// ── Playback ──────────────────────────────────────────────────────────────────

// Record a play in the session stats.
function trackPlayed(ti) {
  state.stats.played++;
  state.stats.playCounts[ti] = (state.stats.playCounts[ti] || 0) + 1;
}

// Scroll the page until the track list stops growing, then return all elements.
async function loadTracks(status) {
  // Wait up to 10 s for at least one track element to appear before scrolling.
  // Without this, last=0 and n=0 on the first tick are equal, so stable
  // immediately increments to 3 and we return an empty array on pages that
  // haven't rendered their track list yet.
  for (let i = 0; i < 20; i++) {
    if (document.querySelectorAll('.trackList__item, .soundList__item, li.sc-list-item').length > 0) break;
    if (status) status.textContent = `⏳ waiting for tracks…`;
    await wait(500);
  }
  let last = 0, stable = 0;
  while (stable < 3) {
    window.scrollTo(0, document.body.scrollHeight);
    await wait(1200);
    const n = document.querySelectorAll('.trackList__item, .soundList__item, li.sc-list-item').length;
    if (status) status.textContent = `⏳ loading… (${n})`;
    n === last ? stable++ : (stable = 0, last = n);
  }
  window.scrollTo(0, 0);
  await wait(400);
  return [...document.querySelectorAll('.trackList__item, .soundList__item, li.sc-list-item')];
}

// Click the play button for track at index `idx` and wait for the title to change.
async function playAt(idx) {
  if (!state.active) return;

  const el = state.els[idx];
  if (!el || !document.body.contains(el)) {
    // Track removed from the playlist mid-session, or we've navigated away.
    state.els[idx] = null;

    const anyAlive = state.els.some(e => e && document.body.contains(e));
    if (!anyAlive) {
      state.suspended = true;
      state.busy      = false;
      updateMiniPlayer();
      return;
    }

    state.busy = false;
    await next(document.getElementById('tss-status'), false);
    return;
  }

  pause();
  await wait(50);
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  await wait(100);
  el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  await wait(50);

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
  if (titleChanged) trackPlayed(idx);
  setTimeout(() => { refreshPlayBtn(); updateProgressBar(); updateMiniPlayer(); }, 300);
}

// Advance to the next track in the queue.
async function next(status, fromWatcher = false) {
  if (!state.active) return;
  if (state.busy) return;
  if (fromWatcher && state.manualAction) { state.manualAction = false; return; }

  if (!state.els.some(e => e && document.body.contains(e))) {
    state.suspended = true;
    updateMiniPlayer();
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
      // Reinsert the played track into the future portion of the queue,
      // biased by priority:
      //   0.25 (low)    → last ~25 % of remaining
      //   1.0  (normal) → anywhere in remaining
      //   2.0  (high)   → first ~50 % of remaining
      const remaining = state.queue.length - state.pos;
      if (remaining > 0) {
        const weight     = state.priority[justPlayed] ?? 1.0;
        const rangeStart = weight >= 1.0 ? 0 : Math.floor(remaining * (1 - weight));
        const rangeEnd   = weight <= 1.0 ? remaining : Math.ceil(remaining / weight);
        const span       = Math.max(1, rangeEnd - rangeStart);
        const insertAt   = state.pos + 1 + rangeStart + Math.floor(Math.random() * span);
        state.queue.splice(Math.min(insertAt, state.queue.length), 0, justPlayed);
      } else {
        // Last track in the queue — start a fresh shuffled cycle.
        state.queue = fisherYates([...Array(state.meta.length).keys()]);
        state.pos   = 0;
        // Ensure the just-played track doesn't immediately repeat at position 0.
        if (state.queue[0] === justPlayed && state.queue.length > 1) {
          const swap = 1 + Math.floor(Math.random() * (state.queue.length - 1));
          [state.queue[0], state.queue[swap]] = [state.queue[swap], state.queue[0]];
        }
      }
    }
    // autoRepeat=false: track is not reinserted; queue shrinks by one each play.
  }

  // Insert a "play next" track at the current position.
  // Remove any existing copy first so the queue doesn't gain a duplicate.
  if (state.playNext.length > 0) {
    const ti  = state.playNext.shift();
    const dup = state.queue.indexOf(ti);
    if (dup !== -1) {
      state.queue.splice(dup, 1);
      if (dup < state.pos) state.pos--;
    }
    state.queue.splice(state.pos, 0, ti);
  }

  // Queue exhausted — only reachable when autoRepeat=false.
  if (state.pos >= state.queue.length) {
    stop();
    renderList();
    if (status) status.textContent = '';
    const btn = document.getElementById('tss-btn');
    if (btn) { btn.textContent = '🔀 True Shuffle'; btn.dataset.state = 'idle'; }
    state.busy = false;
    return;
  }

  await playAt(state.queue[state.pos]);
  badges();
  renderList();
  if (status) status.textContent = `▶ ${state.stats.played} / ${state.queue.length}`;
  state.busy = false;
}

// Go back to the previously played track.
async function prevTrack(status) {
  if (!state.active) return;
  if (state.busy) return;

  // > 3 s in → restart current track.  ≤ 3 s → go to previous in history.
  if (currentSec() > 3 || !state.history.length) {
    seekTo(0);
    return;
  }

  state.busy         = true;
  state.manualAction = true;

  const prevTi = state.history.pop();

  // Search the full queue (not just the future portion) so a track that was
  // dragged before state.pos is still found and removed before reinserting.
  const existingIdx = state.queue.indexOf(prevTi);
  if (existingIdx !== -1) {
    state.queue.splice(existingIdx, 1);
    if (existingIdx < state.pos) state.pos--;
  }
  state.queue.splice(state.pos, 0, prevTi);

  await playAt(state.queue[state.pos]);
  badges();
  renderList();
  if (status) status.textContent = `▶ ${state.stats.played} / ${state.queue.length}`;
  state.busy = false;
}

// Jump directly to a specific position in the queue.
async function jumpTo(qi, ti, status) {
  if (state.busy) return;
  state.busy         = true;
  state.manualAction = true;
  state.suspended    = false;

  // Record what was playing so prevTrack() can return to it.
  const current = state.queue[state.pos];
  if (current !== undefined) {
    state.history.push(current);
    if (state.history.length > 50) state.history.shift();
  }

  state.pos = qi;
  await playAt(ti);
  badges();
  renderList();
  if (status) status.textContent = `▶ ${state.stats.played} / ${state.queue.length}`;
  state.busy = false;
}

// Add a track to the front of the playNext priority queue.
// A short debounce prevents double-fires from rapid clicks.
function queueNext(ti) {
  if (state._qnd) return;
  state._qnd = true;
  setTimeout(() => { state._qnd = false; }, 500);
  state.playNext.push(ti);
  renderList();
}

// Remove a track from the queue by its queue index.
// The currently playing track cannot be removed.
function removeFromQueue(qi) {
  if (qi === state.pos) return;
  state.queue.splice(qi, 1);
  if (qi < state.pos) state.pos--;
  badges();
  renderList();
}

// ── Start / Stop ──────────────────────────────────────────────────────────────

async function start(btn, status) {
  // Toggle off if already running.
  if (state.active) {
    stop();
    btn.textContent   = '🔀 True Shuffle';
    btn.dataset.state = 'idle';
    if (status) status.textContent = '';
    renderList();
    const mini = document.getElementById('tss-mini');
    if (mini) mini.style.display = 'none';
    return;
  }

  btn.disabled      = true;
  btn.textContent   = '⏳ loading…';
  btn.dataset.state = 'loading';

  const els = await loadTracks(status);
  if (!els.length) {
    if (status) status.textContent = '❌ no tracks found';
    btn.textContent   = '🔀 True Shuffle';
    btn.dataset.state = 'idle';
    btn.disabled      = false;
    return;
  }

  state.els  = els;
  state.meta = els.map(getMeta);

  // Restore a queue cached before an external-track navigation.
  // Tracks are identified by permalink URL so indices stay correct even if
  // SC re-renders the DOM in a different order.
  let _cached = null;
  try {
    const _raw = sessionStorage.getItem('tss_queue_cache');
    if (_raw) {
      const _c = JSON.parse(_raw);
      if (Date.now() - (_c.ts || 0) < 30 * 60 * 1000          // 30-min window
          && playlistBase(location.href) === playlistBase(_c.playlistUrl || '')
          && Array.isArray(_c.queue) && _c.queue.length > 0
          && Array.isArray(_c.metaKeys)) {

        // Build id → newTi lookup so we can remap old indices to new ones.
        const idToNew = {};
        state.meta.forEach((m, ti) => {
          const id = trackId(m);
          if (id) idToNew[id] = ti;
        });

        // Remap cached queue: old ti → cached id → new ti.
        const mk = _c.metaKeys;  // mk[oldTi] = stable id string
        const remapOld = oldTi => {
          const id = mk[oldTi];
          return (id && idToNew[id] !== undefined) ? idToNew[id] : null;
        };
        const remappedQueue = _c.queue.map(remapOld).filter(ti => ti !== null);

        // Tracks that didn't remap (new, renamed, or lazy-rendered) are
        // shuffled and appended so the full playlist is always covered.
        const inQueue   = new Set(remappedQueue);
        const extras    = fisherYates(
          [...Array(state.meta.length).keys()].filter(ti => !inQueue.has(ti))
        );
        const finalQueue = remappedQueue.concat(extras);

        // Only restore if at least one track remapped; otherwise it's a
        // completely different playlist and a fresh shuffle makes more sense.
        if (remappedQueue.length > 0) {
          const cachedPos = typeof _c.pos === 'number' ? _c.pos : 0;
          const posId     = mk[_c.queue[cachedPos]] || '';
          let   newPos    = finalQueue.findIndex(
            newTi => trackId(state.meta[newTi]) === posId
          );
          if (newPos === -1) newPos = 0;

          const newHistory = (Array.isArray(_c.history) ? _c.history : [])
            .map(remapOld).filter(ti => ti !== null);
          const newPriority = {};
          for (const [k, w] of Object.entries(_c.priority || {})) {
            const nti = remapOld(+k);
            if (nti !== null) newPriority[nti] = w;
          }

          sessionStorage.removeItem('tss_queue_cache');
          _cached = { queue: finalQueue, pos: newPos,
                      history: newHistory, priority: newPriority };
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
  state.suspended    = false;
  state.busy         = false;
  state.manualAction    = false;
  state.playlistUrl     = location.href.split(/[?#]/)[0];

  // Restore session stats if the user restarted within 10 minutes.
  const prev = state._savedStats;
  if (prev && (Date.now() - (prev._ts || 0)) < 600_000) {
    state.stats = { ...prev };
  } else {
    state.stats = { played: 0, playCounts: {}, elapsed: 0 };
  }
  state._savedStats = null;

  btn.textContent   = '⏹ Stop';
  btn.dataset.state = 'active';
  btn.disabled      = false;

  await playAt(state.queue[state.pos]);
  badges();
  renderList();
  if (status) status.textContent = `▶ ${state.stats.played} / ${state.queue.length}`;
  startWatcher(status);

  const mini = document.getElementById('tss-mini');
  if (mini) mini.style.display = 'flex';
  else mkMiniPlayer();
  updateMiniPlayer();
}

function stop() {
  state.active = false;
  state.busy   = false;
  state.worker?.postMessage('stop');
  state.worker?.terminate();
  state.worker = null;
  if (state._workerInterval) {
    clearInterval(state._workerInterval);
    state._workerInterval = null;
  }
  document.querySelectorAll('.tss-badge').forEach(b => b.remove());
  // Snapshot stats so they survive a quick restart.
  state._savedStats = { ...state.stats, _ts: Date.now() };
}
