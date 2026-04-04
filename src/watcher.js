function startWatcher() {
  if (state.worker) { state.worker.terminate(); state.worker = null; }
  if (state._workerInterval) { clearInterval(state._workerInterval); state._workerInterval = null; }

  state.lastTitle = playerTitle();
  let lastTitle  = state.lastTitle;
  let titleTicks = 0;
  let nearEnd    = false;

  const tick = async () => {
    if (!state.active || state.busy) return;

    const title = playerTitle();
    const p     = progress();

    if (state.suspended) {
      if (p >= 0.99 && !nearEnd && !paused()) {
        nearEnd = true;
        pause();
        await wait(150);

        if (state.els.some(e => e && document.body.contains(e))) {
          state.suspended = false;
          try {
            await next(true);
          } finally {
            lastTitle = playerTitle();
            nearEnd   = false;
          }
        } else {
          // Playlist DOM gone — cache queue and navigate back.
          nearEnd = false;
          const worker = state.worker;
          state.worker = null;
          if (worker) worker.terminate();
          if (state._workerInterval) { clearInterval(state._workerInterval); state._workerInterval = null; }

          try {
            sessionStorage.setItem('tss_queue_cache', JSON.stringify({
              queue:       state.queue.slice(),
              pos:         state.pos,
              history:     state.history.slice(),
              priority:    { ...state.priority },
              playlistUrl: state.playlistUrl,
              ts:          Date.now(),
              metaKeys:    state.meta.map(m => trackId(m) || ''),
            }));
          } catch (_) {}

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

    // Unrecognised title change — debounce 2 ticks before entering suspended mode.
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

    if (p >= 0.99 && !nearEnd && !paused()) {
      nearEnd = true;
      pause();
      await wait(150);
      try {
        await next(true);
      } finally {
        lastTitle = playerTitle();
        nearEnd   = false;
      }
      return;
    }

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
    state._workerInterval = setInterval(tick, 300);
  }
}
