# Ventris

**Look inside an EEG recording in seconds, right in your browser.**

Open an EDF, EDF+ or CSV file to see its signals, frequency bands, annotations and header details on one screen. There's nothing to install, and the file never leaves your computer.

**[Open Ventris](https://ventris-tools.github.io/ventris/)** and drop in a recording, paste a link to a public one on NEMAR, or start with the built-in demo.

[![Ventris showing eight EEG channels, with frequency band shares and recording details beside the traces](docs/screenshot.png)](https://ventris-tools.github.io/ventris/)

*The demo is synthetic: a blink shows in Fp1 and Fp2, and alpha builds at the back of the head when the eyes close at 0:20.*

## What it's for

Ventris is the quick look before MNE-Python, EEGLAB or FieldTrip: what's in this file, and is it any good?

- **Check a session while you can still redo it.** Spot flat channels, noisy channels and artifacts.
- **Size up a dataset you didn't record.** Read its sample rate, channels, filters and duration before you write any code. EDF header fields follow MNE-Python's reader, so they usually match `mne.io.read_raw_edf`.
- **Find your events.** Jump between annotations and check that they line up with the signal.
- **Browse public datasets.** Open a recording from a NEMAR dataset by its GitHub link, with nothing to download or clone.
- **Teach.** The demo shows a blink and eyes-closed alpha, with nothing for students to install.

The [help page](https://ventris-tools.github.io/ventris/help.html) explains each panel and what it measures.

## Open a public recording by link

Paste the GitHub address of a recording in a [NEMAR](https://nemar.org) dataset under **Open a recording**, such as:

```text
https://github.com/nemarDatasets/on003194/blob/main/sub-NEPO01/ses-Nepopre/eeg/sub-NEPO01_ses-Nepopre_task-taskprenepo_eeg.edf
```

GitHub keeps only a small pointer for each file, so Ventris downloads the recording from OpenNeuro's public copy and checks it against the size and SHA-256 hash in the pointer. If GitHub doesn't answer within a few seconds, Ventris opens the copy anyway, with a note that it couldn't check it. The address bar then links to the recording, so you can share the view.

This works for EDF files in the datasets NEMAR mirrors from OpenNeuro, whose names start with `on`. NEMAR's own datasets, starting `nm`, don't open yet, because their storage doesn't let a web page download them. The [help page](https://ventris-tools.github.io/ventris/help.html#links) lists the links that work.

## Your recordings stay on your computer

Your browser reads the file, and Ventris has no code that sends it anywhere. Its Content Security Policy also blocks XHR and WebSocket connections to other hosts, and lets fetch reach only the two places a public recording comes from: OpenNeuro's bucket on S3 and NEMAR's datasets on GitHub. Watch your browser's network panel while a file opens to see for yourself, or read the code.

Opening a recording by link is the one time Ventris uses the network. It downloads that file and nothing else, and Amazon and GitHub see your IP address and which file you asked for.

## Limits

Ventris is an early preview. It's a research tool, not a medical device.

- BDF files aren't supported yet.
- A CSV file needs a header row and a column of times.
- It doesn't filter, re-reference or export signals.
- The whole file is read into memory, so a very large recording may not open.

Live streaming from EEG headsets is next. If Ventris is missing something you need, [open an issue](https://github.com/ventris-tools/ventris/issues).

## Run it locally

There's no build step and there are no dependencies, so any static file server runs a copy, and it works offline apart from opening a recording by link:

```bash
git clone https://github.com/ventris-tools/ventris.git
cd ventris
python3 -m http.server 4173
```

Then open <http://localhost:4173>.

---

Ventris is open source under the [BSD 3-Clause license](LICENSE). To work on it, see [CONTRIBUTING.md](CONTRIBUTING.md).
