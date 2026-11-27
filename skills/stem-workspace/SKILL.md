---
name: stem-workspace
description: >
  Continue the 2become1 stem workspace safely: the keep-mounted Studio, the
  Cutting Room clip edits, Record Sleeves stem identity, the Stem-Focus panel
  and role-based patchbay visuals. Use when changing library.js, the Crate,
  stem-sleeve.js, stem-focus.js, stem-roles.js, placement, or the clip
  inspector.
---

# Stem workspace (Never Lose the Mix → Studio Surgeon)

The detail lives in the docs. Read the one for your surface first:
- [never-lose-the-mix](../../docs/never-lose-the-mix.md)
- [cutting-room](../../docs/cutting-room.md)
- [record-sleeves](../../docs/record-sleeves.md)
- [studio-surgeon](../../docs/studio-surgeon.md)
- [Owner acceptance and release handoff](../../docs/studio-surgeon-act-iii.md)
- [Stem audio contract](../stem-audio-contract/SKILL.md)

Trust the code and `AGENTS.md` over this note.

## Invariants

- **Never Lose the Mix.**
  - The Studio stays mounted across navigation.
  - There is one `AudioContext`, made by Play.
  - Arrangement history survives a trip through Library, Activity or Engine.
  - Journeys check `window.__arrangement.__tag`, the clips and the history depth.
- **Cutting Room.**
  - Every edit is a `DawSession.apply` command: non-destructive and one undo step.
  - Cut, Copy and Paste are clipboard data plus `deleteClip`, `deleteRegion` and `pasteClipboard`.
  - Source offsets go through `time-math.js`.
  - Prove an edit by exporting the WAV and measuring silence and level, not by reading state.
- **Record Sleeves.**
  - A stem *is* `(stem_set_id, role)`. The label lives only in `names_json` and is looked up live, never stored in ProjectState.
  - The audio URL is exactly the stem route.
  - Reuse points at Library media; no WAV is ever copied.
  - Search results keep source attribution (recording and role).
- **Stem-Focus.**
  - It is ONE panel. Asset mode (Library, Crate) renames and places a selection. Clip mode (Arrangement) edits through the clip's existing commands.
  - Audition uses the one `audio.js` preview, registered via `useFocusAudio`, plus the `exclusive-play` handshake. The panel says what interrupted it.
  - A waveform is real peaks only: the stem route, or the Arrangement's `peaksFor`. Unknown peaks are said, never drawn.
- **Patchbay identity.**
  - Each role has a `--color-role-*` token, a glyph and the written role (`stem-roles.js`), on rows, clips and the panel.
  - The A/B bank stays the clip colour and the lane label.
  - Center/sides and unknown roles are neutral.

## Verification habits that paid off

- **Run the journeys against a scratch `--data-dir` on a spare port.**
  - Never touch 8765 or the owner's listening port.
  - Run pytest and servers from a worktree with `PYTHONPATH=src`, because the shared `.venv` points at main.
- **Prove each fix with a negative control.** Swap the old file in and see the test fail.
- **Check a failing journey against the base commit before blaming the branch.** Record Sleeves step 12 was already red at `170b270`.
- **Focus restoration breaks when a re-render rebuilds the trigger.**
  - Restore by `data-key`, not by element.
  - Document-level shortcuts must ignore keys inside `<dialog>`.
- **Importing `audio.js` from a component builds `Audio()` at import time.** That breaks the tests: inject it instead.
- **A CSS grid row stretches its neighbours** (a card next to an expanded one). Use `align-items: start`.
- **Literal colours fail `dom.test.js`.** Add tokens in `studio.css` only.
- **Headless passes are not acceptance.** The owner listens on a running scratch Studio; keep it up and say which port.

## Open

- The owner accepted the In/Out repair at `e705a12`. Loop wraps use approximate media seeks and can have a gap.
- Navigation preserves the mounted session. Refresh, tab close or restart loses live desk state, unsaved edits and Undo history. Save the Arrangement explicitly.
- The 200% mobile zoom overflow remains open. Real screen-reader speech remains unverified.
- The other limits are listed in `docs/studio-surgeon.md`.
