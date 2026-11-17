# Static asset policy

**Owner decision, 2026-11-17 (OPERATION OPEN THE VAULT).** The 650,000-byte
hard ceiling and the 600,000-byte soft checkpoint are retired. They are
replaced by measured, evidence-based controls.

The ceiling was a proxy for load cost, and it had already stopped being
honest: the preserved baseline `763e1d9` measured **650,905 bytes**, 905 bytes
over the cap, before any new feature. A number that is breached by the
starting point cannot separate a regression from an accepted cost.

## What replaces the ceiling

Every frontend-bearing change records:

1. **Size and growth.** Total uncompressed bytes under
   `src/twobecomeone/studio_static`, the file count, the five largest files,
   and the delta against the recorded baseline. Growth is reported and
   explained; it is never hidden.
2. **Startup and responsiveness.** The browser suite already boots the real
   Studio against the fixture server. Report the observed time to a usable
   Studio and any meaningful change in the deck, stem-desk, crate or three-bus
   journeys.
3. **Usability at both viewports.** Desktop `1280x800` and mobile `390x844`:
   no horizontal overflow, 44 px targets retained, keyboard journeys intact.
4. **The existing gates stay.** `npm test`, `pytest -q`,
   `node tests/browser/run.js` for both viewports, `stem_desk_ux.js`,
   `stem_crate_ux.js`, `three_bus_ux.js`, and the OfflineAudioContext PCM
   capture (`stem_desk_audio.js`) remain required where the change touches
   playback or UI.

A byte count is evidence, not a gate. **Never minify, compress readability, or
delete a useful behaviour to satisfy a historical byte ceiling.** If growth is
real and the journeys still hold, record it and carry on. If growth is real and
a journey degrades, fix the cause.

## Measurement procedure

```bash
# total, file count, and the largest files
find src/twobecomeone/studio_static -type f -printf '%s %p\n' \
  | sort -rn | awk '{ s += $1 } END { printf "total=%d files=%d\n", s, NR }'
find src/twobecomeone/studio_static -type f -printf '%s %p\n' | sort -rn | head -5
```

Compare the total against the table below and quote the delta in the change
report.

## Recorded history

| Date | Commit | Uncompressed bytes | Note |
| --- | --- | --- | --- |
| 2026-11-17 | `763e1d9` | 650,905 | preserved baseline; 905 B over the retired cap |
| 2026-11-17 | `c88d64e` (`feature/stem-desk`) | 678,582 | +27,677 B (+4.25%) for the four-lane Stem Performance Desk |

The Stem Desk is eligible for reconsideration under this policy: its growth is
measured, explained, and covered by the desktop and mobile journeys.

## Historical documents

The phase plans and handover notes that cite the 500,000 / 600,000 / 650,000
byte figures are historical records of what those slices were measured
against. Their text is left intact; this document is the current policy.
