"""Writes test/support/scipy-filters.js, SciPy's answers for the display filters in js/filters.js.

CI has no Python, so the answers are committed. Rerun after changing a case or the input:

    python3 -I test/support/scipy-filters.py > test/support/scipy-filters.js
    npx prettier --write test/support/scipy-filters.js

The input is built from integers and powers of two, so Python and JavaScript make exactly the
same float32 samples without sharing a sine function.

The filtered samples come from SciPy's sosfilt run forwards and backwards, as sosfiltfilt runs
it, but starting from the closed-form steady state in steady_state, which is what
js/filters.js uses. Each case is checked against sosfiltfilt itself before it's written.
"""

import json
import math

import numpy as np
import scipy
from scipy import signal

NOTCH_Q = 30
SETTLE = 1e-5

# fs, high-pass, low-pass, notch, number of samples, and which filters apply at this rate
CASES = [
    (256, 0.5, 70, 50, 4000, ("highpass", "lowpass", "notch")),
    (1000, 0.1, None, 60, 40000, ("highpass", "notch")),
    (128, 1, 70, 50, 3000, ("highpass", "notch")),
    (16384, 0.1, 40, None, 20000, ("highpass", "lowpass")),
    (250, None, 30, None, 2, ("lowpass",)),
]

KEEP = 20


def sample(i, fs):
    """The same expression as inputFor in test/filters.test.js."""
    period = 20 * fs
    place = i % period
    drift = (place if place < period / 2 else period - place) / 64
    alpha = 40 if (i * 10 // fs) % 2 == 0 else -40
    mains = 20 if (i * 50 // fs) % 2 == 0 else -20
    noise = (((i * 2654435761) % 2**32 >> 20) - 2048) / 256
    return 250000 + drift + alpha + mains + noise


def sections(fs, highpass, lowpass, mains, applies):
    rows = []
    if "highpass" in applies:
        rows.append(signal.butter(2, highpass, "highpass", fs=fs, output="sos")[0])
    if "lowpass" in applies:
        rows.append(signal.butter(2, lowpass, "lowpass", fs=fs, output="sos")[0])
    if "notch" in applies:
        b, a = signal.iirnotch(mains, NOTCH_Q, fs=fs)
        rows.append(np.concatenate([b, a]))
    return np.array(rows)


def pad_length(sos, n):
    slowest = max(row[5] for row in sos)
    return max(0, min(n - 1, math.ceil(2 * math.log(SETTLE) / math.log(slowest))))


def steady_state(sos):
    """The state each section settles into, in closed form. SciPy's sosfilt_zi solves a linear
    system for it instead, which loses digits when a pole sits near 1: for a 0.1 Hz high-pass
    at 16384 Hz, a constant 250000 then leaks through as 0.026 rather than 1e-11."""
    state = []
    scale = 1.0
    for b0, b1, b2, _, a1, a2 in sos:
        gain = (b0 + b1 + b2) / (1 + a1 + a2)
        state.append([scale * (gain - b0), scale * (b2 - a2 * gain)])
        scale *= gain
    return np.array(state)


def filtfilt(sos, x, padlen):
    """scipy.signal.sosfiltfilt with padtype 'odd', starting each pass from steady_state."""
    n = len(x)
    left = 2 * x[0] - x[padlen:0:-1]
    right = 2 * x[-1] - x[n - 2 :: -1][:padlen]
    ext = np.concatenate([left, x, right])
    zi = steady_state(sos)
    y, _ = signal.sosfilt(sos, ext, zi=zi * ext[0])
    y, _ = signal.sosfilt(sos, y[::-1], zi=zi * y[-1])
    return y[::-1][padlen : padlen + n]


def kept(values):
    n = len(values)
    middle = n // 2
    places = sorted(
        set(range(min(KEEP, n)))
        | set(range(max(0, middle - KEEP // 2), min(n, middle + KEEP // 2)))
        | set(range(max(0, n - KEEP), n))
    )
    return [[place, float(values[place])] for place in places]


def main():
    cases = []
    for fs, highpass, lowpass, mains, n, applies in CASES:
        x = np.array([sample(i, fs) for i in range(n)], dtype=np.float64).astype(np.float32)
        sos = sections(fs, highpass, lowpass, mains, applies)
        padlen = pad_length(sos, n)
        y = filtfilt(sos, x.astype(np.float64), padlen)
        theirs = signal.sosfiltfilt(sos, x.astype(np.float64), padtype="odd", padlen=padlen)
        assert np.max(np.abs(y - theirs)) < 1e-7 * np.max(np.abs(x)), "strays from sosfiltfilt"
        cases.append(
            {
                "fs": fs,
                "settings": {"highpass": highpass, "lowpass": lowpass, "notch": mains},
                "n": n,
                "sos": sos.tolist(),
                "zi": signal.sosfilt_zi(sos).ravel().tolist(),
                "padlen": padlen,
                "output": kept(y),
            }
        )
    print(f"// Written by test/support/scipy-filters.py with SciPy {scipy.__version__}. Don't edit.")
    print(f"export const CASES = {json.dumps(cases)};")


main()
