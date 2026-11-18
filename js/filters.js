// Display filters: a high-pass, a low-pass and a mains notch, drawn on the traces and never
// written to the file. Each runs forwards and then backwards, so nothing lags and peaks stay
// under their annotations. Running twice also halves the signal at a cutoff, where one pass
// takes it down by 3 dB, as MNE's IIR filters do too.
//
// Written from published formulas: the second-order Butterworth sections come from the
// bilinear transform with prewarping, and the notch from Orfanidis, "Introduction to Signal
// Processing" (1996), which scipy.signal.iirnotch follows. Each section is a row of
// [b0, b1, b2, 1, a1, a2], as in SciPy's "sos" form. The two passes follow
// scipy.signal.sosfiltfilt with padtype 'odd', with padding long enough for the filters to
// settle. test/filters.test.js checks them against SciPy.

import { channelType, isSensor } from './channels.js';

// How narrow the notch is: at 50 Hz it takes out about 1.7 Hz around the mains frequency.
export const NOTCH_Q = 30;

// A filter this close to half the sample rate is skipped. The signal holds little there, and
// the bilinear transform squeezes the filter against it.
export const NYQUIST_SHARE = 0.45;

// The padding at each end lasts until every filter's ringing falls to this share of a step.
const SETTLE = 1e-5;

// How many samples a pass filters between pauses, so a long channel can't hold the page.
const CHUNK = 65536;

// The most samples a filtered copy can hold, about 600 MB. The recording and the copy on
// screen stay in memory while a new one is made, and a tab that runs out can be lost.
export const MAX_FILTER_SAMPLES = 1.5e8;

// A second-order section. Its damping is √2 for a second-order Butterworth filter, and a
// higher order cascades sections with the dampings its poles give, as js/erd.js does.
export function butterworth(kind, cutoff, fs, damping = Math.SQRT2) {
  const k = Math.tan((Math.PI * cutoff) / fs);
  const norm = 1 / (1 + damping * k + k * k);
  const b0 = kind === 'lowpass' ? k * k * norm : norm;
  const b1 = kind === 'lowpass' ? 2 * b0 : -2 * b0;
  return [b0, b1, b0, 1, 2 * (k * k - 1) * norm, (1 - damping * k + k * k) * norm];
}

export function notch(frequency, fs, q = NOTCH_Q) {
  const w0 = (2 * Math.PI * frequency) / fs;
  const gain = 1 / (1 + Math.tan(w0 / (2 * q)));
  const middle = -2 * gain * Math.cos(w0);
  return [gain, middle, gain, 1, middle, 2 * gain - 1];
}

// The sections that apply to one channel. An EMG channel keeps its high frequencies, which
// are what it measures: a low-pass would flatten chin tone to look like REM sleep.
export function sectionsFor({ highpass, lowpass, notch: mains }, fs, kind) {
  const fits = (frequency) => frequency !== null && frequency < NYQUIST_SHARE * fs;
  const sections = [];
  if (fits(highpass)) sections.push(butterworth('highpass', highpass, fs));
  if (fits(lowpass) && kind !== 'EMG') sections.push(butterworth('lowpass', lowpass, fs));
  if (fits(mains)) sections.push(notch(mains, fs));
  return sections;
}

// The state each section settles into under a steady input of 1, two values a section, as
// scipy.signal.sosfilt_zi gives it. A section passes its input on scaled by its gain at 0 Hz,
// which is zero for a high-pass, so every section after one starts from rest.
export function steadyState(sections) {
  const state = new Float64Array(2 * sections.length);
  let scale = 1;
  sections.forEach(([b0, b1, b2, , a1, a2], index) => {
    const gain = (b0 + b1 + b2) / (1 + a1 + a2);
    state[2 * index] = scale * (gain - b0);
    state[2 * index + 1] = scale * (b2 - a2 * gain);
    scale *= gain;
  });
  return state;
}

// How many samples to pad each end with. Each section here has a pair of poles at a radius
// whose square is a2, and ringing shrinks by that radius every sample. Short recordings pad
// with all they have.
export function padLength(sections, n) {
  if (sections.length === 0) return 0;
  const slowest = Math.max(...sections.map((section) => section[5]));
  const length = Math.ceil((2 * Math.log(SETTLE)) / Math.log(slowest));
  return Math.max(0, Math.min(n - 1, length));
}

// Runs every section over x from `from` up or down to `to`, in place, carrying state from
// one call to the next. A plain loop, kept apart from the pauses, so that it stays fast.
function run(x, from, to, step, coefficients, state) {
  const count = state.length / 2;
  for (let i = from; i !== to; i += step) {
    let value = x[i];
    for (let s = 0, c = 0; s < count; s += 1, c += 5) {
      const out = coefficients[c] * value + state[2 * s];
      state[2 * s] = coefficients[c + 1] * value - coefficients[c + 3] * out + state[2 * s + 1];
      state[2 * s + 1] = coefficients[c + 2] * value - coefficients[c + 4] * out;
      value = out;
    }
    x[i] = value;
  }
}

function* pass(x, from, to, step, coefficients, state) {
  for (let i = from; i !== to;) {
    const end = step > 0 ? Math.min(to, i + CHUNK) : Math.max(to, i - CHUNK);
    run(x, i, end, step, coefficients, state);
    i = end;
    yield;
  }
}

// Filters data into out, using scratch, which holds at least data.length + 2 * padlen values
// and can be shared from one channel to the next. The padding mirrors each end about its last
// sample, and each pass starts as if its first value had always been there.
function* filterInto(data, sections, padlen, scratch, out) {
  const n = data.length;
  const length = n + 2 * padlen;
  const x = scratch;
  for (let i = 0; i < padlen; i += 1) {
    x[i] = 2 * data[0] - data[padlen - i];
    x[padlen + n + i] = 2 * data[n - 1] - data[n - 2 - i];
  }
  for (let i = 0; i < n; i += 1) x[padlen + i] = data[i];

  const coefficients = Float64Array.from(
    sections.flatMap(([b0, b1, b2, , a1, a2]) => [b0, b1, b2, a1, a2]),
  );
  const settled = steadyState(sections);
  yield* pass(
    x,
    0,
    length,
    1,
    coefficients,
    settled.map((value) => value * x[0]),
  );
  yield* pass(
    x,
    length - 1,
    -1,
    -1,
    coefficients,
    settled.map((value) => value * x[length - 1]),
  );
  for (let i = 0; i < n; i += 1) out[i] = x[padlen + i];
  return out;
}

// One channel filtered straight through, in double precision, or the same array when no
// section applies.
export function filtfilt(data, sections, padlen = padLength(sections, data.length)) {
  if (sections.length === 0 || data.length === 0) return data;
  const scratch = new Float64Array(data.length + 2 * padlen);
  const steps = filterInto(data, sections, padlen, scratch, new Float64Array(data.length));
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

// Filters every channel the settings apply to, pausing every CHUNK samples, so the caller
// can let the page draw and give up if the settings change. Sensor channels, and channels no
// filter applies to, come back as they were. Returns { channels, untouched, reason }, where
// untouched counts the sensor channels, and channels is null when the recording is too long
// to filter here, with reason 'large', or memory ran out, with reason 'memory'.
export function* filterRecording(channels, settings, { maxSamples = MAX_FILTER_SAMPLES } = {}) {
  const sensors = channels.map(({ label }) => isSensor(label));
  const plans = channels.map(({ label, fs, data }, index) => {
    if (sensors[index] || data.length === 0) return null;
    const sections = sectionsFor(settings, fs, channelType(label));
    return sections.length > 0 ? { sections, padlen: padLength(sections, data.length) } : null;
  });
  const untouched = sensors.filter(Boolean).length;
  let total = 0;
  let longest = 0;
  plans.forEach((plan, index) => {
    if (!plan) return;
    const { length } = channels[index].data;
    total += length;
    longest = Math.max(longest, length + 2 * plan.padlen);
  });
  if (total > maxSamples) return { channels: null, untouched, reason: 'large' };

  try {
    const scratch = new Float64Array(longest);
    const filtered = [];
    for (const [index, channel] of channels.entries()) {
      const plan = plans[index];
      if (!plan) {
        filtered.push(channel);
        continue;
      }
      const out = new Float32Array(channel.data.length);
      yield* filterInto(channel.data, plan.sections, plan.padlen, scratch, out);
      filtered.push({ ...channel, data: out });
    }
    return { channels: filtered, untouched, reason: null };
  } catch (error) {
    if (error instanceof RangeError) return { channels: null, untouched, reason: 'memory' };
    throw error;
  }
}
