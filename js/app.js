import { DEMO_START, demoRecording } from './demo.js';
import { BAND_RANGE, BANDS, bandShares, timeStats } from './dsp.js';
import {
  AFTER,
  BEFORE,
  chartScale,
  DURING,
  eventKinds,
  eventPower,
  findChannels,
  POWER_BANDS,
} from './erd.js';
import { amount, count, decimalsFor, downloadProgress, formatClock } from './format.js';
import { infoGroups, timeRows } from './info.js';
import { download, LinkError, resolveLink } from './remote.js';
import { describe, isOff, record, redo, runSteps, startHistory, STEPS, undo } from './steps.js';
import {
  clamp,
  eventColors,
  GAIN_LIMITS,
  rowName,
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

// How long the cursor rests on a row before event-related power follows it, so that passing
// over rows on the way to the chart leaves it as it was.
const DWELL = 400;

// How long typing can pause before the channels named are measured.
const TYPING_DELAY = 300;

const POWER_PROBLEMS = {
  slow: 'Sampled too slowly for this band.',
  rest: 'No baseline annotation lies in the recording.',
  flat: 'Flat in this band.',
};

// Event-related power's chart, in its own units, which are pixels at the panel's width, with
// the room it leaves around the plot for its labels.
const CHART = { width: 204, height: 100, left: 22, right: 6, top: 6, bottom: 16 };

// The dashes that tell the curves apart, as well as their colours.
const DASHES = ['none', '6 3', '2 2', '8 3 2 3'];

const SVG = 'http://www.w3.org/2000/svg';

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
const powerSection = $('event-power');
const powerKindList = $('power-kinds');
const powerBand = $('power-band');
const powerBaseline = $('power-baseline');
const powerChannels = $('power-channels');
const powerCharts = $('power-charts');
const powerNote = $('power-note');

// The window is the length chosen in the list, and length is how much is on screen, which a
// zoom shortens. Rows are the channels a zoom keeps, or null for all of them. A zoom keeps
// where its window started, to go back to.
//
// filters is the history of the display filter's settings, montage included, which carries
// over to the next recording. processed is the recording filtered with them, once it's ready,
// and raw says the reader has asked to see the samples as recorded instead. untouched counts
// the channels the filter leaves alone, kept the EEG channels the montage leaves alone, and
// problem says why a recording couldn't be filtered.
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
  kept: 0,
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
// Event-related power: the recording's kinds of annotation, each with its colour, the keys of
// those it averages, which carry over to the next recording where it has them, and the row
// it follows when no channel is named. dwell is the row the cursor has come to rest on.
let powerKinds = [];
const power = { kinds: new Set(), row: null };
let powerRun = 0;
let powerTimer = 0;
const dwell = { row: null, timer: 0 };

function showHover(hit, announce = false) {
  followCursor(hit);
  if (!hit) {
    readout.textContent = '';
    cursorStatus.textContent = '';
    return;
  }
  const { time, channel, value, spread } = hit;
  const reading = amount(value, channel.unit, decimalsFor(4 * spread));
  const text = `${formatClock(time, 2)} · ${rowName(channel)} · ${reading}`;
  readout.textContent = text;
  if (announce) cursorStatus.textContent = text;
}

const latestStart = () => Math.max(0, state.recording.duration - state.length);

// The recording drawn: filtered once a filter is ready, unless the reader asked for raw.
const onScreen = () => (state.raw || !state.processed ? state.recording : state.processed);

const capitalise = (text) => text.charAt(0).toUpperCase() + text.slice(1);

// What the traces show, in a few words, or '' with every filter off.
function filterText() {
  const settings = state.filters.present;
  if (isOff(settings)) return '';
  if (state.problem) return `Raw · ${FILTER_PROBLEMS[state.problem]}`;
  if (state.raw) return 'Raw · filter paused';
  const { filter, montage } = describe(settings);
  if (state.filtering) {
    return filter
      ? `Filtering ${[filter, montage].filter(Boolean).join(' · ')}…`
      : `Applying ${montage}…`;
  }
  const parts = [
    filter && `Filtered ${filter}`,
    montage,
    state.untouched > 0 && `${count(state.untouched, 'channel')} unfiltered`,
    state.kept > 0 && `${count(state.kept, 'EEG channel')} not re-referenced`,
  ];
  return capitalise(parts.filter(Boolean).join(' · '));
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

// One list for each setting, with Off first. A list's values are text, so a choice is found
// by its text to get back its value, which may be a number.
const filterSelects = STEPS.map(({ key, label, choices }) => {
  const choice = document.createElement('label');
  const name = document.createElement('span');
  const select = document.createElement('select');
  choice.className = 'filter-choice';
  name.textContent = label;
  select.id = key;
  select.append(
    new Option('Off', ''),
    ...choices.map(({ value, text }) => new Option(text, String(value))),
  );
  select.addEventListener('change', () => {
    const chosen = choices.find(({ value }) => String(value) === select.value);
    changeFilters({ ...state.filters.present, [key]: chosen ? chosen.value : null });
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

// The kinds of annotation to average, and the baselines. The kinds chosen before carry over
// where this recording has them, and otherwise every kind with a colour starts chosen.
function showPowerChoices({ annotations }, colors) {
  const colorOf = new Map(annotations.map(({ text }, i) => [text.trim().toLowerCase(), colors[i]]));
  powerKinds = eventKinds(annotations).map((kind) => ({ ...kind, color: colorOf.get(kind.key) }));
  powerSection.hidden = powerKinds.length === 0;
  const carried = powerKinds.filter(({ key }) => power.kinds.has(key));
  const chosen =
    carried.length > 0 ? carried : powerKinds.filter(({ color }) => color !== '--ink-2');
  power.kinds = new Set(chosen.map(({ key }) => key));
  power.row = null;
  // One at a time, since every annotation can be a kind of its own, as in showAnnotations.
  const choices = document.createDocumentFragment();
  const baselines = document.createDocumentFragment();
  baselines.append(new Option(`${BEFORE} s before`, ''));
  for (const kind of powerKinds) {
    choices.append(kindChoice(kind));
    baselines.append(new Option(kind.text, kind.key));
  }
  powerKindList.replaceChildren(choices);
  const baseline = powerBaseline.value;
  powerBaseline.replaceChildren(baselines);
  powerBaseline.value = powerKinds.some(({ key }) => key === baseline) ? baseline : '';
}

function kindChoice({ key, text, color }) {
  const choice = document.createElement('label');
  const box = document.createElement('input');
  choice.className = 'power-kind';
  // The same colour as the annotations and the curves, which the key below says in words.
  choice.style.setProperty('--event', `var(${color})`);
  box.type = 'checkbox';
  box.checked = power.kinds.has(key);
  box.addEventListener('change', () => {
    if (box.checked) power.kinds.add(key);
    else power.kinds.delete(key);
    schedulePower();
  });
  choice.append(box, text);
  return choice;
}

// Event-related power follows the row the cursor comes to rest on.
function followCursor(hit) {
  const row = hit ? hit.row : null;
  if (row === dwell.row) return;
  clearTimeout(dwell.timer);
  dwell.row = row;
  if (row === null || row === power.row) return;
  dwell.timer = setTimeout(() => {
    power.row = row;
    if (!powerChannels.value.trim()) schedulePower(0);
  }, DWELL);
}

function schedulePower(delay = 60) {
  clearTimeout(powerTimer);
  powerRun += 1;
  powerTimer = setTimeout(updatePower, delay);
}

function* measurePower(channels, rows, kinds, band, rest) {
  const results = [];
  for (const row of rows) results.push(yield* eventPower(channels[row], kinds, band, rest));
  return results;
}

// Measures event-related power at the channels named, or at the cursor's row, in the traces
// as drawn, while its section is open. Gives up if anything it depends on changes.
async function updatePower() {
  if (!powerSection.open || powerSection.hidden) return;
  const run = powerRun;
  const drawn = onScreen();
  const kinds = powerKinds.filter(({ key }) => power.kinds.has(key));
  const named = powerChannels.value.trim();
  const { rows, unknown } = named
    ? findChannels(drawn.channels, named)
    : { rows: power.row === null ? [] : [power.row], unknown: [] };
  const band = POWER_BANDS.find(({ value }) => value === powerBand.value);
  const rest = powerKinds.find(({ key }) => key === powerBaseline.value) ?? null;
  const steps = measurePower(drawn.channels, kinds.length > 0 ? rows : [], kinds, band, rest);
  const results = await drain(steps, () => run === powerRun, FILTER_SLICE);
  if (!results) return;
  const scale = chartScale(results.flatMap(({ curves }) => curves ?? []));
  powerCharts.replaceChildren(
    ...results.map((result, i) => powerFigure(drawn.channels[rows[i]], kinds, result, scale)),
  );
  const problems = [
    kinds.length === 0 && 'Choose annotations to average.',
    rows.length === 0 && !named && 'Point at a channel on the traces, or name channels here.',
    unknown.length > 0 && `No channel named ${unknown.join(', ')}.`,
  ];
  const recorded = drawn === state.recording;
  powerNote.textContent =
    problems.find(Boolean) || `From the ${recorded ? 'traces as recorded' : 'filtered traces'}`;
}

function svgElement(name, attributes, text = '') {
  const element = document.createElementNS(SVG, name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  element.textContent = text;
  return element;
}

// A line in a curve's colour and dashes, on the chart or in its key.
function curveLine(element, { color }, index) {
  element.setAttribute('class', 'power-line');
  element.setAttribute('stroke-dasharray', DASHES[index % DASHES.length]);
  element.style.setProperty('--event', `var(${color})`);
  return element;
}

function powerChart({ times, curves }, kinds, { low, high, ticks }) {
  const { width, height, left, right, top, bottom } = CHART;
  const x = (time) => left + ((time + BEFORE) / (BEFORE + AFTER)) * (width - left - right);
  const y = (db) => top + ((high - db) / (high - low)) * (height - top - bottom);
  const chart = svgElement('svg', {
    class: 'power-chart',
    viewBox: `0 0 ${width} ${height}`,
    'aria-hidden': 'true',
  });
  for (const tick of ticks) {
    chart.append(
      svgElement('line', {
        class: tick === 0 ? 'power-zero' : 'power-grid',
        x1: left,
        x2: width - right,
        y1: y(tick),
        y2: y(tick),
      }),
      svgElement('text', { class: 'power-db', x: left - 4, y: y(tick) }, amount(tick, '', 0)),
    );
  }
  for (let second = -BEFORE; second <= AFTER; second += 1) {
    const unit = second + 1 > AFTER ? 's' : '';
    const label = { class: 'power-time', x: x(second), y: height - 3 };
    chart.append(svgElement('text', label, amount(second, unit, 0)));
  }
  chart.append(
    svgElement('line', { class: 'power-onset', x1: x(0), x2: x(0), y1: top, y2: y(low) }),
  );
  curves.forEach(({ db }, index) => {
    if (!db) return;
    const points = Array.from(db, (value, i) => `${x(times[i]).toFixed(1)},${y(value).toFixed(1)}`);
    chart.append(
      curveLine(svgElement('polyline', { points: points.join(' ') }), kinds[index], index),
    );
  });
  return chart;
}

// The key to a chart, which also gives each kind's figures in words.
function powerKey(curves, kinds) {
  const table = document.createElement('table');
  const head = table.createTHead().insertRow();
  table.className = 'power-key';
  for (const text of ['Kind', 'Events', `${DURING[0]} to ${DURING[1]} s`]) {
    const cell = document.createElement('th');
    cell.scope = 'col';
    cell.textContent = text;
    head.append(cell);
  }
  const body = table.createTBody();
  curves.forEach(({ count, during }, index) => {
    const row = body.insertRow();
    const name = document.createElement('th');
    const swatch = svgElement('svg', {
      class: 'power-swatch',
      viewBox: '0 0 18 6',
      'aria-hidden': 'true',
    });
    swatch.append(
      curveLine(svgElement('line', { x1: 0, x2: 18, y1: 3, y2: 3 }), kinds[index], index),
    );
    name.scope = 'row';
    name.append(swatch, kinds[index].text);
    row.append(name);
    row.insertCell().textContent = String(count);
    row.insertCell().textContent = during === null ? '–' : amount(during, 'dB', 1);
  });
  return table;
}

function powerFigure(channel, kinds, result, scale) {
  const figure = document.createElement('figure');
  const caption = document.createElement('figcaption');
  figure.className = 'power-figure';
  caption.textContent = rowName(channel);
  figure.append(caption);
  if (result.reason) {
    const note = document.createElement('p');
    note.className = 'note';
    note.textContent = POWER_PROBLEMS[result.reason];
    figure.append(note);
  } else {
    figure.append(powerChart(result, kinds, scale), powerKey(result.curves, kinds));
  }
  return figure;
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
    kept: 0,
    problem: null,
  });
  viewer.hidden = false;
  demoOffer.hidden = recording.format === 'Synthetic';
  updateGainButtons();
  nameHeading.textContent = name;
  showDetails(recording);
  const colors = eventColors(recording.annotations);
  showAnnotations(recording, colors);
  showPowerChoices(recording, colors);
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
  schedulePower();
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
  schedulePower();
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
    Object.assign(state, { processed: null, filtering: false, untouched: 0, kept: 0 });
    showSignals();
    return;
  }
  state.filtering = true;
  showFilters();
  refresh();
  const steps = runSteps(recording.channels, settings);
  const result = await drain(steps, () => run === filterRun, FILTER_SLICE);
  if (run !== filterRun) return;
  Object.assign(state, {
    processed: result.channels && { ...recording, channels: result.channels },
    filtering: false,
    untouched: result.untouched,
    kept: result.kept,
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
powerSection.addEventListener('toggle', () => schedulePower(0));
powerBand.append(...POWER_BANDS.map(({ value, text }) => new Option(text, value)));
powerBand.addEventListener('change', () => schedulePower());
powerBaseline.addEventListener('change', () => schedulePower());
powerChannels.addEventListener('input', () => schedulePower(TYPING_DELAY));
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
