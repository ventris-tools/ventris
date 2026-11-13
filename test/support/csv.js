// Builds the bytes of a CSV file from a header and rows. Lines in before go above the header.
export function buildCsv(header, rows, { delimiter = ',', eol = '\n', before = [] } = {}) {
  const lines = [...before, header.join(delimiter), ...rows.map((row) => row.join(delimiter))];
  return new TextEncoder().encode(lines.join(eol) + eol).buffer;
}

export const ELECTRODES = ['Fz', 'C3', 'Cz', 'C4', 'PO7', 'Pz', 'PO8', 'Oz'];

// A recording shaped like the Kaggle motor imagery files: Lab Streaming Layer clock times
// with a little jitter, steps that make 250 Hz look like 250.25, eight electrodes resting
// hundreds of thousands of microvolts from zero, and a marker column that is empty but for
// a few rows.
export function lslCsv({
  rows = 2002,
  step = 0.003996,
  start = 53704.78020002602,
  markers = { 250: 'trial_start', 1000: 'move', 1500: 'cue_stop' },
} = {}) {
  const lines = [];
  for (let i = 0; i < rows; i += 1) {
    const time = start + i * step + (i % 3 === 0 ? 2e-6 : 0);
    const values = ELECTRODES.map((_, c) =>
      (250000 + c * 1000 + 10 * Math.sin(i / 9 + c)).toFixed(2),
    );
    lines.push([time, ...values, markers[i] ?? '']);
  }
  return buildCsv(['time', ...ELECTRODES, 'Marker_val'], lines);
}
