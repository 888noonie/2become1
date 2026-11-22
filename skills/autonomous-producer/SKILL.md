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

## Tests

```bash
node --test tests/frontend/chorus-fit-panel.test.js
node tests/browser/maestro_journey.js
PYTHONPATH=src .venv/bin/pytest -q tests/test_creative_move.py tests/test_listening_room.py -k "not live and not local_model"
```

The two `test_listening_room.py` tests marked live talk to the local model. A llama-server crash from the known NVIDIA driver mismatch is an environment failure, not a reason to weaken the fallback.

## Recovery

Revert the producer commit. The musician's project file is the arrangement JSON in the data dir; restoring it from the last save is separate from git. Do not rewrite history to remove a bad take.

## What not to do

Do not invent a governance layer or a new project type. Do not treat a remembered spec as safe for fields the command still names. Do not leave the input disabled after control returns. Do not claim the Producer heard its candidates. It commits the plan blind; measuring candidates before commit is the next bottleneck recorded in `docs/the-maestro.md`.
