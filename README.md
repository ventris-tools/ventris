# Ventris

EEG decoding in your browser.

Open an EDF recording to explore its signals and frequency bands. Everything runs in your browser, so your recordings never leave your computer. The page's Content Security Policy blocks the app from opening network connections, and the app has no code that sends a recording anywhere.

This is an early preview, and live streaming from EEG headsets is the next goal. Ventris is a research tool, not a medical device.

## Run it locally

There is no build step and there are no dependencies.

```bash
python3 -m http.server 4173
```

Then open <http://localhost:4173>.

## Test

```bash
npm test
```

## Layout

| File | Purpose |
|---|---|
| `js/edf.js` | Reads EDF and EDF+ files |
| `js/dsp.js` | Computes power spectra, band shares and time statistics |
| `js/info.js` | Builds the rows of the right-hand menu |
| `js/demo.js` | Generates the synthetic demo recording |
| `js/traces.js` | Draws the traces and handles scrolling |
| `js/app.js` | Connects the interface |

## License

BSD 3-Clause. See [LICENSE](LICENSE).
