import assert from 'node:assert/strict';
import test from 'node:test';
import {
  describe,
  isOff,
  NO_FILTERS,
  record,
  redo,
  runSteps,
  startHistory,
  STEPS,
  undo,
} from '../js/steps.js';

const filters = (highpass, lowpass, notch, montage = null) => ({
  highpass,
  lowpass,
  notch,
  montage,
});

test('offers high-pass choices that all sit below the low-pass ones', () => {
  const values = Object.fromEntries(
    STEPS.map(({ key, choices }) => [key, choices.map(({ value }) => value)]),
  );
  assert.ok(Math.max(...values.highpass) < Math.min(...values.lowpass));
  assert.deepEqual(Object.keys(NO_FILTERS), Object.keys(values));
  assert.deepEqual(values.montage, ['average', 'laplacian']);
  assert.equal(STEPS[0].choices[0].text, '0.1 Hz');
});

test('says what the filter and the montage are in a few words', () => {
  const words = (settings) => Object.values(describe(settings));
  assert.deepEqual(words(filters(0.5, 70, 50)), ['0.5 to 70 Hz · 50 Hz notch', '']);
  assert.deepEqual(words(filters(0.1, null, null)), ['0.1 Hz high-pass', '']);
  assert.deepEqual(words(filters(null, 40, 60)), ['40 Hz low-pass · 60 Hz notch', '']);
  assert.deepEqual(words(filters(null, null, 50, 'laplacian')), ['50 Hz notch', 'Laplacian']);
  assert.deepEqual(words(filters(null, null, null, 'average')), ['', 'average reference']);
  assert.deepEqual(words(NO_FILTERS), ['', '']);
});

test('knows when every filter is off', () => {
  assert.equal(isOff(NO_FILTERS), true);
  assert.equal(isOff(filters(null, null, 50)), false);
});

test('undoes and redoes changes in order', () => {
  let history = startHistory();
  history = record(history, filters(0.5, null, null));
  history = record(history, filters(0.5, 70, null));
  history = undo(history);
  assert.deepEqual(history.present, filters(0.5, null, null));
  history = undo(history);
  assert.deepEqual(history.present, NO_FILTERS);
  history = redo(history);
  assert.deepEqual(history.present, filters(0.5, null, null));
  history = redo(history);
  assert.deepEqual(history.present, filters(0.5, 70, null));
});

test('has nowhere to go past either end', () => {
  const history = startHistory();
  assert.equal(undo(history), history);
  assert.equal(redo(history), history);
});

test('ignores a change that changes nothing', () => {
  const history = record(startHistory(), filters(1, null, null));
  assert.equal(record(history, filters(1, null, null)), history);
});

test('forgets what could be redone once something new is chosen', () => {
  let history = record(startHistory(), filters(1, null, null));
  history = record(undo(history), filters(2, null, null));
  assert.equal(redo(history), history);
});

test('keeps a hundred changes to undo', () => {
  let history = startHistory();
  for (let step = 1; step <= 150; step += 1) history = record(history, filters(null, null, step));
  assert.equal(history.past.length, 100);
  for (let step = 0; step < 100; step += 1) history = undo(history);
  assert.deepEqual(history.present, filters(null, null, 50));
  assert.equal(undo(history), history);
});

// Runs the steps straight through, as the app does when nothing changes under them.
function finish(steps) {
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

const channel = (label, values) => ({
  label,
  unit: 'uV',
  fs: 256,
  data: Float32Array.from(values),
});

test('filters first, then takes the montage over the filtered samples', () => {
  const ramp = Array.from({ length: 2560 }, (_, i) => 500 + i + 20 * Math.sin(i / 3));
  const channels = [
    channel('Cz', ramp),
    channel(
      'C3',
      ramp.map((value) => value + 7),
    ),
  ];
  const filtered = finish(runSteps(channels, filters(1, null, null)));
  const both = finish(runSteps(channels, filters(1, null, null, 'average')));
  assert.equal(both.reason, null);
  assert.equal(both.channels[0].mark, 'avg');
  // The two channels differ by a constant, which the high-pass took away, so the average
  // leaves each with half of nothing.
  const left = both.channels[0].data.map(
    (value, i) => value - (filtered.channels[0].data[i] - filtered.channels[1].data[i]) / 2,
  );
  assert.ok(left.every((value) => Math.abs(value) < 1e-3));
});

test('runs the montage alone, with no filter', () => {
  const channels = [channel('Cz', [1, 2, 3]), channel('Pz', [3, 2, 1])];
  const result = finish(runSteps(channels, filters(null, null, null, 'average')));
  assert.deepEqual(Array.from(result.channels[0].data), [-1, 0, 1]);
  assert.equal(result.untouched, 0);
});

test('declines to mix a recording too long to process here', () => {
  const channels = [channel('Cz', [1, 2, 3]), channel('Pz', [3, 2, 1])];
  const result = finish(
    runSteps(channels, filters(null, null, null, 'average'), { maxSamples: 4 }),
  );
  assert.equal(result.reason, 'large');
  const filtered = finish(runSteps(channels, filters(1, null, null, 'average'), { maxSamples: 4 }));
  assert.equal(filtered.reason, 'large');
});

// Swaps the global Float32Array for one that throws, as allocation does when memory runs out.
function withFailingArrays(error, run) {
  const original = globalThis.Float32Array;
  const failing = class extends original {
    constructor() {
      throw error;
    }
  };
  globalThis.Float32Array = failing;
  try {
    return run();
  } finally {
    globalThis.Float32Array = original;
  }
}

test('says so when memory runs out mixing channels, and lets any other error through', () => {
  const channels = [channel('Cz', [1, 2, 3]), channel('Pz', [3, 2, 1])];
  const settings = filters(null, null, null, 'laplacian');
  const result = withFailingArrays(new RangeError('no room'), () =>
    finish(runSteps(channels, filters(null, null, null, 'average'))),
  );
  assert.equal(result.reason, 'memory');
  assert.throws(
    () =>
      withFailingArrays(new TypeError('broken'), () =>
        finish(runSteps(channels, filters(null, null, null, 'average'))),
      ),
    TypeError,
  );
  assert.equal(finish(runSteps(channels, settings)).kept, 2);
});
