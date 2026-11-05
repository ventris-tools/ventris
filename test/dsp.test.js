import assert from 'node:assert/strict';
import test from 'node:test';
import { demoRecording } from '../js/demo.js';
import {
  BANDS,
  bandShares,
  channelType,
  fft,
  relativeBandPower,
  timeStats,
  welch,
} from '../js/dsp.js';

const sine = (frequency, fs, seconds) =>
  Float32Array.from({ length: fs * seconds }, (_, i) => Math.sin((2 * Math.PI * frequency * i) / fs));

const index = (name) => BANDS.findIndex((band) => band.name === name);

test('fft finds a pure tone in the right bin', () => {
  const re = Float64Array.from({ length: 64 }, (_, i) => Math.cos((2 * Math.PI * 8 * i) / 64));
  const im = new Float64Array(64);
  fft(re, im);
  const magnitude = Array.from(re, (value, i) => Math.hypot(value, im[i]));
  assert.equal(magnitude.slice(0, 32).indexOf(Math.max(...magnitude.slice(0, 32))), 8);
  assert.ok(Math.abs(magnitude[8] - 32) < 1e-9);
});

for (const [frequency, band] of [[2, 'Delta'], [6, 'Theta'], [10, 'Alpha'], [20, 'Beta']]) {
  test(`a ${frequency} Hz tone lands in ${band}`, () => {
    const shares = relativeBandPower(welch(sine(frequency, 256, 10), 256));
    assert.ok(shares[index(band)] > 0.95, `share was ${shares[index(band)]}`);
  });
}

test('band shares add up to one', () => {
  const shares = relativeBandPower(welch(sine(10, 250, 10), 250));
  assert.ok(Math.abs(shares.reduce((a, b) => a + b, 0) - 1) < 1e-9);
});

test('a flat signal has no band shares', () => {
  const result = bandShares([{ label: 'Cz', fs: 256, data: new Float32Array(2560) }], 0, 10);
  assert.equal(result, null);
});

test('leaves out non-EEG and slow channels', () => {
  const result = bandShares(
    [
      { label: 'EEG Fpz-Cz', fs: 256, data: sine(10, 256, 10) },
      { label: 'EMG submental', fs: 256, data: sine(20, 256, 10) },
      { label: 'Temp rectal', fs: 256, data: sine(2, 256, 10) },
      { label: 'Slow', fs: 1, data: sine(0.1, 1, 10) },
    ],
    0,
    10,
  );
  assert.equal(result.channels, 1);
  assert.ok(result.shares[index('Alpha')] > 0.95);
});

test('the demo shows more alpha while its eyes are closed', () => {
  const { channels } = demoRecording();
  const open = bandShares(channels, 25 - 20, 10).shares[index('Alpha')];
  const closed = bandShares(channels, 25, 10).shares[index('Alpha')];
  assert.ok(closed > open * 1.5, `open ${open}, closed ${closed}`);
});

test('the demo is identical every time', () => {
  assert.deepEqual(demoRecording().channels[0].data, demoRecording().channels[0].data);
});

const channel = (label, values, unit = 'uV') => ({ label, unit, fs: 10, data: Float32Array.from(values) });

test('reads the kind of channel from its label', () => {
  assert.equal(channelType('Fc5.'), 'EEG');
  assert.equal(channelType('EEG Fpz-Cz'), 'EEG');
  assert.equal(channelType('EOG horizontal'), 'EOG');
  assert.equal(channelType('EMG submental'), 'EMG');
  assert.equal(channelType('EKG'), 'ECG');
  assert.equal(channelType('Resp oro-nasal'), 'Other');
});

test('pools time statistics across EEG channels', () => {
  const stats = timeStats([channel('C3', [1, 3]), channel('C4', [5, 7, 9, 11])]);
  const all = [1, 3, 5, 7, 9, 11];
  const mean = all.reduce((a, b) => a + b) / all.length;
  const deviation = Math.sqrt(all.reduce((a, b) => a + (b - mean) ** 2, 0) / all.length);
  assert.equal(stats.channels, 2);
  assert.equal(stats.unit, 'uV');
  assert.ok(Math.abs(stats.mean - mean) < 1e-9);
  assert.ok(Math.abs(stats.deviation - deviation) < 1e-9);
  assert.equal(stats.minimum, 1);
  assert.equal(stats.maximum, 11);
});

test('names the quietest and loudest channels and counts flat ones', () => {
  const stats = timeStats([
    channel('Flat', [4, 4, 4]),
    channel('Quiet', [1, 2, 3]),
    channel('Loud', [-50, 0, 50]),
  ]);
  assert.equal(stats.quietest.label, 'Quiet');
  assert.equal(stats.loudest.label, 'Loud');
  assert.equal(stats.flat, 1);
});

test('leaves other signals and other units out of time statistics', () => {
  const stats = timeStats([
    channel('C3', [1, 2]),
    channel('EOG left', [900, 900]),
    channel('C4', [1000, 2000], 'mV'),
  ]);
  assert.equal(stats.channels, 1);
  assert.equal(stats.maximum, 2);
  assert.equal(timeStats([channel('EOG left', [1, 2])]), null);
});
