# Stem Desk owner demonstration plan — 2026-11-17

A controlled, transient demonstration of the integrated Stem Performance Desk.
Nothing here touches the owner's real library, projects or media database, and
nothing here is a production deployment.

## Scope

Show the four-lane desk on one genuinely separated synthetic track:

1. select one separated track;
2. see four accurate lanes and their provenance;
3. start two or more stems together;
4. change one lane's gain independently;
5. mute and solo individual stems;
6. stop and confirm the transport resets.

The audible part is for the owner to hear. This plan was validated with a real
Demucs separation and a real browser session, but **no claim is made that sound
reached a speaker**: the readiness check runs headless Chromium, which has no
listening environment.

## Prerequisites

- Integration worktree `/tmp/opencode/2become1-family-together` on branch
  `integration/family-together`.
- `.venv`, `node_modules`, `ffmpeg`, and Demucs 4.1.0 available (all present).
- First demonstration run downloads the HTDemucs weights (~80 MB) unless
  already cached.

The project `.venv` is an editable install pointing at the owner checkout, so
run the integration code with `PYTHONPATH=$PWD/src`. Without it the server would
serve `763e1d9`, not the integration branch.

## 1. Build the synthetic fixture (once)

Four distinguishable components, generated locally; no licensing issue:

```bash
D=/tmp/opencode/demo-fixtures
mkdir -p "$D" && cd "$D"
ffmpeg -v error -f lavfi -i "sine=frequency=110:sample_rate=44100:duration=12"  -af volume=0.35 bass.wav
ffmpeg -v error -f lavfi -i "sine=frequency=440:sample_rate=44100:duration=12"  -af "volume=0.25,tremolo=f=5:d=0.6" vocal.wav
ffmpeg -v error -f lavfi -i "anoisesrc=color=pink:sample_rate=44100:duration=12" -af "volume=0.18,agate=threshold=0.05:ratio=4:attack=5:release=80" drum.wav
ffmpeg -v error -f lavfi -i "sine=frequency=1320:sample_rate=44100:duration=12" -af volume=0.18 other.wav
ffmpeg -v error -i bass.wav -i vocal.wav -i drum.wav -i other.wav \
  -filter_complex "amix=inputs=4:duration=longest:normalize=0" -ar 44100 -ac 2 synthetic-mix.wav
```

## 2. Launch a transient Studio

Port 8765 is free on this machine, but use 8766 so an accidental production
instance could never be confused with the demonstration.

```bash
cd /tmp/opencode/2become1-family-together
PYTHONPATH=$PWD/src .venv/bin/twobecomeone web \
  --port 8766 --data-dir /tmp/opencode/demo-data
```

`/tmp/opencode/demo-data` is temporary and disposable. Loopback only; never add
`--allow-network`. Open <http://127.0.0.1:8766>.

## 3. Import and separate

1. **Choose Track → Upload** and upload `/tmp/opencode/demo-fixtures/synthetic-mix.wav`.
2. The import keeps the full mix and queues `submit_separation(method="auto")`.
   On this machine that resolves to Demucs on CUDA.
3. Wait for the separation job in **Activity** to complete. The 12-second
   fixture took well under a minute once the model was cached.

Do not click *Separate* again while the job is running.

## 4. Run the demonstration

Scroll to **Stem Performance Desk** in the Studio view.

| Step | Action | Expected |
| --- | --- | --- |
| 1 | Choose `synthetic-mix` in the track selector, click **Load stems** | Status: “Loaded 4 separated stems on one transport.” |
| 2 | Inspect the lanes | Vocals, Drums, Bass, Other, each with `demucs · htdemucs@4.1.0 · cuda` and no center/sides fallback note |
| 3 | Press **Play** | Status: “Playing 4 stems together.”; the position advances |
| 4 | Drag **Bass gain** to `-12 dB` | Only the bass lane reads `-12 dB`; the others keep their value |
| 5 | Press **M** on Drums, then **S** on Vocals | Each button reports `aria-pressed="true"`; the status names the action |
| 6 | Press **Stop** | Position returns to `0.0 s`; the desk reports stopped |

Release solo and mute before the next run if you want all four audible again.

## 5. Recovery and teardown

```bash
# stop only the demonstration instance
pkill -f "twobecomeone web --port 8766 --data-dir /tmp/opencode/demo-data"
ss -ltnp | grep 8766 || echo "8766 free"

# optional: discard the temporary library and fixture
rm -rf /tmp/opencode/demo-data /tmp/opencode/demo-fixtures
```

If the browser or server is interrupted, relaunch the same command; the
temporary data directory keeps the imported track and its stems. The owner's
real data directory `~/.local/share/2become1` is never opened by this plan.

## What was verified in this phase

A real separation and a real browser session, recorded in
`/tmp/opencode/evidence/`:

- Demucs on CUDA produced `vocals`, `drums`, `bass`, `other`, 12.0 s each,
  stored under the temporary data directory with `htdemucs@4.1.0` provenance.
- `tests/browser/demo_smoke.js` drove the real Studio and passed 12/12 checks:
  shell renders, the track is offered, four lanes load together, names are the
  four Demucs stems, provenance names the real model, mute and solo toggle
  pressed state, bass gain reads −12 dB, the transport advances to 1.2 s,
  status says “Playing 4 stems together.”, stop resets to 0.0 s, no page errors.
- The server bound `127.0.0.1:8766` only, was stopped afterwards, and port 8765
  and the canonical data directory were untouched.

To repeat the readiness check against a running demonstration instance:

```bash
node tests/browser/demo_smoke.js http://127.0.0.1:8766
```

## Outstanding limitations

- Audibility is the owner's to confirm. The readiness check and the
  signal-level `tests/browser/stem_desk_audio.js` both stop short of a speaker.
- The five moderate mobile accessibility findings are pre-existing at
  `763e1d9`; they are not introduced by this demonstration branch.
- The desk keeps its bounded decoded-PCM limits and refuses over-long tracks;
  a loop-window or streaming design is not part of this demonstration.
