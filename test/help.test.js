import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { BAND_RANGE } from '../js/dsp.js';

// Help lives in a folder of its own, so that its address is help/ rather than help.html.
const page = new URL('../help/index.html', import.meta.url);
const { document } = new JSDOM(readFileSync(page, 'utf8')).window;
const text = document.querySelector('main').textContent;

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
  assert.deepEqual(scripts, ['../js/theme.js']);
  assert.ok(document.querySelector('.theme-toggle'));
});

test('leads back to the viewer', () => {
  assert.equal(document.querySelector('.brand').getAttribute('href'), '../');
});

test('lists every section in its contents, in the order they come', () => {
  const sections = [...document.querySelectorAll('main h2')].map((heading) => `#${heading.id}`);
  const contents = [...document.querySelectorAll('.contents a')].map((link) => link.hash);
  assert.ok(sections.length >= 10);
  assert.deepEqual(contents, sections);
});

test('finds every file it links to from its own folder', () => {
  const links = [...document.querySelectorAll('[src], [href]')]
    .map((element) => element.getAttribute('src') ?? element.getAttribute('href'))
    .filter((link) => !link.startsWith('#') && !link.includes(':'));
  assert.ok(links.length >= 6);
  for (const link of links) assert.ok(existsSync(new URL(link, page)), link);
});

test('every icon in use is defined on the page', () => {
  const uses = [...document.querySelectorAll('use')].map((use) => use.getAttribute('href'));
  assert.ok(uses.length >= 4);
  for (const href of uses) assert.ok(document.querySelector(`symbol${href}`), href);
});

test("has the section that the viewer's link help points to", () => {
  const viewer = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const help = new JSDOM(viewer).window.document.querySelector('.link-head a');
  assert.equal(help.getAttribute('href'), 'help/#links');
  assert.equal(help.target, '_blank');
  assert.ok(document.getElementById('links'));
});
