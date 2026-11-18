import assert from 'node:assert/strict';
import test from 'node:test';
import {
  describe,
  isOff,
  NO_FILTERS,
  record,
  redo,
  startHistory,
  STEPS,
  undo,
} from '../js/steps.js';

const filters = (highpass, lowpass, notch) => ({ highpass, lowpass, notch });

test('offers high-pass choices that all sit below the low-pass ones', () => {
  const choices = Object.fromEntries(STEPS.map(({ key, choices: list }) => [key, list]));
  assert.ok(Math.max(...choices.highpass) < Math.min(...choices.lowpass));
  assert.deepEqual(Object.keys(NO_FILTERS), Object.keys(choices));
});

test('says what the filter is in a few words', () => {
  assert.equal(describe(filters(0.5, 70, 50)), '0.5 to 70 Hz · 50 Hz notch');
  assert.equal(describe(filters(0.1, null, null)), '0.1 Hz high-pass');
  assert.equal(describe(filters(null, 40, 60)), '40 Hz low-pass · 60 Hz notch');
  assert.equal(describe(filters(null, null, 50)), '50 Hz notch');
  assert.equal(describe(NO_FILTERS), '');
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
