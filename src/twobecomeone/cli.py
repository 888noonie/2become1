"""2become1 command-line interface."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from . import __version__
from . import analyzer, assembler, separator, sources
from .common import UserError, log


def _error_json(msg: str) -> dict:
    return {"error": msg}


def cmd_analyze(args) -> int:
    results = []
    errors = []
    for p in args.paths:
        try:
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
        except UserError as exc:
            errors.append({"path": str(p), "error": str(exc)})
            if not args.json:
                log(f"error analyzing {p}: {exc}")
    if args.json:
        if errors and not results:
            print(json.dumps({"errors": errors}, indent=2))
        else:
            print(json.dumps({"results": results, "errors": errors or None}, indent=2))
    return 0 if not errors else 1


def cmd_separate(args) -> int:
    # If method is explicit 'demucs', fail if Demucs is unavailable.
    if args.method == "demucs":
        try:
            import demucs.api  # noqa: F401
        except Exception:
            msg = "Demucs is not installed. Run: uv pip install -e '.[demucs]'"
            if args.json:
                print(json.dumps(_error_json(msg), indent=2))
            else:
                log(f"error: {msg}")
            return 1

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
            print(json.dumps({"error": f"no torrent results for '{args.query}' (index {args.index})"}))
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


def cmd_import(args) -> int:
    """Import a local path or YouTube URL into the managed Studio library."""
    from .studio import StudioService

    service = StudioService(args.data_dir)
    try:
        if sources.is_youtube_url(args.source):
            track = service.ingest_youtube(args.source)
        elif "://" in args.source:
            raise UserError("only local audio paths and YouTube URLs are supported")
        else:
            track = service.ingest_path(args.source)
    finally:
        service.close()

    if args.json:
        print(json.dumps(track, indent=2))
    else:
        print(f"imported '{track['name']}'")
        print(f"  ID   : {track['id']}")
        print(f"  BPM  : {track['bpm']:.1f}")
        print(f"  Key  : {track['key']['tonic']} {track['key']['mode']}")
        print(f"  Source: {track['source']['kind']}")
    return 0


def _require_allow_network(host: str, *, allow_network: bool) -> None:
    """Refuse a non-loopback bind unless ``--allow-network`` was passed.

    The Studio is unauthenticated; binding beyond loopback shares the library
    and jobs with anyone who can reach the port. Loopback binds are always
    permitted.
    """
    from .webapp import _is_loopback_host

    if not _is_loopback_host(host) and not allow_network:
        raise UserError(
            "binding to a non-loopback host exposes the unauthenticated Studio "
            "to your network. Re-run with --allow-network to accept this risk."
        )


def cmd_web(args) -> int:
    """Launch the local-first Studio web application."""
    try:
        import uvicorn
        from .webapp import create_app
    except ImportError as exc:
        raise UserError(
            "Studio dependencies are missing. Install them with: "
            "uv pip install --python .venv/bin/python -e '.[web]'"
        ) from exc

    _require_allow_network(args.host, allow_network=args.allow_network)
    app = create_app(args.data_dir, bind_host=args.host, trusted_hosts=args.trusted_host)
    print(f"2become1 Studio → http://{args.host}:{args.port}")
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")
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
        "anchor_start": args.anchor_start,
        "lead_start": args.lead_start,
        "duration": args.duration,
    }


def cmd_mash(args) -> int:
    try:
        anchor_a = analyzer.analyze(args.anchor)
        lead = analyzer.analyze(args.lead)
    except UserError as exc:
        if args.json:
            print(json.dumps(_error_json(str(exc)), indent=2))
        else:
            log(f"error: {exc}")
        return 1

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
        # If stem_method is explicit 'demucs', fail if Demucs is unavailable.
        if args.stem_method == "demucs":
            try:
                import demucs.api  # noqa: F401
            except Exception:
                msg = "Demucs is not installed. Run: uv pip install -e '.[demucs]'"
                if args.json:
                    print(json.dumps(_error_json(msg), indent=2))
                else:
                    log(f"error: {msg}")
                return 1

        if not args.json:
            print(f"separating lead stems into {args.stem_dir} ...")
        stems = separator.separate(args.lead, args.stem_dir, method=args.stem_method)
        if "vocals" in stems:
            lead_path = stems["vocals"]
        else:
            if args.json:
                plan["warning"] = "no vocals stem found; using full lead"
            else:
                print("no vocals stem found; using full lead")

    spec = assembler.MashSpec(
        anchor_path=Path(args.anchor), lead_path=lead_path,
        lead_gain=args.lead_gain, anchor_gain=args.anchor_gain,
        anchor_start=args.anchor_start,
        lead_start=args.lead_start,
        duration=args.duration,
    )
    try:
        out = assembler.build_mash(spec, plan["tempo_ratio"], plan["semitone_shift"], args.output)
    except UserError as exc:
        if args.json:
            print(json.dumps(_error_json(str(exc)), indent=2))
        else:
            log(f"error: {exc}")
        return 1

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

    i = sub.add_parser("import", help="add a local file or YouTube URL to the Studio library")
    i.add_argument("source", help="audio file path or youtube.com/youtu.be URL")
    i.add_argument("--data-dir", default=None,
                   help="media/project storage (default: ~/.local/share/2become1)")
    i.add_argument("--json", action="store_true")
    i.set_defaults(func=cmd_import)

    w = sub.add_parser("web", help="launch the local 2become1 Studio")
    w.add_argument("--host", default="127.0.0.1",
                   help=("bind address (default: local machine only; 0.0.0.0 exposes the "
                         "unauthenticated Studio to your network)"))
    w.add_argument("--trusted-host", action="append", default=[],
                   help="Additional exact host/IP allowed to access Studio; repeat as needed")
    w.add_argument("--allow-network", action="store_true",
                   help="permit binding to a non-loopback host (accepts the no-auth risk)")
    w.add_argument("--port", type=int, default=8765)
    w.add_argument("--data-dir", default=None,
                   help="media/project storage (default: ~/.local/share/2become1)")
    w.set_defaults(func=cmd_web)

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
    # Region options
    m.add_argument("--anchor-start", type=float, default=0.0,
                   help="Start offset in seconds for the anchor track")
    m.add_argument("--lead-start", type=float, default=0.0,
                   help="Start offset in seconds for the lead track")
    m.add_argument("--duration", type=float, default=None,
                   help="Render duration in seconds (default: until shorter region ends)")
    m.set_defaults(func=cmd_mash)

    args = ap.parse_args(argv)
    try:
        return args.func(args)
    except UserError as exc:
        if hasattr(args, 'json') and args.json:
            print(json.dumps(_error_json(str(exc)), indent=2))
        else:
            log(f"error: {exc}")
        return 1
    except FileNotFoundError as exc:
        if hasattr(args, 'json') and args.json:
            print(json.dumps(_error_json(f"file not found: {exc}"), indent=2))
        else:
            log(f"error: file not found: {exc}")
        return 1
    except Exception as exc:
        if hasattr(args, 'json') and args.json:
            print(json.dumps(_error_json(str(exc)), indent=2))
        else:
            log(f"unexpected error: {exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
