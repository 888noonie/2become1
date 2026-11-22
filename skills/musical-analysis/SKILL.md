---
name: musical-analysis
description: >
  Rank a chorus or section of one 2become1 song against another using the
  stored fingerprint. Use when changing listening analysis, chorus fit, or the
  ranker the Producer consults.
---

# Musical analysis and Chorus Fit

## When to use

Changing section detection, chroma fingerprints, tempo or pitch compatibility, or the explanation shown before a passage is placed.

## Problem

Two songs can share a pitch-class shape and still be a bad musical fit. The ranker must show its evidence and leave the lanes alone until the musician, or an explicit take, places the passage.

## Source of truth

- `src/twobecomeone/listening.py` — `analyse`, `for_track`, `apply_corrections`
- `src/twobecomeone/chorus_fit.py` — `rank_fit`
- `src/twobecomeone/studio_static/js/arrangement/chorus-fit.js`
- `docs/listening-room.md`
- `docs/the-maestro.md`

## Boundaries

`rank_fit` compares section descriptors the listening pass already stored. It does not separate stems and it does not call a language model. Whisper runs only when `TWOBECOMEONE_WHISPER_MODEL` is set; nothing is downloaded. Keyword and button directions work with no model. Nothing in this path hears the audio. Chroma, tempo, and swing are measurements.

## What the ranker decides

`rank_fit` in `src/twobecomeone/chorus_fit.py` orders candidates by the best cosine over twelve chroma rotations. Duration, vocal presence, tempo, and swing stay beside that score and do not outrank a clearly better pitch-class match. Missing chroma is omitted, not stored as zero.

A gap under `CHROMA_AMBIGUITY_GAP` (0.05) is ambiguous. Swing separates that cluster only when the swing gap reaches `SWING_DECISIVE_GAP` (0.12). Otherwise the result asks which candidate to try. Stretch is applied only for the tempo as read, and only inside 0.857–1.2. Half-time and double-time are reported relationships, not stretch rates. The reply must keep the `_LIMITATIONS` text: a rotation is a pitch hypothesis, not a chord progression, a lyric, or a judgement of taste.

## What worked, and what does not

The Chorus Fit Chromium journey on `cbe6984` ranked two synthetic songs, placed a finite source offset at zero pitch, and did not call a model. Treating a rotation as permission to retune is the failure this skill exists to prevent. The local language-model tests are a separate path. On this machine they failed because `llama-server` segfaulted under the NVIDIA driver mismatch. Ranking must not wait on that runtime.

## Invariants

- A rotation is a pitch-class reading. The UI says it is not a chord-by-chord proof.
- Tempo stretch is accepted inside 0.857–1.2. Outside that, the fit says so.
- The placed passage keeps zero pitch and a finite source offset unless the musician asked for pitch.
- Jam explains the candidate before Hear it. Take the decks may commit a ranked plan without a separate Hear it, and it says it did not audition the audio.
- The same start and length are not inferred from equal durations.

## Procedure

1. From a worktree whose `.venv` is the shared checkout env, run Python with `PYTHONPATH=src` so imports resolve to that worktree.
2. Run `node tests/browser/chorus_fit_journey.js`. It builds two short synthetic songs, calls `POST /api/chorus-fit`, and must not call the model.
3. Read the cosine, rotation, and stretch in the reply before treating a candidate as placed.

## Failure modes

- Treating a chroma rotation as permission to retune.
- Placing a passage with a missing or negative source offset.
- Ranking against a section the musician has since corrected without reloading `for_track`.
- Skipping the ranker and inventing a chorus from the filename.

## Tests

```bash
PYTHONPATH=src .venv/bin/pytest -q tests/test_chorus_fit.py tests/test_chorus_fit_gate.py tests/test_section_chroma.py
node --test tests/frontend/chorus-fit.test.js tests/frontend/chorus-fit-panel.test.js
node tests/browser/chorus_fit_journey.js
```

## Recovery

Revert the analysis commit. Cached analyses in a data dir can be recomputed with `for_track(..., compute=True)`. Do not delete the musician's library to clear a bad cache.

## What not to do

Do not download a model. Do not require the NVIDIA stack. Do not describe a pitch-class match as musical taste.
