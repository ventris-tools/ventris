import assert from 'node:assert/strict';
import test from 'node:test';
import { buildEdf } from './support/edf.js';
import { installDom } from './support/dom.js';

const window = installDom();
const { document } = window;
await import('../js/app.js');

const $ = (id) => document.getElementById(id);
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function drop(file) {
  const event = new window.Event('drop', { cancelable: true });
  event.dataTransfer = { types: ['Files'], files: [file] };
  window.dispatchEvent(event);
}

const fileOf = (name, buffer) => ({ name, arrayBuffer: async () => buffer });

// A file that stays unread until release() is called.
function slowFile(name, buffer) {
  let release;
  const reading = new Promise((resolve) => {
    release = () => resolve(buffer);
  });
  return { name, arrayBuffer: () => reading, release };
}

const signal = (samples = 256) => ({ label: 'Cz', samples, value: (r, i) => (i % 7) * 100 });
const edf = (options) => buildEdf([signal()], { records: 30, ...options });

async function open(name, buffer = edf()) {
  drop(fileOf(name, buffer));
  await wait(0);
  await wait(0);
}

const press = (target, key) =>
  target.dispatchEvent(
    new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
  );

test('starts on the dialog with nothing behind it', () => {
  assert.equal($('loader').open, true);
  assert.equal($('viewer').hidden, true);
  assert.equal($('close-loader').hidden, true);
  assert.match(document.querySelector('.loader-intro').textContent, /EEG recording/);
});

test('offers the theme switch and GitHub link on the dialog and in the viewer', () => {
  for (const place of ['.loader-head', '.masthead']) {
    const area = document.querySelector(place);
    const link = area.querySelector('.github-link');
    assert.ok(area.querySelector('.theme-toggle'), place);
    assert.equal(link.href, 'https://github.com/ventris-tools/ventris');
    assert.equal(link.getAttribute('aria-label'), 'Ventris on GitHub');
  }
});

test('opens GitHub in a new tab so that the recording stays open', () => {
  for (const link of document.querySelectorAll('.github-link')) {
    assert.equal(link.target, '_blank');
    assert.equal(link.rel, 'noopener noreferrer');
  }
});

test('every icon in use is defined on the page', () => {
  const uses = [...document.querySelectorAll('use')].map((use) => use.getAttribute('href'));
  assert.ok(uses.length >= 6);
  for (const href of uses) assert.ok(document.querySelector(`symbol${href}`), href);
});

test('the dialog stays open until something has been opened', () => {
  $('loader').close();
  assert.equal($('loader').open, true);
});

test('says plainly that the demo is synthetic', () => {
  $('show-demo').click();
  assert.equal($('loader').open, false);
  assert.equal($('viewer').hidden, false);
  assert.equal($('recording-name').textContent, 'Demo (synthetic data)');
  assert.match($('recording-note').textContent, /not a real recording/);
  assert.equal($('recording-note').hidden, false);
});

test('offers windows up to the whole file and starts at ten seconds', () => {
  const labels = [...$('window').options].map(({ text }) => text);
  assert.deepEqual(labels, ['5 s', '10 s', '30 s', 'Whole file']);
  assert.equal($('window').value, '10');
});

test('lists annotations and jumps to them', async () => {
  const buttons = [...$('annotation-list').querySelectorAll('button')];
  assert.equal($('annotations').hidden, false);
  assert.deepEqual(
    buttons.map(({ textContent }) => textContent),
    ['0:20 Eyes closed', '0:40 Eyes open'],
  );
  buttons[1].click();
  assert.equal(Number($('position').value), 39);
  assert.match($('position-text').textContent, /^0:39 to 0:49$/);
});

test('keeps the fraction of an annotation that falls between seconds', async () => {
  const tal = (record) => `+${record}\x14\x14\0${record === 1 ? '+1.5\x14Spike\x14\0' : ''}`;
  const annotated = buildEdf([signal(), { label: 'EDF Annotations', samples: 32, tal }], {
    records: 30,
    reserved: 'EDF+C',
  });
  await open('annotated.edf', annotated);
  assert.equal($('annotation-list').textContent, '0:01.5 Spike');
  $('open-recording').click();
  $('show-demo').click();
});

test('moves through time from the keyboard', () => {
  const position = $('position');
  press(position, 'Home');
  assert.equal(Number(position.value), 0);
  press(position, 'ArrowRight');
  assert.equal(Number(position.value), 1);
  press(position, 'ArrowLeft');
  assert.equal(Number(position.value), 0);
  press(position, 'PageUp');
  assert.equal(Number(position.value), 10);
  press($('traces'), 'PageUp');
  assert.equal(Number(position.value), 20);
  press(position, 'PageDown');
  assert.equal(Number(position.value), 10);
  press(position, 'End');
  assert.equal(Number(position.value), 50);
  press(position, 'Home');
});

test('the canvas keeps the arrow keys for its cursor', () => {
  const before = $('position').value;
  press($('traces'), 'ArrowRight');
  assert.equal($('position').value, before);
  assert.match($('cursor-status').textContent, /Fp1/);
  assert.equal($('cursor-status').textContent, $('readout').textContent);
});

test('stops the trace size at its limits', () => {
  for (let i = 0; i < 12; i += 1) $('gain-up').click();
  assert.equal($('gain-up').disabled, true);
  assert.equal($('gain-down').disabled, false);
  for (let i = 0; i < 24; i += 1) $('gain-down').click();
  assert.equal($('gain-down').disabled, true);
  assert.equal($('gain-up').disabled, false);
});

test('opens an EDF file, resets the view and hides the empty annotation list', async () => {
  await open('night.edf');
  assert.equal($('recording-name').textContent, 'night.edf');
  assert.equal($('annotations').hidden, true);
  assert.equal($('recording-note').hidden, true);
  assert.equal($('gain-down').disabled, false);
  assert.equal($('readout').textContent, '');
  assert.match($('traces').getAttribute('aria-label'), /^Traces for 1 channel, from/);
});

test('gives the real reason when bands cannot be measured', async () => {
  await open(
    'flat.edf',
    buildEdf([{ label: 'Cz', samples: 256, value: () => 3 }], { records: 10 }),
  );
  await wait(80);
  assert.equal($('band-note').textContent, 'The EEG channels are flat in this window.');
  assert.ok(document.querySelector('.bar').hidden);

  await open('slow.edf', buildEdf([{ label: 'Cz', samples: 32 }], { records: 10 }));
  await wait(80);
  assert.match($('band-note').textContent, /high enough sample rate/);

  await open('belts.edf', buildEdf([{ label: 'Abdomen', samples: 256 }], { records: 10 }));
  await wait(80);
  assert.equal($('band-note').textContent, 'This recording has no EEG channels to measure.');
  assert.equal($('time-note').textContent, 'This recording has no EEG channels to measure.');
});

test('a bad file shows its error and keeps the recording on screen', async () => {
  await open('night.edf');
  await open('junk.edf', new Uint8Array(600).fill(120).buffer);
  assert.equal($('loader').open, true);
  assert.equal($('error').textContent, 'This does not look like an EDF file.');
  assert.equal($('close-loader').hidden, false);
  assert.equal($('recording-name').textContent, 'night.edf');
  $('close-loader').click();
});

test('a file that cannot be read says so', async () => {
  const file = { name: 'huge.edf', arrayBuffer: () => Promise.reject(new Error('too big')) };
  drop(file);
  await wait(0);
  assert.match($('error').textContent, /huge\.edf could not be opened/);
  $('close-loader').click();
});

test('a file that finishes late does not replace what was opened after it', async () => {
  const late = slowFile('late.edf', edf());
  drop(late);
  $('open-recording').click();
  $('show-demo').click();
  assert.equal($('recording-name').textContent, 'Demo (synthetic data)');
  late.release();
  await wait(0);
  assert.equal($('recording-name').textContent, 'Demo (synthetic data)');
  assert.equal($('choose-file').disabled, false);
});

test('the last of two files wins, whichever finishes first', async () => {
  const first = slowFile('first.edf', edf());
  const second = slowFile('second.edf', edf());
  drop(first);
  drop(second);
  second.release();
  await wait(0);
  first.release();
  await wait(0);
  assert.equal($('recording-name').textContent, 'second.edf');
});

test('a slow read opens the dialog so that a drop shows progress', async () => {
  const slow = slowFile('slow.edf', edf());
  assert.equal($('loader').open, false);
  drop(slow);
  await wait(200);
  assert.equal($('loader').open, true);
  assert.equal($('choose-label').textContent, 'Reading…');
  slow.release();
  await wait(0);
  assert.equal($('loader').open, false);
  assert.equal($('choose-label').textContent, 'Choose an EDF file');
});

test('marks a drag over the page and clears it on drop', async () => {
  const over = new window.Event('dragover', { cancelable: true });
  over.dataTransfer = { types: ['Files'] };
  window.dispatchEvent(over);
  assert.ok(document.body.classList.contains('dropping'));
  await open('night.edf');
  assert.ok(!document.body.classList.contains('dropping'));
});

test('sideways wheel movement scrolls time and takes the event', () => {
  press($('position'), 'Home');
  const event = new window.WheelEvent('wheel', { deltaX: 200, cancelable: true, bubbles: true });
  $('traces').dispatchEvent(event);
  assert.ok(Number($('position').value) > 0);
  assert.equal(event.defaultPrevented, true);
});
