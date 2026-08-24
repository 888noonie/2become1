"""2become1 command-line interface."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from . import __version__
from . import analyzer, assembler, sources, separator


def cmd_analyze(args) -> int:
    results = []
    for p in args.paths:
        r = analyzer.analyze(p)
        result = {
            "path": str(p),
            "bpm": r.bpm,
            "key": r.key,
            "duration": round(r.duration, 3),
        }
        results.append(result)
        if not args.json:
            print(f"--- {p}")
            print(f"  BPM  : {r.bpm}")
            print(f"  Key  : {r.key['tonic']} {r.key['mode']} (conf {r.key['confidence']})")
            print(f"  Dur  : {r.duration:.1f}s")
    if args.json:
        print(json.dumps(results, indent=2))
    return 0


def cmd_separate(args) -> int:
    result = separator.separate(args.path, args.out_dir, method=args.method)
    if args.json:
        print(json.dumps({k: str(v) for k, v in result.items()}, indent=2))
    else:
        for stem, path in result.items():
            print(f"  {stem}: {path}")
    return 0


def cmd_torrent(args) -> int:
    hits = sources.search_torrents(args.query, index=args.index, cap=args.cap)
    if not hits:
        print(f"no torrent results for '{args.query}' (index {args.index})")
        return 1
    if args.json:
        print(json.dumps([{"title": h.title, "source": h.source, "magnet": h.magnet}
                          for h in hits], indent=2))
        return 0
    for i, h in enumerate(hits):
        print(f"[{i}] {h.title}  ({h.source})")
        if args.magnet:
            print(f"    {h.magnet}")
    return 0


def cmd_mash(args) -> int:
    anchor_a = analyzer.analyze(args.anchor)
    lead = analyzer.analyze(args.lead)
    print(f"anchor '{args.anchor}': {anchor_a.bpm} BPM, "
          f"{anchor_a.key['tonic']} {anchor_a.key['mode']}")
    print(f"lead   '{args.lead}': {lead.bpm} BPM, "
          f"{lead.key['tonic']} {lead.key['mode']}")

    tempo_ratio = anchor_a.bpm / lead.bpm
    key_anchor = f"{anchor_a.key['tonic']} {anchor_a.key['mode']}"
    key_lead = f"{lead.key['tonic']} {lead.key['mode']}"
    shift = assembler.semitones_to_match(key_anchor, key_lead)
    print(f"tempo ratio: {tempo_ratio:.3f}  key shift: {shift} st "
          f"(lead -> anchor)")

    lead_path = Path(args.lead)
    if args.stems:
        print(f"separating lead stems into {args.stem_dir} ...")
        stems = separator.separate(args.lead, args.stem_dir, method=args.stem_method)
        if "vocals" in stems:
            lead_path = stems["vocals"]
        else:
            print("no vocals stem found; using full lead")

    if args.dry_run or args.json:
        info = {
            "anchor": str(args.anchor), "anchor_bpm": anchor_a.bpm,
            "anchor_key": anchor_a.key, "lead": str(args.lead),
            "lead_bpm": lead.bpm, "lead_key": lead.key,
            "tempo_ratio": tempo_ratio, "semitone_shift": shift,
            "output": str(args.output),
        }
        if args.stems:
            info["stems"] = {k: str(v) for k, v in stems.items()}
        if args.json:
            print(json.dumps(info, indent=2))
        if args.dry_run:
            print("dry run — no output rendered")
            return 0

    spec = assembler.MashSpec(anchor_path=Path(args.anchor), lead_path=lead_path,
                              lead_gain=args.lead_gain, anchor_gain=args.anchor_gain)
    out = assembler.build_mash(spec, tempo_ratio, shift, args.output)
    print(f"wrote {out}")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="twobecomeone",
                                 description="General-purpose mashup stack")
    ap.add_argument("--version", action="version", version=f"twobecomeone {__version__}")
    sub = ap.add_subparsers(dest="cmd", required=True)

    a = sub.add_parser("analyze", help="detect BPM + key of track(s)")
    a.add_argument("paths", nargs="+")
    a.add_argument("--json", action="store_true")
    a.set_defaults(func=cmd_analyze)

    s = sub.add_parser("separate", help="separate a track into stems")
    s.add_argument("path", help="audio file to separate")
    s.add_argument("-o", "--out-dir", default="stems")
    s.add_argument("--method", choices=["auto", "demucs", "ffmpeg"], default="auto")
    s.add_argument("--json", action="store_true")
    s.set_defaults(func=cmd_separate)

    t = sub.add_parser("torrent", help="search a public torrent index for sources")
    t.add_argument("query")
    t.add_argument("--index", type=int, default=0)
    t.add_argument("--cap", type=int, default=10)
    t.add_argument("--magnet", action="store_true")
    t.add_argument("--json", action="store_true")
    t.set_defaults(func=cmd_torrent)

    m = sub.add_parser("mash", help="align a lead track to an anchor and mix")
    m.add_argument("anchor", help="track providing tempo + key")
    m.add_argument("lead", help="track aligned to the anchor (vocals/lead)")
    m.add_argument("-o", "--output", default="mashup.mp3")
    m.add_argument("--lead-gain", type=float, default=1.0)
    m.add_argument("--anchor-gain", type=float, default=1.0)
    m.add_argument("--stems", action="store_true",
                   help="separate the lead's vocals and use them instead of the full mix")
    m.add_argument("--stem-dir", default="stems")
    m.add_argument("--stem-method", choices=["auto", "demucs", "ffmpeg"], default="auto")
    m.add_argument("--dry-run", action="store_true")
    m.add_argument("--json", action="store_true")
    m.set_defaults(func=cmd_mash)

    args = ap.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
