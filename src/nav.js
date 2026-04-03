// ── Navigation ────────────────────────────────────────────────────────────────
// SoundCloud is a SPA — we watch for URL changes via a MutationObserver on the
// document root and reinitialise the UI on every navigation.

// Returns true only on pages that have a shuffle-able track list.
const validPage = () =>
  /soundcloud\.com\/[^/]+\/(sets\/|likes|tracks|reposts)/.test(location.href);

// Strip query params and hash so we can compare playlist identity robustly.
// SoundCloud sometimes appends ?si=… tracking params or #anchor fragments
// when doing SPA navigation, which would break an exact href comparison.
// Normalize a URL to just origin+path for playlist identity comparison.
// Strips query params, hash fragments, AND trailing slashes so that
// "soundcloud.com/u/sets/p" and "soundcloud.com/u/sets/p/" compare equal.
const playlistBase = url => url.split(/[?#]/)[0].replace(/\/+$/, '');

// Called on every navigation (and on first load).
// The navLock prevents a second concurrent execution if the MutationObserver
// fires multiple times during a single navigation (e.g. SC changes the URL
// then React re-renders cause more mutations).
let navLock = false;
async function onNav() {
  if (navLock) return;
  navLock = true;
  try {
    if (state.active) {
      if (!validPage()) {
        // Navigated to a non-playlist page while shuffle is running.
        // Keep the queue alive but suspend so the external track plays freely.
        state.suspended = true;
        updateMiniPlayer();
        return;
      }

      // Returned after an external track ended.
      // state.queue / state.pos / state.meta are intact in memory — we just
      // need fresh DOM references because SC's SPA destroyed the old ones.
      // We remap queue indices via track permalink URLs (trackId) so the
      // shuffle order is preserved even if SC renders elements in a
      // different order or with a different element count this time.
      if (playlistBase(location.href) === playlistBase(state.playlistUrl)) {
        // Normal SPA re-navigation to the same playlist while shuffle is active
        // (e.g. the user clicked the playlist link manually).
        // Re-sync DOM elements in case SC re-rendered the list.
        state.suspended = false;
        await wait(1500);
        inject();
        const status   = document.getElementById('tss-status');
        const freshEls = await loadTracks(status);
        if (freshEls.length > 0) {
          state.els  = freshEls;
          state.meta = freshEls.map(getMeta);
        }
        return;
      }

      // Navigated to a DIFFERENT valid playlist page — full stop.
      stop();
      const mini = document.getElementById('tss-mini');
      const tab  = document.getElementById('tss-mini-tab');
      if (mini) mini.style.display = 'none';
      if (tab)  tab.style.display  = 'none';
    }
    await wait(1500); // give SoundCloud time to render the new page
    if (validPage()) {
      inject();
      // Auto-resume a suspended queue if we just returned to the playlist.
      try {
        const raw = sessionStorage.getItem('tss_queue_cache');
        if (raw) {
          const c = JSON.parse(raw);
          if (Date.now() - (c.ts || 0) < 10 * 60 * 1000
              && playlistBase(location.href) === playlistBase(c.playlistUrl || '')) {
            const btn    = document.getElementById('tss-btn');
            const status = document.getElementById('tss-status');
            if (btn && status) await start(btn, status);
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
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    onNav();
  }
}).observe(document, { subtree: true, childList: true });

onNav();
