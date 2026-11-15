# Producer architecture review — smallest additive path from today's main

- **Status:** Architectural review and recommendation. Authorizes nothing.
- **Reviewed checkpoint:** `main` at `e39898f` (Phase 15A LiveMixer leaf merged;
  six-file wiring blocked on the static budget).
- **Method:** read `README.md`, `CODEX.md`, `CURSOR_HANDOVER.md`,
  `docs/V1_GHOST_ARCHITECTURE.md`, the Phase 14/15 plans, `actions.py`,
  `action_store.py`, `proposal_lifecycle.py`, `ghost_assets.py`,
  `migrations.py`, the `js/actions/*`, `js/runtime/*`, `js/transport/*`
  modules, `api.js`, `state.js`, the contract vectors and CI workflow.
  Verified the current Hermes Agent extension model against its published
  documentation rather than assuming it.
- **Governing constraint:** the existing phase plan (13 open, 14B → 15A wiring →
  15B → 14C/15C) is authoritative. Everything below is additive to it.

---

## 1. Current-state audit — what exists and must be preserved

The repository is further along than the product direction implies. Most of the
"AI Producer" foundation already exists as a *human* system. That is the single
most important finding: the Producer is not a new subsystem, it is a new
**actor** on an existing boundary.

### 1.1 The Action boundary is real, strict, and cross-language

- Frozen V1 envelope `{ id, schemaVersion: 1, type, actor{type,id}, requestedAt,
  idempotencyKey, payload }` with four types: `preview_layer`, `commit_layer`,
  `reject_proposal`, `revert_commit`.
- Twin validators: `actions.py::validate_action` and
  `js/actions/contracts.js::validateAction`, both allow-list every key, reject
  bool-as-number, non-finite numbers and non-serializable values, and share one
  error vocabulary (`V_*`, `P_*`, `L_*`, `I_*`, `T_*`, `X_*`) proven by
  `tests/fixtures/action_contract_vectors.json`.
- `actor.type ∈ {human, producer}` is **already in the contract**. Producer is a
  first-class actor type today; it is simply denied.
- Permission is constitutional and mirrored: `permission.js` (client) and
  `action_store._apply_to_projection` (server). Producer may never commit,
  reject or revert. Producer preview is gated by `producerPreviewAllowed`
  (client) and hard-coded to `P_PRODUCER_PREVIEW_DENIED` (server).
- Idempotency is durable: unique `(project, actor_type, actor_id,
  idempotency_key)`; a replay returns the stored outcome; a key reused with a
  different payload is `I_KEY_REUSED_WITH_DIFFERENT_REQUEST`.

**Preserve:** the envelope, the allow-list discipline, the twin validators, the
vector file, the permission table, durable idempotency. Do not add keys to
schemaVersion 1. New operations become new versioned types (Phase 14C already
set this precedent with `preview_stem_stack`).

### 1.2 Ledger + projection + lifecycle facts are the right durable model

- `actions` is append-only; `action_projection` is a rebuildable snapshot;
  both are written in one SQLite transaction. `rebuild_projection` replays
  without filesystem or subprocess side effects.
- `proposal_lifecycle_facts` separates *runtime* truth (`scheduled`,
  `auditioning`) from *musical* Actions, with one-fact-per-state uniqueness and
  a strict receipt echo (`assetId`, `contentHash`, `launchBeat`,
  `launchAudioTime`, `gridRevision`, ≤512 bytes).
- Commit is gated by the durable auditioning fact and verifies asset identity,
  content hash and destination grid revision (`S_ASSET_MISMATCH`). "Commit
  exactly what was heard" is enforced, not aspirational.
- Expensive preparation (ffmpeg) happens *before* the short write transaction;
  a failed or racing append discards unpublished bytes.

**Preserve:** all of it. The Producer needs nothing new here except a
permission source and a provenance link.

### 1.3 The audio engine already has the properties the Producer needs

- Scheduling is on `AudioContext.currentTime`, never on wall clock or network.
  `resolveNextPhrase` is pure; `GhostScheduler` enforces a 250 ms minimum lead
  and **re-resolves the following phrase rather than starting late**. That is
  exactly the "late material misses its window and is reconsidered" semantic
  the product direction asks for. It exists.
- `CommittedLayerEngine` uses look-ahead chained timers, re-resolves against the
  live clock every wake, suspends on transport change, and refuses ambiguous
  multi-layer projections instead of guessing.
- `LiveMixer` (15A leaf) gives one shared context, two deck buses, generation
  tokens on every async boundary, and a frozen serializable snapshot.
- Nothing runtime ever enters `StateStore`; the store is serializable and
  deep-cloned.

**Preserve:** clock ownership in the browser runtime, the min-lead/re-resolve
rule, the "engine returns facts, never repairs intent" posture, and the
runtime/state separation.

### 1.4 Server-side deterministic preparation is the Tier 0 the hierarchy needs

`ghost_assets.py` resolves everything by opaque ID from the database, refuses to
guess when grid/BPM facts are missing (`S_GRID_MISSING`), bounds region span and
tempo ratio, records a reproducible `transformSpec`, and hashes the output. The
render path (`_resolve_committed_layer`) re-verifies the receipt against the
transform. This is the deterministic executor the Producer will parameterize.

### 1.5 Existing guardrails that indirectly protect the Producer work

- Loopback-only by default; mutation-origin checks; no absolute paths in
  payloads; strict opaque IDs (`ga-<32hex>`, `sha256:<64hex>`,
  `grid-v1:<64hex>`).
- One GPU/audio job at a time; 32-job admission ceiling; per-stage deadlines.
- Jobs already have a persistent state machine, cancellation, retry, restart
  recovery and per-job SSE. A Producer request can be a job kind and inherit
  all of this.
- Framework-free ESM frontend under a 500,000-byte ceiling (currently
  499,988 bytes).

### 1.6 Evidence discipline worth keeping

Receipts prove scheduling intent, not audible output (Phase 13 classes A/B/C).
Every Producer claim later ("the drop landed on the phrase") must inherit this:
the Producer's explanation is generated from recorded provenance, never from
the model's narration.

---

## 2. Architectural gaps — only the delta to the Producer vision

| # | Gap | Evidence in main | Severity |
|---|---|---|---|
| G1 | Producer permission is a hard-coded deny on the server and an in-memory boolean on the client. There is no durable, human-created, expiring **grant** object. | `action_store._apply_to_projection` raises `P_PRODUCER_PREVIEW_DENIED` unconditionally; `permission.js` reads `context.producerPreviewAllowed`. | Blocking for any Producer slice |
| G2 | No provenance link from a proposal to the *request* that produced it (model, provider, tier, digest revision, prompt hash, token usage). | `actions` rows carry only `actor{type,id}`. | Blocking — explanations and cost accounting need it |
| G3 | Audition assumes the proposal author is the auditioner. | `GhostScheduler.schedule` returns `NOT_HUMAN` if `proposal.actor.type !== 'human'`; `GhostController.invoke` authors *and* schedules in one gesture. | Blocking — a human must be able to audition a producer-authored `ready` proposal |
| G4 | No `expired` lifecycle state; a `ready` proposal lives until a human rejects it. | `actions.TRANSITIONS` / `lifecycle.js` have no `expired`; the architecture doc mentions it. | Needed once Producer creates proposals nobody arms |
| G5 | No compact, versioned, model-facing session summary; the only read is the full projection plus per-track API calls. | `/action-state`, `/tracks/{id}`, `/renders/plan`. | Blocking for context economics |
| G6 | No model-provider port, no budget/cache/escalation policy code. | Nothing under `src/twobecomeone/` touches an LLM. | Blocking, but small |
| G7 | No candidate retrieval over the library (BPM/key/role/tag filtering). Compatibility math exists only in the Phase 14A prototype and the render planner. | `design/stem_crate_fun_mock.html`; `_compute_arrangement`. | Needed for Tier 1; Phase 14B.2 already plans the deterministic compatibility output |
| G8 | One committed layer, one active Ghost. "Several prepared objects coexisting" is a deliberate policy limit. | `L_LAYER_LIMIT`; `GhostController` one-active rule. | Not a Producer gap — a Phase 15C+ engine decision. Producer must not be the reason to relax it |
| G9 | No push channel for action-state changes; the browser learns about foreign proposals only by hydration. | Only `/api/jobs/{id}/events` is SSE. | Solved for free if Producer requests are jobs |
| G10 | No library-level reusable region/phrase entity, no tags, no generated/derived asset provenance. | Phase 14B defines `stem_crate_items`; nothing for tags/generated assets. | Phase 14B covers the first half; the rest is LATER |
| G11 | Continuous controls (gain/pan/EQ/crossfader) are LWW project settings or (15B) live AudioParams, not Actions. | `projects.settings_json`; Phase 15B crossfader. | Not a gap to close by making knob turns Actions (see §4.3) |
| G12 | Static budget has 12 bytes of headroom. Any Producer UI is blocked before it starts. | `PHASE_15A_DELETION_INVENTORY.md`. | Blocking for 16B; needs a decision, not code |
| G13 | GPU is a single shared 6 GB device used by Demucs under a one-job policy. A local LLM on the same GPU is a contention and OOM risk. | `CODEX.md` invariants; `AUDIT.md` hardware note. | Design constraint on Tier 2 |

Everything else in the product direction (voice, generation, autopilot,
branching, delegated autonomy) is downstream of G1–G6 and is deliberately
**not** a gap in current main.

---

## 3. Producer host decision matrix

### 3.1 What was verified about Hermes Agent (so nothing is invented)

- Skills are `SKILL.md` files with YAML frontmatter (`name`, `description`,
  optional `version`, `platforms`, `metadata.hermes.{tags, category,
  requires_toolsets, fallback_for_toolsets, config}`), stored under
  `~/.hermes/skills/`, loaded with progressive disclosure. They are
  **procedural text**, not executable schemas.
- Native tools are self-registering Python modules in Hermes's own `tools/*.py`
  (via `registry.register()`) or plugins. Writing one couples 2become1 to the
  Hermes codebase.
- Hermes is a full MCP **client** (stdio and HTTP servers under `mcp_servers`
  in `config.yaml`, per-server tool filtering, sampling, elicitation routed to
  its approval surface).
- Hermes as an MCP **server** (`hermes mcp serve`) exposes only messaging/
  channel tools. It is not a general "ask Hermes to plan" API.
- Providers: Nous Portal, OpenRouter, Ollama Cloud (`ollama-cloud`), custom
  OpenAI-compatible endpoints (local Ollama, vLLM), a `fallback_providers`
  chain and a cheaper `auxiliary.compression` model.
- Default Hermes toolsets include terminal and file access on the host.

Consequence: if Hermes were the Producer *runtime*, the correct split would be
**SKILL.md = procedure** ("read the digest, choose among candidates, call
`propose_preview_layer`, never attempt commit, on validation failure re-read
the digest once then stop"), **MCP = 2become1's deterministic tools**
(`get_session_digest`, `search_library`, `propose_preview_layer`,
`get_proposal_status`, `explain_proposal`), **native Hermes Tool = none**, and
**2become1 local API = the only authority**. Commit/reject/revert would be
*absent* from the MCP surface, not merely denied.

### 3.2 Matrix

Ratings: ++ strong, + adequate, 0 neutral, − weak, −− disqualifying for the core.

| Criterion | A. Direct providers behind adapter | B. Ollama local + Ollama Cloud | C. Hermes Agent + Skill + MCP | D. Hybrid (Hermes orchestrates, 2become1 owns state) | E. Recommended (below) |
|---|---|---|---|---|---|
| Latency isolation from audio | ++ (in-process, async job) | ++ | + (extra process, but still only a client of the Action API) | + | ++ |
| Token/API cost | + (per-token, sparse) | + (subscription cloud; free local) | − (agent loop burns tokens on tool chatter, memory, skills) | − | ++ (tiers + budget) |
| Local/offline fallback | 0 (must be built) | ++ (native) | − (Hermes offline works only with local provider; whole harness must be up) | − | ++ |
| Tool-calling reliability | + (structured outputs, one schema, we validate) | + (same wire; small models weaker) | 0 (harness retries but adds nondeterminism) | 0 | ++ (schema-first + compile step + validate_action) |
| Context management | ++ (we build the digest) | ++ | − (Hermes context/memory/compression are outside our control; digest gets wrapped in agent scaffolding) | − | ++ |
| Security / "no secret door" | ++ | ++ | −− (host terminal/file tools next to the SQLite truth unless the *user* filters toolsets; 2become1 cannot enforce) | − (same, mitigated only by user config) | ++ |
| Model/provider portability | ++ | 0 (Ollama catalogue only for cloud; no Claude/GPT-class on Ollama Cloud) | + (Hermes provider list) | + | ++ (OpenAI-compatible wire covers Ollama, OpenRouter, vLLM, direct) |
| Voice integration | 0 (separate STT port) | 0 | + (gateway voice notes) but in Hermes's chat, not the instrument | + | 0 (deliberately postponed) |
| Persistent preferences/memory | 0 (we store in SQLite) | 0 | + (Hermes memory) but opaque and not provenance-linked | 0 | + (explicit, inspectable, ledger-linked) |
| Testing | ++ (scripted provider in CI) | ++ | −− (second runtime, nondeterministic loop, no CI story) | − | ++ |
| Failure recovery | + | + | − (harness failures are ours to diagnose) | − | ++ (job state machine) |
| Implementation complexity | + | + | − (config, profiles, MCP server, approval UX split) | − | + |
| Preserves phase plan | ++ | ++ | 0 (adds an external dependency the plan never contemplated) | 0 | ++ |

### 3.3 Recommendation: **E — one in-process `ProducerCoordinator` with a wire-level `ModelProvider` port; Ollama-local as default Tier 2; any OpenAI-compatible endpoint as Tier 3; Hermes as an optional external MCP client (LAB), never the Producer runtime.**

Why this and not the others:

- A and B are not really different architectures. Ollama local, Ollama Cloud,
  OpenRouter, vLLM, LM Studio and OpenAI all speak the OpenAI chat-completions
  wire with JSON-schema structured output. One thin client (stdlib `urllib` or
  the already-present `httpx`) covers all of them with zero new runtime
  dependency. B's only unique asset — identical API locally and in the cloud —
  is obtained anyway. B's cost is real: Ollama Cloud does not host the
  frontier-class models Tier 3 exists for.
- C fails the project's own constitutional test. A Hermes profile with default
  toolsets is a secret execution path by construction (terminal + file access
  on the machine that holds `~/.local/share/2become1`). 2become1 can only
  *ask* the user to filter toolsets; it cannot enforce it. Additionally the
  conversation would live in Hermes's CLI/gateway, not in the instrument, and
  the audio clock lives in the browser, so "audition now" can never be a
  Hermes tool call anyway. Hermes is excellent as the *coding* agent this
  project already uses; that is a different role.
- D inherits C's security posture and testing story while adding a process
  boundary. It becomes attractive only if 2become1 already has the MCP server
  and digest from E — at which point D is a config file, not an architecture.
- E keeps the whole Producer testable in CI with a `ScriptedProvider` that
  never touches a network or a model, which matches how this repository has
  earned every acceptance so far.

Explicit pushback on the framing: "Hermes Skill" is not a hosting decision, it
is documentation for an agent that happens to be a client. Do not let the
choice of coding agent leak into the product runtime.

---

## 4. Target boundaries

### 4.1 Component map (additive; existing components unchanged in role)

```text
                     ┌────────────────────────────────────────────────────────┐
  UI (views/components)  ──dispatch──▶ StateStore (serializable) ◀──semantic facts── Runtime controllers
        │                                                          (GhostController, CommittedLayerEngine,
        │ human gesture                                             LiveMixer, GhostScheduler; own the clock)
        ▼                                                                      ▲
  api.js ──POST /actions──▶ StudioService.record_project_action ──▶ ActionStore (ledger+projection) │
        │                          ▲                                    │ prepared assets (Tier 0)      │
        │                          │ same call, actor=producer          ▼                               │
        │                   ProducerCoordinator ──▶ GhostAssetStore / (14C) StackPreparer               │
        │                     │      ▲                                                                  │
        │ POST /producer/requests    │ SessionDigest (read-only)                                        │
        └──────────────▶ Job(kind=producer_request) ─SSE─▶ browser learns of new `ready` proposals ─────┘
                              │
                     ModelProvider port ──▶ Tier 2 local (Ollama) | Tier 3 remote (OpenAI-compatible)
                     GenerationProvider port (SCAFFOLD) ──▶ Job(kind=generate) ──▶ library asset
                     PersistentLibrary (tracks, stem_sets, 14B crate items, tags, provenance)
```

The Producer never talks to the audio engine, the filesystem, or the database.
It talks to `StudioService.record_project_action` with `actor.type =
"producer"`, exactly as `api.js` does for humans.

### 4.2 Interfaces (exact enough to test, small enough to keep)

**UI → StateStore.** Unchanged. One additive slice:

```js
producer: {
  grants: [{ id, scope: 'preview_layer', expiresAt, maxPending }],
  inbox: [{ proposalId, summary, proposedBy, requestId, createdAt }], // derived from proposals where actor.type==='producer' && lifecycle==='ready'
  request: { status: 'idle'|'running'|'failed'|'done', jobId, error, tier, tokens },
}
```

**Runtime controllers → StateStore.** Unchanged (semantic facts only). One
additive controller method, human-gesture only:

```js
GhostController.auditionExisting(proposalId)  // schedules a `ready` proposal (any author) via the existing scheduler path
```

**api.js → server.** Three additive helpers, same envelope conventions:

```js
postProducerGrant(projectId, { scope, ttlSeconds, maxPending })   // human Action-like grant
revokeProducerGrant(projectId, grantId)
postProducerRequest(projectId, { text, directive?, basedOnDigestRevision? }) // → { jobId }
```

**Server: ActionStore permission source.** Replace the hard-coded deny with an
injected `permission_context(project_id, conn) -> {producerPreviewAllowed,
maxPending}` derived from durable grants. The permission *table* does not
change; only its input does.

**Server: ProducerCoordinator (Python, pure where possible).**

```python
class ModelProvider(Protocol):
    id: str                      # e.g. "ollama-local/qwen2.5:7b", "openrouter/anthropic/claude-…"
    tier: int                    # 2 or 3
    def complete_structured(self, *, system: str, user: str, schema: dict,
                            max_output_tokens: int, timeout_s: float,
                            cancel: CancellationToken) -> StructuredResult: ...
    # StructuredResult = {json: dict, usage: {input, output}, latency_ms, raw_hash}

class ProducerCoordinator:
    def build_digest(project_id, request) -> SessionDigest          # §5.1, pure over service reads
    def interpret(request, digest) -> Intent | Escalate               # Tier 1 deterministic grammar
    def plan(intent, digest, provider) -> ProposalDraft               # Tier 2/3 call, budgeted, cached
    def compile(draft, digest) -> list[Action]                        # handles→ids, ids/keys/actor/time
    def submit(project_id, actions) -> list[Outcome]                  # StudioService.record_project_action
```

**Server: GenerationProvider (SCAFFOLD only).** See §8.

**Persistent library.** Existing `tracks`, `stem_sets`, `ghost_assets`; Phase
14B `stem_crate_items`; LATER `tags`, `item_tags`, `asset_provenance`.

### 4.3 Musical Actions versus control changes (a boundary the vision needs)

Do **not** make every gain/pan/EQ/crossfader move a ledger Action. The ledger is
append-only and provenance-bearing; a fader gesture at 60 Hz would destroy its
readability and its idempotency semantics. Keep two vocabularies:

- **Musical Actions** (discrete, quantized, provenance-worthy, undoable): the
  existing four, Phase 14C's stack pair, and later `set_mix_control`
  (declarative target + ramp + launch quantization), `schedule_transition`.
  Producer may only speak this vocabulary.
- **Control changes** (continuous, latest-value, coalesced): live bus gains,
  crossfader, EQ knobs. Owned by `LiveMixer` control state (15B), snapshotted
  into project settings by LWW autosave as today. Producer never touches
  these directly; when it wants a filter sweep it emits `set_mix_control` with
  `launch: next_phrase`, and the deterministic engine turns it into
  `AudioParam` ramps on the audio clock.

This keeps "same typed Action boundary for human, MIDI, automation, AI" true
for musical operations without pretending a jog wheel is an Action.

---

## 5. Context and cost architecture

### 5.1 SessionDigest (versioned, bounded, no media)

```jsonc
{
  "schemaVersion": 1,
  "digestRevision": "dg-3f9c…",           // sha256 over basis fields, 16 hex
  "basis": {
    "projectId": "p-…", "lastSequence": 42,
    "gridRevisions": { "A": "grid-v1:…", "B": "grid-v1:…" },
    "libraryRevision": 17,                 // monotonic counter bumped by import/separate/crate edits
    "generatedAt": "2026-09-12T12:00:00Z"
  },
  "directive": { "text": "124 BPM melodic/deep, start restrained, build slowly", "setAt": "…" } , // or null
  "transport": { "masterDeck": "B", "outputBpm": 124, "phraseBars": 8,
                 "phraseIndex": 5, "secondsToNextPhrase": 11.2, "minLeadSeconds": 0.25 },
  "decks": {
    "A": { "handle": "t1", "title": "…", "bpm": 122.0, "key": "Am", "confidence": 0.82,
           "durationSeconds": 312, "cueSeconds": 32.4, "variant": "full",
           "stemsAvailable": ["vocals","drums","bass","other"], "playing": true },
    "B": { "…": "…" }
  },
  "layers": { "committed": [ { "handle": "L1", "kind": "vocal_ghost",
                               "source": "t1 vocals bars 33–49", "gainDb": -3, "live": true } ],
              "limit": 1 },
  "proposals": {
    "active": [ { "id": "a-…", "type": "preview_layer", "lifecycle": "ready",
                  "proposedBy": "producer", "summary": "…" } ],
    "recentOutcomes": [ { "id": "a-…", "outcome": "rejected", "by": "human", "reason": "too loud" } ]
  },
  "capabilities": {
    "actions": [ { "type": "preview_layer",
                   "constraints": { "stem": ["vocal"], "regionBeats": [1, 64],
                                    "gainDb": [-24, 12], "launch": ["next_phrase"] } } ],
    "grants": [ { "scope": "preview_layer", "expiresAt": "…", "maxPending": 2, "pending": 1 } ]
  },
  "candidates": [
    { "handle": "c7", "kind": "stem_region", "track": "t9", "stem": "vocals", "bars": 8,
      "bpm": 124, "key": "Am", "compat": { "bpmDelta": 0, "keyRelation": "same",
      "explain": "124→124 BPM; 0 st; source inherited" }, "tags": ["favourite","hook"],
      "lastUsedAt": "…" }
  ],
  "history": [ "seq 40 human commit_layer L1", "seq 41 producer preview_layer → rejected" ]
}
```

Rules:

- **Never** includes audio, waveform arrays, file paths, URLs, content hashes
  (other than revision identifiers), the full library, or the full ledger.
- Every referenced object is a short **handle** minted per digest
  (`t1`, `c7`, `L1`). The model can only name things the digest named.
  Handles are resolved back to real IDs by the compiler; an unknown handle is a
  validation failure, not a lookup.
- `capabilities` is generated from the *actual* permission table, grants and
  validator bounds, so the model is told what is possible right now and
  hallucinated operations are rejected before `validate_action` ever runs.
- Size target: ≤ 1,200 tokens core + ≤ 90 tokens per candidate, K ≤ 12.
  Typical call ≈ 2.5k input tokens.

### 5.2 ProposalDraft (what the model returns)

```jsonc
{
  "basedOnDigestRevision": "dg-3f9c…",
  "proposals": [
    { "type": "preview_layer", "candidate": "c7", "destinationDeck": "B",
      "gainDb": -3, "launch": "next_phrase", "rationale": "≤200 chars" }
  ],
  "questions": [],            // clarifications for the human, if any
  "declined": null            // or a short reason when nothing sensible fits
}
```

The compiler turns each draft item into a full V1 Action: `id = "pr-" +
sha256(requestId, index)[:32]`, `idempotencyKey` derived the same way (so a
retried request cannot duplicate proposals), `actor = { type: "producer",
id: "producer:<providerId>" }`, `requestedAt` = server time, `payload` from
handle resolution. Then `validate_action`, then permission, then append (which
prepares the asset). The `rationale` is stored on the request row, never in
the Action — explanations are rendered from provenance plus rationale, and the
UI labels the rationale as the model's claim.

### 5.3 Intelligence hierarchy (challenged and revised)

The proposed four tiers are right in shape and wrong in one placement: a
"cheap local model for routine interpretation" is the wrong Tier 1. Routine
instructions are exactly where you want zero latency and zero nondeterminism,
and a 7B model on the laptop GPU that Demucs already saturates is neither
cheap nor reliable. Revised:

| Tier | What runs | Input | Cache | Escalates when |
|---|---|---|---|---|
| **0 — deterministic engine** | `validate_action`, permission, `GhostAssetStore` preparation, `resolveNextPhrase`, `CommittedLayerEngine`, `LiveMixer`, render planner. | Validated Actions only. | Prepared assets by `transformSpec` hash (exists: stem cache, ghost assets). | Never. Failures are stable codes. |
| **1 — deterministic interpretation + retrieval** | A small intent grammar ("preview chorus 2 vocal on B", "louder", "release", "loop 4 bars", "next"), candidate retrieval (BPM window incl. 1:2 ratios, Camelot relation, role, stem availability, tags, recency), compatibility explanation (Phase 14B.2 output), **user macros** (previously accepted Tier 2/3 results promoted to grammar entries). | Raw text + digest basis. No model. | Intent cache keyed by `normalize(text) + digestRevision-coarse`. | Grammar miss, ambiguous referent, or request names > 1 step. |
| **2 — local model** | Ollama-local (or any local OpenAI-compatible server), CPU-first or scheduled through the existing single-GPU executor to avoid Demucs contention. NL → `ProposalDraft` for single-step requests; ranking among ≤12 candidates. | Digest with candidates; strict JSON schema. | Draft cache keyed by `(intent, digestRevision)`; prompt prefix (system + capabilities) constant across calls. | Schema failure after one retry; request tagged multi-step/creative; explicit user "ask the big one". |
| **3 — remote/frontier** | Any OpenAI-compatible endpoint (OpenRouter → Claude/GPT-class, direct provider, Ollama Cloud for open frontier). Set-level planning under a directive, ambiguous creative asks, multi-proposal sequences, generation briefs. | Digest + directive + last N outcomes; same schema, larger K. | Plan cache keyed by `(directive hash, coarse digest)` with TTL; results demoted into Tier 1 macros when the human accepts them twice. | Never higher. Budget exhaustion demotes to Tier 2 and says so. |

Escalation is decided by **deterministic code** (grammar miss, validator
failure, plan complexity flag, budget), never by a model asking for a bigger
model.

**Repeated instructions get cheaper by promotion, not by caching alone:** an
accepted Tier 2/3 draft plus its normalized instruction becomes a visible,
editable macro in Tier 1. The third time the user says "bring the diva hook
in at the next phrase" no model runs.

**If every cloud provider disappears:** Tier 0 and 1 are unaffected (all
existing human functionality plus grammar/macros/retrieval). Tier 2 continues
if a local model is installed. Tier 3 requests fail fast with a stable code
(`PR_PROVIDER_UNAVAILABLE`), the UI offers Tier 2 or manual, and nothing in
playback changes. This falls out of the job model: a Producer request is a job
that failed, not a session that broke.

### 5.4 Token-budget policy

- Per call: Tier 2 ≤ 4k in / 1k out; Tier 3 ≤ 8k in / 2k out. Enforced by
  trimming in fixed order (history → candidates beyond 6 → recentOutcomes)
  before refusing.
- Per session: configurable ceiling (default e.g. 150k Tier 3 tokens); per
  day: currency ceiling from provider-reported usage. Both visible in the UI
  next to the grant.
- Exactly one in-flight Producer call per project; new requests supersede a
  queued one (same rule as the existing serialized Retry).

### 5.5 Event-driven, never periodic

Producer calls are triggered only by: a human request; a proposal outcome
(accept/reject feedback under an active directive); a generation job arriving;
or, under an active directive and a live grant, the horizon rule "fewer than
`maxPending` producer proposals exist and the next decision phrase is within
2 phrases". Never per beat, never on a timer without a directive. Debounced to
one call per phrase at most.

### 5.6 Invalidation and versioning

- `digestRevision` = hash of `(lastSequence, gridRevisions A/B, deck
  assignments, libraryRevision)`. Drafts carry `basedOnDigestRevision`.
- The compiler rejects a draft whose revision no longer matches **for the
  fields it touches**: a changed grid revision on the destination deck or a
  vanished candidate handle is `PR_STALE_CONTEXT` (mirrors the existing
  `GHOST_GRID_STALE` / `S_ASSET_MISMATCH` posture). A library change that does
  not affect referenced handles is tolerated.
- Digest `schemaVersion` and ProposalDraft `schemaVersion` are versioned
  independently of the Action `schemaVersion`; contract vectors cover both.

---

## 6. Failure modes

| Failure | Behaviour | Where it lands |
|---|---|---|
| Offline / no provider | Tier 1 keeps working; Tier 2 if local; the request job fails with `PR_PROVIDER_UNAVAILABLE`; playback untouched. | Job state machine, `producer.request.error` |
| Provider timeout | Job timeout (existing per-stage deadline pattern); partial output discarded; no proposal appended. | `jobs.py` deadlines |
| Malformed tool call / bad JSON | Schema parse fails → one bounded retry with the parse error appended → then `PR_DRAFT_INVALID`. Nothing reaches `validate_action`. | Coordinator |
| Draft violates Action contract | `validate_action` returns the stable `V_*` code; the request row stores it; the model never gets a second silent chance. | `actions.py` |
| Hallucinated handle / operation | Unknown handle → `PR_UNKNOWN_HANDLE`; operation not in `capabilities` → `PR_CAPABILITY_DENIED`. Both before the ledger. | Compiler |
| Late generated audio | Generation is a job; arrival adds a library item and (optionally) triggers one Producer call. Nothing is scheduled by arrival. If a human later arms it, `GhostScheduler` applies the min-lead rule and takes the following phrase. | Existing scheduler policy |
| Duplicate action | Deterministic `id`/`idempotencyKey` from `(requestId, index)`; the ledger's unique index returns the stored outcome (`idempotentReplay: true`). | `ActionStore` |
| Stale state | `PR_STALE_CONTEXT` at compile; `GHOST_GRID_STALE` at audition; `S_ASSET_MISMATCH` at commit. Three independent checks, all existing patterns. | Compiler / controller / store |
| Model "explains" something it did not do | Explanations are rendered from ledger + lifecycle facts + request row; rationale is labelled as the model's claim. | UI copy rule |
| Interrupted session (reload, project switch, context closed) | Existing A8 semantics: hydrated `ready` producer proposals appear in the inbox with Audition/Dismiss, never autoplay; in-flight request job is `interrupted` and retryable. | `GhostController`, `JobStore` |
| Grant expiry mid-request | Permission check runs inside the append transaction; an expired grant yields `P_PRODUCER_PREVIEW_DENIED` and the prepared asset is discarded via the existing discard hook. | `ActionStore.append_action` |
| GPU contention (local model vs Demucs) | Local inference is CPU by default; GPU inference, if enabled, is scheduled through the serialized audio executor. | Executor policy |
| Producer floods proposals | `maxPending` per grant; excess is refused with `PR_PENDING_LIMIT`; `ready` proposals expire (G4) after N phrases or TTL. | Grant + lifecycle |

---

## 7. Migration plan mapped onto the existing phases

Labels: **NOW** = do in the next authorized slice; **SCAFFOLD** = define the
interface/table/type with tests, no behaviour; **LATER** = after 15C;
**LAB** = experiment outside the production path; **REJECT** = do not do.

| Item | Phase | Label | Note |
|---|---|---|---|
| Resolve the 500 KB budget question (raise, or adopt native `import()` lazy modules counted separately from first paint) | before 15A wiring | **NOW** | Blocks 15A wiring *and* any Producer UI. Decision, not code. |
| Phase 14B crate items + deterministic compatibility output | 14B | as planned | This *is* the Tier 1 retrieval substrate. Add nothing to it for the Producer. |
| Durable producer **grant** (migration 11: `producer_grants`), server permission context replaces hard-coded deny, client context reads grant from projection | 16A | **NOW** | Pure backend + contract vectors; zero static bytes. |
| `producer_requests` provenance table + link rows | 16A | **NOW** | Model, provider, tier, digest revision, prompt hash, usage, latency, outcome codes. |
| `SessionDigest` builder (pure) + `ProposalDraft` schema + compiler + `ScriptedProvider` | 16A | **NOW** | Deterministic, CI-tested, no network. |
| `JobKind.PRODUCER_REQUEST` + `POST /projects/{id}/producer/requests` | 16A | **NOW** | Reuses job SSE; solves G9. |
| CLI `twobecomeone producer suggest --project … "text"` | 16A | **LAB** | Proves the ledger path with zero frontend change. |
| `OpenAICompatibleProvider` (stdlib/httpx), Ollama-local default | 16B | **NOW** (after 16A) | One class covers Ollama local/cloud, OpenRouter, vLLM, direct. |
| Tier 1 grammar + intent cache + macro promotion | 16B | **SCAFFOLD** then NOW | Grammar first with 5–10 intents; macros after first accepted drafts exist. |
| Producer inbox UI (lazy module), `auditionExisting`, scheduler author gate change | 16B | **NOW** (after budget decision) | Extends the human Ghost path; no parallel AI path. |
| `expired` lifecycle state (additive, terminal) | 16B | **NOW** | Needed the moment proposals nobody arms exist. |
| Tier 3 remote provider + budget + plan cache + demotion | 16C | **LATER** | Only after Tier 2 has produced accepted proposals. |
| `set_mix_control`, `schedule_transition` Action types | after 15B | **SCAFFOLD** now (types, vectors) → implement after 15B | Engine executes as AudioParam ramps on the clock. |
| `preview_stem_stack` / `commit_stem_stack` (Producer may propose) | 14C | as planned | Producer gains it for free via `capabilities`. |
| `GenerationProvider` Protocol + `FakeGenerationProvider` + `JobKind.GENERATE` | 17 | **SCAFFOLD** | No provider chosen. Interface and tests only. |
| Tags, `asset_provenance`, promote pinned ghost asset to library item | 17 | **LATER** | After 14B ships; reference by content hash, never copy media. |
| Directive + `SetConductor` (deterministic executor of pre-approved plan) + delegated grant scopes with expiry | 18 | **LATER** | Requires 15B live warping evidence first. |
| `branch_session` (fork projection at sequence) | 18 | **LATER** | Doc §9.6 already reserves it. |
| Local STT (whisper-class) as an input adapter producing text | 18+ | **LATER** | Text path first; STT is a dependency decision. |
| Browser Web Speech API for voice | — | **REJECT** | Ships audio to a third party in Chromium; violates local-first. Revisit only as an explicit opt-in. |
| Hermes as Producer runtime | — | **REJECT** | See §3. |
| 2become1 MCP server (`twobecomeone mcp serve`) exposing digest/search/propose tools for Hermes, Cursor, Claude Code as clients | 17 | **LAB** | Cheap once 16A exists; commit/reject/revert absent from the surface. |
| Making continuous controls ledger Actions | — | **REJECT** | §4.3. |
| Relaxing `L_LAYER_LIMIT` / one-active Ghost for the Producer | — | **REJECT** as a Producer item | Engine decision for 15C+/16; Producer must not be the pretext. |
| Producer commit under any grant | — | **REJECT** | Constitutional. Delegation, if ever, is a separate visible recorded human Action with scope and expiry. |

Ordering constraint: 16A has no dependency on 14B/15 and could be authorized
in parallel because it adds no static bytes and touches no audio; 16B waits on
the budget decision; 16C waits on 16B evidence. None of this reorders the
existing 14B → 15A → 15B → 14C/15C sequence.

---

## 8. First Producer vertical slice

**Goal:** prove that a model's output can become a `preview_layer` proposal
through the *existing* `POST /api/projects/{id}/actions` path, be auditioned by
a human through the *existing* `GhostScheduler`, and be committed or released
exactly as a human proposal is — with denied actors, malformed output, stale
context, duplicates, cancellation and provenance all tested.

**Scope (16A backend, then 16B UI):**

1. Human creates a grant: `scope: preview_layer`, TTL, `maxPending: 1`.
   Recorded durably; visible in the projection; revocable.
2. Human types an instruction in the Studio (or, in LAB, the CLI). Server
   creates a `producer_request` job. The job: builds the digest, runs Tier 1
   (grammar miss is fine for the first slice), calls the `ModelProvider`
   (`ScriptedProvider` in tests; Ollama-local for real), parses
   `ProposalDraft`, compiles, validates, appends with `actor.type=producer`.
   The asset is prepared by `GhostAssetStore` exactly as for a human.
3. The browser learns via the job's SSE; the proposal is `ready` and shown in
   a "Producer suggestion" card with **Audition** and **Dismiss**. No audio.
4. **Audition** is a human gesture: `GhostController.auditionExisting(id)`
   posts the human `scheduled` lifecycle fact and runs the scheduler.
   `GhostScheduler`'s author gate changes from "proposal author is human" to
   "audition is human-initiated" (the lifecycle fact already requires a human
   actor). Min-lead and grid-parity checks are unchanged.
5. **Commit** and **Release** are the existing human paths. Provenance reads:
   *proposed by Producer (ollama-local/qwen…), request #…, auditioned by you,
   accepted by you.*

**Tests required (mirroring the repository's style):**

- Denied without grant, denied after expiry, denied beyond `maxPending`
  (`P_PRODUCER_PREVIEW_DENIED`, `PR_PENDING_LIMIT`); prepared asset discarded.
- Malformed provider output (bad JSON, unknown handle, extra keys,
  bool-as-number, gain out of range, `launch` ≠ `next_phrase`) never reaches
  the ledger; each yields its stable code on the request row.
- Stale digest revision rejected at compile (`PR_STALE_CONTEXT`).
- Same request replayed → identical action IDs → `idempotentReplay: true`,
  one proposal.
- Cancellation mid-inference → job `cancelled`, no proposal.
- Provider unavailable → job `failed` with `PR_PROVIDER_UNAVAILABLE`; the
  existing human Ghost flow is unaffected (regression suite).
- Browser: a `ready` producer proposal produces **no** audio until Audition;
  Audition, Commit, Undo, reload all produce the same provenance; contract
  vectors extended for the digest and draft schemas.

**What the slice deliberately does not do:** Tier 3, voice, generation,
directives, multiple pending proposals, any new Action type, any change to
`L_LAYER_LIMIT`, any change to schemaVersion 1.

---

## 9. File-level plan

Existing files to change (16A/16B):

- `src/twobecomeone/migrations.py` — migration 11: `producer_grants(id,
  project_id, scope, max_pending, created_by, created_at, expires_at,
  revoked_at)`, `producer_requests(id, project_id, job_id, digest_revision,
  tier, provider_id, model, prompt_hash, input_tokens, output_tokens,
  latency_ms, status, error_code, rationale_json, created_at)`,
  `producer_request_actions(request_id, action_id)`.
- `src/twobecomeone/action_store.py` — `permission_context` injection
  replacing the unconditional producer deny; count pending producer proposals
  inside the transaction; optional `expired` handling.
- `src/twobecomeone/actions.py` — add `expired` to `LIFECYCLE_STATES` /
  `TRANSITIONS` (additive, terminal). No envelope change.
- `src/twobecomeone/contracts.py` — `JobKind.PRODUCER_REQUEST`.
- `src/twobecomeone/studio.py` — grant CRUD, `submit_producer_request`,
  `_run_producer_request` (job executor), digest read helpers.
- `src/twobecomeone/webapp.py` — routes `/api/projects/{id}/producer/grants`,
  `/api/projects/{id}/producer/requests`; passthrough Pydantic like
  `ActionBody`.
- `src/twobecomeone/cli.py` — `producer suggest` (LAB).
- `src/twobecomeone/studio_static/js/actions/lifecycle.js` — `EXPIRED`.
- `src/twobecomeone/studio_static/js/actions/permission.js` — context
  derived from projection grants.
- `src/twobecomeone/studio_static/js/runtime/ghost-scheduler.js` — author
  gate → audition gate.
- `src/twobecomeone/studio_static/js/runtime/ghost-controller.js` —
  `auditionExisting`; treat producer `ready` proposals as inbox, not
  "interrupted".
- `src/twobecomeone/studio_static/js/api.js` — three helpers.
- `src/twobecomeone/studio_static/js/state.js` — `producer` slice.
- `tests/fixtures/action_contract_vectors.json` — producer-actor valid/invalid
  cases with grant context.

New files:

- `src/twobecomeone/producer/__init__.py`
- `src/twobecomeone/producer/digest.py` — pure `SessionDigest` builder +
  handle minting.
- `src/twobecomeone/producer/schema.py` — `ProposalDraft` JSON schema,
  compile-to-Action, `PR_*` error codes (registered alongside the existing
  vocabulary in both languages).
- `src/twobecomeone/producer/providers.py` — `ModelProvider` Protocol,
  `ScriptedProvider`, `OpenAICompatibleProvider` (16B).
- `src/twobecomeone/producer/coordinator.py` — tiers, budget, cache,
  escalation, request lifecycle.
- `src/twobecomeone/producer/retrieval.py` — candidate retrieval (reuses 14B
  compatibility output when it lands).
- `src/twobecomeone/producer/grammar.py` — Tier 1 intents and macros (16B).
- `src/twobecomeone/generation.py` — `GenerationProvider` Protocol +
  `FakeGenerationProvider` (SCAFFOLD, 17).
- `src/twobecomeone/studio_static/js/components/producer-inbox.js` — lazy
  `import()` module (16B, after budget decision).
- `tests/test_producer_grants.py`, `tests/test_producer_digest.py`,
  `tests/test_producer_compile.py`, `tests/test_producer_request_job.py`,
  `tests/fixtures/producer_draft_vectors.json`,
  `tests/frontend/producer/inbox.test.js`,
  `tests/frontend/runtime/ghost-audition-existing.test.js`,
  `tests/browser/producer_ux.js` (both viewports).

### GenerationProvider (SCAFFOLD detail)

```python
class GenerationProvider(Protocol):
    id: str
    capabilities: GenerationCapabilities   # {full_track: bool, stems: set[str], max_seconds, bpm_control, key_control}
    def submit(self, brief: GenerationBrief, *, cancel: CancellationToken,
               progress: Callable[[ProgressDetail], None]) -> GenerationHandle: ...
    def poll(self, handle) -> GenerationStatus: ...       # queued|running|done|failed|cancelled
    def fetch(self, handle) -> GenerationResult: ...       # files by role, claimed bpm/key, provenance{provider, model, brief_hash, terms}
    def cancel(self, handle) -> None: ...
```

Policy: request stems natively when `capabilities.stems` covers the brief
(cleaner than post-hoc separation, no bleed); otherwise import the full track
through the existing ingestion and run the existing Demucs job with honest
`separation: demucs` provenance. In both cases run the existing analyzer on
arrival and store `claimed` and `detected` BPM/key separately (the
override/detected/effective pattern already exists). Cache by `brief_hash`;
fall back across providers only when the brief is capability-compatible; time
out through the job deadline pattern.

### Persistent library evolution (LATER, reference-only)

`tracks` (source), `stem_sets` (separated), `ghost_assets` (derived,
ephemeral→pinned), 14B `stem_crate_items` (region/phrase + loop spec) already
give track/stem/region/phrase/derived. Add `tags` + `item_tags` (favourites are
a tag), `asset_provenance` (generated/derived: provider, model, brief hash,
rights/source terms, parent content hashes), and treat **usage history as a
ledger query** (Actions referencing the handle), not a table. Promote a pinned
ghost asset to a library item by reference to its `transformSpec` and content
hash. No media is ever copied; everything resolves by content hash under the
managed roots.

---

## 10. Decisions

### Ten decisions to make now

1. The Producer runtime is **in-process Python** behind a `ModelProvider` port;
   the only provider implementation for a long time is one OpenAI-compatible
   client. Hermes/Cursor/Claude Code are optional external MCP clients, never
   the runtime.
2. Producer permission becomes a **durable, human-created, expiring grant**
   with `maxPending`, replacing both the client boolean and the server
   hard-coded deny. The permission *table* does not change.
3. **No new Action types and no change to schemaVersion 1** for the first
   slice. The Producer speaks `preview_layer` only.
4. Producer output is a **`ProposalDraft` compiled by deterministic code** into
   Actions; the model never authors an Action envelope, an ID, a key, a hash or
   a path.
5. Producer requests are **jobs** (`JobKind.PRODUCER_REQUEST`), inheriting
   cancellation, deadlines, retry, restart recovery and SSE.
6. **Tier 1 is deterministic** (grammar, retrieval, macros); local models start
   at Tier 2 and run CPU-first or through the serialized audio executor.
7. Provenance lives in a **`producer_requests` table linked to Action IDs**;
   explanations are rendered from ledger + facts + request row, with model
   rationale labelled as a claim.
8. **Continuous controls are not Actions.** Producer influences them only via
   future declarative `set_mix_control` / `schedule_transition` types.
9. **Resolve the 500 KB budget** before any Producer UI: either raise it with a
   recorded sign-off or define first-paint versus lazy-module budgets using
   native `import()`.
10. The digest and draft schemas get **contract vectors and version numbers**
    from day one, in the same style as the Action vectors.

### Ten decisions to postpone explicitly

1. Which generative-music provider, if any.
2. Which local STT engine; whether voice is in scope at all before 18.
3. Whether Tier 3 is OpenRouter, a direct vendor, Ollama Cloud, or several with
   fallback — defer until Tier 2 has produced accepted proposals.
4. Relaxing `L_LAYER_LIMIT` or the one-active Ghost rule (engine decision,
   15C+).
5. Delegated autonomy scopes beyond `preview_layer` with `maxPending: 1`.
6. `branch_session` semantics.
7. Tag taxonomy and rights-metadata schema for the vault.
8. Whether live tempo warping across arbitrary library tracks is feasible in
   the browser (15B evidence decides; the "124 BPM set" promise depends on it).
9. Per-stem independent analysis (14B says inherit; keep it).
10. A 2become1 MCP server and its exact tool list (LAB after 16A).

### The single highest-leverage next architectural move

**Land the Producer boundary as pure, model-free code:** migration 11
(grants + request provenance), the server permission context replacing the
hard-coded deny, the `SessionDigest` builder, the `ProposalDraft` compiler, and
a `ScriptedProvider` — proven end to end by a CI test in which a scripted
"model" produces a `preview_layer` proposal that a human then auditions and
commits through the existing Ghost path.

It adds zero static bytes, touches no audio code, reorders no phase, requires
no cloud account, and converts "Producer access remains deferred" from a
sentence in the README into a tested, permission-gated door that every later
tier, provider, voice adapter and generation job must walk through.

---

## Pushback summary

- The Producer is an actor, not a subsystem. Most of the requested
  architecture already exists as the human Ghost path; the vision documents
  under-credit current main.
- Hermes is the wrong runtime for the reason this project cares about most:
  it ships a general execution path onto the machine that holds musical truth.
- A "cheap local model" is not the cheap tier on a 6 GB laptop GPU shared with
  Demucs. Deterministic grammar is.
- "Continuous session from a high-level instruction" is mostly a *live
  warping* problem (15B) and a *delegation* problem (constitutional), not a
  model problem. Do not let the Producer work become the vehicle for either.
- The 500,000-byte ceiling is now the actual critical path for every
  user-visible feature including this one. Decide it deliberately.
- Generation is asynchronous library ingestion with provenance, then ordinary
  Actions. There is no "inject into live session" operation to design.
