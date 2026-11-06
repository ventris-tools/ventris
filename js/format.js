// Turns numbers into the text the interface shows, so every panel writes them the same way.

const MAX_DECIMALS = 20;

export const unitLabel = (unit) => unit.replace(/^u(?=V$)/, 'µ');

export const count = (number, noun) => `${number} ${noun}${number === 1 ? '' : 's'}`;

// A time as m:ss or h:mm:ss, with fractions of a second when decimals asks for them.
export function formatClock(seconds, decimals = 0) {
  const scale = 10 ** decimals;
  const ticks = Math.round(seconds * scale);
  const whole = Math.floor(ticks / scale);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = String(whole % 60).padStart(2, '0');
  const fraction = decimals > 0 ? `.${String(ticks % scale).padStart(decimals, '0')}` : '';
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}${fraction}`
    : `${minutes}:${rest}${fraction}`;
}

// Decimals for values measured against a range: at least one, and enough for three
// significant figures, so a signal stored in volts does not round to zero.
export function decimalsFor(range) {
  if (!(range > 0)) return 1;
  return Math.min(MAX_DECIMALS, Math.max(1, 2 - Math.floor(Math.log10(range))));
}

export function amount(value, unit, decimals = 1) {
  const digits = { minimumFractionDigits: decimals, maximumFractionDigits: decimals };
  const number = value.toLocaleString('en-US', digits);
  // Rounding can leave a sign on nothing at all, as in -0.0.
  const signed = /[1-9]/.test(number) ? number.replace('-', '−') : number.replace('-', '');
  return `${signed} ${unitLabel(unit)}`.trim();
}

// One formatter for every row of every frame, as making one is what takes the time.
const rangeNumber = new Intl.NumberFormat('en-US', { maximumSignificantDigits: 2 });

// How far a row reaches either side of its middle.
export function rowRange(value, unit) {
  return `±${rangeNumber.format(value)} ${unitLabel(unit)}`.trim();
}
