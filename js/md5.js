// MD5, written from its specification, RFC 1321. Web Crypto has no MD5, and git-annex names
// many files by their MD5 hash, so a download from a link is checked with this. It guards
// against a wrong or damaged copy, not against tampering.

// How far each step rotates, four to a round.
const SHIFTS = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];

// The whole part of 2^32 × |sin(i)|, for i from 1 to 64.
const SINES = Int32Array.from({ length: 64 }, (_, i) =>
  Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32),
);

// Mixes one block of 64 bytes, from at in bytes, into the state.
function mix(state, bytes, at, words) {
  for (let i = 0; i < 16; i += 1) {
    const j = at + 4 * i;
    words[i] = bytes[j] | (bytes[j + 1] << 8) | (bytes[j + 2] << 16) | (bytes[j + 3] << 24);
  }
  let a = state[0];
  let b = state[1];
  let c = state[2];
  let d = state[3];
  for (let i = 0; i < 64; i += 1) {
    let f;
    let word;
    if (i < 16) {
      f = (b & c) | (~b & d);
      word = i;
    } else if (i < 32) {
      f = (d & b) | (~d & c);
      word = (5 * i + 1) & 15;
    } else if (i < 48) {
      f = b ^ c ^ d;
      word = (3 * i + 5) & 15;
    } else {
      f = c ^ (b | ~d);
      word = (7 * i) & 15;
    }
    const shift = SHIFTS[((i >> 4) << 2) | (i & 3)];
    const sum = (a + f + SINES[i] + words[word]) | 0;
    a = d;
    d = c;
    c = b;
    b = (b + ((sum << shift) | (sum >>> (32 - shift)))) | 0;
  }
  state[0] = (state[0] + a) | 0;
  state[1] = (state[1] + b) | 0;
  state[2] = (state[2] + c) | 0;
  state[3] = (state[3] + d) | 0;
}

// Takes the bytes in pieces as they arrive, so a download is hashed while it comes in.
export class Md5 {
  constructor() {
    this.state = Int32Array.of(0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476);
    this.block = new Uint8Array(64);
    this.words = new Int32Array(16);
    this.waiting = 0;
    this.length = 0;
  }

  update(bytes) {
    this.length += bytes.length;
    let at = 0;
    if (this.waiting > 0) {
      at = Math.min(64 - this.waiting, bytes.length);
      this.block.set(bytes.subarray(0, at), this.waiting);
      this.waiting += at;
      if (this.waiting < 64) return this;
      mix(this.state, this.block, 0, this.words);
      this.waiting = 0;
    }
    for (; at + 64 <= bytes.length; at += 64) mix(this.state, bytes, at, this.words);
    this.block.set(bytes.subarray(at));
    this.waiting = bytes.length - at;
    return this;
  }

  // The hash as 32 lowercase hex digits. The padding ends with the length in bits.
  digest() {
    const bits = this.length * 8;
    const padding = new Uint8Array((this.waiting < 56 ? 64 : 128) - this.waiting);
    padding[0] = 0x80;
    const view = new DataView(padding.buffer);
    view.setUint32(padding.length - 8, bits >>> 0, true);
    view.setUint32(padding.length - 4, Math.floor(bits / 2 ** 32), true);
    this.update(padding);
    const bytes = new Uint8Array(this.state.buffer);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
}
