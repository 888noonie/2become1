# Record Crate · Two Become One

The review candidate lives on `integration/record-crate-stage1`. Merge
`fa78074673630e73dd0b87f0c318cd86169fc0f5` has Claude's
`c6bdafabbcc874ca1c32538094a677762c5cefa9` and OpenCode's
`a0373bd9193a975c356e49659633eb1461fc0832` as its original parents.
Claude's parent is First Mix `a9c6dc0`. OpenCode's parent and the common
ancestor are `main` at `06bdae9`. Both source checkouts had clean tracked
files and existing untracked dependency symlinks. Main's tracked tree was
clean and its existing untracked files were left in place.

## Contract

The Crate reads the bounded `GET /api/crate` projection. The adapter consumes
`source.kind`, `stems.status`, `stems.quad` and validated roles. It never
constructs readiness from a job or a role count. Exact-content matches,
same-source matches and possible versions have separate labels. The Crate
permits only the catalogue's Choose and Separate actions. Load also requires
the desk's current bank selection. Projected job status carries no percentage.
Progress can arrive through the existing job watch. The local selected and
loaded badges come from the mounted desk. The interim 404 fallback has been
removed. [Contract and replay instructions](record-crate.md)

The real browser run used a copied Library with two Demucs tracks, a partial
set with two validated roles and an unseparated track. The browser observed
HTTP 200 catalogue and search responses whose IDs matched existing Library
records. Search did not fan out into per-track stem reads. On desktop and
mobile, Choose updated the selector with no audio fetch or new AudioContext.
Explicit Load used one context for all eight lanes. Loading B first still
placed A to its left or above it. The desktop overlay and mobile sheet returned
focus when closed. The local Producer audition and kept Undo survived tab
changes. The real separation action posted one Demucs request and the
validated quad appeared after that job completed.

The server used a disposable library on loopback port 8767. Its verification
wrapper refused outbound Python socket connections and DNS, enabled offline
model caches and removed cloud credentials. The browser refused external
origins and Producer model routes. Neither guard recorded an attempt. The
Demucs job used the existing local weights. The owner Library and the existing
server on 8766 were excluded from the write path.

The desktop desk was available in 220 ms and displayed initial Crate results
in 81 ms after opening. The 390 px observations were 167 ms and 103 ms.
These are single local observations.

## Evidence

| Check | Result |
| --- | --- |
| Adapter negative controls | Both requested assertions fail against the original adapter with exit 1. The old adapter fails to show the authoritative quad as ready and promotes the partial fixture when it sees the obsolete readiness field. |
| Focused frontend | 88 passed, exit 0. |
| Full frontend | 1,066 passed, one skipped, exit 0. The optional saved bounce WAV is absent. |
| Real Studio Crate | 11/11, exit 0. The real Demucs separation returned 202, completed as job `3bf6288182614272b511b72d83cff1ff`, and then produced a validated catalogue quad. |
| Non-live Python | 695 passed, 7 skipped, exit 0. The additional 10 tests are OpenCode's catalogue suite. The skips are the existing live model, optional speech and BPM conditions. |
| Crate browser UX | 37/37. Tested the docked view, expanded overlay and mobile sheet, keyboard focus and trap, 44 px controls, reduced motion, accessibility audit and absence of external page requests. |
| Two-bank browser | 42/42 at 1280×800 and 41/41 at 390×844, including repeated Unload and reload. |
| Real Demucs PCM | Stop 10/10 and survivor replay 12/12. Stop produced digital silence. Unload retained A's four decoded buffers and settings and released B's bytes. |
| Full Studio browser | 39/39 each at 1280×800 and 390×844. Both accessibility audits found zero issues. |
| Other Studio browser gates | Single Desk 5/5, Stem Crate 13/13, three-bus 7/7. |
| Standard offline capture | 8/8. |
| 60-second offline PCM and memory | 20/20. Removing one bank reduced decoded allocation from 184,320,000 to 92,160,000 bytes. Reload restored eight lanes and invalid and oversized sections were refused. |

The historical 200% mobile CSS zoom issue reproduced at 493 px on a 390 px
viewport on both First Mix and this candidate. Both measured 390 px at
normal scale. Record the zoom issue separately as shell reflow and
surface-switch wrapping. The Crate sheet passed at normal 390 px. The earlier
Python runner interruption and three-bus timeout are historical. Both exited
successfully in this run.

## Static assets

The effective repository policy uses 15% or 50,000 bytes as investigation
triggers. Setting `STATIC_GROWTH_ENFORCE=1` opts into enforcement against the
checked-in baseline, and the default candidate checks do not set it.
The candidate measures **1,504,870 bytes across 100 files**, up **47,633 bytes
(+3.27%)** from First Mix's 1,457,237 bytes across 97 files. It is **3,737 bytes
smaller** than Claude's original frontend after removing the interim fallback
and adding the authoritative mapping. The checked-in historical baseline,
650,905 bytes across 67 files at `763e1d9`, yields a reporting trigger of
+853,965 bytes (+131.20%). The difference between that historical total and
First Mix is inherited. The thresholds and baseline remain as recorded.

| Largest file | Bytes |
| --- | ---: |
| `vendor/signalsmith-stretch/SignalsmithStretch.mjs` | 113,867 |
| `js/components/arrangement-producer.js` | 92,021 |
| `js/components/arrangement-panel.js` | 85,657 |
| `js/components/stem-desk-panel.js` | 80,586 |
| `js/realtime-engine.js` | 69,356 |

## Owner gate

**GO for Crate owner acceptance.**

Independent backend review should confirm the projection's file validation,
pagination bounds and duplicate categories. Independent frontend review should
inspect permissions, keyboard and touch reflow, and that the Producer mix stays
intact when opening the Crate. The owner should then search and load both local
tracks, compare a partial result, switch tabs during an audition and listen
through shared Stop and Unload. Actual screen-reader speech is unverified.
Physical listening and PM approval remain separate acceptance gates.
