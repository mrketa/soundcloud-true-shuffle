const validPage    = () => /soundcloud\.com\/[^/]+\/(sets\/|likes|tracks|reposts)/.test(location.href);
const playlistBase = url => url.split(/[?#]/)[0].replace(/\/+$/, '');

let navLock = false;
async function onNav() {
  if (navLock) return;
  navLock = true;
  try {
    if (state.active) {
      if (!validPage()) {
        state.suspended = true;
        updateHub();
        return;
      }

      if (playlistBase(location.href) === playlistBase(state.playlistUrl)) {
        // Same playlist re-navigation — refresh DOM references.
        state.suspended = false;
        await wait(1500);
        inject();
        state.worker?.postMessage('stop');
        if (state._workerInterval) { clearInterval(state._workerInterval); state._workerInterval = null; }
        const freshEls = await loadTracks();
        if (freshEls.length > 0) { state.els = freshEls; state.meta = freshEls.map(getMeta); }
        if (state.worker) { state.worker.postMessage('start'); } else { startWatcher(); }
        return;
      }

      stop();
    }

    await wait(1500);
    if (validPage()) {
      inject();
      try {
        const raw = sessionStorage.getItem('tss_queue_cache');
        if (raw) {
          const c = JSON.parse(raw);
          if (Date.now() - (c.ts || 0) < 30 * 60 * 1000
              && playlistBase(location.href) === playlistBase(c.playlistUrl || '')) {
            await start();
          }
        }
      } catch (_) {}
    }
  } finally {
    navLock = false;
  }
}

let lastUrl = location.href;
new MutationObserver(() => {
  if (location.href !== lastUrl) { lastUrl = location.href; onNav(); }
}).observe(document, { subtree: true, childList: true });

onNav();
