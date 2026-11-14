// Opens a recording in a worker, so that reading a large file leaves the page free to answer.
// The page sends { buffer, reader }: the file's bytes, moved rather than copied, and 'edf' or
// 'csv'. Back comes { recording, spreads, baselines }, with each channel's samples moved back
// the same way, or { error: { kind, message } }, where kind is 'edf' or 'csv' when the message
// is a reader's own words about the file, and 'other' when something else went wrong.
//
// The page's Content Security Policy comes from a meta tag, which a worker doesn't inherit,
// so nothing here or in what it imports may use the network. ESLint checks that.

import { CsvError, parseCsv } from './csv.js';
import { EdfError, parseEdf } from './edf.js';
import { baseline, robustSpread } from './traces.js';

const READERS = { edf: parseEdf, csv: parseCsv };

function kindOf(error) {
  if (error instanceof EdfError) return 'edf';
  if (error instanceof CsvError) return 'csv';
  return 'other';
}

// The reply to a file, and the buffers in it to move rather than copy. A buffer can be moved
// only once, so each is listed once, however many arrays it holds.
export function openRecording({ buffer, reader }) {
  try {
    const recording = READERS[reader](buffer);
    const spreads = recording.channels.map(({ data }) => robustSpread(data));
    const baselines = recording.channels.map(({ data, fs }) => baseline(data, fs));
    const moved = new Set([
      ...recording.channels.map(({ data }) => data.buffer),
      ...baselines.map(({ levels }) => levels.buffer),
    ]);
    return { reply: { recording, spreads, baselines }, transfer: [...moved] };
  } catch (error) {
    return { reply: { error: { kind: kindOf(error), message: error.message } }, transfer: [] };
  }
}

// Answers each file sent to scope, the worker's global scope, or a stand-in for it in tests.
export function answer(scope) {
  scope.addEventListener('message', ({ data }) => {
    const { reply, transfer } = openRecording(data);
    scope.postMessage(reply, transfer);
  });
}

// Imported anywhere but a worker, as it is in the tests, this module only exports.
if (typeof WorkerGlobalScope !== 'undefined') answer(self);
