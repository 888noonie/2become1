// js/stem-sleeve.js — OPERATION OPEN THE RECORD SLEEVES.
//
// One separated stem has ONE identity: (stem_set_id, role). The role token is
// the path key, the audio query and the lane identity; the owner's label
// (display_name) is only text. This module:
//
// - turns GET /api/tracks/{id}/stems variants and the search `match.stems`
//   entries into one validated shape (never trusting a URL it did not expect),
// - renames or clears a label with PATCH /api/stem-sets/{id}/names and tells
//   every visible list (Library, Crate, Arrangement) through one small bus,
// - keeps a cache of identity cards (GET /api/stem-sets/{id}) so a label is
//   looked up live and never written into ProjectState,
// - holds the one stem the musician chose to bring into an Arrangement. That
//   offer is a pointer to Library media, not a second asset system: the
//   Arrangement still decodes it and places it through its own edit commands.
//
// It owns no catalogue state: lists re-read the backend for anything new.

import { createElement, replaceChildren } from './dom.js';
import { roleChip, roleToken } from './stem-roles.js';

export const STEM_ROLES = Object.freeze(['vocals', 'drums', 'bass', 'other', 'center', 'sides']);
export const ROLE_LABELS = Object.freeze({
  vocals: 'Vocals', drums: 'Drums', bass: 'Bass', other: 'Other',
  center: 'Center (channel split)', sides: 'Sides (channel split)',
});
export const STEM_NAME_LIMIT = 200;
const SET_ID = /^[A-Za-z0-9_-]{1,80}$/;
const METHOD_LABELS = Object.freeze({ demucs: 'Demucs', imported: 'Imported by you', ffmpeg: 'ffmpeg channel split' });

export const roleLabel = (role) => ROLE_LABELS[role] || role;
export const methodLabel = (method) => METHOD_LABELS[method] || (method ? String(method) : 'method not recorded');
export const stemKey = (stemSetId, role) => `${stemSetId}:${role}`;

/** The only audio URL a stem may have: the Studio's own stem route. */
export function stemAudioPath(stemSetId, role) {
  return `/api/stems/${stemSetId}/audio?name=${role}`;
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Validate one stem from either backend shape. Returns null for anything that
 * is not a known role of a well-formed set, or whose audio URL is not exactly
 * the stem route for that (set, role): a label can never become a path.
 */
export function normalizeStem(raw, { trackId = null, trackName = null, available = undefined } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const role = raw.role ?? raw.name;
  const stemSetId = raw.stem_set_id;
  if (!STEM_ROLES.includes(role) || typeof stemSetId !== 'string' || !SET_ID.test(stemSetId)) return null;
  const audioUrl = raw.audio_url === stemAudioPath(stemSetId, role) ? raw.audio_url : null;
  const custom = raw.custom_name === true && Boolean(text(raw.display_name));
  return {
    key: stemKey(stemSetId, role),
    stemSetId,
    role,
    displayName: custom ? text(raw.display_name) : role,
    customName: custom,
    method: text(raw.method),
    modelName: text(raw.model_name),
    // Playable only when the backend said so AND the URL is the stem route.
    available: Boolean(audioUrl) && (available ?? raw.available) === true,
    audioUrl,
    matched: Array.isArray(raw.matched) ? raw.matched.filter((m) => ['label', 'role', 'track'].includes(m)) : [],
    trackId: text(raw.track_id) ?? trackId,
    trackName: text(raw.track_name) ?? trackName,
  };
}

/** GET /api/tracks/{id}/stems → the separated stems (never the full mix). */
export function stemsFromVariants(response, { trackId, trackName }) {
  const variants = Array.isArray(response?.variants) ? response.variants : [];
  // list_stems only lists roles whose file validated, so a listed stem is
  // available; anything malformed is dropped by normalizeStem.
  return variants
    .filter((v) => v && v.name !== 'full')
    .map((v) => normalizeStem(v, { trackId, trackName, available: true }))
    .filter(Boolean);
}

/** A search item's `match` → {trackMatched, stems}, or null when absent. */
export function stemMatch(match, { trackId, trackName }) {
  if (!match || typeof match !== 'object' || !Array.isArray(match.stems)) return null;
  const seen = new Set();
  const stems = [];
  for (const raw of match.stems) {
    const stem = normalizeStem(raw, { trackId, trackName });
    // A stem is listed under its own recording only, once.
    if (!stem || seen.has(stem.key) || (stem.trackId && trackId && stem.trackId !== trackId)) continue;
    seen.add(stem.key);
    stems.push(stem);
  }
  return { trackMatched: match.track === true, stems };
}

/** The same rules as the backend label (NFC, collapsed, 1–200 characters). */
export function cleanStemName(value) {
  const cleaned = String(value ?? '').normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return { ok: false, reason: 'Enter a name, or use Original name to go back to the role.' };
  if ([...cleaned].length > STEM_NAME_LIMIT) return { ok: false, reason: `A stem name must be ${STEM_NAME_LIMIT} characters or fewer.` };
  return { ok: true, value: cleaned };
}

/** "Matched by …" in plain words. */
export function matchReasons(stem) {
  const words = { label: 'its name', role: 'its role', track: 'the recording name' };
  return stem.matched.map((m) => words[m]).join(' and ');
}

// ------------------------------------------------------------ name bus + cards

const cards = new Map(); // stem_set_id → identity card (live labels, provenance)
const pendingCards = new Map();
const nameListeners = new Set();

export function onStemCard(fn) {
  nameListeners.add(fn);
  return () => nameListeners.delete(fn);
}

/** Remember a fresh identity card and tell every visible list. */
export function publishStemCard(card) {
  if (!card || typeof card.stem_set_id !== 'string') return;
  cards.set(card.stem_set_id, card);
  for (const fn of [...nameListeners]) {
    try { fn(card); } catch (err) { console.error(err); }
  }
}

export function cachedStemCard(stemSetId) {
  return cards.get(stemSetId) ?? null;
}

/** GET /api/stem-sets/{id} once per set (until a rename publishes a newer card). */
export function loadStemCard(stemSetId, fetchJson) {
  if (!SET_ID.test(String(stemSetId))) return Promise.resolve(null);
  if (cards.has(stemSetId)) return Promise.resolve(cards.get(stemSetId));
  if (pendingCards.has(stemSetId)) return pendingCards.get(stemSetId);
  const p = Promise.resolve(fetchJson(`/api/stem-sets/${stemSetId}`))
    .then((card) => { if (card) publishStemCard(card); return card ?? null; })
    .catch(() => null)
    .finally(() => pendingCards.delete(stemSetId));
  pendingCards.set(stemSetId, p);
  return p;
}

/** The label to show for (set, role): the owner's name, else the role. */
export function liveStemLabel(stemSetId, role) {
  const card = cards.get(stemSetId);
  const entry = card?.stems?.find?.((s) => s.name === role);
  return entry?.custom_name && text(entry.display_name) ? text(entry.display_name) : null;
}

/** Apply a card to one stem: new label, or unavailable when its role is gone. */
export function withCard(stem, card) {
  if (!card || card.stem_set_id !== stem.stemSetId) return stem;
  const entry = (card.stems || []).find((s) => s.name === stem.role);
  if (!entry) return { ...stem, available: false };
  const custom = entry.custom_name === true && Boolean(text(entry.display_name));
  return { ...stem, displayName: custom ? text(entry.display_name) : stem.role, customName: custom };
}

/**
 * Rename (or clear with null) one stem's label. Only names_json changes on the
 * server; the role, files, audio URL and set id are the same afterwards.
 */
export async function renameStem(patchJson, stem, name) {
  const card = await patchJson(`/api/stem-sets/${stem.stemSetId}/names`, { names: { [stem.role]: name } });
  publishStemCard(card);
  // A saved rename changes what a search finds: tell the views that own results.
  for (const fn of [...renameListeners]) {
    try { fn(card); } catch (err) { console.error(err); }
  }
  return card;
}

const renameListeners = new Set();

/** Called after the server accepted a rename or a cleared name (not on card loads). */
export function onStemRenamed(fn) {
  renameListeners.add(fn);
  return () => renameListeners.delete(fn);
}

// ------------------------------------------------------------ arrangement offer

let offer = null;
const offerListeners = new Set();

/**
 * The musician chose this stem for an Arrangement. Nothing plays or decodes.
 * A Stem-Focus selection travels with it as `window` {startSec, endSec}
 * (source seconds), which the Arrangement offers as the length to place.
 */
export function offerStem(stem, selection = null) {
  if (!stem?.available || !stem.audioUrl) return false;
  const span = selection && Number.isFinite(selection.startSec) && Number.isFinite(selection.endSec)
    && selection.startSec >= 0 && selection.endSec > selection.startSec
    ? Object.freeze({ startSec: selection.startSec, endSec: selection.endSec })
    : null;
  offer = Object.freeze({
    stemSetId: stem.stemSetId, role: stem.role, displayName: stem.displayName, customName: stem.customName,
    method: stem.method, modelName: stem.modelName, audioUrl: stem.audioUrl,
    trackId: stem.trackId, trackName: stem.trackName, window: span,
  });
  for (const fn of [...offerListeners]) {
    try { fn(offer); } catch (err) { console.error(err); }
  }
  return true;
}

export const stemOffer = () => offer;

export function clearStemOffer() {
  offer = null;
  for (const fn of [...offerListeners]) {
    try { fn(null); } catch (err) { console.error(err); }
  }
}

export function onStemOffer(fn) {
  offerListeners.add(fn);
  return () => offerListeners.delete(fn);
}

/** Tests only: forget cards and the offer. */
export function resetStemSleeveForTests() {
  cards.clear();
  pendingCards.clear();
  offer = null;
}

// ------------------------------------------------------------ the list widget

let listSeq = 0;

/**
 * A list of stems under one recording, with Rename, Original name and Use in
 * Arrangement. Survives being re-attached by a parent re-render (the parent
 * keeps the element), keeps focus on the same control after a rename, and
 * updates itself from the name bus.
 *
 * @param {object} o
 * @param {string} o.label       accessible name of the list
 * @param {object} o.api         {patchJson}
 * @param {(stem) => void} o.onUse  bring a stem into an Arrangement
 * @param {(msg: string) => void} [o.announce]
 * @param {boolean} [o.showReasons] show why each stem matched a search
 * @param {(stem, trigger: HTMLElement) => void} [o.onFocus] open Stem-Focus
 *   (the Focus button, Enter on it, or a double-click on the row)
 */
export function createStemList({ label, api, onUse, onFocus = null, announce = () => {}, showReasons = false, emptyText = 'No separated stems for this recording yet.' }) {
  listSeq += 1;
  const prefix = `stem-list-${listSeq}`;
  let stems = [];
  let editing = null; // stem key whose name field is open
  let busy = null;
  let statusText = '';
  let loading = false;
  let error = null;
  const ul = createElement('ul', { class: 'stem-sleeve__list', 'aria-label': label });
  const status = createElement('p', { class: 'stem-sleeve__status', role: 'status', 'aria-live': 'polite' });
  const root = createElement('div', { class: 'stem-sleeve' }, [ul, status]);

  const keyed = (key) => [...root.querySelectorAll('[data-key]')].find((el) => el.dataset.key === key) || null;

  function say(message) {
    statusText = message;
    status.textContent = message;
    announce(message);
  }

  function factsLine(stem) {
    return [
      `Role: ${roleLabel(stem.role)}`,
      methodLabel(stem.method),
      `set ${stem.stemSetId.slice(0, 8)}`,
      stem.available ? 'stem audio available' : 'stem audio missing',
    ].join(' · ');
  }

  function row(stem) {
    const id = `${prefix}-${stem.key.replace(/[^A-Za-z0-9_-]/g, '-')}`;
    const isEditing = editing === stem.key;
    const nameLine = createElement('div', { class: 'stem-sleeve__name' }, [
      roleChip(stem.role),
      createElement('strong', { class: 'stem-sleeve__label', text: stem.displayName, id: `${id}-label` }),
      createElement('span', {
        class: 'stem-sleeve__role',
        text: stem.customName ? `${roleLabel(stem.role)} stem` : 'original role name',
      }),
    ]);
    const facts = createElement('p', { class: 'stem-sleeve__facts', text: factsLine(stem) });
    const from = createElement('p', {
      class: 'stem-sleeve__from',
      text: `From the recording ${stem.trackName ? `“${stem.trackName}”` : stem.trackId || 'not recorded'}`,
    });
    const reasons = showReasons && stem.matched.length
      ? createElement('p', { class: 'stem-sleeve__why', text: `Matched by ${matchReasons(stem)}` })
      : null;
    const describedBy = `${id}-label`;
    const actions = [];
    if (!isEditing) {
      if (onFocus) {
        actions.push(createElement('button', {
          type: 'button', class: 'button button--sm stem-sleeve__focus', text: 'Focus',
          'aria-label': `Focus on ${stem.displayName} (${roleLabel(stem.role)}, ${stem.trackName || 'recording'}): audition and edit`,
          'aria-haspopup': 'dialog',
          dataset: { key: `focus:${stem.key}`, stemAction: 'focus' },
        }));
      }
      actions.push(createElement('button', {
        type: 'button', class: 'button button--sm', text: 'Rename',
        'aria-label': `Rename ${stem.displayName} (${roleLabel(stem.role)}, ${stem.trackName || 'recording'})`,
        dataset: { key: `rename:${stem.key}`, stemAction: 'rename' },
        disabled: busy || !stem.available ? 'true' : undefined,
      }));
      if (stem.customName) {
        actions.push(createElement('button', {
          type: 'button', class: 'button button--sm button--ghost', text: 'Original name',
          'aria-label': `Use the original name ${stem.role} for ${stem.displayName}`,
          dataset: { key: `clear:${stem.key}`, stemAction: 'clear' },
          disabled: busy ? 'true' : undefined,
        }));
      }
      actions.push(createElement('button', {
        type: 'button', class: 'button button--sm button--primary', text: 'Use in Arrangement',
        'aria-label': `Use ${stem.displayName} (${roleLabel(stem.role)}) in an Arrangement`,
        'aria-describedby': describedBy,
        dataset: { key: `use:${stem.key}`, stemAction: 'use' },
        disabled: stem.available ? undefined : 'true',
      }));
    }
    let form = null;
    if (isEditing) {
      const input = createElement('input', {
        class: 'input stem-sleeve__input', type: 'text', maxlength: String(STEM_NAME_LIMIT * 2),
        value: stem.customName ? stem.displayName : '',
        placeholder: roleLabel(stem.role),
        'aria-label': `New name for the ${roleLabel(stem.role)} stem of ${stem.trackName || 'this recording'}`,
        dataset: { key: `name:${stem.key}` },
      });
      form = createElement('form', { class: 'stem-sleeve__form', dataset: { stemKey: stem.key } }, [
        input,
        createElement('button', { type: 'submit', class: 'button button--sm button--primary', text: 'Save name', dataset: { key: `save:${stem.key}` } }),
        createElement('button', { type: 'button', class: 'button button--sm', text: 'Cancel', dataset: { key: `cancel:${stem.key}`, stemAction: 'cancel' } }),
      ]);
    }
    return createElement('li', {
      class: `stem-sleeve__row${stem.available ? '' : ' is-unavailable'}`,
      dataset: { stemKey: stem.key, role: stem.role, stemSetId: stem.stemSetId, roleToken: roleToken(stem.role).token },
    }, [nameLine, facts, from, reasons, actions.length ? createElement('div', { class: 'stem-sleeve__actions' }, actions) : null, form]);
  }

  function render({ focusKey = null } = {}) {
    const active = root.ownerDocument.activeElement;
    const keep = focusKey ?? (active && root.contains(active) ? active.dataset?.key ?? null : null);
    if (loading && !stems.length) replaceChildren(ul, [createElement('li', { class: 'stem-sleeve__empty', text: 'Reading the stems…' })]);
    else if (error && !stems.length) replaceChildren(ul, [createElement('li', { class: 'stem-sleeve__empty', text: error })]);
    else if (!stems.length) replaceChildren(ul, [createElement('li', { class: 'stem-sleeve__empty', text: emptyText })]);
    else replaceChildren(ul, stems.map(row));
    status.textContent = statusText;
    if (keep) {
      const target = keyed(keep);
      if (target && !target.disabled) target.focus();
      else if (keep.includes(':')) {
        // A control that is gone (Original name after clearing) hands focus
        // to the same stem's Rename.
        const fallback = keyed(`rename:${keep.slice(keep.indexOf(':') + 1)}`);
        if (fallback && !fallback.disabled) fallback.focus();
      }
    }
  }

  async function commitName(stem, value) {
    let name = null;
    if (value !== null) {
      const cleaned = cleanStemName(value);
      if (!cleaned.ok) { say(cleaned.reason); render({ focusKey: `name:${stem.key}` }); return; }
      name = cleaned.value;
    }
    busy = stem.key;
    render({ focusKey: value === null ? `clear:${stem.key}` : `name:${stem.key}` });
    try {
      await renameStem(api.patchJson, stem, name);
      editing = null;
      busy = null;
      const now = stems.find((s) => s.key === stem.key) ?? stem;
      say(name === null
        ? `${roleLabel(stem.role)} stem of ${stem.trackName || 'the recording'} uses its original name again. The audio file is unchanged.`
        : `Renamed the ${roleLabel(stem.role)} stem of ${stem.trackName || 'the recording'} to “${now.displayName}”. The audio file is unchanged.`);
      render({ focusKey: `rename:${stem.key}` });
    } catch (err) {
      busy = null;
      say(`Could not rename: ${err?.message || 'request failed'}. Nothing changed.`);
      render({ focusKey: value === null ? `clear:${stem.key}` : `name:${stem.key}` });
    }
  }

  root.addEventListener('click', (event) => {
    const button = event.target.closest?.('button[data-stem-action]');
    if (!button || !root.contains(button)) return;
    const key = button.closest('[data-stem-key]')?.dataset.stemKey;
    const stem = stems.find((s) => s.key === key);
    if (!stem) return;
    const action = button.dataset.stemAction;
    if (action === 'rename') { editing = stem.key; render({ focusKey: `name:${stem.key}` }); keyed(`name:${stem.key}`)?.select?.(); }
    else if (action === 'cancel') { editing = null; render({ focusKey: `rename:${stem.key}` }); }
    else if (action === 'clear') void commitName(stem, null);
    else if (action === 'use') onUse?.(stem);
    else if (action === 'focus') onFocus?.(stem, button);
  });
  // Desktop shortcut: double-click a stem row (not its buttons or name field).
  root.addEventListener('dblclick', (event) => {
    if (!onFocus || event.target.closest?.('button, input, form, a')) return;
    const rowEl = event.target.closest?.('[data-stem-key]');
    const stem = rowEl && stems.find((s) => s.key === rowEl.dataset.stemKey);
    if (!stem) return;
    event.preventDefault();
    onFocus(stem, keyed(`focus:${stem.key}`) ?? rowEl);
  });
  root.addEventListener('submit', (event) => {
    event.preventDefault();
    const key = event.target.dataset?.stemKey;
    const stem = stems.find((s) => s.key === key);
    const input = event.target.querySelector('input');
    if (stem && input && !busy) void commitName(stem, input.value);
  });
  root.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !editing) return;
    const key = editing;
    editing = null;
    event.stopPropagation();
    render({ focusKey: `rename:${key}` });
  });

  const unsubscribe = onStemCard((card) => {
    if (!stems.some((s) => s.stemSetId === card.stem_set_id)) return;
    stems = stems.map((s) => withCard(s, card));
    render();
  });

  return {
    el: root,
    setStems(next) {
      stems = next.map((s) => withCard(s, cachedStemCard(s.stemSetId)));
      loading = false;
      error = null;
      if (editing && !stems.some((s) => s.key === editing)) editing = null;
      render();
    },
    setLoading(value) { loading = Boolean(value); render(); },
    setError(message) { error = message; loading = false; render(); },
    stems: () => stems.slice(),
    dispose() { unsubscribe(); root.remove(); },
  };
}
