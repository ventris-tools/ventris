import assert from 'node:assert/strict';
import test from 'node:test';
import { parseEdf } from '../js/edf.js';
import { answer, openRecording } from '../js/open-worker.js';
import { baseline, robustSpread } from '../js/traces.js';
import { buildCsv, lslCsv } from './support/csv.js';
import { buildEdf } from './support/edf.js';

const edf = () =>
  buildEdf(
    [
      { label: 'Cz', samples: 256, value: (r, i) => ((r * 7 + i) % 13) * 50 },
      { label: 'Pz', samples: 128, value: (r, i) => (i % 5) * 80 },
    ],
    { records: 20 },
  );

test('reads an EDF file and measures each channel as the page would', () => {
  const { reply } = openRecording({ buffer: edf(), reader: 'edf' });
  const expected = parseEdf(edf());
  assert.deepEqual(reply.recording, expected);
  assert.deepEqual(
    reply.spreads,
    expected.channels.map(({ data }) => robustSpread(data)),
  );
  assert.deepEqual(
    reply.baselines,
    expected.channels.map(({ data, fs }) => baseline(data, fs)),
  );
});

test('moves the samples and the baselines back rather than copying them, each buffer once', () => {
  const { reply, transfer } = openRecording({ buffer: edf(), reader: 'edf' });
  const buffers = [
    ...reply.recording.channels.map(({ data }) => data.buffer),
    ...reply.baselines.map(({ levels }) => levels.buffer),
  ];
  assert.equal(transfer.length, 4);
  assert.deepEqual(new Set(transfer), new Set(buffers));
  // structuredClone takes the list as postMessage does, and refuses a buffer listed twice.
  const moved = structuredClone(reply, { transfer });
  assert.equal(moved.recording.channels[0].data.length, 256 * 20);
  assert.ok(transfer.every((buffer) => buffer.detached));
});

test('reads a CSV file with the CSV reader', () => {
  const { reply, transfer } = openRecording({ buffer: lslCsv(), reader: 'csv' });
  assert.equal(reply.recording.format, 'CSV');
  assert.equal(reply.spreads.length, reply.recording.channels.length);
  assert.equal(transfer.length, 2 * reply.recording.channels.length);
});

test("passes on a reader's error in its own words, and says which reader's they are", () => {
  const junk = new Uint8Array(600).fill(120).buffer;
  assert.deepEqual(openRecording({ buffer: junk, reader: 'edf' }), {
    reply: { error: { kind: 'edf', message: 'This does not look like an EDF file.' } },
    transfer: [],
  });
  const noTimes = buildCsv(
    ['Cz', 'Pz'],
    [
      [1, 2],
      [3, 4],
    ],
  );
  assert.deepEqual(openRecording({ buffer: noTimes, reader: 'csv' }).reply.error, {
    kind: 'csv',
    message: 'This CSV has no time column, so its sample rate is unknown.',
  });
});

test('says when anything else goes wrong, so the page blames nothing in the file', () => {
  const { reply, transfer } = openRecording({ buffer: edf(), reader: 'xls' });
  assert.equal(reply.error.kind, 'other');
  assert.deepEqual(transfer, []);
});

test('answers each message sent to its scope, with the buffers to move', () => {
  const posted = [];
  const scope = new EventTarget();
  scope.postMessage = (...args) => posted.push(args);
  answer(scope);
  scope.dispatchEvent(new MessageEvent('message', { data: { buffer: edf(), reader: 'edf' } }));
  scope.dispatchEvent(new MessageEvent('message', { data: { buffer: edf(), reader: 'csv' } }));
  const [[opened, transfer], [failed]] = posted;
  assert.equal(opened.recording.channels.length, 2);
  assert.equal(transfer.length, 4);
  assert.equal(failed.error.kind, 'csv');
});
