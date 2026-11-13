import assert from 'node:assert/strict';
import test from 'node:test';
import {
  baseline,
  eventColors,
  levelAt,
  robustSpread,
  sidewaysPixels,
  tickStep,
  TraceView,
  windowChoices,
} from '../js/traces.js';
import { installDom } from './support/dom.js';

const wheel = (event) => ({ deltaX: 0, deltaY: 0, deltaMode: 0, shiftKey: false, ...event });

test('sideways wheel movement keeps its size and direction', () => {
  assert.equal(sidewaysPixels(wheel({ deltaX: 30 }), 1000), 30);
  assert.equal(sidewaysPixels(wheel({ deltaX: -30 }), 1000), -30);
});

test('leaves mostly vertical movement to the browser', () => {
  assert.equal(sidewaysPixels(wheel({ deltaY: 30 }), 1000), 0);
  assert.equal(sidewaysPixels(wheel({ deltaX: 5, deltaY: 30 }), 1000), 0);
  assert.equal(sidewaysPixels(wheel({ deltaX: 30, deltaY: 30 }), 1000), 0);
});

test('takes a diagonal swipe as sideways when that is the larger part', () => {
  assert.equal(sidewaysPixels(wheel({ deltaX: 30, deltaY: 5 }), 1000), 30);
});

test('Shift turns a vertical wheel sideways', () => {
  assert.equal(sidewaysPixels(wheel({ deltaY: 30, shiftKey: true }), 1000), 30);
  assert.equal(sidewaysPixels(wheel({ deltaX: 30, shiftKey: true }), 1000), 30);
});

test('converts wheels that count in lines or pages', () => {
  assert.equal(sidewaysPixels(wheel({ deltaX: 3, deltaMode: 1 }), 1000), 48);
  assert.equal(sidewaysPixels(wheel({ deltaX: 1, deltaMode: 2 }), 1000), 1000);
});

// A mostly constant channel: it rests on zero and has one burst.
const sparse = () => {
  const data = new Float32Array(25600);
  for (let i = 12000; i < 12800; i += 1) data[i] = 80 * Math.sin(i / 5);
  return data;
};

test('a channel that mostly rests on one value still has a spread', () => {
  assert.ok(robustSpread(sparse()) > 5);
  assert.equal(robustSpread(new Float32Array(100)), 0);
});

test('a blink does not widen the spread', () => {
  const data = Float32Array.from({ length: 1000 }, (_, i) => Math.sin(i / 3));
  const quiet = robustSpread(data);
  data.fill(500, 400, 420);
  assert.ok(robustSpread(data) < quiet * 1.2);
});

test('a blink does not move the baseline', () => {
  const data = new Float32Array(256 * 60);
  data.fill(300, 2000, 2100);
  assert.deepEqual([...baseline(data, 256).levels], [0, 0]);
});

test('the baseline follows slow drift between the middles of its blocks', () => {
  const data = Float32Array.from({ length: 256 * 90 }, (_, i) => Math.floor(i / (256 * 30)) * 100);
  const level = baseline(data, 256);
  assert.deepEqual([...level.levels], [0, 100, 200]);
  assert.equal(levelAt(level, 0), 0);
  assert.equal(levelAt(level, 256 * 15), 0);
  assert.equal(levelAt(level, 256 * 30), 50);
  assert.equal(levelAt(level, 256 * 45), 100);
  assert.equal(levelAt(level, 256 * 90), 200);
});

test('a recording shorter than a block has one level', () => {
  const level = baseline(new Float32Array(100).fill(7), 256);
  assert.deepEqual([...level.levels], [7]);
  assert.equal(levelAt(level, 50), 7);
});

const channels = (count, fs) => Array.from({ length: count }, () => ({ fs }));

test('offers the whole file when it fits', () => {
  const overnight = { channels: channels(2, 100), duration: 28800 };
  assert.deepEqual(windowChoices(overnight), [5, 10, 30, 60, 300, 1800, 3600, 7200, 28800]);
  assert.deepEqual(windowChoices({ channels: channels(8, 256), duration: 60 }), [5, 10, 30, 60]);
  assert.deepEqual(windowChoices({ channels: channels(1, 256), duration: 12.5 }), [5, 10, 12.5]);
  assert.deepEqual(windowChoices({ channels: channels(1, 256), duration: 3 }), [3]);
});

test('keeps long windows from dense recordings', () => {
  const dense = { channels: channels(64, 1024), duration: 28800 };
  assert.deepEqual(windowChoices(dense), [5, 10, 30, 60, 300]);
  const huge = { channels: channels(1000, 8192), duration: 28800 };
  assert.deepEqual(windowChoices(huge), [5]);
});

test('spaces ticks by the width of their labels', () => {
  assert.equal(tickStep(5, 1200, 40), 0.5);
  assert.equal(tickStep(10, 600, 40), 1);
  assert.equal(tickStep(28800, 1000, 40), 1800);
});

test('counts ticks in whole days past the longest step', () => {
  const step = tickStep(1e9, 1000, 40);
  assert.ok(step > 86400);
  assert.equal(step % 86400, 0);
});

const events = (...texts) => texts.map((text, time) => ({ time, duration: 0, text }));

test('annotations with the same text share a colour, and different texts differ', () => {
  const colors = eventColors(events('Blink', 'Eyes closed', 'Blink', 'Eyes open'));
  assert.equal(colors[0], colors[2]);
  assert.equal(new Set(colors).size, 3);
});

test('the commonest kinds take the first colours, and ties keep their order', () => {
  const colors = eventColors(events('Note', 'Spike', 'Arousal', 'Spike', 'Spike', 'Arousal'));
  assert.deepEqual(colors, [
    '--event-3',
    '--event-1',
    '--event-2',
    '--event-1',
    '--event-1',
    '--event-2',
  ]);
});

test('reads a kind past its case and spacing', () => {
  const colors = eventColors(events('Eyes closed', 'eyes closed ', 'EYES CLOSED'));
  assert.equal(new Set(colors).size, 1);
});

test('kinds past the palette share the grey of secondary text', () => {
  const texts = Array.from({ length: 6 }, (_, index) => `Kind ${index}`);
  const colors = eventColors(events(...texts));
  assert.deepEqual(colors, [
    '--event-1',
    '--event-2',
    '--event-3',
    '--event-4',
    '--ink-2',
    '--ink-2',
  ]);
});

const window = installDom();

function viewOf(recording) {
  const frame = window.document.createElement('div');
  const canvas = window.document.createElement('canvas');
  const axis = window.document.createElement('canvas');
  frame.append(canvas);
  window.document.body.append(frame, axis);
  const hits = [];
  const view = new TraceView(
    canvas,
    axis,
    (hit, announce) => hits.push({ hit, announce }),
    () => {},
  );
  view.setRecording({ annotations: [], ...recording });
  return { view, canvas, axis, hits };
}

const called = (canvas, name) => canvas.getContext('2d').calls.filter((call) => call.name === name);
const drawn = (canvas) => called(canvas, 'fillText').map(({ args }) => args[0]);

function traceHeight(canvas) {
  const ys = called(canvas, 'lineTo').map(({ args }) => args[1]);
  return Math.max(...ys) - Math.min(...ys);
}

const oneChannel = (data, fs = 256) => ({
  channels: [{ label: 'Cz', unit: 'uV', fs, data }],
  duration: data.length / fs,
});

const twoRows = () => ({
  channels: ['Cz', 'Pz'].map((label) => ({
    label,
    unit: 'uV',
    fs: 256,
    data: new Float32Array(2560),
  })),
  duration: 10,
});

test('draws a burst on a channel that mostly rests on one value', () => {
  const { view, canvas } = viewOf(oneChannel(sparse()));
  view.setView(45, 10, 1);
  canvas.getContext('2d').calls.length = 0;
  view.draw();
  assert.ok(traceHeight(canvas) > 20, `trace height was ${traceHeight(canvas)}`);
});

test('a sample sits at the same height wherever the window has scrolled to', () => {
  const data = Float32Array.from({ length: 256 * 60 }, (_, i) => 40 * Math.sin(i / 9) + i / 100);
  data.fill(900, 256 * 21, 256 * 21 + 40);
  const { view, canvas } = viewOf(oneChannel(data));
  const heights = (start) => {
    view.setView(start, 5, 1);
    canvas.getContext('2d').calls.length = 0;
    view.draw();
    return called(canvas, 'lineTo').map(({ args }) => args[1]);
  };
  const first = heights(20);
  const second = heights(22);
  const shift = 2 * 256;
  // Past the grid lines and into the trace, where samples line up one to one.
  const samples = first.slice(-200, -100);
  assert.deepEqual(second.slice(-200 - shift, -100 - shift), samples);
});

test('labels each row with its range, and a flat row as flat', () => {
  const { view, canvas } = viewOf({
    channels: [
      { label: 'Cz', unit: 'uV', fs: 256, data: Float32Array.from({ length: 2560 }, Math.random) },
      { label: 'Pz', unit: 'uV', fs: 256, data: new Float32Array(2560) },
    ],
    duration: 10,
  });
  view.setView(0, 10, 1);
  view.draw();
  assert.ok(drawn(canvas).some((text) => /^±[\d.,]+ µV$/.test(text)));
  assert.ok(drawn(canvas).includes('flat'));
});

test('never repeats a label on the time axis', () => {
  const { view, axis } = viewOf(oneChannel(new Float32Array(256 * 60)));
  view.setView(55, 5, 1);
  axis.getContext('2d').calls.length = 0;
  view.draw();
  const labels = drawn(axis);
  assert.ok(labels.includes('0:55.5'));
  assert.equal(new Set(labels).size, labels.length);
});

test('keeps the same clock format as the view scrolls past a minute', () => {
  const { view, axis } = viewOf(oneChannel(new Float32Array(256 * 120)));
  view.setView(45, 10, 1);
  view.draw();
  assert.ok(drawn(axis).every((label) => /^\d+:\d\d/.test(label)));
});

test('writes annotation names on the axis and marks them on the traces', () => {
  const recording = oneChannel(new Float32Array(256 * 60));
  const annotations = [
    { time: 2, duration: 0, text: 'Eyes closed' },
    { time: 5, duration: 2, text: 'Seizure onset' },
    { time: 40, duration: 0, text: 'Later' },
  ];
  const { view, canvas, axis } = viewOf({ ...recording, annotations });
  view.setView(0, 10, 1);
  canvas.getContext('2d').calls.length = 0;
  view.draw();
  assert.ok(drawn(axis).includes('Eyes closed'));
  assert.ok(!drawn(axis).includes('Later'));
  assert.equal(called(canvas, 'fillRect').length, 1);
  assert.equal(axis.style.height, '44px');
});

// The colours each canvas was set to, in order.
function paints(canvas, property) {
  const values = [];
  Object.defineProperty(canvas.getContext('2d'), property, {
    set: (value) => {
      values.push(value);
    },
    configurable: true,
  });
  return values;
}

test('marks and names each kind of annotation in its own colour', () => {
  const root = window.document.documentElement;
  const palette = { '--event-1': '#111111', '--event-2': '#222222', '--ink': '#000000' };
  for (const [name, value] of Object.entries(palette)) root.style.setProperty(name, value);
  const annotations = [
    { time: 1, duration: 0, text: 'Blink' },
    { time: 3, duration: 0, text: 'Eyes closed' },
    { time: 5, duration: 0, text: 'Blink' },
  ];
  const { view, canvas, axis } = viewOf({ ...oneChannel(new Float32Array(2560)), annotations });
  view.setView(0, 10, 1);
  const lines = paints(canvas, 'strokeStyle');
  const names = paints(axis, 'fillStyle');
  view.draw();
  for (const name of Object.keys(palette)) root.style.removeProperty(name);

  // The grid and the traces read colours this test leaves unset, so they come back empty.
  assert.deepEqual(lines.filter(Boolean), ['#111111', '#222222', '#111111']);
  // Each name's mark in its colour, then the name itself in ink.
  assert.deepEqual(names.slice(-6), [
    '#111111',
    '#000000',
    '#222222',
    '#000000',
    '#111111',
    '#000000',
  ]);
});

test('leaves room for a time axis of the usual height without annotations', () => {
  const { axis } = viewOf(oneChannel(new Float32Array(2560)));
  assert.equal(axis.style.height, '26px');
});

test('a new recording clears the reading of the last one', () => {
  const { view, hits } = viewOf(oneChannel(new Float32Array(2560)));
  view.setView(0, 10, 1);
  view.moveCursor(10, 0, false);
  view.setRecording({ annotations: [], ...oneChannel(new Float32Array(2560)) });
  assert.equal(hits.at(-1).hit, null);
});

test('the keyboard moves a cursor across channels and through the window', () => {
  const data = Float32Array.from({ length: 2560 }, (_, i) => i);
  const { view, canvas, hits } = viewOf({
    channels: [
      { label: 'Cz', unit: 'uV', fs: 256, data },
      { label: 'Pz', unit: 'uV', fs: 256, data },
    ],
    duration: 10,
  });
  view.setView(0, 10, 1);
  canvas.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  assert.equal(hits.at(-1).hit.channel.label, 'Pz');
  assert.equal(hits.at(-1).announce, true);
  const before = hits.at(-1).hit.time;
  canvas.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.ok(hits.at(-1).hit.time > before);
});

test('tells a keyboard user the new reading when the window moves', () => {
  const { view, canvas, hits } = viewOf(oneChannel(new Float32Array(2560)));
  view.setView(0, 5, 1);
  view.moveCursor(10, 0, false);
  view.setView(1, 5, 1);
  assert.equal(hits.at(-1).announce, false);
  canvas.tabIndex = 0;
  canvas.focus();
  view.setView(2, 5, 1);
  assert.equal(hits.at(-1).announce, true);
  canvas.blur();
});

test('redraws when the theme changes', async () => {
  const { canvas } = viewOf(oneChannel(new Float32Array(2560)));
  const context = canvas.getContext('2d');
  context.calls.length = 0;
  window.document.documentElement.dataset.theme = 'dark';
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(context.calls.some(({ name }) => name === 'clearRect'));
});

test('the mouse reads a value and leaving clears it', () => {
  const { view, canvas, hits } = viewOf(oneChannel(new Float32Array(2560)));
  view.setView(0, 10, 1);
  canvas.dispatchEvent(new window.MouseEvent('pointermove', { clientX: 300, clientY: 50 }));
  assert.equal(hits.at(-1).hit.channel.label, 'Cz');
  assert.equal(hits.at(-1).announce, false);
  canvas.dispatchEvent(new window.MouseEvent('pointerleave'));
  assert.equal(hits.at(-1).hit, null);
});

test('leaving the plot for the row labels clears the reading', () => {
  const { view, canvas, hits } = viewOf(oneChannel(new Float32Array(2560)));
  view.setView(0, 10, 1);
  canvas.dispatchEvent(new window.MouseEvent('pointermove', { clientX: 300, clientY: 50 }));
  canvas.dispatchEvent(new window.MouseEvent('pointermove', { clientX: 1, clientY: 50 }));
  assert.equal(hits.at(-1).hit, null);
  assert.equal(view.cursor, null);
});

test('a finger dragged sideways scrolls by how far it moved, and lifting it ends the drag', () => {
  const scrolled = [];
  const { view, canvas } = viewOf(oneChannel(new Float32Array(2560)));
  view.onScroll = (pixels) => scrolled.push(pixels);
  const touch = (type, clientX) => {
    const event = new window.MouseEvent(type, { clientX, clientY: 50 });
    Object.assign(event, { pointerType: 'touch', isPrimary: true });
    canvas.dispatchEvent(event);
  };
  touch('pointerdown', 300);
  touch('pointermove', 280);
  touch('pointerup', 280);
  touch('pointerdown', 100);
  assert.deepEqual(scrolled, [20]);
});

test('the keyboard scrolls the rows to keep the cursor in view', () => {
  const channels = Array.from({ length: 40 }, (_, row) => ({
    label: `C${row}`,
    unit: 'uV',
    fs: 256,
    data: new Float32Array(2560),
  }));
  const { view, canvas } = viewOf({ channels, duration: 10 });
  view.setView(0, 10, 1);
  const frame = canvas.parentElement;
  view.moveCursor(10, 39, false);
  view.reveal(39);
  assert.equal(frame.scrollTop, view.rowHeight * 40 - frame.clientHeight);
  view.reveal(0);
  assert.equal(frame.scrollTop, 0);
});

test('a keyboard user lands on a cursor in the first row in view, and the mouse does not', () => {
  const { view, canvas, hits } = viewOf(oneChannel(new Float32Array(2560)));
  view.setView(0, 10, 1);
  canvas.matches = () => false;
  canvas.dispatchEvent(new window.FocusEvent('focus'));
  assert.equal(view.cursor, null);
  canvas.matches = () => true;
  canvas.dispatchEvent(new window.FocusEvent('focus'));
  assert.equal(view.cursor.row, 0);
  assert.equal(hits.at(-1).announce, true);
  canvas.dispatchEvent(new window.FocusEvent('focus'));
  assert.equal(hits.at(-1).announce, true);
});

test('the cursor shades its row and marks its place, behind and in front of the traces', () => {
  const { view, canvas } = viewOf(twoRows());
  view.setView(0, 10, 1);
  const shading = canvas.previousElementSibling;
  const line = canvas.nextElementSibling;
  assert.deepEqual([shading.hidden, line.hidden], [true, true]);

  view.moveCursor(100.4, 1, false);
  assert.deepEqual([shading.hidden, line.hidden], [false, false]);
  assert.equal(shading.style.top, `${view.rowHeight}px`);
  assert.equal(shading.style.height, `${view.rowHeight}px`);
  assert.equal(shading.style.left, `${view.gutter}px`);
  assert.equal(shading.style.width, `${view.plotWidth()}px`);
  assert.equal(line.style.left, `${Math.round(view.gutter + 100.4)}px`);
  assert.equal(line.style.height, `${view.rowHeight * 2}px`);

  view.leave();
  assert.deepEqual([shading.hidden, line.hidden], [true, true]);
});

test('pointing at a trace redraws nothing', async () => {
  const { view, canvas } = viewOf(oneChannel(new Float32Array(2560)));
  view.setView(0, 10, 1);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const context = canvas.getContext('2d');
  context.calls.length = 0;
  view.moveCursor(100, 0, false);
  view.leave();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(context.calls, []);
});

test('the cursor follows the rows when the view changes size', () => {
  const { view, canvas } = viewOf(twoRows());
  view.setView(0, 10, 1);
  view.moveCursor(100, 1, false);
  const before = view.rowHeight;
  Object.defineProperty(canvas.parentElement, 'clientHeight', { value: 2000 });
  view.resize();
  assert.ok(view.rowHeight > before);
  assert.equal(canvas.previousElementSibling.style.top, `${view.rowHeight}px`);
});

test('a new recording draws only once its window arrives', () => {
  const { view, canvas } = viewOf(oneChannel(new Float32Array(2560)));
  const context = canvas.getContext('2d');
  context.calls.length = 0;
  view.setRecording({ annotations: [], ...oneChannel(new Float32Array(2560)) });
  assert.deepEqual(called(canvas, 'clearRect'), []);
});

test('a new recording removes the cursor from the screen', () => {
  const { view, canvas } = viewOf(oneChannel(new Float32Array(2560)));
  view.setView(0, 10, 1);
  view.moveCursor(100, 0, false);
  view.setRecording({ annotations: [], ...oneChannel(new Float32Array(2560)) });
  assert.equal(canvas.nextElementSibling.hidden, true);
});
