import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AFTER,
  bandSections,
  BEFORE,
  chartScale,
  eventKinds,
  eventPower,
  findChannels,
  POWER_BANDS,
} from '../js/erd.js';
import { filtfilt } from '../js/filters.js';

const FS = 160;
const BAND = POWER_BANDS[0];

// Runs a generator to the end, and counts how often it paused.
function finish(steps) {
  let pauses = 0;
  let step = steps.next();
  while (!step.done) {
    pauses += 1;
    step = steps.next();
  }
  return { ...step.value, pauses };
}

// A 10 Hz rhythm that falls to half its height, 6 dB down, from 0.5 to 3.5 s after each of
// the onsets, and to scale times its height during the stretches in louder.
function rhythm(seconds, onsets, { louder = [], scale = 2 } = {}) {
  const inside = (time, [from, to]) => time >= from && time < to;
  return Float32Array.from({ length: seconds * FS }, (_, i) => {
    const time = i / FS;
    let height = onsets.some((onset) => inside(time, [onset + 0.5, onset + 3.5])) ? 0.5 : 1;
    if (louder.some((span) => inside(time, span))) height *= scale;
    return 100 * height * Math.sin((2 * Math.PI * 10 * i) / FS);
  });
}

const kindAt = (key, times, duration = 0) => ({
  key,
  events: times.map((time) => ({ time, duration })),
});

const valueAt = ({ times, curves }, index, time) =>
  curves[index].db[times.findIndex((value) => value >= time)];

// The magnitude of a cascade of sections at a frequency.
function response(sections, frequency, fs) {
  const w = (2 * Math.PI * frequency) / fs;
  let magnitude = 1;
  for (const [b0, b1, b2, , a1, a2] of sections) {
    const part = (c0, c1, c2) => {
      const re = c0 + c1 * Math.cos(w) + c2 * Math.cos(2 * w);
      const im = -c1 * Math.sin(w) - c2 * Math.sin(2 * w);
      return Math.hypot(re, im);
    };
    magnitude *= part(b0, b1, b2) / part(1, a1, a2);
  }
  return magnitude;
}

test('band-passes with fourth-order Butterworth filters at either edge', () => {
  // The bilinear transform's Butterworth response, in closed form.
  const warp = (frequency) => Math.tan((Math.PI * frequency) / FS);
  const expected = (frequency, low, high) => {
    const below = (warp(low) / warp(frequency)) ** 8;
    const above = (warp(frequency) / warp(high)) ** 8;
    return Math.sqrt(1 / (1 + below)) * Math.sqrt(1 / (1 + above));
  };
  for (const { low, high } of POWER_BANDS) {
    const sections = bandSections(low, high, FS);
    assert.equal(sections.length, 4);
    for (const frequency of [2, 5, low, 10, high, 40, 60]) {
      const got = response(sections, frequency, FS);
      const want = expected(frequency, low, high);
      assert.ok(Math.abs(got - want) < 1e-9, `${low}-${high} Hz at ${frequency} Hz: ${got}`);
    }
  }
});

test('offers 8 to 30 Hz first, then mu and beta', () => {
  assert.deepEqual(
    POWER_BANDS.map(({ low, high }) => [low, high]),
    [
      [8, 30],
      [8, 13],
      [13, 30],
    ],
  );
});

test('groups annotations into kinds by their text, in the order they first appear', () => {
  const kinds = eventKinds([
    { time: 1, duration: 4.2, text: 'T0' },
    { time: 2, duration: 4.1, text: ' t1 ' },
    { time: 3, duration: 0, text: 't0' },
    { time: 4, duration: 4.1, text: 'T1' },
  ]);
  assert.deepEqual(kinds, [
    {
      key: 't0',
      text: 'T0',
      events: [
        { time: 1, duration: 4.2 },
        { time: 3, duration: 0 },
      ],
    },
    {
      key: 't1',
      text: 't1',
      events: [
        { time: 2, duration: 4.1 },
        { time: 4, duration: 4.1 },
      ],
    },
  ]);
});

test('finds channels by label or by the electrode they name', () => {
  const channels = ['Fc5.', 'C3..', 'EEG C4-A1', 'T7..', 'EEG Fpz-Cz', 'C3-A2'].map((label) => ({
    label,
  }));
  assert.deepEqual(findChannels(channels, 'c3 C4'), { rows: [1, 2], unknown: [] });
  assert.deepEqual(findChannels(channels, ' C4  c4.. T3 '), { rows: [2, 3], unknown: [] });
  assert.deepEqual(findChannels(channels, 'C3-A2'), { rows: [5], unknown: [] });
  assert.deepEqual(findChannels(channels, 'EEG Fpz-Cz, Pz, FC5'), {
    rows: [4, 0],
    unknown: ['Pz'],
  });
  assert.deepEqual(findChannels(channels, 'EEG'), { rows: [], unknown: ['EEG'] });
  assert.deepEqual(findChannels(channels, ''), { rows: [], unknown: [] });
});

test('averages power around the events, in dB against the second before them', () => {
  const onsets = [3, 9, 15, 21];
  const result = finish(
    eventPower({ fs: FS, data: rhythm(30, onsets) }, [kindAt('go', onsets)], BAND),
  );
  const [curve] = result.curves;
  assert.equal(result.reason, null);
  assert.equal(curve.count, 4);
  assert.equal(result.pauses, 4);
  assert.equal(result.times[0], -BEFORE);
  assert.ok(result.times.at(-1) < AFTER && result.times.at(-1) > AFTER - 0.1);
  assert.equal(result.times.length, curve.db.length);
  // Half the height is a quarter of the power, 6 dB down, away from the smoothing's edges.
  for (const time of [1, 2, 3]) assert.ok(Math.abs(valueAt(result, 0, time) + 6.02) < 0.05);
  for (const time of [-0.5, 0, 4.2]) assert.ok(Math.abs(valueAt(result, 0, time)) < 0.05);
  // The smoothing ramps in over the first and last quarter second of 0.5 to 3.5 s.
  assert.ok(Math.abs(curve.during + 5.51) < 0.05, curve.during);
});

test('can measure against another kind of annotation instead, such as rest', () => {
  const onsets = [3, 15];
  const rests = [9, 21];
  // The rhythm is twice as tall during rest, 6 dB up, from each rest's onset to its end.
  const data = rhythm(30, onsets, { louder: rests.map((time) => [time, time + 4]) });
  const rest = kindAt('rest', rests, 4);
  const result = finish(eventPower({ fs: FS, data }, [kindAt('go', onsets)], BAND, rest));
  assert.equal(result.pauses, 4);
  assert.ok(Math.abs(valueAt(result, 0, -0.5) + 6.02) < 0.1);
  assert.ok(Math.abs(valueAt(result, 0, 2) + 12.04) < 0.1);
});

test('measures a rest annotation without a duration over the seconds after it', () => {
  const onsets = [3];
  const quiet = (time) => time >= 12 && time < 12 + AFTER;
  const data = rhythm(20, onsets).map((value, i) => (quiet(i / FS) ? value / 2 : value));
  const rest = kindAt('rest', [12]);
  const result = finish(eventPower({ fs: FS, data }, [kindAt('go', onsets)], BAND, rest));
  // Rest has half the height, 6 dB down, so the rhythm before the onset is 6 dB up. To the
  // end of the recording, rest would have been 2.4 dB down.
  assert.ok(Math.abs(valueAt(result, 0, -0.5) - 6.02) < 0.2);
});

test('counts only the events whose whole epoch lies in the recording', () => {
  const data = rhythm(20, [3]);
  const kinds = [kindAt('go', [0.5, 3, 17]), kindAt('late', [19])];
  const result = finish(eventPower({ fs: FS, data }, kinds, BAND));
  assert.deepEqual(
    result.curves.map(({ count }) => count),
    [1, 0],
  );
  assert.equal(result.curves[1].db, null);
  assert.equal(result.curves[1].during, null);
});

test('reaches the start of the recording, where the smoothing runs short', () => {
  const data = rhythm(10, [BEFORE]);
  const result = finish(eventPower({ fs: FS, data }, [kindAt('go', [BEFORE])], BAND));
  assert.equal(result.curves[0].count, 1);
  assert.ok(Math.abs(valueAt(result, 0, -0.9)) < 0.5);
});

test('matches filtering the whole recording, since each epoch is filtered with a second either side', () => {
  // Noise that doesn't repeat, so that only a settled filter gets the same answer.
  let seed = 1;
  const noise = Float32Array.from({ length: 40 * FS }, () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647 - 0.5;
  });
  const onsets = [5, 14, 23, 32];
  const result = finish(eventPower({ fs: FS, data: noise }, [kindAt('go', onsets)], BAND));
  const power = filtfilt(noise, bandSections(BAND.low, BAND.high, FS)).map((value) => value ** 2);
  const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;
  // Power smoothed over the 80 samples around each sample, half a second, averaged over the
  // events, offset samples from their onsets.
  const smoothed = (at) => mean(power.subarray(at - 40, at + 40));
  const average = (offset) => mean(onsets.map((onset) => smoothed(onset * FS + offset)));
  const span = (from, to) => mean(Array.from({ length: to - from }, (_, i) => average(from + i)));
  const expected = 10 * Math.log10(span(80, 560) / span(-160, 0));
  assert.ok(Math.abs(result.curves[0].during - expected) < 0.01, `${result.curves[0].during}`);
});

test('keeps a flat stretch on the chart, at the floor', () => {
  const data = rhythm(10, []).map((value, i) => (i >= 4 * FS ? 0 : value));
  const result = finish(eventPower({ fs: FS, data }, [kindAt('go', [3])], BAND));
  assert.equal(valueAt(result, 0, 2), -60);
});

test('says why it has no curves', () => {
  const kinds = [kindAt('go', [3])];
  const slow = finish(eventPower({ fs: 50, data: new Float32Array(500) }, kinds, BAND));
  assert.deepEqual(slow, { reason: 'slow', times: null, curves: null, pauses: 0 });
  // The beta band's top edge needs more than 66.7 Hz, and mu's less.
  const mu = finish(eventPower({ fs: 40, data: new Float32Array(400) }, kinds, POWER_BANDS[1]));
  assert.equal(mu.reason, 'flat');

  const data = rhythm(10, []);
  const beyond = kindAt('rest', [12, 20]);
  assert.equal(finish(eventPower({ fs: FS, data }, kinds, BAND, beyond)).reason, 'rest');
  const flat = new Float32Array(10 * FS);
  assert.equal(finish(eventPower({ fs: FS, data: flat }, kinds, BAND)).reason, 'flat');
  // A kind with no events in the recording isn't flat, just empty.
  const empty = finish(eventPower({ fs: FS, data: flat }, [kindAt('late', [9])], BAND));
  assert.equal(empty.reason, null);
});

test('scales charts to take in 0 and every curve, in whole steps', () => {
  const curve = (...db) => ({ db: Float64Array.from(db) });
  assert.deepEqual(chartScale([]), { low: -1, high: 1, ticks: [-1, 0, 1] });
  assert.deepEqual(chartScale([curve(-0.4, 0.2), { db: null }]), {
    low: -1,
    high: 1,
    ticks: [-1, 0, 1],
  });
  assert.deepEqual(chartScale([curve(-3.3, 0.6), curve(1.9)]), {
    low: -4,
    high: 2,
    ticks: [-4, -2, 0, 2],
  });
  assert.deepEqual(chartScale([curve(-60, 12)]).ticks, [-60, -40, -20, 0, 20]);
  assert.deepEqual(chartScale([curve(-60, 250)]).ticks, [-160, 0, 160, 320]);
});
