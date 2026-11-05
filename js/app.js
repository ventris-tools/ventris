import { DEMO_START, demoRecording } from './demo.js';
import { BAND_RANGE, BANDS, bandShares, timeStats } from './dsp.js';
import { EdfError, parseEdf } from './edf.js';
import { amount, count, decimalsFor, formatClock } from './format.js';
import { infoGroups, timeRows } from './info.js';
import { GAIN_LIMITS, sidewaysPixels, TraceView, windowChoices } from './traces.js';

const PREFERRED_WINDOW = 10;
const GAIN_STEP = 1.4;
const DEMO_NAME = 'Demo (synthetic data)';

// A file that takes longer than this to read shows the dialog, so a drop gets a response.
const PROGRESS_DELAY = 150;

const BAND_PROBLEMS = {
  'no-eeg': 'This recording has no EEG channels to measure.',
  slow: 'No EEG channels here have a high enough sample rate to measure bands.',
  short: 'This window is too short to measure bands.',
  flat: 'The EEG channels are flat in this window.',
};

const $ = (id) => document.getElementById(id);
const openButton = $('open-recording');
const viewer = $('viewer');
const loader = $('loader');
const closeButton = $('close-loader');
const chooseButton = $('choose-file');
const chooseLabel = $('choose-label');
const demoButton = $('show-demo');
const demoOffer = $('demo-offer');
const demoFlag = $('demo-flag');
const fileInput = $('file-input');
const errorBox = $('error');
const nameHeading = $('recording-name');
const noteLine = $('recording-note');
const canvas = $('traces');
const tracePanel = canvas.closest('.trace-panel');
const position = $('position');
const positionText = $('position-text');
const windowSelect = $('window');
const gainDown = $('gain-down');
const gainUp = $('gain-up');
const readout = $('readout');
const cursorStatus = $('cursor-status');
const bandBody = $('band-rows');
const bandNote = $('band-note');
const annotationSection = $('annotations');
const annotationList = $('annotation-list');

const state = { recording: null, start: 0, length: PREFERRED_WINDOW, gain: 1 };
let bandTimer = 0;
let progressTimer = 0;
let openRequest = 0;

function showHover(hit, announce = false) {
  if (!hit) {
    readout.textContent = '';
    cursorStatus.textContent = '';
    return;
  }
  const { time, channel, value, spread } = hit;
  const reading = amount(value, channel.unit, decimalsFor(4 * spread));
  const text = `${formatClock(time, 2)} · ${channel.label} · ${reading}`;
  readout.textContent = text;
  if (announce) cursorStatus.textContent = text;
}

function moveTo(time) {
  const { recording, start, length } = state;
  const latest = Math.max(0, recording.duration - length);
  const next = Math.min(latest, Math.max(0, time));
  if (next === start) return;
  state.start = next;
  position.value = String(next);
  refresh();
}

// Sideways scrolling moves through time, one pixel of trace per pixel scrolled.
const scrollTime = (pixels) => moveTo(state.start + view.secondsFor(pixels));

const view = new TraceView(canvas, $('axis'), showHover, scrollTime);

const bandRows = BANDS.map(({ name, low, high }) => {
  const row = document.createElement('tr');
  const header = document.createElement('th');
  const range = document.createElement('span');
  const barCell = document.createElement('td');
  const bar = document.createElement('span');
  const valueCell = document.createElement('td');

  header.scope = 'row';
  header.textContent = name;
  range.textContent = `${low} to ${high} Hz`;
  header.append(range);
  barCell.className = 'bar-cell';
  bar.className = 'bar';
  barCell.append(bar);
  valueCell.className = 'value';
  row.append(header, barCell, valueCell);
  bandBody.append(row);
  return { name, row, bar, value: valueCell };
});

function fillRows(list, rows) {
  list.replaceChildren(
    ...rows.map(([label, value]) => {
      const row = document.createElement('div');
      const term = document.createElement('dt');
      const detail = document.createElement('dd');
      term.textContent = label;
      detail.textContent = value;
      row.append(term, detail);
      return row;
    }),
  );
}

function showDetails(recording) {
  const { general, acquisition, channels, filters } = infoGroups(recording);
  fillRows($('info-general'), general);
  fillRows($('info-acquisition'), acquisition);
  fillRows($('info-channels'), channels);
  fillRows($('info-filters'), filters);
  $('channel-names').textContent = recording.channels.map(({ label }) => label).join(', ');

  const stats = timeStats(recording.channels);
  fillRows($('time-rows'), stats ? timeRows(stats) : []);
  $('time-note').textContent = stats
    ? `Whole recording, across ${count(stats.channels, 'EEG channel')}.`
    : BAND_PROBLEMS['no-eeg'];
}

function annotationButton({ time, text }) {
  const item = document.createElement('li');
  const button = document.createElement('button');
  const when = document.createElement('span');
  button.type = 'button';
  when.textContent = formatClock(time, Number.isInteger(time) ? 0 : 1);
  button.append(when, ` ${text}`);
  // A little of what came before stays in view.
  button.addEventListener('click', () => moveTo(time - state.length / 10));
  item.append(button);
  return item;
}

function showAnnotations({ annotations }) {
  annotationSection.hidden = annotations.length === 0;
  annotationList.replaceChildren(...annotations.map(annotationButton));
}

function updateBands() {
  const { recording, start, length } = state;
  const { shares, channels, reason } = bandShares(recording.channels, start, length);
  bandRows.forEach(({ name, row, bar, value }, index) => {
    const share = shares ? shares[index] : 0;
    bar.hidden = !shares;
    bar.style.setProperty('--share', share.toFixed(4));
    value.textContent = shares ? `${Math.round(share * 100)}%` : '–';
    row.title = shares ? `${name}: ${(share * 100).toFixed(1)}% of ${BAND_RANGE} power` : '';
  });
  bandNote.textContent = shares
    ? `Share of ${BAND_RANGE} power in this window, averaged over ${count(channels, 'EEG channel')}.`
    : BAND_PROBLEMS[reason];
}

function refresh() {
  const { recording, start, length, gain } = state;
  const end = Math.min(recording.duration, start + length);
  const text = `${formatClock(start)} to ${formatClock(end)}`;
  positionText.textContent = text;
  position.setAttribute('aria-valuetext', text);
  canvas.setAttribute(
    'aria-label',
    `Traces for ${count(recording.channels.length, 'channel')}, from ${text}. Arrow keys read values, and Page Up and Page Down move a window at a time. Band shares are in the table.`,
  );
  view.setView(start, length, gain);
  clearTimeout(bandTimer);
  bandTimer = setTimeout(updateBands, 60);
}

function setWindow(seconds) {
  const { recording } = state;
  state.length = Math.min(seconds, recording.duration);
  const latest = Math.max(0, recording.duration - state.length);
  state.start = Math.min(state.start, latest);
  position.max = String(latest);
  position.disabled = latest === 0;
  position.value = String(state.start);
  refresh();
}

function updateGainButtons() {
  const [lowest, highest] = GAIN_LIMITS;
  gainDown.disabled = state.gain <= lowest;
  gainUp.disabled = state.gain >= highest;
}

function formatWindow(seconds, duration) {
  if (seconds === duration) return 'Whole file';
  return seconds < 120 ? `${seconds} s` : formatClock(seconds);
}

function show(recording, name, start = 0) {
  state.recording = recording;
  viewer.hidden = false;
  state.start = start;
  state.gain = 1;
  demoFlag.hidden = recording.format !== 'Synthetic';
  demoOffer.hidden = !demoFlag.hidden;
  updateGainButtons();
  nameHeading.textContent = name;
  showDetails(recording);
  showAnnotations(recording);
  noteLine.textContent = recording.warnings.join(' ');
  noteLine.hidden = recording.warnings.length === 0;

  const choices = windowChoices(recording);
  windowSelect.replaceChildren(
    ...choices.map(
      (seconds) => new Option(formatWindow(seconds, recording.duration), String(seconds)),
    ),
  );
  const preferred = choices.findLast((seconds) => seconds <= PREFERRED_WINDOW) ?? choices[0];
  windowSelect.value = String(preferred);
  view.setRecording(recording);
  setWindow(preferred);
}

function showDemo() {
  show(demoRecording(), DEMO_NAME, DEMO_START);
}

function setError(message) {
  errorBox.textContent = message;
  errorBox.hidden = !message;
}

function openLoader() {
  if (!loader.open) loader.showModal();
}

function stopReading() {
  clearTimeout(progressTimer);
  chooseButton.disabled = false;
  chooseLabel.textContent = 'Choose an EDF file';
}

// Reading can take a while, so whatever was opened last is what stays on screen.
async function openFile(file) {
  openRequest += 1;
  const request = openRequest;
  setError('');
  chooseButton.disabled = true;
  chooseLabel.textContent = 'Reading…';
  clearTimeout(progressTimer);
  progressTimer = setTimeout(openLoader, PROGRESS_DELAY);
  try {
    const buffer = await file.arrayBuffer();
    if (request !== openRequest) return;
    show(parseEdf(buffer), file.name);
    loader.close();
  } catch (error) {
    if (request !== openRequest) return;
    openLoader();
    setError(
      error instanceof EdfError
        ? error.message
        : `${file.name} could not be opened. It may be too large for this browser.`,
    );
  } finally {
    if (request === openRequest) stopReading();
  }
}

openButton.addEventListener('click', () => {
  setError('');
  openLoader();
});
closeButton.addEventListener('click', () => loader.close());
chooseButton.addEventListener('click', () => fileInput.click());
demoButton.addEventListener('click', () => {
  openRequest += 1;
  stopReading();
  setError('');
  showDemo();
  loader.close();
});
fileInput.addEventListener('change', () => {
  const [file] = fileInput.files;
  if (file) openFile(file);
  fileInput.value = '';
});

position.addEventListener('input', () => {
  state.start = Number(position.value);
  refresh();
});
windowSelect.addEventListener('change', () => setWindow(Number(windowSelect.value)));

// Page keys follow the slider convention, where Page Up means later. The canvas keeps the
// arrow keys for its cursor, so on the slider alone they step a tenth of a window.
tracePanel.addEventListener('keydown', (event) => {
  const { recording, start, length } = state;
  if (!recording) return;
  const nudge = length / 10;
  const slider = event.target === position;
  const targets = {
    PageUp: start + length,
    PageDown: start - length,
    Home: 0,
    End: recording.duration,
    ...(slider && {
      ArrowRight: start + nudge,
      ArrowUp: start + nudge,
      ArrowLeft: start - nudge,
      ArrowDown: start - nudge,
    }),
  };
  if (!(event.key in targets)) return;
  event.preventDefault();
  moveTo(targets[event.key]);
});

tracePanel.addEventListener(
  'wheel',
  (event) => {
    const pixels = sidewaysPixels(event, canvas.clientWidth);
    if (pixels === 0) return;
    // Left alone, a two-finger swipe can send the browser back and lose the recording.
    if (event.cancelable) event.preventDefault();
    scrollTime(pixels);
  },
  { passive: false },
);

function changeGain(factor) {
  const [lowest, highest] = GAIN_LIMITS;
  state.gain = Math.min(highest, Math.max(lowest, state.gain * factor));
  updateGainButtons();
  refresh();
}
gainDown.addEventListener('click', () => changeGain(1 / GAIN_STEP));
gainUp.addEventListener('click', () => changeGain(GAIN_STEP));

const hasFiles = (event) => event.dataTransfer?.types.includes('Files');
window.addEventListener('dragover', (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  document.body.classList.add('dropping');
});
window.addEventListener('dragleave', (event) => {
  if (event.relatedTarget === null) document.body.classList.remove('dropping');
});
window.addEventListener('drop', (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  document.body.classList.remove('dropping');
  const [file] = event.dataTransfer.files;
  if (file) openFile(file);
});

showDemo();

// A canvas keeps whatever font it was drawn with, so redraw once the real one arrives.
document.fonts.ready.then(() => view.resize());
