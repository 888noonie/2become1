---
name: autonomous-producer
description: >
  Change the 2become1 Producer that takes the decks, revises an arrangement,
  and returns control. Use when a remembered plan, a late callback, or Take
  over can move or delete the musician's clips.
---

# Autonomous Producer and human takeover

## When to use

Changing Take the decks, Try another, More energy, Keep, Hear mine, Take over, Take back, Restore, or You play.

## Problem

The Producer remembers a spec and a plan, then writes them onto the current lanes. A remembered write must not delete a clip the musician changed after that plan was made, and returning control must leave the talk box usable.

## Source of truth

- `src/twobecomeone/studio_static/js/components/arrangement-producer.js`
- `src/twobecomeone/studio_static/js/arrangement/producer-intent.js`
- `src/twobecomeone/studio_static/js/arrangement/chorus-fit.js` (`DECK_REVISIONS`)
- `src/twobecomeone/producer_brain.py`
- `docs/the-maestro.md`

## Boundaries

Buttons and the keyword map run with no model. A model call reads the environment only. Do not write a key into the repo and do not select `mistral-large-3:675b-cloud`. Unknown phrases with no model return `PR_PROVIDER_UNAVAILABLE` and apply nothing. There is one `ProjectState`. Do not add a second project model.

## Invariants

- `arrangementDirty` compares `editingSerial()` and `session.edit.revision` with `conv.decks`. It guards Restore and Take back only. It does not run before the next autonomous write.
- While a previous idea is heard, `realise` undoes that idea before the next write. It clears `idea.touched` only for clip ids named by `spec.main`, `spec.parts`, or `spec.clips`. Any other touched clip is left in place.
- `commitArrangement` also omits those touched ids from `spec.drop`. A changed clip is not deleted to make room. It is not added to `spec.kept`, so a later command that names the same id may still retarget it.
- Do not put a touched idea clip into `musicianClips`. That blocks a legitimate same-clip retarget and breaks Hear mine.
- An explicit new Take the decks may replace untouched Producer clips. A preserved clip can remain beside a new vocal. The reply must name what is still playing.
- Take over, Take back, and You play while `conv.busy` bump `conv.turn`, abort `conv.loadAbort`, set `conv.busy` false, stop playback, and `sync()` so the input enables without waiting for the load.
- `converse`, `realise`, and `settle` ignore completions whose `conv.turn` no longer matches. A late load must not write and must not clear a newer turn's busy flag.
- `DECK_REVISIONS` is 4. After that the Producer asks for one change, Take over, or Take back.
- A hand edit hides Restore. Take back then refuses and points at Undo.

### Kept clips

An AI proposal is not the musician's decision. Only Keep it adds the idea clip ids to `musicianClips`. A clip moved by hand is touched, not kept.

- A kept clip owns its time on its lane. `clearOfKept` in `producer-intent.js` starts a new part where the kept clip ends. A kept clip is not moved, trimmed, or doubled.
- A lane that holds a kept clip keeps its own gain curve. The new entrance is the new clip's fade-in. A fresh lane curve holds its first value before the first point (`sampleCurve` in `automation.js`) and would silence the kept clip.
- Keep moves the Restore checkpoint to the current edit serial (`conv.decks.before` and `conv.decks.after` in `keepOrUndo`). Restore and Take back stop there.
- Kept status is derived. On a reload or a newly opened arrangement, `followArrangement` treats every `idea-*` clip already on the lanes as kept, because no pending idea stands behind it. While a card is running, a hand move stays touched and stays out of `musicianClips`. Do not store kept status in ProjectState.

### One write gate

- `realise` runs `respectKept` and refuses a field that targets a kept clip.
- `offer()` is the gate for the Ask buttons, which do not go through `realise`. Clip fields are keyed `<clipId>:<what>`. Filter on the id before the colon. Also drop a mute, a level cut, or a solo that would silence a kept lane.
- During a load, `conv.loadBase` snapshots the lanes and `conv.loadOwn` records fields the Producer itself wrote. A field changed by hand during the load keeps the hand value. If that field is the Producer clip being rewritten, the whole write is dropped.
- Each idea button checks `ideaIsStale()`. A different `session.edit` (Open, New) sets the old idea aside.

### The Producer does not delete a musician's clip

- Bed trims are recomputed from the lanes on every build (`spec.trimmedIds`). A remembered trim is not replayed over a hand trim.
- Every piece of a split bed is handled. A piece that starts inside a new part and runs past it returns where the part ends (`resumeAfter`: a move plus a slip). A piece wholly inside stays, and the reply names it.
- A trim that ends the other song's vocal at this vocal's entrance carries `atVocalStart`, so it follows a bar the musician names later.

### Replies state what was applied

- Say the fade, position, or length actually written. Name every clip still sounding under the new part, and every clip that now comes back later.
- More energy measures from where the vocal sits now (`planAsPlaced`). When nothing can change, it says so and writes nothing.
- `creativeDirection` is a keyword map. The reply quotes the word it read and says no model was used. `producer_brain.status` reports `answered` from the last real call. A model that `/api/tags` lists and that crashes on load is unavailable.

## Procedure

1. Add a frontend test that fails on the previous producer before changing it.
2. For a stalled load, hold `loadSource` and press Take over. The input must enable, and Stop must be obeyed. Releasing the load must add no `idea-` clip.
3. Move or gain an idea clip by hand, then ask for More energy. That same clip id, position, and gain must remain when the new command does not name it.
4. Run `node tests/browser/maestro_journey.js`. It must not call the model.

## Failure modes

- Reverting a heard idea with `before = {exists: false}` deletes the musician's moved clip, then a fresh plan mints a new id.
- Promoting every touched clip to kept, so Try the strongest match cannot change the source and Hear mine cannot remove the idea.
- Take over aborting the fetch but leaving `conv.busy` true, so later typed commands never run.
- A late `answer()` overwriting the takeover reply.
- Assuming `arrangementDirty` protects the next take. It does not.
- Guarding only the main write path. The Maestro reviews found the same class of bug on a typed match, an Ask button, a cached preview, and a reopened project.
- Refreshing the whole load snapshot on a Producer write, which absorbs an unrelated hand edit made during that load.
- Using clip gain to silence a clip. Clip gain stops at −24 dB. Deleting a musician's clip is not a mute.

## Tests

```bash
node --test tests/frontend/chorus-fit-panel.test.js
node tests/browser/maestro_journey.js
PYTHONPATH=src .venv/bin/pytest -q tests/test_creative_move.py tests/test_listening_room.py -k "not live and not local_model"
```

The two `test_listening_room.py` tests marked live talk to the local model. A llama-server crash from the known NVIDIA driver mismatch is an environment failure, not a reason to weaken the fallback.

`docs/the-maestro.md` records a CPU-only Ollama on `127.0.0.1:11435` that does not touch CUDA or the main service. On 2026-11-22 that note measured qwen2.5:3b-instruct at 18/20 creative moves and 0.72 on varied phrasings, below the 0.75 bar. The keyword path remains the one this release depends on. Stop a spare server by its PID. `pkill -f "ollama serve"` also matches the calling shell.

## Recovery

If review rounds keep finding another write path, stop patching paths one by one. The next step recorded in `docs/the-maestro.md` is to build each take from the current ProjectState. That step is not in this release. The release protection is the touched-clip rule above.

Revert the producer commit. The musician's project file is the arrangement JSON in the data dir; restoring it from the last save is separate from git. Do not rewrite history to remove a bad take.

## What worked, and what failed

These are the lessons from the Maestro reviews through `cbe6984`.

Worked:

- Buttons and the keyword map arrange two songs, revise inside `DECK_REVISIONS` (4), and export with no model. `node tests/browser/maestro_journey.js` is that proof.
- Take over, Take back, and You play during a load return the input when they bump `conv.turn`, abort `conv.loadAbort`, clear `conv.busy`, stop playback, and call `sync()`.
- A clip the musician moved or gained survives a later command that does not name it. The same id, position, and gain are the check.
- Codex review was useful when each finding had a control that failed on the previous file. The repair stayed in `arrangement-producer.js`. Eight recorded rounds are in `docs/the-maestro.md`. A named limitation that does not reproduce is not a new review cycle.

Failed, and must stay failed:

- Rewinding every touched clip to `{exists: false}` before a new plan. More energy then deleted the vocal the musician had moved and wrote a new id.
- Adding that touched clip to `musicianClips`. Same-clip retarget and Hear mine both broke.
- Aborting the fetch while leaving `conv.busy` true. Ordinary commands, including Stop, never ran.
- Expecting `arrangementDirty` to protect the next take. It does not.

Still true after the repair: a command that names a clip may replace it. A new Take the decks may replace untouched Producer clips. A preserved clip can sit beside a new vocal. The Producer plans from analysis and commits without hearing the candidates.

## What not to do

Do not invent a governance layer or a new project type. Do not treat a remembered spec as safe for fields the command still names. Do not leave the input disabled after control returns. Do not claim the Producer heard its candidates. Measuring candidates before commit is the next bottleneck recorded in `docs/the-maestro.md`.
