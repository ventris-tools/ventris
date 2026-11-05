# Contributing

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

Fonts and other assets keep their own licenses. Put the license file next to the asset and mention it in the README, as `fonts/OFL.txt` does for JetBrains Mono.

## Keeping recordings private

The README promises that a recording never leaves the computer. Two checks protect that promise:

- ESLint rejects network calls and navigation in `js/`.
- `test/privacy.test.js` fails if the Content Security Policy in `index.html` changes.

These catch mistakes, not deliberate workarounds, so review changes to them with care. If a change really needs one of them relaxed, update the README's promise in the same pull request.
