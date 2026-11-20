#!/usr/bin/env bash
# Repeat the live (fake-output, no device) measurement N times per set and
# summarise. Usage: live-repeat.sh N   -> ~/.local/state/clockwork-rescue/live-repeat.json
set -u
N=${1:-8}
OUT=~/.local/state/clockwork-rescue
cd "$(dirname "$0")/../../.."
: > "$OUT/live-repeat.jsonl"
for set in worst audition; do
  for i in $(seq 1 "$N"); do
    timeout 200 node tests/browser/clockwork-rescue/run.mjs --mode "live:$set" >/dev/null 2>&1
    python3 - "$OUT/live-$set-results.json" "$set" >> "$OUT/live-repeat.jsonl" <<'PY'
import json, sys
r = json.load(open(sys.argv[1])); m = r['measurements'].get('live', {})
print(json.dumps({'set': sys.argv[2], 'passed': all(c['passed'] for c in r['checks']) and not r['errors'],
  'phases': m.get('phases'), 'minLeadMs': (m.get('suppliedDspLeadMs') or {}).get('min'),
  'misses': m.get('deadlineMisses'), 'startDelaysMs': m.get('startDelaysMs'), 'catchUpMaxMs': m.get('clockCatchUpMaxMs'),
  'buildMaxMs': (m.get('buildMs') or {}).get('max'), 'wakeP99Ms': (m.get('wakeLatenessMs') or {}).get('p99'),
  'wakeMaxMs': (m.get('wakeLatenessMs') or {}).get('max'), 'streamsMax': r['measurements'].get('playbackStreamsSeen', {}).get('max'),
  'errors': r['errors'][:1]}))
PY
  done
done
python3 - "$OUT/live-repeat.jsonl" > "$OUT/live-repeat.json" <<'PY'
import json, sys
rows = [json.loads(l) for l in open(sys.argv[1])]
out = {}
for s in sorted({r['set'] for r in rows}):
  rs = [r for r in rows if r['set'] == s]
  vals = lambda k: [r[k] for r in rs if r[k] is not None]
  out[s] = {'runs': len(rs), 'passed': sum(r['passed'] for r in rs), 'deadlineMissRuns': sum(1 for r in rs if r['misses']),
    'startDelayedRuns': sum(1 for r in rs if r['startDelaysMs']), 'minLeadMs': min(vals('minLeadMs'), default=None),
    'catchUpMaxMs': max(vals('catchUpMaxMs'), default=None), 'buildMaxMs': max(vals('buildMaxMs'), default=None),
    'wakeP99MaxMs': max(vals('wakeP99Ms'), default=None), 'wakeMaxMs': max(vals('wakeMaxMs'), default=None),
    'playbackStreamsMax': max(vals('streamsMax'), default=None)}
print(json.dumps(out, indent=2))
PY
cat "$OUT/live-repeat.json"
