// Draws scrolling EEG traces on a canvas, one row per channel. The time axis has a canvas
// of its own below them, so it stays in view however far the rows scroll.

import { signalStats } from './dsp.js';
import { formatClock, rowRange } from './format.js';

export const GAIN_LIMITS = [0.2, 12];

const TICK_ROW = 26;
const EVENT_ROW = 18;
const MIN_ROW = 26;
const TICK_GAP = 16;
const DAY = 86400;
// prettier-ignore
const TICK_STEPS = [
  0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600, 7200, 14400, 28800,
  43200, DAY,
];
const LINE_PIXELS = 16;
const LABEL_SIZE = 12;
const RANGE_SIZE = 10;

// An annotation's marker is dashed, this many pixels on and then off.
const DASH = [4, 3];
const DASH_LENGTH = DASH[0] + DASH[1];

// How much of a half row a trace two spreads high fills at normal size.
const ROW_FILL = 0.55;

const SPREAD_SAMPLES = 8192;
const BASELINE_SECONDS = 30;
const BASELINE_SAMPLES = 128;

const WINDOW_CHOICES = [5, 10, 30, 60, 300, 1800, 3600, 7200];

// About what can redraw without the page stalling. Dense recordings stop short of the
// longest windows.
const MAX_WINDOW_SAMPLES = 2e7;

// How many kinds of annotation get a colour of their own, from the palette in styles.css.
// Any two kinds can sit side by side, and no more colours than this stay apart for
// colour-blind readers in both themes. CONTRIBUTING.md has the rule.
const EVENT_COLORS = 4;

// The shortest stretch of time a zoom shows, in seconds. A spike still spans a good part of it.
export const MIN_ZOOM = 0.2;

// A drag shorter than this, in pixels, is a click. A drag can stray this far, or further
// on a long one, up to the lock, and still zoom one way only.
const BOX_MIN = 8;
const BOX_LOCK = 20;

const CURSOR_STEPS = 50;
const CURSOR_KEYS = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

export const clamp = (value, lowest, highest) => Math.min(highest, Math.max(lowest, value));

// Evenly spaced samples from part of a channel, sorted. A typed array sorts by value on its own,
// which is far faster than an array with a comparison function.
function sortedSample(data, from, to, wanted) {
  const stride = Math.max(1, Math.floor((to - from) / wanted));
  const sample = new Float64Array(Math.ceil((to - from) / stride));
  for (let i = 0; i < sample.length; i += 1) sample[i] = data[from + i * stride];
  return sample.sort();
}

const middle = (sorted) => sorted[sorted.length >> 1];

// Median absolute deviation, so a blink does not shrink a whole channel. A channel that
// rests on one value for most of a recording has none, and the standard deviation takes
// over so that its bursts still show.
export function robustSpread(data) {
  const sample = sortedSample(data, 0, data.length, SPREAD_SAMPLES);
  const median = middle(sample);
  const deviations = sample.map((value) => Math.abs(value - median)).sort();
  return 1.4826 * middle(deviations) || signalStats(data).deviation;
}

// A channel's slow level: the median of each block of the recording, so a blink counts for
// nothing. Traces are drawn against this rather than anything to do with the window, so a
// sample sits at the same height wherever it scrolls to, and slow drift stays in its row.
export function baseline(data, fs) {
  const block = Math.max(1, Math.round(BASELINE_SECONDS * fs));
  const levels = new Float32Array(Math.ceil(data.length / block));
  for (let index = 0; index < levels.length; index += 1) {
    const from = index * block;
    const to = Math.min(data.length, from + block);
    levels[index] = middle(sortedSample(data, from, to, BASELINE_SAMPLES));
  }
  return { levels, block };
}

// The level at a sample, on a straight line between the middles of its nearest blocks.
export function levelAt({ levels, block }, sample) {
  const place = sample / block - 0.5;
  const index = Math.floor(place);
  if (index < 0) return levels[0];
  if (index >= levels.length - 1) return levels[levels.length - 1];
  return levels[index] + (levels[index + 1] - levels[index]) * (place - index);
}

// The window lengths worth offering, shortest first. The last is the whole file when it fits.
// A redraw draws only the rows near the view, so what counts is the rate of the fastest
// channels that can be drawn at once.
export function windowChoices({ channels, duration }, rows = channels.length) {
  const rate = channels
    .map(({ fs }) => fs)
    .sort((a, b) => b - a)
    .slice(0, rows)
    .reduce((sum, fs) => sum + fs, 0);
  const fits = (seconds) => seconds * rate <= MAX_WINDOW_SAMPLES;
  const choices = WINDOW_CHOICES.filter(
    (seconds, index) => seconds < duration && (index === 0 || fits(seconds)),
  );
  return fits(duration) || choices.length === 0 ? [...choices, duration] : choices;
}

// The colour of each annotation, as the name of a CSS property. Annotations with the same
// text share a colour, and the commonest kinds take the colours. Any further kinds share the
// grey of secondary text, and their names tell them apart.
export function eventColors(annotations) {
  const keys = annotations.map(({ text }) => text.trim().toLowerCase());
  const counts = new Map();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  // A stable sort, so kinds as common as each other keep the order they first appear in.
  const colors = new Map(
    [...counts.keys()]
      .sort((a, b) => counts.get(b) - counts.get(a))
      .map((key, rank) => [key, rank < EVENT_COLORS ? `--event-${rank + 1}` : '--ink-2']),
  );
  return keys.map((key) => colors.get(key));
}

// The smallest tick step that leaves room for a label between ticks.
export function tickStep(length, plotWidth, labelWidth) {
  const seconds = ((labelWidth + TICK_GAP) / plotWidth) * length;
  return TICK_STEPS.find((step) => step >= seconds) ?? Math.ceil(seconds / DAY) * DAY;
}

// How far a wheel event scrolls sideways, in pixels. A mostly vertical event gives
// zero, which leaves the browser to scroll the channels.
export function sidewaysPixels({ deltaX, deltaY, deltaMode, shiftKey }, pageWidth) {
  if (!shiftKey && Math.abs(deltaX) <= Math.abs(deltaY)) return 0;
  return (deltaX || deltaY) * [1, LINE_PIXELS, pageWidth][deltaMode];
}

// Which ways a box drawn on the traces zooms. A flat box zooms time alone and a narrow one
// channels alone, so a drag needn't be dead straight. Too small both ways, it was a click.
export function zoomAxes(width, height) {
  if (height < Math.min(Math.max(width * 0.6, BOX_MIN), BOX_LOCK)) {
    return { time: width >= BOX_MIN, channels: false };
  }
  return { time: width >= Math.min(height * 0.6, BOX_LOCK), channels: true };
}

// The time a zoom shows, from the stretch a box covers. A short stretch widens about its
// middle to the shortest zoom, and no zoom runs past either end of the recording.
export function zoomSpan(from, to, duration) {
  const length = Math.min(duration, Math.max(MIN_ZOOM, to - from));
  return { start: clamp((from + to - length) / 2, 0, duration - length), length };
}

function cursorMark(className) {
  const mark = document.createElement('div');
  mark.className = className;
  mark.hidden = true;
  return mark;
}

// Cuts text to a width. The app's fonts are monospace, so one character measures them all.
function fitText(context, text, width, character) {
  if (context.measureText(text).width <= width) return text;
  const room = Math.floor(width / character) - 1;
  return `${text.slice(0, room)}…`;
}

// The last of each run of items that land in the same pixel column, which is the one that
// shows when they are drawn in order.
function lastInColumn(items, xOf) {
  return items.filter((item, index) => {
    const next = items[index + 1];
    return next === undefined || Math.round(xOf(next)) !== Math.round(xOf(item));
  });
}

export class TraceView {
  constructor(canvas, axis, onHover, onScroll, onZoom) {
    this.canvas = canvas;
    this.axis = axis;
    this.context = canvas.getContext('2d');
    this.axisContext = axis.getContext('2d');
    this.onHover = onHover;
    this.onScroll = onScroll;
    this.onZoom = onZoom;
    this.recording = null;
    this.events = [];
    this.spreads = [];
    this.baselines = [];
    this.start = 0;
    this.length = 10;
    this.gain = 1;
    this.firstRow = 0;
    this.rowCount = 0;
    this.width = 0;
    this.frameHeight = 0;
    this.rowHeight = MIN_ROW;
    this.canvasTop = 0;
    this.canvasHeight = 0;
    this.gutter = 48;
    this.cursor = null;
    this.touchX = null;
    this.drag = null;
    this.frame = 0;

    // The cursor is made of elements rather than drawn, so pointing at a trace redraws nothing.
    // The canvas is see-through, so the row's shading can sit behind the traces. The box a
    // drag draws is made the same way, in front of them all. The canvas covers only the rows
    // near the view, so a spacer gives the frame the height of them all to scroll through.
    this.rowMark = cursorMark('cursor-row');
    this.lineMark = cursorMark('cursor-line');
    this.boxMark = cursorMark('zoom-box');
    this.space = document.createElement('div');
    canvas.before(this.rowMark);
    canvas.after(this.lineMark, this.boxMark, this.space);

    const frame = canvas.parentElement;
    new ResizeObserver(() => {
      if (frame.clientWidth !== this.width || frame.clientHeight !== this.frameHeight) {
        this.resize();
      }
    }).observe(frame);
    frame.addEventListener(
      'scroll',
      () => {
        if (this.recording && this.placeCanvas()) this.schedule();
      },
      { passive: true },
    );
    // A canvas keeps the colours it was drawn with, so it has to follow the theme by hand.
    new MutationObserver(() => this.schedule()).observe(document.documentElement, {
      attributeFilter: ['data-theme'],
    });
    canvas.addEventListener('pointerdown', (event) => {
      this.touch(event);
      this.press(event);
    });
    canvas.addEventListener('pointermove', (event) => {
      this.touch(event);
      this.hover(event);
      this.stretch(event);
    });
    canvas.addEventListener('pointerleave', () => this.leave());
    canvas.addEventListener('pointerup', () => {
      this.touchX = null;
      this.release();
    });
    canvas.addEventListener('pointercancel', () => {
      this.touchX = null;
      this.endDrag();
    });
    canvas.addEventListener('focus', () => {
      if (!canvas.matches(':focus-visible')) return;
      if (this.cursor) this.report(true);
      else this.placeCursor();
    });
    canvas.addEventListener('blur', () => this.leave());
    canvas.addEventListener('keydown', (event) => this.keydown(event));
  }

  // colors are those of eventColors, which the caller may already have for its own list.
  setRecording(recording, colors = eventColors(recording.annotations)) {
    this.recording = recording;
    this.events = recording.annotations.map((event, index) => ({ ...event, color: colors[index] }));
    this.spreads = recording.channels.map((channel) => robustSpread(channel.data));
    this.baselines = recording.channels.map(({ data, fs }) => baseline(data, fs));
    this.firstRow = 0;
    this.rowCount = recording.channels.length;
    this.cursor = null;
    this.onHover(null);
    this.endDrag();
    this.measure();
    // Not a draw yet: the window it would show belongs to the last recording. setView draws.
    this.layout();
  }

  // How many rows a redraw can draw at most, with every channel in view.
  rowsDrawn() {
    return Math.min(this.rowCount, Math.ceil(this.canvasHeight / this.rowHeight) + 1);
  }

  // Rows are the run of channels on screen, as { first, count }, or null for all of them.
  setView(start, length, gain, rows = null) {
    this.start = start;
    this.length = length;
    this.gain = gain;
    const first = rows ? rows.first : 0;
    const count = rows ? rows.count : this.recording.channels.length;
    if (first !== this.firstRow || count !== this.rowCount) this.showRows(first, count);
    // The traces moved under a cursor that stayed still, so it points at something new.
    if (this.cursor) this.report(document.activeElement === this.canvas);
    this.schedule();
  }

  // The rows on screen share the frame's height between them, so fewer rows means taller
  // traces. Coming back out, the rows that were zoomed in on stay in view.
  showRows(first, count) {
    const previous = this.firstRow;
    this.firstRow = first;
    this.rowCount = count;
    this.endDrag();
    const { cursor } = this;
    if (cursor && (cursor.row < first || cursor.row >= first + count)) this.leave();
    this.layout();
    this.canvas.parentElement.scrollTop = Math.max(0, previous - first) * this.rowHeight;
    this.placeCanvas();
  }

  secondsFor(pixels) {
    return (pixels / this.plotWidth()) * this.length;
  }

  eventRow() {
    return this.events.length > 0 ? EVENT_ROW : 0;
  }

  fit(canvas, context, height) {
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(this.width * ratio);
    canvas.height = Math.round(height * ratio);
    canvas.style.width = `${this.width}px`;
    canvas.style.height = `${height}px`;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  resize() {
    if (!this.recording) return;
    this.layout();
    this.draw();
  }

  // A canvas measures text in whatever font it has, so the labels are measured again once
  // the real one arrives.
  remeasure() {
    if (!this.recording) return;
    this.measure();
    this.resize();
  }

  // The gutter holds the row labels. It is wide enough at any trace size, so the plot does
  // not shift when the size changes, and it depends only on the recording and the font.
  measure() {
    const { context } = this;
    const { channels } = this.recording;
    context.font = this.font(LABEL_SIZE);
    const labels = channels.map(({ label }) => context.measureText(label).width);
    context.font = this.font(RANGE_SIZE);
    const ranges = channels.flatMap((_, row) =>
      GAIN_LIMITS.map((gain) => context.measureText(this.rangeText(row, gain)).width),
    );
    this.gutter = Math.ceil(Math.max(...labels, ...ranges)) + 20;
  }

  // The canvas covers the rows in view and as much again around them, so it stays the same
  // size however many channels there are.
  layout() {
    const { canvas, axis, context, axisContext } = this;
    const frame = canvas.parentElement;
    this.width = frame.clientWidth;
    this.frameHeight = frame.clientHeight;
    this.rowHeight = Math.max(MIN_ROW, Math.floor(this.frameHeight / this.rowCount));
    this.canvasHeight = Math.min(this.plotHeight(), 2 * this.frameHeight);
    this.space.style.height = `${this.plotHeight()}px`;
    this.fit(canvas, context, this.canvasHeight);
    this.fit(axis, axisContext, this.eventRow() + TICK_ROW);
    this.placeCanvas(true);
    this.showCursor();
  }

  // Moves the canvas once scrolling reaches its edge, to leave as much room either side of
  // the view as it can, so that most scrolling needs no redraw. Says whether it moved.
  placeCanvas(always = false) {
    const { scrollTop } = this.canvas.parentElement;
    const top = this.canvasTop;
    const shown = Math.min(this.frameHeight, this.canvasHeight);
    const covered = scrollTop >= top && scrollTop + shown <= top + this.canvasHeight;
    if (covered && !always) return false;
    const spare = this.canvasHeight - shown;
    const latest = this.plotHeight() - this.canvasHeight;
    this.canvasTop = clamp(Math.round(scrollTop - spare / 2), 0, latest);
    this.canvas.style.top = `${this.canvasTop}px`;
    return this.canvasTop !== top;
  }

  font(size) {
    const family = getComputedStyle(document.documentElement).getPropertyValue('--font').trim();
    return `${size}px ${family}`;
  }

  schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  plotWidth() {
    return Math.max(1, this.width - this.gutter - 8);
  }

  plotHeight() {
    return this.rowHeight * this.rowCount;
  }

  // The channels with any part from top to bottom of the plot, each with its index in the
  // recording and the middle of its row.
  rows(top, bottom) {
    const { firstRow, rowHeight } = this;
    const from = Math.max(0, Math.floor(top / rowHeight));
    const to = Math.min(this.rowCount, Math.ceil(bottom / rowHeight));
    return this.recording.channels.slice(firstRow + from, firstRow + to).map((channel, index) => ({
      channel,
      row: firstRow + from + index,
      middle: (from + index + 0.5) * rowHeight,
    }));
  }

  xOf(time) {
    return this.gutter + ((time - this.start) / this.length) * this.plotWidth();
  }

  pixelsPerUnit(row) {
    const spread = this.spreads[row];
    return spread > 0 ? ((this.rowHeight / 2) * ROW_FILL * this.gain) / (2 * spread) : 0;
  }

  // How much signal a row holds either side of its middle. Rows differ, so each says its own.
  rangeText(row, gain) {
    const spread = this.spreads[row];
    if (!(spread > 0)) return 'flat';
    return rowRange((2 * spread) / (ROW_FILL * gain), this.recording.channels[row].unit);
  }

  // A finger dragged sideways scrolls time. The browser keeps vertical drags.
  touch(event) {
    if (event.pointerType !== 'touch' || !event.isPrimary) return;
    if (this.touchX !== null) this.onScroll(this.touchX - event.clientX);
    this.touchX = event.clientX;
  }

  // How far down the plot a point on the screen is. The canvas starts canvasTop down it.
  plotY(clientY, box) {
    return clientY - box.top + this.canvasTop;
  }

  hover(event) {
    if (!this.recording) return;
    const box = this.canvas.getBoundingClientRect();
    const x = event.clientX - box.left - this.gutter;
    const slot = Math.floor(this.plotY(event.clientY, box) / this.rowHeight);
    if (x < 0 || x > this.plotWidth() || slot < 0 || slot >= this.rowCount) {
      this.leave();
      return;
    }
    this.moveCursor(x, this.firstRow + slot, false);
  }

  // Where a pointer is on the plot, kept inside it so that a drag can run off the edge.
  pointAt({ clientX, clientY }) {
    const box = this.canvas.getBoundingClientRect();
    return {
      x: clamp(clientX - box.left - this.gutter, 0, this.plotWidth()),
      y: clamp(this.plotY(clientY, box), 0, this.plotHeight() - 1),
    };
  }

  // A mouse or pen dragged across the traces draws a box to zoom to. A finger scrolls instead.
  press(event) {
    if (!this.recording || event.pointerType === 'touch' || event.button !== 0) return;
    const point = this.pointAt(event);
    this.drag = { from: point, to: point };
    // Keeps the drag going when it leaves the canvas.
    this.canvas.setPointerCapture(event.pointerId);
  }

  stretch(event) {
    if (!this.drag) return;
    this.drag.to = this.pointAt(event);
    this.showBox();
  }

  // What a drag zooms to: a stretch of the plot in pixels and a run of rows on screen.
  box() {
    const { from, to } = this.drag;
    const { time, channels } = zoomAxes(Math.abs(to.x - from.x), Math.abs(to.y - from.y));
    const slot = (y) => Math.floor(y / this.rowHeight);
    return {
      time,
      channels,
      left: time ? Math.min(from.x, to.x) : 0,
      right: time ? Math.max(from.x, to.x) : this.plotWidth(),
      top: channels ? slot(Math.min(from.y, to.y)) : 0,
      bottom: channels ? slot(Math.max(from.y, to.y)) : this.rowCount - 1,
    };
  }

  // The box shows what letting go will zoom to, whole rows and all.
  showBox() {
    const box = this.drag && this.box();
    const { boxMark, rowHeight } = this;
    boxMark.hidden = !box || !(box.time || box.channels);
    if (boxMark.hidden) return;
    boxMark.style.left = `${this.gutter + box.left}px`;
    boxMark.style.width = `${box.right - box.left}px`;
    boxMark.style.top = `${box.top * rowHeight}px`;
    boxMark.style.height = `${(box.bottom - box.top + 1) * rowHeight}px`;
  }

  release() {
    if (!this.drag) return;
    const box = this.box();
    this.endDrag();
    const count = box.bottom - box.top + 1;
    // A box over every row on screen leaves the rows as they are.
    const rows = count < this.rowCount ? { first: this.firstRow + box.top, count } : null;
    const timeAt = (x) => this.start + this.secondsFor(x);
    const span = box.time
      ? zoomSpan(timeAt(box.left), timeAt(box.right), this.recording.duration)
      : null;
    if (span || rows) this.onZoom(span, rows);
  }

  endDrag() {
    this.drag = null;
    this.showBox();
  }

  moveCursor(x, row, announce) {
    this.cursor = { x, row };
    this.report(announce);
    this.showCursor();
  }

  showCursor() {
    const { cursor, rowMark, lineMark, gutter, rowHeight } = this;
    rowMark.hidden = !cursor;
    lineMark.hidden = !cursor;
    if (!cursor) return;
    rowMark.style.left = `${gutter}px`;
    rowMark.style.top = `${(cursor.row - this.firstRow) * rowHeight}px`;
    rowMark.style.width = `${this.plotWidth()}px`;
    rowMark.style.height = `${rowHeight}px`;
    lineMark.style.left = `${Math.round(gutter + cursor.x)}px`;
    lineMark.style.height = `${this.plotHeight()}px`;
  }

  report(announce) {
    const { x, row } = this.cursor;
    const time = this.start + (x / this.plotWidth()) * this.length;
    const channel = this.recording.channels[row];
    const index = Math.min(channel.data.length - 1, Math.round(time * channel.fs));
    this.onHover(
      { time, channel, value: channel.data[index], spread: this.spreads[row] },
      announce,
    );
  }

  leave() {
    if (this.cursor === null) return;
    this.cursor = null;
    this.onHover(null);
    this.showCursor();
  }

  // Keyboard users start from the middle of the first row in view.
  placeCursor() {
    if (!this.recording || this.cursor) return;
    const slot = Math.ceil(this.canvas.parentElement.scrollTop / this.rowHeight);
    this.moveCursor(this.plotWidth() / 2, this.firstRow + slot, true);
  }

  keydown(event) {
    // Escape drops a drag under way. Without one, it is left to undo the zoom.
    if (event.key === 'Escape' && this.drag) {
      event.preventDefault();
      this.endDrag();
      return;
    }
    const move = CURSOR_KEYS[event.key];
    if (!move || !this.recording) return;
    event.preventDefault();
    this.placeCursor();
    const plotWidth = this.plotWidth();
    const x = clamp(this.cursor.x + (move[0] * plotWidth) / CURSOR_STEPS, 0, plotWidth);
    const lastRow = this.firstRow + this.rowCount - 1;
    const row = clamp(this.cursor.row + move[1], this.firstRow, lastRow);
    this.moveCursor(x, row, true);
    this.reveal(row);
  }

  reveal(row) {
    const frame = this.canvas.parentElement;
    const top = (row - this.firstRow) * this.rowHeight;
    const bottom = top + this.rowHeight;
    if (top < frame.scrollTop) frame.scrollTop = top;
    else if (bottom > frame.scrollTop + frame.clientHeight) {
      frame.scrollTop = bottom - frame.clientHeight;
    }
  }

  ticks() {
    const { axisContext, start, length } = this;
    axisContext.font = this.font(LABEL_SIZE);
    const widest = axisContext.measureText(formatClock(start + length, 1)).width;
    const step = tickStep(length, this.plotWidth(), widest);
    const decimals = step < 1 ? 1 : 0;
    const ticks = [];
    for (let index = Math.ceil(start / step); index * step <= start + length; index += 1) {
      const time = index * step;
      ticks.push({ x: Math.round(this.xOf(time)) + 0.5, label: formatClock(time, decimals) });
    }
    return ticks;
  }

  visibleEvents() {
    const end = this.start + this.length;
    return this.events.filter(({ time, duration }) => time <= end && time + duration >= this.start);
  }

  // Draws the rows the canvas covers, in the plot's own coordinates: the canvas starts top
  // pixels down the plot, and the context is moved up to match.
  draw() {
    const { context, recording, gutter, canvasTop: top, canvasHeight: height } = this;
    if (!recording) return;
    const styles = getComputedStyle(document.documentElement);
    // Kept for the frame, since a window can hold thousands of annotations in a few colours.
    const colors = {};
    const color = (name) => (colors[name] ??= styles.getPropertyValue(name).trim());
    const bottom = top + height;
    const plotWidth = this.plotWidth();
    const ticks = this.ticks();
    const events = this.visibleEvents();
    const rows = this.rows(top, bottom);

    context.clearRect(0, 0, this.width, height);
    context.save();
    context.translate(0, -top);
    context.textBaseline = 'middle';

    // Time grid.
    context.strokeStyle = color('--grid');
    context.lineWidth = 1;
    context.beginPath();
    for (const { x } of ticks) {
      context.moveTo(x, top);
      context.lineTo(x, bottom);
    }
    context.stroke();

    context.save();
    context.beginPath();
    context.rect(gutter, top, plotWidth, height);
    context.clip();
    this.drawEvents(events, top, bottom, color);
    context.strokeStyle = color('--trace');
    context.lineWidth = 1;
    context.lineJoin = 'round';
    for (const row of rows) this.drawChannel(row, plotWidth);
    context.restore();

    // Each row's name, and under it the amplitude that row spans.
    const labelFont = this.font(LABEL_SIZE);
    const rangeFont = this.font(RANGE_SIZE);
    context.fillStyle = color('--ink-2');
    context.textAlign = 'right';
    rows.forEach(({ channel, row, middle }) => {
      context.font = labelFont;
      context.fillText(channel.label, gutter - 10, middle - 6);
      context.font = rangeFont;
      context.fillText(this.rangeText(row, this.gain), gutter - 10, middle + 7);
    });
    context.restore();

    this.drawAxis(ticks, events, color);
  }

  // A marker at each annotation in its colour, with a shaded span when it lasts a while.
  // Markers in one pixel column cover each other, so only the one on top is drawn, which
  // keeps a window of thousands of annotations quick to draw. The dashes start from the top
  // of the plot, so they don't shift when the canvas moves.
  drawEvents(events, top, bottom, color) {
    const { context } = this;
    context.globalAlpha = 0.12;
    for (const { time, duration, color: name } of events) {
      if (!(duration > 0)) continue;
      const x = Math.round(this.xOf(time)) + 0.5;
      context.fillStyle = color(name);
      context.fillRect(x, top, this.xOf(time + duration) - x, bottom - top);
    }
    context.globalAlpha = 1;
    context.lineWidth = 1;
    context.setLineDash(DASH);
    const from = top - (top % DASH_LENGTH);
    for (const { time, color: name } of lastInColumn(events, ({ time }) => this.xOf(time))) {
      const x = Math.round(this.xOf(time)) + 0.5;
      context.strokeStyle = color(name);
      context.beginPath();
      context.moveTo(x, from);
      context.lineTo(x, bottom);
      context.stroke();
    }
    context.setLineDash([]);
  }

  drawAxis(ticks, events, color) {
    const { axisContext: context, width, gutter } = this;
    const eventRow = this.eventRow();
    context.clearRect(0, 0, width, eventRow + TICK_ROW);
    context.font = this.font(LABEL_SIZE);
    context.textBaseline = 'middle';
    context.textAlign = 'center';
    context.fillStyle = color('--ink-2');
    for (const { x, label } of ticks) {
      const half = context.measureText(label).width / 2;
      context.fillText(label, clamp(x, half + 4, width - half - 4), eventRow + TICK_ROW / 2 + 1);
    }

    // Annotation names sit here so that they stay in view too. Each follows a mark in its
    // colour under the marker's line, and is written in ink, which reads on any colour. Like
    // the markers, only the last mark in a pixel column is drawn, and a name with no room for
    // a letter is left out.
    const right = gutter + this.plotWidth();
    const character = context.measureText('0').width;
    const placeOf = ({ time }) => Math.max(gutter, this.xOf(time));
    const marked = lastInColumn(events, placeOf);
    context.textAlign = 'left';
    marked.forEach((event, index) => {
      const x = placeOf(event);
      const next = index + 1 < marked.length ? placeOf(marked[index + 1]) : right;
      context.fillStyle = color(event.color);
      context.fillRect(Math.round(x) - 1, 0, 3, EVENT_ROW - 3);
      const room = Math.min(next, right) - x - 12;
      if (room < 2 * character) return;
      context.fillStyle = color('--ink');
      context.fillText(fitText(context, event.text, room, character), x + 6, EVENT_ROW / 2);
    });
  }

  drawChannel({ channel, row, middle }, plotWidth) {
    const { context, gutter } = this;
    const { data, fs } = channel;
    const from = Math.max(0, Math.floor(this.start * fs));
    const to = Math.min(data.length, Math.ceil((this.start + this.length) * fs) + 1);
    if (to - from < 2) return;

    const level = this.baselines[row];
    const pixelsPerUnit = this.pixelsPerUnit(row);
    const yOf = (value, sample) => middle - (value - levelAt(level, sample)) * pixelsPerUnit;
    const samplesPerPixel = (this.length * fs) / plotWidth;

    context.beginPath();
    if (samplesPerPixel <= 2) {
      for (let i = from; i < to; i += 1) {
        const x = gutter + ((i / fs - this.start) / this.length) * plotWidth;
        if (i === from) context.moveTo(x, yOf(data[i], i));
        else context.lineTo(x, yOf(data[i], i));
      }
    } else {
      // More samples than pixels: draw each pixel column's minimum and maximum. Columns
      // are counted from the start of the recording, so they keep their shape as they scroll.
      const firstColumn = Math.floor(from / samplesPerPixel);
      const endColumn = Math.ceil(to / samplesPerPixel);
      const origin = gutter - (this.start / this.length) * plotWidth;
      for (let column = firstColumn; column < endColumn; column += 1) {
        const first = Math.floor(column * samplesPerPixel);
        const last = Math.min(data.length, Math.floor((column + 1) * samplesPerPixel));
        let low = Infinity;
        let high = -Infinity;
        for (let i = first; i < Math.max(last, first + 1); i += 1) {
          if (data[i] < low) low = data[i];
          if (data[i] > high) high = data[i];
        }
        const x = origin + column;
        if (column === firstColumn) context.moveTo(x, yOf(low, first));
        else context.lineTo(x, yOf(low, first));
        context.lineTo(x, yOf(high, first));
      }
    }
    context.stroke();
  }
}
