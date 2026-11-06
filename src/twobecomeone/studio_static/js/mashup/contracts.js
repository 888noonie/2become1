// mashup/contracts.js — browser mirror of mashup_contracts.py.
// Fail closed: unknown fields and out-of-range ops are rejected.
// No network, no audio nodes, no credentials.

export const SCHEMA_DECK_LOAD = 'deck-load-asset/v1';
export const SCHEMA_DIRECTIVE = 'playback-directive/v1';
export const SCHEMA_QUEUE_EVENT = 'queue-progress/v1';

export const SYSTEM1_MODEL = 'deepseek-v4-flash:cloud';
export const COMPLEX_MODEL = 'deepseek-v4-pro:cloud';
export const DISALLOWED_DEFAULT_MODELS = Object.freeze(['mistral-large-3:675b-cloud']);

export const DECKS = Object.freeze(['A', 'B']);
export const TARGET_DECKS = Object.freeze(['A', 'B', 'auto']);
export const ASSET_STATUSES = Object.freeze(['rejected', 'queued', 'running', 'complete', 'failed']);
export const OPS = Object.freeze(['eq', 'gain', 'crossfader', 'filter', 'loop', 'play', 'pause']);
export const BANDS = Object.freeze(['low', 'mid', 'high']);
export const FILTER_MODES = Object.freeze(['lowpass', 'highpass', 'off']);
export const LOOP_BARS = Object.freeze([1, 2, 4, 8]);
export const EVENT_TYPES = Object.freeze([
  'import_next', 'assign_deck', 'transition', 'blocked', 'idle',
]);
export const NEAR_END_SECONDS = 8;

const DECK_LOAD_KEYS = new Set([
  'schema', 'ok', 'canonicalUrl', 'jobId', 'trackId', 'status', 'targetDeck', 'error',
]);
const DIRECTIVE_KEYS = new Set([
  'schema', 'ok', 'tier', 'source', 'model', 'ops', 'declined', 'error',
]);
const EVENT_KEYS = new Set([
  'schema', 'type', 'itemId', 'deck', 'fromDeck', 'toDeck', 'trackId', 'url', 'code', 'message',
]);

function rejectUnknown(payload, allowed) {
  const extra = Object.keys(payload).filter((key) => !allowed.has(key));
  if (extra.length) {
    throw new Error(`UNKNOWN_FIELD:${extra.sort().join(',')}`);
  }
}

function copyError(error, label) {
  if (error == null) return null;
  if (typeof error !== 'object' || Array.isArray(error)) throw new Error(label);
  const keys = Object.keys(error);
  if (keys.some((key) => key !== 'code' && key !== 'message')) throw new Error(label);
  if (typeof error.code !== 'string' || typeof error.message !== 'string' || !error.code || !error.message) {
    throw new Error(label);
  }
  return { code: error.code, message: error.message };
}

function optionalString(value, label) {
  if (value == null) return null;
  if (typeof value !== 'string' || !value.trim()) throw new Error(label);
  return value;
}

export function validateDeckLoadAsset(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('ASSET_TYPE');
  rejectUnknown(payload, DECK_LOAD_KEYS);
  if (payload.schema !== SCHEMA_DECK_LOAD) throw new Error('ASSET_SCHEMA');
  if (typeof payload.ok !== 'boolean') throw new Error('ASSET_OK');
  if (!ASSET_STATUSES.includes(payload.status)) throw new Error('ASSET_STATUS');
  if (!TARGET_DECKS.includes(payload.targetDeck)) throw new Error('ASSET_DECK');
  const canonicalUrl = optionalString(payload.canonicalUrl, 'ASSET_CANONICALURL');
  const jobId = optionalString(payload.jobId, 'ASSET_JOBID');
  const trackId = optionalString(payload.trackId, 'ASSET_TRACKID');
  const error = copyError(payload.error, 'ASSET_ERROR');
  if (payload.ok && payload.status === 'rejected') throw new Error('ASSET_OK_STATUS');
  if (!payload.ok && !error) throw new Error('ASSET_ERROR_REQUIRED');
  if (payload.status === 'complete' && payload.ok && !trackId) throw new Error('ASSET_TRACK_REQUIRED');
  if ((payload.status === 'queued' || payload.status === 'running') && trackId) throw new Error('ASSET_TRACK_EARLY');
  if (payload.status !== 'rejected' && payload.ok && !jobId) throw new Error('ASSET_JOB_REQUIRED');
  return {
    schema: SCHEMA_DECK_LOAD,
    ok: payload.ok,
    canonicalUrl,
    jobId,
    trackId,
    status: payload.status,
    targetDeck: payload.targetDeck,
    error,
  };
}

function validateOp(op) {
  if (!op || typeof op !== 'object' || Array.isArray(op)) throw new Error('OP_TYPE');
  if (!OPS.includes(op.op)) throw new Error('OP_UNKNOWN');
  const allowed = new Set(['op', 'deck', 'band', 'db', 'value', 'position', 'mode', 'amount', 'bars', 'enabled']);
  rejectUnknown(op, allowed);
  if (op.op === 'crossfader') {
    if (Object.keys(op).length !== 2 || !Object.hasOwn(op, 'position')) throw new Error('OP_CROSSFADER');
    if (typeof op.position !== 'number' || !Number.isFinite(op.position) || op.position < 0 || op.position > 100) {
      throw new Error('OP_CROSSFADER_RANGE');
    }
    return { op: 'crossfader', position: op.position };
  }
  if (!DECKS.includes(op.deck)) throw new Error('OP_DECK');
  if (op.op === 'eq') {
    if (!BANDS.includes(op.band)) throw new Error('OP_BAND');
    if (typeof op.db !== 'number' || !Number.isFinite(op.db) || op.db < -12 || op.db > 12) throw new Error('OP_DB');
    return { op: 'eq', deck: op.deck, band: op.band, db: op.db };
  }
  if (op.op === 'gain') {
    if (typeof op.value !== 'number' || !Number.isFinite(op.value) || op.value < 0 || op.value > 1) {
      throw new Error('OP_GAIN');
    }
    return { op: 'gain', deck: op.deck, value: op.value };
  }
  if (op.op === 'filter') {
    if (!FILTER_MODES.includes(op.mode)) throw new Error('OP_FILTER');
    if (typeof op.amount !== 'number' || !Number.isFinite(op.amount) || op.amount < 0 || op.amount > 1) {
      throw new Error('OP_FILTER_AMOUNT');
    }
    return { op: 'filter', deck: op.deck, mode: op.mode, amount: op.amount };
  }
  if (op.op === 'loop') {
    if (!LOOP_BARS.includes(op.bars)) throw new Error('OP_BARS');
    const enabled = op.enabled == null ? true : op.enabled;
    if (typeof enabled !== 'boolean') throw new Error('OP_LOOP_ENABLED');
    return { op: 'loop', deck: op.deck, bars: op.bars, enabled };
  }
  if (op.op === 'play' || op.op === 'pause') {
    const keys = Object.keys(op);
    if (keys.length !== 2 || !keys.includes('deck')) throw new Error('OP_TRANSPORT');
    return { op: op.op, deck: op.deck };
  }
  throw new Error('OP_UNKNOWN');
}

export function validatePlaybackDirective(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('DIRECTIVE_TYPE');
  rejectUnknown(payload, DIRECTIVE_KEYS);
  if (payload.schema !== SCHEMA_DIRECTIVE) throw new Error('DIRECTIVE_SCHEMA');
  if (!['deterministic', 'system1', 'complex'].includes(payload.tier)) throw new Error('DIRECTIVE_TIER');
  if (!['grammar', 'model', 'transition'].includes(payload.source)) throw new Error('DIRECTIVE_SOURCE');
  if (typeof payload.ok !== 'boolean') throw new Error('DIRECTIVE_OK');
  if (payload.model != null) {
    if (typeof payload.model !== 'string' || DISALLOWED_DEFAULT_MODELS.includes(payload.model)) {
      throw new Error('DIRECTIVE_MODEL');
    }
    if (payload.tier === 'system1' && payload.model !== SYSTEM1_MODEL) throw new Error('DIRECTIVE_MODEL');
    if (payload.tier === 'complex' && payload.model !== COMPLEX_MODEL) throw new Error('DIRECTIVE_MODEL');
    if (payload.tier === 'deterministic') throw new Error('DIRECTIVE_MODEL');
  } else if (payload.tier !== 'deterministic') {
    throw new Error('DIRECTIVE_MODEL_REQUIRED');
  }
  if (!Array.isArray(payload.ops) || !Array.isArray(payload.declined)) throw new Error('DIRECTIVE_LIST');
  if (payload.ops.length > 4 || payload.declined.length > 4) throw new Error('DIRECTIVE_LIMIT');
  const ops = payload.ops.map(validateOp);
  const declined = payload.declined.map((item) => copyError(item, 'DIRECTIVE_DECLINED'));
  const error = copyError(payload.error, 'DIRECTIVE_ERROR');
  if (payload.ok && ops.length === 0 && declined.length === 0) throw new Error('DIRECTIVE_EMPTY');
  if (!payload.ok && !error) throw new Error('DIRECTIVE_ERROR_REQUIRED');
  if (!payload.ok && ops.length) throw new Error('DIRECTIVE_OPS_ON_FAILURE');
  return {
    schema: SCHEMA_DIRECTIVE,
    ok: payload.ok,
    tier: payload.tier,
    source: payload.source,
    model: payload.model ?? null,
    ops,
    declined,
    error,
  };
}

export function transitionDirective(fromDeck, toDeck) {
  if (!DECKS.includes(fromDeck) || !DECKS.includes(toDeck) || fromDeck === toDeck) {
    throw new Error('TRANSITION_DECK');
  }
  return validatePlaybackDirective({
    schema: SCHEMA_DIRECTIVE,
    ok: true,
    tier: 'deterministic',
    source: 'transition',
    model: null,
    ops: [{ op: 'crossfader', position: toDeck === 'B' ? 100 : 0 }],
    declined: [],
    error: null,
  });
}

export function validateQueueEvent(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('EVENT_TYPE');
  rejectUnknown(payload, EVENT_KEYS);
  if (payload.schema !== SCHEMA_QUEUE_EVENT) throw new Error('EVENT_SCHEMA');
  if (!EVENT_TYPES.includes(payload.type)) throw new Error('EVENT_NAME');
  const event = {
    schema: SCHEMA_QUEUE_EVENT,
    type: payload.type,
    itemId: optionalString(payload.itemId, 'EVENT_FIELD'),
    deck: payload.deck ?? null,
    fromDeck: payload.fromDeck ?? null,
    toDeck: payload.toDeck ?? null,
    trackId: optionalString(payload.trackId, 'EVENT_FIELD'),
    url: optionalString(payload.url, 'EVENT_FIELD'),
    code: optionalString(payload.code, 'EVENT_FIELD'),
    message: optionalString(payload.message, 'EVENT_FIELD'),
  };
  for (const key of ['deck', 'fromDeck', 'toDeck']) {
    const value = event[key];
    if (value == null) continue;
    if (key === 'deck' && value === 'auto') continue;
    if (!DECKS.includes(value)) throw new Error('EVENT_DECK');
  }
  if (event.type === 'import_next') {
    if (!event.itemId || !event.url || !TARGET_DECKS.includes(event.deck)) throw new Error('EVENT_IMPORT');
  } else if (event.type === 'assign_deck') {
    if (!DECKS.includes(event.deck) || !event.trackId || !event.itemId) throw new Error('EVENT_ASSIGN');
  } else if (event.type === 'transition') {
    if (!DECKS.includes(event.fromDeck) || !DECKS.includes(event.toDeck) || event.fromDeck === event.toDeck) {
      throw new Error('EVENT_TRANSITION');
    }
  } else if (event.type === 'blocked') {
    if (!event.code || !event.message) throw new Error('EVENT_BLOCKED');
  }
  return event;
}

export function selectModel(tier) {
  if (tier === 'system1') return SYSTEM1_MODEL;
  if (tier === 'complex') return COMPLEX_MODEL;
  throw new Error('MODEL_TIER');
}
