import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import test from 'node:test';
import { buildCsv, lslCsv } from './support/csv.js';
import { buildEdf } from './support/edf.js';
import { installDom } from './support/dom.js';

const window = installDom();
const { document } = window;
await import('../js/app.js');

const $ = (id) => document.getElementById(id);
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

// For work that takes as long as the machine makes it, which no fixed wait can cover.
async function until(ready) {
  for (let tries = 0; tries < 500 && !ready(); tries += 1) await wait(10);
}

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

test('opens straight on the demo, with no dialog in the way', () => {
  assert.equal($('loader').open, false);
  assert.equal($('viewer').hidden, false);
  assert.equal($('recording-name').textContent, 'Demo (synthetic data)');
});

test('opens the demo where a blink and the eyes closing share the first screen', () => {
  assert.equal($('position-text').textContent, '0:13 to 0:23');
});

test('keeps the masthead to the logo and the name', () => {
  const masthead = document.querySelector('.masthead');
  assert.equal(masthead.textContent.trim(), 'Ventris');
  assert.equal(masthead.querySelector('a, button'), null);
});

test('leaves explanations to the help page, apart from its two promises', () => {
  assert.equal(document.querySelector('.panel-controls .note'), null);
  assert.match(document.querySelector('.loader-note').textContent, /never leave your computer/);
  assert.match(document.querySelector('.site-footer .note').textContent, /not a medical device/);
});

test('offers help, the theme switch and the GitHub link in the footer', () => {
  const area = document.querySelector('.site-footer');
  const help = area.querySelector('.help-link');
  const link = area.querySelector('.github-link');
  assert.equal(help.getAttribute('href'), 'help/');
  assert.equal(help.textContent.trim(), 'Help');
  assert.ok(area.querySelector('.theme-toggle'));
  assert.equal(link.href, 'https://github.com/ventris-tools/ventris');
  assert.equal(link.getAttribute('aria-label'), 'Ventris on GitHub');
});

test('opens help and GitHub in a new tab so that the recording stays open', () => {
  const links = document.querySelectorAll('.site-tools a');
  assert.equal(links.length, 2);
  for (const link of links) {
    assert.equal(link.target, '_blank');
    assert.equal(link.rel, 'noopener noreferrer');
  }
});

test('every icon in use is defined on the page', () => {
  const uses = [...document.querySelectorAll('use')].map((use) => use.getAttribute('href'));
  assert.ok(uses.length >= 5);
  for (const href of uses) assert.ok(document.querySelector(`symbol${href}`), href);
});

test('preloads every module, so that they arrive together rather than one layer at a time', () => {
  const links = document.querySelectorAll('link[rel="modulepreload"]');
  const preloaded = [...links].map((link) => link.getAttribute('href'));
  const modules = readdirSync(new URL('../js/', import.meta.url))
    .filter((name) => name !== 'app.js' && name !== 'theme.js')
    .map((name) => `js/${name}`);
  assert.deepEqual(preloaded.sort(), modules.sort());
});

test('the dialog opens on request and can always be closed', () => {
  $('open-recording').click();
  assert.equal($('loader').open, true);
  assert.equal($('close-loader').hidden, false);
  $('close-loader').click();
  assert.equal($('loader').open, false);
});

test('says plainly that the demo is synthetic', () => {
  assert.match($('recording-name').textContent, /synthetic data/);
  assert.match($('info-acquisition').textContent, /Synthetic/);
});

test('offers windows up to the whole file and starts at ten seconds', () => {
  const labels = [...$('window').options].map(({ text }) => text);
  assert.deepEqual(labels, ['5 s', '10 s', '30 s', 'Whole file']);
  assert.equal($('window').value, '10');
});

test('lists annotations and jumps to them', async () => {
  const buttons = [...$('annotation-list').querySelectorAll('button')];
  assert.equal($('annotations').hidden, false);
  assert.equal($('annotations').open, true);
  assert.deepEqual(
    buttons.map(({ textContent }) => textContent),
    ['0:20 Eyes closed', '0:40 Eyes open'],
  );
  assert.deepEqual(
    buttons.map(({ style }) => style.getPropertyValue('--event')),
    ['var(--event-1)', 'var(--event-2)'],
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

// A real file of this size takes jsdom minutes, so this checks the cause: the browser
// refuses a call with too many arguments, and that left the old recording on screen.
test('never passes the annotations as arguments, which a long list would overflow', async (t) => {
  const tal = (record) => `+${record}\x14\x14\0+${record}\x14Spike\x14\0`;
  const annotated = buildEdf([signal(), { label: 'EDF Annotations', samples: 32, tal }], {
    records: 30,
    reserved: 'EDF+C',
  });
  const replace = t.mock.method($('annotation-list'), 'replaceChildren');
  await open('annotated.edf', annotated);
  assert.equal(replace.mock.calls.at(-1).arguments.length, 1);
  assert.equal($('annotation-list').children.length, 30);
  $('open-recording').click();
  $('show-demo').click();
});

test('offers the demo only while something else is open', async () => {
  $('open-recording').click();
  assert.equal($('demo-offer').hidden, true);
  $('close-loader').click();
  await open('night.edf');
  $('open-recording').click();
  assert.equal($('demo-offer').hidden, false);
  $('show-demo').click();
  assert.equal($('demo-offer').hidden, true);
  assert.equal($('position-text').textContent, '0:13 to 0:23');
});

test('captions the bands and the time figures with what they cover', async () => {
  const caption = '1 to 30 Hz · 8 EEG channels';
  await until(() => $('band-note').textContent === caption);
  assert.equal($('band-note').textContent, caption);
  assert.equal($('time-note').textContent, 'Whole file · 8 EEG channels');
});

test('keeps a warning about the file in view', async () => {
  const whole = new Uint8Array(edf());
  await open('cut.edf', whole.slice(0, whole.length - 100).buffer);
  assert.equal($('recording-note').hidden, false);
  assert.match($('recording-note').textContent, /cut off/);
  $('open-recording').click();
  $('show-demo').click();
  assert.equal($('recording-note').hidden, true);
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

test('the slider moves through the recording and says where it is', () => {
  $('position').value = '25';
  $('position').dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal($('position-text').textContent, '0:25 to 0:35');
  assert.equal($('position').getAttribute('aria-valuetext'), '0:25 to 0:35');
  assert.match($('traces').getAttribute('aria-label'), /from 0:25 to 0:35/);
  press($('position'), 'Home');
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

const pointer = (type, clientX, clientY) =>
  $('traces').dispatchEvent(new window.MouseEvent(type, { clientX, clientY, bubbles: true }));

// Rows of the demo are 75 pixels high, and the plot starts well before 300 pixels in.
function dragBox([x0, y0], [x1, y1]) {
  pointer('pointerdown', x0, y0);
  pointer('pointermove', x1, y1);
  pointer('pointerup', x1, y1);
}

function slideTo(seconds) {
  $('position').value = String(seconds);
  $('position').dispatchEvent(new window.Event('input', { bubbles: true }));
}

const shownLength = () => 60 - Number($('position').max);

test('a box drawn on the traces zooms to its time and channels, and a double-click undoes it', () => {
  slideTo(20);
  dragBox([300, 80], [500, 230]);
  const label = $('traces').getAttribute('aria-label');
  assert.match(label, /^Traces for 3 of 8 channels, from 0:2\d\.\d to 0:2\d\.\d\./);
  assert.match(label, /Escape undoes the zoom/);
  assert.match($('position-text').textContent, /^0:2\d\.\d to 0:2\d\.\d$/);
  assert.ok(shownLength() < 5);
  assert.equal($('reset-zoom').hidden, false);
  assert.equal($('window').value, 'zoomed');
  assert.equal($('window').selectedOptions[0].text, 'Zoomed');

  $('traces').dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
  assert.equal($('position-text').textContent, '0:20 to 0:30');
  assert.match($('traces').getAttribute('aria-label'), /^Traces for 8 channels, from 0:20 to 0:30/);
  assert.doesNotMatch($('traces').getAttribute('aria-label'), /Escape/);
  assert.equal($('reset-zoom').hidden, true);
  assert.equal($('window').value, '10');
  assert.ok(![...$('window').options].some(({ value }) => value === 'zoomed'));
});

test('a zoom within a zoom still goes back to the window it began in', () => {
  slideTo(20);
  dragBox([300, 80], [700, 380]);
  dragBox([350, 10], [500, 12]);
  assert.match($('traces').getAttribute('aria-label'), /^Traces for 5 of 8 channels/);
  $('reset-zoom').click();
  assert.equal($('position-text').textContent, '0:20 to 0:30');
});

test('a zoom moved off its window comes back centred on what was on screen', () => {
  slideTo(20);
  dragBox([300, 100], [500, 100]);
  for (let i = 0; i < 6; i += 1) press($('traces'), 'PageUp');
  const start = Number($('position').value);
  const middle = start + shownLength() / 2;
  assert.ok(start > 30);
  assert.equal(press($('traces'), 'Escape'), false);
  assert.ok(Math.abs(Number($('position').value) + 5 - middle) < 1e-9);
  assert.equal($('reset-zoom').hidden, true);
  assert.equal(press($('traces'), 'Escape'), true);
});

test('Escape drops a drag under way before it undoes a zoom', () => {
  slideTo(20);
  dragBox([300, 100], [500, 100]);
  const zoomed = $('position-text').textContent;
  pointer('pointerdown', 300, 80);
  pointer('pointermove', 500, 380);
  press($('traces'), 'Escape');
  pointer('pointerup', 500, 380);
  assert.equal($('position-text').textContent, zoomed);
  assert.equal($('reset-zoom').hidden, false);
  press($('traces'), 'Escape');
  assert.equal($('reset-zoom').hidden, true);
});

test('choosing a window ends a zoom', () => {
  slideTo(20);
  dragBox([300, 80], [500, 230]);
  $('window').value = '30';
  $('window').dispatchEvent(new window.Event('change'));
  assert.equal(shownLength(), 30);
  assert.equal($('reset-zoom').hidden, true);
  assert.match($('traces').getAttribute('aria-label'), /^Traces for 8 channels/);
  $('window').value = '10';
  $('window').dispatchEvent(new window.Event('change'));
});

test('opening a recording ends a zoom', async () => {
  dragBox([300, 80], [500, 230]);
  await open('night.edf');
  assert.equal($('reset-zoom').hidden, true);
  assert.equal($('window').value, '10');
  assert.match(
    $('traces').getAttribute('aria-label'),
    /^Traces for 1 channel, from 0:00 to 0:10\./,
  );
  $('open-recording').click();
  $('show-demo').click();
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

test('opens a CSV file, with its markers as annotations', async () => {
  await open('S001-001_eeg.csv', lslCsv());
  assert.equal($('recording-name').textContent, 'S001-001_eeg.csv');
  assert.equal($('recording-note').hidden, true);
  assert.deepEqual(
    [...$('annotation-list').querySelectorAll('button')].map(({ textContent }) => textContent),
    ['0:01 trial_start', '0:04 move', '0:06 cue_stop'],
  );
  assert.match($('info-acquisition').textContent, /CSV/);
  assert.match($('info-acquisition').textContent, /250 Hz/);
  assert.match($('info-filters').textContent, /Unknown/);
  assert.equal($('time-note').textContent, 'Whole file · 8 EEG channels');
});

test('opens tab-separated text by its name', async () => {
  await open(
    'session.tsv',
    buildCsv(
      ['time', 'Cz'],
      [
        [0, 1],
        [0.004, 2],
      ],
      { delimiter: '\t' },
    ),
  );
  assert.equal($('recording-name').textContent, 'session.tsv');
});

test('a CSV file it cannot read says why', async () => {
  await open(
    'table.csv',
    buildCsv(
      ['Cz', 'Pz'],
      [
        [1, 2],
        [3, 4],
      ],
    ),
  );
  assert.equal($('loader').open, true);
  assert.equal(
    $('error').textContent,
    'This CSV has no time column, so its sample rate is unknown.',
  );
  assert.equal($('recording-name').textContent, 'session.tsv');
  $('close-loader').click();
});

test('a move drops the band measurement under way, so only the latest one shows', async (t) => {
  await open('pair.edf', buildEdf([signal(), { ...signal(), label: 'Pz' }], { records: 30 }));
  await wait(80);

  // A clock that races, so that measuring pauses after each channel.
  let now = 0;
  t.mock.method(performance, 'now', () => (now += 100));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const shown = t.mock.method(document.querySelector('.bar').style, 'setProperty');
  const moveSlider = (seconds) => {
    $('position').value = String(seconds);
    $('position').dispatchEvent(new window.Event('input', { bubbles: true }));
  };
  const runTimers = async () => {
    for (let i = 0; i < 8; i += 1) {
      t.mock.timers.tick(0);
      await Promise.resolve();
    }
  };

  moveSlider(5);
  t.mock.timers.tick(60);
  assert.equal(shown.mock.callCount(), 0);

  moveSlider(10);
  await runTimers();
  assert.equal(shown.mock.callCount(), 0);
  t.mock.timers.tick(60);
  await runTimers();
  assert.equal(shown.mock.callCount(), 1);
  assert.equal($('position-text').textContent, '0:10 to 0:20');
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
  assert.equal($('choose-label').textContent, 'Choose an EDF or CSV file');
});

test('a large file opens the dialog and says so before reading it holds the page', async () => {
  const big = slowFile('big.edf', new Uint8Array(16e6).buffer);
  drop(big);
  big.release();
  await wait(0);
  assert.equal($('loader').open, true);
  assert.equal($('choose-label').textContent, 'Opening…');
  await until(() => !$('error').hidden);
  assert.equal($('error').textContent, 'This does not look like an EDF file.');
  assert.equal($('choose-label').textContent, 'Choose an EDF or CSV file');
  $('close-loader').click();
});

test('closing the dialog gives up on a file still being read', async () => {
  const before = $('recording-name').textContent;
  const slow = slowFile('abandoned.edf', edf());
  drop(slow);
  await wait(200);
  assert.equal($('loader').open, true);
  $('close-loader').click();
  assert.equal($('choose-file').disabled, false);
  assert.equal($('choose-label').textContent, 'Choose an EDF or CSV file');
  slow.release();
  await wait(0);
  await wait(0);
  assert.equal($('recording-name').textContent, before);
});

test('the file picker offers every file, since EDF files turn up under many names', () => {
  assert.equal($('file-input').hasAttribute('accept'), false);
});

test('the link field takes an address written without https://', () => {
  const input = $('link-input');
  input.value = 'github.com/nemarDatasets/on003194/blob/main/sub-01/eeg/sub-01_eeg.edf';
  assert.equal(input.checkValidity(), true);
  input.value = '';
  assert.equal(input.checkValidity(), false);
});

test('marks a drag over the page and clears it on drop', async () => {
  const over = new window.Event('dragover', { cancelable: true });
  over.dataTransfer = { types: ['Files'] };
  window.dispatchEvent(over);
  assert.ok(document.body.classList.contains('dropping'));
  await open('night.edf');
  assert.ok(!document.body.classList.contains('dropping'));
});

test('clears the mark when a drag leaves the window, but not when it moves within it', () => {
  const dragOver = new window.Event('dragover', { cancelable: true });
  dragOver.dataTransfer = { types: ['Files'] };
  window.dispatchEvent(dragOver);
  const dragLeave = (relatedTarget) => {
    const event = new window.Event('dragleave');
    event.relatedTarget = relatedTarget;
    window.dispatchEvent(event);
  };
  dragLeave(document.body);
  assert.ok(document.body.classList.contains('dropping'));
  dragLeave(null);
  assert.ok(!document.body.classList.contains('dropping'));
});

test('opens the file chosen in the dialog, and lets the same file be chosen again', async () => {
  const input = $('file-input');
  Object.defineProperty(input, 'files', {
    value: [fileOf('chosen.edf', edf())],
    configurable: true,
  });
  input.dispatchEvent(new window.Event('change'));
  await wait(0);
  await wait(0);
  assert.equal($('recording-name').textContent, 'chosen.edf');
  assert.equal(input.value, '');
});

test('closing the file picker without a choice changes nothing', () => {
  const input = $('file-input');
  Object.defineProperty(input, 'files', { value: [], configurable: true });
  input.dispatchEvent(new window.Event('change'));
  assert.equal($('recording-name').textContent, 'chosen.edf');
});

test('sideways wheel movement scrolls time and takes the event', () => {
  press($('position'), 'Home');
  const event = new window.WheelEvent('wheel', { deltaX: 200, cancelable: true, bubbles: true });
  $('traces').dispatchEvent(event);
  assert.ok(Number($('position').value) > 0);
  assert.equal(event.defaultPrevented, true);
});
