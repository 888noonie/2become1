# 2become1

A general-purpose mashup stack. Given any two tracks, it can:

1. **source** them — local files, YouTube (yt-dlp), or torrents (scraper)
2. **analyze** them — BPM + musical key (self-contained, no ML deps)
3. **align** — time-stretch the lead to the anchor's tempo, pitch-shift it
   into the anchor's key (ffmpeg atempo/asetrate)
4. **recombine** — mix the aligned lead over the anchor track

The name is a nod to the Spice Girls, but this is a general tool, not a
one-off for any specific song.

## Setup

```
uv venv .venv
uv pip install --python .venv/bin/python -e .
.venv/bin/2become1 --help
```

Requires `ffmpeg` on PATH (system install). `yt-dlp` optional for YouTube.

## Usage

```
# Inspect tempo/key of tracks
2become1 analyze track_a.mp3 track_b.mp3

# Search a torrent index for source material
2become1 torrent "some artist - some track" --magnet

# Mash: align 'lead' to 'anchor' (anchor sets tempo + key)
2become1 mash anchor.mp3 lead.mp3 -o out.mp3 --lead-gain 1.1
```

## Roadmap

- [x] analyze (BPM + key)
- [x] source: local + yt-dlp + torrent scraper
- [x] align (tempo/key) + recombine
- [ ] stem separation (ffmpeg center-extract, then Demucs)
- [ ] lyrics transcription + section alignment
- [ ] key/Camelot-compat hints in `analyze`
