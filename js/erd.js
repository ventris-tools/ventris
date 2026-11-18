// Event-related power: how the power in a band falls or rises around one kind of annotation,
// averaged over its events. A fall is an event-related desynchronization (ERD) and a rise a
// synchronization (ERS), as Pfurtscheller and Lopes da Silva (1999) describe them: the mu and
// beta rhythms over the motor cortex fall when a hand moves, or is imagined moving, on the
// other side.
//
// Each event's epoch runs from a second before its onset to 4.5 s after. The signal is
// band-passed, squared, smoothed over half a second and averaged across the events, then given
// in decibels against a baseline: the second before the events, or the power during another
// kind of annotation, such as rest.

import { butterworth, filtfilt, NYQUIST_SHARE } from './filters.js';
import { electrodeOf } from './montage.js';

export const BEFORE = 1;
export const AFTER = 4.5;
const SMOOTH = 0.5;

// The recording on each side of an epoch that's filtered with it, so the filter has settled
// by the time it reaches the epoch. Its slowest ringing, at 8 Hz, dies away in about 50 ms.
const MARGIN = 1;

// The stretch the figure for each kind averages: after the response to the onset itself, and
// before the end of a typical motor imagery trial.
export const DURING = [0.5, 3.5];

// How many points a second a curve keeps. Smoothing leaves nothing faster than a few hertz.
const POINTS_PER_SECOND = 50;

// The lowest a curve goes, in dB, so a flat stretch, such as a gap, stays on the chart.
const FLOOR = -60;

// Mu and beta are the rhythms that fall over the motor cortex, and the default takes in both.
export const POWER_BANDS = [
  { value: 'mu-beta', text: '8 to 30 Hz', low: 8, high: 30 },
  { value: 'mu', text: 'Mu 8 to 13 Hz', low: 8, high: 13 },
  { value: 'beta', text: 'Beta 13 to 30 Hz', low: 13, high: 30 },
];

// A fourth-order Butterworth filter as two second-order sections, with the dampings its poles
// give, 2 sin(π/8) and 2 sin(3π/8).
const DAMPINGS = [1, 3].map((odd) => 2 * Math.sin((odd * Math.PI) / 8));

// A band-pass as a fourth-order high-pass and a fourth-order low-pass.
export const bandSections = (low, high, fs) => [
  ...DAMPINGS.map((damping) => butterworth('highpass', low, fs, damping)),
  ...DAMPINGS.map((damping) => butterworth('lowpass', high, fs, damping)),
];

// The kinds of annotation in a recording, in the order they first appear, each with its
// events. Annotations whose text differs only in case, or in spaces at either end, are one
// kind, as eventColors has it.
export function eventKinds(annotations) {
  const kinds = new Map();
  for (const { time, duration, text } of annotations) {
    const key = text.trim().toLowerCase();
    if (!kinds.has(key)) kinds.set(key, { key, text: text.trim(), events: [] });
    kinds.get(key).events.push({ time, duration });
  }
  return [...kinds.values()];
}

const nameOf = (label) => label.trim().toUpperCase();

// The rows a list of names picks out, such as "C3 C4", or "EEG Fpz-Cz, EEG Pz-Oz" for names
// with spaces in them. A name matches a channel's whole label, ignoring case, or else the
// electrode its label names, so C3 finds "EEG C3-A2" and "C3..". Returns { rows, unknown },
// unknown holding the names that match nothing.
export function findChannels(channels, text) {
  const names = text
    .split(text.includes(',') ? ',' : /\s+/)
    .map((name) => name.trim())
    .filter(Boolean);
  const rows = [];
  const unknown = [];
  for (const name of names) {
    const { site } = electrodeOf(name);
    let row = channels.findIndex(({ label }) => nameOf(label) === nameOf(name));
    if (row < 0 && site) row = channels.findIndex(({ label }) => electrodeOf(label).site === site);
    if (row < 0) unknown.push(name);
    else if (!rows.includes(row)) rows.push(row);
  }
  return { rows, unknown };
}

// The band-passed signal squared, from sample first up to end, filtered along with up to
// margin samples of the recording on each side.
function squared(data, first, end, sections, margin) {
  const from = Math.max(0, first - margin);
  const to = Math.min(data.length, end + margin);
  const filtered = filtfilt(data.subarray(from, to), sections);
  const out = new Float64Array(end - first);
  for (let i = first; i < end; i += 1) out[i - first] = filtered[i - from] ** 2;
  return out;
}

// Power through the length samples from start, each the mean over the width samples around
// it, or over as many of them as the recording holds.
function epochPower(data, start, length, width, sections, margin) {
  const half = Math.floor(width / 2);
  const first = Math.max(0, start - half);
  const end = Math.min(data.length, start + length - 1 - half + width);
  const power = squared(data, first, end, sections, margin);
  const sums = new Float64Array(power.length + 1);
  for (let i = 0; i < power.length; i += 1) sums[i + 1] = sums[i] + power[i];
  const out = new Float64Array(length);
  for (let i = 0; i < length; i += 1) {
    const low = Math.max(first, start + i - half) - first;
    const high = Math.min(end, start + i - half + width) - first;
    out[i] = (sums[high] - sums[low]) / (high - low);
  }
  return out;
}

const mean = (values, from, to) => {
  let sum = 0;
  for (let i = from; i < to; i += 1) sum += values[i];
  return sum / (to - from);
};

// The mean power during rest's events, each from its onset for its duration, or for AFTER
// seconds if it has none, or null when none of them lies in the recording.
function* restPower(data, fs, rest, sections, margin) {
  let sum = 0;
  let count = 0;
  for (const { time, duration } of rest.events) {
    const first = Math.max(0, Math.round(time * fs));
    const end = Math.min(data.length, Math.round((time + (duration || AFTER)) * fs));
    if (end > first) {
      sum += mean(squared(data, first, end, sections, margin), 0, end - first);
      count += 1;
    }
    yield;
  }
  return count > 0 ? sum / count : null;
}

// Power around each kind's events at one channel, in dB against the second before them, or
// against rest's power when rest is a kind. Returns { reason, times, curves }, with times in
// seconds from the onset and a curve { key, count, db, during } for each kind. count says how
// many events had their whole epoch in the recording, and during is the mean over DURING, in
// dB. db and during are null when no event counted.
//
// reason is null, or says why there are no curves: 'slow' when the sample rate is too low
// for the band, 'rest' when no rest event lies in the recording, or 'flat' when the channel
// has no power in the band. This yields after each event, so the caller can pause.
export function* eventPower({ fs, data }, kinds, band, rest = null) {
  const none = (reason) => ({ reason, times: null, curves: null });
  if (band.high >= NYQUIST_SHARE * fs) return none('slow');
  const sections = bandSections(band.low, band.high, fs);
  const lead = Math.round(BEFORE * fs);
  const length = lead + Math.round(AFTER * fs);
  const width = Math.max(1, Math.round(SMOOTH * fs));
  const margin = Math.round(MARGIN * fs);
  const reference = rest ? yield* restPower(data, fs, rest, sections, margin) : null;
  if (rest && reference === null) return none('rest');

  const step = Math.max(1, Math.floor(fs / POINTS_PER_SECOND));
  const kept = Math.ceil(length / step);
  const times = Float64Array.from({ length: kept }, (_, i) => (i * step - lead) / fs);
  const [from, to] = DURING.map((time) => lead + Math.round(time * fs));
  const curves = [];
  let flat = false;
  for (const { key, events } of kinds) {
    const average = new Float64Array(length);
    let count = 0;
    for (const { time } of events) {
      const start = Math.round(time * fs) - lead;
      if (start >= 0 && start + length <= data.length) {
        const power = epochPower(data, start, length, width, sections, margin);
        for (let i = 0; i < length; i += 1) average[i] += power[i];
        count += 1;
      }
      yield;
    }
    for (let i = 0; i < length; i += 1) average[i] /= count;
    const base = reference ?? mean(average, 0, lead);
    if (count === 0 || !(base > 0)) {
      flat ||= count > 0;
      curves.push({ key, count, db: null, during: null });
      continue;
    }
    const decibels = (power) => Math.max(FLOOR, 10 * Math.log10(power / base));
    curves.push({
      key,
      count,
      db: times.map((_, i) => decibels(average[i * step])),
      during: decibels(mean(average, from, to)),
    });
  }
  return flat ? none('flat') : { reason: null, times, curves };
}

// Steps between the ticks of a chart, in dB.
const TICK_STEPS = [1, 2, 5, 10, 20, 50];

// The range of a chart that takes in 0 and every value of these curves, in whole steps, with
// a tick at each step and no more than five of them. It reaches 1 dB either side of 0 at
// least, so a chart of flat curves still has somewhere to draw them.
export function chartScale(curves) {
  let low = -1;
  let high = 1;
  for (const { db } of curves) {
    for (const value of db ?? []) {
      low = Math.min(low, value);
      high = Math.max(high, value);
    }
  }
  const fits = (step) => Math.ceil(high / step) - Math.floor(low / step) <= 4;
  const step = TICK_STEPS.find(fits) ?? 10 * Math.ceil((high - low) / 20);
  const ticks = [];
  for (let tick = Math.floor(low / step); tick <= Math.ceil(high / step); tick += 1) {
    ticks.push(tick * step);
  }
  return { low: ticks[0], high: ticks.at(-1), ticks };
}
