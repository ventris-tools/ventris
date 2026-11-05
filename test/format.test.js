import assert from 'node:assert/strict';
import test from 'node:test';
import { amount, count, decimalsFor, formatClock, rowRange, unitLabel } from '../js/format.js';

test('writes a time as minutes or hours', () => {
  assert.equal(formatClock(0), '0:00');
  assert.equal(formatClock(61), '1:01');
  assert.equal(formatClock(3661), '1:01:01');
});

test('keeps half seconds apart when asked for decimals', () => {
  const labels = [60, 60.5, 61, 61.5].map((time) => formatClock(time, 1));
  assert.deepEqual(labels, ['1:00.0', '1:00.5', '1:01.0', '1:01.5']);
});

test('carries a rounded fraction into the next second', () => {
  assert.equal(formatClock(59.96, 1), '1:00.0');
  assert.equal(formatClock(28789.91, 2), '7:59:49.91');
});

test('chooses decimals from the size of a range', () => {
  assert.equal(decimalsFor(213), 1);
  assert.equal(decimalsFor(0.5), 3);
  assert.equal(decimalsFor(5e-5), 7);
  assert.equal(decimalsFor(0), 1);
  assert.equal(decimalsFor(1e-300), 20);
});

test('writes amounts with a true minus and no sign on zero', () => {
  assert.equal(amount(-1200, 'uV'), '−1,200.0 µV');
  assert.equal(amount(-0.01, 'uV'), '0.0 µV');
  assert.equal(amount(2, ''), '2.0');
  assert.equal(amount(-0.00002, 'V', 7), '−0.0000200 V');
});

test('writes how far a row reaches', () => {
  assert.equal(rowRange(32.7, 'uV'), '±33 µV');
  assert.equal(rowRange(1234, 'uV'), '±1,200 µV');
  assert.equal(rowRange(0.0123, 'mV'), '±0.012 mV');
});

test('counts with the right plural', () => {
  assert.equal(count(1, 'channel'), '1 channel');
  assert.equal(count(8, 'EEG channel'), '8 EEG channels');
});

test('spells out microvolts only', () => {
  assert.equal(unitLabel('uV'), 'µV');
  assert.equal(unitLabel('uA'), 'uA');
});
