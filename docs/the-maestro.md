# OPERATION THE MAESTRO — the autonomous Producer, challenged and refined

Date: 2026-11-22. Branch `claude/the-maestro`, cut from `daw/perfect-harmony`
at `24e2850`. Nothing was pushed or merged. Every existing branch and worktree
is untouched.

Both roles in the brief were run in one Claude Opus 5.5 session. No separate
Sonnet agent was used. The interaction changes and the integration repairs are
in one commit because they touch the same functions. The commit message says
which part is which.

## What changed

| Commit | What |
| --- | --- |
| `4dc35f7` | Model status reports the last real call (a crash is no longer shown as "available"). The creative-move prompt describes each move. |
| `6ad3060` | Three Producer defects repaired, plus the interaction refinements below. |
| this commit | Real-Chromium Maestro journey, this report, AGENTS.md contract lines. |

### Defects found and repaired

Each one is reproduced by a test that fails on `24e2850`.

1. **Kept clips were doubled.** After **Keep it**, the next **Take the decks**
   placed an identical B vocal and B drums clip on top of the kept ones, so 17.6
   beats played twice, and nothing was said
   (`a kept vocal is not doubled by the next take…`). A new part now starts
   where a Producer clip the musician kept ends on that lane
   (`clearOfKept`, `producer-intent.js`). The kept clip is never moved or
   shortened. The reply and the card name what was kept.
2. **Kept vocals were silenced.** A later entrance wrote a new lane curve. The
   curve holds its first point (−60 dB) before it starts, so the kept vocal
   earlier on the lane played at lane gain 0.001
   (`a later entrance does not silence the vocal the musician kept`). A lane
   holding a kept clip now keeps its own curve, and the entrance becomes the
   new clip's fade-in.
3. **The transition claim was false.** "Find a more interesting transition"
   replied that the handoff fade was eight bars, but `commitArrangement` capped
   every part's fade at one bar. The longer fade is now applied, capped at half
   the passage, and the reply states the length actually applied.

### The musician's controls (Black Tie card, no new panel)

- **Status line** (`.daw__producer-now`, `data-state`). Possible states:
  *You're playing* · *Jamming, waiting for your direction* · *An idea is
  waiting* / *Hearing my idea* · *Creating…* · *Playing my take: …* ·
  *Finished: …* · *The decks are yours*.
- **Direction row.** Shown only while the Producer holds the decks: **Try
  another · More energy · Previous vocal · Take over**. These buttons go through
  the same path as typing. Previous vocal is disabled until a different earlier
  vocal exists. All but Take over are disabled at the four-revision cap, and the
  status line says why.
- **Stopping vs restoring:**
  - **Take over** stops the Producer and keeps the take.
  - **Restore previous arrangement** appears after that, and only until the
    musician edits anything.
  - **Take back** stops the Producer and restores, unless the musician has
    edited since.
- **Kept clips** are listed on the card ("Kept from earlier: B Vocals at bar 1
  beat 4.17 …") and in every later take's reply.
- **Loose words** while the Producer holds the decks, read without a model:
  - *bigger*, *crank it up*, *punch* → more energy
  - *calm*, *let it breathe*, *less energy* → gentler entrance
  - *another version*, *rework*, *not feeling it* → different structure
  - *the old singer*, *first vocal* → previous vocal
  - *weird*, *blow my mind* → surprise
  - *my turn*, *I've got it* → take over

  The reply says which word it read and that no model was used. Anything else
  still goes to the local model when one answers.

## The Producer, challenged

**Does it create meaningful differences or select templates?** It selects
templates. `arrangementPlans` has four fixed structures:

- *A keeps the drums and bass, B sings*
- *Instruments lead, then B sings*
- *The drums drop out, then return*
- *B's drums take the bed*

They are filled from the chorus position and the top two rows of the harmonic
ranker. The differences between them are real edits:

- where the vocal enters
- which drum lane carries the bed
- where the handoff falls
- how long the fades are

But no new musical material is made, and no candidate is heard before it is
chosen. With only two sections in song B (the synthetic demo), **Try another**
reused the same B passage and changed only its timing.

**Can the musician choose a direction without exact phrases?** Now partly:

- The buttons need no words.
- A keyword map covers common loose wording and says it used no model.
- Free sentences go to the local model, which currently fails on this machine
  (see below).
- Anything outside these routes gets a plain answer listing the moves the
  Producer can make.

**Does the earlier kept vocal belong in the new arrangement?** Before this
work it caused unintended layering (defect 1) or was silently muted
(defect 2). It now stays exactly where the musician kept it, audible on its
own curve, and new parts are placed around it. One honest limitation: the
Producer does not ask whether the kept clip *should* stay. It treats Keep as
permanent until the musician moves or deletes the clip.

**Are the vocal and drum handoffs coherent?** They are coherent in timing:

- B's drums start where B's vocal ends (`afterVocal`).
- A's drums are trimmed to that same beat.

They are not a crossfade. From the source:

- A's drums fade out over their last 2 beats before the handoff
  (`fadeOut: duration >= 4 ? 2 : 0`).
- B's drums fade in over the next 4 beats.

So both drum lanes are near zero at the handoff beat: a short drum dropout. It
can read as a break, but nobody chose it as one, and it has not been listened to.

**Are transitions editable after the AI completes them?** Yes:

- Every Producer clip is an ordinary clip (`idea-N`), editable with the same
  edit commands.
- Its entrance and bed dip are lane gain points, editable with Draw levels.
- A hand edit turns the field into the musician's ("yours now").
- The Chromium journeys move a Producer clip and re-level a track after a
  take. Both edits survive Take back, and the re-level survives save/reopen.

**Does Take back consistently return control without discarding musician
edits?** Yes, in every case tested (unit tests and Chromium):

- After any hand edit, Take back stops the Producer, says it will not take the
  edit away, and leaves the lanes alone.
- Restore is offered only while the lanes are exactly as the take left them.

**Does the export match what is displayed and played?** In the Chromium
journey, the exported WAV was measured against a live capture of the same
arrangement. The capture comes from the session's monitor bus through the
repo's `pcm-capture` worklet, divided by the −12 dB monitor gain.

| Measure | Result |
| --- | --- |
| Export length | 42.95 s, against 42.45 s of clips on the lanes (+0.5 s release tail) |
| 50 ms envelope correlation, live vs export | 0.962, at 115 ms start lag |
| Level difference, median | −0.14 dB |
| Level difference, 5–95% | −2.23 … +0.80 dB |
| Export peak | −0.30 dBFS, 0 samples ≥ 0.999 |
| Unintended silence | 0 runs of 250 ms below −60 dBFS |
| Same-lane overlaps after reopen | 0 |
| Beats where both songs' vocals sound | 0 |

The live and offline paths are not sample-identical. The envelope agrees and
the median level agrees within 0.14 dB.

## Local model runtime — measured, not assumed

**Cause of the crashes.** The loaded and installed NVIDIA kernel module is
**620.70.06**, but the user-space driver is **620.73.04**:

- `nvidia-utils` was upgraded on 2026-11-21 at 17:33.
- `linux-cachyos-nvidia-open 7.3.4-1` still ships the 620.70.06 module.
- `nvidia-smi` reports "Failed to initialize NVML: Driver/library version
  mismatch".
- From 18:33 that day, every `llama-server --list-devices` and every model load
  in `ollama-artifactforge.service` ends in `signal: segmentation fault`. That
  includes qwen2.5:3b-instruct (installed), qwen2.5:1.5b-instruct and tev1:0.8b.

**A reboot will not fix it,** because the module on disk is also 620.70.06.
The real fix is a package operation, which is out of scope here. Two routes:

- a module package built for 620.73, or
- the cached `nvidia-utils 620.70.06`.

Nothing was installed, downgraded or rebooted.

**A safe working alternative exists:** a CPU-only Ollama on a second loopback
port. It uses the same model store with pruning off, and it does not touch
CUDA or the main service:

```bash
CUDA_VISIBLE_DEVICES=-1 OLLAMA_LLM_LIBRARY=cpu OLLAMA_NOPRUNE=1 \
  OLLAMA_MODELS=$HOME/Models OLLAMA_HOST=127.0.0.1:11435 ollama serve
TWOBECOMEONE_PRODUCER_URL=http://127.0.0.1:11435 .venv/bin/twobecomeone web
```

Measured on that runner (no segfaults):

| Model | Creative move, 20 phrases, old → new prompt | Time per call | Repo live tests |
| --- | --- | --- | --- |
| qwen2.5:3b-instruct | 10/20 → **18/20** | 0.6 s | Varied phrasings 0.72 (bar 0.75); brief conversation fails |
| qwen2.5:1.5b-instruct | 3/20 → 14/20 | 0.3 s | Varied phrasings 0.61; misreads "undo that idea" and "keep it" as `hear_idea` |
| tev1:0.8b | — | 7–50 s | Non-JSON answers, then the runner dropped |

So real local language interpretation can run on this machine today, but only
on CPU, and below the repo's own conversation quality bar. The Studio is not
pointed at it by default. In the Maestro journey, every direction was handled
by buttons or by the keyword map, and the page says so. The model card now says
"installed … has not answered yet" until a call succeeds, and names the
daemon's error after a failure.

## Evidence

- `node --test tests/frontend/*.js`: 343/343 pass. That includes 7 new tests;
  the two layering tests and the transition test fail on `24e2850`.
- `pytest -q`: 680 pass, 6 skipped. Only the two live-model tests fail, and only
  because `:11434` segfaults; they were also run against the CPU runner, with
  the results in the table above.
- `node tests/browser/maestro_journey.js`: 31/31 in real Chromium, against a
  temporary Studio and data directory:
  - a full take
  - Keep, then Try another
  - More energy and loose words
  - a real interrupt during *creating* (lanes byte-identical afterwards)
  - a hand edit kept through Take back
  - save, reload and reopen (same clips, timing, gains and passages)
  - export, then live capture vs export
  - the card at 390×844

  Set `MAESTRO_EVIDENCE=<dir>` to write `maestro-evidence.json` and card
  screenshots.
- `node tests/browser/chorus_fit_journey.js`: 26/26.
- Not run: `listening_room_daw.js`. It needs a seeded Studio with the owner's
  library songs and a working model.

The songs in these runs are synthetic: every stem of a song is the same
tone-and-click mix. They prove timing, clip identity, levels and handoffs. They
say nothing about taste. **No AI listened to any audio.** The PM's listening
acceptance is still open.

## PM audition (about 5 minutes, real songs)

1. Bring two separated songs onto the lanes. Press **Take the decks**. The
   status line reads *Creating…*, then *Playing my take*. Listen through the
   handoff where B's drums come in, and judge whether that drum dropout works.
2. Press **Keep it**, then **Try another**. Check that the kept vocal is still
   heard, that the new vocal follows it rather than sitting on top, and that the
   card lists what was kept.
3. Press **More energy**, then type *let it breathe*. You should hear a sooner
   vocal, then a softer entrance.
4. Press **Try another** and **Take over** straight away. Nothing new should land.
5. Move one fader. **Restore previous arrangement** disappears, and **Take
   back** leaves your fader alone.
6. Save, reopen and **Export WAV**. The file should sound like what you just
   heard.

## Next engineering bottleneck (for Grok and Codex)

**The Producer never hears its own candidates.** The four structures are chosen
by index and committed blind. The shared offline renderer already exists, so
the next step is a **render-and-measure loop** before commit:

1. Bounce each candidate plan offline, short sections only.
2. Measure:
   - drum-bus continuity across the handoff (the dropout above)
   - vocal collisions
   - the loudness curve
   - silence and peak
3. Repair or rank the plans on those measures, and report the numbers in the
   reply.

That turns *Try another* from a template rotation into a measured choice,
without claiming taste. The handoff should become an equal-power overlap, or a
deliberate break that the plan names. Separately, the GPU runtime needs the
owner's package decision before any model path is on by default.

The local development history still has no off-machine backup.
