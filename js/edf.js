// Reads EDF and EDF+ recordings. Most header fields follow MNE's EDF reader, so the Info
// section usually matches mne.io.read_raw_edf. It parts from MNE in three places: a
// six-part recording field still gives its date, free text stays whole, and a record
// length of zero is an error rather than one second.
//
// cutoff() and the choice of filter in parseFilters() are adapted from MNE-Python
// (mne/io/edf/edf.py), under the BSD 3-Clause license. See licenses/MNE-Python.txt.

import { twoDigits } from './format.js';

export class EdfError extends Error {}

// A recording that says nothing about its participant.
export const NO_SUBJECT = {
  id: null,
  name: null,
  sex: null,
  birthday: null,
  hand: null,
  height: null,
  weight: null,
};

const HEADER_BYTES = 256;
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const ANNOTATION_LABEL = 'EDF Annotations';

// Anything past these is a damaged header rather than a recording.
const MAX_SAMPLE_RATE = 1e6;
const MAX_SECONDS = 1e9;

const decoder = new TextDecoder('latin1');
const annotationDecoder = new TextDecoder();

// Some recorders pad fields with NUL rather than spaces, so a field ends at the first one.
function text(bytes, start, length) {
  return decoder
    .decode(bytes.subarray(start, start + length))
    .split('\0', 1)[0]
    .trim();
}

function damaged() {
  return new EdfError('This EDF file has a damaged header.');
}

function number(bytes, start, length) {
  const raw = text(bytes, start, length).replace(',', '.');
  const value = raw === '' ? NaN : Number(raw);
  if (!Number.isFinite(value)) throw damaged();
  return value;
}

// EDF+ writes a field it does not know as X.
const known = (value) => (value && value !== 'X' ? value : null);

const measure = (value) => (value && Number.isFinite(Number(value)) ? Number(value) : null);

function isoDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  const real = date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  if (!real) return null;
  return `${year}-${twoDigits(month)}-${twoDigits(day)}`;
}

// 02-MAY-1951
function longDate(value = '') {
  const match = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(value);
  const month = match ? MONTHS.indexOf(match[2].toUpperCase()) + 1 : 0;
  return month ? isoDate(Number(match[3]), month, Number(match[1])) : null;
}

// The three numbers of a header field that writes them between dots.
function dotted(value) {
  const match = /^(\d{1,2})\.(\d{1,2})\.(\d{1,2})$/.exec(value);
  return match ? match.slice(1).map(Number) : null;
}

// 12.08.09. EDF counts two-digit years from 1985.
function shortDate(value) {
  const parts = dotted(value);
  if (!parts) return null;
  const [day, month, year] = parts;
  return isoDate(year < 85 ? 2000 + year : 1900 + year, month, day);
}

// 16.15.00
function clockTime(value) {
  const parts = dotted(value);
  if (!parts) return null;
  const [hours, minutes, seconds] = parts;
  if (hours > 23 || minutes > 59 || seconds > 59) return null;
  return parts.map(twoDigits).join(':');
}

// EDF+ form: code, sex, birth date, name, then optional hand=, height= and weight=.
// Plain EDF allows any text, so whatever does not fit that form is kept whole.
function parseSubject(field) {
  const parts = field.split(/\s+/);
  const fits =
    parts.length >= 4 &&
    /^[MFX]$/.test(parts[1]) &&
    (parts[2] === 'X' || longDate(parts[2]) !== null);
  if (!fits) return { ...NO_SUBJECT, id: known(field) };

  const extras = Object.fromEntries(parts.slice(4).map((part) => part.split('=')));
  return {
    id: known(parts[0]),
    name: known(parts[3])?.replaceAll('_', ' ') ?? null,
    sex: { M: 'Male', F: 'Female' }[parts[1]] ?? null,
    birthday: longDate(parts[2]),
    hand: measure(extras.hand),
    height: measure(extras.height),
    weight: measure(extras.weight),
  };
}

// EDF+ form: Startdate, date, project code, technician, device.
function parseRecordingField(field) {
  const [marker, date, project, experimenter, device] = field.split(/\s+/);
  if (marker !== 'Startdate') {
    return { date: null, project: null, experimenter: null, device: null };
  }
  return {
    date: longDate(date),
    project: known(project),
    experimenter: known(experimenter),
    device: known(device),
  };
}

// Reads one cutoff from text like "HP:0.1Hz LP:75Hz N:50Hz". NaN if it has none.
function cutoff(prefilter, name) {
  const [, raw = ''] = new RegExp(`\\b${name}:\\s*([a-zA-Z0-9,.]+)`).exec(prefilter) ?? [];
  const value = raw.replace('Hz', '').replace(',', '.');
  if (value === 'DC') return 0;
  return /^\d*\.?\d*$/.test(value) && /\d/.test(value) ? Number(value) : NaN;
}

// When channels differ, the strictest filter wins. With no lowpass, the limit is Nyquist.
function parseFilters(prefilters, nyquist) {
  const read = (name) => prefilters.map((filter) => cutoff(filter, name)).filter(Number.isFinite);
  const highpass = Math.max(0, ...read('HP'));
  const lowest = Math.min(...read('LP'));
  const lowpass = Number.isFinite(lowest) && lowest > 0 ? lowest : nyquist;
  const notch = Math.max(0, ...read('N')) || null;
  return highpass > lowpass
    ? { highpass: 0, lowpass: nyquist, notch }
    : { highpass, lowpass, notch };
}

// A timed annotation list: +onset, an optional duration, then its texts, repeated in the
// bytes of an annotation channel. 0x15 and 0x14 mark the parts, and zero bytes end each list.
function parseTals(bytes) {
  const tals = [];
  for (const tal of annotationDecoder.decode(bytes).split('\0')) {
    const [timing, ...texts] = tal.split('\x14');
    const [onset, duration] = timing.split('\x15').map(Number);
    if (/^[+-]/.test(timing) && Number.isFinite(onset)) {
      tals.push({ onset, duration: duration || 0, texts: texts.filter(Boolean) });
    }
  }
  return tals;
}

// The first list in a record stamps when that record began. Times here count from the
// start of the data as shown, so gaps in the recording do not shift the annotations.
function readAnnotations(bytes, slots, { headerBytes, recordBytes, records, recordSeconds }) {
  const annotations = [];
  for (let record = 0; record < records; record += 1) {
    const recordStart = headerBytes + record * recordBytes;
    let stamp = null;
    for (const { offset, length } of slots) {
      const from = recordStart + offset;
      for (const { onset, duration, texts } of parseTals(bytes.subarray(from, from + length))) {
        stamp ??= onset;
        const time = record * recordSeconds + onset - stamp;
        for (const text of texts) annotations.push({ time, duration, text });
      }
    }
  }
  return annotations.sort((a, b) => a.time - b.time);
}

export function parseEdf(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < HEADER_BYTES) {
    throw new EdfError('This file is too short to be an EDF recording.');
  }
  if (bytes[0] === 0xff) {
    throw new EdfError('This looks like a BDF file. Only EDF is supported so far.');
  }
  if (text(bytes, 0, 8) !== '0') {
    throw new EdfError('This does not look like an EDF file.');
  }

  const headerBytes = number(bytes, 184, 8);
  const reserved = text(bytes, 192, 44);
  const declaredRecords = number(bytes, 236, 8);
  const recordSeconds = number(bytes, 244, 8);
  const signalCount = number(bytes, 252, 4);

  const validShape =
    Number.isInteger(signalCount) &&
    signalCount > 0 &&
    Number.isInteger(declaredRecords) &&
    headerBytes === HEADER_BYTES * (signalCount + 1) &&
    bytes.length >= headerBytes;
  if (!validShape) throw damaged();
  if (recordSeconds <= 0) throw new EdfError('This file has no timed signal data.');

  // Header fields are stored column by column: every label, then every unit.
  let cursor = HEADER_BYTES;
  const column = (width, read) => {
    const values = [];
    for (let i = 0; i < signalCount; i += 1) {
      values.push(read(bytes, cursor + i * width, width));
    }
    cursor += width * signalCount;
    return values;
  };
  const labels = column(16, text);
  column(80, text); // transducer type
  const units = column(8, text);
  const physicalMin = column(8, number);
  const physicalMax = column(8, number);
  const digitalMin = column(8, number);
  const digitalMax = column(8, number);
  const prefiltering = column(80, text);
  const samplesPerRecord = column(8, number);

  if (samplesPerRecord.some((count) => !Number.isInteger(count) || count < 0)) throw damaged();
  if (Math.max(...samplesPerRecord) / recordSeconds > MAX_SAMPLE_RATE) throw damaged();
  const recordBytes = 2 * samplesPerRecord.reduce((sum, count) => sum + count, 0);
  if (recordBytes === 0) throw new EdfError('This file has no signal data.');

  const available = Math.floor((bytes.length - headerBytes) / recordBytes);
  const records = declaredRecords >= 0 ? Math.min(declaredRecords, available) : available;
  if (records < 1) throw new EdfError('This file has no complete data records.');
  if (records * recordSeconds > MAX_SECONDS) throw damaged();

  const warnings = [];
  if (declaredRecords > available) {
    warnings.push('This file looks cut off, so only the complete part is shown.');
  }
  if (reserved.startsWith('EDF+D')) {
    warnings.push('This recording has gaps, which the time axis does not show.');
  }

  const view = new DataView(buffer);
  const channels = [];
  const prefilters = [];
  const annotationSlots = [];
  let offsetInRecord = 0;

  for (let i = 0; i < signalCount; i += 1) {
    const count = samplesPerRecord[i];
    if (labels[i] === ANNOTATION_LABEL) {
      annotationSlots.push({ offset: offsetInRecord, length: 2 * count });
    } else if (count > 0) {
      const digitalRange = digitalMax[i] - digitalMin[i];
      const scale = digitalRange === 0 ? 1 : (physicalMax[i] - physicalMin[i]) / digitalRange;
      const shift = physicalMin[i] - digitalMin[i] * scale;
      const data = new Float32Array(records * count);
      let out = 0;
      for (let record = 0; record < records; record += 1) {
        let at = headerBytes + record * recordBytes + offsetInRecord;
        for (let sample = 0; sample < count; sample += 1) {
          data[out] = view.getInt16(at, true) * scale + shift;
          out += 1;
          at += 2;
        }
      }
      channels.push({
        label: labels[i] || `Channel ${i + 1}`,
        unit: units[i],
        fs: count / recordSeconds,
        data,
      });
      prefilters.push(prefiltering[i]);
    }
    offsetInRecord += 2 * count;
  }

  if (channels.length === 0) throw new EdfError('This file has no signal channels.');

  // The recording field carries a four-digit year, so it beats the header's date.
  const { date, ...recordingField } = parseRecordingField(text(bytes, 88, 80));
  const startDate = date ?? shortDate(text(bytes, 168, 8));
  const nyquist = Math.max(...channels.map(({ fs }) => fs)) / 2;

  return {
    format: reserved.startsWith('EDF+') ? 'EDF+' : 'EDF',
    duration: records * recordSeconds,
    channels,
    annotations: readAnnotations(bytes, annotationSlots, {
      headerBytes,
      recordBytes,
      records,
      recordSeconds,
    }),
    warnings,
    info: {
      date: startDate,
      time: startDate && clockTime(text(bytes, 176, 8)),
      subject: parseSubject(text(bytes, 8, 80)),
      ...recordingField,
      ...parseFilters(prefilters, nyquist),
    },
  };
}
