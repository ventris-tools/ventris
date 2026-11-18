import { DEMO_START, demoRecording } from './demo.js';
import { BAND_RANGE, BANDS, bandShares, timeStats } from './dsp.js';
import { filterRecording } from './filters.js';
import { amount, count, decimalsFor, downloadProgress, formatClock } from './format.js';
import { infoGroups, timeRows } from './info.js';
import { download, LinkError, resolveLink } from './remote.js';
import { describe, isOff, record, redo, startHistory, STEPS, undo } from './steps.js';
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

// A file that takes longer than this to read and open shows the dialog, so a drop gets a
// response.
const PROGRESS_DELAY = 150;

// How long measuring bands can hold the page before it lets a frame through, in milliseconds.
const BAND_SLICE = 10;

// How long filtering can hold the page before it lets a frame through. Longer than for bands,
// since every pause costs a few milliseconds of its own.
const FILTER_SLICE = 20;

const FILTER_PROBLEMS = {
  large: 'too long to filter here',
  memory: 'out of memory to filter',
};

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
const filterChoices = $('filter-choices');
const rawButton = $('show-raw');
const filterStatus = $('filter-status');

// The window is the length chosen in the list, and length is how much is on screen, which a
// zoom shortens. Rows are the channels a zoom keeps, or null for all of them. A zoom keeps
// where its window started, to go back to.
//
// filters is the history of the display filter's settings, which carries over to the next
// recording. processed is the recording filtered with them, once it's ready, and raw says the
// reader has asked to see the samples as recorded instead. untouched counts the channels a
// filter leaves alone, and problem says why a recording couldn't be filtered.
const state = {
  recording: null,
  start: 0,
  length: PREFERRED_WINDOW,
  window: PREFERRED_WINDOW,
  rows: null,
  zoom: null,
  gain: 1,
  filters: startHistory(),
  raw: false,
  processed: null,
  filtering: false,
  untouched: 0,
  problem: null,
};
let bandTimer = 0;
let bandRun = 0;
// What the band shares were last measured over, so that a change of trace size or of the
// rows in view measures nothing again.
let measured = {};
// The recording whose time figures are shown, if any, and how many channels they cover.
let timed = null;
let timedChannels = null;
// Counts filter runs, so that one overtaken by a newer change or recording gives up.
let filterRun = 0;
let progressTimer = 0;
let openRequest = 0;
let opening = false;
let downloading = null;
// The worker opening a file, if any.
let opener = null;

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

// The recording drawn: filtered once a filter is ready, unless the reader asked for raw.
const onScreen = () => (state.raw || !state.processed ? state.recording : state.processed);

// What the traces show, in a few words, or '' with every filter off.
function filterText() {
  const settings = state.filters.present;
  if (isOff(settings)) return '';
  if (state.problem) return `Raw · ${FILTER_PROBLEMS[state.problem]}`;
  if (state.raw) return 'Raw · filter paused';
  const label = describe(settings);
  if (state.filtering) return `Filtering ${label}…`;
  const unfiltered =
    state.untouched > 0 ? ` · ${count(state.untouched, 'channel')} unfiltered` : '';
  return `Filtered ${label}${unfiltered}`;
}

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

// One list for each filter setting, with Off first.
const filterSelects = STEPS.map(({ key, label, choices }) => {
  const choice = document.createElement('label');
  const name = document.createElement('span');
  const select = document.createElement('select');
  choice.className = 'filter-choice';
  name.textContent = label;
  select.id = key;
  select.append(
    new Option('Off', ''),
    ...choices.map((value) => new Option(`${value} Hz`, String(value))),
  );
  select.addEventListener('change', () => {
    const value = select.value === '' ? null : Number(select.value);
    changeFilters({ ...state.filters.present, [key]: value });
  });
  choice.append(name, select);
  filterChoices.append(choice);
  return { key, select };
});

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
// and their section starts closed, so they wait until it's open. They describe the file, so
// they say so while a filter changes what's drawn.
function showTimes() {
  const { recording } = state;
  if (!timeSection.open || timed === recording) return;
  timed = recording;
  const stats = timeStats(recording.channels);
  fillRows(timeList, stats ? timeRows(stats) : []);
  timedChannels = stats ? stats.channels : null;
  showTimeNote();
}

function showTimeNote() {
  if (timed !== state.recording) return;
  const recorded = onScreen() === state.recording ? '' : ' · as recorded';
  timeNote.textContent =
    timedChannels === null
      ? BAND_PROBLEMS['no-eeg']
      : `Whole file · ${count(timedChannels, 'EEG channel')}${recorded}`;
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

function showBands({ shares, channels, reason }, filtered) {
  bandRows.forEach(({ name, row, bar, value }, index) => {
    const share = shares ? shares[index] : 0;
    bar.hidden = !shares;
    bar.style.setProperty('--share', share.toFixed(4));
    value.textContent = shares ? `${Math.round(share * 100)}%` : '–';
    row.title = shares ? `${name}: ${(share * 100).toFixed(1)}% of ${BAND_RANGE} power` : '';
  });
  bandNote.textContent = shares
    ? `${BAND_RANGE} · ${count(channels, 'EEG channel')}${filtered ? ', filtered' : ''}`
    : BAND_PROBLEMS[reason];
}

// Runs steps, a generator, a slice of time at a time, letting the page draw in between, and
// gives up once isCurrent says the work is no longer wanted. Returns what the generator
// returns, or undefined when it gave up.
async function drain(steps, isCurrent, slice) {
  let sliceStart = performance.now();
  let step = steps.next();
  while (!step.done) {
    if (performance.now() - sliceStart > slice) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (!isCurrent()) return undefined;
      sliceStart = performance.now();
    }
    step = steps.next();
  }
  return step.value;
}

// Keeps the page responsive however long the window is, and gives up if the view moves on.
// The bands measure what's drawn, filtered or not.
async function updateBands() {
  const run = bandRun;
  const { start, length } = state;
  const shown = onScreen();
  const steps = bandShares(shown.channels, start, length);
  const result = await drain(steps, () => run === bandRun, BAND_SLICE);
  if (result) showBands(result, shown !== state.recording);
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
  const zoomed = zoom ? ' Escape undoes the zoom.' : '';
  const filter = filterText();
  const filtered = filter
    ? ` ${filter.replace(/…$/, '')}. R switches between filtered and raw.`
    : '';
  positionText.textContent = text;
  position.setAttribute('aria-valuetext', text);
  canvas.setAttribute(
    'aria-label',
    `Traces for ${shown}, from ${text}.${filtered} Arrow keys read values, and Page Up and Page Down move a window at a time.${zoomed} Band shares are in the table.`,
  );
  showZoom();
  view.setView(start, length, gain, rows);
  // Bands depend only on the samples drawn and the stretch of them on screen.
  const drawn = onScreen();
  if (measured.recording === drawn && measured.start === start && measured.length === length) {
    return;
  }
  measured = { recording: drawn, start, length };
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

// levels are the spreads and baselines of the channels, when the worker has measured them.
// The display filter's settings carry over, so a new recording opens as recorded and is
// filtered with them once that's ready.
function show(recording, name, { start = 0, levels } = {}) {
  filterRun += 1;
  Object.assign(state, {
    recording,
    start,
    gain: 1,
    rows: null,
    zoom: null,
    raw: false,
    processed: null,
    filtering: !isOff(state.filters.present),
    untouched: 0,
    problem: null,
  });
  viewer.hidden = false;
  demoOffer.hidden = recording.format === 'Synthetic';
  updateGainButtons();
  nameHeading.textContent = name;
  showDetails(recording);
  const colors = eventColors(recording.annotations);
  showAnnotations(recording, colors);
  noteLine.textContent = recording.warnings.join(' ');
  noteLine.hidden = recording.warnings.length === 0;
  view.setRecording(recording, colors, levels);

  // The longest windows depend on how many rows fit on screen, as measured now.
  const choices = windowChoices(recording, view.rowsDrawn());
  windowSelect.replaceChildren(
    ...choices.map(
      (seconds) => new Option(formatWindow(seconds, recording.duration), String(seconds)),
    ),
  );
  const preferred = choices.findLast((seconds) => seconds <= PREFERRED_WINDOW) ?? choices[0];
  setWindow(preferred);
  showFilters();
  if (state.filtering) applyFilters();
}

// The display filter's controls and status line, as the settings and the state of the
// filtering stand.
function showFilters() {
  const settings = state.filters.present;
  for (const { key, select } of filterSelects) {
    select.value = settings[key] === null ? '' : String(settings[key]);
  }
  rawButton.disabled = isOff(settings);
  rawButton.setAttribute('aria-pressed', String(state.raw));
  const text = filterText();
  filterStatus.textContent = text;
  // A narrow screen cuts the line short, so pointing at it gives the whole of it.
  filterStatus.title = text;
  filterStatus.hidden = !text;
  showTimeNote();
}

// Draws whichever samples are on screen now, and says so.
function showSignals() {
  view.setSignals(onScreen().channels);
  showFilters();
  refresh();
}

// Filters the recording with the current settings, a slice at a time, and draws the result
// once it's ready. Until then, whatever was drawn stays. A newer change, or a new recording,
// makes this run give up.
async function applyFilters() {
  filterRun += 1;
  const run = filterRun;
  const { recording } = state;
  const settings = state.filters.present;
  state.problem = null;
  if (isOff(settings)) {
    Object.assign(state, { processed: null, filtering: false, untouched: 0 });
    showSignals();
    return;
  }
  state.filtering = true;
  showFilters();
  refresh();
  const steps = filterRecording(recording.channels, settings);
  const result = await drain(steps, () => run === filterRun, FILTER_SLICE);
  if (run !== filterRun) return;
  Object.assign(state, {
    processed: result.channels && { ...recording, channels: result.channels },
    filtering: false,
    untouched: result.untouched,
    problem: result.reason,
  });
  showSignals();
}

// A new choice of filter is a step that can be undone. Choosing turns raw off, since the
// reader wants to see what they chose.
function changeFilters(settings) {
  const history = record(state.filters, settings);
  if (history === state.filters) return;
  state.filters = history;
  state.raw = false;
  applyFilters();
}

// Undoes or redoes a change of filter, given undo or redo.
function stepHistory(move) {
  const history = move(state.filters);
  if (history === state.filters) return;
  state.filters = history;
  state.raw = false;
  applyFilters();
}

// Shows the samples as recorded, or the filtered ones again, without changing the filter.
function toggleRaw() {
  if (isOff(state.filters.present)) return;
  state.raw = !state.raw;
  showSignals();
}

function showDemo() {
  show(demoRecording(), DEMO_NAME, { start: DEMO_START });
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

// Each new recording to open stops the one before, and its download or worker if it has one.
function beginOpening() {
  openRequest += 1;
  clearTimeout(progressTimer);
  downloading?.abort();
  downloading = null;
  opener?.terminate();
  opener = null;
  setError('');
  return openRequest;
}

function opened({ recording, ...levels }, name, link) {
  stopReading();
  show(recording, name, { levels });
  setAddress(link);
  loader.close();
}

function failed(message) {
  stopReading();
  openLoader();
  setError(message);
}

// Reading a file and measuring its channels runs in a worker, which keeps the page free, so
// the dialog can say what it's doing and be closed. The buffer moves to the worker rather
// than being copied, and the worker stops once it has answered.
function openInWorker(buffer, reader) {
  const worker = new Worker(new URL('./open-worker.js', import.meta.url), { type: 'module' });
  opener = worker;
  return new Promise((resolve, reject) => {
    worker.onmessage = ({ data }) => (data.error ? reject(data.error) : resolve(data));
    // A worker that can't start, or runs out of memory, says nothing more useful than this.
    const lost = () => reject({ kind: 'other' });
    worker.onerror = lost;
    worker.onmessageerror = lost;
    worker.postMessage({ buffer, reader }, [buffer]);
  }).finally(() => worker.terminate());
}

// A reader's own error says what's wrong with the file, so it's shown as it is.
const readerSaid = (error) => error?.kind === 'edf' || error?.kind === 'csv';

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
    chooseLabel.textContent = 'Opening…';
    const result = await openInWorker(buffer, TEXT_FILE.test(file.name) ? 'csv' : 'edf');
    if (request !== openRequest) return;
    opened(result, file.name, '');
  } catch (error) {
    if (request !== openRequest) return;
    failed(
      readerSaid(error)
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
    linkStatus.textContent = 'Opening…';
    const result = await openInWorker(buffer, 'edf');
    if (request !== openRequest) return;
    opened(result, target.name, target.link);
  } catch (error) {
    if (request !== openRequest) return;
    failed(
      error instanceof LinkError || readerSaid(error)
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
rawButton.addEventListener('click', toggleRaw);
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
  // R alone: with Cmd or Ctrl it reloads the page, which the browser should still do. Held
  // down, it would flicker between the two.
  if (event.key.toLowerCase() === 'r' && !event.metaKey && !event.ctrlKey && !event.altKey) {
    event.preventDefault();
    if (!event.repeat) toggleRaw();
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

// Undo and redo step through the filter's settings, wherever the focus is, except in the
// dialog, whose link field keeps them for its own text.
document.addEventListener('keydown', (event) => {
  if (event.key.toLowerCase() !== 'z' || !(event.metaKey || event.ctrlKey) || event.altKey) return;
  if (loader.open || event.defaultPrevented) return;
  event.preventDefault();
  stepHistory(event.shiftKey ? redo : undo);
});

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
