// Reads EEG saved as text: a header row that names the columns, then one row per sample.
// Lab Streaming Layer recordings are often saved this way, and so is MNE-Python's
// raw.to_data_frame(). A column named for time gives the sample rate, the other columns of
// numbers become channels, and a column that is mostly empty holds the events.

import { NO_SUBJECT } from './edf.js';

export class CsvError extends Error {}

// Timestamps from a computer's clock make a device's rate look a little off, such as 250.25
// for 250 Hz. A rate this close to one that devices use is taken to be that rate, which is
// the one analysis code works with.
const DEVICE_RATES = [
  100, 125, 128, 160, 200, 250, 256, 300, 500, 512, 1000, 1024, 2000, 2048, 4000, 4096, 8000, 8192,
  16000, 16384,
];
const CLOSE_ENOUGH = 0.005;

// Anything past these is a misread time column rather than a recording.
const MAX_SAMPLE_RATE = 1e6;
const MAX_SECONDS = 1e9;

// A step this much longer or shorter than the usual one is a break in the recording.
const STEP_TOLERANCE = 0.5;

// Names are compared in lower case with everything but letters and digits taken out, so
// "Time (s)" is "times" and "Unnamed: 0" is "unnamed0". A unit starting with m is
// milliseconds, and any other unit, or none, is seconds.
const TIME_NAME = /^(?:lsl)?time(?:stamps?)?(s|secs?|seconds|ms|msecs?|millis|milliseconds)?$/;

// Row numbers, which pandas and some recorders write. They say nothing about the signal.
const INDEX_NAMES = new Set(['', 'index', 'unnamed0', 'sample', 'samples', 'sampleindex']);

// A unit of voltage at the end of a name, as in "Fz [uV]" or "Fz (µV)".
const VOLTS = /^(.*?)\s*[[(]\s*([nuµμm]?V)\s*[\])]$/;

// Cells that hold no value. pandas writes a missing value as an empty cell, and others
// write NaN or null.
const EMPTY = /^\s*(?:nan|null|none|n\/a|na)?\s*$/i;

const normalName = (name) => name.toLowerCase().replace(/[^a-z0-9]/g, '');

// Some exports, such as OpenBCI's, start with comment lines.
const isComment = (line) => /^\s*[#%]/.test(line);

const isBlank = (line) => line.trim() === '';

// The character that splits the header most often.
function delimiterOf(header) {
  const counts = [',', '\t', ';'].map((mark) => [mark, header.split(mark).length]);
  return counts.reduce((best, next) => (next[1] > best[1] ? next : best))[0];
}

// Splits a line at the delimiter, keeping a quoted cell whole. Most lines have no quotes,
// and for them a plain split is far faster.
function cellsOf(line, delimiter) {
  if (!line.includes('"')) return line.split(delimiter);
  const cells = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quoted && char === '"' && line[i + 1] === '"') {
      cell += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === delimiter && !quoted) {
      cells.push(cell);
      cell = '';
    } else {
      cell += char;
    }
  }
  cells.push(cell);
  return cells;
}

// A cell's number, or NaN when it is empty or holds words. Number() alone reads a blank
// cell as zero. A file split by semicolons or tabs may write a decimal comma.
function numberIn(cell, decimalComma) {
  const text = decimalComma ? cell.replace(',', '.') : cell;
  return isBlank(text) ? NaN : Number(text);
}

// Every column's numbers, and the cells that hold words, kept until there are too many of
// them for the column to be a list of events. Times keep double precision, as single
// precision near the clock values of Lab Streaming Layer is as coarse as a sample.
function readColumns(body, names, delimiter, timeIndex) {
  const rows = body.length;
  const decimalComma = delimiter !== ',';
  const columns = names.map((name, index) => ({
    name,
    values: index === timeIndex ? new Float64Array(rows) : new Float32Array(rows),
    numbers: 0,
    words: [],
  }));
  for (let row = 0; row < rows; row += 1) {
    const cells = cellsOf(body[row], delimiter);
    for (let index = 0; index < columns.length; index += 1) {
      const column = columns[index];
      const cell = cells[index] ?? '';
      const value = numberIn(cell, decimalComma);
      column.values[row] = value;
      if (Number.isFinite(value)) {
        column.numbers += 1;
      } else if (!EMPTY.test(cell) && column.words.length <= rows / 2) {
        column.words.push({ row, text: cell.trim() });
      }
    }
  }
  return columns;
}

// The sample rate from the usual step between times, which jitter in the timestamps does
// not move, and how many steps break from it.
function timing(times, scale) {
  const steps = new Float64Array(times.length - 1);
  for (let i = 0; i < steps.length; i += 1) steps[i] = times[i + 1] - times[i];
  const step = steps.slice().sort()[steps.length >> 1];
  if (!(step > 0)) {
    throw new CsvError("The times in this file don't count up, so its sample rate is unknown.");
  }
  let breaks = 0;
  for (const next of steps) {
    if (Math.abs(next - step) > STEP_TOLERANCE * step) breaks += 1;
  }
  const measured = 1 / (step * scale);
  const device = DEVICE_RATES.find((rate) => Math.abs(measured / rate - 1) < CLOSE_ENOUGH);
  return { fs: device ?? measured, breaks };
}

// Repeats the value before each empty cell, and the first value for those at the start.
function fillGaps(values) {
  let previous = values.find(Number.isFinite);
  for (let i = 0; i < values.length; i += 1) {
    if (Number.isNaN(values[i])) values[i] = previous;
    else previous = values[i];
  }
}

function labelOf(name, index) {
  const [, label = name, unit = ''] = VOLTS.exec(name) ?? [];
  return { label: label || `Channel ${index + 1}`, unit: unit.replace(/^[µμ]/, 'u') };
}

// Events are numbered codes or words. With more than one column of them, each says which
// column it came from.
function eventsOf(columns, fs) {
  const named = columns.length > 1;
  const events = [];
  for (const { name, values, words } of columns) {
    const text = (value) => (named ? `${name}: ${value}` : value);
    values.forEach((value, row) => {
      if (Number.isFinite(value)) {
        events.push({ time: row / fs, duration: 0, text: text(String(value)) });
      }
    });
    for (const word of words) {
      events.push({ time: word.row / fs, duration: 0, text: text(word.text) });
    }
  }
  return events.sort((a, b) => a.time - b.time);
}

export function parseCsv(buffer) {
  const lines = new TextDecoder().decode(buffer).split(/\r?\n/);
  const start = lines.findIndex((line) => !isComment(line) && !isBlank(line));
  if (start < 0) throw new CsvError('This CSV file is empty.');

  const delimiter = delimiterOf(lines[start]);
  const names = cellsOf(lines[start], delimiter).map((name) => name.trim());
  if (names.every((name) => !Number.isNaN(numberIn(name, false)) || name === '')) {
    throw new CsvError('This CSV has no header row naming its columns.');
  }
  const timeIndex = names.findIndex((name) => TIME_NAME.test(normalName(name)));
  if (timeIndex < 0) {
    throw new CsvError('This CSV has no time column, so its sample rate is unknown.');
  }
  const body = lines.slice(start + 1).filter((line) => !isBlank(line));
  if (body.length < 2) throw new CsvError('This CSV has fewer than two rows of samples.');

  const rows = body.length;
  const columns = readColumns(body, names, delimiter, timeIndex);
  const times = columns[timeIndex].values;
  if (columns[timeIndex].numbers < rows) {
    throw new CsvError(`The ${names[timeIndex]} column has cells that aren't numbers.`);
  }
  const [, unit = ''] = TIME_NAME.exec(normalName(names[timeIndex]));
  const scale = unit.startsWith('m') ? 1e-3 : 1;
  const { fs, breaks } = timing(times, scale);
  if (fs > MAX_SAMPLE_RATE || rows / fs > MAX_SECONDS) {
    throw new CsvError(`The ${names[timeIndex]} column doesn't look like seconds.`);
  }

  const signals = [];
  const events = [];
  const wordy = [];
  columns.forEach((column, index) => {
    const present = column.numbers + column.words.length;
    if (index === timeIndex || INDEX_NAMES.has(normalName(column.name)) || present === 0) return;
    if (present <= rows / 2) events.push(column);
    else if (column.words.length > 0) wordy.push(column.name);
    else signals.push({ column, index });
  });
  if (signals.length === 0) throw new CsvError('This CSV has no columns of numbers to show.');

  const warnings = [];
  if (breaks > 0) warnings.push('This recording has gaps, which the time axis does not show.');
  if (signals.some(({ column }) => column.numbers < rows)) {
    warnings.push('Some cells are empty, so those samples repeat the value before them.');
  }
  if (wordy.length > 0) {
    warnings.push(`Left out columns of words rather than numbers: ${wordy.join(', ')}.`);
  }

  return {
    format: 'CSV',
    duration: rows / fs,
    channels: signals.map(({ column, index }) => {
      if (column.numbers < rows) fillGaps(column.values);
      return { ...labelOf(column.name, index), fs, data: column.values };
    }),
    annotations: eventsOf(events, fs),
    warnings,
    info: {
      date: null,
      time: null,
      subject: NO_SUBJECT,
      project: null,
      experimenter: null,
      device: null,
      // A CSV says nothing about filtering.
      highpass: null,
      lowpass: null,
      notch: null,
      firstTime: times[0] * scale,
    },
  };
}
