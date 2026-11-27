# Studio Surgeon Act III

The integration preserves Claude's `7dc8f71074e781fd7c94115e9ecab9f84d907d7d` and OpenCode's `488d49ea75247c1d0f486a9b1ddf81915f767019` as the two parents of `ec14466d0848cdc345eb3da03d2f64e9deb3293d`. Both started at `170b2705b930662ae0eff57c0c9989b06e7c6a8e`. OpenCode's contract describes the baseline audio routes and still governs their identity, Range support and sample-aligned sections. The integrated candidate adds Claude's waveform route to provide an overview of the actual stem without downloading or decoding it in the browser. Arrangement clip Focus draws the peaks it already has.

The waveform route resolves the same stored set and role as the audio route. Lookup rejects missing and disallowed roles, unavailable files, wrong filename keys and links that escape the managed stems root. The existing managed-root resolver permits aliases that resolve inside that root. Waveform generation forces the WAV demuxer, reports an opaque error for unreadable or malformed audio and never writes source audio. Each response generated from audio has 1,200 peak pairs. FFmpeg decoding is bounded by the existing 30-minute input limit and process timeout. The first miss still decodes the stem on the server. The shared generator downsamples a mono mix of the stem for display.

Caches live under the Studio data directory in `waveforms/stems`. The version and source device, inode, size, modification time and change time determine reuse. Missing media is refused before cache lookup. A malformed cache is recomputed. Concurrent misses may both compute peaks but publish via separate temporary files and atomic replacement. A cache write failure still permits the generated response.

Focus previews through the existing media element and exclusive-play handshake. The exact section route is used for Arrangement placement. Audition In/Out and loops use a browser animation tick and media seeks. Boundary timing varies and loops can have a gap. Clip preview auditions the source at natural speed and level. Hear it in place uses the existing Arrangement engine and hears its clip processing, including Signalsmith when pitch-preserving stretch is needed. The Performance Desk's separate varispeed contract is unchanged.

## Independent evidence

- The three added waveform regressions failed on the untouched merge with a shared temporary-file collision, a non-object cache exception, and a leaked local filename. The same checks passed with the repair.
- Python exited 0 with 61 passes. The Starlette test-client dependency emitted one deprecation warning.
- The two focused Node modules reported 34 passes and zero failures.
- Real Chromium against a loopback Studio on 8806 with a disposable two-track Library copy passed 37/37 checks. Library and Crate played the same renamed vocal URL. The journey checked shared playback ownership, exact 4–9.5 second placement, source identity, trim and split, Undo, unchanged hashes for eight WAVs, session continuity, focus return, shortcut isolation, 44 px controls, 390 px layout and forced colours. The Studio was stopped afterward. No speaker or screen-reader speech was tested.
- Static assets total 1,667,542 bytes across 106 files, up 65,915 bytes and three files from Record Sleeves. The largest are `arrangement-panel.js` (117,670), `SignalsmithStretch.mjs` (113,867), `arrangement-producer.js` (92,021) and `stem-desk-panel.js` (82,641). The growth crosses the investigation trigger. Most comes from the shared Focus panel. The integration repair adds no static bytes.

## Reproduce

Run from the isolated integration worktree with the existing local Python and Node dependencies available. The browser fixture needs a disposable Studio Library containing just Midnight Circuit and Paper Lanterns with both validated quads. The journey temporarily changes a stem label, so use a scratch copy.

```bash
PYTHONPATH="$PWD/src" .venv/bin/pytest -q \
  tests/test_stem_waveform.py tests/test_stem_audio_truth.py \
  tests/test_stem_names.py tests/test_track_names_and_sections.py
node --test tests/frontend/stem-focus.test.js tests/frontend/record-sleeves.test.js
PYTHONPATH="$PWD/src" .venv/bin/python -m twobecomeone.cli web \
  --host 127.0.0.1 --port 8806 --data-dir /tmp/stem-focus-demo/data
```

In another terminal from the same worktree:

```bash
node tests/browser/stem_focus.js http://127.0.0.1:8806 \
  /tmp/stem-focus-demo/browser /tmp/stem-focus-demo/data
```

Stop the scratch server with Ctrl+C in its terminal. ## Golden Master handoff

The PM confirmed by ear that the final In/Out repair at `e705a12` works and accepted Studio Surgeon. The repair preserves one preview player. Arrangement Focus auditions through the existing seekable full-stem URL with a section-local cursor. Loop on resumes from In, Loop off parks at In when it reaches Out, and Stop parks at In. The Arrangement still renders from its saved asset reference. The repair passed 39 focused frontend tests and a real Chromium journey through Library, Crate and Arrangement. The baseline negative controls reproduced the reset and ownership failures.

- Start with the [workspace skill](../skills/stem-workspace/SKILL.md) for continuity, Cutting Room and Undo/Redo, Library provenance and reusable stems, and Stem-Focus role tokens. Use the [audio contract](../skills/stem-audio-contract/SKILL.md) for waveform validation and caching, Range, audition ownership and Signalsmith.
- Approximate seek timing and possible loop gaps remain. The known [200% mobile zoom overflow](record-crate-stage1.md) remains open. Real screen-reader speech is unverified.
- In-app navigation preserves the live session. A refresh, tab close or restart loses loaded banks, unsaved work and session history. Explicitly saved arrangements can reopen, with fresh Undo history. See [Never Lose the Mix](never-lose-the-mix.md).
- Next session: start from the Golden Master on `main`. Review the [Stem Workshop proposal](stem-workshop-act-i.md) before any work on precise Demucs start/end separation, independent stem tempo through existing Signalsmith controls, or further musical usability.
