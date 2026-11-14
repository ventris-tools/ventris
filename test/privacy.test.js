import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { NEMAR_GITHUB, OPENNEURO } from '../js/remote.js';

const POLICY_TAG = 'meta[http-equiv="Content-Security-Policy"]';

// This policy backs up the README's promise that a recording never leaves the computer, so
// changing it should take a deliberate edit here as well as in the pages.
const policy = (connect) => [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  `connect-src ${connect}`,
  "base-uri 'none'",
  "form-action 'none'",
];

// The viewer may download a public recording opened by link, from these two places alone. The
// help page has no reason to reach anything.
const PAGES = {
  'index.html': policy(`${OPENNEURO} ${NEMAR_GITHUB}`),
  'help/index.html': policy("'none'"),
};

for (const [page, expected] of Object.entries(PAGES)) {
  const html = readFileSync(new URL(`../${page}`, import.meta.url), 'utf8');
  const { document } = new JSDOM(html).window;

  test(`${page} keeps its Content Security Policy`, () => {
    assert.deepEqual(document.querySelector(POLICY_TAG).content.split(/;\s*/), expected);
  });

  test(`the policy in ${page} comes before anything it has to cover`, () => {
    const first = document.querySelector(`${POLICY_TAG}, script, style, link`);
    assert.equal(first.getAttribute('http-equiv'), 'Content-Security-Policy');
  });
}

test('lets the viewer reach only a folder on each host, never a whole host', () => {
  for (const place of [OPENNEURO, NEMAR_GITHUB]) {
    const { protocol, pathname } = new URL(place);
    assert.equal(protocol, 'https:');
    assert.match(pathname, /^\/[^/]+\/$/);
  }
});
