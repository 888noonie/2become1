// js/app-context.js — shared application singletons.
//
// Kept in a leaf module (imported by app.js and components alike) so there is
// no import cycle between app.js and views/components that need the store or
// the ProjectManager. Both are constructed here once and injected into views.

import { StateStore, registerReducers } from './state.js';
import { ProjectManager } from './project.js';

export const store = registerReducers(new StateStore());
export const projectManager = new ProjectManager(store);
