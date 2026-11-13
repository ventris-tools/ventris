import assert from 'node:assert/strict';
import test from 'node:test';
import { CsvError, parseCsv } from '../js/csv.js';
import { buildCsv, ELECTRODES, lslCsv } from './support/csv.js';

const text = (value) => new TextEncoder().encode(value).buffer;

// Times a sample rate apart, from zero.
const timed = (fs, columns) => columns.map((cells, i) => [i / fs, ...cells]);

const near = (actual, expected, tolerance = 1e-6) =>
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} is not ${expected}`);

test('reads a Lab Streaming Layer recording, with its markers as annotations', () => {
  const recording = parseCsv(lslCsv());
  assert.equal(recording.format, 'CSV');
  assert.deepEqual(
    recording.channels.map(({ label }) => label),
    ELECTRODES,
  );
  assert.ok(recording.channels.every(({ fs, unit }) => fs === 250 && unit === ''));
  assert.equal(recording.channels[0].data.length, 2002);
  near(recording.channels[0].data[0], 250000, 0.05);
  near(recording.channels[7].data[0], 257000 + 10 * Math.sin(7), 0.05);
  assert.equal(recording.duration, 2002 / 250);
  assert.deepEqual(recording.annotations, [
    { time: 1, duration: 0, text: 'trial_start' },
    { time: 4, duration: 0, text: 'move' },
    { time: 6, duration: 0, text: 'cue_stop' },
  ]);
  assert.deepEqual(recording.warnings, []);
});

// In single precision, times near 53,704 s come in steps of 0.0039 s, and the rate would
// come out as 256 Hz.
test('keeps the times precise enough to tell one sample from the next', () => {
  const { info, channels } = parseCsv(lslCsv());
  assert.equal(channels[0].fs, 250);
  near(info.firstTime, 53704.78020202602, 1e-9);
});

test('says nothing about filters, which a CSV does not record', () => {
  const { info } = parseCsv(lslCsv());
  assert.equal(info.highpass, null);
  assert.equal(info.lowpass, null);
  assert.equal(info.notch, null);
  assert.equal(info.date, null);
  assert.equal(info.subject.id, null);
});

test('keeps a measured rate that is not near any device rate', () => {
  const recording = parseCsv(buildCsv(['time', 'Cz'], timed(333, [[1], [2], [3], [4]])));
  near(recording.channels[0].fs, 333);
});

test('reads times in milliseconds when the name says so', () => {
  for (const name of ['time_ms', 'Timestamp (ms)', 'time_milliseconds']) {
    const rows = [0, 4, 8, 12].map((time) => [time, 1]);
    assert.equal(parseCsv(buildCsv([name, 'Cz'], rows)).channels[0].fs, 250, name);
  }
});

test('finds the time column under the names recorders give it', () => {
  for (const name of ['time', 'Time (s)', 'timestamp', 'TimeStamps', 'lsl_timestamp']) {
    const recording = parseCsv(
      buildCsv(
        ['Cz', name],
        timed(100, [[1], [2], [3]]).map(([t, v]) => [v, t]),
      ),
    );
    assert.equal(recording.channels[0].fs, 100, name);
    assert.equal(recording.channels[0].label, 'Cz');
  }
});

test('reads a unit of voltage from the end of a name', () => {
  const header = [
    'time',
    'Fz [uV]',
    'Cz (µV)',
    'Pz (μV)',
    'Oz [mV]',
    'EOG(V)',
    'Accel X [g]',
    '[uV]',
  ];
  const recording = parseCsv(
    buildCsv(
      header,
      timed(250, [
        [1, 2, 3, 4, 5, 6, 7],
        [1, 2, 3, 4, 5, 6, 7],
      ]),
    ),
  );
  assert.deepEqual(
    recording.channels.map(({ label, unit }) => [label, unit]),
    [
      ['Fz', 'uV'],
      ['Cz', 'uV'],
      ['Pz', 'uV'],
      ['Oz', 'mV'],
      ['EOG', 'V'],
      ['Accel X [g]', ''],
      ['Channel 8', 'uV'],
    ],
  );
});

test('skips the row numbers that pandas and recorders write', () => {
  for (const name of ['', 'Unnamed: 0', 'index', 'Sample Index']) {
    const rows = [0, 1, 2].map((i) => [i, i / 250, 5]);
    const recording = parseCsv(buildCsv([name, 'time', 'Cz'], rows));
    assert.deepEqual(
      recording.channels.map(({ label }) => label),
      ['Cz'],
      name,
    );
  }
});

test('reads files split by semicolons or tabs, which may write decimal commas', () => {
  const semicolons = parseCsv(text('time;Cz;Pz\n0,000;1,5;2\n0,004;2,5;3\n'));
  assert.equal(semicolons.channels[0].fs, 250);
  assert.deepEqual([...semicolons.channels[0].data], [1.5, 2.5]);
  const tabs = parseCsv(text('time\tCz\n0.000\t1.5\n0.004\t2,5\n'));
  assert.deepEqual([...tabs.channels[0].data], [1.5, 2.5]);
});

test('keeps a quoted cell whole, quotes and delimiters included', () => {
  const rows = ['time,Cz,"Event, note"', '0,1,"cue ""a"", b"', '0.004,2,', '0.008,3,'];
  const recording = parseCsv(text(rows.join('\n')));
  assert.equal(recording.channels.length, 1);
  assert.deepEqual(recording.annotations, [{ time: 0, duration: 0, text: 'cue "a", b' }]);
});

test('passes over comments, blank lines, a byte order mark and Windows line ends', () => {
  const recording = parseCsv(
    buildCsv(['time', 'Cz'], [[0, 1], [0.004, 2], [], [0.008, 3]], {
      before: ['﻿%OpenBCI Raw EXG Data', '# Sample Rate = 250 Hz', ''],
      eol: '\r\n',
    }),
  );
  assert.deepEqual([...recording.channels[0].data], [1, 2, 3]);
  assert.equal(recording.channels[0].fs, 250);
});

test('warns about gaps in the times, which the time axis does not show', () => {
  const rows = [0, 0.004, 0.008, 2, 2.004, 2.008].map((time) => [time, 1]);
  const { warnings, duration } = parseCsv(buildCsv(['time', 'Cz'], rows));
  assert.deepEqual(warnings, ['This recording has gaps, which the time axis does not show.']);
  assert.equal(duration, 6 / 250);
});

test('turns a mostly empty column of numbers into events', () => {
  const rows = timed(100, [
    [1, 7],
    [2, ''],
    [3, ''],
    [4, 9],
  ]);
  const { annotations, channels } = parseCsv(buildCsv(['time', 'Cz', 'Trigger'], rows));
  assert.deepEqual(
    channels.map(({ label }) => label),
    ['Cz'],
  );
  assert.deepEqual(annotations, [
    { time: 0, duration: 0, text: '7' },
    { time: 0.03, duration: 0, text: '9' },
  ]);
});

test('names the column of each event when there is more than one', () => {
  const rows = timed(100, [
    [1, '', 'start'],
    [2, 4, ''],
    [3, '', ''],
    [4, '', ''],
  ]);
  const { annotations } = parseCsv(buildCsv(['time', 'Cz', 'Code', 'Note'], rows));
  assert.deepEqual(
    annotations.map(({ text: label }) => label),
    ['Note: start', 'Code: 4'],
  );
});

test('leaves out columns of words, and says which', () => {
  const rows = timed(
    250,
    [1, 2, 3, 4, 5, 6].map((v) => [v, `12:00:0${v}`, '']),
  );
  const { channels, annotations, warnings } = parseCsv(
    buildCsv(['time', 'Cz', 'Timestamp (Formatted)', 'Spare'], rows),
  );
  assert.deepEqual(
    channels.map(({ label }) => label),
    ['Cz'],
  );
  assert.deepEqual(annotations, []);
  assert.deepEqual(warnings, [
    'Left out columns of words rather than numbers: Timestamp (Formatted).',
  ]);
});

test('fills empty cells in a channel from the value before them', () => {
  const rows = timed(250, [[''], [2], ['NaN'], [4], [5], [' '], [7]]);
  const recording = parseCsv(buildCsv(['time', 'Cz'], rows));
  assert.deepEqual([...recording.channels[0].data], [2, 2, 2, 4, 5, 5, 7]);
  assert.deepEqual(recording.warnings, [
    'Some cells are empty, so those samples repeat the value before them.',
  ]);
});

test('reads a short row as ending in empty cells', () => {
  const recording = parseCsv(text('time,Cz,Marker\n0,1,start\n0.004,2\n0.008,3\n'));
  assert.deepEqual([...recording.channels[0].data], [1, 2, 3]);
  assert.equal(recording.annotations.length, 1);
});

test('rejects files it cannot read, saying why', () => {
  const cases = [
    ['', 'This CSV file is empty.'],
    ['% only a comment\n\n', 'This CSV file is empty.'],
    ['0,1\n0.004,2\n', 'This CSV has no header row naming its columns.'],
    ['Cz,Pz\n1,2\n3,4\n', 'This CSV has no time column, so its sample rate is unknown.'],
    ['time,Cz\n0,1\n', 'This CSV has fewer than two rows of samples.'],
    ['time,Cz\n0,1\nlater,2\n', "The time column has cells that aren't numbers."],
    ['time,Cz\n0,1\n,2\n', "The time column has cells that aren't numbers."],
    [
      'time,Cz\n5,1\n5,2\n5,3\n',
      "The times in this file don't count up, so its sample rate is unknown.",
    ],
    ['time,Cz\n0,1\n1e-7,2\n', "The time column doesn't look like seconds."],
    ['time,Cz\n0,1\n1e9,2\n', "The time column doesn't look like seconds."],
    ['time,Note\n0,a\n0.004,b\n', 'This CSV has no columns of numbers to show.'],
  ];
  for (const [file, message] of cases) {
    assert.throws(() => parseCsv(text(file)), new CsvError(message), file);
  }
});
