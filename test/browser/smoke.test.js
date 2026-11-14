// Opens Ventris in a real Chrome, which jsdom can't stand in for: the Content Security Policy,
// module loading, fonts, canvas drawing and form checks run here as they do for people. It
// drives Chrome over the DevTools protocol with Node's own WebSocket, so it needs no package.
// Chrome comes from CHROME_PATH or the usual places. Without one the tests skip, except in CI,
// where they fail.

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

const TYPES = {
  '.css': 'text/css',
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

function which(name) {
  try {
    return execFileSync('which', [name], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ...['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].map(which),
  ];
  return candidates.find((path) => path && existsSync(path));
}

const chromePath = findChrome();
const skip = !chromePath && !process.env.CI && 'needs Chrome, from CHROME_PATH or the usual places';

// Serves the repository as GitHub Pages would, and notes any file a page asks for that isn't there.
const missing = [];
function serve() {
  const server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    let file = normalize(join(ROOT, path));
    if (!file.startsWith(ROOT.endsWith(sep) ? ROOT : ROOT + sep)) {
      response.writeHead(403).end();
      return;
    }
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!existsSync(file)) {
      missing.push(path);
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    response.end(readFileSync(file));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function launch(profile) {
  // GitHub's Ubuntu runners don't allow Chrome's sandbox.
  const sandbox = process.env.CI ? ['--no-sandbox'] : [];
  const chrome = spawn(
    chromePath,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1280,800',
      ...sandbox,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  return new Promise((resolve, reject) => {
    let said = '';
    chrome.stderr.on('data', (chunk) => {
      said += chunk;
      const listening = /DevTools listening on ws:\/\/([^/]+)\//.exec(said);
      if (listening) resolve({ chrome, host: listening[1] });
    });
    chrome.on('exit', (code) => reject(new Error(`Chrome stopped with code ${code}: ${said}`)));
  });
}

// One tab, driven over the DevTools protocol.
class Tab {
  constructor(socket) {
    this.socket = socket;
    this.sent = 0;
    this.replies = new Map();
    this.events = [];
    this.listeners = [];
    socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data);
      if (message.id) {
        const { resolve, reject } = this.replies.get(message.id);
        this.replies.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
        return;
      }
      this.events.push(message);
      this.listeners = this.listeners.filter(({ method, resolve }) => {
        if (method !== message.method) return true;
        resolve(message.params);
        return false;
      });
    });
  }

  static async open(host) {
    const pages = await (await fetch(`http://${host}/json/list`)).json();
    const { webSocketDebuggerUrl } = pages.find(({ type }) => type === 'page');
    const socket = new WebSocket(webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve);
      socket.addEventListener('error', reject);
    });
    const tab = new Tab(socket);
    await tab.send('Runtime.enable');
    await tab.send('Log.enable');
    await tab.send('Page.enable');
    // A blocked load or script is reported here as well as in the console. Scrollbars take
    // room from the page, as they do on Linux and Windows, where macOS lays them over it.
    await tab.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `window.violations = [];
        addEventListener('securitypolicyviolation', (event) => {
          window.violations.push(event.violatedDirective + ' ' + event.blockedURI);
        });
        const bars = new CSSStyleSheet();
        bars.replaceSync('::-webkit-scrollbar { width: 15px; height: 15px; }');
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, bars];`,
    });
    return tab;
  }

  send(method, params = {}) {
    this.sent += 1;
    const id = this.sent;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.replies.set(id, { resolve, reject }));
  }

  next(method) {
    return new Promise((resolve) => this.listeners.push({ method, resolve }));
  }

  async goto(url) {
    const loaded = this.next('Page.loadEventFired');
    await this.send('Page.navigate', { url });
    await loaded;
  }

  async evaluate(expression) {
    const { result, exceptionDetails } = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (exceptionDetails) {
      throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    }
    return result.value;
  }

  // Waits up to five seconds for an expression to come out true in the page.
  async until(expression) {
    const ready = await this.evaluate(`new Promise((resolve) => {
      const started = performance.now();
      const check = () => {
        if (${expression}) resolve(true);
        else if (performance.now() - started > 5000) resolve(false);
        else requestAnimationFrame(check);
      };
      check();
    })`);
    assert.ok(ready, `timed out waiting for ${expression}`);
  }

  // Errors and warnings from the page, and anything its policy blocked. Chrome's advice on
  // reading a canvas often is left out, since only these tests read the canvases.
  async problems() {
    const reported = this.events.flatMap(({ method, params }) => {
      if (method === 'Runtime.exceptionThrown') {
        const { exception, text } = params.exceptionDetails;
        return [exception?.description ?? text];
      }
      if (method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(params.type)) {
        return [params.args.map(({ value, description }) => value ?? description).join(' ')];
      }
      if (method === 'Log.entryAdded' && ['error', 'warning'].includes(params.entry.level)) {
        return [`${params.entry.text} ${params.entry.url ?? ''}`.trim()];
      }
      return [];
    });
    this.events = [];
    const ours = (text) => text.startsWith('Canvas2D: Multiple readback operations');
    return [
      ...reported.filter((text) => !ours(text)),
      ...(await this.evaluate('window.violations')),
    ];
  }
}

// How many pixels of a canvas have anything drawn on them.
const drawnPixels = (id) => `(() => {
  const canvas = document.getElementById('${id}');
  const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
  let count = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] > 0) count += 1;
  return count;
})()`;

let server;
let chrome;
let tab;
let profile;
let origin;

before(async () => {
  if (skip) return;
  assert.ok(chromePath, 'CI is set but no Chrome was found. Set CHROME_PATH.');
  server = await serve();
  origin = `http://127.0.0.1:${server.address().port}`;
  profile = mkdtempSync(join(tmpdir(), 'ventris-chrome-'));
  const launched = await launch(profile);
  chrome = launched.chrome;
  tab = await Tab.open(launched.host);
});

after(async () => {
  tab?.socket.close();
  if (chrome) {
    const stopped = new Promise((resolve) => chrome.once('exit', resolve));
    chrome.kill();
    await stopped;
  }
  server?.close();
  if (profile) rmSync(profile, { recursive: true, force: true });
});

test(
  'opens on the demo and draws it, with nothing blocked, missing or thrown',
  { skip },
  async () => {
    await tab.goto(`${origin}/`);
    await tab.until(
      `document.getElementById('recording-name').textContent === 'Demo (synthetic data)'`,
    );
    await tab.until(`${drawnPixels('traces')} > 20000 && ${drawnPixels('axis')} > 500`);
    await tab.evaluate('document.fonts.ready');
    assert.equal(await tab.evaluate(`document.fonts.check('12px "JetBrains Mono"')`), true);
    await tab.until(`document.getElementById('band-note').textContent.includes('EEG channel')`);
    assert.match(await tab.evaluate(`document.getElementById('band-note').textContent`), /8 EEG/);
    assert.deepEqual(await tab.problems(), []);
    assert.deepEqual(missing, []);
  },
);

test('the link field takes an address written without https://', { skip }, async () => {
  const valid = await tab.evaluate(`(() => {
    const input = document.getElementById('link-input');
    input.value = 'github.com/nemarDatasets/on003194/blob/main/sub-01/eeg/sub-01_eeg.edf';
    const valid = input.checkValidity();
    input.value = '';
    return valid;
  })()`);
  assert.equal(valid, true);
});

test(
  'a recording of 200 channels keeps the canvas to the rows near the view',
  { skip },
  async () => {
    await tab.evaluate(`(() => {
    const channels = 200;
    const rate = 256;
    const seconds = 60;
    const headerBytes = 256 * (channels + 1);
    const bytes = new Uint8Array(headerBytes + seconds * 2 * rate * channels).fill(32, 0, headerBytes);
    const put = (text, at) => {
      for (let i = 0; i < text.length; i += 1) bytes[at + i] = text.charCodeAt(i);
    };
    put('0', 0);
    put('01.01.26', 168);
    put('00.00.00', 176);
    put(String(headerBytes), 184);
    put(String(seconds), 236);
    put('1', 244);
    put(String(channels), 252);
    let at = 256;
    const column = (width, value) => {
      for (let i = 0; i < channels; i += 1) put(value(i), at + i * width);
      at += width * channels;
    };
    column(16, (i) => 'EEG ' + (i + 1));
    column(80, () => '');
    column(8, () => 'uV');
    column(8, () => '-3276.8');
    column(8, () => '3276.7');
    column(8, () => '-32768');
    column(8, () => '32767');
    column(80, () => '');
    column(8, () => String(rate));
    const samples = new Int16Array(bytes.buffer, headerBytes);
    for (let i = 0; i < samples.length; i += 1) samples[i] = 300 * Math.sin(i / 9);
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], 'many.edf'));
    dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, cancelable: true }));
  })()`);
    await tab.until(`document.getElementById('recording-name').textContent === 'many.edf'`);

    const frame = `document.getElementById('traces').parentElement`;
    const sizes = await tab.evaluate(`({
    canvas: document.getElementById('traces').clientHeight,
    frame: ${frame}.clientHeight,
    plot: ${frame}.scrollHeight,
  })`);
    assert.equal(sizes.plot, 200 * 26);
    assert.equal(sizes.canvas, 2 * sizes.frame);

    await tab.evaluate(`${frame}.scrollTop = 3000`);
    await tab.until(`document.getElementById('traces').style.top !== '0px'`);
    await tab.until(`${drawnPixels('traces')} > 20000`);
    const covers = await tab.evaluate(`(() => {
    const canvas = document.getElementById('traces').getBoundingClientRect();
    const view = ${frame}.getBoundingClientRect();
    return canvas.top <= view.top && canvas.bottom >= view.bottom;
  })()`);
    assert.equal(covers, true);
    assert.deepEqual(await tab.problems(), []);
  },
);

test('the help page opens with nothing blocked, missing or thrown', { skip }, async () => {
  await tab.goto(`${origin}/help/`);
  assert.equal(await tab.evaluate('document.title'), 'Help · Ventris');
  await tab.evaluate('document.fonts.ready');
  assert.deepEqual(await tab.problems(), []);
  assert.deepEqual(missing, []);
});
