import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { Md5 } from '../js/md5.js';

const md5 = (bytes) => createHash('md5').update(bytes).digest('hex');
const ascii = (text) => new TextEncoder().encode(text);

test('gives the hashes in RFC 1321', () => {
  const suite = {
    '': 'd41d8cd98f00b204e9800998ecf8427e',
    a: '0cc175b9c0f1b6a831c399e269772661',
    abc: '900150983cd24fb0d6963f7d28e17f72',
    'message digest': 'f96b697d7cb7938d525a2f31aaf161d0',
    abcdefghijklmnopqrstuvwxyz: 'c3fcd3d76192e4007dfb496cca67e13b',
    '12345678901234567890123456789012345678901234567890123456789012345678901234567890':
      '57edf4a22be3c955ac49da2e2107b67a',
  };
  for (const [text, hash] of Object.entries(suite)) {
    assert.equal(new Md5().update(ascii(text)).digest(), hash, text);
  }
});

test('agrees with Node at every length around a block and its padding', () => {
  const bytes = Uint8Array.from({ length: 300 }, (_, i) => (i * 37 + 11) & 255);
  for (const length of [1, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 300]) {
    const part = bytes.subarray(0, length);
    assert.equal(new Md5().update(part).digest(), md5(part), `length ${length}`);
  }
});

test('gives the same hash however the bytes arrive', () => {
  const bytes = Uint8Array.from({ length: 5000 }, (_, i) => (i * i) & 255);
  for (const sizes of [[1], [7], [63], [64], [65], [1000, 1, 3999]]) {
    const hash = new Md5();
    for (let at = 0, n = 0; at < bytes.length; n += 1) {
      const size = sizes[n % sizes.length];
      hash.update(bytes.subarray(at, at + size));
      at += size;
    }
    assert.equal(hash.digest(), md5(bytes), `pieces of ${sizes}`);
  }
});
