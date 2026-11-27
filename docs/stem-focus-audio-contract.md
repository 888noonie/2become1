# The Stem-Focus audio contract (OPERATION STUDIO SURGEON, Act II)

Baseline `integration/record-sleeves @ 170b270`. Branch `feat/audio-truth`.
Backend and audio only: no frontend file, no DSP change, no new route, no
migration, no media copy.

This note is the source of truth Claude builds Stem Focus against and Codex
reviews it with. Everything here was measured on the running routes; the tests
that pin it are named at the end.

## Summary

The existing audio surface is already sufficient for a focused stem preview.

* **Preview** a stem with the URL the backend already publishes.
  `/api/stems/{set}/audio?name={role}` streams the full stem and honours HTTP
  `Range`, so an `<audio>` element seeks.
* **A selected in/out window** needs no new endpoint. Fetch the stem (or one of
  the existing 30/60/90 s sections) and schedule the window in the browser:
  `AudioBufferSourceNode.start(when, offset, duration)` for one pass, or
  `loopStart`/`loopEnd` for a loop. The desk already plays this way.
* **No backend defect blocks that.** Nothing in the routes was changed. What was
  missing was a written contract and proof; both are here.

## 1. The five routes that matter

| Route | What it answers | Source of truth for |
| --- | --- | --- |
| `GET /api/tracks/{track_id}/stems` | The recording's chosen playable set, lane by lane | `variants[]`, `audio_url`, `display_name`, provenance |
| `GET /api/stem-sets/{stem_set_id}` | One set's identity card | role, label, source recording, tempo |
| `GET /api/stems/{set}/audio?name=role` | The stem's own bytes | preview URL, decoded duration, seeking |
| `GET /api/stems/{set}/audio?name=role&start=S&duration=N` | A cut section | bounded fetch before decode |
| `GET /api/tracks/{id}/audio`, `/api/tracks/{id}/waveform` | The recording's mix and its peaks | the mix only, never a stem |

There is no stem waveform route, no stem-duration field and no second catalogue.

## 2. Identity is `(stem_set_id, role)`

* `role` is the key: `vocals`, `drums`, `bass`, `other`, and for a channel split
  `center`, `sides`. It is also the `name` used by the audio route and the key
  in `paths_json`.
* A display name is presentation. `PATCH /api/stem-sets/{id}/names` writes
  `names_json` only; the role, the set id, the stored file name, the bytes and
  the source recording do not change.
* So a preview URL is **stable across a rename**:

  ```text
  /api/stems/f84c2075…/audio?name=vocals
  ```

  Measured: identical before and after renaming vocals to "Lantern Lead", with
  the file's sha256 unchanged (`TestIdentity::test_a_rename_changes_only_the_label`).
* `full` is **not** a stem. It is the recording's own mix at
  `/api/tracks/{id}/audio`. `name=full` is refused on the stem route.
* A set row is only ever published `status='complete'`; finalisation is an
  atomic directory rename plus one insert.

### The identity card

```json
{
  "stem_set_id": "…", "track_id": "…", "track_name": "Paper Lanterns",
  "source_kind": "local", "bpm": 100.6, "bpm_source": "measured",
  "method": "imported", "model_name": "sha256:…", "device": "user",
  "status": "complete", "created_at": 1795746720.74,
  "stems": [
    { "name": "vocals", "display_name": "Lantern Lead",
      "custom_name": true,
      "audio_url": "/api/stems/…/audio?name=vocals" }
  ]
}
```

* `bpm` is the source recording's **effective** tempo (override if present).
* `bpm_source` is `"entered"` only when the owner supplied the override,
  otherwise `"measured"`. It is the field Claude maps to
  `nativeBpmSource: 'owner' | 'analysis'`.
* `stems[]` omits any role whose file no longer validates, so the card cannot
  advertise dead media.
* The card carries no media path, no `paths_json`/`names_json`/
  `provenance_json` and no peaks. `model_name` is the set's own honest identity
  (`sha256:<set hash>` for an imported set, the model name for a separation),
  not a file path.

## 3. The preview URL

```text
/api/stems/{stem_set_id}/audio?name={role}
```

* `Content-Type: audio/x-wav`, `Accept-Ranges: bytes`,
  `Content-Disposition: inline; filename="vocals.wav"`.
* `Range` works: `bytes=0-99` → `206` with `Content-Range: bytes 0-99/TOTAL`;
  `bytes=-64` → the last 64 bytes; an unsatisfiable range → `416`.
* `download=true` adds an `attachment` disposition. Do not use it for preview.
* Do not construct this URL from a label. A stem is playable only if its
  `audio_url` is exactly the route above; the record-sleeves
  `normalizeStem` already enforces that and should keep enforcing it.
* `HEAD` answers `405` on the audio and API GET routes checked (the same is
  true of `/api/health`). Use `GET`; do not probe with `HEAD`.

### Refusals (all `400` with the standard error envelope)

| Request | Message |
| --- | --- |
| unknown set id | `unknown stem set: …` |
| role not in `paths_json` | `stem 'guitar' not found in stem set …` |
| `name=full` | `stem 'full' not found in stem set …` |
| `name=../../tracks/x` | `stem '../../tracks/x' not found in stem set …` |
| file deleted or corrupt | `stem media is unavailable or corrupt: bass` |

A missing `name` is a `422 validation_error`.

## 4. Sections: the bounded way to fetch before decoding

```text
/api/stems/{set}/audio?name=vocals&start=1.25&duration=30
```

* `duration` must be exactly **30, 60 or 90**. Anything else is refused, as is
  `start` alone or `duration` alone.
* `start` is seconds, `0 ≤ start ≤ 3600`, and may be fractional. It is converted
  to a sample index with `round(start × file_rate)`; the cut is
  `atrim=start_sample=…:end_sample=…` and timestamps are reset.
* The response is `audio/wav` with the source's own sample rate, channel count
  and sample width. 16-bit stays 16-bit, 24-bit stays 24-bit, float stays float.
  Nothing is resampled or downmixed.
* The cut is the remainder when the recording is shorter than the section.
* **Measured sample accuracy:** at `start=1.25` the returned `data` equals the
  source from sample `round(1.25 × rate)` to the end, byte for byte; a 24-bit and
  a float stem decode identically to an independent `atrim` of the same file
  (`TestSectionRoute`).
* **The last sample is reachable**: `start=(frames-1)/rate` returns exactly one
  frame. `start=frames/rate` is refused with
  `the section starts past the end of the recording`.
* The returned WAV declares real RIFF and `data` sizes (no pipe placeholder),
  so a decoder does not read a 30 s cut as a multi-gigabyte file.
* A cut is written to a temp file under the data root and deleted immediately.
  The stored stem is never modified: same sha256 and same directory contents
  after the request.
* The section response has **no** `Accept-Ranges`. If a view must scrub inside
  the audio, use the full route, which does.

## 5. Playing a selected window without a backend change

Two supported paths. Pick by what the feature needs.

### A. Preview the whole stem (simplest, no decode budget)

The Studio already owns one preview element:

```js
audioController.play({ trackId, url: stem.audioUrl, kind: 'stem',
                       stemName: role, variant: role });
audioController.seek(seconds);   // after the first `duration` event
```

* One HTMLAudioElement for the whole page; starting a new source stops the
  previous one.
* `audio.js` dispatches `twobecomeone:exclusive-play` with
  `detail.owner = 'preview'`; the Performance desk and Arrangement stop, and
  starting either of those pauses the preview. **Join that handshake; do not add
  a third transport.**
* Seeking works because the route sends `Range`. Set `currentTime` only once the
  element reports metadata — `audioController.on((type) => … 'duration' …)` fires
  on `durationchange`, and `preload='metadata'` is already set. A seek before
  that is dropped by the browser.
* A stop-at-`b` window is `timeupdate` driven, so it is not sample accurate and
  a tight loop will drift. That is a property of the element, not the server.

### B. Play an exact window from a decoded buffer (sample accurate)

```js
const source = ctx.createBufferSource();
source.buffer = buffer;            // decoded from the stem URL
source.connect(gain);
source.start(when, offsetSec, lengthSec);   // one pass
// or, for a loop:
source.loop = true; source.loopStart = offsetSec; source.loopEnd = offsetSec + lengthSec;
```

* This is what `stem-desk.js` does today (`source.start(when, bufferOffset)`,
  with per-lane `stop(laneEnd)`), and it is the only way to get a
  sample-accurate in/out and a gapless loop.
* `offsetSec` is the **in-point inside the decoded buffer**, so if you fetched a
  section starting at `S`, `offsetSec = selectionStart − S`.
* Budgets (unchanged, documented in `AGENTS.md`): 40 MiB fetched and 40 MiB
  decoded per stem for sections, 128 MiB / 512 MiB / 1024 MiB for full length.
  At 48 kHz, 40 MiB decoded is **109.2 s of stereo** (218.4 s mono); 128 MiB is
  **349.5 s stereo** (699 s mono). A 90 s stereo section fits; a 2 minute one
  does not fit the section budget.
* A refused fetch keeps the server's reason in the body (`error.message`), so
  surface it rather than flattening it to "unavailable".

**What this means for a long stem:** a 6 minute stereo stem cannot be decoded
inside the 40 MiB section budget, and not inside the 128 MiB full budget either
above 5:49. For such a recording, draw the **mix** peaks
(`/api/tracks/{id}/waveform`) as an overview and be explicit that they are the
mix, or fetch one 90 s section and scope the focus to it. Do not silently raise
a limit.

## 6. Duration: what is and is not stored

There is **no stored stem duration** and the identity card has no duration
field. The truthful answers are:

1. **The decoded buffer's duration** (`AudioBuffer.duration`) — the value the
   waveform, the in/out and the loop are actually built from. This is the
   authority for a preview.
2. **The server's own bound**, independently probed from the file on every
   section request. A wrong client-side duration cannot make the route return
   audio from past the end; it refuses.

Two caveats worth stating in the UI copy:

* `track.duration` is the **recording's** duration. Demucs stems come from that
  recording, but an imported set is only validated to share one timeline
  **within itself**: equal sample rate, equal channel count, and durations
  within **10 ms** of each other. Nothing checks an imported stem against the
  mix duration. So do not compute a stem's in/out bounds from
  `track.duration` for `method="imported"`.
* For an imported set only, `GET /api/tracks/{id}/stems` exposes
  `variants[].provenance[role].{duration,sample_rate,channels}` from import
  time. Use it as metadata, never as a substitute for decoding.

## 7. Waveform and peaks

* `GET /api/tracks/{id}/waveform` → `{version: 1, bins: 1200, peaks: [[min,max], …]}`,
  generated once at ingest from the **full mix** (mono decode, min/max per bin).
  It is cached under the data directory. `stem_sets` has no waveform column.
* **There is no stem peaks route.** A stem's peaks must be computed from its
  decoded PCM: `computePeaks(channels, 256)` in
  `js/arrangement/daw-session.js` returns `{bucketFrames, sampleRate, min, max}`
  and `peaksFor(reference)` caches it per buffer reference. Reuse those two
  functions; do not write a second peak calculator.
* Label a mix waveform as the mix. A stem focus that draws 1200 mix bins under
  a stem's name is a false claim about that stem.

## 8. Tempo and stretch: the exact relationships

Conventions come from `js/arrangement/time-math.js` and are normative.

```text
secPerBeat         = 60 / masterBpm
rate               = SOURCE seconds consumed per OUTPUT second
  beat_sync        = masterBpm / asset.nativeBpm
  manual           = clip.customStretchRatio
outputDuration     = sourceSpan / rate
clip length (beats)= sourceSeconds × nativeBpm / 60      (beat_sync)
clip length (beats)= sourceSeconds × masterBpm / 60      (natural speed, rate 1)
pitch factor       = 2^(semitones / 12)                  (DSP only; no timing change)
```

* **Source BPM** comes from the identity card (`bpm` / `bpm_source`). A stem has
  no tempo of its own; it inherits the recording's. An entered tempo stays
  labelled entered.
* **Project BPM** is the Arrangement transport's (`masterBpm`).
* **Clip rate** belongs to the clip: `Fit to project tempo` sets `beat_sync`;
  `Speed ×` sets a manual ratio. A freshly placed Library stem is
  `manual` at ratio **1** — it plays at its own speed and is not stretched.

### Owner-facing controls (Arrangement clip inspector)

| Control | API call | Meaning |
| --- | --- | --- |
| `Fit to project tempo` | `stretchClipKeepingSource(clipId, 'auto')` | `beat_sync`, rate = master/native |
| `Speed ×` + `Apply speed` | `stretchClipKeepingSource(clipId, ratio)` | manual ratio, **pitch kept** |
| `Source BPM` | `setAssetTempo(assetId, nativeBpm)` | sets the asset's tempo, labelled entered |
| `Pitch (time kept)` | `setClipPitch(clipId, semitones, preserveFormants)` | semitones only, no timing change |
| `Keep formants` | same, `preserveFormants: true` | Signalsmith formant compensation |

Limits: manual rate `0.05 … 20` in the edit API (the UI number input offers
`0.25 … 4`), pitch `-12 … +12` semitones.

### What is qualified, and what is only reported

* `QUALIFIED_STRETCH_RATES = [0.857, 1.2]` at **0 semitones** for the default
  preset. Outside that, or with any pitch shift, the clip **still plays**, and
  the live engine emits `STRETCH_UNQUALIFIED` once per clip
  (`realtime-engine.js`). It is a report, not a refusal.
* Live routing is `bypass-unity`: rate exactly `1` and `0` semitones plays
  through a plain `AudioBufferSourceNode`, sample-exact and with no DSP
  priming. Anything else routes through Signalsmith. The offline bounce still
  uses `stretch-all`.
* Measured live-versus-bounce consequence for a bypass clip: equal level,
  transients aligned, ~1.3 ms offset, not sample-identical. Do not claim
  waveform identity for a stretched clip; judge onset and envelope.

### The distinction the UI must keep

`playbackRate` on an `HTMLMediaElement` (`<audio>`) or an
`AudioBufferSourceNode` is **varispeed**: it changes speed *and* pitch. The
Performance decks use exactly that (`element.playbackRate = tempoRatio`, with
the browser's `preservesPitch` toggled). It is **not** the Arrangement's
pitch-preserving stretch and must never be labelled "speed, pitch kept".

If Stem Focus offers a tempo change, either route it through Signalsmith (the
existing engine) or say plainly that changing speed changes pitch too. There is
no third DSP and no new one to build.

## 9. Measured constraints

| Fact | Value | Where it comes from |
| --- | --- | --- |
| Section lengths | 30, 60, 90 s | `_SECTION_SECONDS` |
| Section start | 0 ≤ start ≤ 3600 s, fractional | `_SECTION_START_MAX` |
| Section sample accuracy | byte-identical remainder | test compares the whole cut |
| Section fetch ceiling | 40 MiB decoded per stem | `_DEFAULT_STEM_DECODED_BYTES` |
| Full-length ceilings | 128 / 512 / 1024 MiB | desk full limits |
| Imported set alignment | sample rate, channels, ±10 ms durations | `STEM_IMPORT_DURATION_TOLERANCE_SECONDS` |
| Channel layouts | mono or stereo | import and section probe |
| Waveform | 1200 bins, version 1, mix only | `media.WAVEFORM_BINS` |
| Stretch qualification | 0.857–1.2 at 0 st | `QUALIFIED_STRETCH_RATES` |
| Pitch range | −12…+12 st | `project-state.js` |

## 10. Safety: what cannot be reached

Verified by `tests/test_stem_audio_truth.py`, including two disposable negative
controls:

* an **absolute** database path, a **traversal** path (`stems/../../x.wav`), a
  `tracks/...` path, a **symlink out of the managed root** (`/etc/hostname`), a
  differently named file inside the root, and **another role's file** under the
  `vocals` key are each refused with `stem media is unavailable or corrupt`;
* malformed `paths_json` reports no stems at all rather than raising;
* a deleted stem file is refused by both the full and the section route and
  disappears from the identity card and the stems listing, while the
  recording's `full` mix stays listed;
* the identity card and the Library/Crate search match carry no filesystem
  path, `paths_json`, `names_json`, `provenance_json`, `content_sha256` or
  peaks. The *stems listing* is the one place that exposes a sanitized
  `provenance` object per lane for an imported set (original file name,
  `sample_rate`, `channels`, `duration`, and a `source_sha256`); it still
  carries no absolute path.

Removing the managed-root containment check makes the symlink test fail.
Removing the role/filename equality check makes the tampered-path test fail.
Both were restored with `cmp` before the suite was rerun.

## 11. Instructions

### Claude

1. Use `audio_url` verbatim, and only after confirming it is exactly
   `/api/stems/{set}/audio?name={role}`. Never build it from a label.
2. Preview with `audioController` (owner `preview`, exclusive-play) for the
   whole-stem listen. Use a decoded buffer with
   `start(when, offset, duration)` / `loopStart`+`loopEnd` when the selected
   window must be exact or loop.
3. Get duration from the decoded buffer. Do not infer an imported stem's extent
   from `track.duration`.
4. Draw stem peaks from decoded PCM (`computePeaks`); draw `/api/tracks/{id}/waveform`
   only as the mix, and say so.
5. Take tempo from the identity card and keep `bpm_source` honest. Use
   `Fit to project tempo` / `Speed ×` / `Pitch (time kept)`; never call
   `playbackRate` "pitch kept".
6. Keep one transport. Do not open a second AudioContext, a second preview
   element or a third transport to add a stem focus.
7. Do not add a section request just to read a duration; it is refused unless
   the length is 30/60/90.

### Codex

1. `docs/stem-focus-audio-contract.md` and `tests/test_stem_audio_truth.py` are
   the contract. If a frontend change contradicts them, the change is wrong
   until the PM says otherwise.
2. Keep `/api/stems/{set}/audio` the only stem audio route. Do not add a
   `start/end` route, a peaks route or a duration column for symmetry.
3. Any change to `_validated_stem_path`, `stem_audio_path`,
   `stem_audio_window`, `stem_set_info` or `_probe_audio_layout` must keep the
   refusals above and the sample-accuracy test green.
4. Do not move stretch or pitch work outside `time-math.js`, the realtime
   engine and the offline renderer.

## 12. Evidence

```bash
PYTHONPATH=$PWD/src .venv/bin/pytest \
  tests/test_stem_audio_truth.py -q
# 22 passed

PYTHONPATH=$PWD/src .venv/bin/pytest \
  tests/test_stem_audio_truth.py tests/test_for_your_ears_acceptance.py \
  tests/test_stem_import.py tests/test_stem_names.py tests/test_stem_finder.py \
  tests/test_phase5_backend.py tests/test_phase3_http.py \
  tests/test_track_names_and_sections.py -q
# 115 passed
```

Headless tests and probes prove identity, bounds and sample alignment. They do
not replace the PM listening to a focused stem.

## 13. Not done, on purpose

* No route, field, migration, table or media copy was added.
* No frontend, Arrangement editor, playback or DSP file was changed.
* No Demucs source-range feature and no independent stem tempo.
* No full-suite marathon, no merge, no push, no production data touched.
