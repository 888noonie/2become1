# 2become1 UI/UX Plan — Local First, Vercel-Ready

**Author:** kimi
**Date:** 2026-08-24
**Target:** V0.2

## Goal

Give 2become1 a web UI that a non-technical user can operate. It must run
locally on Richard's laptop and be trivial to deploy to Vercel if the local
prototype proves useful.

## Design principles

1. **No hidden magic.** Every transformation is visible and explainable:
   BPM, key, tempo ratio, pitch shift, which stems are used.
2. **Fast feedback loop.** Analysis happens in seconds; full mashup renders in
   the background while the UI keeps the user informed.
3. **Keyboard-friendly, mouse-optional.** Drag-and-drop supported, but every
   action has a clear text/click fallback.
4. **Dark, playful, 90s-pop aesthetic.** The Spice Girls nod should show up
   in color and typography, not in the UX copy.

## Technology choice

| Layer | Tech | Rationale |
|-------|------|-----------|
| Frontend | React + Tailwind + Vite | Fast dev, small bundle, easy Vercel deploy |
| State | Zustand | Tiny, no boilerplate |
| Backend | FastAPI (Python) | Serves the existing twobecomeone package directly; no port to JS |
| Realtime | Server-Sent Events (SSE) | Progress bars for long renders; simpler than WebSockets |
| Audio player | wavesurfer.js | Waveform preview with regions, in/out points |
| Storage | local disk + optionally SQLite | Keep project state between sessions |

## Backend API (FastAPI)

Mounted on the existing `twobecomeone` package. Each CLI command becomes an
endpoint.

### `POST /upload`
- Accept one or two audio files.
- Save to `projects/<uuid>/`.
- Return track IDs + ffprobe metadata (duration, sample rate, channels).

### `GET /tracks/{id}/analyze`
- Run `analyzer.analyze()`.
- Return JSON: `bpm`, `key`, `duration`, `filename`.

### `POST /tracks/{id}/separate`
- Run `separator.separate()`.
- Stream progress via SSE if Demucs is used (model load, chunk progress).
- Return stem file URLs: `vocals`, `drums`, `bass`, `other` / `instrumental`.

### `POST /mashups`
Body:
```json
{
  "anchor_id": "...",
  "lead_id": "...",
  "anchor_gain": 1.0,
  "lead_gain": 1.0,
  "use_vocal_stem": true,
  "loop_lead": false,
  "output_name": "my_mashup.mp3"
}
```
- Computes tempo ratio + key shift.
- Renders in background.
- Returns `mashup_id`.

### `GET /mashups/{id}/status`
- Polling endpoint (or SSE) for render progress.

### `GET /mashups/{id}/download`
- Download the finished mashup.

### `GET /search/torrents?q=...`
- Proxy `sources.search_torrents()`.
- Returns TPB magnets / archive.org torrent URLs.

### `POST /search/youtube`
- Body: `{ "url": "https://..." }`
- Downloads to a project dir, returns track metadata.

## Frontend screens

### 1. Project landing

Centered two-drop zones:
```
┌─────────────────┐      ┌─────────────────┐
│   DROP BEAT     │  ↔   │   DROP VOX      │
│   or pick file  │      │   or YouTube    │
└─────────────────┘      └─────────────────┘
        │                          │
     BPM / KEY                   BPM / KEY
```

- Two big cards for anchor and lead.
- Accept file drop, click-to-pick, paste YouTube URL, or search torrent.
- Once a track is loaded, show: waveform thumbnail, BPM, key, duration, file
  source icon (local/YouTube/torrent).

### 2. Source browser (slide-over panel)

Tabs: **Local**, **YouTube**, **Torrent Search**.
- Local: native file picker (multi-select).
- YouTube: paste URL, preview title before download.
- Torrent: search box, results list with ▶ preview / ↓ download button.

### 3. Stem / arrangement view

After a lead is loaded, show a small mixer:
```
Lead stems ─┬─ vocals    [solo] [mute] [gain ──────]
            ├─ drums     [solo] [mute] [gain ──────]
            ├─ bass      [solo] [mute] [gain ──────]
            └─ other     [solo] [mute] [gain ──────]
```
- If Demucs hasn't run, show "Separate stems" button with estimated time.
- If using ffmpeg fallback, only vocals/instrumental shown.
- Anchor track can also be stem-separated for advanced remixing (future).

### 4. Alignment preview

Show the computed alignment before rendering:
- Anchor BPM → Lead BPM (tempo ratio)
- Anchor key → Lead key (semitone shift, with "relative" shown if 0)
- A short 10-second preview player that loops the drop point.
- Manual override: user can edit BPM/key, or choose to keep original lead pitch.

### 5. Render queue / library

A bottom drawer listing all renders in the current session:
- Name, source tracks, render status (queued / separating / aligning / mixing / done).
- Play button when done, download button, "open folder" link.
- Cancel button for queued/running jobs.

## Real-time progress

For long operations (Demucs separation, mashup render), the backend streams
SSE events:
```
event: progress
data: {"stage": "separate", "percent": 42, "message": "demucs: vocals chunk 3/4"}
```

The frontend renders a stage-based progress bar with animated transitions.

## Local dev stack

```bash
cd /home/richardn/2become1
uv pip install --python .venv/bin/python -e '.[dev,web]'  # adds fastapi/uvicorn/react tooling
.venv/bin/python -m twobecomeone.web.server  # starts FastAPI on :8000
cd ui && npm run dev  # Vite dev server on :5173
```

## Vercel deploy path

1. Build the React app to `ui/dist`.
2. Add a `vercel.json` that serves static files and proxies `/api/*` to a
   serverless function. **Important:** true Vercel serverless can't run
   ffmpeg/Demucs/torch reliably (binary size, cold-start, GPU).
3. Therefore the Vercel version is a **static preview UI** only; real
   processing stays local or moves to a dedicated GPU backend later.

Alternative: self-host the FastAPI backend on Richard's laptop and use
Vercel solely for the React frontend, with the user pointing the UI at their
own backend URL (`?api=http://localhost:8000`). This is the cleanest
"local-first, optionally cloud" shape.

## V0.2 scope

- [ ] FastAPI backend wrapping twobecomeone
- [ ] React frontend with drop zones + source browser
- [ ] Track analysis display (BPM/key/duration)
- [ ] Stem separation trigger + stem mixer
- [ ] Alignment preview with manual override
- [ ] Render queue with SSE progress
- [ ] Local dev server (`twobecomeone web`)
- [ ] Vercel-ready static build config

## Out of scope for V0.2 (future ideas)

- Waveform-based beat-grid editing
- Section detection / auto-cut points
- Lyrics/transcription overlay
- Collaborative projects / cloud storage
- Mobile-optimized responsive layout
