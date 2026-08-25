// views/studio.js — Studio view (Phase 5 placeholder + minimal slot summary).
//
// Phase 4.4: the Studio route contains only a Phase 5 placeholder and a minimal
// project-slot summary/Choose action. It must not grow into deck controls.

import { createElement } from '../dom.js';
import { openSourcePicker } from '../components/source-picker.js';

export function mountStudio({ store, container }) {
  const render = (state) => {
    const project = state.currentProject || { anchor_track_id: null, lead_track_id: null };

    const hero = createElement('div', { class: 'studio-placeholder__hero' }, [
      createElement('h1', {}, [
        'Two tracks.',
        createElement('br'),
        createElement('span', { text: 'One electric moment.' }),
      ]),
      createElement('p', { class: 'hero-copy', text: 'Choose a foundation and a lead to begin. Full deck controls arrive in a later phase.' }),
    ]);

    const anchorTrack = findTrack(state, project.anchor_track_id);
    const leadTrack = findTrack(state, project.lead_track_id);

    const anchorCard = slotCard('anchor', 'Foundation', anchorTrack, () => openSourcePicker(store, 'anchor'));
    const leadCard = slotCard('lead', 'Lead', leadTrack, () => openSourcePicker(store, 'lead'));

    const summary = createElement('div', { class: 'slot-summary' }, [anchorCard, leadCard]);

    container.replaceChildren(
      createElement('div', { class: 'studio-placeholder' }, [hero, summary]),
    );
  };

  const slotCard = (slot, label, track, onChoose) => {
    const title = createElement('div', { class: 'slot-card__title', text: label });
    const trackEl = createElement('div', {
      class: 'slot-card__track',
      text: track ? track.name : 'No track selected',
    });
    const chooseBtn = createElement('button', {
      class: 'button', type: 'button',
      text: track ? 'Change' : 'Choose',
      onclick: onChoose,
    });
    return createElement('div', { class: `slot-card slot-card--${slot}` }, [title, trackEl, chooseBtn]);
  };

  const findTrack = (state, trackId) => {
    if (!trackId) return null;
    return state.library.items.find((t) => t.id === trackId) || null;
  };

  const refresh = () => render(store.getState());
  const unsubscribeProject = store.subscribeSlice('currentProject', refresh);
  const unsubscribeLibrary = store.subscribeSlice('library', refresh);
  render(store.getState());

  return () => {
    unsubscribeProject();
    unsubscribeLibrary();
  };
}
