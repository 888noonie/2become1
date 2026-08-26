// js/app.js — boot, routing, capability load, and global wiring.
//
// Phase 4.2/4.4: loads as a native ES module. Wires the StateStore, Router,
// AudioController, and the active-job badge.

import { Router } from './router.js';
import { audioController } from './audio.js';
import { closeAllMonitors, getHealth, listJobs, listTracks } from './api.js';
import { jobCoordinator, store, projectManager } from './app-context.js';
import { mountStudio } from './views/studio.js';
import { mountLibrary } from './views/library.js';
import { mountActivity } from './views/activity.js';
import { mountEngine } from './views/engine.js';

const container = document.getElementById('main');

const views = {
  studio: mountStudio,
  library: mountLibrary,
  activity: mountActivity,
  engine: mountEngine,
};

const router = new Router({ store, container, views });
jobCoordinator.start();

// ---- Active-job badge ----
const badge = document.getElementById('active-badge');

function updateBadge(jobs) {
  const count = jobs.activeCount;
  badge.textContent = String(count);
  badge.hidden = count === 0;
}

// ---- Now-playing footer ----
const nowPlaying = document.getElementById('now-playing');
const nowPlayingTitle = document.getElementById('now-playing-title');

function updateNowPlaying() {
  const state = store.getState();
  const playback = state.playback;
  if (playback.trackId || playback.source?.jobId) {
    const source = playback.source;
    // Render/preview results carry a server-authored safe title; tracks fall
    // back to the library display name.
    let title = source?.title || null;
    if (!title && playback.trackId) {
      const track = state.library.items.find((t) => t.id === playback.trackId);
      title = track ? track.name : 'Playing';
    }
    nowPlayingTitle.textContent = title || 'Playing';
    nowPlaying.hidden = false;
  } else {
    nowPlaying.hidden = true;
  }
}

// ---- Audio events -> store ----
audioController.on((type, payload) => {
  if (type === 'play') {
    store.dispatch({
      type: 'playback/set',
      trackId: payload.trackId,
      source: {
        trackId: payload.trackId,
        kind: payload.kind || 'track',
        stemName: payload.stemName || null,
        variant: payload.variant || 'full',
        url: payload.url || null,
        jobId: payload.jobId || null,
        title: payload.title || null,
      },
      playing: true,
      error: null,
    });
  } else if (type === 'pause') {
    store.dispatch({ type: 'playback/set', playing: false });
  } else if (type === 'time') {
    store.dispatch({ type: 'playback/set', time: payload });
  } else if (type === 'duration') {
    store.dispatch({ type: 'playback/set', duration: payload });
  } else if (type === 'error') {
    store.dispatch({ type: 'playback/set', error: payload.message });
  } else if (type === 'stop') {
    store.dispatch({
      type: 'playback/set',
      trackId: null,
      source: null,
      playing: false,
      time: 0,
    });
  }
});

// ---- Boot ----
store.subscribeSlice('jobs', updateBadge);
store.subscribeSlice('playback', updateNowPlaying);
store.subscribeSlice('library', updateNowPlaying);

async function boot() {
  // Load health and initial job counts (non-blocking).
  try {
    const health = await getHealth();
    store.dispatch({ type: 'health/set', health });
  } catch (err) {
    console.error('health load failed', err);
  }
  try {
    const data = await listJobs({ limit: 100 });
    const items = data.items || data.jobs || [];
    const activeCount = items.filter((j) => j.status === 'queued' || j.status === 'running').length;
    store.dispatch({ type: 'jobs/set', items, total: items.length, activeCount });
    jobCoordinator.restore(items);
  } catch (err) {
    console.error('jobs load failed', err);
  }
  try {
    // Prime the shared library so the Studio source picker can offer existing
    // tracks before the user has visited the Library route.
    const data = await listTracks({ limit: 50, status: 'active', sort: 'created' });
    store.dispatch({
      type: 'library/set',
      items: data.items, total: data.total, limit: data.limit, offset: data.offset,
    });
  } catch (err) {
    console.error('library preload failed', err);
  }
  // Load/create the persisted project after the library is primed so deck
  // resolution can fall back to per-track fetches when needed.
  await projectManager.boot();
}

router.start();
boot();

function teardown() {
  router.stop();
  jobCoordinator.dispose();
  closeAllMonitors();
  audioController.stop();
}

window.addEventListener('beforeunload', teardown, { once: true });
