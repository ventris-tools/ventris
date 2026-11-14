import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCsv } from '../js/csv.js';
import { demoRecording } from '../js/demo.js';
import { parseEdf } from '../js/edf.js';
import { NO_INFO, NO_SUBJECT } from '../js/recording.js';
import { lslCsv } from './support/csv.js';
import { buildEdf } from './support/edf.js';

const KEYS = ['annotations', 'channels', 'duration', 'format', 'info', 'warnings'];

// Details that only some readers give, each named in js/recording.js.
const EXTRA_INFO = ['firstTime'];

const tal = (record) => `+${record}\x14\x14\0+${record}.5\x14Spike\x14\0`;
const readers = {
  EDF: () =>
    parseEdf(
      buildEdf(
        [
          { label: 'Cz', samples: 256 },
          { label: 'EDF Annotations', samples: 32, tal },
        ],
        {
          records: 4,
          reserved: 'EDF+C',
          subject: 'P1 M 02-MAY-1951 Jo_Bloggs',
        },
      ),
    ),
  CSV: () => parseCsv(lslCsv()),
  demo: demoRecording,
};

for (const [name, read] of Object.entries(readers)) {
  test(`the ${name} reader returns a recording of the shared shape`, () => {
    const recording = read();
    assert.deepEqual(Object.keys(recording).sort(), KEYS);
    assert.equal(typeof recording.format, 'string');
    assert.ok(recording.duration > 0);
    assert.ok(recording.warnings.every((warning) => typeof warning === 'string'));

    assert.ok(recording.channels.length > 0);
    for (const channel of recording.channels) {
      assert.deepEqual(Object.keys(channel).sort(), ['data', 'fs', 'label', 'unit']);
      assert.ok(channel.data instanceof Float32Array);
      assert.ok(channel.fs > 0);
      assert.equal(typeof channel.label, 'string');
      assert.equal(typeof channel.unit, 'string');
    }

    assert.ok(recording.annotations.length > 0);
    recording.annotations.forEach((annotation, index) => {
      assert.deepEqual(Object.keys(annotation).sort(), ['duration', 'text', 'time']);
      if (index > 0) assert.ok(annotation.time >= recording.annotations[index - 1].time);
    });

    const { info } = recording;
    for (const key of Object.keys(NO_INFO)) assert.ok(key in info, `info.${key}`);
    for (const key of Object.keys(info)) {
      assert.ok(key in NO_INFO || EXTRA_INFO.includes(key), `info.${key} isn't in the shape`);
    }
    assert.deepEqual(Object.keys(info.subject).sort(), Object.keys(NO_SUBJECT).sort());
  });
}

test('the shared empty details cannot be changed by one recording for the next', () => {
  assert.ok(Object.isFrozen(NO_INFO));
  assert.ok(Object.isFrozen(NO_SUBJECT));
});
