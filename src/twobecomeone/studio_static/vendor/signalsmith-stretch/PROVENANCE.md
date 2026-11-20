# Signalsmith Stretch — dependency provenance

Pinned for OPERATION THE LIVING DAYLIGHTS (Milestone B), 2026-11-20.

| Fact | Value |
| --- | --- |
| Library | Signalsmith Stretch (Web Audio WASM/AudioWorklet release) |
| Upstream | https://github.com/Signalsmith-Audio/signalsmith-stretch |
| Tag | `1.4.0` |
| Commit | `a670068d9aeb64913331d5cc29337b19a457a7df` |
| Source archive sha256 | `077235709ecf2a358545e3ca7bdf32859f70f5c9afb4493e078bd753c9aff284` (tag tarball) |
| Vendored file | `SignalsmithStretch.mjs` sha256 `97530b11d5bc01015af4cde40d6aa55ff10c40aa1294ca4c8c5762027d517a46` |
| Licence | MIT — Geraint Luff / Signalsmith Audio Ltd, see `LICENSE.txt` (notice preserved verbatim) |
| Upstream docs | `UPSTREAM-README.md` (the web release README as shipped) |

Note: the release bundle's `package.json` reports `version: 1.3.2` although it is
shipped inside tag `1.4.0`. Provenance is pinned by tag + commit + archive
sha256 + file sha256, not by that internal version string.

Only the ES module build is vendored (the UMD `SignalsmithStretch.js` is not
used). The WASM payload is embedded in the module — there is no separate
`.wasm` file to fetch.
