# 2become1

A general-purpose mashup stack. Given any two tracks, it can:

1. **source** them — local files, YouTube (yt-dlp), or torrents (public indexers)
2. **analyze** them — BPM + musical key (self-contained, only numpy/scipy + ffmpeg)
3. **separate** them — optional Demucs (vocals/drums/bass/other), or an ffmpeg center-channel fallback
4. **align** them — time-stretch the lead to the anchor's tempo, pitch-shift it into the anchor's key
5. **recombine** them — mix the aligned lead over the anchor track

The project name is a nod to the Spice Girls, but this is a general tool, not a
one-off for any specific song.

## Setup

Requires **ffmpeg** on PATH. Python 3.11+.

```bash
cd /home/richardn/2become1
uv venv .venv
uv pip install --python .venv/bin/python -e '.[dev]'
.venv/bin/twobecomeone --version
```

For high-quality stem separation with GPU:

```bash
uv pip install --python .venv/bin/python -e '.[demucs]'
```

## Usage

```bash
# Analyze tempo and key
.venv/bin/twobecomeone analyze track_a.mp3 track_b.mp3

# Analyze with JSON output
.venv/bin/twobecomeone analyze track_a.mp3 --json

# Search a public torrent index for source material
.venv/bin/twobecomeone torrent "artist - track" --magnet

# Separate a track into stems (auto: Demucs if installed, else ffmpeg)
.venv/bin/twobecomeone separate track.mp3 -o stems/

# Mash: align 'lead' to 'anchor' (anchor sets tempo + key)
.venv/bin/twobecomeone mash anchor.mp3 lead.mp3 -o out.mp3

# Mash using only the separated vocals from the lead
.venv/bin/twobecomeone mash anchor.mp3 lead.mp3 -o out.mp3 --stems

# Preview what the mash would do without rendering
.venv/bin/twobecomeone mash anchor.mp3 lead.mp3 --dry-run --json
```

## Development

```bash
.venv/bin/pytest tests/ -q
```

## V0.1 Roadmap

- [x] analyze (BPM + key)
- [x] source: local + yt-dlp + torrent scraper
- [x] stem separation: ffmpeg fallback + optional Demucs
- [x] align (tempo/key) + recombine
- [x] pytest test suite
- [x] --json output on all subcommands
- [x] --dry-run for mash
- [ ] lyrics/transcription
- [ ] section-level alignment
- [ ] Camelot-compat hints in `analyze`

## License

MIT
