# Stem Desk engineering guide

Practical rules, procedures and failure modes for the Stem Performance Desk,
drawn from SOUND CHECK (2026-11-17), the OCTOPUSSY build (2026-11-18) and the
challenges that followed. `AGENTS.md` carries the short version; this file
carries the detail. Acceptance record:
[`milestone-2026-11-18-eight-stem-desk.md`](milestone-2026-11-18-eight-stem-desk.md).

## 1. The audio graph

```
lane GainNode (mute / solo / lane gain)
  → group GainNode (equal-power crossfade × per-track level)
    → master GainNode (unity)
      → WaveShaper soft-clip ceiling (linear ≤ 0.8, saturates at 1.0)
        → destination
```

- **One `AudioContext` per mounted panel**, owned by the panel
  (`ownsContext: true`) and closed on dispose. Never reuse or close LiveMixer's
  context, and never open a second context to add a track.
- **One `when` per group** in a `play()`. Every stem inside a group shares that
  onset; a stored per-group entry nudge may move the group's onset, which is
  still one clock and one transport. Position comes from the context clock, not
  a media element.
- **One master, one ceiling.** No per-track analyser, no limiter that applies
  automatic makeup gain: the Web Audio `DynamicsCompressorNode` does, and it
  raised quiet material by 1.216× when tried here.
- The desk must not route through LiveMixer's media-element decks or its
  pre-mixed stem-stack bus; those are different sources and clocks.

### Mute / Solo / Gain law

```js
anySolo = lanes.some(l => l.solo)                 // all eight lanes
audible = anySolo ? lane.solo : !lane.muted        // solo wins over mute
lane.node.gain = audible ? dbToLinear(clamp(db,-60,+6)) : 0
group.node.gain = equalPowerGains(xfade) * dbToLinear(clamp(level,-40,+6))
effectiveGain = audible ? laneGain * groupGain : 0
```

- `audible` answers "would this lane be heard if its track were open";
  `effectiveGain` answers "what does it contribute now". Show both when a
  crossfader can silence a soloed lane, or the silence looks like a bug.
- Mute flags survive solo release. A bare lane name must be refused when two
  tracks both have it (`S_AMBIGUOUS_STEM`); address lanes as `track:name`.

### Transport

- `play({ loop })` takes one base `when`, applies each group's stored entry
  offset, schedules no per-lane `loopEnd`, skips a lane whose `offset` is past
  its end, and records `endAt` for the latest lane end.
- The desk returns to `ready` at `endAt`; never leave `playing` after the
  programme ends.
- One loaded track keeps `loop: true` (accepted four-stem behaviour). Two tracks
  play once: looping unequal lengths wraps them out of phase.
- A successful load **stops playback** and returns to `ready`. Say so; do not
  imply a group can be swapped into a running mix.
- Re-read the transport at commit time, not at load entry: Play can be pressed
  while a fetch is still pending.

## 2. Honesty rules

- **One clock is not beat matching.** Write "started on one clock", never
  "synced", "in time", "locked" or "beat-matched". Different tempos drift.
- **Provenance is server-authored.** Show method, model, device and stem-set id.
  Never label center/sides as vocals, never label user or ffmpeg material as
  Demucs, and never let the client invent a label the server did not produce.
- **Silent lanes stay visible.** A lane at ≤ −50 dBFS RMS is labelled
  "effectively silent in this separation", still loads, still obeys M/S/gain,
  and says so when soloed. A correct silence must not look like Stop.
- **Refusals quote the runtime.** Show the code and the measured byte counts
  (`S_STEM_TOO_LONG`, `S_DESK_FULL`, `S_STEM_LAYOUT`), not "some stems are
  unavailable".
- **Audible acceptance is a separate gate.** Headless PCM and screenshots never
  prove speakers. Only the owner's listening does.

## 3. Test procedure

Run from the worktree with `node_modules`/`.venv` linked to the owner checkout
when the worktree is fresh.

```bash
npm test                                   # frontend, 524/524 at acceptance
.venv/bin/pytest -q                        # python, 580 passed / 1 skipped
node tests/browser/run.js --viewport 1280x800
node tests/browser/run.js --viewport 390x844
node tests/browser/stem_desk_ux.js --viewport 1280x800
node tests/browser/stem_desk_two_track_ux.js --viewport 1280x800
node tests/browser/stem_desk_two_track_ux.js --viewport 390x844
node tests/browser/stem_desk_two_track_audio.js            # synthetic PCM
node tests/browser/stem_desk_two_track_real.js --stemsA <dirA> --stemsB <dirB>
node tests/browser/stem_desk_audio.js                      # single-desk regression
node tests/browser/stem_desk_real_audio.js --stems <dir>
node tests/browser/demo_two_track_smoke.js http://127.0.0.1:<port>
```

**Real separated audio, not just tones.** Synthetic probes prove the graph;
only decoded Demucs stems prove the media. Keep both, and keep the real gate
against two tracks at different tempos.

**Negative controls are part of the proof.** A test that cannot fail on the
previous code is not evidence. Reproduce the defect first:

| Defect | Control | Expected old / new |
| --- | --- | --- |
| silent stems | `stem_desk_real_audio.js` on a tone fixture | 13/15, fails the two silent lanes / 15/15 |
| short-lane wrap | unequal lanes, measure the short lane after its end | 0.244 and `playing` / 4×10⁻¹⁷ and `ready` |
| stuck transport | load B pending → Play → release B | `playing`, source alive / `ready`, none |
| clipping | hot lanes + +6 dB lane + +6 dB track | 16.795 / 1.000 |
| null node mid-load | play inside the missing-node window | 1 null connection / 0 |

**Assertions that actually pin behaviour.** Prefer PCM energy per lane and per
group over node values; assert mute ≡ solo-complement; assert a gain change
leaves other lanes bit-identical; assert Stop is exactly silent; assert a
replacement refusal cannot read as a success.

## 4. Memory and resources

- Budgets: 40 MiB fetch and 40 MiB decoded per stem, 160 MiB per track, 320 MiB
  per desk, mono or stereo only (`S_STEM_LAYOUT`).
- Decoded size follows the **context** sample rate, not the file header: 40 MiB
  is ≈118.9 s at 44.1 kHz and ≈109.2 s at 48 kHz.
- Rejections happen after decode for byte ceilings (peak-memory gap is real),
  and on declared `Content-Length` before the body where possible.
- `unloadGroup()` frees one group and its bytes; `unload()`/`dispose()` clear
  both. The browser reclaims lazily: measure with a forced GC and with repeated
  cycles, and report "no per-cycle growth" rather than "immediate reclamation".
- Re-measure on the target machine before quoting a ceiling; one headless
  Chromium is not a mobile guarantee.

## 5. Concurrency, cancellation, disposal

- Two loads may overlap. Merge at commit time against the current group set and
  re-check tracks, lanes and bytes there; a load that commits from its entry
  snapshot drops the other track.
- Reserve a single load slot in the UI **before any `await`**, and release it in
  a `finally` that covers no-track, empty-library, failed-request and
  throwing-listener paths.
- A disposed panel must not announce, start a request, or commit decoded audio.
  The runtime refuses new loads after `dispose()` and leaves the desk `idle`.
- An announcement listener is a viewer: contain it so its failure cannot escape
  a handler.
- A load in flight stops the transport by design; do not announce that as "the
  stem desk reached the end".

## 6. Repository operation

- Isolated data and ports: `--data-dir /tmp/... --port 8766/8767` on loopback
  only; never touch `~/.local/share/2become1` or the owner's library.
- Separate the paths that start separation from `ingest()` and the CLI; uploads
  and YouTube imports keep the full mix and queue `submit_separation`.
- Feature work happens on an isolated branch/worktree; the owner checkout and
  the accepted integration branch stay untouched.
- Native MISIX Q assignment (worktree, casefile, re-run checks) is not the same
  as direct OpenCode work; label which one produced a commit.
- Promotion and remote writes need separate owner authority. A green suite,
  a model's PASS or a milestone document grants none.

## 7. Where the evidence lives

- Diagnosis and measurements: [`stem-desk-audio-diagnosis.md`](stem-desk-audio-diagnosis.md)
- Demonstration plan: [`stem-desk-demonstration.md`](stem-desk-demonstration.md)
- Slice engineering record: [`octopussy-eight-stem-desk.md`](octopussy-eight-stem-desk.md)
- Acceptance: [`milestone-2026-11-18-eight-stem-desk.md`](milestone-2026-11-18-eight-stem-desk.md)
- Raw captures from this mission:
  `/tmp/opencode/octopussy-evidence/` (probes, controls, PCM, screenshots);
  treat that path as transient and re-run the commands rather than citing it as
  a permanent record.

## 8. Owner-supplied stems (Stem Passport)

- Roles are explicit: vocals, drums, bass, other. Never infer a role from a
  filename.
- Import accepts **WAV only** and never transcodes or resamples. It checks
  decode, one sample rate, one channel count (1 or 2) and durations within
  10 ms; a mismatch is refused with the measured values.
- Publish atomically under the existing `stems/<set>/<role>.wav` layout; a
  failed import must remove its staged inputs and leave no partial set.
- Provenance: `method="imported"`, `device="user"`, `model_name` =
  `sha256:<set hash>`, plus per-lane original name and content hash. Never call
  it Demucs and never start a separation job for an import.
- The desk shows an owner-supplied set ahead of separation output for the same
  lane, deterministically; the other files stay on disk.
- Equal duration is not alignment. Say so in the UI and in any demo notes.
