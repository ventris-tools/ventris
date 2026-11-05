// Turns a recording into the rows of the right-hand menu. The Info section follows
// the groups of MNE's summary of a recording: general, acquisition, channels, filters.

import { channelType } from './dsp.js';
import { formatClock } from './traces.js';

const UNKNOWN = 'Unknown';
const HANDS = { 1: 'Right', 2: 'Left', 3: 'Ambidextrous' };

export const unitLabel = (unit) => unit.replace(/^u(?=V$)/, 'µ');

const hertz = (value) => `${Math.round(value * 100) / 100} Hz`;

// A row that only appears when the file has the value.
const optional = (label, value, suffix = '') => (value === null ? [] : [[label, `${value}${suffix}`]]);

function amount(value, unit) {
  const digits = { minimumFractionDigits: 1, maximumFractionDigits: 1 };
  const number = value.toLocaleString('en-US', digits).replace('-', '−');
  return `${number} ${unitLabel(unit)}`.trim();
}

export function infoGroups({ channels, duration, format, info }) {
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
      ['Sample rate', lowest === highest ? hertz(highest) : `${lowest} to ${hertz(highest)}`],
      ['Time points', Math.round(duration * highest).toLocaleString('en-US')],
      ['Format', format],
    ],
    channels: [
      ...[...counts].map(([type, count]) => [type, String(count)]),
      ...optional(units.length > 1 ? 'Units' : 'Unit', units.join(', ') || null),
    ],
    filters: [
      ['Highpass', hertz(info.highpass)],
      ['Lowpass', hertz(info.lowpass)],
      ...optional('Notch', info.notch === null ? null : hertz(info.notch)),
    ],
  };
}

export function timeRows({ unit, mean, deviation, minimum, maximum, quietest, loudest, flat }) {
  const channel = (found) => found && `${found.label} ${amount(found.deviation, unit)}`;
  return [
    ['Mean', amount(mean, unit)],
    ['Minimum', amount(minimum, unit)],
    ['Maximum', amount(maximum, unit)],
    ['Peak to peak', amount(maximum - minimum, unit)],
    ['Std deviation', amount(deviation, unit)],
    ...optional('Lowest SD', channel(quietest)),
    ...optional('Highest SD', channel(loudest)),
    ['Flat channels', String(flat)],
  ];
}
