// js/actions/hydration.js — silent V1 bootstrap hydration adapter (Phase 9A).
//
// Fetches the server's finite action-state projection after a current project
// exists, validates its shape defensively, deep-clones it, and hands it to the
// store via the narrow `v1/hydrate` reducer action that replaces ONLY the
// session/proposals slices.
//
// This module is deliberately boring and silent:
//   - no visual controls, no toasts, no routing changes;
//   - fully abortable (AbortController owned by the caller or internal);
//   - teardown-safe (a late response after teardown is ignored);
//   - on any failure it keeps the empty/local V1 projection and reports
//     `{ ok: false }` — never fake success.

import { get as apiGet } from '../api.js';

const ALLOWED_TOP_KEYS = ['projection_version', 'last_sequence', 'session', 'proposals'];
const ALLOWED_SESSION_KEYS = ['deckAssignments', 'committedLayers', 'revertedLayers', 'acceptedActionIds'];
const ALLOWED_PROPOSAL_KEYS = ['byId', 'order', 'activeIds'];
const MAX_LAYER_COUNT = 256;
const MAX_JSON_DEPTH = 16;
const MAX_JSON_NODES = 4096;

export const V1_HYDRATE_ACTION = 'v1/hydrate-projection';

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isBoundedPlainJson(value, depth = 0, budget = { nodes: 0 }) {
  budget.nodes += 1;
  if (budget.nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) {
    return value.length <= MAX_LAYER_COUNT
      && value.every((item) => isBoundedPlainJson(item, depth + 1, budget));
  }
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  if (keys.length > MAX_LAYER_COUNT) return false;
  return keys.every((key) => isBoundedPlainJson(value[key], depth + 1, budget));
}

/**
 * Defensive shape check of a server projection. Accepts only the finite
 * bootstrap shape documented in the plan; anything else is a failure.
 */
export function validateProjectionShape(body) {
  if (!isPlainObject(body)) return { ok: false, reason: 'not an object' };
  for (const key of Object.keys(body)) {
    if (!ALLOWED_TOP_KEYS.includes(key)) return { ok: false, reason: `unknown top-level key ${key}` };
  }
  if (body.projection_version !== 1) return { ok: false, reason: 'unsupported projection_version' };
  if (!isFiniteNumber(body.last_sequence) || body.last_sequence < 0) {
    return { ok: false, reason: 'invalid last_sequence' };
  }
  const session = body.session;
  const proposals = body.proposals;
  if (!isPlainObject(session) || !isPlainObject(proposals)) {
    return { ok: false, reason: 'missing session/proposals' };
  }
  for (const key of Object.keys(session)) {
    if (!ALLOWED_SESSION_KEYS.includes(key)) return { ok: false, reason: `unknown session key ${key}` };
  }
  for (const key of Object.keys(proposals)) {
    if (!ALLOWED_PROPOSAL_KEYS.includes(key)) return { ok: false, reason: `unknown proposals key ${key}` };
  }
  if (!isPlainObject(session.deckAssignments)) return { ok: false, reason: 'deckAssignments missing' };
  if (
    !Array.isArray(session.committedLayers) ||
    !Array.isArray(session.revertedLayers) ||
    !Array.isArray(session.acceptedActionIds)
  ) {
    return { ok: false, reason: 'session arrays missing' };
  }
  if (!isPlainObject(proposals.byId) || !Array.isArray(proposals.order) || !Array.isArray(proposals.activeIds)) {
    return { ok: false, reason: 'proposals containers missing' };
  }
  // Every proposal must be a serializable record with the required fields.
  for (const id of Object.keys(proposals.byId)) {
    const proposal = proposals.byId[id];
    if (!isPlainObject(proposal) || proposal.id !== id || typeof proposal.lifecycle !== 'string') {
      return { ok: false, reason: `invalid proposal ${id}` };
    }
  }
  // Amendment 8: committedLayers and revertedLayers are mutually exclusive by
  // commitActionId, and each list must be bounded, recursively plain JSON with
  // no duplicate identities.
  const committedIds = new Set();
  if (session.committedLayers.length > MAX_LAYER_COUNT
      || session.revertedLayers.length > MAX_LAYER_COUNT) {
    return { ok: false, reason: 'too many session layers' };
  }
  for (const layer of session.committedLayers) {
    if (!isPlainObject(layer) || typeof layer.actionId !== 'string'
        || !isBoundedPlainJson(layer)) {
      return { ok: false, reason: 'invalid committed layer' };
    }
    if (committedIds.has(layer.actionId)) {
      return { ok: false, reason: 'duplicate committed layer identity' };
    }
    committedIds.add(layer.actionId);
  }
  const revertedIds = new Set();
  for (const layer of session.revertedLayers) {
    if (!isPlainObject(layer) || typeof layer.actionId !== 'string'
        || !isBoundedPlainJson(layer)) {
      return { ok: false, reason: 'invalid reverted layer' };
    }
    if (revertedIds.has(layer.actionId)) {
      return { ok: false, reason: 'duplicate reverted layer identity' };
    }
    revertedIds.add(layer.actionId);
    if (committedIds.has(layer.actionId)) {
      return { ok: false, reason: 'layer present in both committed and reverted lists' };
    }
  }
  return { ok: true };
}

/**
 * Create a hydration controller for one project boot.
 *
 * @param {object} deps
 * @param {import('../state.js').StateStore} deps.store
 * @param {string} deps.projectId
 * @param {(path: string, signal?: AbortSignal) => Promise<any>} [deps.fetcher]
 * @returns {{ promise: Promise<{ok: boolean, reason?: string}>, abort: () => void, settled: () => boolean }}
 */
export function hydrateActionState({ store, projectId, fetcher } = {}) {
  const get = fetcher || apiGet;
  const controller = new AbortController();
  let tornDown = false;
  let settled = false;

  const promise = (async () => {
    try {
      const body = await get(
        `/api/projects/${encodeURIComponent(projectId)}/action-state`,
        controller.signal,
      );
      if (tornDown) return { ok: false, reason: 'torn down' };
      const shape = validateProjectionShape(body);
      if (!shape.ok) return { ok: false, reason: shape.reason };
      // Narrow reducer replaces ONLY the two V1 slices, deep-cloned.
      store.dispatch({
        type: V1_HYDRATE_ACTION,
        projection: structuredClone({ session: body.session, proposals: body.proposals }),
        lastSequence: body.last_sequence,
      });
      settled = true;
      return { ok: true };
    } catch (error) {
      if (tornDown) return { ok: false, reason: 'torn down' };
      if (error && error.name === 'AbortError') return { ok: false, reason: 'aborted' };
      // Silent failure: retain empty/local projection, report no fake success.
      return { ok: false, reason: (error && error.message) || 'hydration failed' };
    }
  })();

  return {
    promise,
    abort: () => controller.abort(),
    teardown: () => {
      tornDown = true;
      controller.abort();
    },
    settled: () => settled,
  };
}
