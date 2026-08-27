// js/actions/ledger.js — injected in-memory ActionLedger.
//
// Part of the V1 Action and DeckTransport foundation (Phase 8C).
// Pure and intentionally isolated from persistence, network, DOM, and audio.
// It is an explicit temporary stand-in for the future SQLite Action ledger.
//
// The ledger is append-only. Every validated, permissioned Action becomes an
// immutable `LedgerEntry`. The dispatcher reads the ledger for idempotency
// checks and provenance lookups. Nothing outside the dispatcher/ledger
// modules may mutate entries.

import { buildFailure, buildSuccess, ERROR_CODES } from './errors.js';

export class ActionLedger {
  /**
   * @param {object} deps
   * @param {() => string} deps.idFactory - generates stable entry IDs (tests inject this)
   * @param {() => string} deps.timestampFactory - generates ISO timestamps (tests inject this)
   */
  constructor(deps = {}) {
    this._idFactory = deps.idFactory || (() => crypto.randomUUID?.() || `entry-${Math.random().toString(36).slice(2)}`);
    this._timestampFactory = deps.timestampFactory || (() => new Date().toISOString());
    this._entries = [];
  }

  /** Append an immutable ledger entry. Returns the frozen entry. */
  append({ action, outcome, transportFact = null, supersededBy = null, rejectionReason = null }) {
    if (!action || typeof action !== 'object') {
      return buildFailure(ERROR_CODES.V_INVALID_TYPE);
    }
    const entry = Object.freeze({
      id: this._idFactory(),
      type: 'action_ledger_entry',
      schemaVersion: 1,
      action: Object.freeze(structuredClone(action)),
      outcome, // 'proposal_created' | 'committed' | 'rejected' | 'superseded' | 'blocked'
      transportFact: transportFact ? Object.freeze(structuredClone(transportFact)) : null,
      supersededBy,
      rejectionReason,
      recordedAt: this._timestampFactory(),
    });
    this._entries.push(entry);
    return buildSuccess(entry);
  }

  /** Find the most recent ledger entry with the given idempotency key. */
  findByIdempotencyKey(idempotencyKey) {
    if (typeof idempotencyKey !== 'string') return null;
    for (let i = this._entries.length - 1; i >= 0; i -= 1) {
      const entry = this._entries[i];
      if (entry.action.idempotencyKey === idempotencyKey) {
        return entry;
      }
    }
    return null;
  }

  /** Find a ledger entry by the original Action id. */
  findByActionId(actionId) {
    if (typeof actionId !== 'string') return null;
    for (let i = this._entries.length - 1; i >= 0; i -= 1) {
      const entry = this._entries[i];
      if (entry.action.id === actionId) return entry;
    }
    return null;
  }

  /** Return a frozen snapshot of entries in order. */
  entries() {
    return Object.freeze([...this._entries]);
  }

  /** Deep-cloned serializable state suitable for diagnostics/tests. */
  toJSON() {
    return JSON.parse(JSON.stringify(this._entries));
  }
}

/**
 * Compare two actions for semantic idempotency. Same actor/type/payload
 * means a retry; different payload means key reuse is forbidden.
 * Returns { equal, reason }.
 */
export function compareActions(a, b) {
  if (!a || !b) return { equal: false, reason: 'missing' };
  if (a.actor?.type !== b.actor?.type || a.actor?.id !== b.actor?.id) {
    return { equal: false, reason: 'actor' };
  }
  if (a.type !== b.type) {
    return { equal: false, reason: 'type' };
  }
  try {
    const same = JSON.stringify(a.payload) === JSON.stringify(b.payload);
    if (!same) return { equal: false, reason: 'payload' };
  } catch {
    return { equal: false, reason: 'payload' };
  }
  return { equal: true };
}
