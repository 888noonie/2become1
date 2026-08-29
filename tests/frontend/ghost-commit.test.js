// Phase 11A/11C visible Commit and serialized Undo coverage.

import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, teardownDom } from './helpers/dom.js';

import { GhostController } from '../../src/twobecomeone/studio_static/js/runtime/ghost-controller.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

class Store {
  constructor() {
    this.state = {
      currentProject: { id: 'p1' },
      proposals: { byId: { a1: { id: 'a1', lifecycle: 'auditioning' } }, order: ['a1'], activeIds: ['a1'] },
      session: { deckAssignments: {}, committedLayers: [], revertedLayers: [], acceptedActionIds: [] },
      ghostStatus: { phase: 'auditioning', error: null },
    };
  }
  getState() { return structuredClone(this.state); }
  dispatch(action) {
    if (action.type === 'v1/ghost-status/set') this.state.ghostStatus = { ...this.state.ghostStatus, ...structuredClone(action.patch) };
    if (action.type === 'v1/hydrate-projection') {
      this.state.session = structuredClone(action.projection.session);
      this.state.proposals = structuredClone(action.projection.proposals);
    }
    if (action.type === 'v1/commit/reverted') {
      const layer = this.state.session.committedLayers.find((item) => item.actionId === action.commitActionId);
      this.state.session.committedLayers = this.state.session.committedLayers.filter((item) => item.actionId !== action.commitActionId);
      if (layer) this.state.session.revertedLayers.push({ ...layer, revertedBy: action.revertActionId });
    }
  }
}

function controllerFixture() {
  const store = new Store();
  const gate = deferred();
  const posts = [];
  const committedLayer = { actionId: 'commit-1', proposalId: 'a1' };
  const api = {
    buildCommitAction: () => ({ id: 'commit-1', type: 'commit_layer', payload: {} }),
    buildRevertAction: () => ({ id: 'undo-1', type: 'revert_commit', payload: { commitActionId: 'commit-1' } }),
    postProjectAction: async (_projectId, action) => {
      posts.push(action);
      if (action.type === 'commit_layer') await gate.promise;
      return { outcome: { result: action.type === 'commit_layer' ? 'proposal_committed' : 'commit_reverted' } };
    },
    getActionState: async () => ({
      last_sequence: 2,
      session: { deckAssignments: {}, committedLayers: [committedLayer], revertedLayers: [], acceptedActionIds: ['commit-1'] },
      proposals: { byId: { a1: { id: 'a1', lifecycle: 'accepted', committedActionId: 'commit-1' } }, order: ['a1'], activeIds: [] },
    }),
  };
  const controller = new GhostController({
    store, api, audioContextFactory: { create: () => ({}) },
  });
  controller._gen = {
    projectId: 'p1', proposalId: 'a1',
    asset: { id: 'ga-1', contentHash: 'sha256:x', transformSpec: {} },
  };
  return { store, gate, posts, controller };
}

test('double Commit shares one POST and Release cannot race it', async () => {
  const { gate, posts, controller } = controllerFixture();
  const first = controller.commit();
  const second = controller.commit();
  const release = controller.release();
  assert.equal(posts.filter((a) => a.type === 'commit_layer').length, 1);
  gate.resolve();
  assert.equal((await first).ok, true);
  assert.equal((await second).ok, true);
  assert.equal((await release).code, 'ALREADY_COMMITTED');
  assert.equal(posts.filter((a) => a.type === 'reject_proposal').length, 0);
});

test('double Undo shares one envelope and one POST', async () => {
  const { store, posts, controller } = controllerFixture();
  store.state.session.committedLayers = [{ actionId: 'commit-1' }];
  const first = controller.revert('commit-1');
  const second = controller.revert('commit-1');
  assert.equal((await first).ok, true);
  assert.equal((await second).ok, true);
  assert.equal(posts.filter((a) => a.type === 'revert_commit').length, 1);
  assert.equal(store.state.session.revertedLayers.length, 1);
});

test('committed layer view requires confirmation and disables Undo in flight', async () => {
  const dom = setupDom();
  try {
    const { StateStore, registerReducers } = await import('../../src/twobecomeone/studio_static/js/state.js');
    const { mountCommittedLayers } = await import('../../src/twobecomeone/studio_static/js/components/committed-layers.js');
    const store = registerReducers(new StateStore());
    store.dispatch({ type: 'v1/hydrate-projection', projection: {
      session: {
        deckAssignments: {}, acceptedActionIds: ['commit-1'], revertedLayers: [],
        committedLayers: [{
          actionId: 'commit-1', sourceRegionRef: { startBeat: 0, endBeat: 8 },
          placement: { gainDb: -3 }, launchReceipt: { launchBeat: 16 },
        }],
      },
      proposals: { byId: {}, order: [], activeIds: [] },
    } });
    const gate = deferred();
    let calls = 0;
    const dispose = mountCommittedLayers({
      container: document.getElementById('main'), store,
      onUndo: async () => { calls += 1; await gate.promise; return { ok: true }; },
    });
    const button = document.querySelector('button[aria-label="Undo committed Ghost 1"]');
    assert.ok(button);
    button.click();
    assert.equal(calls, 0, 'confirmation comes before the durable write');
    const confirm = [...document.querySelectorAll('dialog button')].find((item) => item.textContent === 'Undo Ghost');
    confirm.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(calls, 1);
    const busyButton = document.querySelector('button[aria-label="Undo committed Ghost 1"]');
    assert.equal(busyButton.disabled, true);
    busyButton.click();
    assert.equal(calls, 1);
    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    dispose();
  } finally {
    teardownDom(dom);
  }
});
