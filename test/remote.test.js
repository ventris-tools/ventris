import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { download, LinkError, NEMAR_GITHUB, OPENNEURO, resolveLink } from '../js/remote.js';

const FILE = 'sub-01/ses-1/eeg/sub-01_ses-1_task-rest_eeg.edf';
const GITHUB = `https://github.com/nemarDatasets/on003194/blob/main/${FILE}`;

const rejects = (text, message) =>
  assert.throws(
    () => resolveLink(text),
    (error) => error instanceof LinkError && message.test(error.message),
  );

test('reads a GitHub link into the OpenNeuro copy and the pointer beside it', () => {
  assert.deepEqual(resolveLink(GITHUB), {
    name: 'sub-01_ses-1_task-rest_eeg.edf',
    dataset: 'ds003194',
    link: GITHUB,
    dataUrl: `${OPENNEURO}ds003194/${FILE}`,
    pointerUrl: `${NEMAR_GITHUB}on003194/main/${FILE}`,
  });
});

test('keeps a branch whose name holds slashes', () => {
  const raw = `https://raw.githubusercontent.com/nemarDatasets/on003194/release/v2.0.0/${FILE}`;
  assert.equal(resolveLink(raw).pointerUrl, `${NEMAR_GITHUB}on003194/release/v2.0.0/${FILE}`);
  const page = `https://github.com/nemarDatasets/On003194/raw/refs/heads/main/${FILE}`;
  assert.equal(resolveLink(page).pointerUrl, `${NEMAR_GITHUB}On003194/refs/heads/main/${FILE}`);
});

test('opens an OpenNeuro address as it is, with nothing to check it against', () => {
  const pathStyle = resolveLink(`  s3.amazonaws.com/openneuro.org/ds003194/${FILE}  `);
  assert.equal(pathStyle.dataUrl, `${OPENNEURO}ds003194/${FILE}`);
  assert.equal(pathStyle.link, `https://s3.amazonaws.com/openneuro.org/ds003194/${FILE}`);
  assert.equal(pathStyle.pointerUrl, null);
  const hostStyle = resolveLink(`https://openneuro.org.s3.amazonaws.com/ds003194/${FILE}`);
  assert.equal(hostStyle.dataUrl, `${OPENNEURO}ds003194/${FILE}`);
});

test('names the file as it reads, and accepts the extension in capitals', () => {
  const spaced = resolveLink(`${OPENNEURO}ds000001/sub-01/eeg/sub-01%20rest_eeg.EDF`);
  assert.equal(spaced.name, 'sub-01 rest_eeg.EDF');
  const broken = resolveLink(`${OPENNEURO}ds000001/sub-01/eeg/sub-01%E0%A4%A_eeg.edf`);
  assert.equal(broken.name, 'sub-01%E0%A4%A_eeg.edf');
});

test("says why NEMAR's own datasets can't be opened yet", () => {
  rejects(
    'https://github.com/nemarDatasets/nm000109/blob/main/sub-00/eeg/sub-00_eeg.edf',
    /NEMAR's own datasets, named nm…, can't be opened in a browser yet/,
  );
});

test('turns away links that are not to one EDF recording', () => {
  rejects('', /doesn't look like a web address/);
  rejects('https://example.com/sub-01_eeg.edf', /NEMAR datasets on GitHub, or to OpenNeuro/);
  rejects(`https://github.com/someone/on003194/blob/main/${FILE}`, /nemarDatasets organization/);
  rejects('https://github.com/', /nemarDatasets organization/);
  rejects(`https://github.com/nemarDatasets/xx000001/blob/main/${FILE}`, /isn't a NEMAR dataset/);
  rejects(`https://raw.githubusercontent.com/nemarDatasets`, /dataset or a folder/);
  rejects('https://github.com/nemarDatasets/on003194', /dataset or a folder/);
  rejects('https://github.com/nemarDatasets/on003194/tree/main/sub-01', /dataset or a folder/);
  rejects('https://github.com/nemarDatasets/on003194/blob/main/README', /dataset or a folder/);
  rejects(`${OPENNEURO}ds003194`, /dataset or a folder/);
  rejects(`${OPENNEURO}datasets/${FILE}`, /dataset or a folder/);
  rejects(
    `https://github.com/nemarDatasets/on004362/blob/main/sub-001/eeg/sub-001_eeg.set`,
    /EDF files only, and this one is to a \.set file/,
  );
  rejects(`${OPENNEURO}ds003194/sub-01/eeg`, /EDF files only, and this one is to something else/);
});

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const bytesOf = (length) => Uint8Array.from({ length }, (_, i) => i % 251);

// A response whose body arrives in the given chunks, as a download does.
function streamed(chunks, headers = {}) {
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(body, { headers });
}

// Stands in for fetch, answering each address from a table and keeping a list of the calls.
function fakeFetch(t, answers) {
  return t.mock.method(globalThis, 'fetch', async (url, options) => {
    const answer = answers[url];
    if (answer === undefined) return new Response('', { status: 404 });
    return typeof answer === 'function' ? answer(options) : answer;
  });
}

const target = resolveLink(GITHUB);
const pointerFor = (bytes, backend = 'SHA256E', hash = sha256(bytes)) =>
  `../../.git/annex/objects/Ab/Cd/${backend}-s${bytes.length}--${hash}.edf/${backend}-s${bytes.length}--${hash}.edf`;

test('downloads a recording, checks it against its pointer and reports progress', async (t) => {
  const bytes = bytesOf(5000);
  const calls = fakeFetch(t, {
    [target.pointerUrl]: new Response(pointerFor(bytes)),
    [target.dataUrl]: streamed([bytes.slice(0, 3000), bytes.slice(3000)]),
  });
  const progress = [];
  const buffer = await download(target, { onProgress: (...args) => progress.push(args) });
  assert.deepEqual(new Uint8Array(buffer), bytes);
  assert.deepEqual(progress, [
    [3000, 5000],
    [5000, 5000],
  ]);
  for (const { arguments: args } of calls.mock.calls) {
    assert.equal(args[1].credentials, 'omit');
    assert.equal(args[1].referrerPolicy, 'no-referrer');
  }
});

const hashOf = (algorithm, bytes) => createHash(algorithm).update(bytes).digest('hex');

test('checks the hash of every backend that has one, MD5 and the SHA family alike', async (t) => {
  const bytes = bytesOf(3000);
  const backends = { MD5E: 'md5', MD5: 'md5', SHA1E: 'sha1', SHA384E: 'sha384', SHA512: 'sha512' };
  for (const [backend, algorithm] of Object.entries(backends)) {
    const pointer = pointerFor(bytes, backend, hashOf(algorithm, bytes));
    const chunks = [bytes.slice(0, 1000), bytes.slice(1000, 1001), bytes.slice(1001)];
    fakeFetch(t, {
      [target.pointerUrl]: new Response(pointer),
      [target.dataUrl]: streamed(chunks),
    });
    assert.deepEqual(new Uint8Array(await download(target)), bytes, backend);

    const wrong = pointerFor(bytes, backend, hashOf(algorithm, bytesOf(10)));
    fakeFetch(t, {
      [target.pointerUrl]: new Response(wrong),
      [target.dataUrl]: streamed(chunks),
    });
    await assert.rejects(download(target), /doesn't match the version the link is to/, backend);
  }
});

test('checks only the size when the backend has no hash it can check', async (t) => {
  const bytes = bytesOf(300);
  for (const pointer of [
    `/annex/objects/WORM-s300-m1700000000--sub-01_eeg.edf\n`,
    `/annex/objects/SHA3_256E-s300--${'0'.repeat(64)}.edf\n`,
  ]) {
    fakeFetch(t, {
      [target.pointerUrl]: new Response(pointer),
      [target.dataUrl]: streamed([bytes]),
    });
    assert.deepEqual(new Uint8Array(await download(target)), bytes, pointer);
  }
});

test('stops reading a copy the moment it runs past the size in the pointer', async (t) => {
  const bytes = bytesOf(400);
  let pulls = 0;
  const body = new ReadableStream({
    pull(controller) {
      pulls += 1;
      controller.enqueue(bytes.slice(0, 300));
    },
  });
  fakeFetch(t, {
    [target.pointerUrl]: new Response(pointerFor(bytesOf(400))),
    [target.dataUrl]: new Response(body),
  });
  await assert.rejects(download(target), /doesn't match the version the link is to/);
  assert.ok(pulls <= 3, `read ${pulls} chunks`);
});

test('downloads no more than the limit, whatever the pointer or the server says', async (t) => {
  const bytes = bytesOf(2000);
  const message = /larger than 0\.000001 GB, the most Ventris downloads by link/;
  const calls = fakeFetch(t, {
    [target.pointerUrl]: new Response(pointerFor(bytes)),
    [target.dataUrl]: streamed([bytes]),
  });
  await assert.rejects(download(target, { most: 1000 }), message);
  assert.equal(calls.mock.callCount(), 1);

  const direct = { ...target, pointerUrl: null };
  fakeFetch(t, { [target.dataUrl]: streamed([bytes], { 'content-length': '2000' }) });
  await assert.rejects(download(direct, { most: 1000 }), message);
  fakeFetch(t, { [target.dataUrl]: streamed([bytes.slice(0, 600), bytes.slice(600)]) });
  await assert.rejects(download(direct, { most: 1000 }), message);
  fakeFetch(t, { [target.dataUrl]: streamed([bytes.slice(0, 600), bytes.slice(600, 1000)]) });
  assert.equal((await download(direct, { most: 1000 })).byteLength, 1000);
});

test('says when the connection drops part way, and lets a stop end as an abort', async (t) => {
  const failing = (error) =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(bytesOf(100));
          controller.error(error);
        },
      }),
    );
  const direct = { ...target, pointerUrl: null };
  fakeFetch(t, { [target.dataUrl]: () => failing(new TypeError('network error')) });
  await assert.rejects(download(direct), /stopped part way\. Check your connection/);
  fakeFetch(t, { [target.dataUrl]: () => failing(new DOMException('Stopped.', 'AbortError')) });
  await assert.rejects(download(direct), { name: 'AbortError' });
});

test('refuses a copy that differs from the version the link is to', async (t) => {
  const bytes = bytesOf(400);
  const answers = {
    [target.pointerUrl]: new Response(pointerFor(bytes, 'SHA256E', 'f'.repeat(64))),
    [target.dataUrl]: streamed([bytes]),
  };
  fakeFetch(t, answers);
  await assert.rejects(download(target), /doesn't match the version the link is to/);

  answers[target.pointerUrl] = new Response(pointerFor(bytesOf(399)));
  answers[target.dataUrl] = streamed([bytes]);
  await assert.rejects(download(target), /doesn't match the version the link is to/);
});

test('takes a file kept in git itself straight from GitHub', async (t) => {
  const bytes = bytesOf(2000);
  const calls = fakeFetch(t, { [target.pointerUrl]: new Response(bytes) });
  assert.deepEqual(new Uint8Array(await download(target)), bytes);
  assert.equal(calls.mock.callCount(), 1);

  const small = new TextEncoder().encode('0       not a pointer');
  fakeFetch(t, { [target.pointerUrl]: new Response(small) });
  assert.deepEqual(new Uint8Array(await download(target)), small);
});

test('says when the file is missing from GitHub or from OpenNeuro', async (t) => {
  fakeFetch(t, {});
  await assert.rejects(download(target), /isn't in that version of the dataset/);
  fakeFetch(t, { [target.pointerUrl]: new Response(pointerFor(bytesOf(10))) });
  await assert.rejects(download(target), /OpenNeuro doesn't have this file/);
  fakeFetch(t, { [target.dataUrl]: new Response('', { status: 403 }) });
  await assert.rejects(download({ ...target, pointerUrl: null }), /doesn't have this file/);
});

test('reports a server error and a lost connection in words', async (t) => {
  fakeFetch(t, { [target.pointerUrl]: new Response('', { status: 503 }) });
  await assert.rejects(download(target), /failed with HTTP status 503/);
  t.mock.method(globalThis, 'fetch', () => Promise.reject(new TypeError('Failed to fetch')));
  await assert.rejects(download(target), /could not be downloaded\. Check your connection/);
});

test('lets a cancelled download end as an abort, not as a failure', async (t) => {
  t.mock.method(globalThis, 'fetch', () =>
    Promise.reject(new DOMException('The user aborted a request.', 'AbortError')),
  );
  await assert.rejects(download(target), { name: 'AbortError' });
});

test('grows the buffer when the size is not known, and trims it at the end', async (t) => {
  const bytes = bytesOf(700);
  const direct = { ...target, pointerUrl: null };
  const progress = [];
  fakeFetch(t, {
    [target.dataUrl]: streamed([bytes.slice(0, 100), bytes.slice(100, 150), bytes.slice(150)]),
  });
  const buffer = await download(direct, { onProgress: (...args) => progress.push(args) });
  assert.deepEqual(new Uint8Array(buffer), bytes);
  assert.equal(buffer.byteLength, 700);
  assert.deepEqual(
    progress.map(([, total]) => total),
    [0, 0, 0],
  );

  fakeFetch(t, { [target.dataUrl]: streamed([bytes], { 'content-length': '700' }) });
  assert.deepEqual(new Uint8Array(await download(direct, { onProgress() {} })), bytes);
});
