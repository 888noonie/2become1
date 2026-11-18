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
0 is A only, 100 is B only, 50 gives both groups `1/√2`.

**There are two independent gain layers**, which is why a crossfade move cannot
wipe out a track level:

```
group gain = equalPowerGains(crossfader) × dbToLinear(track level, −40…+6 dB)
lane gain  = audible ? dbToLinear(lane gain, −60…+6 dB) : 0
effectiveGain (reported) = lane gain × the lane's own group gain
```

The per-track level defaults to 0 dB and is set with `setTrackLevel(trackId,db)`
from the group's own slider. Moving the crossfader rewrites only the equal-power
factor. At the crossfader midpoint each group sits at `1/√2`, so a track sounds
about 3 dB quieter there than at its own end of the fader; that is the standard
equal-power behaviour, and the panel shows `gainA`/`gainB` so it is visible
rather than surprising.

With only one loaded track the crossfader is disabled and that group's gain is
forced to 1 (times its level), so a single track is never faded to silence.

### Output ceiling

The master feeds one `WaveShaperNode` before the destination. Its curve is
**exactly linear below 0.8**, then compresses quadratically and reaches full
scale at 1.0; inputs past full scale clamp to that end point. This is output
protection, not a mastering chain: a normal mix is bit-identical to the old
path, while the allowed worst case (+6 dB per lane plus +6 dB per track on
eight lanes) cannot hard-clip. A compressor was rejected because the Web Audio
`DynamicsCompressorNode` applies automatic makeup gain, which would change
quiet material — the first attempt did exactly that (levels rose 1.216×) and
was removed.

Solo is evaluated **across all eight lanes**, not per group:

```
anySolo over every lane ? lane.solo : !lane.muted
lane gain = audible ? dbToLinear(clamp(gainDb, -60, +6)) : 0
```

Soloing `A:vocals` therefore suppresses B as well as the other A lanes. Releasing
solo restores the previous per-lane mute flags. The panel states this policy in
plain words (“Solo applies across both tracks…”) and the runtime reports a
post-crossfade `effectiveGain`, so a soloed lane on a closed track reads 0
instead of looking broken. A silent lane keeps its
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
| per-lane gain range | −60 … +6 dB |
| per-track level range | −40 … +6 dB |
| silent RMS threshold | −50 dBFS |

A group is decoded into temporary lane objects first. It is committed only if
it fits the track lane budget and the desk byte/lane/track budgets. Otherwise
it is refused with `S_DESK_FULL`; already-loaded groups are not unloaded or
modified. A media failure inside an otherwise valid group is still an honest
`S_STEM_PARTIAL`, matching the old single-track behavior.

The panel shows the runtime's own reason, not a generic failure: a refusal
reads e.g. `S_STEM_TOO_LONG — stem vocals decodes to 45312000 bytes; the desk
holds at most 41943040 per stem`, and a partial load names the first unavailable
lane with its code. A refused *replacement* of an already-loaded group therefore
cannot be mistaken for a success.

## 4. Transport: no wrapping by default

`play({ loop = false, offset = 0 })` defaults to **no loop**. The panel keeps
the accepted four-stem experience by asking for `loop: true` when exactly one
track is loaded, and asks for `loop: false` for a two-track programme. Looping
two tracks of different lengths would wrap them against each other, so that is
deliberately not offered. Every scheduled lane receives the same `when` (one
context clock plus the 0.05 s lead), so start alignment is tested as a schedule
property. There is
deliberately **no per-lane `loopEnd`**: a loop, when explicitly requested,
loops the whole buffer rather than letting each lane define its own end point.

If `offset >= lane.durationSeconds`, that lane is not scheduled at all. For a
finite programme the desk records `endAt`. Once the context clock reaches it,
`state()`/`position()` stop the sources and return status to `ready`; they do
not keep reporting a playing transport. This is proven with Chromium's
`OfflineAudioContext` in `stem_desk_two_track_audio.js` and with real decoded
stems in `stem_desk_two_track_real.js`.

Loading a group is **non-destructive to the other group's decoded audio**, but
it is not silent about the transport: if anything is playing when the load
commits, the desk stops all sources, rebuilds the graph and returns to `ready`.
That includes the case where Play was pressed while a fetch was still in
flight — the transport state is re-read at commit time, not at entry, because a
load that completed during playback used to leave old sources running behind a
disconnected graph.

`unloadGroup(trackId)` removes and disconnects only that group and subtracts
only its decoded bytes; it also stops playback and rebuilds the remaining
group's graph. `dispose()` still closes the AudioContext **only when the desk
owns it**.

## 5. Panel

The panel renders:

- two track selects, `Track for group A` and `Track for group B`, each with its
  own Load button;
- one Play/Stop transport and one position label;
- one crossfader slider with `gainA`/`gainB` readout, disabled when only one
  track is loaded;
- one level slider per group (`-40…+6 dB`), independent of the crossfader;
- eight rows under two group headings (`Group A · title`, `Group B · title`);
- provenance (`demucs · model · device · set <first 8>` or the ffmpeg
  center/side note) and the “effectively silent in this separation” note on each
  affected row; the stem-set id is what distinguishes two tracks that both have
  a “vocals”;
- group-qualified accessible names such as `Mute A · Vocals`, `Solo B · Drums`;
- a standing policy line: solo applies across both tracks, the faders apply on
  top, and — with two tracks loaded — that they start on one clock at their own
  tempo and are not beat-matched. The line is visible before Play, not only
  after it.

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
# 8/8 two-track signal-level checks passed

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

Static asset report from the frontend run (`tests/frontend/static-size.test.js`):

| Measurement | Value |
| --- | --- |
| total | **708,866 bytes across 69 files** |
| baseline | 650,905 bytes across 67 files |
| delta | **+57,961 bytes (+8.90%)** |
| trigger | +50,000 bytes crossed; 15% not crossed |

That crosses the byte trigger, so the investigation is recorded here per
`docs/static-asset-policy.md`:

- `js/runtime/stem-desk.js` 23,247 → **31,989 bytes** (+8,742): two group
  gains, the second gain layer, the output ceiling, the layout guard and the
  commit-time merge.
- `js/components/stem-desk-panel.js` 12,905 → **24,337 bytes**: two track
  pickers, per-group level, crossfader, policy line, in-place row updates.
- `js/runtime/crossfader.js` and the rest are unchanged (only imported).
- The growth is behaviour the owner asked for, not padding; the journeys at
  both viewports still pass and no file was minified or compressed.

The five largest files remain `ghost-controller.js` (55,945), `live-mixer.js`
(39,556), `stem-desk.js` (31,989), `studio.css` (30,601) and `plan.js` (27,543).

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

## 10. Independent challenge and what it changed

Cursor Grok 4.5 (High) challenged the design read-only before this
implementation was accepted. Its verdict was **NEEDS CHANGES**, and the
following blocking items were adopted rather than argued away:

| Finding | Change made |
| --- | --- |
| Group gain collapsed into the crossfader would overwrite a track level | added the second gain layer `setTrackLevel` / per-group slider |
| The accepted single-track desk loops; a blanket `loop:false` regresses it | panel loops for one track, plays once for two |
| `effectiveGain` ignored the group gain, so a crossfaded-out solo looked broken | `effectiveGain = lane gain × group gain`; policy stated in the UI |
| 320 MiB was asserted, not measured | measured on this machine (§11) |
| A lane needs its stem set to be identifiable | `stemSetId` carried per lane and shown in provenance |
| "Played N stems together" overclaims | "Started N lanes on one clock … not tempo or beat matching" |
| The wrap defect had no negative control | proven below against the pre-change runtime |

Non-blocking notes kept open: the `-60 dB` `audible`/`effectiveGain` edge, and
`stem_audio_path` status hardening (both pre-existing and unchanged here).

## 11. Measured memory (this machine, headless Chromium)

All figures below are copied from the probe files in
`/tmp/opencode/octopussy-evidence/` (`memory-probe.json`,
`memory-probe-ceiling*.json`, `cycle-probe.json`). They are one machine's
measurements, not a browser guarantee.

Real two-track demonstration stems (19.2 s and 16.0 s, eight lanes) decoded by
a real `AudioContext`, which Chromium runs at **48 kHz** and therefore
resamples these 44.1 kHz files:

| Stage | Used JS heap |
| --- | --- |
| before load | 0.68 MB |
| after eight lanes decode | 52.41 MB |
| during playback | 52.42 MB |
| after `unloadGroup('B')` | 52.44 MB (4 lanes) |
| after `unload()` | 52.44 MB (0 lanes) |
| after `dispose()` + context close | 52.45 MB |
| after a forced GC | 52.29 MB |

Desk accounting at load: **51.56 MiB decoded**, **6.45 MiB per lane**. The
earlier 47.37 MiB figure came from an `OfflineAudioContext` at 44.1 kHz; the
same files decode larger at 48 kHz. The sample rate of the context, not the file
header, decides the decoded size, so the duration a lane limit buys is not a
single number:

| Context rate | 40 MiB per-lane budget buys | 320 MiB desk budget buys |
| --- | --- | --- |
| 44.1 kHz | ≈118.9 s per lane | ≈951 s across eight lanes |
| 48 kHz (Chromium real) | ≈109.2 s per lane | ≈873 s across eight lanes |

**The guard was exercised at the ceiling and refused honestly.** Eight 118 s
stereo stems were offered to a real `AudioContext`; the first lane decodes to
45,312,000 bytes, above the 40 MiB per-lane ceiling, and the desk refused with
`S_STEM_TOO_LONG` (“stem vocals decodes to 45312000 bytes; the desk holds at
most 41943040 per stem”) without loading anything. So the ceiling is enforced
per lane before a track can starve the desk, and the refusal is truthful rather
than a crash.

In an `OfflineAudioContext` at 44.1 kHz the full desk ceiling was reached
deliberately: **317.61 MiB decoded**, heap 318.3 MB, accepted, played, unloaded
and disposed without error. That number is a bound check of the total budget,
not a claim that eight full-length lanes are comfortable in a real-time context.

Reclamation is lazy in the browser: the heap did not visibly fall after
`unload()` even with a forced GC. That is a browser-level observation, not a
desk reference leak — the desk clears `_groups`, `_lanes` and `_decodedBytes`
(unit-tested), and three consecutive load/unload cycles held flat at
**52.3 MB** (`cycle-probe.json`), so there is no per-cycle growth. Mobile was
not profiled; the per-track 160 MiB and per-stem 40 MiB ceilings bound each
track independently of the total.

## 12. Negative control: the wrap defect and its repair

`wrap_negative_control.mjs` renders one 1.2 s lane beside one 0.4 s lane and
measures the short lane's energy after its own end.

| Runtime / call | Short-lane tail RMS | Status after longest lane |
| --- | --- | --- |
| pre-change runtime, `loop:true` (what the old panel asked for) | **0.244** | **`playing`** |
| this change, two-track `loop:false` | **3.96 × 10⁻¹⁷** | **`ready`** |

That is the defect the two-track desk removes: a short stem used to wrap under
a longer one while the transport still claimed to be playing.

## 13. Demonstration

Two original arrangements, separated with the real engine:

| | Track A | Track B |
| --- | --- | --- |
| fixture | 100 BPM, A minor, 8 bars | **120 BPM, G minor, 8 bars** |
| duration | 19.20 s | 16.00 s |
| stem set | `2022192fb2384b3c91e42282d74a6f95` | `847423aefc3b4ba993a4dbfb16e4eeef` |
| stem RMS (vocals/drums/bass/other) | −29.6 / −23.5 / −23.9 / −29.1 dBFS | −31.3 / −22.3 / −22.7 / −28.0 dBFS |
| four-stem reconstruction residual | −29.3 dB rel mix | −27.7 dB rel mix |

Both sets contain meaningful content in all four lanes and neither clips. The
tempos differ on purpose: this slice does not beat-match, so the demonstration
must not imply that it does.

Run the desk against that temporary library:

```bash
cd /tmp/opencode/octopussy-desk
PYTHONPATH=$PWD/src /home/richardn/2become1/.venv/bin/twobecomeone web \
  --port 8767 --data-dir /tmp/opencode/octopussy-demo
```

Then: pick Track A in group A → **Load A**; pick Track B in group B →
**Load B**; press **Play**. Use each group's level slider, the eight M/S/gain
rows and the A/B crossfader. Playback is one-shot and ends with the longer
track.

## 14. Full verification run (final HEAD)

```bash
npm test                     # 524 tests, 524 pass, 0 fail
.venv/bin/pytest -q          # 580 passed, 1 skipped
node tests/browser/run.js --viewport 1280x800   # 39 checks, 0 failures
node tests/browser/run.js --viewport 390x844    # 39 checks, 5 failures
node tests/browser/stem_desk_ux.js --viewport 1280x800     # pass
node tests/browser/stem_desk_two_track_ux.js --viewport 1280x800  # 21/21
node tests/browser/stem_desk_two_track_ux.js --viewport 390x844   # 21/21
node tests/browser/stem_desk_two_track_audio.js            # 8/8
node tests/browser/stem_desk_two_track_real.js ...         # 8/8
node tests/browser/stem_desk_audio.js                      # 8/8 (single-desk regression)
node tests/browser/stem_desk_real_audio.js ...             # 15/15 (single-desk regression)
```

The five mobile failures are the same pre-existing moderate accessibility
findings recorded at the accepted baseline; they are not new and are kept
separate from this change.

## 15. Defects found by the second challenge and their fixes

The Codex GPT-6.2 Sol challenge ran against HEAD `2a24c20` and returned
NEEDS CHANGES with two blocking findings. Both were reproduced, then fixed:

| Finding | Reproduction | Fix and proof |
| --- | --- | --- |
| Both track levels at +6 dB push the documented demo peak (−3.14 dBFS) past full scale; nothing protects the master | arithmetic on the measured real-stem peak | output soft-clip ceiling (§2); `hot_boosted` renders loud lanes with **+6 dB on every lane and +6 dB on both track levels** and asserts peak ≤ 1.0 and > 0.5 — measured **1.000** with the ceiling, **16.795** without it in the same coherent worst-case render |
| Play pressed while a group is still loading leaves the old sources running behind a rebuilt graph | in-memory reproduction: old source not stopped, lane disconnected, status still `playing` at 0.0 s after the load | the commit path re-reads the transport and stops sources; the unit test uses the failing order (load B pending → Play → B completes) and asserts every prior source is stopped and status is `ready` |

The second fix has its own negative control against the pre-fix runtime
(`/tmp/opencode/octopussy-evidence/transport-control/`):

| Runtime | Status after the load | Live sources | Old source still running |
| --- | --- | --- | --- |
| pre-fix `2a24c20` | `playing` | 1 | **yes** |
| this HEAD | `ready` | 0 | no |

A stem with more than two channels is now refused with `S_STEM_LAYOUT` rather
than downmixed after the ceiling, where channels could sum past full scale
(the desk serves separated stems, which are mono or stereo).

Three non-blocking observations were also taken:

- the panel now shows the specific refusal (code and byte counts) instead of
  “some stems are unavailable”, and a refused replacement cannot read as a
  success;
- the solo/tempo policy line is visible before Play and includes the honest
  two-track tempo statement;
- the docs now say plainly that a successful load stops playback, instead of
  implying that a group can be swapped into a running mix.

Accepted as-is, with the limitation recorded: gain writes are direct
assignments, so a fast drag can produce small zipper artefacts. The demo is a
static audition, and both PCM gates set controls before rendering.

## 16. Third challenge: concurrent loads

Codex reproduced one further defect on `74d3c42`: the panel allowed both Load
buttons to run at once, and each load committed from the group set it captured
before decoding. Whichever finished last replaced the other, so loading A and B
quickly could silently keep only one track.

Fixed at the commit point rather than only in the UI: a group is merged into
the desk as it exists when its decode finishes, and the lane and byte budgets
are re-checked against that current state. The panel also keeps one load in
flight at a time so the buttons do not invite the race. A unit test starts both
loads before either can commit and asserts that both groups survive.

The broader frontend suite (`npm test`) is 524/524 on this HEAD. The reviewer
saw `mashup-session.test.js` and `url-queue-panel.test.js` fail in its own run;
both pass in isolation and in the full suite here, and neither touches the Stem
Desk.

## 17. Fourth pass: the remaining overlap and mid-load edges

Three more edge cases were reproduced and closed at the source:

| Edge | Fix | Proof |
| --- | --- | --- |
| A third track could be accepted when three loads overlapped, because `maxTracks` was only checked at entry | the commit-time merge re-checks the track limit as well as lanes and bytes, and refuses with `S_DESK_FULL` | unit test “a third track is refused at commit, not just at entry” |
| Two quick Load clicks could both start while the library was still being fetched, because the busy slot was taken after an `await` | the panel reserves the single load slot before any `await` and ignores a second click | panel test “two quick Load clicks start only one load, even before the library resolves” |
| Play during a multi-group load could connect a source to a lane whose gain node did not exist yet, leaving a `playing` desk that had thrown | `play()` rebuilds the graph first when any lane lacks a node | unit test “play during a multi-group load builds the graph instead of throwing” |

A throwing announcement listener could also leave both Load buttons disabled;
the announcement now runs inside the same `try` as the load.

## 18. Fifth pass: the two proofs and the lockout

Two more findings were reproduced and fixed.

**A reserved load slot could lock both buttons.** The handler reserved the
single slot and then returned early when no track was chosen (or the library was
empty or its request failed), before reaching the `finally` that releases the
slot. Everything after the reservation now lives inside one `try/finally`, with
a regression test for the empty-library and failed-request cases.

**The play-during-load proof was not deterministic.** It waited a single
microtask and used a fake source that accepted a null destination, so it passed
on the broken revision. It now waits for the actual missing-node window
(a second group still fetching while the first has been published), asserts
every lane has a gain node, and asserts every scheduled source connected to one.
A control against the previous runtime records the defect directly:

| Runtime | In the window | Sources connected to null |
| --- | --- | --- |
| previous `3cce7b2` | yes | **1** |
| this HEAD | yes | 0 |

The control is in `/tmp/opencode/octopussy-evidence/play-control/`.

The ceiling's own control is in `/tmp/opencode/octopussy-evidence/ceiling-control/`:
the same hot render (eight 0.9-amplitude lanes, +6 dB lane, +6 dB track, both
groups open) peaks at **16.795 before the ceiling** and **1.000 after it**.

## 19. Sixth pass: disposal, announcements and the asset trigger

Four findings, all fixed at the source:

| Finding | Fix |
| --- | --- |
| A panel disposed during a library lookup still announced and started a stem request afterwards | a post-await disposal check; the runtime also refuses to commit a decode that finishes after `dispose()` and leaves the desk `idle` with no lanes |
| A throwing announcement listener escaped the handler as an unhandled rejection | `say()` catches the listener; the load path and the buttons are unaffected |
| A load during playback announced “The stem desk reached the end”, because the load stops the transport by design | the end message is suppressed while a load is in flight |
| The asset investigation record was stale and did not mention the crossed byte trigger | §“Static asset report” now records the measured 708,866 bytes / +57,961 (+8.90%) and what grew |

Tests were added for the disposal race and the throwing listener.
