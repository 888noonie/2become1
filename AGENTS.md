# AGENTS.md

Operating notes for an agent changing this repository. Product behavior is
described in `README.md`. Historical phase handoffs live in `CODEX.md` and the
`PHASE_*.md` files. When those older plans disagree with the code, trust the
code and this file.

## Run

```bash
uv sync --frozen --extra web --extra dev --extra demucs
.venv/bin/twobecomeone web
.venv/bin/pytest -q
npm test
```

The Studio listens on `127.0.0.1:8765` and stores media in
`~/.local/share/2become1`. Do not bind `0.0.0.0` without `--allow-network`.
A sync that omits `--extra demucs` uninstalls the local Demucs extra.

Verify UI against a second loopback port and a temporary `--data-dir`. Leave
the process already bound to port 8765 running. The frontend is vanilla JS in
`src/twobecomeone/studio_static` with no production bundler. Tests mount the
real view functions with `node --test tests/frontend/*.js`.

## Library, separation, and the sidebar

- A track that finishes a Studio upload or YouTube import keeps its original
  full mix. `_finish_import` then queues `submit_separation(method="auto")`
  and returns without waiting. A full queue or a missing capability must not
  fail the import.
- Do not start that hook from `ingest()` or the CLI `import` command. Doing so
  separates every test fixture. Do not backfill tracks that were stored before
  the hook existed.
- `auto` uses Demucs vocals, drums, bass, and other when `demucs.api` imports.
  Otherwise the components are ffmpeg center and sides. Never label center or
  sides as vocals. Explicit `method="demucs"` still fails closed when Demucs
  is not installed.
- Constructing `demucs.api.Separator` downloads HTDemucs weights. Import tests
  that reach `JobEngine.close()` must monkeypatch
  `twobecomeone.separator.demucs_available` to false unless the test is
  specifically about Demucs.
- The Library **+** pane calls `openSourcePicker(store, null)`. That dialog
  keeps its Library, Upload, and YouTube choices.
- The Studio sidebar queue adds a track that is already in the library. It has
  no YouTube paste box. YouTube import stays in Choose Track. The queue is not
  persisted.
- `drop the bass on deck A` applies `{op: eq, deck: A, band: low, db: -12}`.
  On success the agent output is exactly `I have dropped the bass to come in
  on the next suitable cue`. A vocal-loop phrase returns
  `STEM_LOOP_UNAVAILABLE` and does not start separation.
- An EQ cut requested before a deck has a media element is stored and applied
  when the tone stage opens. A missing filter on an already loaded element
  stays `TONE_UNAVAILABLE`, and that failure does not show the bass sentence.

## Contracts that stay strict

- `import_next` still requires `itemId`, `url`, and `deck`. A library track
  enters the queue through `assign_deck`, not by omitting the URL.
- No model call separates stems. Cloud model calls read `OLLAMA_API_KEY` from
  the environment only. Do not write a key into the repo, and do not select
  `mistral-large-3:675b-cloud`.
- Unknown mix phrases with no model return `PR_PROVIDER_UNAVAILABLE` and apply
  nothing.

## Commits

Stage the source, tests, and docs for the change. Leave personal documents,
`Mock Images/`, `.playwright-mcp/`, editor state, and session notes
untracked. Do not commit unless the user asks.
