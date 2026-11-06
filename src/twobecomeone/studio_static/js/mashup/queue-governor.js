// mashup/queue-governor.js — pure queue reducer.
// Emits validated queue-progress events. Does not load media or assign decks.

import { DECKS, NEAR_END_SECONDS, validateQueueEvent } from './contracts.js';

const SCHEMA_QUEUE_EVENT = 'queue-progress/v1';
const OPEN_STATUSES = new Set(['pending', 'importing', 'ready']);
const JOB_FAILURES = new Set(['failed', 'cancelled', 'interrupted']);

const IDLE_HEAD = Object.freeze({
  playing: false,
  ended: false,
  time: 0,
  duration: 0,
});

export function createQueueState() {
  return {
    armed: false,
    items: [],
    activeImportId: null,
    endNotified: { A: false, B: false },
  };
}

function copyState(state, patch) {
  return {
    armed: state.armed,
    items: state.items,
    activeImportId: state.activeImportId,
    endNotified: state.endNotified,
    ...patch,
  };
}

function replaceItem(items, itemId, next) {
  return items.map((item) => (item.id === itemId ? next : item));
}

export function enqueueTrack(state, track) {
  const trackId = typeof track?.id === 'string' ? track.id.trim() : '';
  if (!trackId) {
    return { state, error: { code: 'EMPTY_TRACK', message: 'Track is missing.' } };
  }
  const duplicate = state.items.some((item) => item.trackId === trackId && OPEN_STATUSES.has(item.status));
  if (duplicate) return { state, error: null };
  const name = typeof track.name === 'string' && track.name.trim() ? track.name.trim() : trackId;
  const item = {
    id: `q${state.items.length + 1}-${trackId.length}`,
    url: null,
    name,
    status: 'pending',
    jobId: null,
    trackId,
    targetDeck: null,
    error: null,
  };
  return {
    state: copyState(state, { items: [...state.items, item] }),
    error: null,
  };
}

export function enqueueUrl(state, url) {
  const trimmed = typeof url === 'string' ? url.trim() : '';
  if (!trimmed) {
    return { state, error: { code: 'EMPTY_URL', message: 'URL is empty.' } };
  }
  const duplicate = state.items.some((item) => item.url === trimmed && OPEN_STATUSES.has(item.status));
  if (duplicate) return { state, error: null };
  const item = {
    id: `q${state.items.length + 1}-${trimmed.length}`,
    url: trimmed,
    status: 'pending',
    jobId: null,
    trackId: null,
    targetDeck: null,
    error: null,
  };
  return {
    state: copyState(state, { items: [...state.items, item] }),
    error: null,
  };
}

export function setArmed(state, armed) {
  const next = armed === true;
  if (state.armed === next) return state;
  return copyState(state, { armed: next });
}

export function removeItem(state, itemId) {
  const item = state.items.find((entry) => entry.id === itemId);
  if (!item || item.status === 'importing') return state;
  return copyState(state, {
    items: state.items.filter((entry) => entry.id !== itemId),
    activeImportId: state.activeImportId === itemId ? null : state.activeImportId,
  });
}

function headOf(playheads, deck) {
  const head = playheads && typeof playheads === 'object' ? playheads[deck] : null;
  if (!head || typeof head !== 'object' || Array.isArray(head)) return IDLE_HEAD;
  return {
    playing: head.playing === true,
    ended: head.ended === true,
    time: typeof head.time === 'number' && Number.isFinite(head.time) ? head.time : 0,
    duration: typeof head.duration === 'number' && Number.isFinite(head.duration) ? head.duration : 0,
  };
}

function remaining(head) {
  if (head.ended) return 0;
  if (!(head.duration > 0)) return Infinity;
  return Math.max(0, head.duration - head.time);
}

function nearEnd(head) {
  return head.ended === true || (head.playing === true && remaining(head) <= NEAR_END_SECONDS);
}

function otherDeck(deck) {
  return deck === 'A' ? 'B' : 'A';
}

function headsOf(playheads) {
  return {
    A: headOf(playheads, 'A'),
    B: headOf(playheads, 'B'),
  };
}

function outgoingDeck(heads) {
  let chosen = null;
  let best = Infinity;
  for (const deck of DECKS) {
    if (!nearEnd(heads[deck])) continue;
    const left = remaining(heads[deck]);
    if (chosen == null || left < best) {
      chosen = deck;
      best = left;
    }
  }
  return chosen;
}

function tryEvent(partial) {
  try {
    return validateQueueEvent({
      schema: SCHEMA_QUEUE_EVENT,
      type: partial.type,
      itemId: partial.itemId ?? null,
      deck: partial.deck ?? null,
      fromDeck: partial.fromDeck ?? null,
      toDeck: partial.toDeck ?? null,
      trackId: partial.trackId ?? null,
      url: partial.url ?? null,
      code: partial.code ?? null,
      message: partial.message ?? null,
    });
  } catch {
    return null;
  }
}

export function decide(state, playheads) {
  if (!state || state.armed !== true) return { state, events: [] };
  if (state.activeImportId) return { state, events: [] };

  const heads = headsOf(playheads);
  const outgoing = outgoingDeck(heads);
  if (!outgoing) return { state, events: [] };

  const pending = state.items.find((item) => item.status === 'pending');
  if (!pending) {
    if (heads[outgoing].ended === true && state.endNotified[outgoing] !== true) {
      const event = tryEvent({
        type: 'blocked',
        code: 'QUEUE_EMPTY',
        message: 'Queue is empty.',
      });
      if (!event) return { state, events: [] };
      return {
        state: copyState(state, {
          endNotified: { ...state.endNotified, [outgoing]: true },
        }),
        events: [event],
      };
    }
    return { state, events: [] };
  }

  const incoming = otherDeck(outgoing);
  const incomingHead = heads[incoming];
  const incomingHealthy = incomingHead.playing === true
    && incomingHead.ended !== true
    && remaining(incomingHead) > NEAR_END_SECONDS;
  if (incomingHealthy && heads[outgoing].ended !== true) {
    return { state, events: [] };
  }

  const target = incomingHealthy ? outgoing : incoming;
  return beginPending(state, pending, target, playheads);
}

export function fillEmptyDeck(state, occupancy) {
  if (!state || state.armed !== true || state.activeImportId) return { state, events: [] };
  const pending = state.items.find((item) => item.status === 'pending');
  if (!pending) return { state, events: [] };
  const occ = occupancy && typeof occupancy === 'object' ? occupancy : {};
  const target = DECKS.find((deck) => occ[deck] !== true);
  if (!target) return { state, events: [] };
  return beginPending(state, pending, target, null);
}

function beginPending(state, pending, target, playheads) {
  const trackId = typeof pending.trackId === 'string' ? pending.trackId.trim() : '';
  if (trackId) {
    const assign = tryEvent({
      type: 'assign_deck',
      deck: target,
      trackId,
      itemId: pending.id,
    });
    if (!assign) return { state, events: [] };
    const events = [assign];
    if (playheads) {
      const other = otherDeck(target);
      const otherHead = headsOf(playheads)[other];
      if (otherHead.playing === true && otherHead.ended !== true) {
        const transition = tryEvent({
          type: 'transition',
          fromDeck: other,
          toDeck: target,
        });
        if (transition) events.push(transition);
      }
    }
    return {
      state: copyState(state, {
        items: replaceItem(state.items, pending.id, {
          ...pending,
          status: 'loaded',
          trackId,
          targetDeck: target,
          error: null,
        }),
        endNotified: { ...state.endNotified, [target]: false },
      }),
      events,
    };
  }

  const event = tryEvent({
    type: 'import_next',
    itemId: pending.id,
    url: pending.url,
    deck: target,
  });
  if (!event) return { state, events: [] };
  return {
    state: copyState(state, {
      items: replaceItem(state.items, pending.id, {
        ...pending,
        status: 'importing',
        targetDeck: target,
        jobId: null,
      }),
      activeImportId: pending.id,
      endNotified: { ...state.endNotified, [target]: false },
    }),
    events: [event],
  };
}

export function noteJob(state, itemId, job) {
  const item = state.items.find((entry) => entry.id === itemId);
  if (!item || item.status !== 'importing' || !job || typeof job !== 'object') return state;
  const status = typeof job.status === 'string' ? job.status : '';
  const jobId = typeof job.id === 'string' && job.id.trim() ? job.id : item.jobId;
  const failed = JOB_FAILURES.has(status);
  if (!failed && jobId === item.jobId) return state;
  const next = {
    ...item,
    jobId,
    status: failed ? 'failed' : 'importing',
    error: failed ? { code: 'JOB_FAILED', message: status } : item.error,
  };
  return copyState(state, {
    items: replaceItem(state.items, itemId, next),
    activeImportId: failed && state.activeImportId === itemId ? null : state.activeImportId,
  });
}

function assetError(error) {
  const code = error && typeof error === 'object' && typeof error.code === 'string' && error.code.trim()
    ? error.code
    : 'ASSET_FAILED';
  const message = error && typeof error === 'object' && typeof error.message === 'string' && error.message.trim()
    ? error.message
    : 'Import failed.';
  return { code, message };
}

function jobIdFrom(asset, fallback) {
  if (asset && typeof asset.jobId === 'string' && asset.jobId.trim()) return asset.jobId;
  return fallback;
}

export function noteAsset(state, itemId, asset, playheads) {
  const item = state.items.find((entry) => entry.id === itemId);
  if (!item) return { state, events: [] };
  const body = asset && typeof asset === 'object' ? asset : {};
  const trackId = typeof body.trackId === 'string' ? body.trackId : '';

  if (body.ok === true && body.status === 'complete' && trackId.trim()) {
    const target = item.targetDeck;
    const assign = tryEvent({
      type: 'assign_deck',
      deck: target,
      trackId,
      itemId,
    });
    const events = [];
    if (assign) {
      events.push(assign);
      const other = otherDeck(target);
      const otherHead = headsOf(playheads)[other];
      if (otherHead.playing === true && otherHead.ended !== true) {
        const transition = tryEvent({
          type: 'transition',
          fromDeck: other,
          toDeck: target,
        });
        if (transition) events.push(transition);
      }
    }
    return {
      state: copyState(state, {
        items: replaceItem(state.items, itemId, {
          ...item,
          status: 'loaded',
          trackId,
          jobId: jobIdFrom(body, item.jobId),
          error: null,
        }),
        activeImportId: state.activeImportId === itemId ? null : state.activeImportId,
      }),
      events,
    };
  }

  if (body.ok === false || body.status === 'failed') {
    const error = assetError(body.error);
    const event = tryEvent({
      type: 'blocked',
      itemId,
      code: error.code,
      message: error.message,
    });
    return {
      state: copyState(state, {
        items: replaceItem(state.items, itemId, {
          ...item,
          status: 'failed',
          error,
          jobId: jobIdFrom(body, item.jobId),
        }),
        activeImportId: state.activeImportId === itemId ? null : state.activeImportId,
      }),
      events: event ? [event] : [],
    };
  }

  const jobId = jobIdFrom(body, null);
  if (!jobId || jobId === item.jobId) return { state, events: [] };
  return {
    state: copyState(state, {
      items: replaceItem(state.items, itemId, { ...item, jobId }),
    }),
    events: [],
  };
}
