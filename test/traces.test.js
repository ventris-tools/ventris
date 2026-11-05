import assert from 'node:assert/strict';
import test from 'node:test';
import { sidewaysPixels } from '../js/traces.js';

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
