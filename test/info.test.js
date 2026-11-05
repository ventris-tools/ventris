import assert from 'node:assert/strict';
import test from 'node:test';
import { demoRecording } from '../js/demo.js';
import { timeStats } from '../js/dsp.js';
import { infoGroups, timeRows } from '../js/info.js';

const subject = {
  id: null, name: null, sex: null, birthday: null, hand: null, height: null, weight: null,
};

function recording(info = {}, channels = [{ label: 'Cz', unit: 'uV', fs: 160, data: new Float32Array(1) }]) {
  return {
    format: 'EDF+',
    duration: 61,
    channels,
    warnings: [],
    info: {
      date: '2009-08-12',
      time: '16:15:00',
      subject,
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
  assert.deepEqual(filters, [['Highpass', '0 Hz'], ['Lowpass', '80 Hz']]);
});

test('adds participant, device and notch rows when the file has them', () => {
  const { general, filters } = infoGroups(
    recording({
      subject: { ...subject, id: 'P1', name: 'Ann Lee', sex: 'Female', birthday: '1951-05-02', hand: 2, height: 1.7, weight: 60 },
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
  assert.deepEqual(groups.channels, [['EEG', '2'], ['EOG', '1'], ['Units', 'µV, mV']]);
  assert.equal(lookup(groups.acquisition)['Sample rate'], '64 to 256 Hz');
  assert.equal(lookup(groups.acquisition)['Time points'], '15,616');
});

test('leaves the unit row out when no channel states one', () => {
  const channels = [{ label: 'Cz', unit: '', fs: 160, data: new Float32Array(1) }];
  assert.deepEqual(infoGroups(recording({}, channels)).channels, [['EEG', '1']]);
});

test('formats time statistics with their unit', () => {
  const rows = lookup(
    timeRows(timeStats([{ label: 'Cz', unit: 'uV', fs: 2, data: Float32Array.from([-1200, 1000]) }])),
  );
  assert.equal(rows.Mean, '−100.0 µV');
  assert.equal(rows.Minimum, '−1,200.0 µV');
  assert.equal(rows['Peak to peak'], '2,200.0 µV');
  assert.equal(rows['Highest SD'], 'Cz 1,100.0 µV');
  assert.equal(rows['Flat channels'], '0');
});

test('leaves channel rows out when every channel is flat', () => {
  const rows = timeRows(timeStats([{ label: 'Cz', unit: 'uV', fs: 2, data: Float32Array.from([3, 3]) }]));
  assert.ok(!labels(rows).includes('Lowest SD'));
  assert.ok(!labels(rows).includes('Highest SD'));
  assert.equal(lookup(rows)['Flat channels'], '1');
});

test('the demo fills every section the way a real file does', () => {
  const demo = demoRecording();
  const { general, channels } = infoGroups(demo);
  assert.equal(lookup(general)['Start date'], '2026-01-15');
  assert.deepEqual(channels, [['EEG', '8'], ['Unit', 'µV']]);
  assert.ok(timeRows(timeStats(demo.channels)).length > 0);
});
