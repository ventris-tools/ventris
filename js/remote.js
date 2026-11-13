// Opens a public recording from a link to NEMAR or OpenNeuro. This is the only module allowed
// to use the network, and it only ever downloads: it sends nothing but the address it asks for.
// The Content Security Policy in index.html lets it reach the two places below and nowhere else.

// OpenNeuro's public bucket, which keeps each file under its path in the dataset.
export const OPENNEURO = 'https://s3.amazonaws.com/openneuro.org/';

// NEMAR's datasets on GitHub. A recording there is a git-annex pointer to the real file, a few
// hundred bytes that name its size and its SHA-256 hash.
export const NEMAR_GITHUB = 'https://raw.githubusercontent.com/nemarDatasets/';

// A git-annex pointer is the key on its own or at the end of a path. The key holds the backend,
// the size in bytes and, after the double dash, the hash with the file's extension.
const ANNEX_KEY = /(?:^|\/)([A-Z0-9]+)-s(\d+)(?:-[A-Za-z]\d+)*--([0-9a-f]+)[^/]*$/;

// Anything this long is the file itself rather than a pointer to it.
const POINTER_LIMIT = 1024;

export class LinkError extends Error {}

const segmentsOf = (url) => url.pathname.split('/').filter(Boolean);

const notOneFile = () =>
  new LinkError(
    'This link is to a dataset or a folder. Link to one recording in it, a file ending in .edf.',
  );

function decoded(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function nemarDataset(repo) {
  const mirrored = /^on(\d{6})$/i.exec(repo);
  if (mirrored) return `ds${mirrored[1]}`;
  if (/^nm\d+$/i.test(repo)) {
    throw new LinkError(
      "NEMAR's own datasets, named nm…, can't be opened in a browser yet. The ones it mirrors from OpenNeuro, named on…, can.",
    );
  }
  throw new LinkError(`${repo} isn't a NEMAR dataset that Ventris can open.`);
}

// GitHub puts the branch or tag before the path, and a branch name can hold slashes. Recordings
// always sit in a subject folder, so the path starts at the first segment named sub-.
function splitRef(rest) {
  const start = rest.findIndex((segment) => segment.startsWith('sub-'));
  if (start < 1) throw notOneFile();
  return { ref: rest.slice(0, start), path: rest.slice(start) };
}

// A page on github.com has blob or raw between the dataset and the branch, where
// raw.githubusercontent.com has nothing, so both arrive here in the github.com form.
function fromGitHub([owner, repo, kind, ...rest]) {
  if (owner?.toLowerCase() !== 'nemardatasets') {
    throw new LinkError('Ventris opens links to the nemarDatasets organization on GitHub.');
  }
  if (!repo) throw notOneFile();
  const dataset = nemarDataset(repo);
  if (kind !== 'blob' && kind !== 'raw') throw notOneFile();
  return { repo, dataset, ...splitRef(rest) };
}

function fromOpenNeuro(segments) {
  const [dataset, ...path] = segments;
  if (!/^ds\d{6}$/.test(dataset) || path.length === 0) throw notOneFile();
  return { dataset, path };
}

// Reads a link into the addresses to download from. GitHub links also name the pointer, so the
// download can be checked against the version of the dataset the link is to.
export function resolveLink(text) {
  const trimmed = text.trim();
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    throw new LinkError("That doesn't look like a web address.");
  }

  const segments = segmentsOf(url);
  let source;
  if (url.hostname === 'github.com') source = fromGitHub(segments);
  else if (url.hostname === 'raw.githubusercontent.com') {
    const [owner, repo, ...rest] = segments;
    source = fromGitHub([owner, repo, 'raw', ...rest]);
  } else if (url.hostname === 's3.amazonaws.com' && segments[0] === 'openneuro.org') {
    source = fromOpenNeuro(segments.slice(1));
  } else if (url.hostname === 'openneuro.org.s3.amazonaws.com') {
    source = fromOpenNeuro(segments);
  } else {
    throw new LinkError('Ventris opens links to NEMAR datasets on GitHub, or to OpenNeuro on S3.');
  }

  const { repo, ref, dataset, path } = source;
  const name = decoded(path.at(-1));
  const extension = /\.([^.]+)$/.exec(name)?.[1].toLowerCase();
  if (extension !== 'edf') {
    throw new LinkError(
      extension
        ? `Links open EDF files only, and this one is to a .${extension} file.`
        : 'Links open EDF files only, and this one is to something else.',
    );
  }

  const filePath = path.join('/');
  return {
    name,
    dataset,
    link: url.href,
    dataUrl: `${OPENNEURO}${dataset}/${filePath}`,
    pointerUrl: repo ? `${NEMAR_GITHUB}${repo}/${ref.join('/')}/${filePath}` : null,
  };
}

async function get(url, signal) {
  let response;
  try {
    response = await fetch(url, { signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new LinkError('The recording could not be downloaded. Check your connection.');
  }
  if (response.ok) return response;
  if (response.status === 404 || response.status === 403) return null;
  throw new LinkError(`The download failed with HTTP status ${response.status}.`);
}

// A pointer names the file's size and, for the SHA-256 backends, its hash. A file small enough
// to live in git itself comes back whole.
async function readPointer(url, signal) {
  const response = await get(url, signal);
  if (!response) throw new LinkError("This file isn't in that version of the dataset.");
  const bytes = new Uint8Array(await response.arrayBuffer());
  const key =
    bytes.length < POINTER_LIMIT && ANNEX_KEY.exec(new TextDecoder().decode(bytes).trim());
  if (!key) return { whole: bytes };
  const [, backend, size, hash] = key;
  return { size: Number(size), sha256: backend.startsWith('SHA256') ? hash : null };
}

// Fills one buffer as the bytes arrive, so a large recording isn't held twice.
async function readBody(response, expected, onProgress) {
  const total = expected ?? (Number(response.headers.get('content-length')) || 0);
  const reader = response.body.getReader();
  let bytes = new Uint8Array(total);
  let filled = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (filled + value.length > bytes.length) {
      const grown = new Uint8Array(Math.max(bytes.length * 2, filled + value.length));
      grown.set(bytes.subarray(0, filled));
      bytes = grown;
    }
    bytes.set(value, filled);
    filled += value.length;
    onProgress(filled, total);
  }
  return filled === bytes.length ? bytes : bytes.slice(0, filled);
}

async function sha256(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// Downloads a recording that resolveLink has read. onProgress hears the bytes received so far
// and the total, which is 0 when the total isn't known.
export async function download(target, { signal, onProgress = () => {} } = {}) {
  const pointer = target.pointerUrl ? await readPointer(target.pointerUrl, signal) : null;
  if (pointer?.whole) return pointer.whole.buffer;

  const response = await get(target.dataUrl, signal);
  if (!response) throw new LinkError("OpenNeuro doesn't have this file.");
  const bytes = await readBody(response, pointer?.size, onProgress);

  if (
    pointer &&
    (bytes.length !== pointer.size || (pointer.sha256 && (await sha256(bytes)) !== pointer.sha256))
  ) {
    throw new LinkError(
      "OpenNeuro's copy of this file doesn't match the version the link is to, so it wasn't opened.",
    );
  }
  return bytes.buffer;
}
