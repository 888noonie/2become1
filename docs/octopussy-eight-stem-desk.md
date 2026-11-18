# Operation Octopussy — eight-stem desk, 2026-11-18

## 1. Slice

The Stem Performance Desk now holds **two separated tracks** (groups A and B)
of **up to four lanes each**: eight stem lanes, one transport, one equal-power
A/B crossfader. The single-group API and law remain intact:

- `StemDesk.load(lanes)` is still the single-track wrapper. It clears the desk
  and loads the wrapper as group `A`.
- `StemDesk.loadGroups([{ trackId, title, lanes }])` loads or replaces groups
  non-destructively: loading B never unloads A, and a refused group leaves both
  existing groups untouched.
- Lane keys are ``${trackId}:${name}`` (`A:vocals`, `B:drums`); a missing
  `trackId` defaults to `A`.
- Mute, solo, per-lane gain and the existing silent-lane label keep their
  meanings.

Changed source:

- `src/twobecomeone/studio_static/js/runtime/stem-desk.js`
- `src/twobecomeone/studio_static/js/components/stem-desk-panel.js`

Changed tests:

- `tests/frontend/runtime/stem-desk.test.js` (single-group cases kept; two-group
  loading, keys, solo-across-eight, crossfader, no-wrap transport, end state,
  `unloadGroup`, and budget refusal added)
- `tests/frontend/stem-desk-panel.test.js` (two selects, load each, one
  transport, crossfader, eight rows under two headings, group-qualified ARIA,
  in-place gain update)
- `tests/browser/stem_desk_two_track_audio.js` (new PCM gate)
- `tests/browser/stem_desk_two_track_real.js` (new `--stemsA/--stemsB` gate)
- `tests/browser/stem_desk_audio.js`, `stem_desk_real_audio.js`,
  `stem_desk_ux.js` (import/selector updates for the new runtime and panel)

No LiveMixer bus, server route, `studio.py`, `webapp.py`, stem crate,
Action/Ghost path, canonical library, upload path or persisted project/renders
was touched. The panel only calls the existing read-only `listTracks` and
`listStems` helpers.

## 2. Graph and mixer law

There is one master GainNode connected to the destination. Group A and group B
each have one gain node feeding master. Each lane has one gain node feeding its
group. The crossfader imports `equalPowerGains` from `js/runtime/crossfader.js`;
0 is A only, 100 is B only, 50 gives both groups `1/√2`. With only one loaded
track the crossfader is disabled and that group's gain is forced to 1, so a
single track is never faded to silence.

Solo is evaluated **across all eight lanes**, not per group:

```
anySolo over every lane ? lane.solo : !lane.muted
lane gain = audible ? dbToLinear(clamp(gainDb, -60, +6)) : 0
```

Soloing `A:vocals` therefore suppresses B as well as the other A lanes. Releasing
solo restores the previous per-lane mute flags. A silent lane keeps its
`silentRmsDb <= -50` label, still loads, still obeys mute/solo/gain and is never
removed.

## 3. Limits and memory budget

`STEM_DESK_LIMITS` now includes:

| Limit | Value |
| --- | --- |
| tracks (groups) | 2 |
| lanes per track | 4 |
| lanes for the desk | 8 |
| fetch bytes per stem | 40 MiB |
| decoded bytes per stem | 40 MiB |
| decoded bytes per track | 160 MiB |
| decoded bytes for the desk | 320 MiB |
| gain range | −60 … +6 dB |
| silent RMS threshold | −50 dBFS |

A group is decoded into temporary lane objects first. It is committed only if
it fits the track lane budget and the desk byte/lane/track budgets. Otherwise
it is refused with `S_DESK_FULL`; already-loaded groups are not unloaded or
modified. A media failure inside an otherwise valid group is still an honest
`S_STEM_PARTIAL`, matching the old single-track behavior.

## 4. Transport: no wrapping by default

`play({ loop = false, offset = 0 })` now defaults to **no loop**. Every
scheduled lane receives the same `when` (one context clock plus the 0.05 s
lead), so start alignment is tested as a schedule property. There is
deliberately **no per-lane `loopEnd`**: a loop, when explicitly requested,
loops the whole buffer rather than letting each lane define its own end point.

If `offset >= lane.durationSeconds`, that lane is not scheduled at all. For a
finite programme the desk records `endAt`. Once the context clock reaches it,
`state()`/`position()` stop the sources and return status to `ready`; they do
not keep reporting a playing transport. This is proven with Chromium's
`OfflineAudioContext` in `stem_desk_two_track_audio.js` and with real decoded
stems in `stem_desk_two_track_real.js`.

`unloadGroup(trackId)` removes and disconnects only that group, subtracts only
its decoded bytes and keeps the other group loaded. `dispose()` still closes
the AudioContext **only when the desk owns it**.

## 5. Panel

The panel renders:

- two track selects, `Track for group A` and `Track for group B`, each with its
  own Load button;
- one Play/Stop transport and one position label;
- one crossfader slider with `gainA`/`gainB` readout, disabled when only one
  track is loaded;
- eight rows under two group headings (`Group A · title`, `Group B · title`);
- provenance (`demucs · model · device` or the ffmpeg center/side note) and the
  “effectively silent in this separation” note on each affected row;
- group-qualified accessible names such as `Mute A · Vocals`, `Solo B · Drums`.

Changing a lane gain updates that row's value and dB readout **in place**; the
row element and focus are not rebuilt during the drag. Mute/solo re-render the
existing rows rather than inventing new state.

## 6. Honesty: one clock is not beat matching

Both groups share one AudioContext clock and start with one `when`. That means
**sample-start alignment**, not tempo sync, beat grid alignment, warp or beat
matching. The demonstration tracks are different tempos (100 BPM and 120 BPM);
the desk does not time-stretch either group to match the other. A future beat
matcher would need a separate, explicitly tested contract.

The headless PCM/browser gates prove graph values and captured samples. They do
not prove that sound reached a speaker. **Audible acceptance remains the PM's
(or owner's) listening judgement.**

## 7. User-stem contract — documented, not implemented

This slice accepts only stems already separated in the library and served by the
existing read-only stem endpoints. A user-supplied stem contract would need:

- two groups of up to four named lanes, each with an audio URL and provenance;
- the same 40 MiB/160 MiB/320 MiB decode budget and bounded fetch behavior;
- explicit ownership and persistence for user media;
- honest labels for unknown or silent lanes.

No upload route, persistence, UI, or server support for user-supplied stems is
part of this change. The contract is recorded here so a later slice does not
invent incompatible semantics.

## 8. Verification (commands and results)

All commands were run from the worktree root.

```bash
node --test tests/frontend/runtime/stem-desk.test.js
# 26 tests, 26 pass, 0 fail

node --test tests/frontend/stem-desk-panel.test.js
# 15 tests, 15 pass, 0 fail

node --test tests/frontend/*.test.js tests/frontend/**/*.test.js
# 504 tests, 504 pass, 0 fail (npm test equivalent; run with local
# node_modules/.venv links because this worktree starts without them)

node --test tests/browser/stem_desk_two_track_audio.js
# 6/6 two-track signal-level checks passed

node --test tests/browser/stem_desk_audio.js
# 8/8 signal-level checks passed (single-group regression)

node --test --env-file=tests/browser/artifacts/two-track.env \
  tests/browser/stem_desk_two_track_real.js
# 8/8 two-track real-stem checks passed
```

The real-stem gate used the prepared demonstration media and ids:

```text
stems A: /tmp/opencode/octopussy-demo/stems/2022192fb2384b3c91e42282d74a6f95
stems B: /tmp/opencode/octopussy-demo/stems/847423aefc3b4ba993a4dbfb16e4eeef
ids:     /tmp/opencode/octopussy-fixtures/ids.json
trackA:  c383b6d0302d41918056b6134dc40661 (stem set 2022192f…)
trackB:  9ac89f665e22431ca5665a875971a540 (stem set 847423ae…)
```

The gate supports the normal form:

```bash
node tests/browser/stem_desk_two_track_real.js \
  --stemsA <dir> --stemsB <dir> --ids /tmp/opencode/octopussy-fixtures/ids.json
```

### Captured sample measurements

Synthetic OfflineAudioContext gate (eight probe lanes, amplitude 0.05):

| Scenario | A lane amplitude | B lane amplitude | Peak |
| --- | --- | --- | --- |
| crossfader 0 | 0.050000 | ≈0 (≤3×10⁻⁶) | 0.1779 |
| crossfader 50 | 0.035356 | 0.035354 | 0.2268 |
| crossfader 100 | ≈0 (≤2×10⁻⁶) | 0.050000 | — |
| end of programme | tail peak 0 | — | status `ready` |

Real-stem gate (100/120 BPM demonstration sets):

| Measurement | Result |
| --- | --- |
| solo A vocals RMS / peak | −30.45 dBFS / −16.28 dBFS |
| solo A suppresses all of B | correlation 1.000000, ratio 1.000000 |
| crossfader 0 vs A group reference | correlation 0.99999999999985, ratio 1.414214 (=√2) |
| crossfader 100 vs B group reference | correlation 0.99999999999991, ratio 1.414214 (=√2) |
| two-track midpoint RMS / peak | −18.58 dBFS / −3.14 dBFS (no clip) |
| end tail | peak 0, status `ready`, `playing:false` |

Static asset report from the frontend run: 69 files, 696,930 bytes, baseline
650,905 bytes, **+46,025 bytes (+7.07%)**. The growth is the two-group runtime
and panel plus their tests; the 15% / 50,000-byte investigation trigger was not
reached.

`git diff --check bdad67a769a8eaca0ef0d9f77993f2927634a1b9..HEAD` was clean.

## 9. Limitations

- **A/B are start-aligned, not beat-matched.** 100 BPM and 120 BPM material
  stays at its own tempo; there is no warp, tempo ratio or phrase lock.
- The real-stem gate runs headless Chromium on captured PCM. It cannot prove
  speakers, headphones or room acoustics; the PM must audition.
- A real separation can still contain effectively silent lanes. The desk
  labels them truthfully; it does not repair the separation.
- The user-supplied stem contract is documentation only; no upload or
  persistence exists.
- The frontend suite needed local `node_modules` and `.venv` links in this
  fresh worktree. Those links are gitignored and are not part of the commit.
