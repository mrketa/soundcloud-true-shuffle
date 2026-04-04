// ── Watcher ───────────────────────────────────────────────────────────────────
// Polls every 300 ms via a Web Worker. Detects title changes (external song
// or SC auto-advance) and fires next() when a track nears its end.

function startWatcher(status) {
  if (state.worker) {
    state.worker.terminate();
    state.worker = null;
  }
  if (state._workerInterval) {
    clearInterval(state._workerInterval);
    state._workerInterval = null;
  }

  state.lastTitle = playerTitle();
  let lastTitle   = state.lastTitle;
  let titleTicks  = 0;   // consecutive ticks where title differs (debounce)
  let nearEnd     = false;

  const tick = async () => {
    if (!state.active || state.busy) return;

    const title = playerTitle();
    const p     = progress();

    // ── Suspended mode ────────────────────────────────────────────────────────
    // An external (non-queue) track is playing. Let it play freely; resume
    // the queue when it ends.
    if (state.suspended) {
      if (p >= 0.99 && !nearEnd && !paused()) {
        nearEnd = true;
        pause();
        await wait(150);

        const anyAlive = state.els.some(e => e && document.body.contains(e));
        if (anyAlive) {
          // Still on the playlist page — resume immediately.
          state.suspended = false;
          try {
            await next(status, true);
          } finally {
            lastTitle = playerTitle();
            nearEnd   = false;
          }
        } else {
          // Playlist DOM is gone — save the queue and navigate back.
          nearEnd = false;
          const worker = state.worker;
          state.worker = null;
          if (worker) worker.terminate();
          if (state._workerInterval) {
            clearInterval(state._workerInterval);
            state._workerInterval = null;
          }

          try {
            const metaKeys = state.meta.map(m => trackId(m) || '');
            sessionStorage.setItem('tss_queue_cache', JSON.stringify({
              queue:       state.queue.slice(),
              pos:         state.pos,
              history:     state.history.slice(),
              priority:    { ...state.priority },
              playlistUrl: state.playlistUrl,
              ts:          Date.now(),
              metaKeys,
            }));
          } catch (_) {}

          // Set inactive before navigating so onNav() on the new page always
          // takes the inactive fallthrough path and reads the cache.
          state.active    = false;
          state.busy      = false;
          state.suspended = false;

          const a = document.createElement('a');
          a.href = state.playlistUrl;
          document.body.appendChild(a);
          a.click();
          setTimeout(() => { if (a.parentNode) a.remove(); }, 2000);
        }
      } else {
        if (title && title !== lastTitle) lastTitle = title;
        titleTicks = 0;
        refreshPlayBtn();
        updateProgressBar();
        updateHub();
      }
      return;
    }

    // Title changed to a track we didn't queue — either the user clicked
    // something manually or SC auto-advanced past our controls.
    // Enter suspended mode so the song plays fully, then resume.
    // Two consecutive ticks debounce brief flashes during our own playAt().
    // manualAction exempts intentional control actions (jumpTo, prevTrack).
    if (title && lastTitle && title !== lastTitle) {
      if (++titleTicks >= 2) {
        titleTicks = 0;
        nearEnd    = false;
        lastTitle  = title;
        if (state.manualAction) {
          state.manualAction = false;
        } else {
          state.suspended = true;
          updateHub();
        }
      }
      return;
    }
    titleTicks = 0;

    // Track is within 1 % of its end and currently playing.
    // Pause before SC can auto-advance, then pick our own next track.
    if (p >= 0.99 && !nearEnd && !paused()) {
      nearEnd = true;
      pause();
      await wait(150);
      try {
        await next(status, true);
      } finally {
        lastTitle = playerTitle();
        nearEnd   = false;
      }
      return;
    }

    // Reset nearEnd if the track looped back (progress jumped backward).
    if (state.lastProgress > 0.5 && p < 0.1) nearEnd = false;
    state.lastProgress = p;
    if (title) lastTitle = title;

    refreshPlayBtn();
    updateProgressBar();
    updateHub();
  };

  state.worker = mkWorker();
  if (state.worker) {
    state.worker.onmessage = tick;
    state.worker.postMessage('start');
  } else {
    // Blob Worker blocked (e.g. CSP) — fall back to setInterval.
    // Background-tab throttling may apply, but this is better than no polling.
    state._workerInterval = setInterval(tick, 300);
  }
}
