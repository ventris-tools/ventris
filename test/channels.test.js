import assert from 'node:assert/strict';
import test from 'node:test';
import { channelType, isEeg } from '../js/channels.js';

const kinds = {
  EEG: [
    'Fc5.',
    'EEG Fpz-Cz',
    'EEG Pz (sparse)',
    'Cz',
    'O2',
    'C3-A2',
    'Fp1-F7',
    'F3-REF',
    'A1',
    'TP10',
    'FCC3h',
    'Temporal L',
    'Channel 3',
    'Ch12',
    'E12',
    '7',
  ],
  EOG: [
    'EOG horizontal',
    'L-EOG',
    'L_EOG',
    'EEG_EOG1',
    'LOC-A2',
    'ROC-A1',
    'E1-M2',
    'E2-M1',
    'HEOG',
  ],
  EMG: ['EMG submental', 'Chin', 'Chin1-Chin2', 'Leg/L', 'LLeg'],
  ECG: ['EKG', 'ECG II', 'EEG EKG1-REF'],
  Other: [
    'Resp oro-nasal',
    'Temp rectal',
    'Event marker',
    'SpO2',
    'SaO2',
    'Snore',
    'Light',
    'Sound',
    'Abdomen',
    'Thorax',
    'Airflow',
    'Nasal Pressure',
    'Pleth',
    'Position',
    'PHOTIC PH',
    'IBI',
    'BURSTS',
    'SUPPR',
    'MEG 0113',
    'ERG',
    'EP',
    'TRIG',
    'DC01',
    'HR',
    'ACCEL X',
    'Accessory',
    'Mystery',
  ],
};

for (const [kind, labels] of Object.entries(kinds)) {
  test(`reads ${kind} labels`, () => {
    for (const label of labels) assert.equal(channelType(label), kind, label);
  });
}

test('picks EEG channels out of a list', () => {
  assert.equal(isEeg({ label: 'Cz' }), true);
  assert.equal(isEeg({ label: 'Snore' }), false);
});
