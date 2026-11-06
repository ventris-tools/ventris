// Frequency analysis: Welch power spectra summarised into the classic EEG bands.

import { isEeg } from './channels.js';

export const BANDS = [
  { name: 'Delta', low: 1, high: 4 },
  { name: 'Theta', low: 4, high: 8 },
  { name: 'Alpha', low: 8, high: 13 },
  { name: 'Beta', low: 13, high: 30 },
];

export const BAND_RANGE = `${BANDS[0].low} to ${BANDS.at(-1).high} Hz`;

// Bands need rates well above 30 Hz, and only make sense for brain channels.
const MIN_SAMPLE_RATE = 64;

// Enough for a stable estimate, however long the window is.
const MAX_SEGMENTS = 256;

// Amplitude across the whole recording, pooled over the EEG channels that share the
// first one's unit. Returns null when there are no EEG channels.
export function timeStats(channels) {
  const eeg = channels.filter(isEeg);
  if (eeg.length === 0) return null;
  const { unit } = eeg[0];

  const measured = eeg
    .filter((channel) => channel.unit === unit)
    .map(({ label, data }) => {
      let sum = 0;
      let minimum = Infinity;
      let maximum = -Infinity;
      for (let i = 0; i < data.length; i += 1) {
        sum += data[i];
        if (data[i] < minimum) minimum = data[i];
        if (data[i] > maximum) maximum = data[i];
      }
      const mean = sum / data.length;
      let squares = 0;
      for (let i = 0; i < data.length; i += 1) squares += (data[i] - mean) ** 2;
      const deviation = Math.sqrt(squares / data.length);
      return { label, count: data.length, mean, squares, minimum, maximum, deviation };
    })
    .sort((a, b) => a.deviation - b.deviation);

  const total = measured.reduce((sum, { count }) => sum + count, 0);
  const mean = measured.reduce((sum, c) => sum + c.mean * c.count, 0) / total;
  const squares = measured.reduce((sum, c) => sum + c.squares + c.count * (c.mean - mean) ** 2, 0);
  const moving = measured.filter(({ deviation }) => deviation > 0);

  return {
    unit,
    channels: measured.length,
    mean,
    deviation: Math.sqrt(squares / total),
    minimum: Math.min(...measured.map((c) => c.minimum)),
    maximum: Math.max(...measured.map((c) => c.maximum)),
    quietest: moving[0] ?? null,
    loudest: moving.at(-1) ?? null,
    flat: measured.length - moving.length,
  };
}

const hannCache = new Map();

// The periodic form, which spectral analysis uses and SciPy's welch defaults to.
function hann(length) {
  if (!hannCache.has(length)) {
    const taper = new Float64Array(length);
    for (let i = 0; i < length; i += 1) {
      taper[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / length);
    }
    hannCache.set(length, taper);
  }
  return hannCache.get(length);
}

// In-place radix-2 FFT. The length must be a power of two.
export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const angle = (-2 * Math.PI) / size;
    const stepRe = Math.cos(angle);
    const stepIm = Math.sin(angle);
    for (let start = 0; start < n; start += size) {
      let wRe = 1;
      let wIm = 0;
      for (let k = 0; k < size / 2; k += 1) {
        const a = start + k;
        const b = a + size / 2;
        const tRe = re[b] * wRe - im[b] * wIm;
        const tIm = re[b] * wIm + im[b] * wRe;
        re[b] = re[a] - tRe;
        im[b] = im[a] - tIm;
        re[a] += tRe;
        im[a] += tIm;
        const nextRe = wRe * stepRe - wIm * stepIm;
        wIm = wRe * stepIm + wIm * stepRe;
        wRe = nextRe;
      }
    }
  }
}

// Averages Hann-windowed spectra of segments that overlap by half. A segment is the first
// power of two that holds two seconds of samples, or the most that fits a shorter window.
// A very long window spreads MAX_SEGMENTS of them evenly instead.
export function welch(samples, fs) {
  const wanted = 2 ** Math.ceil(Math.log2(fs * 2));
  const size = 2 ** Math.floor(Math.log2(Math.min(wanted, samples.length)));
  if (!(size >= 32)) return null;

  const taper = hann(size);
  const power = new Float64Array(size / 2 + 1);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const span = samples.length - size;
  const overlapping = Math.floor(span / (size / 2)) + 1;
  const segments = Math.min(overlapping, MAX_SEGMENTS);
  const step = overlapping > MAX_SEGMENTS ? span / (MAX_SEGMENTS - 1) : size / 2;

  for (let segment = 0; segment < segments; segment += 1) {
    const start = Math.round(segment * step);
    let mean = 0;
    for (let i = 0; i < size; i += 1) mean += samples[start + i];
    mean /= size;
    for (let i = 0; i < size; i += 1) {
      re[i] = (samples[start + i] - mean) * taper[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < power.length; k += 1) power[k] += re[k] * re[k] + im[k] * im[k];
  }
  for (let k = 0; k < power.length; k += 1) power[k] /= segments;
  return { power, resolution: fs / size };
}

// Each band's share of the power across all the bands. Returns null for a flat signal.
export function relativeBandPower({ power, resolution }) {
  const totals = BANDS.map(() => 0);
  for (let k = 0; k < power.length; k += 1) {
    const frequency = k * resolution;
    const band = BANDS.findIndex(({ low, high }) => frequency >= low && frequency < high);
    if (band >= 0) totals[band] += power[k];
  }
  const sum = totals.reduce((a, b) => a + b, 0);
  return sum > 0 ? totals.map((value) => value / sum) : null;
}

// Averages shares across channels, so one loud channel cannot dominate. With nothing to
// measure, shares is null and reason says why. A long window can take many frames, so this
// yields after each channel and returns the result, which lets the caller pause or give up.
export function* bandShares(channels, start, length) {
  const eeg = channels.filter(isEeg);
  const fast = eeg.filter(({ fs }) => fs >= MIN_SAMPLE_RATE);
  const shares = BANDS.map(() => 0);
  let long = 0;
  let used = 0;

  for (const channel of fast) {
    const from = Math.floor(start * channel.fs);
    const to = Math.min(channel.data.length, Math.ceil((start + length) * channel.fs));
    const spectrum = welch(channel.data.subarray(from, to), channel.fs);
    if (spectrum) long += 1;
    const relative = spectrum && relativeBandPower(spectrum);
    if (relative) {
      relative.forEach((value, i) => {
        shares[i] += value;
      });
      used += 1;
    }
    yield;
  }

  if (used > 0) {
    return { shares: shares.map((value) => value / used), channels: used, reason: null };
  }
  const reasons = [
    [eeg.length === 0, 'no-eeg'],
    [fast.length === 0, 'slow'],
    [long === 0, 'short'],
    [true, 'flat'],
  ];
  return { shares: null, channels: 0, reason: reasons.find(([applies]) => applies)[1] };
}
