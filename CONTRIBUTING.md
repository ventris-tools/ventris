# Contributing

This guide covers how Ventris is built, tested and published. To use Ventris, see the [README](README.md).

## Run it

Follow [Run it locally](README.md#run-it-locally) in the README. The app has no build step, so reload the page to see a change.

## Test

The development tools need Node.js 22.22.2 or a later 22, 24.15 or a later 24, or 26 and up, as jsdom does.

```bash
npm install
```

```bash
npm test
```

```bash
npm run coverage
```

```bash
npm run test:browser
```

```bash
npm run lint
```

```bash
npm run format:check
```

`npm run coverage` fails if coverage falls below the floors in `package.json`. Raise the floors when coverage improves, so that it can't slip back.

`npm test` runs the app in jsdom, which has no Content Security Policy, real canvas or form checks. `npm run test:browser` opens the pages in headless Chrome and fails on any error, blocked load or missing file. It finds Chrome in the usual places, or set `CHROME_PATH`, and skips without it except in CI.

`npm run lint` checks the JavaScript with ESLint, the CSS with stylelint's recommended rules and the HTML with html-validate's. Stylelint's `no-descending-specificity` is off, since it flags selectors that never match the same element.

## Layout

| File | Purpose |
|---|---|
| `js/recording.js` | Describes the recording every reader returns, and its shared limits |
| `js/edf.js` | Reads EDF and EDF+ files |
| `js/csv.js` | Reads EEG saved as CSV, with a header row and a column of times |
| `js/channels.js` | Reads the kind of each channel from its label |
| `js/dsp.js` | Computes power spectra, band shares and time statistics |
| `js/format.js` | Writes times and amounts for the interface |
| `js/info.js` | Builds the rows of the details panel |
| `js/remote.js` | Reads a link to a public recording on NEMAR or OpenNeuro, and downloads it |
| `js/md5.js` | Hashes a download with MD5, which Web Crypto lacks, to check it against its pointer |
| `js/demo.js` | Generates the synthetic demo recording |
| `js/traces.js` | Draws the traces and the time axis, and handles the cursor |
| `js/theme.js` | Sets the light or dark theme and remembers the choice in the browser |
| `js/app.js` | Connects the interface |

`index.html` preloads the modules so that the browser fetches them together. A new module has to be added there, and a test fails until it is.

## Colour

Ventris has to work for colour-blind people. About 1 man in 12 and 1 woman in 200 can't tell some reds from some greens, and every colour in the app is chosen with them in mind:

- Nothing is said by colour alone. A colour always comes with a name, a number, a shape or a place that says the same thing. Annotations carry their names, and the band bars carry their shares.
- Colours that tell things apart, like the annotation colours, stay apart for everyone. In each theme, every two of them differ by at least 8 in OKLab ΔE (×100) under simulated protanopia and deuteranopia, using Machado, Oliveira and Fernandes (2009) at full severity, and by at least 15 for full colour vision. Any two annotations can sit side by side, so every pair counts, not only neighbours.
- Marks are at least 3:1 against the background they're drawn on, and text is at least 4.5:1, so they hold up when hue doesn't.

`test/colors.test.js` checks this for both themes and fails when a colour breaks it. Colours live as custom properties at the top of `styles.css`, and a new one goes there too, set for both themes and added to the test if it tells things apart.

This is why only four kinds of annotation get a colour: no fifth colour stays apart from those four and the grey in both themes. Further kinds are grey, and their names tell them apart.

## Where text goes

The viewer keeps to labels and short captions, and `help/index.html` holds anything that takes a sentence. The exceptions are the privacy promise, the medical disclaimer and messages about the file that's open. Help opens in a new tab, so that reading it doesn't close the recording.

## Deploy

Changes reach `main` through pull requests, which need the `test` check in [ci.yml](.github/workflows/ci.yml) to pass. Each merge then publishes to GitHub Pages.

Only the files the app needs are published. A new top-level file has to be added to the list in that workflow.

## Update the screenshot

`docs/screenshot.png` in the README shows the demo in the light theme, at 1440 by 900. Retake it when the interface changes. Run the app on port 4173, then run this. It needs Google Chrome, and this is its path on macOS.

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --hide-scrollbars --user-data-dir="$(mktemp -d)" --window-size=1440,900 --force-device-scale-factor=2 --blink-settings=preferredColorScheme=1 --virtual-time-budget=4000 --screenshot="$PWD/docs/screenshot.png" http://localhost:4173
```

## Update the fonts

`fonts/` holds JetBrains Mono, served from Ventris itself so that the page makes no third-party requests. It's cut down to Latin and Greek, without its ligatures and alternate letters, which makes it about a fifth of the size. Other scripts fall back to the system's monospace font.

To change that, install the tool, then run this on the TTF files from a [JetBrains Mono release](https://github.com/JetBrains/JetBrainsMono/releases), once for Regular and once for Medium.

```bash
pip install "fonttools[woff]"
```

```bash
pyftsubset JetBrainsMono-Regular.ttf --flavor=woff2 --unicodes="U+0020-007E,U+00A0-017F,U+0370-03FF,U+2010-2027,U+2030-205E,U+20AC,U+2190-2193,U+2212,U+2248,U+2260,U+2264,U+2265" --layout-features="kern,mark,mkmk" --output-file=fonts/JetBrainsMono-Regular.woff2
```

## Reusing outside code

Ventris is under the BSD 3-Clause license, so anything added to it has to be usable under those terms. Check the license before you copy, port or closely adapt code from another project.

| The code's license | What to do |
|---|---|
| BSD, MIT, ISC, Apache-2.0 or public domain | You can adapt it. Keep its copyright notice and license text, and say in a comment where it came from. |
| GPL, LGPL or AGPL | Don't adapt it, unless its authors give written permission to relicense it under BSD 3-Clause. |
| Non-commercial or no-derivatives terms | Don't adapt it. |
| Unknown, or no license | Don't adapt it. |

EDFbrowser, SigViewer, FieldTrip and Brainstorm are under the GPL, so their code is off limits. EDFlib and MNE-Python are under BSD 3-Clause, so theirs can be adapted.

Put a copied license in `licenses/`, and name it in a comment beside the code, as `js/edf.js` does for `licenses/MNE-Python.txt`. Code in the public domain needs only the comment, as in `js/demo.js`.

This rule covers code. You can still write your own version from a published paper or a format specification.

Fonts and other assets keep their own licenses. Put the license file next to the asset, as `fonts/OFL.txt` is for JetBrains Mono.

List everything that comes with its own license in [licenses/README.md](licenses/README.md).

## Keeping recordings private

The README promises that a recording never leaves the computer. The Content Security Policy blocks XHR, WebSockets and loads from other hosts, and fetch everywhere but the two places below, but it can't stop navigation or WebRTC, so the promise rests on the code too. Two checks protect it:

- ESLint rejects network calls and navigation in `js/`. The one exception is `fetch` in `js/remote.js`, which downloads a public recording opened by link and sends nothing of its own.
- `test/privacy.test.js` fails if the Content Security Policy in `index.html` or `help/index.html` changes. The policy in `index.html` lets `fetch` reach only the two places named in `js/remote.js`: OpenNeuro's public bucket and NEMAR's datasets on GitHub, each limited to its own folder.

These catch mistakes, not deliberate workarounds, so review changes to them with care. If a change really needs one of them relaxed, update the README's promise in the same pull request.
