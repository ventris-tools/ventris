// The steps the display can take a recording through, in the order they run, and the history
// of their settings, so that a change can be undone. A step works on what the steps before it
// made, so any change recomputes from the recording itself. Undoing a change restores
// settings, never a kept copy of the samples.
//
// The display filter is the only step so far. Settings are one flat object, so a later step
// adds keys of its own and the history needs no change.

// The choices each setting offers, in hertz. Every high-pass sits below every low-pass, so no
// pair of choices leaves nothing to pass.
export const STEPS = [
  { key: 'highpass', label: 'High-pass', choices: [0.1, 0.5, 1, 2] },
  { key: 'lowpass', label: 'Low-pass', choices: [15, 30, 40, 70] },
  { key: 'notch', label: 'Notch', choices: [50, 60] },
];

export const NO_FILTERS = Object.freeze({ highpass: null, lowpass: null, notch: null });

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

// The filter in a few words, such as "0.5 to 70 Hz · 50 Hz notch", or '' for none.
export function describe({ highpass, lowpass, notch }) {
  const parts = [];
  if (highpass !== null && lowpass !== null) parts.push(`${highpass} to ${lowpass} Hz`);
  else if (highpass !== null) parts.push(`${highpass} Hz high-pass`);
  else if (lowpass !== null) parts.push(`${lowpass} Hz low-pass`);
  if (notch !== null) parts.push(`${notch} Hz notch`);
  return parts.join(' · ');
}
