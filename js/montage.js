// Montages for display: a common average reference, and a surface Laplacian that takes each
// electrode's nearest neighbours away from it. Like the display filter, they change only what's
// drawn. Both work on EEG channels alone, sampled together, so a channel from a belt or a
// muscle never leaks into the brain channels.
//
// Positions come from the names of the 10-10 system, placed on a sphere: each row of electrodes
// runs in equal steps from the midline to the ring 10% above the nasion, ears and inion, as the
// system defines it. They're good enough to find neighbours, which is all they're used for.

import { channelType } from './channels.js';

export const MONTAGES = ['average', 'laplacian'];

// How each montage marks the rows it changes, after the channel's own name.
export const MARKS = { average: 'avg', laplacian: 'lap' };

// A Laplacian takes the nearest four, as Hjorth's did, but none further than this many times
// the nearest, so an electrode at the edge isn't pulled towards one across the head. The
// positions are least exact at the front and back, where AF3 lands nearer Fp1 than Fpz does,
// so the reach leaves room for that.
const NEIGHBOURS = 4;
const REACH = 1.8;

// Fewer neighbours than this would make a bipolar pair rather than a Laplacian.
const FEWEST = 2;

// How many samples a pass works through between pauses, as the filter does.
const CHUNK = 65536;

// The 10-20 names that the 10-10 system replaced.
const OLD_NAMES = { T3: 'T7', T4: 'T8', T5: 'P7', T6: 'P8' };

// A scalp electrode, with the row as letters and its place along the row: Z on the midline, odd
// numbers to the left, even to the right.
const SITE = /^(FP|AF|FC|FT|F|CP|C|TP|T|PO|P|O|I)(Z|\d{1,2})$/;

// Ears, mastoids and reference names, which a label can give as what a channel is measured
// against.
const REFERENCE = /^(?:A[12]|M[12]|REF|REFERENCE|LE|RE|AVG|AR|CAR|LINKED)$/;

// Each row's midline point, in degrees from Cz, and which way it lies.
const ROWS = {
  FP: { polar: 72, back: false },
  AF: { polar: 54, back: false },
  F: { polar: 36, back: false },
  FC: { polar: 18, back: false },
  C: { polar: 0, back: false },
  CP: { polar: 18, back: true },
  P: { polar: 36, back: true },
  PO: { polar: 54, back: true },
  O: { polar: 72, back: true },
  I: { polar: 90, back: true },
};

// Where a row meets the ring, in degrees round from the front towards the left ear. The fourth
// electrode out, such as F7 or T7, sits there.
const RING = { AF: 36, F: 54, FC: 72, C: 90, CP: 108, P: 126, PO: 144 };

// The rows that run along the ring itself, or below it, 18 degrees apart.
const ALONG = { FP: 0, O: 180, I: 180 };

const ROW_OF = { FT: 'FC', TP: 'CP', T: 'C' };

const DEGREE = Math.PI / 180;

const point = (polar, azimuth) => [
  Math.sin(polar * DEGREE) * Math.cos(azimuth * DEGREE),
  Math.sin(polar * DEGREE) * Math.sin(azimuth * DEGREE),
  Math.cos(polar * DEGREE),
];

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

const angle = (a, b) => Math.acos(Math.min(1, Math.max(-1, dot(a, b))));

// The point a share t of the way from a to b along the great circle through them.
function along(a, b, t) {
  const total = angle(a, b);
  const from = Math.sin((1 - t) * total) / Math.sin(total);
  const to = Math.sin(t * total) / Math.sin(total);
  return a.map((value, axis) => from * value + to * b[axis]);
}

// The scalp electrode a label names, such as C3 for "EEG C3-A2" or "C3..", or null when it
// names none, names a reference site itself, or names two, as a bipolar pair like "Fp1-F7"
// does. reference says whether the label is a reference site or a bipolar pair, which no
// montage may mix in.
export function electrodeOf(label) {
  const words = label
    .trim()
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter((word) => word && word !== 'EEG')
    .map((word) => OLD_NAMES[word] ?? word);
  const sites = words.filter((word) => SITE.test(word));
  const referenceOnly = words.length > 0 && words.every((word) => REFERENCE.test(word));
  if (sites.length > 1 || referenceOnly) return { site: null, mixed: true };
  return { site: sites[0] ?? null, mixed: false };
}

// Where an electrode sits on a unit sphere, with Cz on top, the nose towards x and the left ear
// towards y, or null for a name off the 10-10 system.
export function positionOf(site) {
  const [, letters, place] = SITE.exec(site) ?? [];
  const row = ROW_OF[letters] ?? letters;
  if (!row) return null;
  const number = place === 'Z' ? 0 : Number(place);
  const steps = Math.ceil(number / 2);
  const side = number % 2 === 1 ? 1 : -1;
  const { polar, back } = ROWS[row];
  if (row in ALONG) {
    const azimuth = ALONG[row] + (back ? -1 : 1) * side * 18 * steps;
    return point(polar, azimuth);
  }
  const middle = point(polar, back ? 180 : 0);
  if (steps === 0) return middle;
  const [x, y, z] = along(middle, point(72, RING[row]), steps / 4);
  return [x, side * y, z];
}

// Each position's neighbours, as indices, or null for a position with too few of them or
// none at all.
export function neighboursOf(positions) {
  return positions.map((here, index) => {
    if (!here) return null;
    const near = positions
      .map((there, other) => ({
        other,
        distance: there && other !== index ? angle(here, there) : Infinity,
      }))
      .filter(({ distance }) => Number.isFinite(distance))
      .sort((a, b) => a.distance - b.distance);
    const reach = (near[0]?.distance ?? 0) * REACH;
    const chosen = near.slice(0, NEIGHBOURS).filter(({ distance }) => distance <= reach);
    return chosen.length >= FEWEST ? chosen.map(({ other }) => other) : null;
  });
}

function isFlat(data) {
  for (let i = 1; i < data.length; i += 1) if (data[i] !== data[0]) return false;
  return true;
}

// The EEG channels a montage can mix: not a bipolar pair or reference site, not flat, and at
// the sample rate and length most EEG channels share, so that their samples line up.
function mixable(channels) {
  const eeg = channels.map(({ label, data }) => {
    if (channelType(label) !== 'EEG' || data.length === 0) return false;
    return !electrodeOf(label).mixed && !isFlat(data);
  });
  const rates = new Map();
  channels.forEach(({ fs, data }, index) => {
    if (!eeg[index]) return;
    const key = `${fs} ${data.length}`;
    rates.set(key, (rates.get(key) ?? 0) + 1);
  });
  const [common] = [...rates.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
  return channels.map(({ fs, data }, index) => eeg[index] && `${fs} ${data.length}` === common);
}

// A copy of target less the mean of sources, sample by sample, pausing every CHUNK samples.
// Each sample's sources are added before dividing, which rounds least.
function* lessMean(target, sources) {
  const out = new Float32Array(target.length);
  const count = sources.length;
  for (let from = 0; from < out.length; from += CHUNK) {
    const to = Math.min(out.length, from + CHUNK);
    for (let i = from; i < to; i += 1) {
      let total = 0;
      for (let k = 0; k < count; k += 1) total += sources[k][i];
      out[i] = target[i] - total / count;
    }
    yield;
  }
  return out;
}

// The mean of the sources, sample by sample, in double precision: summed a source at a time,
// to read each one in order, then divided.
function* meanOf(sources) {
  const mean = new Float64Array(sources[0].length);
  for (const source of sources) {
    for (let from = 0; from < mean.length; from += CHUNK) {
      const to = Math.min(mean.length, from + CHUNK);
      for (let i = from; i < to; i += 1) mean[i] += source[i];
      yield;
    }
  }
  for (let i = 0; i < mean.length; i += 1) mean[i] /= sources.length;
  return mean;
}

// Applies a montage to the channels. Returns { channels, kept }, where kept counts the EEG
// channels it left as they were, because they can't be mixed or, for a Laplacian, have no
// known place or too few neighbours. Changed channels carry the montage's mark.
export function* applyMontage(channels, montage) {
  const usable = mixable(channels);
  const eeg = channels.filter(({ label }) => channelType(label) === 'EEG').length;
  const out = [...channels];
  let changed = 0;

  if (montage === 'average') {
    const members = channels.filter((_, index) => usable[index]).map(({ data }) => data);
    if (members.length >= FEWEST) {
      const mean = yield* meanOf(members);
      for (const [index, channel] of channels.entries()) {
        if (!usable[index]) continue;
        const data = yield* lessMean(channel.data, [mean]);
        out[index] = { ...channel, data, mark: MARKS.average };
        changed += 1;
      }
    }
  } else {
    const positions = channels.map(({ label }, index) => {
      const { site } = electrodeOf(label);
      return usable[index] && site ? positionOf(site) : null;
    });
    const neighbours = neighboursOf(positions);
    for (const [index, channel] of channels.entries()) {
      const near = neighbours[index];
      if (!near) continue;
      const data = yield* lessMean(
        channel.data,
        near.map((other) => channels[other].data),
      );
      out[index] = { ...channel, data, mark: MARKS.laplacian };
      changed += 1;
    }
  }
  return { channels: out, kept: eeg - changed };
}
