---
name: stem-audio-contract
description: >
  The verified 2become1 stem audio and identity contract: preview URL, HTTP
  Range, sample-aligned 30/60/90 s sections, the cached stem waveform, rename
  identity, search matches, missing-media refusals, audio ownership, and the
  difference between varispeed and pitch-preserving stretch. Use before
  changing a stem route, a stem waveform, a preview, or a claim about a stem's
  duration or tempo.
---

# Stem audio and identity contract

Written after OPERATION STUDIO SURGEON (2026-11-27) on
`integration/studio-surgeon` — `e705a12` at time of writing (`950c8d5` was the
waveform-cache repair underneath it). Read the detail, then trust the code:

| Read | For |
| --- | --- |
| `docs/stem-focus-audio-contract.md` | The measured route contract, budgets and refusals |
| `docs/studio-surgeon.md` | The Stem-Focus panel, clip mode and its limits |
| `docs/stem-workshop-act-i.md` | The **proposed** Demucs segment contract (migration 15) and independent stem tempo |
| `docs/stem-finder.md`, `docs/stem-passport.md` | Search matching, owner-supplied stems |
| `skills/stem-workspace/SKILL.md` | Panel invariants and workspace handoff |

## Status: do not blur these four

| Capability | Status | Evidence |
| --- | --- | --- |
| Eight-stem desk limits and the one-transport law | **owner-accepted by ear** (2026-11-18) | `docs/milestone-2026-11-18-eight-stem-desk.md` |
| Black Tie arrangement surface | **owner-accepted** at `e53b266` | `AGENTS.md`, `docs/black-tie.md` |
| Stem identity `(stem_set_id, role)`, `names_json`, rename routes | implemented, tested | migration 14; `tests/test_stem_names.py`, `tests/test_stem_audio_truth.py` |
| Library/Crate stem search `match` on track results | implemented, tested | `tests/test_stem_finder.py` |
| Stem audio route: full + `Range` + 30/60/90 section | implemented, tested | `tests/test_stem_audio_truth.py` (22) |
| Stem waveform route, cached by file identity | implemented, tested on integration | `tests/test_stem_waveform.py`; `docs/studio-surgeon-act-iii.md` |
| Stem-Focus panel (Library, Crate, clip mode) | implemented, tested, **owner accepted** at `e705a12` | `tests/frontend/stem-focus.test.js`, `tests/browser/stem_focus.js` 37/37 |
| Record Sleeves (`170b270`) | implemented and tested in the released workspace | `docs/record-sleeves.md` |
| Demucs source segments, `segment_key`, reuse of a full set | **proposed only**, nothing built | `docs/stem-workshop-act-i.md` §2 |
| Independent stem tempo controls | **proposed only** | `docs/stem-workshop-act-i.md` §3 |
| Sample-accurate Focus loop | **not delivered, and not claimed** | See "The loop seam" below |

## Identity and provenance

- A stem **is** `(stem_set_id, role)`. `role` is `vocals`, `drums`, `bass`,
  `other`, and `center`/`sides` for a channel split. It is the `paths_json` key
  and the audio route's `name`.
- `display_name` is presentation only. Migration 14 adds
  `stem_sets.names_json TEXT` (nullable, no backfill); `PATCH
  /api/stem-sets/{id}/names` writes it with a single conditional update. A
  rename never touches the role, the set id, the stored `<role>.wav`, the
  bytes or the source recording.
- `GET /api/stem-sets/{id}` is the identity card: track, `bpm`, `bpm_source`
  (`entered` only for an owner override), method, model, device, and the roles
  whose files still validate. It omits dead roles; it carries no media path.
- `full` is the **recording's mix** at `/api/tracks/{id}/audio`. It is not a
  stem and `name=full` is refused on the stem route.
- Search (`GET /api/tracks?q=`, `/api/crate?q=`) attaches
  `match: {track, stems}` only when at least one validated stem matched.
  `total` counts **tracks**, so several stems on one recording are one result.
  Match reasons are `label`, `role`, `track`.
- **Readiness is not the search match.** A Crate item's own readiness `stems`
  object carries `status` (`quad`, `center_sides`, `partial`), its roles and its
  actions. Search adds a separate `match`. Do not read one as the other, and do
  not count `match.stems` toward `total`.
- A stem match requires `status = 'complete'`, a known role in `paths_json`, a
  file that validates beneath `stems/`, and a label/role/source-name substring.
  Center/sides are a channel split, never `vocals`.
- Saved arrangements store `source.stemSetId`, `source.role` and the audio URL
  — never the label. A rename cannot break a saved project.

## Routes that exist

| Route | Contract |
| --- | --- |
| `GET /api/stems/{set}/audio?name={role}` | Stored bytes; `Accept-Ranges: bytes`; `206` on `Range`, `416` when unsatisfiable; `download=true` → attachment |
| `…&start=S&duration=N` | `N` exactly 30/60/90; `S` in `[0, 3600]`, fractional; cut by sample index; keeps rate, channels and sample width; the remainder when longer than the file; the exact end is refused |
| `GET /api/stems/{set}/waveform?name={role}` | `{version:1, bins:1200, peaks, duration_sec}`; cached at `waveforms/stems/{set}.{role}.json` |
| `GET /api/tracks/{id}/stems` | The chosen playable set plus `variants[]` (imported sets also expose sanitized `provenance`) |
| `GET/PATCH /api/stem-sets/{id}[/names]` | Identity card; set or clear labels |

**No stem duration field exists.** Duration is the decoded buffer's, or the
waveform payload's `duration_sec`. `track.duration` is the recording's: an
imported set is only validated to share one timeline *with itself* (±10 ms),
never against the mix.

**Waveform cache identity** is `[st_dev, st_ino, st_size, st_mtime_ns,
st_ctime_ns]` plus the payload `version` and bin count. A malformed cache is
recomputed; a cache write failure still serves the response; concurrent misses
publish through separate temp files and an atomic replace. Generation forces
the WAV demuxer and never writes source audio.

## What must stay refused

Every one of these is a live guard, and each has a test that fails when the
guard is removed:

- absolute database path, `stems/../../x.wav`, a `tracks/…` path, a symlink
  leaving the managed root;
- a differently named real file inside the root, or another role's file under
  the `vocals` key (role/filename equality);
- an unknown set, an unknown role, `full`, an empty name;
- a deleted or corrupt file — refused **and** absent from the card and listing;
- malformed `paths_json` — reported as no stems, never raised;
- a section length other than 30/60/90, a start outside `[0, 3600]`, a start at
  or past the last sample.

## Audio ownership

- One preview element (`js/audio.js`), registered by `app.js` through
  `useFocusAudio`. Never import `audio.js` from a component: it constructs
  `Audio()` at import time.
- One `AudioContext`, made by Play. Opening a Focus panel plays nothing and
  makes no context.
- `twobecomeone:exclusive-play` is the handshake: Library preview, Stem-Focus,
  the Performance desk and the Arrangement stop each other. The panel names
  what interrupted it.
- Seeking works because the full route sends `Range`. The **section** response
  has no `Accept-Ranges`; scrub on the full route.

## Tempo and stretch: keep the words honest

`js/arrangement/time-math.js` is normative.

| Concept | Rule |
| --- | --- |
| `rate` | source seconds consumed **per output second** |
| `beat_sync` | `rate = masterBpm / asset.nativeBpm` |
| `manual` | `rate = clip.customStretchRatio` |
| Output duration | `sourceSpan / rate` |
| Pitch | `2 ** (semitones / 12)`, no timing change |
| Bypass | only `rate === 1` and `0` semitones (live routing `bypass-unity`) |
| Qualified | `0.857 … 1.2` at 0 st; outside it still plays and reports `STRETCH_UNQUALIFIED` |

`playbackRate` on a media element or a buffer source is **varispeed**: speed and
pitch together. The Performance decks use it. It is not Signalsmith, and it must
never be labelled "speed, pitch kept". A freshly placed Library stem is `manual`
at ratio 1.

## Budgets (do not raise one alone)

| Budget | Section load | Full length |
| --- | --- | --- |
| Per stem, decoded | 40 MiB | 128 MiB |
| Per four-lane group | 160 MiB | 512 MiB |
| Eight-lane desk | 320 MiB | 1024 MiB |

At 48 kHz, 40 MiB is 109.2 s of stereo; 128 MiB is 349.5 s. Decoded size follows
the **context** rate, not the file header. A stored stem may be as large as the
full-length ceiling; the default load still cuts a section. Machine RAM is not
this allowance.

## The loop seam

The Focus window is enforced per animation frame through media seeks. It is
**not sample-accurate**, and a loop boundary can vary by the frame interval.
That limit is unchanged and must be stated honestly.

The 2026-11-27 repair (`e705a12`, "Keep Stem-Focus audition resets at the
selected In point", on `integration/studio-surgeon`) fixed the *reset* defects,
not the precision limit. Verified evidence, recorded before the commit:

- Unit suite 39/39.
- Real Chromium:
  - a 10 s loop repeatedly seeks back to In (three `seeked` at 34);
  - a non-loop window stops at Out and parks at In;
  - the native `ended` race no longer ends the loop — two native `ended` events
    returned to In and resumed;
  - 0.65 s loops passed in the Crate and in a placed Arrangement clip.
- Negative controls before it: the reset/ownership tests failed, and a test requiring
  the seekable full URL was red when the section URL was used.

PM confirmed the repair by ear and accepted Stem-Focus at `e705a12`. Clip
audition seeks on the full-stem Range URL and maps back to the section-local
cursor. The Arrangement still renders from its stored section reference.
Loop timing remains approximate. See the
[release handoff](../../docs/studio-surgeon-act-iii.md) for remaining limits.

## Panel modes: one panel, two kinds of edit

`js/stem-focus.js` is ONE panel. Which surface opened it decides what an edit
means.

- **Asset mode** (Library, Crate): audition the stored stem, rename it, and
  place a selection. Placement is one `loadStemToTrack` cut from an exact
  30/60/90 s section, so it is one undo step and the stem file is untouched.
- **Clip mode** (Arrangement): every tool is an ordinary `DawSession.apply`
  command over the clip's existing edit API — trim-to-selection (trim → slip →
  trim, as one batch), split, gain, fades, Fit to project tempo, cut/copy/
  duplicate/delete. One history, one undo. Never a second project or snapshot.
- Source offsets move only through `time-math.js`; a selection of the same
  length is a slip, and a clip that already uses the whole stem has no slip
  room until it is trimmed.
- "Hear it in place" plays the Arrangement transport, so gain, fades, stretch
  and pitch are the real ones; the panel's own audition plays the source.

## Proposed, not built

`docs/stem-workshop-act-i.md` holds the design; nothing below exists in code.

- **Demucs source segments:** optional `start_sec`/`end_sec` on the separation
  body, cut server-side before Demucs with the same sample rule as the section
  route. Migration **15** would add `segment_key` (canonical sample indices,
  `''` = whole recording) to the cache key and `segment_json` to record the
  span, the source rate and any full set it was reused from.
- **Reuse:** if a whole-recording set for the same hash/method/model validates,
  cut the requested span from its stems instead of running Demucs again.
- **Segment-aware identity:** a segment's local zero is its own first sample, so
  an asset needs the segment start while `clip.sourceOffsetSec` stays local.
  Without `segment_key`, a full set can answer a section request or a section
  can poison the full cache.
- **Independent stem tempo:** reuse the existing Signalsmith path and the
  `sourceAdvanceRate` convention; do not add a DSP engine.

## What not to do

- Do not add a second stem audio route, a stem duration column, or a peaks
  route "for symmetry". The three routes above cover preview, section and peaks.
- Do not derive a stem's in/out bounds from `track.duration` for an imported set.
- Do not synthesise a waveform, or draw mix peaks under a stem's name.
- Do not store a stem label in `ProjectState`.
- Do not treat a green unit suite as owner listening acceptance.
