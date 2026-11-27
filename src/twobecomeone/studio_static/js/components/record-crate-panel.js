// js/components/record-crate-panel.js — The Crate (record-crate), first slice.
//
// Searches Library tracks, shows what each one is and whether it is selected
// or loaded in Bank A or B, and offers Choose, Load and Separate stems. It owns
// no audio: Choose and Load go through the Performance desk's bridge, which
// uses the desk's own selector change and Load handler. Nothing is fetched
// until the Crate is first shown.

import { createElement, replaceChildren } from '../dom.js';
import {
  CRATE_PAGE_SIZE, bankStates, formatDuration, formatKey, sourceLabel,
  stemState, summaryLine, separateAvailability, separationActive,
} from '../record-crate.js';
import {
  createStemList, onStemRenamed, offerStem, roleLabel, stemsFromVariants,
} from '../stem-sleeve.js';
import { openStemFocus } from '../stem-focus.js';

const GROUP_IDS = ['A', 'B'];
const SEARCH_DELAY_MS = 250;
let instance = 0;

export function mountRecordCrate({
  container,
  source,
  bridge,
  onAnnounce = null,
  searchDelayMs = SEARCH_DELAY_MS,
  onUseStem = null,
} = {}) {
  if (!container) throw new Error('mountRecordCrate requires a container');
  if (!source || !bridge) throw new Error('mountRecordCrate requires a source and a desk bridge');
  instance += 1;
  const prefix = `record-crate-${instance}`;

  const searchInput = createElement('input', {
    id: `${prefix}-search`,
    class: 'input record-crate__search',
    type: 'search',
    autocomplete: 'off',
    spellcheck: 'false',
    placeholder: 'Search your Library',
    'aria-describedby': `${prefix}-scope`,
  });
  const toolbar = createElement('div', { class: 'record-crate__toolbar' });
  const scope = createElement('p', {
    id: `${prefix}-scope`,
    class: 'record-crate__scope',
    text: 'Library tracks only. Choosing a track does not play or load it.',
  });
  const status = createElement('p', { class: 'record-crate__status', role: 'status', 'aria-live': 'polite' });
  const list = createElement('ul', { class: 'record-crate__list', 'aria-label': 'Library results' });
  const more = createElement('button', {
    class: 'button button--sm record-crate__more', type: 'button', text: 'Show more', hidden: 'true',
  });
  const root = createElement('div', { class: 'record-crate', dataset: { state: 'idle' } }, [
    createElement('div', { class: 'record-crate__head' }, [
      createElement('label', { class: 'record-crate__label', for: searchInput.id, text: 'Search the Library' }),
      toolbar,
    ]),
    searchInput,
    scope,
    status,
    list,
    more,
  ]);
  container.appendChild(root);

  let items = [];
  let total = 0;
  let query = '';
  let activated = false;
  let disposed = false;
  let searchTimer = null;
  let searchController = null;
  let searchSeq = 0;
  let mirrorDesk = false;
  const expanded = new Set();
  const jobWatches = new Map();
  const submitting = new Set();
  // Where focus goes back to after a control it was on is re-rendered or
  // disabled (Load disables every Load until the desk settles).
  let pendingFocusKey = null;
  let session = bridge.session();
  let lastLoading = session.loading;
  let crateLoad = null;
  // OPERATION OPEN THE RECORD SLEEVES: stem lists are kept per track so a
  // re-render re-attaches the same list (open, focused, mid-rename).
  const matchLists = new Map(); // track id → {list, source}
  const sleeves = new Map(); // track id → {list, loaded}
  const stemApi = { patchJson: source.patchJson };
  function useStem(stem) {
    if (onUseStem) { onUseStem(stem); return; }
    if (!offerStem(stem)) {
      announce('That stem’s audio is not available, so it cannot be placed.');
      return;
    }
    announce(`${stem.displayName} (${roleLabel(stem.role)}, from ${stem.trackName || 'its recording'}) is ready in the Arrangement. Choose a lane and a bar there; nothing plays until you press Play.`);
    window.location.hash = '#/studio/arrangement';
  }
  // OPERATION STUDIO SURGEON: the shared Stem-Focus panel, in asset mode.
  function focusStem(stem, trigger) {
    openStemFocus({
      mode: 'asset', stem, trigger, announce: (m) => { try { onAnnounce?.(m); } catch { /* a viewer */ } },
      api: { patchJson: source.patchJson, fetchJson: source.fetchJson },
      onPlace: (s, span) => {
        if (onUseStem) { onUseStem(s, span); return true; }
        if (!offerStem(s, span)) { announce('That stem’s audio is not available, so it cannot be placed.'); return false; }
        announce(`${s.displayName}: the selection is ready in the Arrangement. Choose a lane and a bar there; nothing plays until you press Play.`);
        window.location.hash = '#/studio/arrangement';
        return true;
      },
    });
  }
  function stemList(map, item, extra) {
    let entry = map.get(item.trackId);
    if (!entry) {
      entry = {
        list: createStemList({
          label: extra.label, api: stemApi, onUse: useStem, onFocus: focusStem, showReasons: extra.showReasons,
          announce: (message) => { try { onAnnounce?.(message); } catch { /* a viewer */ } },
          emptyText: extra.emptyText,
        }),
        ...extra.state,
      };
      map.set(item.trackId, entry);
    }
    return entry;
  }
  async function loadSleeve(item, entry) {
    if (typeof source.listStems !== 'function') {
      entry.list.setError('Stem details are not available here.');
      return;
    }
    entry.loaded = 'loading';
    entry.list.setLoading(true);
    try {
      const response = await source.listStems(item.trackId);
      if (disposed || !sleeves.has(item.trackId)) return;
      entry.list.setStems(stemsFromVariants(response, { trackId: item.trackId, trackName: item.name }));
      entry.loaded = 'yes';
    } catch (err) {
      entry.loaded = null;
      entry.list.setError(`Could not read the stems: ${err?.message || 'request failed'}`);
    }
  }

  function announce(message, { live = true } = {}) {
    status.textContent = message;
    if (!live) return;
    try { onAnnounce?.(message); } catch { /* a listener is a viewer */ }
  }

  function rowFor(trackId) {
    return items.find((item) => item.trackId === trackId) || null;
  }

  function bankFor(groupId) {
    return session.banks?.[groupId] || {};
  }

  function loadReason(item, groupId) {
    const bank = bankFor(groupId);
    if (session.loading) return `Bank ${session.loading} is loading. Wait for it to finish.`;
    if (item.stems.readiness === 'none') return 'No stems yet. Separate stems first.';
    if (!item.actions.includes(`choose_${groupId}`)) return `This track is unavailable for bank ${groupId}.`;
    if (bank.selectedTrackId !== item.trackId) return `Choose it for ${groupId} first.`;
    if (separationActive(item) || submitting.has(item.trackId)) return 'Separation is still running.';
    return null;
  }

  function badge(text, kind) {
    return createElement('span', { class: `record-crate__badge record-crate__badge--${kind}`, text });
  }

  function detailRow(term, value) {
    return [createElement('dt', { text: term }), createElement('dd', { text: value })];
  }

  function stemDetail({ stems }) {
    if (stems.readiness === 'center_sides') return 'Center/sides channel split. These are not vocal or instrument stems.';
    if (stems.readiness === 'none') return 'None yet';
    return `Available roles: ${stems.roles.join(', ')}`;
  }

  function duplicateDetails(duplicates) {
    return [
      ...(duplicates.exactContent.length ? detailRow('Exact-content matches', String(duplicates.exactContent.length)) : []),
      ...(duplicates.sameSource.length ? detailRow('Same source', String(duplicates.sameSource.length)) : []),
      ...(duplicates.possibleVersions.length
        ? detailRow('Possible versions', duplicates.possibleVersions.map((version) => version.name || version.track_id).join(', '))
        : []),
    ];
  }

  function renderItem(item) {
    const state = stemState(item);
    const banks = bankStates(item.trackId, session);
    const open = expanded.has(item.trackId);
    const detailsId = `${prefix}-details-${item.trackId}`;
    const summary = summaryLine(item);

    const toggle = createElement('button', {
      type: 'button',
      class: 'record-crate__item',
      'aria-expanded': String(open),
      'aria-controls': detailsId,
      dataset: { key: `item-${item.trackId}`, trackId: item.trackId },
    }, [
      createElement('img', {
        class: 'record-crate__art', src: item.artworkUrl, alt: '', width: '40', height: '40', loading: 'lazy', decoding: 'async',
      }),
      createElement('span', { class: 'record-crate__text' }, [
        createElement('span', { class: 'record-crate__title', text: item.name }),
        createElement('span', { class: 'record-crate__summary', text: summary }),
        createElement('span', { class: 'record-crate__badges' }, [
          ...banks.map((bank) => badge(bank.label, `${bank.code}-${bank.groupId.toLowerCase()}`)),
          badge(state.label, state.code),
        ]),
      ]),
    ]);

    const actions = [];
    for (const groupId of GROUP_IDS) {
      const bank = bankFor(groupId);
      const selected = bank.selectedTrackId === item.trackId;
      const canChoose = item.actions.includes(`choose_${groupId}`) && session.loading !== groupId;
      const choose = createElement('button', {
        type: 'button',
        class: `button button--sm record-crate__choose record-crate__choose--${groupId.toLowerCase()}`,
        text: selected ? `Selected for ${groupId}` : `Choose for ${groupId}`,
        'aria-label': `${selected ? 'Selected' : 'Choose'} for ${groupId}, ${item.name}`,
        'aria-pressed': String(selected),
        dataset: { key: `choose-${groupId}-${item.trackId}` },
        disabled: canChoose ? undefined : 'true',
      });
      choose.addEventListener('click', () => { void onChoose(item, groupId); });
      const reason = loadReason(item, groupId);
      const load = createElement('button', {
        type: 'button',
        class: `button button--sm button--primary record-crate__load record-crate__load--${groupId.toLowerCase()}`,
        text: `Load ${groupId}`,
        'aria-label': `Load ${groupId}, ${item.name}`,
        'aria-describedby': `${detailsId}-load-${groupId}`,
        dataset: { key: `load-${groupId}-${item.trackId}` },
        disabled: reason ? 'true' : undefined,
      });
      load.addEventListener('click', () => onLoad(item, groupId, load));
      actions.push(createElement('div', { class: 'record-crate__bank', dataset: { group: groupId } }, [
        choose,
        load,
        createElement('p', {
          id: `${detailsId}-load-${groupId}`,
          class: 'record-crate__reason',
          text: reason || (bank.loadedTrackId === item.trackId
            ? `On ${groupId}. Load ${groupId} reloads it and stops playback.`
            : `Load ${groupId} stops playback.`),
        }),
      ]));
    }
    const separation = submitting.has(item.trackId)
      ? { enabled: false, label: 'Requesting separation…', reason: null }
      : separateAvailability(item);
    const separate = createElement('button', {
      type: 'button',
      class: 'button button--sm record-crate__separate',
      text: separation.label,
      'aria-label': `${separation.label}, ${item.name}`,
      'aria-describedby': separation.reason ? `${detailsId}-sep` : undefined,
      dataset: { key: `separate-${item.trackId}` },
      disabled: separation.enabled ? undefined : 'true',
    });
    separate.addEventListener('click', () => { void onSeparate(item); });

    // Stems that matched the search sit beneath their recording, which is
    // still one result. Without a search the expanded row reads the stem
    // route instead of assuming `match` is filled.
    let matchBlock = null;
    if (item.match && item.match.stems.length) {
      const entry = stemList(matchLists, item, {
        label: `Stems of ${item.name} matching “${query}”`, showReasons: true, state: { source: null },
      });
      if (entry.source !== item.match) {
        entry.source = item.match;
        entry.list.setStems(item.match.stems);
      }
      matchBlock = createElement('div', { class: 'record-crate__stem-match' }, [
        createElement('p', {
          class: 'record-crate__stem-head',
          text: item.match.trackMatched
            ? `${item.match.stems.length} matching ${item.match.stems.length === 1 ? 'stem' : 'stems'}; the recording also matches`
            : `${item.match.stems.length} matching ${item.match.stems.length === 1 ? 'stem' : 'stems'}; found by stem, not by the recording name`,
        }),
        entry.list.el,
      ]);
    }
    const sleeve = open ? stemList(sleeves, item, {
      label: `Separated stems of ${item.name}`, showReasons: false, state: { loaded: null },
      emptyText: 'No separated stems for this recording yet.',
    }) : sleeves.get(item.trackId);
    if (open && sleeve && sleeve.loaded == null) void loadSleeve(item, sleeve);
    const sleeveBlock = createElement('div', { class: 'record-crate__stems' }, [
      createElement('h4', { class: 'record-crate__stems-title', text: 'Separated stems' }),
      sleeve ? sleeve.list.el : null,
    ]);

    const details = createElement('div', {
      id: detailsId,
      class: 'record-crate__details',
      role: 'group',
      'aria-label': `${item.name} details`,
      hidden: open ? undefined : 'true',
    }, [
      createElement('dl', { class: 'record-crate__facts' }, [
        ...detailRow('Length', formatDuration(item.duration) || 'Not measured'),
        ...detailRow('Tempo', item.bpm != null ? `${Number(item.bpm.toFixed(1))} BPM, measured` : 'Not measured'),
        ...detailRow('Key', formatKey(item.key) || 'Not measured'),
        ...detailRow('Artist', 'Not in Library data'),
        ...detailRow('Source', sourceLabel(item.sourceKind)),
        ...detailRow('Stems', stemDetail(item)),
        ...(item.stems.method ? detailRow('Stem set method', item.stems.method) : []),
        ...(item.stems.modelName ? detailRow('Stem set model', item.stems.modelName) : []),
        ...(item.videoId ? detailRow('YouTube ID', item.videoId) : []),
        ...(state.reason ? detailRow('Separation', state.reason) : []),
        ...duplicateDetails(item.duplicates),
      ]),
      createElement('div', { class: 'record-crate__actions' }, actions),
      createElement('div', { class: 'record-crate__separate-row' }, [
        separate,
        separation.reason
          ? createElement('p', { id: `${detailsId}-sep`, class: 'record-crate__reason', text: separation.reason })
          : null,
      ]),
      sleeveBlock,
    ]);

    toggle.addEventListener('click', () => {
      if (expanded.has(item.trackId)) expanded.delete(item.trackId);
      else expanded.add(item.trackId);
      const now = expanded.has(item.trackId);
      toggle.setAttribute('aria-expanded', String(now));
      details.hidden = !now;
      if (now) {
        // Re-read on every open: a separation or rename may have landed.
        const entry = stemList(sleeves, item, {
          label: `Separated stems of ${item.name}`, showReasons: false, state: { loaded: null },
          emptyText: 'No separated stems for this recording yet.',
        });
        if (!sleeveBlock.contains(entry.list.el)) sleeveBlock.append(entry.list.el);
        if (entry.loaded !== 'loading') void loadSleeve(rowFor(item.trackId) || item, entry);
      }
    });

    return createElement('li', {
      class: 'record-crate__row',
      dataset: { trackId: item.trackId, stem: state.code, banks: banks.map((b) => `${b.code}-${b.groupId}`).join(' ') },
    }, [toggle, matchBlock, details]);
  }

  function focusKeyOf(el) {
    return el && root.contains(el) ? el.dataset?.key || null : null;
  }

  function focusByKey(key) {
    const target = key
      ? [...root.querySelectorAll('[data-key]')].find((el) => el.dataset.key === key) || null
      : null;
    if (target && !target.disabled) {
      target.focus();
      return true;
    }
    return false;
  }

  function render() {
    const keep = focusKeyOf(document.activeElement);
    root.dataset.state = items.length ? 'results' : (activated ? 'empty' : 'idle');
    if (!items.length) {
      replaceChildren(list, activated && !searchController
        ? [createElement('li', {
          class: 'record-crate__empty',
          text: query ? `No Library tracks match “${query}”.` : 'Your Library is empty. Add a track on the Library page.',
        })]
        : []);
    } else {
      replaceChildren(list, items.map(renderItem));
    }
    const present = new Set(items.map((item) => item.trackId));
    for (const [map, keep] of [[matchLists, (id) => rowFor(id)?.match?.stems?.length], [sleeves, (id) => present.has(id)]]) {
      for (const [id, entry] of map) {
        if (!keep(id)) { entry.list.dispose(); map.delete(id); }
      }
    }
    more.hidden = items.length >= total;
    const lost = !document.activeElement || document.activeElement === document.body;
    // A requested move (Choose → Load) or a return after Load wins, but only
    // while focus is still in the Crate or has fallen to the page.
    if (pendingFocusKey && (keep || lost) && focusByKey(pendingFocusKey)) {
      pendingFocusKey = null;
      return;
    }
    if (keep && !focusByKey(keep) && !pendingFocusKey && !root.contains(document.activeElement)) {
      // The focused control left the list (a new search); stay in the Crate.
      searchInput.focus();
    }
  }

  async function runSearch({ append = false } = {}) {
    searchController?.abort();
    const controller = new AbortController();
    searchController = controller;
    const seq = ++searchSeq;
    const offset = append ? items.length : 0;
    root.setAttribute('aria-busy', 'true');
    try {
      const page = await source.search({ query, limit: CRATE_PAGE_SIZE, offset, signal: controller.signal });
      if (disposed || seq !== searchSeq) return;
      items = append ? items.concat(page.items) : page.items;
      total = page.total;
      root.dataset.source = 'projection';
      searchController = null;
      for (const item of page.items) followSeparation(item);
      render();
      const ready = items.filter((item) => stemState(item).code === 'ready').length;
      announce(items.length
        ? `${total} ${total === 1 ? 'track' : 'tracks'}${query ? ` match “${query}”` : ' in your Library'}, ${ready} with stems ready${items.length < total ? `. Showing ${items.length}` : ''}.`
        : (query ? `No Library tracks match “${query}”.` : 'Your Library is empty.'), { live: !append });
    } catch (err) {
      if (disposed || seq !== searchSeq || controller.signal.aborted) return;
      searchController = null;
      render();
      announce(`Could not search the Library: ${err?.message || 'request failed'}. Try again.`);
    } finally {
      if (seq === searchSeq) root.removeAttribute('aria-busy');
    }
  }

  function scheduleSearch() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchTimer = null;
      void runSearch();
    }, searchDelayMs);
  }

  async function onChoose(item, groupId) {
    if (!item.actions.includes(`choose_${groupId}`) || session.loading === groupId) return;
    const already = bankFor(groupId).selectedTrackId === item.trackId;
    if (!already) {
      try {
        await bridge.choose(groupId, { id: item.trackId, name: item.name });
      } catch (err) {
        announce(`Could not choose ${item.name} for ${groupId}: ${err?.message || 'request failed'}.`);
        return;
      }
    }
    if (disposed) return;
    const reason = loadReason(rowFor(item.trackId) || item, groupId);
    announce(reason
      ? `${item.name} is selected for ${groupId}. ${reason}`
      : `${item.name} is selected for ${groupId}. Load ${groupId} when you are ready; loading stops playback.`);
    // The next step is Load; when it is unavailable, stay on the row.
    pendingFocusKey = reason ? `item-${item.trackId}` : `load-${groupId}-${item.trackId}`;
    render();
  }

  function onLoad(item, groupId, button) {
    if (loadReason(item, groupId)) return;
    pendingFocusKey = document.activeElement === button ? button.dataset.key : null;
    crateLoad = { groupId, trackId: item.trackId };
    bridge.load(groupId);
  }

  function followSeparation(item) {
    const sep = item.separation;
    if (!sep?.jobId || jobWatches.has(sep.jobId) || typeof bridge.watchJob !== 'function') return;
    if (sep.status !== 'queued' && sep.status !== 'running') return;
    const unsub = bridge.watchJob(sep.jobId, (job) => {
      if (disposed || !job) return;
      const row = rowFor(item.trackId);
      if (job.status === 'queued' || job.status === 'running') {
        if (row?.separation?.jobId === job.id) {
          row.separation = {
            jobId: job.id, status: job.status, progress: job.progress_detail?.percent ?? null, error: null,
          };
          render();
        }
        return;
      }
      jobWatches.get(sep.jobId)?.();
      jobWatches.delete(sep.jobId);
      if (!row || row.separation?.jobId !== job.id) return;
      announce(job.status === 'complete'
        ? `Separation finished for ${row.name}.`
        : `Separation ${job.status} for ${row.name}: ${job.error || job.message || job.status}.`);
      void runSearch();
    });
    jobWatches.set(sep.jobId, unsub);
  }

  async function onSeparate(item) {
    const availability = separateAvailability(item);
    if (!availability.enabled || submitting.has(item.trackId)) return;
    submitting.add(item.trackId);
    pendingFocusKey = `item-${item.trackId}`;
    render();
    announce(`Requesting Demucs separation for ${item.name}…`);
    let job = null;
    try {
      job = await bridge.separate({ id: item.trackId, name: item.name });
    } catch (err) {
      submitting.delete(item.trackId);
      if (disposed) return;
      const row = rowFor(item.trackId);
      if (row) row.separation = { jobId: null, status: 'failed', progress: null, error: err?.message || 'request failed' };
      render();
      announce(`Demucs separation is unavailable for ${item.name}: ${err?.message || 'request failed'}.`);
      return;
    }
    submitting.delete(item.trackId);
    if (disposed) return;
    const row = rowFor(item.trackId);
    if (!job?.id || !row || !['queued', 'running'].includes(job.status)) {
      void runSearch();
      return;
    }
    row.separation = { jobId: job.id, status: job.status || 'queued', progress: null, error: null };
    render();
    announce(`Separating ${item.name} with Demucs. This runs in the background; you can keep playing.`);
    followSeparation(row);
  }

  function onSession(next) {
    const was = lastLoading;
    session = next;
    lastLoading = next.loading;
    render();
    if (was && !next.loading && crateLoad && crateLoad.groupId === was) {
      crateLoad = null;
      if (mirrorDesk && next.message) announce(next.message);
      if (pendingFocusKey && (document.activeElement === document.body || !document.activeElement)) {
        if (focusByKey(pendingFocusKey)) pendingFocusKey = null;
      }
    }
  }

  // Arrow keys move between the result rows; Home and End jump.
  list.addEventListener('keydown', (event) => {
    if (!event.target.classList?.contains('record-crate__item')) return;
    const toggles = [...list.querySelectorAll('.record-crate__item')];
    const index = toggles.indexOf(event.target);
    let next = null;
    if (event.key === 'ArrowDown') next = toggles[index + 1];
    else if (event.key === 'ArrowUp') next = index === 0 ? searchInput : toggles[index - 1];
    else if (event.key === 'Home') next = toggles[0];
    else if (event.key === 'End') next = toggles[toggles.length - 1];
    if (!next) return;
    event.preventDefault();
    next.focus();
  });
  searchInput.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown') return;
    const first = list.querySelector('.record-crate__item');
    if (!first) return;
    event.preventDefault();
    first.focus();
  });
  searchInput.addEventListener('input', () => {
    query = searchInput.value.trim();
    scheduleSearch();
  });
  more.addEventListener('click', () => { void runSearch({ append: true }); });
  // Focus that the musician moves elsewhere is theirs.
  const releaseFocus = (event) => {
    if (!root.contains(event.target)) pendingFocusKey = null;
  };
  document.addEventListener('pointerdown', releaseFocus, true);
  const unsubscribe = bridge.subscribe(onSession);

  // A rename changes what a search finds: search again at once if there is a query.
  const unsubscribeRenamed = onStemRenamed(() => {
    if (activated && !disposed && query) void runSearch();
  });

  return {
    root,
    toolbar,
    searchInput,
    /** First show: one search of the whole Library. Later shows do nothing. */
    activate() {
      if (activated || disposed) return;
      activated = true;
      void runSearch();
    },
    refresh() {
      if (activated && !disposed) void runSearch();
    },
    focusSearch() {
      searchInput.focus();
    },
    setMirrorDeskMessages(value) {
      mirrorDesk = Boolean(value);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(searchTimer);
      searchController?.abort();
      for (const unsub of jobWatches.values()) {
        try { unsub(); } catch { /* ignore */ }
      }
      jobWatches.clear();
      for (const map of [matchLists, sleeves]) {
        for (const entry of map.values()) entry.list.dispose();
        map.clear();
      }
      unsubscribe?.();
      unsubscribeRenamed();
      document.removeEventListener('pointerdown', releaseFocus, true);
      root.remove();
    },
  };
}
