import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { answer } from '../../js/open-worker.js';

// A canvas context that draws nothing and keeps a list of what it was asked to draw.
export function fakeContext() {
  const calls = [];
  const target = { calls, measureText: (text) => ({ width: text.length * 7 }) };
  return new Proxy(target, {
    get: (object, name) =>
      name in object ? object[name] : (...args) => calls.push({ name, args }),
  });
}

// jsdom has no Worker, so this one gives the open worker's own code a stand-in for its scope
// and runs it in a task of its own, as late as a real worker's answer would come. What's sent
// is moved rather than copied, both ways, so a buffer used after it's sent, or sent twice,
// fails here as it would in a browser.
export class FakeWorker {
  constructor(url, options) {
    if (!String(url).endsWith('/js/open-worker.js') || options?.type !== 'module') {
      throw new TypeError(`No worker but the open worker, as a module, runs here: ${url}`);
    }
    this.stopped = false;
    this.scope = new EventTarget();
    this.scope.postMessage = (reply, transfer = []) => {
      const data = structuredClone(reply, { transfer });
      if (!this.stopped) this.onmessage?.({ data });
    };
    answer(this.scope);
  }

  postMessage(message, transfer = []) {
    const data = structuredClone(message, { transfer });
    setTimeout(() => {
      if (!this.stopped) this.scope.dispatchEvent(new MessageEvent('message', { data }));
    }, 0);
  }

  terminate() {
    this.stopped = true;
  }
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
    // Keeps the callback on the element it watches, so that a test can say it has resized.
    ResizeObserver: class {
      constructor(callback) {
        this.callback = callback;
      }

      observe(element) {
        element.resized = this.callback;
      }
    },
    matchMedia: () => ({ addEventListener() {} }),
    Worker: FakeWorker,
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
  window.Element.prototype.setPointerCapture = function setPointerCapture() {};
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
