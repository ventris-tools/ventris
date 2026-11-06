import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInThisContext } from 'node:vm';
import { installDom } from './support/dom.js';

const KEY = 'ventris-theme';
const script = new URL('../js/theme.js', import.meta.url);
const source = readFileSync(script, 'utf8');

// Runs theme.js on a new page as a plain script, the way the head of index.html does. Importing
// it once per page would count every import as a separate file in the coverage total.
function load({ dark = false, stored = null, refuse = false } = {}) {
  const window = installDom();
  const { document } = window;
  const saved = new Map(stored === null ? [] : [[KEY, stored]]);
  const listeners = [];
  const system = { matches: dark, addEventListener: (_, listener) => listeners.push(listener) };
  const storage = {
    getItem(key) {
      if (refuse) throw new Error('refused');
      return saved.get(key) ?? null;
    },
    setItem(key, value) {
      if (refuse) throw new Error('refused');
      saved.set(key, value);
    },
  };
  globalThis.matchMedia = () => system;
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
    writable: true,
  });

  runInThisContext(source, { filename: script.href });
  document.dispatchEvent(new window.Event('DOMContentLoaded'));

  return {
    document,
    saved,
    theme: () => document.documentElement.dataset.theme,
    toggle: () => document.querySelector('.theme-toggle').click(),
    systemChanges(matches) {
      system.matches = matches;
      listeners.forEach((listener) => listener());
    },
  };
}

test('follows the system until someone chooses', () => {
  assert.equal(load({ dark: true }).theme(), 'dark');
  assert.equal(load({ dark: false }).theme(), 'light');
});

test('a remembered choice beats the system', () => {
  assert.equal(load({ dark: true, stored: 'light' }).theme(), 'light');
  assert.equal(load({ dark: false, stored: 'dark' }).theme(), 'dark');
});

test('ignores a remembered value that is not a theme', () => {
  assert.equal(load({ dark: true, stored: 'purple' }).theme(), 'dark');
});

test('the switch changes the theme and remembers it', () => {
  const page = load();
  page.toggle();
  assert.equal(page.theme(), 'dark');
  assert.equal(page.saved.get(KEY), 'dark');
  page.toggle();
  assert.equal(page.theme(), 'light');
  assert.equal(page.saved.get(KEY), 'light');
});

test('a click on the icon inside the switch counts', () => {
  const page = load();
  const icon = page.document.querySelector('.theme-toggle svg');
  icon.dispatchEvent(new page.document.defaultView.MouseEvent('click', { bubbles: true }));
  assert.equal(page.theme(), 'dark');
});

test('other clicks leave the theme alone', () => {
  const page = load();
  page.document.body.click();
  assert.equal(page.theme(), 'light');
  assert.equal(page.saved.size, 0);
});

test('the switch names the theme it leads to', () => {
  const page = load();
  const button = page.document.querySelector('.theme-toggle');
  const labels = () => [button.title, button.getAttribute('aria-label')];
  assert.deepEqual(labels(), ['Switch to dark mode', 'Switch to dark mode']);
  page.toggle();
  assert.deepEqual(labels(), ['Switch to light mode', 'Switch to light mode']);
});

test('follows a change in the system only until someone chooses', () => {
  const page = load();
  page.systemChanges(true);
  assert.equal(page.theme(), 'dark');
  page.toggle();
  assert.equal(page.theme(), 'light');
  page.systemChanges(true);
  assert.equal(page.theme(), 'light');
});

test('still switches when the browser refuses storage', () => {
  const page = load({ dark: true, refuse: true });
  assert.equal(page.theme(), 'dark');
  page.toggle();
  assert.equal(page.theme(), 'light');
  page.systemChanges(true);
  assert.equal(page.theme(), 'light');
});
