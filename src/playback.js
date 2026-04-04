function trackPlayed(ti) {
  state.stats.played++;
  state.stats.playCounts[ti] = (state.stats.playCounts[ti] || 0) + 1;
}

// Scroll the page until the track list stops growing, then return all elements.
async function loadTracks() {
  const sel = '.trackList__item, .soundList__item, li.sc-list-item';
  // Wait up to 10 s for at least one track to appear before scrolling.
  for (let i = 0; i < 20; i++) {
    if (document.querySelectorAll(sel).length > 0) break;
    await wait(500);
  }
  let last = 0, stable = 0;
  while (stable < 2) {
    window.scrollTo(0, document.body.scrollHeight);
    await wait(900);
    const n = document.querySelectorAll(sel).length;
    n === last ? stable++ : (stable = 0, last = n);
  }
  window.scrollTo(0, 0);
  return [...document.querySelectorAll(sel)];
}

// countPlay=false when going back (prevTrack) so the played counter isn't bumped.
async function playAt(idx, countPlay = true) {
  if (!state.active) return;

  const el = state.els[idx];
  if (!el || !document.body.contains(el)) {
    state.els[idx] = null;
    const anyAlive = state.els.some(e => e && document.body.contains(e));
    if (!anyAlive) {
      state.suspended = true;
      state.busy      = false;
      updateHub();
      return;
    }
    state.busy = false;
    await next(false);
    return;
  }

  pause();
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  await wait(80);

  const btn = el.querySelector('button.sc-button-play, .playButton, button[title*="Play"], .trackItem__coverArt, .sound__coverArt');
  if (btn) btn.click();
  else el.querySelector('.trackItem__trackTitle, .soundTitle__title, .sc-link-primary')?.click();

  const prev = state.lastTitle;
  let titleChanged = false;
  for (let i = 0; i < 15; i++) {
    await wait(150);
    const t = playerTitle();
    if (t && t !== prev) { titleChanged = true; break; }
  }

  state.lastTitle    = playerTitle();
  state.lastProgress = 0;
  if (titleChanged && countPlay) trackPlayed(idx);
  setTimeout(() => { refreshPlayBtn(); updateProgressBar(); updateHub(); }, 300);
}

async function next(fromWatcher = false) {
  if (!state.active) return;
  if (state.busy) return;
  if (fromWatcher && state.manualAction) { state.manualAction = false; return; }

  if (!state.els.some(e => e && document.body.contains(e))) {
    state.suspended = true;
    updateHub();
    return;
  }

  state.suspended = false;
  state.busy      = true;

  const justPlayed = state.queue[state.pos];
  if (justPlayed !== undefined) {
    state.history.push(justPlayed);
    if (state.history.length > 50) state.history.shift();
  }

  if (justPlayed !== undefined) {
    state.queue.splice(state.pos, 1);

    if (state.autoRepeat) {
      const remaining = state.queue.length - state.pos;
      if (remaining > 0) {
        const weight     = state.priority[justPlayed] ?? 1.0;
        const rangeStart = weight >= 1.0 ? 0 : Math.floor(remaining * (1 - weight));
        const rangeEnd   = weight <= 1.0 ? remaining : Math.ceil(remaining / weight);
        const span       = Math.max(1, rangeEnd - rangeStart);
        const insertAt   = state.pos + 1 + rangeStart + Math.floor(Math.random() * span);
        state.queue.splice(Math.min(insertAt, state.queue.length), 0, justPlayed);
      } else {
        // End of queue — start a fresh cycle, avoid immediate repeat.
        state.queue = fisherYates([...Array(state.meta.length).keys()]);
        state.pos   = 0;
        if (state.queue[0] === justPlayed && state.queue.length > 1) {
          const swap = 1 + Math.floor(Math.random() * (state.queue.length - 1));
          [state.queue[0], state.queue[swap]] = [state.queue[swap], state.queue[0]];
        }
      }
    }
  }

  if (state.playNext.length > 0) {
    const ti  = state.playNext.shift();
    const dup = state.queue.indexOf(ti);
    if (dup !== -1) {
      state.queue.splice(dup, 1);
      if (dup < state.pos) state.pos--;
    }
    state.queue.splice(state.pos, 0, ti);
  }

  if (state.pos >= state.queue.length) {
    stop();
    renderList();
    state.busy = false;
    return;
  }

  await playAt(state.queue[state.pos]);
  badges();
  renderList();
  state.busy = false;
}

async function prevTrack() {
  if (!state.active) return;
  if (state.busy) return;

  // > 3 s into current track → restart it; otherwise go back in history.
  if (currentSec() > 3 || !state.history.length) {
    seekTo(0);
    return;
  }

  state.busy         = true;
  state.manualAction = true;

  const prevTi = state.history.pop();
  const existingIdx = state.queue.indexOf(prevTi);
  if (existingIdx !== -1) {
    state.queue.splice(existingIdx, 1);
    if (existingIdx < state.pos) state.pos--;
  }
  state.queue.splice(state.pos, 0, prevTi);

  await playAt(state.queue[state.pos], false);
  badges();
  renderList();
  state.busy = false;
}

async function jumpTo(qi, ti) {
  if (!state.active) return;
  if (state.busy) return;
  state.busy         = true;
  state.manualAction = true;
  state.suspended    = false;

  const current = state.queue[state.pos];
  if (current !== undefined) {
    state.history.push(current);
    if (state.history.length > 50) state.history.shift();
  }

  state.pos = qi;
  await playAt(ti);
  badges();
  renderList();
  state.busy = false;
}

function queueNext(ti) {
  if (state._qnd) return;
  state._qnd = true;
  setTimeout(() => { state._qnd = false; }, 500);
  state.playNext.push(ti);
  renderList();
}

function removeFromQueue(qi) {
  if (qi === state.pos) return;
  state.queue.splice(qi, 1);
  if (qi < state.pos) state.pos--;
  badges();
  renderList();
}

async function start() {
  if (state.active) {
    stop();
    renderList();
    return;
  }

  state.loading = true;
  updateHub();

  const els = await loadTracks();
  if (!els.length) {
    state.loading = false;
    updateHub();
    return;
  }

  state.els  = els;
  state.meta = els.map(getMeta);

  let _cached = null;
  try {
    const _raw = sessionStorage.getItem('tss_queue_cache');
    if (_raw) {
      const _c = JSON.parse(_raw);
      if (Date.now() - (_c.ts || 0) < 30 * 60 * 1000
          && playlistBase(location.href) === playlistBase(_c.playlistUrl || '')
          && Array.isArray(_c.queue) && _c.queue.length > 0
          && Array.isArray(_c.metaKeys)) {

        const idToNew = {};
        state.meta.forEach((m, ti) => { const id = trackId(m); if (id) idToNew[id] = ti; });

        const mk       = _c.metaKeys;
        const remapOld = oldTi => { const id = mk[oldTi]; return (id && idToNew[id] !== undefined) ? idToNew[id] : null; };

        const remappedQueue = _c.queue.map(remapOld).filter(ti => ti !== null);
        const inQueue       = new Set(remappedQueue);
        const extras        = fisherYates([...Array(state.meta.length).keys()].filter(ti => !inQueue.has(ti)));
        const finalQueue    = remappedQueue.concat(extras);

        if (remappedQueue.length > 0) {
          const cachedPos = typeof _c.pos === 'number' ? _c.pos : 0;
          const posId     = mk[_c.queue[cachedPos]] || '';
          let   newPos    = finalQueue.findIndex(newTi => trackId(state.meta[newTi]) === posId);
          if (newPos === -1) newPos = 0;

          const newHistory  = (Array.isArray(_c.history) ? _c.history : []).map(remapOld).filter(ti => ti !== null);
          const newPriority = {};
          for (const [k, w] of Object.entries(_c.priority || {})) {
            const nti = remapOld(+k);
            if (nti !== null) newPriority[nti] = w;
          }

          sessionStorage.removeItem('tss_queue_cache');
          _cached = { queue: finalQueue, pos: newPos, history: newHistory, priority: newPriority };
        }
      }
    }
  } catch (_) {}

  if (_cached) {
    state.queue    = _cached.queue;
    state.pos      = _cached.pos;
    state.history  = _cached.history;
    state.priority = _cached.priority;
  } else {
    state.queue    = fisherYates([...Array(els.length).keys()]);
    state.pos      = 0;
    state.history  = [];
    state.priority = {};
  }

  state.playNext     = [];
  state.active       = true;
  state.loading      = false;
  state.suspended    = false;
  state.busy         = false;
  state.manualAction = false;
  state.playlistUrl  = location.href.split(/[?#]/)[0];

  const prev = state._savedStats;
  if (prev && (Date.now() - (prev._ts || 0)) < 600_000) {
    state.stats = { ...prev };
  } else {
    state.stats = { played: 0, playCounts: {}, elapsed: 0 };
  }
  state._savedStats = null;

  await playAt(state.queue[state.pos]);
  badges();
  renderList();
  startWatcher();
  updateHub();
}

function stop() {
  state.active  = false;
  state.busy    = false;
  state.loading = false;
  state.worker?.postMessage('stop');
  state.worker?.terminate();
  state.worker = null;
  if (state._workerInterval) {
    clearInterval(state._workerInterval);
    state._workerInterval = null;
  }
  document.querySelectorAll('.tss-badge').forEach(b => b.remove());
  state._savedStats = { ...state.stats, _ts: Date.now() };
  updateHub();
}
