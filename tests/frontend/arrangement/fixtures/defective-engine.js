// tests/frontend/arrangement/fixtures/defective-engine.js — an intentionally
// defective implementation of split correspondence, used as a negative
// control (OPERATION ALL THE TIME IN THE WORLD, §11: "Include tests that fail
// on an intentionally defective implementation").
//
// The defect is the classic stretch-rate bug: the second half's source offset
// advances at the timeline rate instead of the clip's source-advance rate, so
// every split on a stretched clip loses or gains source time.

import { EditEngine } from '../../../../src/twobecomeone/studio_static/js/arrangement/edit-api.js';
import { cloneState } from '../../../../src/twobecomeone/studio_static/js/arrangement/project-state.js';

export class DefectiveEngine extends EditEngine {
  splitClipAtBeat(clipId, splitBeat) {
    const result = super.splitClipAtBeat(clipId, splitBeat);
    // Recompute the right half's source offset the wrong way: no rate applied.
    const draft = cloneState(this.state);
    const clip = draft.clips.find((c) => c.id === clipId);
    const right = draft.clips.find((c) => c.id === result.rightId);
    const rel = splitBeat - clip.timelineStartBeat;
    const deltaSource = rel * (60 / draft.transport.masterBpm);
    right.sourceOffsetSec = clip.sourceOffsetSec + deltaSource;
    // A real defect would commit without noticing; bypass validation the same way.
    this._state = draft;
    return result;
  }
}
