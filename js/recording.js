// The shape of a recording, which every reader returns and the rest of the app reads:
//
//   format       'EDF', 'EDF+', 'CSV' or 'Synthetic'
//   duration     its length in seconds
//   channels     { label, unit, fs, data } for each signal, data a Float32Array
//   annotations  { time, duration, text } for each, in seconds and sorted by time
//   warnings     sentences about the file, shown under its name
//   info         the details below, null for anything the file doesn't say, and for a CSV
//                firstTime, the clock reading of its first sample
//
// test/recording.test.js checks that every reader keeps to it.

// Anything past these is a damaged header or a misread time column rather than a recording.
export const MAX_SAMPLE_RATE = 1e6;
export const MAX_SECONDS = 1e9;

export const NO_SUBJECT = Object.freeze({
  id: null,
  name: null,
  sex: null,
  birthday: null,
  hand: null,
  height: null,
  weight: null,
});

// Cutoffs are in hertz, and null when the file doesn't say. An EDF header that says nothing
// means no filter, which the EDF reader writes as 0 and the Nyquist rate.
export const NO_INFO = Object.freeze({
  date: null,
  time: null,
  subject: NO_SUBJECT,
  project: null,
  experimenter: null,
  device: null,
  highpass: null,
  lowpass: null,
  notch: null,
});
