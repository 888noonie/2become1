# Static growth evidence

## What changed

The retired static-asset byte ceiling is replaced with measured evidence.

- Added `tests/frontend/static-size.test.js`, a `node:test` recorder that uses
  only built-ins (`node:fs`, `node:path`). Every path is resolved from
  `import.meta.dirname`, never from `process.cwd()`.
- Added `tests/frontend/static-size-baseline.json` with the measured total for
  this checkout.
- The recorder walks `src/twobecomeone/studio_static`, sums regular-file bytes,
  counts files, and prints the total, file count, delta, percentage growth, and
  five largest files.
- It fails only when growth exceeds **either** 15 percent **or** 50,000 bytes
  over the baseline.

Nothing under `src/twobecomeone/studio_static` was modified, minified, or
deleted.

## Command and result

Command:

```bash
node --test tests/frontend/static-size.test.js
```

Quoted output on this checkout:

```text
Static asset size report
  Root:            src/twobecomeone/studio_static
  Total bytes:     650905
  Files:           67
  Baseline bytes:  650905
  Baseline files:  67
  Delta bytes:     0
  Growth:          0.00%
  Limit:           > 15% or > 50000 bytes fails
  Five largest files:
    1.    55945 bytes  js/runtime/ghost-controller.js
    2.    39556 bytes  js/runtime/live-mixer.js
    3.    29316 bytes  styles/studio.css
    4.    27543 bytes  js/components/plan.js
    5.    22250 bytes  js/components/deck.js
✔ static asset growth stays within the measured budget (6.493176ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 53.276354
```

## Measurement

- **Measured total:** 650,905 bytes across 67 regular files.
- **Baseline:** 650,905 bytes across 67 files.
- **Delta:** 0 bytes (0.00 percent growth).
- **Result:** pass. The budget fails only above 15 percent or above 50,000
  bytes of growth, so this checkout is within budget with considerable room.

The five largest files account for 174,610 bytes: `ghost-controller.js`
(55,945), `live-mixer.js` (39,556), `studio.css` (29,316), `plan.js` (27,543),
and `deck.js` (22,250).

## Limitation

This recorder measures raw on-disk bytes only. It does not measure transfer
size after gzip or brotli compression, parse/execute cost, or per-request
overlap, so a byte-neutral refactor can still change runtime cost. It is a
growth tripwire, not a performance benchmark.
