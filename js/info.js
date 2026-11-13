// Turns a recording into the rows of the details panel. The Info section follows the
// groups of MNE's summary of a recording: general, acquisition, channels, filters.

import { channelType } from './channels.js';
import { amount, decimalsFor, formatClock, unitLabel } from './format.js';

const UNKNOWN = 'Unknown';
const HANDS = { 1: 'Right', 2: 'Left', 3: 'Ambidextrous' };

const rate = (value) => Math.round(value * 100) / 100;

const hertz = (value) => `${rate(value)} Hz`;

// A CSV says nothing about filtering, where an EDF header with none means none.
const cutoff = (value) => (value === null ? UNKNOWN : hertz(value));

// A row that only appears when the file has the value.
const optional = (label, value, suffix = '') =>
  value === null ? [] : [[label, `${value}${suffix}`]];

export function infoGroups({ channels, duration, format, info, annotations }) {
  const { subject } = info;
  const rates = channels.map(({ fs }) => fs);
  const lowest = Math.min(...rates);
  const highest = Math.max(...rates);

  const counts = new Map();
  for (const { label } of channels) {
    const type = channelType(label);
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  const units = [...new Set(channels.map(({ unit }) => unitLabel(unit)).filter(Boolean))];

  return {
    general: [
      ['Start date', info.date ?? UNKNOWN],
      ['Start time', info.time ?? UNKNOWN],
      ['Participant', subject.id ?? UNKNOWN],
      ...optional('Name', subject.name),
      ...optional('Sex', subject.sex),
      ...optional('Birth date', subject.birthday),
      ...optional('Hand', HANDS[subject.hand] ?? null),
      ...optional('Height', subject.height, ' m'),
      ...optional('Weight', subject.weight, ' kg'),
      ['Experimenter', info.experimenter ?? UNKNOWN],
      ...optional('Device', info.device),
      ...optional('Project', info.project),
    ],
    acquisition: [
      ['Duration', formatClock(duration)],
      ['Sample rate', lowest === highest ? hertz(highest) : `${rate(lowest)} to ${hertz(highest)}`],
      ['Time points', Math.round(duration * highest).toLocaleString('en-US')],
      ['Format', format],
      // The clock of a Lab Streaming Layer recording, which lines up files from one session.
      ...optional('First timestamp', info.firstTime?.toFixed(3) ?? null, ' s'),
      ...optional('Annotations', annotations.length || null),
    ],
    channels: [
      ...[...counts].map(([type, count]) => [type, String(count)]),
      ...optional(units.length > 1 ? 'Units' : 'Unit', units.join(', ') || null),
    ],
    filters: [
      ['Highpass', cutoff(info.highpass)],
      ['Lowpass', cutoff(info.lowpass)],
      ...optional('Notch', info.notch === null ? null : hertz(info.notch)),
    ],
  };
}

export function timeRows({ unit, mean, deviation, minimum, maximum, quietest, loudest, flat }) {
  const decimals = decimalsFor(maximum - minimum);
  const measure = (value) => amount(value, unit, decimals);
  const channel = (found) => found && `${found.label} ${measure(found.deviation)}`;
  return [
    ['Mean', measure(mean)],
    ['Minimum', measure(minimum)],
    ['Maximum', measure(maximum)],
    ['Peak to peak', measure(maximum - minimum)],
    ['Overall SD', measure(deviation)],
    ...optional('Lowest SD', channel(quietest)),
    ...optional('Highest SD', channel(loudest)),
    ['Flat channels', String(flat)],
  ];
}
