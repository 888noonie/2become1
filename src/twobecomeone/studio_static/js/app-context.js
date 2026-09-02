// js/app-context.js — shared application singletons.
//
// Kept in a leaf module (imported by app.js and components alike) so there is
// no import cycle between app.js and views/components that need the store or
// the ProjectManager. Both are constructed here once and injected into views.

import { StateStore, registerReducers } from './state.js';
import { ProjectManager } from './project.js';
import { JobCoordinator } from './job-coordinator.js';
import { GhostController } from './runtime/ghost-controller.js';
import { CommittedLayerEngine } from './runtime/committed-layer-engine.js';
import { audioController } from './audio.js';
import {
  postProjectAction,
  postProposalLifecycle,
  getActionState,
  buildPreviewAction,
  buildRejectAction,
  buildCommitAction,
  buildRevertAction,
  buildLifecycleBody,
} from './api.js';

export const store = registerReducers(new StateStore());
// Phase 10B: app-scoped Ghost preview controller, constructed BEFORE the
// ProjectManager (which receives it for the A8 hydration/switch boundaries).
// Views never import it directly; the visible Ghost card reads the store's
// ghostStatus slice. The AudioContext factory lives here so the context is
// only created inside an explicit Preview/Retry gesture in the controller.
export const ghostController = new GhostController({
  store,
  api: {
    postProjectAction,
    postProposalLifecycle,
    getActionState,
    buildPreviewAction,
    buildRejectAction,
    buildCommitAction,
    buildRevertAction,
    buildLifecycleBody,
  },
  // A7 ownership proof: the controller reads the REAL singleton player so it
  // can verify the current track is the project's Lead and is audibly playing.
  audioController,
  audioContextFactory: {
    create: () => new AudioContext(),
  },
  // Phase 12: the live committed-layer engine is built lazily by the
  // controller (only when an authoritative projection holds a committed
  // layer), sharing the controller's AudioContext and injected timers.
  liveEngineFactory: (deps) => new CommittedLayerEngine(deps),
});
export const projectManager = new ProjectManager(store, { ghostController });
export const jobCoordinator = new JobCoordinator(store);
