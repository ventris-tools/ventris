import { CsvError, parseCsv } from './csv.js';
import { DEMO_START, demoRecording } from './demo.js';
import { BAND_RANGE, BANDS, bandShares, timeStats } from './dsp.js';
import { EdfError, parseEdf } from './edf.js';
import { amount, count, decimalsFor, downloadProgress, formatClock } from './format.js';
import { infoGroups, timeRows } from './info.js';
import { download, LinkError, resolveLink } from './remote.js';
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

// EDF files turn up under many names, so only a name that says text picks the CSV reader.
const TEXT_FILE = /\.(?:csv|tsv|txt)$/i;

// A recording opened by link is named after this in the address, so the page can be shared.
const LINK_MARK = '#url=';

// A file that takes longer than this to read shows the dialog, so a drop gets a response.
const PROGRESS_DELAY = 150;

// A file at least this large, in bytes, takes long enough to open that the dialog says so first.
const PAINT_FIRST = 16e6;

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
// What the file button says when it isn't busy, in the page's own words.
const CHOOSE = chooseLabel.textContent;
const demoButton = $('show-demo');
const demoOffer = $('demo-offer');
const fileInput = $('file-input');
const linkForm = $('link-form');
const linkInput = $('link-input');
const linkButton = $('open-link');
const linkStatus = $('link-status');
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
const timeSection = $('time-domain');
const timeList = $('time-rows');
const timeNote = $('time-note');

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
// What the band shares were last measured over, so that a change of trace size or of the
// rows in view measures nothing again.
let measured = {};
// The recording whose time figures are shown, if any.
let timed = null;
let progressTimer = 0;
let openRequest = 0;
let opening = false;
let downloading = null;

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
  timed = null;
  fillRows(timeList, []);
  timeNote.textContent = '';
  showTimes();
}

// The time figures read every sample in the file, which holds the page for a long recording,
// and their section starts closed, so they wait until it's open.
function showTimes() {
  const { recording } = state;
  if (!timeSection.open || timed === recording) return;
  timed = recording;
  const stats = timeStats(recording.channels);
  fillRows(timeList, stats ? timeRows(stats) : []);
  timeNote.textContent = stats
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

function showAnnotations({ annotations }, colors) {
  annotationSection.hidden = annotations.length === 0;
  // One at a time, because a recording can hold more of them than a call can take arguments.
  const items = document.createDocumentFragment();
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
  // Bands depend only on the recording and the stretch of it on screen.
  if (measured.recording === recording && measured.start === start && measured.length === length) {
    return;
  }
  measured = { recording, start, length };
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
  const colors = eventColors(recording.annotations);
  showAnnotations(recording, colors);
  noteLine.textContent = recording.warnings.join(' ');
  noteLine.hidden = recording.warnings.length === 0;
  view.setRecording(recording, colors);

  // The longest windows depend on how many rows fit on screen, as measured now.
  const choices = windowChoices(recording, view.rowsDrawn());
  windowSelect.replaceChildren(
    ...choices.map(
      (seconds) => new Option(formatWindow(seconds, recording.duration), String(seconds)),
    ),
  );
  const preferred = choices.findLast((seconds) => seconds <= PREFERRED_WINDOW) ?? choices[0];
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
  opening = false;
  downloading = null;
  chooseButton.disabled = false;
  chooseLabel.textContent = CHOOSE;
  linkButton.disabled = false;
  linkStatus.hidden = true;
}

// Each new recording to open stops the one before, and its download if it has one.
function beginOpening() {
  openRequest += 1;
  clearTimeout(progressTimer);
  downloading?.abort();
  downloading = null;
  setError('');
  return openRequest;
}

function opened(recording, name, link) {
  stopReading();
  show(recording, name);
  setAddress(link);
  loader.close();
}

function failed(message) {
  stopReading();
  openLoader();
  setError(message);
}

// Reading a large file holds the page, so the dialog says so and gets a frame to show it.
async function paintFirst(buffer, status) {
  if (buffer.byteLength < PAINT_FIRST) return;
  openLoader();
  status.textContent = 'Opening…';
  await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

function linkInAddress() {
  const { hash } = new URL(document.URL);
  if (!hash.startsWith(LINK_MARK)) return '';
  const link = hash.slice(LINK_MARK.length);
  if (!/^https?%3A/i.test(link)) return link;
  try {
    return decodeURIComponent(link);
  } catch {
    return link;
  }
}

// The address names a recording opened by link, and nothing once something else is open.
function setAddress(link) {
  const url = new URL(document.URL);
  url.hash = link ? `${LINK_MARK}${link}` : '';
  history.replaceState(null, '', url.href);
}

// Reading can take a while, so whatever was opened last is what stays on screen.
async function openFile(file) {
  const request = beginOpening();
  opening = true;
  chooseButton.disabled = true;
  chooseLabel.textContent = 'Reading…';
  progressTimer = setTimeout(openLoader, PROGRESS_DELAY);
  try {
    const buffer = await file.arrayBuffer();
    if (request !== openRequest) return;
    await paintFirst(buffer, chooseLabel);
    if (request !== openRequest) return;
    const parse = TEXT_FILE.test(file.name) ? parseCsv : parseEdf;
    opened(parse(buffer), file.name, '');
  } catch (error) {
    if (request !== openRequest) return;
    failed(
      error instanceof EdfError || error instanceof CsvError
        ? error.message
        : `${file.name} could not be opened. It may be too large for this browser.`,
    );
  }
}

// A download takes longer than reading a file, so the dialog stays open to show its progress.
// A link that can't be opened still stops the download before it, as any new one does.
async function openLink(text) {
  const request = beginOpening();
  let target;
  try {
    target = resolveLink(text);
  } catch (error) {
    failed(error.message);
    return;
  }
  const controller = new AbortController();
  downloading = controller;
  opening = true;
  linkInput.value = target.link;
  linkButton.disabled = true;
  linkStatus.textContent = 'Downloading…';
  linkStatus.hidden = false;
  openLoader();
  try {
    const buffer = await download(target, {
      signal: controller.signal,
      onProgress: (done, total) => {
        linkStatus.textContent = `Downloading ${downloadProgress(done, total)}`;
      },
    });
    if (request !== openRequest) return;
    await paintFirst(buffer, linkStatus);
    if (request !== openRequest) return;
    opened(parseEdf(buffer), target.name, target.link);
  } catch (error) {
    if (request !== openRequest) return;
    failed(
      error instanceof LinkError || error instanceof EdfError
        ? error.message
        : `${target.name} could not be opened. It may be too large for this browser.`,
    );
  }
}

openButton.addEventListener('click', () => {
  setError('');
  openLoader();
});
closeButton.addEventListener('click', () => loader.close());
// Closing the dialog, with its button or Escape, gives up on whatever it was opening.
loader.addEventListener('close', () => {
  if (!opening) return;
  beginOpening();
  stopReading();
});
chooseButton.addEventListener('click', () => fileInput.click());
demoButton.addEventListener('click', () => {
  beginOpening();
  stopReading();
  showDemo();
  setAddress('');
  loader.close();
});
linkForm.addEventListener('submit', (event) => {
  event.preventDefault();
  openLink(linkInput.value);
});
window.addEventListener('hashchange', () => {
  const link = linkInAddress();
  if (link) openLink(link);
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
timeSection.addEventListener('toggle', showTimes);
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
const startingLink = linkInAddress();
if (startingLink) openLink(startingLink);

// A canvas measures and draws in whatever font it has, so measure and redraw once the real
// one arrives.
document.fonts.ready.then(() => view.remeasure());
