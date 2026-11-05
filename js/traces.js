// Draws scrolling EEG traces on a canvas, one row per channel.

const AXIS_HEIGHT = 26;
const MIN_ROW = 26;
const TICK_STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
const LINE_PIXELS = 16;

// Median absolute deviation, so a blink does not shrink a whole channel.
function robustSpread(data) {
  const stride = Math.max(1, Math.floor(data.length / 8192));
  const sample = [];
  for (let i = 0; i < data.length; i += stride) sample.push(data[i]);
  sample.sort((a, b) => a - b);
  const median = sample[sample.length >> 1];
  const deviations = sample.map((value) => Math.abs(value - median)).sort((a, b) => a - b);
  return 1.4826 * deviations[deviations.length >> 1];
}

export function formatClock(seconds) {
  const whole = Math.round(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = String(whole % 60).padStart(2, '0');
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}`
    : `${minutes}:${rest}`;
}

// How far a wheel event scrolls sideways, in pixels. A mostly vertical event gives
// zero, which leaves the browser to scroll the channels.
export function sidewaysPixels({ deltaX, deltaY, deltaMode, shiftKey }, pageWidth) {
  if (!shiftKey && Math.abs(deltaX) <= Math.abs(deltaY)) return 0;
  return (deltaX || deltaY) * [1, LINE_PIXELS, pageWidth][deltaMode];
}

export class TraceView {
  constructor(canvas, onHover, onScroll) {
    this.canvas = canvas;
    this.context = canvas.getContext('2d');
    this.onHover = onHover;
    this.onScroll = onScroll;
    this.recording = null;
    this.spreads = [];
    this.start = 0;
    this.length = 10;
    this.gain = 1;
    this.width = 0;
    this.frameHeight = 0;
    this.rowHeight = MIN_ROW;
    this.gutter = 48;
    this.pointer = null;
    this.lastPointer = null;
    this.touchX = null;
    this.frame = 0;

    new ResizeObserver(() => {
      const { clientWidth, clientHeight } = canvas.parentElement;
      if (clientWidth !== this.width || clientHeight !== this.frameHeight) this.resize();
    }).observe(canvas.parentElement);
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.schedule());
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
  }

  setRecording(recording) {
    this.recording = recording;
    this.spreads = recording.channels.map((channel) => robustSpread(channel.data));
    this.pointer = null;
    this.resize();
  }

  setView(start, length, gain) {
    this.start = start;
    this.length = length;
    this.gain = gain;
    // The traces moved under a pointer that stayed still, so it points at something new.
    if (this.pointer !== null) this.hover(this.lastPointer);
    this.schedule();
  }

  secondsFor(pixels) {
    return (pixels / this.plotWidth()) * this.length;
  }

  resize() {
    if (!this.recording) return;
    const { canvas, context } = this;
    const count = this.recording.channels.length;
    const ratio = window.devicePixelRatio || 1;
    this.width = canvas.parentElement.clientWidth;
    this.frameHeight = canvas.parentElement.clientHeight;
    this.rowHeight = Math.max(MIN_ROW, Math.floor((this.frameHeight - AXIS_HEIGHT) / count));
    const height = this.rowHeight * count + AXIS_HEIGHT;

    canvas.width = Math.round(this.width * ratio);
    canvas.height = Math.round(height * ratio);
    canvas.style.height = `${height}px`;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);

    context.font = this.labelFont();
    const widest = Math.max(
      ...this.recording.channels.map(({ label }) => context.measureText(label).width),
    );
    this.gutter = Math.ceil(widest) + 20;
    this.draw();
  }

  labelFont() {
    return '12px "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
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

  // A finger dragged sideways scrolls time. The browser keeps vertical drags.
  touch(event) {
    if (event.pointerType !== 'touch' || !event.isPrimary) return;
    if (this.touchX !== null) this.onScroll(this.touchX - event.clientX);
    this.touchX = event.clientX;
  }

  hover(event) {
    if (!this.recording) return;
    this.lastPointer = event;
    const box = this.canvas.getBoundingClientRect();
    const x = event.clientX - box.left - this.gutter;
    const row = Math.floor((event.clientY - box.top) / this.rowHeight);
    const { channels } = this.recording;
    if (x < 0 || x > this.plotWidth() || row < 0 || row >= channels.length) {
      this.leave();
      return;
    }
    const time = this.start + (x / this.plotWidth()) * this.length;
    const channel = channels[row];
    const index = Math.min(channel.data.length - 1, Math.round(time * channel.fs));
    this.pointer = x;
    this.onHover({ time, channel, value: channel.data[index] });
    this.schedule();
  }

  leave() {
    if (this.pointer === null) return;
    this.pointer = null;
    this.onHover(null);
    this.schedule();
  }

  draw() {
    const { context, recording, gutter, rowHeight } = this;
    if (!recording) return;
    const styles = getComputedStyle(document.documentElement);
    const color = (name) => styles.getPropertyValue(name).trim();
    const count = recording.channels.length;
    const plotHeight = rowHeight * count;
    const plotWidth = this.plotWidth();

    context.clearRect(0, 0, this.width, plotHeight + AXIS_HEIGHT);
    context.font = this.labelFont();
    context.textBaseline = 'middle';

    // Time grid and axis labels.
    const step =
      TICK_STEPS.find((candidate) => (candidate / this.length) * plotWidth >= 64) ??
      TICK_STEPS[TICK_STEPS.length - 1];
    context.strokeStyle = color('--grid');
    context.fillStyle = color('--ink-2');
    context.lineWidth = 1;
    context.textAlign = 'center';
    context.beginPath();
    for (let t = Math.ceil(this.start / step) * step; t <= this.start + this.length; t += step) {
      const x = Math.round(gutter + ((t - this.start) / this.length) * plotWidth) + 0.5;
      context.moveTo(x, 0);
      context.lineTo(x, plotHeight);
      const label = this.length + this.start >= 60 ? formatClock(t) : `${t} s`;
      const clamped = Math.min(this.width - 22, Math.max(gutter + 14, x));
      context.fillText(label, clamped, plotHeight + AXIS_HEIGHT / 2 + 1);
    }
    context.stroke();

    // Channels.
    context.textAlign = 'right';
    context.save();
    context.beginPath();
    context.rect(gutter, 0, plotWidth, plotHeight);
    context.clip();
    context.strokeStyle = color('--trace');
    context.lineWidth = 1;
    context.lineJoin = 'round';
    recording.channels.forEach((channel, row) => {
      this.drawChannel(channel, this.spreads[row], row, plotWidth);
    });
    context.restore();

    context.fillStyle = color('--ink-2');
    recording.channels.forEach((channel, row) => {
      context.fillText(channel.label, gutter - 10, (row + 0.5) * rowHeight);
    });

    if (this.pointer !== null) {
      const x = Math.round(gutter + this.pointer) + 0.5;
      context.strokeStyle = color('--accent');
      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(x, plotHeight);
      context.stroke();
    }
  }

  drawChannel(channel, spread, row, plotWidth) {
    const { context, gutter, rowHeight } = this;
    const { data, fs } = channel;
    const from = Math.max(0, Math.floor(this.start * fs));
    const to = Math.min(data.length, Math.ceil((this.start + this.length) * fs) + 1);
    if (to - from < 2) return;

    let mean = 0;
    for (let i = from; i < to; i += 1) mean += data[i];
    mean /= to - from;

    const middle = (row + 0.5) * rowHeight;
    const pixelsPerUnit = spread > 0 ? ((rowHeight / 2) * 0.55 * this.gain) / (2 * spread) : 0;
    const yOf = (value) => middle - (value - mean) * pixelsPerUnit;
    const samplesPerPixel = (this.length * fs) / plotWidth;

    context.beginPath();
    if (samplesPerPixel <= 2) {
      for (let i = from; i < to; i += 1) {
        const x = gutter + ((i / fs - this.start) / this.length) * plotWidth;
        if (i === from) context.moveTo(x, yOf(data[i]));
        else context.lineTo(x, yOf(data[i]));
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
        if (column === firstColumn) context.moveTo(x, yOf(low));
        else context.lineTo(x, yOf(low));
        context.lineTo(x, yOf(high));
      }
    }
    context.stroke();
  }
}
