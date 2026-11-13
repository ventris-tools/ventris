import assert from 'node:assert/strict';
import test from 'node:test';
import { demoRecording } from '../js/demo.js';
import { timeStats } from '../js/dsp.js';
import { NO_SUBJECT } from '../js/edf.js';
import { infoGroups, timeRows } from '../js/info.js';

function recording(
  info = {},
  channels = [{ label: 'Cz', unit: 'uV', fs: 160, data: new Float32Array(1) }],
) {
  return {
    format: 'EDF+',
    duration: 61,
    channels,
    annotations: [],
    warnings: [],
    info: {
      date: '2009-08-12',
      time: '16:15:00',
      subject: NO_SUBJECT,
      project: null,
      experimenter: null,
      device: null,
      highpass: 0,
      lowpass: 80,
      notch: null,
      ...info,
    },
  };
}

const labels = (rows) => rows.map(([label]) => label);
const lookup = (rows) => Object.fromEntries(rows);

test('shows the rows MNE always shows and hides what the file lacks', () => {
  const { general, acquisition, filters } = infoGroups(recording());
  assert.deepEqual(labels(general), ['Start date', 'Start time', 'Participant', 'Experimenter']);
  assert.equal(lookup(general).Participant, 'Unknown');
  assert.deepEqual(acquisition, [
    ['Duration', '1:01'],
    ['Sample rate', '160 Hz'],
    ['Time points', '9,760'],
    ['Format', 'EDF+'],
  ]);
  assert.deepEqual(filters, [
    ['Highpass', '0 Hz'],
    ['Lowpass', '80 Hz'],
  ]);
});

test('shows filters as unknown, and the first timestamp, for a CSV', () => {
  const { acquisition, filters } = infoGroups(
    recording({ highpass: null, lowpass: null, firstTime: 53704.78020002602 }),
  );
  assert.equal(lookup(acquisition)['First timestamp'], '53704.780 s');
  assert.deepEqual(filters, [
    ['Highpass', 'Unknown'],
    ['Lowpass', 'Unknown'],
  ]);
});

test('adds participant, device and notch rows when the file has them', () => {
  const { general, filters } = infoGroups(
    recording({
      subject: {
        ...NO_SUBJECT,
        id: 'P1',
        name: 'Ann Lee',
        sex: 'Female',
        birthday: '1951-05-02',
        hand: 2,
        height: 1.7,
        weight: 60,
      },
      experimenter: 'NN',
      device: 'Telemetry03',
      project: 'PSG-1',
      notch: 50,
    }),
  );
  assert.deepEqual(lookup(general), {
    'Start date': '2009-08-12',
    'Start time': '16:15:00',
    Participant: 'P1',
    Name: 'Ann Lee',
    Sex: 'Female',
    'Birth date': '1951-05-02',
    Hand: 'Left',
    Height: '1.7 m',
    Weight: '60 kg',
    Experimenter: 'NN',
    Device: 'Telemetry03',
    Project: 'PSG-1',
  });
  assert.equal(lookup(filters).Notch, '50 Hz');
});

test('counts channels by kind and lists every unit', () => {
  const channels = [
    { label: 'C3', unit: 'uV', fs: 256, data: new Float32Array(1) },
    { label: 'C4', unit: 'uV', fs: 256, data: new Float32Array(1) },
    { label: 'EOG left', unit: 'mV', fs: 64, data: new Float32Array(1) },
  ];
  const groups = infoGroups(recording({}, channels));
  assert.deepEqual(groups.channels, [
    ['EEG', '2'],
    ['EOG', '1'],
    ['Units', 'µV, mV'],
  ]);
  assert.equal(lookup(groups.acquisition)['Sample rate'], '64 to 256 Hz');
  assert.equal(lookup(groups.acquisition)['Time points'], '15,616');
});

test('leaves the unit row out when no channel states one', () => {
  const channels = [{ label: 'Cz', unit: '', fs: 160, data: new Float32Array(1) }];
  assert.deepEqual(infoGroups(recording({}, channels)).channels, [['EEG', '1']]);
});

test('formats time statistics with their unit', () => {
  const rows = lookup(
    timeRows(
      timeStats([{ label: 'Cz', unit: 'uV', fs: 2, data: Float32Array.from([-1200, 1000]) }]),
    ),
  );
  assert.equal(rows.Mean, '−100.0 µV');
  assert.equal(rows.Minimum, '−1,200.0 µV');
  assert.equal(rows['Peak to peak'], '2,200.0 µV');
  assert.equal(rows['Highest SD'], 'Cz 1,100.0 µV');
  assert.equal(rows['Flat channels'], '0');
});

test('leaves channel rows out when every channel is flat', () => {
  const rows = timeRows(
    timeStats([{ label: 'Cz', unit: 'uV', fs: 2, data: Float32Array.from([3, 3]) }]),
  );
  assert.ok(!labels(rows).includes('Lowest SD'));
  assert.ok(!labels(rows).includes('Highest SD'));
  assert.equal(lookup(rows)['Flat channels'], '1');
});

test('rounds both ends of a range of sample rates', () => {
  const channels = [
    { label: 'Fz', unit: 'uV', fs: 2560 / 3, data: new Float32Array(1) },
    { label: 'Slow', unit: 'uV', fs: 10 / 3, data: new Float32Array(1) },
  ];
  const rows = lookup(infoGroups(recording({}, channels)).acquisition);
  assert.equal(rows['Sample rate'], '3.33 to 853.33 Hz');
});

test('counts annotations when there are any', () => {
  const rows = (annotations) => lookup(infoGroups({ ...recording(), annotations }).acquisition);
  assert.equal(rows([]).Annotations, undefined);
  assert.equal(rows([{ time: 1, duration: 0, text: 'T1' }]).Annotations, '1');
});

test('keeps small signals readable in larger units', () => {
  const rows = lookup(
    timeRows(
      timeStats([{ label: 'Cz', unit: 'V', fs: 2, data: Float32Array.from([-2e-5, 3e-5]) }]),
    ),
  );
  assert.equal(rows.Minimum, '−0.0000200 V');
  assert.equal(rows.Maximum, '0.0000300 V');
  assert.equal(rows['Peak to peak'], '0.0000500 V');
});

test('the demo says it is synthetic and fills every section', () => {
  const demo = demoRecording();
  const { general, acquisition, channels } = infoGroups(demo);
  assert.equal(lookup(general)['Start date'], 'Unknown');
  assert.equal(lookup(acquisition).Format, 'Synthetic');
  assert.equal(lookup(acquisition).Annotations, '2');
  assert.deepEqual(channels, [
    ['EEG', '8'],
    ['Unit', 'µV'],
  ]);
  assert.ok(timeRows(timeStats(demo.channels)).length > 0);
});
