# Ventris

View EEG recordings in your browser.

Use it at <https://ventris-tools.github.io/ventris/>.

Open an EDF recording to explore its signals, annotations and frequency bands. Everything runs in your browser, so your recordings never leave your computer. The app has no code that sends a recording anywhere. The page's Content Security Policy backs this up by blocking `fetch`, XHR, WebSockets and loads from other hosts. It cannot stop navigation or WebRTC, so the promise rests on the code as well.

This is an early preview, and live streaming from EEG headsets is the next goal. Ventris is a research tool, not a medical device.

## Run it locally

The app has no build step and no runtime dependencies.

```bash
python3 -m http.server 4173
```

Then open <http://localhost:4173>.

## Test

The development tools need Node.js 22.13 or later.

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
npm run lint
```

```bash
npm run format:check
```

`npm run coverage` fails if coverage falls below the floors in `package.json`. Raise the floors when coverage improves, so that it can't slip back.

## Deploy

Changes reach `main` through pull requests, which need the `test` check in [ci.yml](.github/workflows/ci.yml) to pass. Each merge then publishes to GitHub Pages.

Only the files the app needs are published. A new top-level file has to be added to the list in that workflow.

## Layout

| File | Purpose |
|---|---|
| `js/edf.js` | Reads EDF and EDF+ files |
| `js/channels.js` | Reads the kind of each channel from its label |
| `js/dsp.js` | Computes power spectra, band shares and time statistics |
| `js/format.js` | Writes times and amounts for the interface |
| `js/info.js` | Builds the rows of the details panel |
| `js/demo.js` | Generates the synthetic demo recording |
| `js/traces.js` | Draws the traces and the time axis, and handles the cursor |
| `js/theme.js` | Sets the light or dark theme and remembers the choice in the browser |
| `js/app.js` | Connects the interface |

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before you reuse code from another project.

## License

BSD 3-Clause. See [LICENSE](LICENSE).

The filter parsing in `js/edf.js` is adapted from [MNE-Python](https://mne.tools), which is also under BSD 3-Clause. See [licenses/MNE-Python.txt](licenses/MNE-Python.txt).

The GitHub mark and the theme icons are from [Octicons](https://github.com/primer/octicons), under the MIT license. See [licenses/octicons.txt](licenses/octicons.txt).

The app uses [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono), hosted here so that it makes no third-party requests. The font is under the SIL Open Font License. See [fonts/OFL.txt](fonts/OFL.txt).
