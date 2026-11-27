# First Mix · The Last Two Notes

**Recommendation · GO for owner listening.**

The isolated candidate is on `integration/first-mix-soundcheck`. The
integration merge `7667ebc` has `034fa65` and OpenCode's `7189194` as
parents. OpenCode's fixture and the existing Stop fixture generate the same
eight bars of the same two songs, with identical WAV roles and manifest fields.
Both harnesses now call the existing generator. The survivor harness keeps
the original settings, buffer identity, byte accounting and replay assertions.
Main remains at `06bdae9`.

## Changes

- `stem-desk-panel.js` keeps a focus claim for the pending keyboard Load.
  The claim ends when focus moves, a pointer interaction begins, the window
  loses focus or the load is cancelled. Success and failure return focus to
  Load when the request still owns the claim. Cancellation leaves the focus
  handoff to Unload, which sends it to the track picker while Load is busy.
- `stem-desk-panel.js` inserts a newly loaded A before B in DOM order while
  leaving the survivor mounted. `stem-desk.css` keeps a lone B in the right
  desktop column. A phone stacks two banks and shows a single bank in the
  first row. The crossfader keeps its position and disables with one bank.
- The source controls show and expose the accessible description “Unloading
  during playback stops both banks. The other bank stays loaded.”
- `stem_desk_two_track_ux.js` uses Enter and Tab to exercise reload, failed
  loads, cancelled loads and user-directed focus. It checks rendered positions,
  source alignment and both bank reload orders.
- `stem_desk_unload_other_bank.js` adds the independent survivor PCM test.
  It covers both a soloed vocal and a muted drum with bass gain changed.

## Evidence

| Check | Result |
| --- | --- |
| Pre-fix browser control | The original panel failed four desktop assertions. B occupied A's column as the lone bank, A reloaded after B, and focus was lost after both successful and failed keyboard loads. |
| Focused panel, runtime and static checks | 122 passed. |
| Full frontend | 1,048 passed and one skipped because the optional saved bounce WAV was absent. |
| Focus and bank order browser journey | 42/42 at 1280 × 800 and 41/41 at 390 × 844. The crossfader's document position and width were identical before and after unloading A. |
| Python | The full test summary reported 685 passed and seven skipped with the live Producer daemon excluded, then the runner returned 143 after the summary. The targeted stem import, track and section suite exited successfully with 37 passed. |
| Full Studio browser and accessibility | 39/39 at 1280 × 800 and 39/39 at 390 × 844, zero automated audit findings or horizontal overflow. |
| Single desk, Stem Crate and three-bus | 5/5, 13/13 and 7/7 respectively. |
| Black Tie layout | 41 observations across five loaded viewports. The separate 200% mobile stress flagged overflow. A controlled replay measured 493 px of document width at a 390 px viewport on both `034fa65` and the candidate, with the same result after hiding the hint. |
| Real Demucs browser replay | Unload A by keyboard and B by touch each stopped all eight voices and released only the selected bank. Decoded bytes fell from 57,139,200 to 27,648,000 or 29,491,200 respectively. The survivor's settings and Library records held. Two delayed real decodes remained retired and the Producer's audition and Undo ended as expected. |
| Standard offline capture | 8/8 signal-level checks. |
| Stop PCM | 10/10 on generated music and 10/10 on two Demucs sets. Post-Stop silence includes the first render quantum. |
| Stop negative control | A scratch no-op Stop failed the silence assertion with peak 0.46328 and 246,584 nonzero channel samples after Stop, 9/10 overall. |
| Survivor PCM | 12/12 on generated music and 12/12 on Demucs. The Demucs run released 25,401,600 decoded bytes and retained A's four original buffers and 27,095,040 bytes. A-only replay matched the reference over 229,388 channel samples per scenario. Maximum difference was zero on Demucs and 1.20 × 10⁻⁷ on generated music. |
| Survivor negative control | Resetting A's track level to 0 dB when unloading B made both settings and replay assertions fail, 8/12 overall. The maximum PCM difference was 0.12877. |

The negative controls ran in scratch copies. Both PCM harnesses use the real
runtime and offline Chromium. The focused keyboard journey uses fixture
responses and a real browser. Physical audio and actual screen-reader speech
remain for owner verification. The existing global load status and separate
Producer announcement behavior remain as recorded at the soundcheck. The hint
explains the shared stop before it happens.

## Static assets

The static tree contains **1,457,237 bytes across 97 files**. Focus handling,
bank insertion and placement, and the accessible hint add 1,859 bytes
(+0.13%) to `034fa65`. The total is 3,480 bytes above `06bdae9`.
On the isolated Demucs library, the panel became usable in 152–185 ms
and both banks loaded in 1.73–1.81 s across the sampled viewports.
The historical policy baseline at `763e1d9` is 650,905 bytes across 67 files,
so the reporting trigger records +806,332 bytes (+123.88%). The current change
accounts for 1,859 bytes of that historical growth.

| Largest static files | Bytes |
| --- | ---: |
| `vendor/signalsmith-stretch/SignalsmithStretch.mjs` | 113,867 |
| `js/components/arrangement-producer.js` | 92,021 |
| `js/components/arrangement-panel.js` | 85,657 |
| `js/components/stem-desk-panel.js` | 69,424 |
| `js/realtime-engine.js` | 69,356 |

## Replay

```sh
node tests/browser/stem_desk_two_track_ux.js --viewport 1280x800 --out /path/to/scratch
node tests/browser/stem_desk_two_track_ux.js --viewport 390x844 --out /path/to/scratch
node tests/browser/stem_desk_stop_regression.js --out /path/to/scratch
node tests/browser/stem_desk_unload_other_bank.js --out /path/to/scratch
```

Pass `--stemsA` and `--stemsB` to either PCM harness to use two existing
four-stem directories.

The [Act III-A soundcheck](first-mix-soundcheck.md) records prior evidence
and the isolated owner replay procedure.
