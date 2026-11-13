import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

// A canvas context that draws nothing and keeps a list of what it was asked to draw.
export function fakeContext() {
  const calls = [];
  const target = { calls, measureText: (text) => ({ width: text.length * 7 }) };
  return new Proxy(target, {
    get: (object, name) =>
      name in object ? object[name] : (...args) => calls.push({ name, args }),
  });
}

// Loads index.html into jsdom and adds what jsdom leaves out for a page like this one.
export function installDom({ width = 1000, height = 600, url = 'http://localhost/' } = {}) {
  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  const { window } = new JSDOM(html, { url });
  const { document } = window;

  Object.assign(globalThis, {
    window,
    document,
    history: window.history,
    Option: window.Option,
    MutationObserver: window.MutationObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: (callback) => setTimeout(callback, 0),
    ResizeObserver: class {
      observe() {}
    },
    matchMedia: () => ({ addEventListener() {} }),
  });

  document.fonts = { ready: Promise.resolve() };
  const dialog = window.HTMLDialogElement.prototype;
  dialog.showModal = function showModal() {
    this.open = true;
  };
  dialog.close = function close() {
    if (!this.open) return;
    this.open = false;
    this.dispatchEvent(new window.Event('close'));
  };
  window.HTMLCanvasElement.prototype.getContext = function getContext() {
    this.fake ??= fakeContext();
    return this.fake;
  };
  for (const [name, value] of [
    ['clientWidth', width],
    ['clientHeight', height],
  ]) {
    Object.defineProperty(window.HTMLElement.prototype, name, { value, configurable: true });
  }
  return window;
}
