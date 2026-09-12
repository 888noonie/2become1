# 2become1 — remaining 14/15 groundwork

Richard Noon, 2026-09-12. Bots: read this before starting a slice.
Richard is out; he will merge `main` himself after a return audit.
**Nobody merges to `main`. Nobody tags. Nobody force-pushes.**

## Already on `origin/main`

- `faea508` — Phase 14B.1 stem-crate API (`stem_crate_items`, `/api/stem-crate`).
- `2a4ccce` — Phase 15A LiveMixer **wired**: decks A and B can play together.
  Footer/library preview stays the `audioController` singleton.
- Static budget through Phases 14–16: soft **600,000** / hard **650,000**
  uncompressed HTML/CSS/JS. Report the total on every frontend-bearing change.
  Do not delete behaviour, squeeze comments, or minify to hit the number.

## Still not true (do not claim)

- Live equal-power **crossfader** (15B).
- Honest crate **loop math** and production crate **UI** (14B.2 / 14B.3).
- One **stem-stack** layer in the mix (14C + 15C).
- Class C loopback / acceptance tolerances (Phase 13). Receipts ≠ speakers.
- Producer / 16A.

ffmpeg center/sides stay center/sides. Never relabel as vocals/instrumental.

## Roster

| Bot | Job | Must not |
|---|---|---|
| **Hermes** | Implement **one** named slice on `bot/hermes/<slice>` from current `origin/main` | Merge, tag, start the next slice before Zeus PASS + Gate packet on the current one |
| **Zeus** | Independent re-audit of a **commit range**. Cite file:line | Edit product code, tell Hermes “closed” without a range |
| **Gate** | Isolated Studio demo: `127.0.0.1:8765`, `--data-dir /tmp/2become1-gate-<slice>` | Touch `~/.local/share/2become1`, bind `0.0.0.0`, merge |
| **Wax** | Listener-truth for **audible** slices (15B, 14C, 15C). Class A + Class B. Class C: measure if you can; never invent PASS | DSP/clock rewrite; treat GhostScheduler receipts as speaker output |

Message each other in this group. `@` the owner of the next step. Do not
invent a fifth Bot.

## One live slice at a time (strict order)

1. **15B** — beat sync + live crossfader (`PHASE_15_THREE_BUS_LIVE_MIXER_TRI_PHASE_PLAN.md`). Wax on.
2. **14B.2** — crate loop/compatibility truth (`PHASE_14_STEM_CRATE_TRI_PHASE_PLAN.md`). Wax parked unless something is heard.
3. **14B.3** — production crate UI in FUN. Placement into a stack stays disabled with honest copy.
4. **14C** — `preview_stem_stack` / `commit_stem_stack`, one prepared composite, one committed layer. Do **not** wire the stack into the singleton player.
5. **15C** — A + B + that stack on the LiveMixer.

If time runs out, stop after the last **Zeus-PASS + Gate-demoed** slice. Leave
that Studio process running for Richard.

## Cycle (every slice)

1. Hermes: branch from `origin/main`, TDD, CI-equivalent in `.github/workflows/test.yml`,
   push `bot/hermes/<slice>`, stop with hashes + static byte count.
2. Zeus: re-audit `origin/main..<tip>` read-only. PASS/FAIL. Do not notify Hermes
   of closure until the range exists.
3. Gate: fixture-only demo. Packet with CI URL, static total, library mtime
   proof, and what a human should hear/see.
4. Wax: if the slice can be heard, Class A/B notes in the same packet (or a
   `LISTENING_*` addendum on the branch — not a `main` merge).
5. **Stop.** Richard merges when he is back. Then fetch `origin/main` before
   the next slice.

GitHub login / 2FA: stop and wait. Do not paste secrets in chat.

## Demo machine

CachyOS clone: `/home/richardn/2become1`. Existing `.venv` — do not `uv sync`
if it would disturb Demucs/CUDA. Command shape:

```bash
.venv/bin/twobecomeone web --host 127.0.0.1 --port 8765 --data-dir /tmp/2become1-gate-<slice>
```

Kill any previous Gate PID on 8765 before starting a new data dir. After the
**last** successful demo, **leave it up**.

## Out of scope until Richard is back

Producer, Ollama/OpenRouter, Phase 16, raising the static ceiling, dependency
upgrades, release tags, Class C PASS without a capture, live-warping, multiple
committed layers, MIDI, collab/battle.
