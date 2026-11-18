import assert from 'node:assert/strict';
import test from 'node:test';
import { applyMontage, electrodeOf, neighboursOf, positionOf } from '../js/montage.js';

// The 64 channels of PhysioNet's EEG Motor Movement/Imagery Dataset, as its EDF files label
// them.
// prettier-ignore
const PHYSIONET = [
  'Fc5.', 'Fc3.', 'Fc1.', 'Fcz.', 'Fc2.', 'Fc4.', 'Fc6.', 'C5..', 'C3..', 'C1..', 'Cz..', 'C2..',
  'C4..', 'C6..', 'Cp5.', 'Cp3.', 'Cp1.', 'Cpz.', 'Cp2.', 'Cp4.', 'Cp6.', 'Fp1.', 'Fpz.', 'Fp2.',
  'Af7.', 'Af3.', 'Afz.', 'Af4.', 'Af8.', 'F7..', 'F5..', 'F3..', 'F1..', 'Fz..', 'F2..', 'F4..',
  'F6..', 'F8..', 'Ft7.', 'Ft8.', 'T7..', 'T8..', 'T9..', 'T10.', 'Tp7.', 'Tp8.', 'P7..', 'P5..',
  'P3..', 'P1..', 'Pz..', 'P2..', 'P4..', 'P6..', 'P8..', 'Po7.', 'Po3.', 'Poz.', 'Po4.', 'Po8.',
  'O1..', 'Oz..', 'O2..', 'Iz..',
];

// prettier-ignore
const TEN_TWENTY = [
  'Fp1', 'Fp2', 'F7', 'F3', 'Fz', 'F4', 'F8', 'T3', 'C3', 'Cz', 'C4', 'T4', 'T5', 'P3', 'Pz',
  'P4', 'T6', 'O1', 'O2',
];

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} is not ${b}`);
const degrees = (a, b) => (Math.acos(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) * 180) / Math.PI;

// Each label's neighbours, by name.
function neighbourNames(labels) {
  const sites = labels.map((label) => electrodeOf(label).site);
  const found = neighboursOf(sites.map((site) => positionOf(site)));
  return Object.fromEntries(
    sites.map((site, index) => [site, found[index]?.map((other) => sites[other]).sort() ?? null]),
  );
}

test('reads the electrode a label names, however it is written', () => {
  const sites = {
    'C3..': 'C3',
    'Fc5.': 'FC5',
    'EEG C3-A2': 'C3',
    'F3-REF': 'F3',
    'EEG Pz (sparse)': 'PZ',
    T3: 'T7',
    'T6-LE': 'P8',
    'Channel 3': null,
  };
  for (const [label, site] of Object.entries(sites)) {
    assert.deepEqual(electrodeOf(label), { site, mixed: false }, label);
  }
});

test('keeps bipolar pairs and reference sites out of any montage', () => {
  for (const label of ['Fp1-F7', 'EEG Fpz-Cz', 'A1', 'M2', 'EEG A2']) {
    assert.deepEqual(electrodeOf(label), { site: null, mixed: true }, label);
  }
});

test('places electrodes on the sphere where the 10-10 system puts them', () => {
  for (const site of ['CZ', 'C3', 'FP1', 'O2', 'IZ', 'T10', 'PO8']) {
    const [x, y, z] = positionOf(site);
    near(x * x + y * y + z * z, 1);
  }
  const cz = positionOf('CZ');
  near(degrees(cz, positionOf('C3')), 36);
  near(degrees(cz, positionOf('T7')), 72);
  near(degrees(cz, positionOf('FPZ')), 72);
  near(
    degrees(positionOf('FPZ'), positionOf('FP1')),
    degrees(positionOf('FPZ'), positionOf('FP2')),
  );
  // Left and right are mirror images, and the midline sits between them.
  const [x3, y3, z3] = positionOf('FC3');
  const [x4, y4, z4] = positionOf('FC4');
  assert.deepEqual([x3, -y3, z3], [x4, y4, z4]);
  near(positionOf('PZ')[1], 0);
  assert.ok(positionOf('O1')[1] > 0 && positionOf('O1')[0] < 0);
  assert.equal(positionOf('FCC3H'), null);
  assert.equal(positionOf('X1'), null);
});

test('finds the four electrodes around C3 and C4, as a surface Laplacian takes them', () => {
  const names = neighbourNames(PHYSIONET);
  assert.deepEqual(names.C3, ['C1', 'C5', 'CP3', 'FC3']);
  assert.deepEqual(names.C4, ['C2', 'C6', 'CP4', 'FC4']);
  assert.deepEqual(names.CZ, ['C1', 'C2', 'CPZ', 'FCZ']);
  assert.deepEqual(names.FP1, ['AF3', 'AF7', 'FPZ']);
  // Every channel on the cap has at least two, all nearby.
  assert.ok(Object.values(names).every((list) => list && list.length >= 2));
});

test('reaches further for neighbours on a sparser cap', () => {
  const names = neighbourNames(TEN_TWENTY);
  assert.deepEqual(names.C3, ['CZ', 'F3', 'P3', 'T7']);
  assert.deepEqual(names.CZ, ['C3', 'C4', 'FZ', 'PZ']);
});

test('gives no neighbours to an electrode with too few nearby, or none known', () => {
  const lone = neighboursOf([positionOf('C3'), positionOf('CZ'), positionOf('C4')]);
  assert.equal(lone[0], null);
  assert.deepEqual(lone[1], [0, 2]);
  assert.deepEqual(neighboursOf([null, positionOf('CZ')]), [null, null]);
});

// Runs a montage straight through, counting its pauses.
function finish(steps) {
  let pauses = 0;
  let step = steps.next();
  while (!step.done) {
    pauses += 1;
    step = steps.next();
  }
  return { ...step.value, pauses };
}

const channel = (label, values, fs = 256) => ({
  label,
  unit: 'uV',
  fs,
  data: Float32Array.from(values),
});

test('takes the average of the EEG channels away from each, and marks them', () => {
  const channels = [
    channel('Cz', [1, 2, 3, 4]),
    channel('C3', [3, 4, 5, 6]),
    channel('C4', [5, 0, 1, 2]),
    channel('EOG left', [100, 100, 0, 0]),
    channel('Fp1-F7', [9, 9, 9, 8]),
    channel('A1', [7, 6, 5, 4]),
    channel('Pz', [2, 2, 2, 2]),
    channel('Oz', [1, 2], 128),
    channel('Resp', [0, 1, 0, 1]),
  ];
  const { channels: mixed, kept } = finish(applyMontage(channels, 'average'));
  assert.deepEqual(Array.from(mixed[0].data), [-2, 0, 0, 0]);
  assert.deepEqual(Array.from(mixed[2].data), [2, -2, -2, -2]);
  assert.deepEqual(
    mixed.map(({ mark }) => mark ?? null),
    ['avg', 'avg', 'avg', null, null, null, null, null, null],
  );
  // The bipolar pair, the reference site, the flat channel and the slower channel stay.
  for (const index of [3, 4, 5, 6, 7, 8]) assert.equal(mixed[index], channels[index]);
  assert.equal(kept, 4);
  assert.deepEqual(Array.from(channels[0].data), [1, 2, 3, 4]);
});

test('leaves every channel alone when fewer than two can be averaged', () => {
  const channels = [channel('Cz', [1, 2, 3]), channel('EOG', [1, 2, 3])];
  const { channels: mixed, kept } = finish(applyMontage(channels, 'average'));
  assert.equal(mixed[0], channels[0]);
  assert.equal(kept, 1);
  assert.deepEqual(finish(applyMontage([], 'average')).channels, []);
});

test('takes the mean of its neighbours away from each electrode', () => {
  const labels = PHYSIONET;
  const channels = labels.map((label, index) =>
    channel(
      label,
      Array.from({ length: 300 }, (_, i) => Math.sin(i / (index + 3)) * (index + 1)),
      160,
    ),
  );
  const { channels: mixed, kept } = finish(applyMontage(channels, 'laplacian'));
  assert.equal(kept, 0);
  const at = (label) => labels.indexOf(label);
  const c3 = mixed[at('C3..')];
  assert.equal(c3.mark, 'lap');
  const around = ['C5..', 'C1..', 'Fc3.', 'Cp3.'].map((label) => channels[at(label)].data);
  c3.data.forEach((value, i) => {
    const expected =
      channels[at('C3..')].data[i] - around.reduce((sum, data) => sum + data[i], 0) / 4;
    assert.ok(Math.abs(value - expected) < 1e-4);
  });
});

test('leaves an electrode with no known place or too few neighbours as it was', () => {
  const channels = [
    channel('C3', [1, 2, 3]),
    channel('Cz', [2, 3, 4]),
    channel('C4', [3, 4, 5]),
    channel('Channel 7', [5, 6, 7]),
  ];
  const { channels: mixed, kept } = finish(applyMontage(channels, 'laplacian'));
  assert.equal(mixed[0], channels[0]);
  assert.equal(mixed[3], channels[3]);
  assert.deepEqual(Array.from(mixed[1].data), [0, 0, 0]);
  assert.equal(kept, 3);
});

test('pauses within a long channel, so the page can draw', () => {
  const long = Array.from({ length: 200000 }, (_, i) => Math.sin(i));
  const channels = ['Cz', 'C3', 'C4'].map((label, index) =>
    channel(
      label,
      long.map((value) => value * (index + 1)),
    ),
  );
  assert.ok(finish(applyMontage(channels, 'average')).pauses > 6);
  assert.ok(finish(applyMontage(channels, 'laplacian')).pauses >= 3);
});
