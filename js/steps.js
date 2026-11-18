// The steps the display can take a recording through, in the order they run, and the history
// of their settings, so that a change can be undone. A step works on what the steps before it
// made, so any change recomputes from the recording itself. Undoing a change restores
// settings, never a kept copy of the samples.
//
// The filter runs first and the montage after it, on the filtered samples. Settings are one
// flat object, so a later step adds keys of its own and the history needs no change.

import { filterRecording, MAX_FILTER_SAMPLES } from './filters.js';
import { applyMontage } from './montage.js';

const hertz = (values) => values.map((value) => ({ value, text: `${value} Hz` }));

// The choices each setting offers. Every high-pass sits below every low-pass, so no pair of
// choices leaves nothing to pass.
export const STEPS = [
  { key: 'highpass', label: 'High-pass', choices: hertz([0.1, 0.5, 1, 2]) },
  { key: 'lowpass', label: 'Low-pass', choices: hertz([15, 30, 40, 70]) },
  { key: 'notch', label: 'Notch', choices: hertz([50, 60]) },
  {
    key: 'montage',
    label: 'Montage',
    choices: [
      { value: 'average', text: 'Average' },
      { value: 'laplacian', text: 'Laplacian' },
    ],
  },
];

export const NO_FILTERS = Object.freeze({
  highpass: null,
  lowpass: null,
  notch: null,
  montage: null,
});

const MONTAGE_NAMES = { average: 'average reference', laplacian: 'Laplacian' };

// Enough to back out of any experiment, without keeping a session's every click.
const HISTORY_LENGTH = 100;

export const isOff = (settings) => STEPS.every(({ key }) => settings[key] === null);

const same = (a, b) => STEPS.every(({ key }) => a[key] === b[key]);

export const startHistory = (settings = NO_FILTERS) => ({
  past: [],
  present: settings,
  future: [],
});

// The history with settings as the latest change, or the same history if nothing changed.
export function record(history, settings) {
  if (same(history.present, settings)) return history;
  return {
    past: [...history.past, history.present].slice(-HISTORY_LENGTH),
    present: settings,
    future: [],
  };
}

// The history a step back or forward, or the same history when there's nowhere to go.
export function undo(history) {
  const { past, present, future } = history;
  if (past.length === 0) return history;
  return { past: past.slice(0, -1), present: past.at(-1), future: [present, ...future] };
}

export function redo(history) {
  const { past, present, future } = history;
  if (future.length === 0) return history;
  return { past: [...past, present], present: future[0], future: future.slice(1) };
}

// The steps in a few words: the filter, such as "0.5 to 70 Hz · 50 Hz notch", and the
// montage, such as "Laplacian", each '' when off.
export function describe({ highpass, lowpass, notch, montage }) {
  const parts = [];
  if (highpass !== null && lowpass !== null) parts.push(`${highpass} to ${lowpass} Hz`);
  else if (highpass !== null) parts.push(`${highpass} Hz high-pass`);
  else if (lowpass !== null) parts.push(`${lowpass} Hz low-pass`);
  if (notch !== null) parts.push(`${notch} Hz notch`);
  return { filter: parts.join(' · '), montage: MONTAGE_NAMES[montage] ?? '' };
}

// Takes the channels through every step that's on, pausing as each step does. Returns
// { channels, untouched, kept, reason }: untouched counts the sensor channels the filter left
// alone, and kept the EEG channels the montage left alone. channels is null when the
// recording is too long to process here, with reason 'large', or memory ran out, with reason
// 'memory'.
export function* runSteps(channels, settings, { maxSamples = MAX_FILTER_SAMPLES } = {}) {
  let current = channels;
  let untouched = 0;
  if (describe(settings).filter) {
    const filtered = yield* filterRecording(current, settings, { maxSamples });
    if (!filtered.channels) return { ...filtered, kept: 0 };
    current = filtered.channels;
    untouched = filtered.untouched;
  }
  if (settings.montage === null) return { channels: current, untouched, kept: 0, reason: null };

  const samples = current.reduce((sum, { data }) => sum + data.length, 0);
  if (samples > maxSamples) return { channels: null, untouched, kept: 0, reason: 'large' };
  try {
    const { channels: mixed, kept } = yield* applyMontage(current, settings.montage);
    return { channels: mixed, untouched, kept, reason: null };
  } catch (error) {
    if (error instanceof RangeError)
      return { channels: null, untouched, kept: 0, reason: 'memory' };
    throw error;
  }
}
