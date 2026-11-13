import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { resolveLink } from '../js/remote.js';
import { buildEdf } from './support/edf.js';
import { installDom } from './support/dom.js';

const FOLDER = 'https://github.com/nemarDatasets/on003194/blob/main/sub-01/eeg';
const linkTo = (name) => `${FOLDER}/${name}`;
const nameOf = (link) => link.split('/').at(-1);

const STARTING = linkTo('sub-01_task-start_eeg.edf');

// Answers fetch from a table of addresses, as OpenNeuro and GitHub would.
const answers = new Map();
const requests = [];
globalThis.fetch = async (url, options) => {
  requests.push({ url, ...options });
  const answer = answers.get(url);
  return answer ? answer(options) : new Response('', { status: 404 });
};

const recording = () =>
  new Uint8Array(buildEdf([{ label: 'Cz', samples: 1000 }], { records: 100 }));

const pointerFor = (bytes, size = bytes.length) =>
  `/annex/objects/SHA256E-s${size}--${createHash('sha256').update(bytes).digest('hex')}.edf`;

// Puts a recording where a link leads. The body can be any response, such as one held back.
function serve(link, bytes = recording(), body = () => new Response(bytes)) {
  const { dataUrl, pointerUrl } = resolveLink(link);
  answers.set(dataUrl, body);
  if (pointerUrl) answers.set(pointerUrl, () => new Response(pointerFor(bytes)));
  return bytes;
}

// A body that sends its first half, then waits for release() or for the download to be stopped.
function heldBody(bytes) {
  const half = bytes.length / 2;
  let release;
  const released = new Promise((resolve) => {
    release = resolve;
  });
  const body = ({ signal }) =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(bytes.slice(0, half));
          signal.addEventListener('abort', () => controller.error(signal.reason));
          released.then(() => {
            controller.enqueue(bytes.slice(half));
            controller.close();
          });
        },
      }),
    );
  return { body, release };
}

serve(STARTING);
const window = installDom({ url: `http://localhost/#url=${STARTING}` });
const { document } = window;
await import('../js/app.js');

const $ = (id) => document.getElementById(id);
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
async function until(ready) {
  for (let tries = 0; tries < 500 && !ready(); tries += 1) await wait(10);
}
const shown = () => $('recording-name').textContent;
const address = () => new URL(document.URL).hash;

function submit(link) {
  $('link-input').value = link;
  const event = new window.Event('submit', { cancelable: true });
  $('link-form').dispatchEvent(event);
  return event;
}

function showDemo() {
  $('open-recording').click();
  $('show-demo').click();
}

test('opens the recording that the address links to', async () => {
  await until(() => shown() === nameOf(STARTING));
  assert.equal(shown(), nameOf(STARTING));
  assert.equal($('loader').open, false);
  assert.equal(address(), `#url=${STARTING}`);
  assert.equal($('link-input').value, STARTING);
  assert.equal($('link-status').hidden, true);
  assert.equal($('open-link').disabled, false);
});

test('downloads only from OpenNeuro and NEMAR, and sends no cookies or referrer', () => {
  for (const { url, credentials, referrerPolicy } of requests) {
    assert.match(
      url,
      /^https:\/\/(s3\.amazonaws\.com\/openneuro\.org|raw\.githubusercontent\.com\/nemarDatasets)\//,
    );
    assert.equal(credentials, 'omit');
    assert.equal(referrerPolicy, 'no-referrer');
  }
});

test('opens a link from the dialog and shows the download as it arrives', async () => {
  const link = linkTo('sub-01_task-held_eeg.edf');
  const held = heldBody(recording());
  serve(link, recording(), held.body);

  const event = submit(link);
  assert.equal(event.defaultPrevented, true);
  assert.equal($('loader').open, true);
  assert.equal($('open-link').disabled, true);
  await until(() => $('link-status').textContent.includes(' of '));
  assert.equal($('link-status').hidden, false);
  assert.equal($('link-status').textContent, 'Downloading 0.1 of 0.2 MB');
  assert.equal(shown(), nameOf(STARTING));
  assert.equal(address(), `#url=${STARTING}`);

  held.release();
  await until(() => shown() === nameOf(link));
  assert.equal($('loader').open, false);
  assert.equal(address(), `#url=${link}`);
});

test("says why a link can't be opened, and keeps the recording and its address", async () => {
  const before = { name: shown(), address: address(), requests: requests.length };
  submit('https://example.com/sub-01_eeg.edf');
  assert.equal($('loader').open, true);
  assert.match($('error').textContent, /NEMAR datasets on GitHub, or to OpenNeuro/);
  assert.equal(requests.length, before.requests);

  submit(linkTo('sub-01_task-missing_eeg.edf'));
  await until(() => !$('error').hidden);
  assert.match($('error').textContent, /isn't in that version of the dataset/);
  assert.equal(shown(), before.name);
  assert.equal(address(), before.address);
  assert.equal($('open-link').disabled, false);
  $('close-loader').click();
});

test("says so when the download isn't an EDF file", async () => {
  const link = 'https://s3.amazonaws.com/openneuro.org/ds003194/sub-01/eeg/sub-01_junk_eeg.edf';
  serve(link, new Uint8Array(600).fill(120));
  submit(link);
  await until(() => !$('error').hidden);
  assert.equal($('error').textContent, 'This does not look like an EDF file.');
  $('close-loader').click();
});

test('says a recording may be too large when the browser cannot hold it', async () => {
  const link = linkTo('sub-01_task-huge_eeg.edf');
  const bytes = serve(link);
  answers.set(resolveLink(link).pointerUrl, () => new Response(pointerFor(bytes, 2 ** 53)));
  submit(link);
  await until(() => !$('error').hidden);
  assert.equal(
    $('error').textContent,
    'sub-01_task-huge_eeg.edf could not be opened. It may be too large for this browser.',
  );
  $('close-loader').click();
});

test('the demo stops a download under way and takes the link out of the address', async () => {
  const link = linkTo('sub-01_task-stopped_eeg.edf');
  const held = heldBody(recording());
  serve(link, recording(), held.body);
  submit(link);
  await until(() => $('link-status').textContent.includes(' of '));

  showDemo();
  const { signal } = requests.at(-1);
  assert.equal(signal.aborted, true);
  assert.equal(shown(), 'Demo (synthetic data)');
  assert.equal(address(), '');
  assert.equal($('link-status').hidden, true);
  assert.equal($('open-link').disabled, false);
  await wait(10);
  assert.equal($('error').hidden, true);
});

test('a link that arrives late does not replace what was opened after it', async () => {
  const link = linkTo('sub-01_task-late_eeg.edf');
  let release;
  const released = new Promise((resolve) => {
    release = resolve;
  });
  // A server that sends the file once released, whether or not the download was stopped.
  const bytes = serve(link, recording(), () => released.then(() => new Response(bytes)));
  submit(link);
  await until(() => requests.at(-1).url === resolveLink(link).dataUrl);
  showDemo();
  release();
  await wait(50);
  assert.equal(shown(), 'Demo (synthetic data)');
  assert.equal(address(), '');
});

test('follows a link pasted into the address, written plainly or encoded', async () => {
  const plain = linkTo('sub-01_task-plain_eeg.edf');
  const encoded = linkTo('sub-01_task-encoded_eeg.edf');
  serve(plain);
  serve(encoded);

  window.location.hash = `#url=${plain}`;
  await until(() => shown() === nameOf(plain));
  assert.equal(shown(), nameOf(plain));

  window.location.hash = `#url=${encodeURIComponent(encoded)}`;
  await until(() => shown() === nameOf(encoded));
  assert.equal(shown(), nameOf(encoded));
  assert.equal(address(), `#url=${encoded}`);

  window.location.hash = '#url=https%3A%2F%2Fgithub.com%E0%A4%A';
  await until(() => !$('error').hidden);
  assert.equal($('error').textContent, "That doesn't look like a web address.");
  assert.equal(shown(), nameOf(encoded));
  $('close-loader').click();

  const before = requests.length;
  window.location.hash = '#elsewhere';
  await wait(20);
  assert.equal(requests.length, before);
  assert.equal(shown(), nameOf(encoded));
});

test('opening a file from the computer takes the link out of the address', async () => {
  const event = new window.Event('drop', { cancelable: true });
  const file = { name: 'night.edf', arrayBuffer: async () => recording().buffer };
  event.dataTransfer = { types: ['Files'], files: [file] };
  window.dispatchEvent(event);
  await until(() => shown() === 'night.edf');
  assert.equal(address(), '');
});
