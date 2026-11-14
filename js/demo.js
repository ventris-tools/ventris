// The synthetic recording that Ventris opens on. Alpha rhythm grows at the back of the
// head between 20 and 40 seconds, which is what closing your eyes does. It contains no
// real person's data, and says so wherever a real file shows its details.

import { NO_INFO } from './recording.js';

const SAMPLE_RATE = 256;
const SECONDS = 60;
const BLINKS = [6, 14, 47, 55];

// Where the viewer opens, so that a blink and the eyes closing share the first screen.
export const DEMO_START = 13;

// Label, closeness to the back of the head, closeness to the eyes.
const MONTAGE = [
  ['Fp1', 0.1, 1],
  ['Fp2', 0.1, 1],
  ['C3', 0.4, 0.15],
  ['C4', 0.4, 0.15],
  ['P3', 0.8, 0],
  ['P4', 0.8, 0],
  ['O1', 1, 0],
  ['O2', 1, 0],
];

// mulberry32 by Tommy Ettinger, in the public domain (CC0):
// https://gist.github.com/tommyettinger/46a874533244883189143505d203312c
function randomSource(seed) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function smoothStep(from, to, value) {
  const x = Math.min(1, Math.max(0, (value - from) / (to - from)));
  return x * x * (3 - 2 * x);
}

export function demoRecording() {
  const total = SAMPLE_RATE * SECONDS;
  const channels = MONTAGE.map(([label, posterior, frontal], index) => {
    const random = randomSource(1952 + index);
    const data = new Float32Array(total);
    const phase = random() * 0.6;
    let drift = 0;
    for (let i = 0; i < total; i += 1) {
      const t = i / SAMPLE_RATE;
      drift = 0.97 * drift + (random() - 0.5) * 7;
      const eyesClosed = smoothStep(19.5, 21, t) * (1 - smoothStep(39.5, 41, t));
      const waxing = 0.75 + 0.25 * Math.sin(2 * Math.PI * 0.4 * t + index);
      const alpha =
        posterior * (5 + 38 * eyesClosed) * waxing * Math.sin(2 * Math.PI * 10 * t + phase);
      const beta = (3 - 1.5 * posterior) * Math.sin(2 * Math.PI * 21 * t + phase * 3);
      let blink = 0;
      for (const time of BLINKS) {
        blink += frontal * 130 * Math.exp(-(((t - time) / 0.11) ** 2));
      }
      data[i] = drift + alpha + beta + blink + (random() - 0.5) * 5;
    }
    return { label, unit: 'uV', fs: SAMPLE_RATE, data };
  });
  return {
    format: 'Synthetic',
    duration: SECONDS,
    channels,
    annotations: [
      { time: 20, duration: 0, text: 'Eyes closed' },
      { time: 40, duration: 0, text: 'Eyes open' },
    ],
    warnings: [],
    // Generated without filtering.
    info: { ...NO_INFO, highpass: 0, lowpass: SAMPLE_RATE / 2 },
  };
}
