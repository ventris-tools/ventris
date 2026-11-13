import { CsvError, parseCsv } from './csv.js';
import { DEMO_START, demoRecording } from './demo.js';
import { BAND_RANGE, BANDS, bandShares, timeStats } from './dsp.js';
import { EdfError, parseEdf } from './edf.js';
import { amount, count, decimalsFor, formatClock } from './format.js';
import { infoGroups, timeRows } from './info.js';
import {
  clamp,
  eventColors,
  GAIN_LIMITS,
  sidewaysPixels,
  TraceView,
  windowChoices,
} from './traces.js';

const PREFERRED_WINDOW = 10;
const GAIN_STEP = 1.4;
const DEMO_NAME = 'Demo (synthetic data)';
const CHOOSE = 'Choose an EDF or CSV file';

// EDF files turn up under many names, so only a name that says text picks the CSV reader.
const TEXT_FILE = /\.(?:csv|tsv|txt)$/i;

// A file that takes longer than this to read shows the dialog, so a drop gets a response.
const PROGRESS_DELAY = 150;

// How long measuring bands can hold the page before it lets a frame through, in milliseconds.
const BAND_SLICE = 10;

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
const fileInput = $('file-input');
const errorBox = $('error');
const nameHeading = $('recording-name');
const noteLine = $('recording-note');
const canvas = $('traces');
const tracePanel = canvas.closest('.trace-panel');
const position = $('position');
const positionText = $('position-text');
const windowSelect = $('window');
const resetButton = $('reset-zoom');
const gainDown = $('gain-down');
const gainUp = $('gain-up');
const readout = $('readout');
const cursorStatus = $('cursor-status');
const bandBody = $('band-rows');
const bandNote = $('band-note');
const annotationSection = $('annotations');
const annotationList = $('annotation-list');

// The window is the length chosen in the list, and length is how much is on screen, which a
// zoom shortens. Rows are the channels a zoom keeps, or null for all of them. A zoom keeps
// where its window started, to go back to.
const state = {
  recording: null,
  start: 0,
  length: PREFERRED_WINDOW,
  window: PREFERRED_WINDOW,
  rows: null,
  zoom: null,
  gain: 1,
};
let bandTimer = 0;
let bandRun = 0;
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

const latestStart = () => Math.max(0, state.recording.duration - state.length);

function moveTo(time) {
  const next = clamp(time, 0, latestStart());
  if (next === state.start) return;
  state.start = next;
  position.value = String(next);
  refresh();
}

// Sideways scrolling moves through time, one pixel of trace per pixel scrolled.
const scrollTime = (pixels) => moveTo(state.start + view.secondsFor(pixels));

// A box drawn on the traces zooms to the time and the channels inside it.
function zoomTo(span, rows) {
  state.zoom ??= { home: state.start };
  if (span) {
    state.start = span.start;
    state.length = span.length;
  }
  if (rows) state.rows = rows;
  fitSlider();
}

const view = new TraceView(canvas, $('axis'), showHover, scrollTime, zoomTo);

// The list shows this while zoomed. It can't be chosen, so choosing any window ends the zoom.
const zoomOption = new Option('Zoomed', 'zoomed');
zoomOption.disabled = true;

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
    ? `Whole file · ${count(stats.channels, 'EEG channel')}`
    : BAND_PROBLEMS['no-eeg'];
}

function annotationButton({ time, text }, color) {
  const item = document.createElement('li');
  const button = document.createElement('button');
  const when = document.createElement('span');
  button.type = 'button';
  // The same colour as its marker on the traces, so the list doubles as their key.
  button.style.setProperty('--event', `var(${color})`);
  when.textContent = formatClock(time, Number.isInteger(time) ? 0 : 1);
  button.append(when, ` ${text}`);
  // A little of what came before stays in view.
  button.addEventListener('click', () => moveTo(time - state.length / 10));
  item.append(button);
  return item;
}

function showAnnotations({ annotations }) {
  annotationSection.hidden = annotations.length === 0;
  // One at a time, because a recording can hold more of them than a call can take arguments.
  const items = document.createDocumentFragment();
  const colors = eventColors(annotations);
  annotations.forEach((annotation, index) => {
    items.append(annotationButton(annotation, colors[index]));
  });
  annotationList.replaceChildren(items);
}

function showBands({ shares, channels, reason }) {
  bandRows.forEach(({ name, row, bar, value }, index) => {
    const share = shares ? shares[index] : 0;
    bar.hidden = !shares;
    bar.style.setProperty('--share', share.toFixed(4));
    value.textContent = shares ? `${Math.round(share * 100)}%` : '–';
    row.title = shares ? `${name}: ${(share * 100).toFixed(1)}% of ${BAND_RANGE} power` : '';
  });
  bandNote.textContent = shares
    ? `${BAND_RANGE} · ${count(channels, 'EEG channel')}`
    : BAND_PROBLEMS[reason];
}

// Keeps the page responsive however long the window is, and gives up if the view moves on.
async function updateBands() {
  const run = bandRun;
  const { recording, start, length } = state;
  const steps = bandShares(recording.channels, start, length);
  let sliceStart = performance.now();
  let step = steps.next();
  while (!step.done) {
    if (performance.now() - sliceStart > BAND_SLICE) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (run !== bandRun) return;
      sliceStart = performance.now();
    }
    step = steps.next();
  }
  showBands(step.value);
}

function showZoom() {
  const zoomed = state.zoom !== null;
  resetButton.hidden = !zoomed;
  if (zoomed) windowSelect.add(zoomOption);
  else zoomOption.remove();
  windowSelect.value = zoomed ? zoomOption.value : String(state.window);
}

function refresh() {
  const { recording, start, length, gain, rows, zoom } = state;
  const end = Math.min(recording.duration, start + length);
  // A short zoom needs tenths of a second to say where it is.
  const decimals = zoom && length < 60 ? 1 : 0;
  const text = `${formatClock(start, decimals)} to ${formatClock(end, decimals)}`;
  const total = count(recording.channels.length, 'channel');
  const shown = rows ? `${rows.count} of ${total}` : total;
  const undo = zoom ? ' Escape undoes the zoom.' : '';
  positionText.textContent = text;
  position.setAttribute('aria-valuetext', text);
  canvas.setAttribute(
    'aria-label',
    `Traces for ${shown}, from ${text}. Arrow keys read values, and Page Up and Page Down move a window at a time.${undo} Band shares are in the table.`,
  );
  showZoom();
  view.setView(start, length, gain, rows);
  clearTimeout(bandTimer);
  bandRun += 1;
  bandTimer = setTimeout(updateBands, 60);
}

// Fits the slider to how much is on screen, and the view to the recording.
function fitSlider() {
  const latest = latestStart();
  state.start = clamp(state.start, 0, latest);
  position.max = String(latest);
  position.disabled = latest === 0;
  position.value = String(state.start);
  refresh();
}

// Shows a window of the chosen length with every channel, which ends any zoom. Coming out of
// a zoom, that's the window the zoom began in, unless the view has since moved off it, when
// the window centres on what was on screen.
function setWindow(seconds) {
  const { recording, start, length, zoom } = state;
  state.window = Math.min(seconds, recording.duration);
  if (zoom) {
    const inside = start >= zoom.home && start + length <= zoom.home + state.window;
    state.start = inside ? zoom.home : start + (length - state.window) / 2;
  }
  Object.assign(state, { length: state.window, rows: null, zoom: null });
  fitSlider();
}

function resetZoom() {
  if (state.zoom) setWindow(state.window);
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
  Object.assign(state, { recording, start, gain: 1, rows: null, zoom: null });
  viewer.hidden = false;
  demoOffer.hidden = recording.format === 'Synthetic';
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
  chooseLabel.textContent = CHOOSE;
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
    const parse = TEXT_FILE.test(file.name) ? parseCsv : parseEdf;
    show(parse(buffer), file.name);
    loader.close();
  } catch (error) {
    if (request !== openRequest) return;
    openLoader();
    setError(
      error instanceof EdfError || error instanceof CsvError
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
resetButton.addEventListener('click', resetZoom);
canvas.addEventListener('dblclick', resetZoom);

// Page keys follow the slider convention, where Page Up means later. The canvas keeps the
// arrow keys for its cursor, so on the slider alone they step a tenth of a window. Escape
// undoes a zoom, once the canvas has let go of any drag under way.
tracePanel.addEventListener('keydown', (event) => {
  const { recording, start, length } = state;
  if (!recording || event.defaultPrevented) return;
  if (event.key === 'Escape' && state.zoom) {
    event.preventDefault();
    resetZoom();
    return;
  }
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
  state.gain = clamp(state.gain * factor, ...GAIN_LIMITS);
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
