"""2become1 command-line interface."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from . import analyzer, assembler, sources


def cmd_analyze(args) -> None:
    for p in args.paths:
        print(f"--- {p}")
        r = analyzer.analyze(p)
        print(f"  BPM  : {r.bpm}")
        print(f"  Key  : {r.key['tonic']} {r.key['mode']} (conf {r.key['confidence']})")
        print(f"  Dur  : {r.duration:.1f}s")
        if args.json:
            print(json.dumps({"path": str(p), "bpm": r.bpm, "key": r.key},
                             indent=2))


def cmd_torrent(args) -> int:
    hits = sources.search_torrents(args.query, index=args.index)
    if not hits:
        print(f"no torrent results for '{args.query}' (index {args.index})")
        return 1
    for i, h in enumerate(hits):
        print(f"[{i}] {h.title}  ({h.source})")
        if args.magnet:
            print(f"    magnet: {h.magnet}")
    return 0


def cmd_mash(args) -> int:
    anchor_a = analyzer.analyze(args.anchor)
    lead = analyzer.analyze(args.lead)
    print(f"anchor '{args.anchor}': {anchor_a.bpm} BPM, "
          f"{anchor_a.key['tonic']} {anchor_a.key['mode']}")
    print(f"lead   '{args.lead}': {lead.bpm} BPM, "
          f"{lead.key['tonic']} {lead.key['mode']}")

    tempo_ratio = anchor_a.bpm / lead.bpm
    shift = assembler.semitones_to_match(anchor_a.key['tonic'] + " " + anchor_a.key['mode'],
                                         lead.key['tonic'] + " " + lead.key['mode'])
    print(f"tempo ratio: {tempo_ratio:.3f}  key shift: {shift} st "
          f"(lead -> anchor)")

    spec = assembler.MashSpec(anchor_path=Path(args.anchor), lead_path=Path(args.lead),
                              lead_gain=args.lead_gain, anchor_gain=args.anchor_gain)
    out = assembler.build_mash(spec, tempo_ratio, shift, args.output)
    print(f"wrote {out}")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="2become1",
                                 description="General-purpose mashup stack")
    sub = ap.add_subparsers(dest="cmd", required=True)

    a = sub.add_parser("analyze", help="detect BPM + key of track(s)")
    a.add_argument("paths", nargs="+")
    a.add_argument("--json", action="store_true")
    a.set_defaults(func=cmd_analyze)

    t = sub.add_parser("torrent", help="search a torrent index for magnets")
    t.add_argument("query")
    t.add_argument("--index", type=int, default=0)
    t.add_argument("--magnet", action="store_true")
    t.set_defaults(func=cmd_torrent)

    m = sub.add_parser("mash", help="align a lead track to an anchor and mix")
    m.add_argument("anchor", help="track providing tempo + key")
    m.add_argument("lead", help="track aligned to the anchor (vocals/lead)")
    m.add_argument("-o", "--output", default="mashup.mp3")
    m.add_argument("--lead-gain", type=float, default=1.0)
    m.add_argument("--anchor-gain", type=float, default=1.0)
    m.set_defaults(func=cmd_mash)

    args = ap.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
