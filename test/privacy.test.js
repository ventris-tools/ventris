import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const { document } = new JSDOM(html).window;
const POLICY_TAG = 'meta[http-equiv="Content-Security-Policy"]';

// This policy backs up the README's promise that a recording never leaves the computer, so
// changing it should take a deliberate edit here as well as in index.html.
const POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
];

test('the page keeps its Content Security Policy', () => {
  assert.deepEqual(document.querySelector(POLICY_TAG).content.split(/;\s*/), POLICY);
});

test('the policy comes before anything it has to cover', () => {
  const first = document.querySelector(`${POLICY_TAG}, script, style, link`);
  assert.equal(first.getAttribute('http-equiv'), 'Content-Security-Policy');
});
