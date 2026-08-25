// js/project.js — persistent project lifecycle and serialized autosave.
//
// Phase 5 (Task 2): loads or creates `Untitled mix` at boot, resolves the two
// deck tracks by ID (even when they are not on the first Library page),
// persists ordinary edits as Last-Write-Wins PATCHes, and serializes network
// saves so an older response can never overwrite a newer local edit. Timers
// and in-flight requests live outside application state; the store only
// carries serializable save status and pending field names.

import {
  createProject,
  deleteProject,
  getProject,
  getTrack,
  listProjects,
  patchProject,
} from './api.js';

const DEBOUNCE_MS = 500;

export class ProjectManager {
  /** @param {import('./state.js').StateStore} store */
  constructor(store) {
    this.store = store;
    this._timer = null;      // debounce timer (not state)
    this._dirty = {};        // coalesced fields awaiting save (not state)
    this._inflight = null;   // { controller } of the active PATCH (not state)
    this._queued = false;    // a save was requested while one was in flight
    this._trackRequests = new Map(); // trackId -> AbortController
  }

  /** Load the most recently updated project, or create `Untitled mix`. */
  async boot() {
    let project = null;
    try {
      const page = await listProjects({ limit: 20 });
      this.store.dispatch({
        type: 'projects/set', items: page.items, total: page.total,
      });
      project = page.items[0] || null;
    } catch (err) {
      console.error('project list failed', err);
    }
    if (!project) {
      try {
        project = await createProject('Untitled mix');
        this.store.dispatch({
          type: 'projects/set', items: [project], total: 1,
        });
      } catch (err) {
        console.error('project create failed', err);
        return;
      }
    }
    this.store.dispatch({ type: 'project/set', project });
    await this.resolveDecks(project);
  }

  /** Fetch and cache the project list for the switcher. */
  async refreshList() {
    try {
      const page = await listProjects({ limit: 20 });
      this.store.dispatch({
        type: 'projects/set', items: page.items, total: page.total,
      });
      return page.items;
    } catch (err) {
      console.error('project refresh failed', err);
      return [];
    }
  }

  /** Resolve both deck tracks by ID; missing/trashed tracks get null. */
  async resolveDecks(project) {
    const ids = [project.anchor_track_id, project.lead_track_id].filter(Boolean);
    await Promise.all(ids.map(async (trackId) => {
      const controller = new AbortController();
      const previous = this._trackRequests.get(trackId);
      if (previous) previous.abort();
      this._trackRequests.set(trackId, controller);
      try {
        const track = await getTrack(trackId, controller.signal);
        this.store.dispatch({ type: 'deckTrack/set', trackId, track });
      } catch (err) {
        if (err && err.name === 'AbortError') return;
        // Explicit recoverable state: show the deck as missing; never
        // silently substitute another track.
        this.store.dispatch({ type: 'deckTrack/set', trackId, track: null });
      } finally {
        if (this._trackRequests.get(trackId) === controller) {
          this._trackRequests.delete(trackId);
        }
      }
    }));
  }

  /**
   * Queue a debounced, serialized save of the given project fields.
   * Applies an optimistic local patch immediately so the UI never appears to
   * lag behind user input. Network responses are authoritative only for the
   * fields they actually wrote.
   */
  save(fields) {
    if (!this.store.getState().currentProject?.id) return;
    // Optimistic local patch first so controls reflect the change instantly.
    this.store.dispatch({ type: 'project/patch-local', fields });
    Object.assign(this._dirty, fields);
    this._publishDirty();
    if (this._inflight) {
      // A flush is already in flight; its continuation reschedules a 0ms flush
      // to pick up these newly-dirty fields. Do not start a second debounce
      // timer here — it would be orphaned when the in-flight flush overwrites
      // this._timer, causing a spurious extra request after the test/teardown.
      return;
    }
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => this._flush(), DEBOUNCE_MS);
  }

  _publishDirty() {
    this.store.dispatch({
      type: 'save/status',
      status: 'saving',
      pending: Object.keys(this._dirty),
      error: null,
    });
  }

  /**
   * Serialize network saves: never overlap requests, and never let an older
   * response clobber newer local edits. On success the server response is
   * merged, but any field re-edited while the PATCH was in flight keeps its
   * newer local value. On failure the user's unsaved edits stay visible and
   * are offered for retry.
   */
  async _flush() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (this._inflight) { this._queued = true; return; }
    const fields = { ...this._dirty };
    this._dirty = {};
    const project = this.store.getState().currentProject;
    if (!project?.id || Object.keys(fields).length === 0) {
      this.store.dispatch({
        type: 'save/status',
        status: 'saved',
        pending: [],
        error: null,
      });
      return;
    }
    const controller = new AbortController();
    this._inflight = { controller, fields };
    this._publishDirty();
    try {
      const saved = await patchProject(project.id, fields, controller.signal);
      const current = this.store.getState().currentProject;
      // Reconcile against fields re-edited while this PATCH was in flight.
      // A field that is dirty again carries a newer local value that must win
      // over the (older) server response. This is timestamp-independent: the
      // optimistic patch does not advance updated_at, so comparing timestamps
      // would wrongly accept a stale response.
      const reconciled = { ...saved };
      let keptLocal = false;
      for (const key of Object.keys(fields)) {
        if (
          key !== 'id' &&
          key !== 'updated_at' &&
          Object.prototype.hasOwnProperty.call(this._dirty, key)
        ) {
          reconciled[key] = current[key];
          keptLocal = true;
        }
      }
      if (keptLocal) {
        // The server's updated_at reflects the older write; keep the local one
        // so the newer (still-unsaved) edit is not mislabelled as persisted.
        reconciled.updated_at = current.updated_at;
      }
      this.store.dispatch({ type: 'project/set', project: reconciled });
      this.store.dispatch({
        type: 'save/status',
        status: Object.keys(this._dirty).length ? 'saving' : 'saved',
        pending: Object.keys(this._dirty),
        error: null,
        lastError: null,
      });
    } catch (err) {
      if (err && err.name === 'AbortError') {
        // A newer save superseded this one; requeue so nothing is lost.
        this._dirty = { ...fields, ...this._dirty };
      } else {
        // Restore the failed fields so the retry sends them; keep edits visible.
        this._dirty = { ...fields, ...this._dirty };
        this.store.dispatch({
          type: 'save/status',
          status: 'error',
          pending: Object.keys(this._dirty),
          error: null,
          lastError: err.message || 'Save failed',
        });
        this._needsRetry = true;
      }
    } finally {
      this._inflight = null;
    }
    this._queued = false;
    // Continue flushing only when the last save succeeded; after a failure
    // the pending fields stay visible until retry().
    if (!this._needsRetry && Object.keys(this._dirty).length > 0) {
      this._timer = setTimeout(() => this._flush(), 0);
    }
  }

  /** Explicit user retry after a failed save. */
  async retry() {
    if (Object.keys(this._dirty).length === 0) return;
    this._needsRetry = false;
    this.store.dispatch({ type: 'save/status', status: 'saving', lastError: null });
    await this._flush();
  }

  /** Flush any pending edits without waiting for the debounce window. */
  async flushNow() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (Object.keys(this._dirty).length > 0) {
      await this._flush();
    }
    if (this._inflight) {
      // Wait briefly for the in-flight request to settle.
      for (let i = 0; i < 100 && this._inflight; i += 1) {
        await new Promise((r) => setTimeout(r, 50));
      }
      if (Object.keys(this._dirty).length > 0) await this._flush();
    }
  }

  /**
   * Swap the two decks as one project save: track IDs, variants, cues, and
   * role gains move together. Role colors themselves remain fixed.
   */
  swap() {
    const project = this.store.getState().currentProject;
    if (!project?.id) return;
    const s = project.settings || {};
    const settings = {
      ...s,
      anchor_start: s.lead_start ?? 0,
      lead_start: s.anchor_start ?? 0,
      anchor_gain: s.lead_gain ?? 0.8,
      lead_gain: s.anchor_gain ?? 0.8,
    };
    const fields = {
      anchor_track_id: project.lead_track_id,
      lead_track_id: project.anchor_track_id,
      anchor_variant: project.lead_variant,
      lead_variant: project.anchor_variant,
      settings,
    };
    // Local optimistic patch so the UI reflects the swap immediately.
    this.store.dispatch({ type: 'project/patch-local', fields });
    this.save(fields);
    // Re-resolve both decks for their (now swapped) track records.
    this.resolveDecks({ ...project, ...fields });
  }

  /** Clear one deck (track + variant) as a single save. */
  clear(slot) {
    const project = this.store.getState().currentProject;
    if (!project?.id) return;
    const fields = slot === 'anchor'
      ? { anchor_track_id: null, anchor_variant: null }
      : { lead_track_id: null, lead_variant: null };
    this.store.dispatch({ type: 'project/patch-local', fields });
    this.save(fields);
  }

  /** Assign a track to a deck (Choose/Replace). Never disturbs the other deck. */
  assign(slot, trackId) {
    const project = this.store.getState().currentProject;
    if (!project?.id) return;
    // Assignment resets the slot variant to the full mix: the previous stem
    // may not exist on the newly assigned track.
    const fields = slot === 'anchor'
      ? { anchor_track_id: trackId, anchor_variant: 'full' }
      : { lead_track_id: trackId, lead_variant: 'full' };
    this.store.dispatch({ type: 'project/patch-local', fields });
    this.save(fields);
    this.resolveDecks({ ...project, ...fields });
  }

  /** Rename the current project. */
  rename(name) {
    const project = this.store.getState().currentProject;
    if (!project?.id) return;
    this.store.dispatch({ type: 'project/patch-local', fields: { name } });
    this.save({ name });
  }

  /** Create a fresh project and switch to it. */
  async newProject(name = 'Untitled mix') {
    await this.flushNow();
    const project = await createProject(name);
    await this.refreshList();
    this.store.dispatch({ type: 'project/set', project });
    await this.resolveDecks(project);
    this.store.dispatch({ type: 'save/status', status: 'idle', pending: [], lastError: null });
    return project;
  }

  /** Switch to an existing project by ID. */
  async switchTo(projectId) {
    await this.flushNow();
    const current = this.store.getState().currentProject;
    if (current?.id === projectId) return current;
    const project = await getProject(projectId);
    this.store.dispatch({ type: 'project/set', project });
    await this.resolveDecks(project);
    this.store.dispatch({ type: 'save/status', status: 'idle', pending: [], lastError: null });
    return project;
  }

  /**
   * Delete a project (already confirmed by the caller). Never deletes tracks.
   * If the active project was deleted, switch to the next most recent one or
   * create a fresh Untitled mix.
   */
  async delete(projectId) {
    await deleteProject(projectId);
    const state = this.store.getState();
    if (state.currentProject?.id === projectId) {
      const page = await this.refreshList();
      const next = page.find((p) => p.id !== projectId);
      if (next) {
        this.store.dispatch({ type: 'project/set', project: next });
        await this.resolveDecks(next);
      } else {
        await this.newProject();
        return;
      }
    } else {
      await this.refreshList();
    }
  }
}
