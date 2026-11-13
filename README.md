# Ventris

**Look inside an EEG recording in seconds, right in your browser.**

Open an EDF, EDF+ or CSV file to see its signals, frequency bands, annotations and header details on one screen. There's nothing to install, and the file never leaves your computer.

**[Open Ventris](https://ventris-tools.github.io/ventris/)** and drop in a recording, or start with the built-in demo.

[![Ventris showing eight EEG channels, with frequency band shares and recording details beside the traces](docs/screenshot.png)](https://ventris-tools.github.io/ventris/)

*The demo is synthetic: a blink shows in Fp1 and Fp2, and alpha builds at the back of the head when the eyes close at 0:20.*

## What it's for

Ventris is the quick look before MNE-Python, EEGLAB or FieldTrip: what's in this file, and is it any good?

- **Check a session while you can still redo it.** Spot flat channels, noisy channels and artifacts.
- **Size up a dataset you didn't record.** Read its sample rate, channels, filters and duration before you write any code. EDF header fields follow MNE-Python's reader, so they usually match `mne.io.read_raw_edf`.
- **Find your events.** Jump between annotations and check that they line up with the signal.
- **Teach.** The demo shows a blink and eyes-closed alpha, with nothing for students to install.

The [help page](https://ventris-tools.github.io/ventris/help.html) explains each panel and what it measures.

## Your recordings stay on your computer

Your browser reads the file, and Ventris has no code that sends it anywhere. Its Content Security Policy also blocks fetch, XHR and WebSocket connections to other hosts. Watch your browser's network panel while a file opens to see for yourself, or read the code.

## Limits

Ventris is an early preview. It's a research tool, not a medical device.

- BDF files aren't supported yet.
- A CSV file needs a header row and a column of times.
- It doesn't filter, re-reference or export signals.
- The whole file is read into memory, so a very large recording may not open.

Live streaming from EEG headsets is next. If Ventris is missing something you need, [open an issue](https://github.com/ventris-tools/ventris/issues).

## Run it locally

There's no build step and there are no dependencies, so any static file server runs a copy, and it works offline:

```bash
git clone https://github.com/ventris-tools/ventris.git
cd ventris
python3 -m http.server 4173
```

Then open <http://localhost:4173>.

---

Ventris is open source under the [BSD 3-Clause license](LICENSE). To work on it, see [CONTRIBUTING.md](CONTRIBUTING.md).
