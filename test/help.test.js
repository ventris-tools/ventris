import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { BAND_RANGE } from '../js/dsp.js';

const html = readFileSync(new URL('../help.html', import.meta.url), 'utf8');
const { document } = new JSDOM(html).window;
const text = document.body.textContent;

test('holds the explanations that the viewer leaves out', () => {
  assert.match(text, /never leave your computer/);
  assert.match(text, /not a medical device/);
  assert.match(text, /not a real recording/);
  assert.match(text, /compare shapes rather than heights/);
});

test('explains how to zoom and how to undo it', () => {
  assert.match(text, /Drag a box across the traces/);
  assert.match(text, /Double-click the traces/);
  assert.ok(document.getElementById('zoom'));
});

test('names the band range the viewer measures', () => {
  assert.ok(text.includes(`${BAND_RANGE} power`));
});

test('runs nothing but the theme, which it shares with the viewer', () => {
  const scripts = [...document.scripts].map((script) => script.getAttribute('src'));
  assert.deepEqual(scripts, ['js/theme.js']);
});

test('leads back to the viewer', () => {
  assert.equal(document.querySelector('.brand').getAttribute('href'), 'index.html');
});
