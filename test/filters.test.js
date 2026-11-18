import assert from 'node:assert/strict';
import test from 'node:test';
import {
  butterworth,
  filterRecording,
  filtfilt,
  notch,
  padLength,
  sectionsFor,
  steadyState,
} from '../js/filters.js';
import { CASES } from './support/scipy-filters.js';

// The input test/support/scipy-filters.py filters: an offset, a slow drift, square waves at
// 10 and 50 Hz and some noise, all in powers of two, so both languages make the same samples.
function inputFor(n, fs) {
  const period = 20 * fs;
  return Float32Array.from({ length: n }, (_, i) => {
    const place = i % period;
    const drift = (place < period / 2 ? place : period - place) / 64;
    const alpha = Math.floor((i * 10) / fs) % 2 === 0 ? 40 : -40;
    const mains = Math.floor((i * 50) / fs) % 2 === 0 ? 20 : -20;
    const noise = (((Math.imul(i, 2654435761) >>> 0) >>> 20) - 2048) / 256;
    return 250000 + drift + alpha + mains + noise;
  });
}

const sine = (frequency, fs, seconds, amplitude = 1) =>
  Float32Array.from(
    { length: Math.round(fs * seconds) },
    (_, i) => amplitude * Math.sin((2 * Math.PI * frequency * i) / fs),
  );

// The largest value in the middle half, where the ends' settling can't reach.
function middlePeak(data) {
  const quarter = Math.floor(data.length / 4);
  return Math.max(...Array.from(data.subarray(quarter, data.length - quarter), Math.abs));
}

// Runs a generator to the end, counting its pauses.
function finish(steps) {
  let pauses = 0;
  let step = steps.next();
  while (!step.done) {
    pauses += 1;
    step = steps.next();
  }
  return { ...step.value, pauses };
}

const settings = (highpass, lowpass, mains) => ({ highpass, lowpass, notch: mains });

for (const { fs, settings: chosen, n, sos, zi, padlen, output } of CASES) {
  const name = `${fs} Hz, ${JSON.stringify(chosen)}`;
  const sections = sectionsFor(chosen, fs, 'EEG');

  test(`designs the same filters as SciPy at ${name}`, () => {
    assert.equal(sections.length, sos.length);
    sections.forEach((section, row) => {
      section.forEach((value, column) => {
        assert.ok(Math.abs(value - sos[row][column]) < 1e-13, `row ${row} column ${column}`);
      });
    });
  });

  // SciPy solves a linear system for this, which loses digits when a pole sits near 1, so
  // the closed form here only has to come close. The filtered samples below are exact.
  test(`settles into the state SciPy finds at ${name}`, () => {
    const state = steadyState(sections);
    assert.equal(state.length, zi.length);
    state.forEach((value, index) => {
      assert.ok(Math.abs(value - zi[index]) < 1e-6 * Math.max(1, Math.abs(zi[index])));
    });
  });

  test(`filters the same samples as SciPy's sosfilt run both ways at ${name}`, () => {
    assert.equal(padLength(sections, n), padlen);
    const input = inputFor(n, fs);
    const filtered = filtfilt(input, sections);
    const largest = Math.max(...Array.from(input, Math.abs));
    for (const [place, expected] of output) {
      const error = Math.abs(filtered[place] - expected);
      assert.ok(error < 1e-9 * largest, `sample ${place} is off by ${error}`);
    }
  });
}

test('a high-pass takes out the offset and slow drift, and keeps the alpha', () => {
  const fs = 256;
  const alpha = sine(10, fs, 20, 30);
  const drifting = alpha.map(
    (value, i) => value + 5000 + 200 * Math.sin((2 * Math.PI * i) / (fs * 40)),
  );
  const filtered = filtfilt(drifting, sectionsFor(settings(1, null, null), fs, 'EEG'));
  const error = filtered.map((value, i) => value - alpha[i]);
  assert.ok(middlePeak(error) < 0.5, `left ${middlePeak(error)} µV behind`);
});

test('a notch takes out the mains and keeps a nearby rhythm', () => {
  const fs = 500;
  const mains = filtfilt(sine(50, fs, 20), sectionsFor(settings(null, null, 50), fs, 'EEG'));
  const beta = filtfilt(sine(25, fs, 20), sectionsFor(settings(null, null, 50), fs, 'EEG'));
  assert.ok(middlePeak(mains) < 0.01);
  assert.ok(middlePeak(beta) > 0.99);
});

test('halves the signal at the cutoff, since it filters twice', () => {
  const fs = 1000;
  const passed = filtfilt(sine(40, fs, 20), [butterworth('lowpass', 40, fs)]);
  assert.ok(Math.abs(middlePeak(passed) - 0.5) < 0.01, `kept ${middlePeak(passed)}`);
});

test('moves nothing in time', () => {
  const fs = 256;
  const bump = Float32Array.from({ length: fs * 10 }, (_, i) =>
    Math.exp(-(((i - 1280) / 20) ** 2)),
  );
  const filtered = filtfilt(bump, sectionsFor(settings(0.5, 15, 50), fs, 'EEG'));
  assert.equal(filtered.indexOf(Math.max(...filtered)), 1280);
});

test('keeps a flat channel flat', () => {
  const flat = new Float32Array(2000).fill(-12.5);
  assert.ok(filtfilt(flat, [butterworth('highpass', 0.5, 256)]).every((value) => value === 0));
  const smoothed = filtfilt(flat, [butterworth('lowpass', 30, 256), notch(50, 256)]);
  assert.ok(smoothed.every((value) => Math.abs(value + 12.5) < 1e-9));
});

test('handles a recording of one or two samples', () => {
  for (const length of [1, 2]) {
    const data = Float32Array.from({ length }, (_, i) => 3 + i);
    const filtered = filtfilt(data, sectionsFor(settings(0.5, 30, 50), 250, 'EEG'));
    assert.equal(filtered.length, length);
    assert.ok(filtered.every(Number.isFinite));
  }
});

test('returns the samples themselves when nothing applies', () => {
  const data = sine(10, 256, 1);
  assert.equal(filtfilt(data, []), data);
  assert.equal(filtfilt(new Float32Array(0), [notch(50, 256)]).length, 0);
  assert.equal(padLength([], 1000), 0);
});

test('pads with the whole recording when it is shorter than the filters need', () => {
  const sections = sectionsFor(settings(0.1, null, null), 1000, 'EEG');
  assert.equal(padLength(sections, 500), 499);
  assert.ok(padLength(sections, 1e9) > 20000);
});

test('skips a filter too close to half the sample rate', () => {
  assert.equal(sectionsFor(settings(null, 70, null), 128, 'EEG').length, 0);
  assert.equal(sectionsFor(settings(null, 70, null), 160, 'EEG').length, 1);
  assert.equal(sectionsFor(settings(null, null, 60), 100, 'EEG').length, 0);
  assert.equal(sectionsFor(settings(0.5, null, null), 1, 'EEG').length, 0);
});

test('applies no low-pass to EMG, whose high frequencies are the signal', () => {
  assert.equal(sectionsFor(settings(0.5, 30, 50), 256, 'EMG').length, 2);
  assert.equal(sectionsFor(settings(0.5, 30, 50), 256, 'EOG').length, 3);
});

test('filters every channel but the sensors, at each channel’s own rate', () => {
  const channels = [
    { label: 'Cz', unit: 'uV', fs: 256, data: sine(10, 256, 4, 20) },
    { label: 'EXG Channel 0', unit: 'uV', fs: 250, data: sine(50, 250, 4, 20) },
    { label: 'Resp chest', unit: '', fs: 32, data: sine(0.3, 32, 4) },
    { label: 'STI 014', unit: '', fs: 256, data: new Float32Array(1024).fill(5) },
    { label: 'O1', unit: 'uV', fs: 64, data: sine(10, 64, 4) },
  ];
  const before = channels.map(({ data }) => data.slice());
  const result = finish(filterRecording(channels, settings(null, 30, 50)));
  assert.equal(result.reason, null);
  assert.equal(result.untouched, 2);
  assert.equal(result.channels[2], channels[2]);
  assert.equal(result.channels[3], channels[3]);
  // At 64 Hz neither a 30 Hz low-pass nor a 50 Hz notch fits, so O1 is left alone too.
  assert.equal(result.channels[4], channels[4]);
  assert.notEqual(result.channels[0].data, channels[0].data);
  assert.ok(result.channels[0].data instanceof Float32Array);
  assert.equal(result.channels[1].label, 'EXG Channel 0');
  assert.ok(middlePeak(result.channels[1].data) < 0.5);
  channels.forEach(({ data }, index) => assert.deepEqual(data, before[index]));
});

test('pauses within a long channel, so the page can draw', () => {
  const channels = [{ label: 'Cz', unit: 'uV', fs: 1000, data: sine(10, 1000, 200) }];
  const { pauses } = finish(filterRecording(channels, settings(1, null, null)));
  assert.ok(pauses > 4, `paused ${pauses} times`);
});

test('leaves an empty channel as it is', () => {
  const channels = [{ label: 'Cz', unit: 'uV', fs: 256, data: new Float32Array(0) }];
  const result = finish(filterRecording(channels, settings(1, null, null)));
  assert.equal(result.channels[0], channels[0]);
});

test('declines a recording too long to filter here', () => {
  const channels = [{ label: 'Cz', unit: 'uV', fs: 256, data: sine(10, 256, 10) }];
  const result = finish(filterRecording(channels, settings(1, null, null), { maxSamples: 1000 }));
  assert.deepEqual(result, { channels: null, untouched: 0, reason: 'large', pauses: 0 });
});

// Swaps the global Float64Array for one that throws, as allocation does when memory runs out.
function withFailingArrays(error, run) {
  const original = globalThis.Float64Array;
  globalThis.Float64Array = class extends original {
    constructor() {
      throw error;
    }
  };
  try {
    return run();
  } finally {
    globalThis.Float64Array = original;
  }
}

test('says so when memory runs out', () => {
  const channels = [{ label: 'Cz', unit: 'uV', fs: 256, data: sine(10, 256, 10) }];
  const result = withFailingArrays(new RangeError('Array buffer allocation failed'), () =>
    finish(filterRecording(channels, settings(1, null, null))),
  );
  assert.equal(result.reason, 'memory');
  assert.equal(result.channels, null);
});

test('lets any other error through', () => {
  const channels = [{ label: 'Cz', unit: 'uV', fs: 256, data: sine(10, 256, 10) }];
  assert.throws(
    () =>
      withFailingArrays(new TypeError('broken'), () =>
        finish(filterRecording(channels, settings(1, null, null))),
      ),
    TypeError,
  );
});
