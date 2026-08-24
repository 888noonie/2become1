"""2become1 — a general-purpose mashup stack.

Given any two tracks, this pipeline can:
  1. source  them (local files, YouTube via yt-dlp, or torrents)
  2. analyze them (BPM + musical key, self-contained, no ML deps)
  3. separate vocals/drums/bass/other (ffmpeg rough pass, or Demucs)
  4. align   them (tempo stretch + key pitch-shift)
  5. recombine them into a mashup in your style

The package name "2become1" is a nod to the Spice Girls; it is not a
one-off tool for any specific song pair.
"""

__version__ = "0.2.0"
