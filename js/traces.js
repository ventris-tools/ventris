// Draws scrolling EEG traces on a canvas, one row per channel. The time axis has a canvas
// of its own below them, so it stays in view however far the rows scroll.

import { formatClock, rowRange } from './format.js';

export const GAIN_LIMITS = [0.2, 12];

const TICK_ROW = 26;
const EVENT_ROW = 18;
const MIN_ROW = 26;
const TICK_GAP = 16;
const DAY = 86400;
// prettier-ignore
const TICK_STEPS = [
  0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600, 7200, 14400, 28800, 43200, DAY,
];
const LINE_PIXELS = 16;
const LABEL_SIZE = 12;
const RANGE_SIZE = 10;

// How much of a half row a trace two spreads high fills at normal size.
const ROW_FILL = 0.55;

const SPREAD_SAMPLES = 8192;
const BASELINE_SECONDS = 30;
const BASELINE_SAMPLES = 128;

const WINDOW_CHOICES = [5, 10, 30, 60, 300, 1800, 3600, 7200];

// About what can redraw without the page stalling. Dense recordings stop short of the
// longest windows.
const MAX_WINDOW_SAMPLES = 2e7;

const CURSOR_STEPS = 50;
const CURSOR_KEYS = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

const clamp = (value, lowest, highest) => Math.min(highest, Math.max(lowest, value));

function deviation(data) {
  let sum = 0;
  for (let i = 0; i < data.length; i += 1) sum += data[i];
  const mean = sum / data.length;
  let squares = 0;
  for (let i = 0; i < data.length; i += 1) squares += (data[i] - mean) ** 2;
  return Math.sqrt(squares / data.length);
}

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
  return 1.4826 * middle(deviations) || deviation(data);
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
export function windowChoices({ channels, duration }) {
  const rate = channels.reduce((sum, { fs }) => sum + fs, 0);
  const fits = (seconds) => seconds * rate <= MAX_WINDOW_SAMPLES;
  const choices = WINDOW_CHOICES.filter(
    (seconds, index) => seconds < duration && (index === 0 || fits(seconds)),
  );
  return fits(duration) || choices.length === 0 ? [...choices, duration] : choices;
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

function cursorMark(className) {
  const mark = document.createElement('div');
  mark.className = className;
  mark.hidden = true;
  return mark;
}

// Cuts text to a width. The app's fonts are monospace, so one character measures them all.
function fitText(context, text, width) {
  if (context.measureText(text).width <= width) return text;
  const room = Math.floor(width / context.measureText('0').width) - 1;
  return room > 0 ? `${text.slice(0, room)}…` : '';
}

export class TraceView {
  constructor(canvas, axis, onHover, onScroll) {
    this.canvas = canvas;
    this.axis = axis;
    this.context = canvas.getContext('2d');
    this.axisContext = axis.getContext('2d');
    this.onHover = onHover;
    this.onScroll = onScroll;
    this.recording = null;
    this.spreads = [];
    this.baselines = [];
    this.start = 0;
    this.length = 10;
    this.gain = 1;
    this.width = 0;
    this.frameHeight = 0;
    this.rowHeight = MIN_ROW;
    this.gutter = 48;
    this.cursor = null;
    this.touchX = null;
    this.frame = 0;

    // The cursor is made of elements rather than drawn, so pointing at a trace redraws nothing.
    // The canvas is see-through, so the row's shading can sit behind the traces.
    this.rowMark = cursorMark('cursor-row');
    this.lineMark = cursorMark('cursor-line');
    canvas.before(this.rowMark);
    canvas.after(this.lineMark);

    new ResizeObserver(() => {
      const { clientWidth, clientHeight } = canvas.parentElement;
      if (clientWidth !== this.width || clientHeight !== this.frameHeight) this.resize();
    }).observe(canvas.parentElement);
    // A canvas keeps the colours it was drawn with, so it has to follow the theme by hand.
    new MutationObserver(() => this.schedule()).observe(document.documentElement, {
      attributeFilter: ['data-theme'],
    });
    canvas.addEventListener('pointerdown', (event) => this.touch(event));
    canvas.addEventListener('pointermove', (event) => {
      this.touch(event);
      this.hover(event);
    });
    canvas.addEventListener('pointerleave', () => this.leave());
    for (const name of ['pointerup', 'pointercancel']) {
      canvas.addEventListener(name, () => {
        this.touchX = null;
      });
    }
    canvas.addEventListener('focus', () => {
      if (!canvas.matches(':focus-visible')) return;
      if (this.cursor) this.report(true);
      else this.placeCursor();
    });
    canvas.addEventListener('blur', () => this.leave());
    canvas.addEventListener('keydown', (event) => this.keydown(event));
  }

  setRecording(recording) {
    this.recording = recording;
    this.spreads = recording.channels.map((channel) => robustSpread(channel.data));
    this.baselines = recording.channels.map(({ data, fs }) => baseline(data, fs));
    this.cursor = null;
    this.onHover(null);
    // Not a draw yet: the window it would show belongs to the last recording. setView draws.
    this.layout();
  }

  setView(start, length, gain) {
    this.start = start;
    this.length = length;
    this.gain = gain;
    // The traces moved under a cursor that stayed still, so it points at something new.
    if (this.cursor) this.report(document.activeElement === this.canvas);
    this.schedule();
  }

  secondsFor(pixels) {
    return (pixels / this.plotWidth()) * this.length;
  }

  eventRow() {
    return this.recording.annotations.length > 0 ? EVENT_ROW : 0;
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

  layout() {
    const { canvas, axis, context, axisContext } = this;
    const { channels } = this.recording;
    const frame = canvas.parentElement;
    this.width = frame.clientWidth;
    this.frameHeight = frame.clientHeight;
    this.rowHeight = Math.max(MIN_ROW, Math.floor(this.frameHeight / channels.length));
    this.fit(canvas, context, this.rowHeight * channels.length);
    this.fit(axis, axisContext, this.eventRow() + TICK_ROW);

    // Wide enough at any trace size, so the plot does not shift when the size changes.
    context.font = this.font(LABEL_SIZE);
    const labels = channels.map(({ label }) => context.measureText(label).width);
    context.font = this.font(RANGE_SIZE);
    const ranges = channels.flatMap((_, row) =>
      GAIN_LIMITS.map((gain) => context.measureText(this.rangeText(row, gain)).width),
    );
    this.gutter = Math.ceil(Math.max(...labels, ...ranges)) + 20;
    this.showCursor();
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

  hover(event) {
    if (!this.recording) return;
    const box = this.canvas.getBoundingClientRect();
    const x = event.clientX - box.left - this.gutter;
    const row = Math.floor((event.clientY - box.top) / this.rowHeight);
    if (x < 0 || x > this.plotWidth() || row < 0 || row >= this.recording.channels.length) {
      this.leave();
      return;
    }
    this.moveCursor(x, row, false);
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
    rowMark.style.top = `${cursor.row * rowHeight}px`;
    rowMark.style.width = `${this.plotWidth()}px`;
    rowMark.style.height = `${rowHeight}px`;
    lineMark.style.left = `${Math.round(gutter + cursor.x)}px`;
    lineMark.style.height = `${rowHeight * this.recording.channels.length}px`;
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
    const firstRow = Math.ceil(this.canvas.parentElement.scrollTop / this.rowHeight);
    this.moveCursor(this.plotWidth() / 2, firstRow, true);
  }

  keydown(event) {
    const move = CURSOR_KEYS[event.key];
    if (!move || !this.recording) return;
    event.preventDefault();
    this.placeCursor();
    const plotWidth = this.plotWidth();
    const x = clamp(this.cursor.x + (move[0] * plotWidth) / CURSOR_STEPS, 0, plotWidth);
    const row = clamp(this.cursor.row + move[1], 0, this.recording.channels.length - 1);
    this.moveCursor(x, row, true);
    this.reveal(row);
  }

  reveal(row) {
    const frame = this.canvas.parentElement;
    const top = row * this.rowHeight;
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
    return this.recording.annotations.filter(
      ({ time, duration }) => time <= end && time + duration >= this.start,
    );
  }

  draw() {
    const { context, recording, gutter, rowHeight } = this;
    if (!recording) return;
    const styles = getComputedStyle(document.documentElement);
    const color = (name) => styles.getPropertyValue(name).trim();
    const plotHeight = rowHeight * recording.channels.length;
    const plotWidth = this.plotWidth();
    const ticks = this.ticks();
    const events = this.visibleEvents();

    context.clearRect(0, 0, this.width, plotHeight);
    context.textBaseline = 'middle';

    // Time grid.
    context.strokeStyle = color('--grid');
    context.lineWidth = 1;
    context.beginPath();
    for (const { x } of ticks) {
      context.moveTo(x, 0);
      context.lineTo(x, plotHeight);
    }
    context.stroke();

    context.save();
    context.beginPath();
    context.rect(gutter, 0, plotWidth, plotHeight);
    context.clip();
    this.drawEvents(events, plotHeight, color('--accent'));
    context.strokeStyle = color('--trace');
    context.lineWidth = 1;
    context.lineJoin = 'round';
    recording.channels.forEach((channel, row) => this.drawChannel(channel, row, plotWidth));
    context.restore();

    // Each row's name, and under it the amplitude that row spans.
    const labelFont = this.font(LABEL_SIZE);
    const rangeFont = this.font(RANGE_SIZE);
    context.fillStyle = color('--ink-2');
    context.textAlign = 'right';
    recording.channels.forEach((channel, row) => {
      const middle = (row + 0.5) * rowHeight;
      context.font = labelFont;
      context.fillText(channel.label, gutter - 10, middle - 6);
      context.font = rangeFont;
      context.fillText(this.rangeText(row, this.gain), gutter - 10, middle + 7);
    });

    this.drawAxis(ticks, events, color);
  }

  // A marker at each annotation, with a shaded span when it lasts a while.
  drawEvents(events, plotHeight, accent) {
    const { context } = this;
    context.strokeStyle = accent;
    context.fillStyle = accent;
    context.lineWidth = 1;
    context.setLineDash([4, 3]);
    for (const { time, duration } of events) {
      const x = Math.round(this.xOf(time)) + 0.5;
      if (duration > 0) {
        context.globalAlpha = 0.12;
        context.fillRect(x, 0, this.xOf(time + duration) - x, plotHeight);
        context.globalAlpha = 1;
      }
      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(x, plotHeight);
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

    // Annotation names sit here so that they stay in view too.
    const right = gutter + this.plotWidth();
    context.textAlign = 'left';
    context.fillStyle = color('--accent');
    events.forEach(({ time, text }, index) => {
      const x = Math.max(gutter, this.xOf(time));
      const next = index + 1 < events.length ? this.xOf(events[index + 1].time) : right;
      context.fillText(fitText(context, text, Math.min(next, right) - x - 8), x + 3, EVENT_ROW / 2);
    });
  }

  drawChannel(channel, row, plotWidth) {
    const { context, gutter, rowHeight } = this;
    const { data, fs } = channel;
    const from = Math.max(0, Math.floor(this.start * fs));
    const to = Math.min(data.length, Math.ceil((this.start + this.length) * fs) + 1);
    if (to - from < 2) return;

    const level = this.baselines[row];
    const middle = (row + 0.5) * rowHeight;
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
