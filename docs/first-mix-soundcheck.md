# First Mix soundcheck

**Recommendation · CONDITIONAL GO for owner listening.** Keep Unload available
during playback. Tell the listener that unloading a loaded bank stops the
shared transport and that reloading that bank restores its default controls.
The announcement and bank-state findings below remain open for UX acceptance.

## Integration

The two candidates have the same single parent, `06bdae9`. Local and remote
`main` both pointed to that parent when checked. Both candidate source trees
had clean indexes and tracked files. The OpenCode worktree had untracked
dependency symlinks. The main checkout had its existing untracked files,
including the listener-runtime tests discussed below.

`integration/first-mix-soundcheck` merges `7bdc78d` and
`2b65f1f78508cd829cea05161fc9575fcb4e5d98` in `93a112d`. There were no
overlapping files or merge conflicts. This report is a documentation-only
follow-up. The candidate runtime, CSS and browser harnesses match the two
source commits. The integration and all servers used an isolated worktree and
scratch libraries.

| Source | Files |
| --- | --- |
| Codex | `stem-desk-panel.js`, `console.css`, `stem-desk.css`, `stem-desk-panel.test.js`, `stem_desk_two_track_ux.js`, `stem-desk-engineering-guide.md` |
| OpenCode | `first_mix_stop_fixture.py`, `stem_desk_stop_regression.js`, `stem_desk_real_audio.js` |
| Integration | This evidence report |

## Evidence matrix

| Check | Result |
| --- | --- |
| Full frontend suite | 1,048 passed, one skipped because the saved bounce WAV was absent |
| Python suite | 685 passed, seven skipped with the live Producer daemon intentionally excluded |
| Python discovery against local main | 692 integration node IDs and 723 main node IDs. Every integration ID appears in main. All 31 extras come from a local untracked test module |
| Unload negative controls | Six failures on the original panel. Independently removing the late stem-list guard, decoder signal, or Play invalidation caused its corresponding race test to fail |
| Two-bank browser journey | 31/31 at 1280 × 800 and 30/30 at 390 × 844 |
| Full Studio journeys and accessibility audits | 39/39 at both sizes, zero audit findings |
| Single desk, Stem Crate and three-bus journeys | 5/5 single desk and 13/13 Stem Crate. Three-bus initially timed out waiting for anchor assignment, then passed 7/7 on isolated rerun. A separate checkout of `06bdae9` also passed 7/7 |
| Loaded Black Tie capture | Five loaded viewports from 390 to 1920 px, 41 recorded observations and no overflow flags |
| Real Demucs browser Unload A and B | A by keyboard at 1280 × 800 and B by touch at 390 × 844. Each stopped 8/8 active sources and retained four lanes with the survivor’s settings and stem identity. A released 29,491,200 bytes and B released 27,648,000 bytes. Reload returned to 57,139,200 bytes and eight lanes |
| Real decode cancellation, focus, Producer and Library | Two held real decode completions could not repopulate B across rapid unload/reload attempts. No duplicate load was accepted. Loaded-bank focus returned to Load, and cancellation focus fell back to the source picker while Load was busy. Heard proposals restored the musician’s surviving settings, hand moves survived, and kept Undo expired. Both Library records and stem sets matched before and after |
| Imported musical section and memory checks | 20/20 PCM and memory, 20/20 UI. A 60-second eight-lane load held 184,320,000 bytes, then 92,160,000 after a bank unload. Reload restored all eight lanes. Full-length guard passed. These are decoded buffer counts |
| Other offline PCM | 8/8 synthetic mixer checks, 14/14 entry-offset checks, 15/15 single-bank Demucs, 8/8 two-bank Demucs |
| OpenCode mid-playback Stop | 10/10 on the supplied musical fixture and 10/10 on Demucs stems |
| OpenCode no-op Stop mutation | Expected 9/10 with exit 1 in a scratch copy. The digital-silence assertion failed at peak 0.46293, with 246,584 nonzero samples and the transport still playing |

The Python counts differ because both runs use pytest discovery under
`tests/`, and the main checkout has an additional untracked test module.
Neither candidate changes pytest settings or adds a collected Python test. The
OpenCode Python file generates musical fixtures for the browser harness. The
31 extra cases account for the previous 716-versus-685 pass totals under the
same live-model exclusion.

OpenCode’s regression suspends the real offline clock at frame 44,160.
Post-Stop peak and nonzero samples were both zero. The first render
quantum after Stop also had zero peak in both successful runs. The matched control without
Stop was −18.80 dBFS RMS on the supplied fixture and −20.71 dBFS RMS on Demucs
stems. The pre-Stop and replay comparisons stayed within 1.20 × 10⁻⁷ absolute
sample difference against a 10⁻⁶ tolerance. Stop retained all eight buffers,
including 52,496,640 decoded bytes in the Demucs run.

## Claude’s UX review

Claude’s *Black Tie, Second Fitting* identified eleven essentials. The
candidate meets bank preservation, scoped cancellation, Producer teardown,
neutral unload copy, touch targets, static reporting and the Studio audits.
The PM’s playback decision supersedes the proposed disabled state. Keyboard
focus goes to Load after a normal unload and to the picker while a cancelled
request is settling. Both controls measured about 107 × 44 CSS pixels at
1280, 768 and 390 px, with a visible 3 px focus outline.

Two essential feedback gaps remain.

- A normal unload updates the main `role=status` once with
  “Unloaded stems from group B. Playback stopped.” It gives no advance
  explanation of the shared stop or subsequent reset. Unloading during Hear it
  or with Undo available updates both the main and Producer live regions.
  Chromium exposed the status in the accessibility tree. The two DOM updates
  are observable, while actual screen-reader speech and its ordering remain
  untested.
- Load is disabled while a request owns the slot and a global status reports
  loading. The bank has neither a local Empty, Loading or Loaded label nor an
  `aria-busy` state. After cancellation the button still says “Load B” while
  disabled through decode retirement. In the loaded mobile sample, the
  status line began 1,534 px below bank B’s source card.

The smallest follow-up is a short bank-local state and an explanation near
the buttons that Unload stops both banks during playback. On completion, make
one live-region update that names the bank and track, confirms the survivor,
and explains that reload restores defaults. Keep the current playback
availability. These gaps block full UX acceptance. They do not block a guided
listening session with the current controls explained up front.

Placing the neutral action on the bank title row for more separation from
Load, relabelling Load as Reload, promoting Stop, adding audible indicators,
and making transport sticky are design options after listening. The candidate
keeps Unload on the source card and disabled on an idle empty bank.

## Static assets

The total is **1,455,378 uncompressed bytes across 97 files**. The increment
from `06bdae9` is **1,621 bytes**, or **0.11%**, for the unload controls,
cancellation handling and compact layout. The merge adds zero static bytes
over the Codex candidate. The configured historical measurement at `763e1d9`
is 650,905 bytes across 67 files. Its +804,473-byte, +123.59% comparison still
triggers an investigation record under the existing reporting policy.

| Largest static files | Bytes |
| --- | ---: |
| `vendor/signalsmith-stretch/SignalsmithStretch.mjs` | 113,867 |
| `js/components/arrangement-producer.js` | 92,021 |
| `js/components/arrangement-panel.js` | 85,657 |
| `js/realtime-engine.js` | 69,356 |
| `js/components/stem-desk-panel.js` | 67,678 |

On the isolated Demucs library, the Performance Desk was available in 140–206 ms and both banks loaded in 1.67–1.87 s at the three sampled viewports. These are observations from one local run. The deck and Stem Crate journeys passed. See the evidence matrix for the three-bus retry.

## Owner replay

Use a separate loopback server and an isolated library with two complete sets.
Load both banks, give the bank you will keep a distinctive level and nudge,
and start Play. Unload the other bank while it is audible. Listen for the
shared stop, then play the survivor on purpose. Reload the cleared bank and
repeat with the other bank. Exercise one audition and one kept proposal with
Undo available before unloading. The automated runs used muted Chromium.
Headphone or speaker listening and assistive-technology speech remain open.

The
[engineer’s guide](stem-desk-engineering-guide.md) documents how to repeat the
committed unload checks. Run
`node tests/browser/stem_desk_stop_regression.js --out <scratch>` for the
self-contained Stop regression. Pass `--stemsA` and `--stemsB` for the same
check against two Demucs stem directories.
