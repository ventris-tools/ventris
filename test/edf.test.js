import assert from 'node:assert/strict';
import test from 'node:test';
import { EdfError, parseEdf } from '../js/edf.js';
import { buildEdf } from './support/edf.js';

test('scales digital values to physical units', () => {
  const buffer = buildEdf([{ label: 'Cz', samples: 2, value: (r, i) => (i === 0 ? 1000 : -500) }]);
  const recording = parseEdf(buffer);
  assert.equal(recording.format, 'EDF');
  assert.equal(recording.duration, 2);
  assert.equal(recording.channels[0].label, 'Cz');
  assert.equal(recording.channels[0].fs, 2);
  assert.deepEqual([...recording.channels[0].data], [100, -50, 100, -50]);
});

test('keeps channels apart when sample rates differ', () => {
  const recording = parseEdf(
    buildEdf([
      { label: 'Fast', samples: 4, value: () => 100 },
      { label: 'Slow', samples: 1, value: () => 200 },
    ]),
  );
  assert.deepEqual(
    recording.channels.map((c) => c.fs),
    [4, 1],
  );
  assert.equal(recording.channels[0].data.length, 8);
  assert.equal(recording.channels[1].data.length, 2);
  assert.ok(recording.channels[0].data.every((v) => Math.abs(v - 10) < 1e-4));
  assert.ok(recording.channels[1].data.every((v) => Math.abs(v - 20) < 1e-4));
});

test('skips the EDF+ annotation channel and reads the signal after it', () => {
  const recording = parseEdf(
    buildEdf(
      [
        { label: 'EDF Annotations', samples: 3, value: () => 0x2b2b },
        { label: 'O1', samples: 2, value: () => 500 },
      ],
      { reserved: 'EDF+C' },
    ),
  );
  assert.equal(recording.format, 'EDF+');
  assert.deepEqual(
    recording.channels.map((c) => c.label),
    ['O1'],
  );
  assert.ok(recording.channels[0].data.every((v) => Math.abs(v - 50) < 1e-4));
});

test('warns about gaps and about files that are cut off', () => {
  const gaps = parseEdf(buildEdf([{ label: 'Cz', samples: 2 }], { reserved: 'EDF+D' }));
  assert.match(gaps.warnings[0], /gaps/);
  const cut = parseEdf(buildEdf([{ label: 'Cz', samples: 2 }], { records: 2, declared: 5 }));
  assert.equal(cut.duration, 2);
  assert.match(cut.warnings[0], /cut off/);
});

test('works out the length when the header says it is unknown', () => {
  const recording = parseEdf(buildEdf([{ label: 'Cz', samples: 2 }], { records: 3, declared: -1 }));
  assert.equal(recording.duration, 3);
});

const cz = [{ label: 'Cz', samples: 2 }];

test('reads the EDF+ participant fields', () => {
  const { info } = parseEdf(
    buildEdf(cz, {
      subject: 'MCH-0234567 F 02-MAY-1951 Haagse_Harry hand=1 height=1.75 weight=70',
    }),
  );
  assert.deepEqual(info.subject, {
    id: 'MCH-0234567',
    name: 'Haagse Harry',
    sex: 'Female',
    birthday: '1951-05-02',
    hand: 1,
    height: 1.75,
    weight: 70,
  });
});

test('treats X as unknown', () => {
  const { info } = parseEdf(buildEdf(cz));
  assert.ok(Object.values(info.subject).every((value) => value === null));
  assert.equal(info.experimenter, null);
  assert.equal(info.device, null);
  assert.equal(info.project, null);
});

test('keeps free text in a plain EDF participant field whole', () => {
  const { info } = parseEdf(buildEdf(cz, { subject: 'Subject 12 at home visit' }));
  assert.equal(info.subject.id, 'Subject 12 at home visit');
  assert.equal(info.subject.sex, null);
});

test('keeps free text that only looks like the EDF+ form whole', () => {
  const { info } = parseEdf(buildEdf(cz, { subject: 'John M Smith Jr' }));
  assert.equal(info.subject.id, 'John M Smith Jr');
  assert.equal(info.subject.sex, null);
  assert.equal(info.subject.name, null);
});

test('reads the EDF+ form when the birth date is unknown', () => {
  const { info } = parseEdf(buildEdf(cz, { subject: 'P7 F X Ann_Lee' }));
  assert.equal(info.subject.id, 'P7');
  assert.equal(info.subject.sex, 'Female');
  assert.equal(info.subject.name, 'Ann Lee');
});

test('reads the EDF+ recording field', () => {
  const { info } = parseEdf(
    buildEdf(cz, { recording: 'Startdate 02-MAR-2002 PSG-1234/2002 NN Telemetry03' }),
  );
  assert.equal(info.project, 'PSG-1234/2002');
  assert.equal(info.experimenter, 'NN');
  assert.equal(info.device, 'Telemetry03');
});

test('prefers the four-digit year in the recording field', () => {
  const { info } = parseEdf(
    buildEdf(cz, {
      recording: 'Startdate 02-MAR-2090 X X X',
      date: '02.03.90',
      time: '14.30.15',
    }),
  );
  assert.equal(info.date, '2090-03-02');
  assert.equal(info.time, '14:30:15');
});

test('reads two-digit years from 1985 and rejects impossible dates', () => {
  const dateOf = (date) => parseEdf(buildEdf(cz, { date })).info.date;
  assert.equal(dateOf('31.12.84'), '2084-12-31');
  assert.equal(dateOf('01.01.85'), '1985-01-01');
  assert.equal(dateOf('31.02.10'), null);
  assert.equal(dateOf('yy.mm.dd'), null);
});

test('reads filters and falls back to Nyquist', () => {
  const filtersOf = (...prefilters) =>
    parseEdf(buildEdf(prefilters.map((prefilter) => ({ label: 'Cz', samples: 200, prefilter }))))
      .info;

  const set = filtersOf('HP:0.1Hz LP:75Hz N:50Hz');
  assert.deepEqual([set.highpass, set.lowpass, set.notch], [0.1, 75, 50]);

  const off = filtersOf('HP:0Hz LP:0Hz N:0Hz');
  assert.deepEqual([off.highpass, off.lowpass, off.notch], [0, 100, null]);

  const missing = filtersOf('');
  assert.deepEqual([missing.highpass, missing.lowpass, missing.notch], [0, 100, null]);

  const direct = filtersOf('HP: DC LP: 70,5 Hz');
  assert.deepEqual([direct.highpass, direct.lowpass], [0, 70.5]);
});

test('keeps the strictest filter when channels differ', () => {
  const { info } = parseEdf(
    buildEdf([
      { label: 'C3', samples: 200, prefilter: 'HP:0.5Hz LP:70Hz' },
      { label: 'C4', samples: 200, prefilter: 'HP:1Hz LP:100Hz' },
    ]),
  );
  assert.deepEqual([info.highpass, info.lowpass], [1, 70]);
});

test('ignores a highpass above the lowpass', () => {
  const { info } = parseEdf(
    buildEdf([{ label: 'Cz', samples: 200, prefilter: 'HP:90Hz LP:40Hz' }]),
  );
  assert.deepEqual([info.highpass, info.lowpass], [0, 100]);
});

test('takes filters only from signal channels', () => {
  const { info } = parseEdf(
    buildEdf(
      [
        { label: 'EDF Annotations', samples: 2, value: () => 0, prefilter: 'HP:9Hz LP:10Hz' },
        { label: 'Cz', samples: 200, prefilter: 'HP:0.5Hz LP:70Hz' },
      ],
      { reserved: 'EDF+C' },
    ),
  );
  assert.deepEqual([info.highpass, info.lowpass], [0.5, 70]);
});

test('rejects files that are not EDF', () => {
  assert.throws(() => parseEdf(new ArrayBuffer(10)), EdfError);
  assert.throws(() => parseEdf(new TextEncoder().encode('x'.repeat(600)).buffer), EdfError);
  const bdf = new Uint8Array(600);
  bdf[0] = 0xff;
  assert.throws(() => parseEdf(bdf.buffer), /BDF/);
});

test('rejects a damaged header', () => {
  const buffer = buildEdf([{ label: 'Cz', samples: 2 }]);
  new Uint8Array(buffer).set(new TextEncoder().encode('abcd    '), 184);
  assert.throws(() => parseEdf(buffer), /damaged/);
});

test('reads fields padded with NUL rather than spaces', () => {
  const recording = parseEdf(buildEdf([{ label: 'Cz', samples: 2 }], { fill: '\0' }));
  assert.equal(recording.duration, 2);
  assert.equal(recording.channels[0].data.length, 4);
});

test('rejects sample rates and lengths no recording could have', () => {
  const cut = (options) => () => parseEdf(buildEdf(cz, options));
  assert.throws(cut({ seconds: '1e-320' }), /damaged/);
  assert.throws(cut({ seconds: '1e-9' }), /damaged/);
  assert.throws(cut({ seconds: '1e300' }), /damaged/);
  assert.throws(cut({ declared: '1.5' }), /damaged/);
});

const annotations = (texts) => ({
  label: 'EDF Annotations',
  samples: 32,
  tal: (record) => texts[record],
});

test('reads EDF+ annotations with their times and durations', () => {
  const { annotations: found } = parseEdf(
    buildEdf(
      [
        { label: 'Cz', samples: 2 },
        annotations([
          '+0\x14\x14\0+0.5\x14Eyes closed\x14\0',
          '+1\x14\x14\0+1.5\x152\x14T1\x14T2\x14\0',
        ]),
      ],
      { reserved: 'EDF+C' },
    ),
  );
  assert.deepEqual(found, [
    { time: 0.5, duration: 0, text: 'Eyes closed' },
    { time: 1.5, duration: 2, text: 'T1' },
    { time: 1.5, duration: 2, text: 'T2' },
  ]);
});

test('times annotations from the data as shown when the recording has gaps', () => {
  const { annotations: found } = parseEdf(
    buildEdf(
      [
        { label: 'Cz', samples: 2 },
        annotations(['+10\x14\x14\0', '+100\x14\x14\0+100.25\x14Spike\x14\0']),
      ],
      { reserved: 'EDF+D' },
    ),
  );
  assert.deepEqual(found, [{ time: 1.25, duration: 0, text: 'Spike' }]);
});

test('reads annotations as UTF-8', () => {
  const { annotations: found } = parseEdf(
    buildEdf([{ label: 'Cz', samples: 2 }, annotations(['+0\x14\x14\0+0\x14µ-Welle\x14\0', ''])]),
  );
  assert.equal(found[0].text, 'µ-Welle');
});

test('a plain EDF file has no annotations', () => {
  assert.deepEqual(parseEdf(buildEdf(cz)).annotations, []);
});
