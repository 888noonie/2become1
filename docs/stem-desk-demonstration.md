# Stem Desk owner demonstration plan — 2026-11-17

A controlled, transient demonstration of the integrated Stem Performance Desk.
Nothing here touches the owner's real library, projects or media database, and
nothing here is a production deployment.

## Scope

Show the four-lane desk on one genuinely separated musical arrangement:

1. select one separated track;
2. see four accurate lanes and their provenance;
3. start all four stems together;
4. change one lane's gain independently;
5. mute and solo individual stems;
6. stop and confirm the transport resets.

The audible part is for the owner to hear. The readiness checks run headless
Chromium, which has no listening environment, so they do not claim that sound
reached a speaker.

## The fixture

`tests/browser/musical_fixture.py` generates an original 19.2 s, 100 BPM
A-minor arrangement: kick, snare and hi-hat pattern, bass line, pad and a
formant-shaped lead melody. It is synthesised here, so it carries no licensing
question; it is an arrangement, not a studio recording.

The first demonstration fixture — pure 110/440/1320 Hz tones plus pink noise —
was not music. Its Demucs `vocals` and `drums` stems measured −68.8 and
−63.6 dBFS RMS, so soloing them sounded like Stop. That failure and its
measurements are recorded in `docs/stem-desk-audio-diagnosis.md`. The tone
fixture must not be used again.

## Prerequisites

- Integration worktree `/tmp/opencode/2become1-family-together`.
- `.venv`, `node_modules`, `ffmpeg` and Demucs 4.1.0 available.
- The HTDemucs weights are already cached from the earlier runs.

The project `.venv` is an editable install pointing at the owner checkout, so
run the integration code with `PYTHONPATH=$PWD/src`. Without it the server would
serve `763e1d9`, not the integration branch.

## Quick start: the already-prepared musical library

The separated musical track already exists at
`/tmp/opencode/musical-demo2` (track `7439aa13…`, stem set `857f73c9…`, four
stems, `htdemucs@4.1.0`, CUDA). To audition it directly:

```bash
cd /tmp/opencode/2become1-family-together
PYTHONPATH=$PWD/src /home/richardn/2become1/.venv/bin/twobecomeone web \
  --port 8766 --data-dir /tmp/opencode/musical-demo2
```

Open <http://127.0.0.1:8766>, scroll to **Stem Performance Desk**, choose
`mix`, press **Load stems**.

## Rebuild from scratch (reproducible)

```bash
cd /tmp/opencode/2become1-family-together
.venv/bin/python tests/browser/musical_fixture.py \
  --out /tmp/opencode/musical-fixture/mix.wav
```

Then launch a fresh temporary library and upload the mix through the UI
(**Choose Track → Upload**). The upload keeps the full mix and queues
`submit_separation(method="auto")`, which resolves to Demucs on CUDA. Wait for
the job in **Activity** to complete before loading the desk.

Do not run the Studio against `~/.local/share/2become1`. Port 8765 stays free.

## Run the demonstration

| Step | Action | Expected |
| --- | --- | --- |
| 1 | Choose the track, click **Load stems** | “Loaded 4 separated stems on one transport.” |
| 2 | Inspect the lanes | Vocals, Drums, Bass, Other, each with `demucs · htdemucs@4.1.0 · cuda`; no center/sides note |
| 3 | Press **Play** | “Playing 4 stems together.”; position advances; drums, bass, pad and lead are all present |
| 4 | Drag **Bass gain** to `-12 dB` | Only the bass lane reads `-12 dB`; the others keep their value |
| 5 | Press **M** on Drums, then **S** on Vocals | Each reports `aria-pressed="true"`; soloing Vocals leaves the lead melody alone, not silence |
| 6 | Release solo and mute, press **Stop**, then **Play** | All four return; stop resets to `0.0 s` and play restarts cleanly |

If a real separation ever produces a near-silent lane, the panel now labels it
“effectively silent in this separation” and says so when it is soloed, rather
than letting a correct silence look like a Stop.

## Verification

Signal-level and real-media checks, recorded under
`/tmp/opencode/evidence/sound-check-failure/`:

```bash
# graph-level synthetic tone test (kept; proves gain nodes)
node tests/browser/stem_desk_audio.js

# real decoded stems (the gate the first demo lacked)
node tests/browser/stem_desk_real_audio.js \
  --stems /tmp/opencode/musical-demo2/stems/857f73c9c69d4a4c8cc80b52b9363751

# UI readiness against the running instance
node tests/browser/demo_smoke.js http://127.0.0.1:8766
```

The real-stem gate passes **15/15** on the musical stems: every lane audible
solo, transport still playing under solo, no clipping, mute and solo exact,
gain isolated, Stop exactly silent. Against the original failed stems it fails
the two silent lanes, which is the reproduction of the audit failure.

## Shutdown

```bash
pkill -f "twobecomeone web --port 8766 --data-dir /tmp/opencode/musical-demo2"
ss -ltnp | grep 8766 || echo "8766 free"
```

## Limits

- The fixture is an original synthetic arrangement, not a studio recording; it
  demonstrates the instrument, not production separation quality.
- Audible acceptance is the owner's judgement. Neither the PCM capture nor the
  browser harness claims speaker output.
- The five moderate mobile accessibility findings predate the integration.
- The desk keeps its bounded decoded-PCM limits and refuses over-long tracks.
