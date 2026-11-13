// Holds the app's colours to the rules under Colour in CONTRIBUTING.md, in both themes, so
// that a new or changed colour can't quietly fail colour-blind readers.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { eventColors } from '../js/traces.js';
import { contrast, difference, VISIONS } from './support/color.js';

const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

// The custom properties a rule sets, by name.
function properties(selector) {
  const start = css.indexOf(`\n${selector} {`);
  assert.ok(start >= 0, `styles.css has no ${selector} rule`);
  const block = css.slice(start, css.indexOf('}', start));
  const pairs = [...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)];
  return Object.fromEntries(pairs.map(([, name, value]) => [name, value.trim()]));
}

const light = properties(':root');
const themes = { light, dark: { ...light, ...properties(':root[data-theme="dark"]') } };

// Every colour an annotation can get, the grey for extra kinds included.
const kinds = Array.from({ length: 20 }, (_, time) => ({ time, duration: 0, text: `${time}` }));
const annotationColors = [...new Set(eventColors(kinds))];
const pairs = annotationColors.flatMap((a, index) =>
  annotationColors.slice(index + 1).map((b) => [a, b]),
);

// Every colour used for text, and every background it sits on.
const TEXT = ['--ink', '--ink-2', '--accent', '--error'];
const BACKGROUNDS = ['--paper', '--surface'];

test('the palette holds the colours that annotations are given, and no others', () => {
  const palette = Object.keys(light).filter((name) => /^--event-\d+$/.test(name));
  assert.deepEqual(
    palette,
    annotationColors.filter((name) => name.startsWith('--event-')),
  );
});

for (const [theme, colors] of Object.entries(themes)) {
  const hex = (name) => {
    assert.match(colors[name] ?? '', /^#[0-9a-f]{6}$/, `${name} in the ${theme} theme`);
    return colors[name];
  };

  test(`every two annotation colours stay apart with colour blindness, ${theme} theme`, () => {
    for (const [a, b] of pairs) {
      for (const vision of VISIONS) {
        const apart = difference(hex(a), hex(b), vision);
        assert.ok(apart >= 8, `${a} and ${b} are ${apart.toFixed(1)} apart with ${vision}`);
      }
    }
  });

  test(`every two annotation colours stay apart with full colour vision, ${theme} theme`, () => {
    for (const [a, b] of pairs) {
      const apart = difference(hex(a), hex(b));
      assert.ok(apart >= 15, `${a} and ${b} are ${apart.toFixed(1)} apart`);
    }
  });

  test(`annotation marks stand out from the traces' background, ${theme} theme`, () => {
    for (const name of annotationColors) {
      const ratio = contrast(hex(name), hex('--surface'));
      assert.ok(ratio >= 3, `${name} is ${ratio.toFixed(2)}:1 on --surface`);
    }
  });

  test(`text reads on every background, ${theme} theme`, () => {
    for (const text of TEXT) {
      for (const background of BACKGROUNDS) {
        const ratio = contrast(hex(text), hex(background));
        assert.ok(ratio >= 4.5, `${text} is ${ratio.toFixed(2)}:1 on ${background}`);
      }
    }
  });
}
