"""2become1 command-line interface."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import __version__
from . import analyzer, assembler, separator, sources
from .common import UserError, log


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
        if args.json:
            print(json.dumps([]))
        else:
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


def _describe_plan(anchor: analyzer.TrackAnalysis, lead: analyzer.TrackAnalysis,
                   args) -> dict:
    tempo_ratio = anchor.bpm / lead.bpm
    key_anchor = f"{anchor.key['tonic']} {anchor.key['mode']}"
    key_lead = f"{lead.key['tonic']} {lead.key['mode']}"
    shift = assembler.semitones_to_match(key_anchor, key_lead)
    return {
        "anchor": str(args.anchor), "anchor_bpm": anchor.bpm,
        "anchor_key": anchor.key, "lead": str(args.lead),
        "lead_bpm": lead.bpm, "lead_key": lead.key,
        "tempo_ratio": tempo_ratio, "semitone_shift": shift,
        "output": str(args.output),
        "lead_gain": args.lead_gain,
        "anchor_gain": args.anchor_gain,
        "stems": args.stems,
        "stem_method": args.stem_method,
        "dry_run": args.dry_run,
    }


def cmd_mash(args) -> int:
    anchor_a = analyzer.analyze(args.anchor)
    lead = analyzer.analyze(args.lead)

    if not args.json:
        print(f"anchor '{args.anchor}': {anchor_a.bpm} BPM, "
              f"{anchor_a.key['tonic']} {anchor_a.key['mode']}")
        print(f"lead   '{args.lead}': {lead.bpm} BPM, "
              f"{lead.key['tonic']} {lead.key['mode']}")

    plan = _describe_plan(anchor_a, lead, args)
    if not args.json:
        print(f"tempo ratio: {plan['tempo_ratio']:.3f}  key shift: {plan['semitone_shift']} st "
              f"(lead -> anchor)")

    if args.dry_run:
        if args.json:
            print(json.dumps(plan, indent=2))
        else:
            print("dry run — no output rendered")
        return 0

    lead_path = Path(args.lead)
    if args.stems:
        if not args.json:
            print(f"separating lead stems into {args.stem_dir} ...")
        stems = separator.separate(args.lead, args.stem_dir, method=args.stem_method)
        if "vocals" in stems:
            lead_path = stems["vocals"]
        else:
            if not args.json:
                print("no vocals stem found; using full lead")

    spec = assembler.MashSpec(
        anchor_path=Path(args.anchor), lead_path=lead_path,
        lead_gain=args.lead_gain, anchor_gain=args.anchor_gain,
    )
    out = assembler.build_mash(spec, plan["tempo_ratio"], plan["semitone_shift"], args.output)
    plan["output_path"] = str(out)

    if args.json:
        print(json.dumps(plan, indent=2))
    else:
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
    m.add_argument("--lead-gain", type=float, default=0.8)
    m.add_argument("--anchor-gain", type=float, default=0.8)
    m.add_argument("--stems", action="store_true",
                   help="separate the lead's vocals and use them instead of the full mix")
    m.add_argument("--stem-dir", default="stems")
    m.add_argument("--stem-method", choices=["auto", "demucs", "ffmpeg"], default="auto")
    m.add_argument("--dry-run", action="store_true")
    m.add_argument("--json", action="store_true")
    m.set_defaults(func=cmd_mash)

    args = ap.parse_args(argv)
    try:
        return args.func(args)
    except UserError as exc:
        log(f"error: {exc}")
        return 1
    except FileNotFoundError as exc:
        log(f"error: file not found: {exc}")
        return 1
    except subprocess.CalledProcessError as exc:
        log(f"error: external command failed: {exc}")
        return 1
    except Exception as exc:
        log(f"unexpected error: {exc}")
        if args.json:
            print(json.dumps({"error": str(exc)}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
