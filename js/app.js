import { demoRecording } from './demo.js';
import { BANDS, bandShares, timeStats } from './dsp.js';
import { EdfError, parseEdf } from './edf.js';
import { infoGroups, timeRows, unitLabel } from './info.js';
import { formatClock, sidewaysPixels, TraceView } from './traces.js';

const WINDOW_CHOICES = [5, 10, 30, 60];
const GAIN_STEP = 1.4;
const GAIN_LIMITS = [0.2, 12];
const DEMO_NAME = 'recording.edf';

const $ = (id) => document.getElementById(id);
const openButton = $('open-recording');
const viewer = $('viewer');
const loader = $('loader');
const closeButton = $('close-loader');
const chooseButton = $('choose-file');
const chooseLabel = $('choose-label');
const demoButton = $('show-demo');
const fileInput = $('file-input');
const errorBox = $('error');
const nameHeading = $('recording-name');
const noteLine = $('recording-note');
const canvas = $('traces');
const position = $('position');
const positionText = $('position-text');
const windowSelect = $('window');
const readout = $('readout');
const bandBody = $('band-rows');
const bandNote = $('band-note');

const state = { recording: null, start: 0, length: 10, gain: 1 };
let bandTimer = 0;

function showHover(hit) {
  if (!hit) {
    readout.textContent = '';
    return;
  }
  const value = `${hit.value.toFixed(1)} ${unitLabel(hit.channel.unit)}`.trim();
  readout.textContent = `${hit.time.toFixed(2)} s · ${hit.channel.label} · ${value}`;
}

// Sideways scrolling moves through time, one pixel of trace per pixel scrolled.
function scrollTime(pixels) {
  const { recording, start, length } = state;
  const latest = Math.max(0, recording.duration - length);
  const next = Math.min(latest, Math.max(0, start + view.secondsFor(pixels)));
  if (next === start) return;
  state.start = next;
  position.value = String(next);
  refresh();
}

const view = new TraceView(canvas, showHover, scrollTime);

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

const channelCount = (count) => `${count} EEG ${count === 1 ? 'channel' : 'channels'}`;

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
    ? `Whole recording, across ${channelCount(stats.channels)}.`
    : 'This recording has no EEG channels to measure.';
}

function updateBands() {
  const { recording, start, length } = state;
  const result = bandShares(recording.channels, start, length);
  bandRows.forEach(({ name, row, bar, value }, index) => {
    const share = result ? result.shares[index] : 0;
    bar.style.setProperty('--share', share.toFixed(4));
    value.textContent = result ? `${Math.round(share * 100)}%` : '–';
    row.title = result ? `${name}: ${(share * 100).toFixed(1)}% of 1 to 30 Hz power` : '';
  });
  if (result) {
    bandNote.textContent = `Share of 1 to 30 Hz power in this window, averaged over ${channelCount(result.channels)}.`;
  } else {
    bandNote.textContent = 'No EEG channels here have a high enough sample rate to measure bands.';
  }
}

function refresh() {
  const { recording, start, length, gain } = state;
  const end = Math.min(recording.duration, start + length);
  const text = `${formatClock(start)} to ${formatClock(end)}`;
  positionText.textContent = text;
  position.setAttribute('aria-valuetext', text);
  canvas.setAttribute(
    'aria-label',
    `EEG traces for ${recording.channels.length} channels, from ${text}. Band shares are in the table.`,
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

function show(recording, name) {
  state.recording = recording;
  viewer.hidden = false;
  state.start = 0;
  state.gain = 1;
  nameHeading.textContent = name;
  showDetails(recording);
  noteLine.textContent = recording.warnings.join(' ');
  noteLine.hidden = recording.warnings.length === 0;

  windowSelect.replaceChildren();
  const choices = WINDOW_CHOICES.filter((seconds) => seconds < recording.duration);
  for (const seconds of [...choices, recording.duration].slice(0, WINDOW_CHOICES.length)) {
    const option = new Option(`${formatWindow(seconds)}`, String(seconds));
    windowSelect.append(option);
  }
  const preferred = Math.min(10, recording.duration);
  windowSelect.value = String(preferred);
  view.setRecording(recording);
  setWindow(preferred);
}

function formatWindow(seconds) {
  return seconds < 120 ? `${Math.round(seconds * 10) / 10} s` : formatClock(seconds);
}

function setError(message) {
  errorBox.textContent = message;
  errorBox.hidden = !message;
}

function openLoader() {
  closeButton.hidden = !state.recording;
  if (!loader.open) loader.showModal();
}

async function openFile(file) {
  setError('');
  chooseButton.disabled = true;
  chooseLabel.textContent = 'Reading…';
  try {
    show(parseEdf(await file.arrayBuffer()), file.name);
    loader.close();
  } catch (error) {
    openLoader();
    setError(
      error instanceof EdfError
        ? error.message
        : `${file.name} could not be opened. It may be too large for this browser.`,
    );
  } finally {
    chooseButton.disabled = false;
    chooseLabel.textContent = 'Choose an EDF file';
  }
}

openButton.addEventListener('click', () => {
  setError('');
  openLoader();
});
closeButton.addEventListener('click', () => loader.close());
// Until something is open there is nothing to go back to, so the dialog stays.
loader.addEventListener('close', () => {
  if (!state.recording) openLoader();
});
chooseButton.addEventListener('click', () => fileInput.click());
demoButton.addEventListener('click', () => {
  setError('');
  show(demoRecording(), DEMO_NAME);
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

canvas.closest('.trace-panel').addEventListener(
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
  refresh();
}
$('gain-down').addEventListener('click', () => changeGain(1 / GAIN_STEP));
$('gain-up').addEventListener('click', () => changeGain(GAIN_STEP));

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

openLoader();
