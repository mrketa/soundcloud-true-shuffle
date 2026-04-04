// ==UserScript==
// @name         SoundCloud True Shuffle
// @namespace    https://greasyfork.org/scripts/soundcloud-true-shuffle
// @version      4.0.1
// @description  Fixes SoundCloud's broken shuffle. Loads all tracks, actually random, works in background tabs.
// @author       keta
// @match        https://soundcloud.com/*
// @license      MIT
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
'use strict';

// ── src/state.js ──────────────────────────────────────────────────────────────

// ── Shared state ─────────────────────────────────────────────────────────────
// Single source of truth for all runtime data. Every module reads/writes this
// object directly — no copies, no getters.

const state = {
  active:       false,   // is shuffle running?
  autoRepeat:   true,    // reshuffle and loop when queue exhausted
  queue:        [],      // shuffled array of track indices (into state.els / state.meta)
  playNext:     [],      // priority queue: play these ti values before continuing
  pos:          0,       // current position in state.queue
  els:          [],      // DOM elements for each track (index = ti)
  meta:         [],      // { title, artist, artwork, link } per track (index = ti)
  worker:       null,    // Web Worker used for background polling
  busy:         false,   // guard: prevents re-entrant playback calls
  lastTitle:    '',      // title of the last confirmed playing track
  lastProgress: 0,       // last known playback progress ratio (0–1)
  sidebarOpen:  false,   // is the sidebar panel visible?
  manualAction: false,   // true when user manually triggered next/prev
  dragSrc:      null,    // queue index being dragged (for reorder)
  history:      [],      // stack of previously played ti values (max 50)
  priority:     {},      // ti → weight: 0.25 = low, 1.0 = normal, 2.0 = high
  suspended:    false,   // true while an external (non-queue) track is playing
  playlistUrl:  '',      // href when shuffle was started (detect navigation away)
  _savedStats:  null,    // snapshot saved on stop() for restore-on-restart
  stats: {
    played:     0,       // total tracks played this session
    playCounts: {},      // ti → number of times played
    elapsed:    0,       // seconds of actual playback time
  },
};

// ── src/utils.js ──────────────────────────────────────────────────────────────

// ── Utilities ────────────────────────────────────────────────────────────────

// Fisher-Yates in-place shuffle — returns a new array.
function fisherYates(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const wait = ms => new Promise(r => setTimeout(r, ms));

// ── DOM helpers ───────────────────────────────────────────────────────────────

// Returns the title currently shown in SoundCloud's playback bar.
// Prefers the `title` attribute over textContent — SC's textContent includes
// an accessibility prefix ("Current track: …") that we don't want to display.
function playerTitle() {
  for (const s of ['.playbackSoundBadge__titleLink', '.playbackSoundBadge a[title]', '.playerTrackName']) {
    const el = document.querySelector(s);
    if (!el) continue;
    const t = (el.getAttribute('title') || el.textContent)
      .trim()
      .replace(/^current\s+track:\s*/i, '');
    if (t) return t;
  }
  return '';
}

// Returns the artwork URL currently shown in SoundCloud's playback bar.
// Used in suspended mode to display the artwork of an externally-playing track.
function playerArtwork() {
  for (const sel of [
    '.playbackSoundBadge__avatar',
    '.playbackSoundBadge__coverArt',
    '.playbackSoundBadge',
  ]) {
    const container = document.querySelector(sel);
    if (!container) continue;
    // background-image on a span (SC's standard artwork rendering)
    const span = container.querySelector('span[style*="background-image"], .sc-artwork[style*="background-image"]');
    if (span?.style.backgroundImage) {
      const m = span.style.backgroundImage.match(/url\(["']?(https?:[^"')]+)["']?\)/);
      if (m) return m[1].replace(/-t\d+x\d+/, '-t200x200');
    }
    // fallback: img tag
    const img = container.querySelector('img[src]');
    if (img?.src) return img.src.replace(/-t\d+x\d+/, '-t200x200');
  }
  return null;
}

// Returns current playback progress as a ratio 0–1, or 0 if unavailable.
function progress() {
  const passed = document.querySelector('.playbackTimeline__timePassed');
  const total  = document.querySelector('.playbackTimeline__duration');
  if (!passed || !total) return 0;
  const toSec = el => {
    const m = el.textContent.match(/(\d+):(\d{2})$/);
    return m ? +m[1] * 60 + +m[2] : 0;
  };
  const d = toSec(total);
  return d ? toSec(passed) / d : 0;
}

// Returns how many seconds into the current track the playhead is.
function currentSec() {
  const el = document.querySelector('.playbackTimeline__timePassed');
  if (!el) return 0;
  const m = el.textContent.match(/(\d+):(\d{2})$/);
  return m ? +m[1] * 60 + +m[2] : 0;
}

// True when the native player is paused (or the play button shows "Play").
function paused() {
  const btn = document.querySelector('.playControls__play');
  if (!btn) return false;
  const label = (btn.getAttribute('aria-label') || '').toLowerCase();
  return label.startsWith('play') || (btn.title || '').toLowerCase().startsWith('play');
}

function pause() {
  const b = document.querySelector('.playControls__play');
  if (b && !paused()) b.click();
}

function toggle() {
  document.querySelector('.playControls__play')?.click();
  setTimeout(refreshPlayBtn, 150);
}

// Seek to a ratio (0–1) by simulating mouse events on SC's progress bar.
function seekTo(ratio) {
  ratio = Math.max(0, Math.min(1, ratio));
  const bar = document.querySelector('.playControls .playbackTimeline__progressWrapper');
  if (!bar) return;
  const rect = bar.getBoundingClientRect();
  const x    = rect.left + rect.width * ratio;
  const y    = rect.top  + rect.height / 2;
  const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y };
  bar.dispatchEvent(new MouseEvent('mousedown', opts));
  bar.dispatchEvent(new MouseEvent('mousemove', opts));
  bar.dispatchEvent(new MouseEvent('mouseup',   opts));
}

// Sync the play/pause icon on both the sidebar and mini-player controls.
function refreshPlayBtn() {
  const isPaused = paused();
  const s = document.getElementById('tss-ctrl-play');
  const m = document.getElementById('tss-mini-play');
  if (s) s.textContent = isPaused ? '▶' : '⏸';
  if (m) m.textContent = isPaused ? '▶' : '⏸';
}

// Sync the progress bar width on both the sidebar and mini-player.
function updateProgressBar() {
  const p = `${Math.min(100, progress() * 100).toFixed(1)}%`;
  const s = document.getElementById('tss-progress-inner');
  const m = document.getElementById('tss-mini-progress');
  if (s) s.style.width = p;
  if (m) m.style.width = p;
}

// ── Track metadata extraction ─────────────────────────────────────────────────

// Resolves the best-available artwork URL from a track list element.
function artwork(el) {
  const span = el.querySelector('span.image__full, span.sc-artwork');
  if (span?.style.backgroundImage) {
    const m = span.style.backgroundImage.match(/url\(["']?(https?:[^"')]+)["']?\)/);
    if (m) return m[1].replace(/-t\d+x\d+/, '-t200x200');
  }
  const img = el.querySelector('img[src*="sndcdn"]');
  if (img?.src) return img.src.replace(/-t\d+x\d+/, '-t200x200');
  return null;
}

// Returns the canonical SoundCloud URL for a track element.
// Covers both trackList (sets/likes) and soundList (profile pages) layouts.
function getLink(el) {
  const a = el.querySelector(
    '.trackItem__trackTitle, .soundTitle__title, a.sc-link-primary'
  );
  if (!a) return null;
  const href = a.getAttribute('href');
  if (!href) return null;
  return href.startsWith('http') ? href : 'https://soundcloud.com' + href;
}

// Stable identity string for a track, used to survive page reloads.
// Prefers the permalink URL (a href attribute, always set by React immediately)
// over the display text which can vary by render state / truncation / locale.
function trackId(m) {
  if (!m) return null;
  if (m.link) return m.link;                          // best: unique, stable
  const t = m.title, a = m.artist;
  if ((t && t !== '—') || (a && a !== '—')) return `${t}|||${a}`;
  return null;
}

// Extracts { title, artist, artwork, link } from a track list DOM element.
function getMeta(el) {
  return {
    title:   el.querySelector('.trackItem__trackTitle, .soundTitle__title, .sc-link-primary')?.textContent.trim() || '—',
    artist:  el.querySelector('.trackItem__username, .soundTitle__username, .sc-link-secondary')?.textContent.trim() || '—',
    artwork: artwork(el),
    link:    getLink(el),
  };
}

// ── Security helper ───────────────────────────────────────────────────────────

// Escapes a string for safe insertion into innerHTML.
function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── src/worker.js ─────────────────────────────────────────────────────────────

// ── Web Worker factory ────────────────────────────────────────────────────────
// Fires a message every 300 ms so the watcher can poll playback state even
// when the tab is in the background.

function mkWorker() {
  try {
    const src = `
      let t = null;
      self.onmessage = e => {
        if (e.data === 'start') {
          clearInterval(t);
          t = setInterval(() => self.postMessage(0), 300);
        } else {
          clearInterval(t);
          t = null;
        }
      };
    `;
    const url = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
    const w   = new Worker(url);
    URL.revokeObjectURL(url); // Worker holds its own internal reference; safe to revoke immediately
    return w;
  } catch (_) {
    return null; // CSP or browser restriction — caller falls back to setInterval
  }
}

// ── src/playback.js ───────────────────────────────────────────────────────────

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
  if (!state.active) return;
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

// ── src/watcher.js ────────────────────────────────────────────────────────────

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
        updateMiniPlayer();
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
          updateMiniPlayer();
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
    updateMiniPlayer();
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

// ── src/ui/badges.js ──────────────────────────────────────────────────────────

// ── Queue badges ──────────────────────────────────────────────────────────────
// Small numbered chips injected next to each track title in the native
// SoundCloud list, showing the upcoming queue order.

function badges() {
  document.querySelectorAll('.tss-badge').forEach(b => b.remove());

  state.queue.forEach((ti, qi) => {
    const el = state.els[ti];
    if (!el || !document.body.contains(el) || el.querySelector('.tss-badge')) return;

    const cur = qi === state.pos;
    const b   = document.createElement('span');
    b.className  = 'tss-badge';
    b.style.cssText = [
      `display:inline-block`,
      `background:${cur ? '#f50' : '#2a2a2a'}`,
      `color:${cur ? '#fff' : '#888'}`,
      `border:1px solid ${cur ? '#f50' : '#444'}`,
      `border-radius:3px`,
      `font-size:10px`,
      `font-weight:bold`,
      `padding:1px 5px`,
      `margin-right:5px`,
      `vertical-align:middle`,
    ].join(';');
    const n       = state.stats.played + (qi - state.pos);
    b.textContent = cur ? `▶ ${n}` : `${n}`;

    const t = el.querySelector('.trackItem__trackTitle, .soundTitle__title, .sc-link-primary');
    if (t) t.parentNode.insertBefore(b, t);
  });
}

// ── src/ui/stats.js ───────────────────────────────────────────────────────────

// ── Session stats ─────────────────────────────────────────────────────────────

// Increment elapsed-time counter once per second while shuffle is active.
function tickPlayTime() {
  if (state.active && !state.suspended && !paused()) {
    state.stats.elapsed = (state.stats.elapsed || 0) + 1;
  }
}
setInterval(tickPlayTime, 1000);

// Re-render the stats overlay contents (called on a 1-second interval and
// after user interaction with priority buttons).
function renderStats() {
  const overlay = document.getElementById('tss-stats-overlay');
  if (!overlay) return;

  const elapsed  = state.stats.elapsed || 0;
  const h        = Math.floor(elapsed / 3600);
  const m        = Math.floor((elapsed % 3600) / 60);
  const s        = elapsed % 60;
  const duration = h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;

  const top = Object.entries(state.stats.playCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  const tp = overlay.querySelector('#tss-stats-played');
  const tt = overlay.querySelector('#tss-stats-time');
  if (tp) tp.textContent = state.stats.played;
  if (tt) tt.textContent = duration;

  const list = overlay.querySelector('#tss-stats-toplist');
  if (!list) return;

  list.innerHTML = top.map(([ti, count]) => {
    const meta  = state.meta[+ti] || {};
    const w     = state.priority[+ti] ?? 1.0;
    const label = w <= 0.25 ? '🔻 low' : w >= 2.0 ? '🔺 high' : '▪ normal';
    const col   = w <= 0.25 ? '#f50'   : w >= 2.0 ? '#4caf50' : '#555';
    return `
      <div style="display:flex;align-items:center;gap:6px;padding:5px 0;border-bottom:1px solid #1a1a1a;">
        <span style="color:#bbb;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;">${esc(meta.title || '—')}</span>
        <span style="color:#f50;font-size:11px;flex-shrink:0;">${count}×</span>
        <button data-ti="${ti}" style="background:#1a1a1a;border:1px solid #333;color:${col};border-radius:4px;padding:2px 7px;font-size:10px;cursor:pointer;flex-shrink:0;white-space:nowrap;">${label}</button>
      </div>`;
  }).join('');

  // Priority toggle buttons — cycle: normal → low → high → normal.
  list.querySelectorAll('[data-ti]').forEach(btn => {
    btn.onclick = e => {
      e.stopPropagation();
      const ti  = +btn.getAttribute('data-ti');
      const cur = state.priority[ti] ?? 1.0;
      let next, label, col;
      if      (cur >= 2.0) { next = 1.0;  label = '▪ normal'; col = '#555';    }
      else if (cur >= 1.0) { next = 0.25; label = '🔻 low';   col = '#f50';    }
      else                 { next = 2.0;  label = '🔺 high';  col = '#4caf50'; }
      state.priority[ti] = next;
      btn.textContent    = label;
      btn.style.color    = col;
    };
  });
}
setInterval(renderStats, 1000);

// Build and show the stats modal; toggle it off if already open.
function showStats() {
  const existing = document.getElementById('tss-stats-overlay');
  if (existing) { existing.remove(); return; }

  const overlay = document.createElement('div');
  overlay.id = 'tss-stats-overlay';
  overlay.style.cssText = `
    position:fixed; top:50%; left:50%; transform:translate(-50%,-50%);
    background:#111; border:1px solid #2a2a2a; border-radius:10px;
    padding:0; z-index:999999; font-family:-apple-system,sans-serif;
    min-width:280px; box-shadow:0 8px 40px rgba(0,0,0,0.8);
    cursor:default; -webkit-user-select:none; user-select:none;
  `;

  overlay.innerHTML = `
    <div id="tss-stats-header" style="display:flex;justify-content:space-between;align-items:center;padding:14px 18px 10px;cursor:move;border-bottom:1px solid #1a1a1a;">
      <span style="color:#fff;font-size:14px;font-weight:600;">session stats</span>
      <span id="tss-stats-close" style="color:#555;cursor:pointer;font-size:18px;line-height:1;">×</span>
    </div>
    <div style="padding:14px 18px 18px;">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px;">
        <div style="background:#1a1a1a;border-radius:6px;padding:12px;">
          <div style="color:#555;font-size:10px;margin-bottom:4px;">tracks played</div>
          <div id="tss-stats-played" style="color:#fff;font-size:22px;font-weight:700;">0</div>
        </div>
        <div style="background:#1a1a1a;border-radius:6px;padding:12px;">
          <div style="color:#555;font-size:10px;margin-bottom:4px;">session time</div>
          <div id="tss-stats-time" style="color:#fff;font-size:22px;font-weight:700;">0s</div>
        </div>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
        <span style="color:#555;font-size:10px;text-transform:uppercase;letter-spacing:0.05em;">most played</span>
        <span style="color:#555;font-size:10px;text-transform:uppercase;letter-spacing:0.05em;">Prio</span>
      </div>
      <div id="tss-stats-toplist"></div>
      <button id="tss-stats-reset" style="margin-top:14px;width:100%;background:#1a1a1a;border:1px solid #2a2a2a;color:#666;border-radius:5px;padding:6px;cursor:pointer;font-size:11px;">reset stats</button>
    </div>
  `;

  document.body.appendChild(overlay);
  renderStats();

  document.getElementById('tss-stats-close').onclick = () => overlay.remove();

  document.getElementById('tss-stats-reset').onclick = () => {
    state.stats       = { played: 0, playCounts: {}, elapsed: 0 };
    state._savedStats = null;
    renderStats();
  };

  // Draggable via the header bar.
  const header = document.getElementById('tss-stats-header');
  header.onmousedown = e => {
    if (e.target.id === 'tss-stats-close') return;
    e.preventDefault();
    const rect  = overlay.getBoundingClientRect();
    overlay.style.transform = 'none';
    overlay.style.left = rect.left + 'px';
    overlay.style.top  = rect.top  + 'px';
    const startX = e.clientX, startY = e.clientY;
    const origL  = rect.left,  origT  = rect.top;
    const move = ev => {
      overlay.style.left = Math.max(0, Math.min(window.innerWidth  - overlay.offsetWidth,  origL + (ev.clientX - startX))) + 'px';
      overlay.style.top  = Math.max(0, Math.min(window.innerHeight - overlay.offsetHeight, origT + (ev.clientY - startY))) + 'px';
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup',   up);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup',   up);
  };
}

// ── src/ui/miniPlayer.js ──────────────────────────────────────────────────────

// ── Mini player ───────────────────────────────────────────────────────────────

// Build the floating mini-player widget and attach all its event handlers.
function mkMiniPlayer() {
  if (document.getElementById('tss-mini')) return;

  const mini = document.createElement('div');
  mini.id = 'tss-mini';
  mini.style.cssText = `
    position:fixed; bottom:60px; right:20px;
    width:220px; min-width:220px; max-width:400px;
    background:#111; border:1px solid #222; border-radius:10px;
    padding:10px 12px; z-index:99996;
    font-family:-apple-system,sans-serif;
    box-shadow:0 4px 20px rgba(0,0,0,0.7);
    display:flex; flex-direction:column; gap:8px;
    overflow:hidden; cursor:default;
  `;

  mini.innerHTML = `
    <div style="display:flex;gap:10px;align-items:center;">
      <div id="tss-mini-art" style="width:40px;height:40px;border-radius:6px;background:#1a1a1a;flex-shrink:0;overflow:hidden;display:flex;align-items:center;justify-content:center;font-size:18px;color:#333;">♪</div>
      <div style="overflow:hidden;flex:1;display:flex;flex-direction:column;gap:3px;">
        <div id="tss-mini-title"  style="color:#fff;font-size:11px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.3;">—</div>
        <div id="tss-mini-artist" style="color:#555;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.3;">—</div>
      </div>
      <span id="tss-mini-close" style="color:#444;cursor:pointer;font-size:16px;flex-shrink:0;align-self:flex-start;line-height:1;">×</span>
    </div>
    <div id="tss-mini-extra" style="display:none;flex-direction:column;gap:4px;border-top:1px solid #1a1a1a;padding-top:8px;">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
        <span style="color:#555;font-size:10px;flex-shrink:0;">next up</span>
        <span id="tss-mini-nextup" style="color:#bbb;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;text-align:right;min-width:0;">—</span>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <span style="color:#555;font-size:10px;">queue</span>
        <span id="tss-mini-queuepos" style="color:#bbb;font-size:10px;">—</span>
      </div>
    </div>
    <div style="display:flex;align-items:center;justify-content:center;gap:8px;">
      <button id="tss-mini-prev"  style="background:none;border:none;color:#888;font-size:14px;cursor:pointer;padding:2px 6px;">⏮</button>
      <button id="tss-mini-play"  style="background:#f50;border:none;color:#fff;width:30px;height:30px;border-radius:50%;cursor:pointer;font-size:13px;">⏸</button>
      <button id="tss-mini-next"  style="background:none;border:none;color:#888;font-size:14px;cursor:pointer;padding:2px 6px;">⏭</button>
      <button id="tss-mini-stats" style="background:none;border:none;color:#555;font-size:12px;cursor:pointer;padding:2px 4px;" title="stats">📊</button>
    </div>
    <div id="tss-mini-seekbar" style="height:6px;background:#1a1a1a;border-radius:3px;overflow:hidden;cursor:pointer;" title="click to seek">
      <div id="tss-mini-progress" style="height:100%;background:#f50;width:0%;transition:width 0.3s linear;pointer-events:none;"></div>
    </div>
    <div id="tss-mini-rzl" style="position:absolute;bottom:0;left:0;width:14px;height:14px;cursor:sw-resize;display:flex;align-items:flex-end;justify-content:flex-start;padding:2px;opacity:0.4;font-size:9px;color:#666;">◤</div>
    <div id="tss-mini-rzr" style="position:absolute;bottom:0;right:0;width:14px;height:14px;cursor:se-resize;display:flex;align-items:flex-end;justify-content:flex-end;padding:2px;opacity:0.4;font-size:9px;color:#666;">◥</div>
  `;

  document.body.appendChild(mini);

  const st = () => document.getElementById('tss-status');

  document.getElementById('tss-mini-play').onclick  = toggle;
  document.getElementById('tss-mini-next').onclick  = () => { state.manualAction = true; next(st()); };
  document.getElementById('tss-mini-prev').onclick  = () => prevTrack(st());
  document.getElementById('tss-mini-stats').onclick = showStats;

  document.getElementById('tss-mini-seekbar').onclick = e => {
    const rect = e.currentTarget.getBoundingClientRect();
    seekTo((e.clientX - rect.left) / rect.width);
  };

  // Collapse to a small tab when closed.
  document.getElementById('tss-mini-close').onclick = () => {
    mini.style.display = 'none';
    let tab = document.getElementById('tss-mini-tab');
    if (!tab) {
      tab = document.createElement('div');
      tab.id = 'tss-mini-tab';
      tab.style.cssText = `
        position:fixed; bottom:60px; right:20px;
        background:#111; border:1px solid #222; border-radius:8px;
        padding:6px 10px; z-index:99996;
        font-family:-apple-system,sans-serif;
        display:flex; align-items:center; gap:8px;
        cursor:pointer; box-shadow:0 4px 12px rgba(0,0,0,0.6);
      `;
      tab.innerHTML = `
        <span style="font-size:13px;">🔀</span>
        <span id="tss-mini-tab-title" style="color:#ccc;font-size:11px;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">—</span>
      `;
      tab.onclick = () => { mini.style.display = 'flex'; tab.style.display = 'none'; updateMiniPlayer(); };
      document.body.appendChild(tab);
    }
    const m = state.meta[state.queue?.[state.pos]];
    const t = document.getElementById('tss-mini-tab-title');
    if (t && m) t.textContent = m.title;
    tab.style.display = 'flex';
  };

  // Drag — only on the player body, not on buttons or resize handles.
  mini.onmousedown = e => {
    const ignore = ['BUTTON', 'SPAN', 'INPUT'];
    if (ignore.includes(e.target.tagName)) return;
    if (e.target.id === 'tss-mini-rzl' || e.target.id === 'tss-mini-rzr') return;

    e.preventDefault();
    const rect    = mini.getBoundingClientRect();
    let curLeft   = rect.left;
    let curTop    = rect.top;
    mini.style.left   = curLeft + 'px';
    mini.style.top    = curTop  + 'px';
    mini.style.right  = 'auto';
    mini.style.bottom = 'auto';
    // If the user drags manually, clear the auto-shifted flag.
    delete mini.dataset.autoShifted;

    const startX = e.clientX, startY = e.clientY;
    const move = ev => {
      curLeft = Math.max(0, Math.min(window.innerWidth  - mini.offsetWidth,  rect.left + (ev.clientX - startX)));
      curTop  = Math.max(0, Math.min(window.innerHeight - mini.offsetHeight, rect.top  + (ev.clientY - startY)));
      mini.style.left = curLeft + 'px';
      mini.style.top  = curTop  + 'px';
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup',   up);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup',   up);
  };

  // Resize handles — change width only, never position.
  const addResize = (handleId, growLeft) => {
    const handle = document.getElementById(handleId);
    if (!handle) return;
    handle.onmousedown = e => {
      e.stopPropagation();
      e.preventDefault();
      const startX = e.clientX;
      const startW = mini.offsetWidth;
      const move = ev => {
        const delta = growLeft ? (startX - ev.clientX) : (ev.clientX - startX);
        const newW  = Math.max(220, Math.min(400, startW + delta));
        mini.style.width = newW + 'px';
        const extra = document.getElementById('tss-mini-extra');
        if (extra) extra.style.display = newW > 280 ? 'flex' : 'none';
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup',   up);
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup',   up);
    };
  };

  addResize('tss-mini-rzl', true);
  addResize('tss-mini-rzr', false);
}

// Sync mini-player display with current playback state.
function updateMiniPlayer() {
  const mini = document.getElementById('tss-mini');

  // If the player is hidden, just update the collapsed tab title.
  if (!mini || mini.style.display === 'none') {
    const tab = document.getElementById('tss-mini-tab');
    const m   = state.meta[state.queue?.[state.pos]];
    const t   = document.getElementById('tss-mini-tab-title');
    if (tab && tab.style.display !== 'none' && m && t) t.textContent = m.title;
    return;
  }

  const el = id => document.getElementById(id);

  if (state.suspended) {
    // An external (non-queue) track is playing.  Show what SC is actually
    // playing and indicate where the queue will resume.
    const extTitle = playerTitle() || '—';
    const nextTi   = state.queue[state.pos];
    const nextM    = nextTi !== undefined ? state.meta[nextTi] : null;

    if (el('tss-mini-title'))    el('tss-mini-title').textContent    = extTitle;
    if (el('tss-mini-artist'))   el('tss-mini-artist').textContent   = '↩ not in queue';
    if (el('tss-mini-play'))     el('tss-mini-play').textContent     = paused() ? '▶' : '⏸';
    if (el('tss-mini-nextup'))   el('tss-mini-nextup').textContent   = nextM ? `${nextM.artist} — ${nextM.title}` : '—';
    if (el('tss-mini-queuepos')) el('tss-mini-queuepos').textContent = `resume at ${state.stats.played + 1} / ${state.queue.length}`;

    // Show artwork from SC's player bar (the external track's artwork).
    const extArtwork = playerArtwork();
    const art = el('tss-mini-art');
    if (art) {
      if (extArtwork && art.dataset.src !== extArtwork) {
        art.dataset.src = extArtwork;
        art.innerHTML   = '';
        const img = document.createElement('img');
        img.src           = extArtwork;
        img.style.cssText = 'width:100%;height:100%;object-fit:cover;';
        img.onerror       = () => { art.innerHTML = '♪'; };
        art.appendChild(img);
      } else if (!extArtwork && art.dataset.src) {
        delete art.dataset.src;
        art.innerHTML = '♪';
      }
    }
    return;
  }

  // Normal mode: use playerTitle() as source of truth so the display stays
  // in sync with what SoundCloud is actually playing, not just our state.
  const currentTitle = playerTitle();
  const m = state.meta[state.queue?.[state.pos]];

  if (el('tss-mini-title'))  el('tss-mini-title').textContent  = currentTitle || m?.title  || '—';
  if (el('tss-mini-artist')) el('tss-mini-artist').textContent = m?.artist || '—';
  if (el('tss-mini-play'))   el('tss-mini-play').textContent   = paused() ? '▶' : '⏸';

  // Update artwork only when it changes to avoid thrashing the DOM.
  const art = el('tss-mini-art');
  if (art && m?.artwork && art.dataset.src !== m.artwork) {
    art.dataset.src = m.artwork;
    art.innerHTML   = '';
    const img = document.createElement('img');
    img.src           = m.artwork;
    img.style.cssText = 'width:100%;height:100%;object-fit:cover;';
    img.onerror       = () => { art.innerHTML = '♪'; };
    art.appendChild(img);
  }

  const nextTi = state.queue[state.pos + 1];
  const nextM  = nextTi !== undefined ? state.meta[nextTi] : null;
  if (el('tss-mini-nextup'))   el('tss-mini-nextup').textContent   = nextM ? `${nextM.artist} — ${nextM.title}` : 'end of queue';
  if (el('tss-mini-queuepos')) el('tss-mini-queuepos').textContent = `${state.stats.played} / ${state.queue.length}`;
}

// Shift the mini-player left when the sidebar opens so they don't overlap;
// restore its anchored position when the sidebar closes.
// Uses data-autoShifted to distinguish auto-moved elements from user-dragged ones.
function shiftMiniPlayer(sidebarOpen) {
  const mini = document.getElementById('tss-mini');
  const tab  = document.getElementById('tss-mini-tab');

  [mini, tab].forEach(el => {
    if (!el || el.style.display === 'none') return;

    if (sidebarOpen) {
      const rect = el.getBoundingClientRect();
      if (rect.right > window.innerWidth - 308) {
        el.dataset.autoShifted = '1';
        el.style.left   = (window.innerWidth - 320 - el.offsetWidth) + 'px';
        el.style.top    = rect.top + 'px';
        el.style.right  = 'auto';
        el.style.bottom = 'auto';
      }
    } else if (el.dataset.autoShifted) {
      // Only restore elements we auto-shifted, not ones the user dragged.
      delete el.dataset.autoShifted;
      el.style.left   = '';
      el.style.top    = '';
      el.style.right  = '20px';
      el.style.bottom = '60px';
    }
  });
}

// ── src/ui/sidebar.js ─────────────────────────────────────────────────────────

// ── Sidebar ───────────────────────────────────────────────────────────────────

// Build the slide-in queue panel and its persistent edge tab.
function mkSidebar() {
  if (document.getElementById('tss-sidebar')) return;

  // Edge tab — always visible, click to open/close.
  const tab = document.createElement('div');
  tab.id = 'tss-sidebar-tab';
  tab.textContent = '🔀';
  tab.style.cssText = `
    position:fixed; right:0; top:50%; transform:translateY(-50%);
    background:#f50; color:#fff;
    width:28px; height:60px;
    display:flex; align-items:center; justify-content:center;
    border-radius:6px 0 0 6px;
    cursor:pointer; z-index:99998; font-size:16px;
    box-shadow:-2px 0 8px rgba(0,0,0,0.4); transition:right 0.25s;
  `;
  tab.onmouseenter = () => { tab.style.background = '#e64a00'; };
  tab.onmouseleave = () => { tab.style.background = '#f50'; };
  tab.onclick = toggleSidebar;

  // Sidebar panel.
  const sidebar = document.createElement('div');
  sidebar.id = 'tss-sidebar';
  sidebar.style.cssText = `
    position:fixed; right:-320px; top:0;
    width:300px; height:calc(100vh - 50px);
    background:#0d0d0d; border-left:1px solid #1a1a1a;
    z-index:99997; display:flex; flex-direction:column;
    transition:right 0.25s; font-family:-apple-system,sans-serif;
    box-shadow:-4px 0 20px rgba(0,0,0,0.7);
  `;

  sidebar.innerHTML = `
    <div style="padding:12px 14px;border-bottom:1px solid #1a1a1a;flex-shrink:0;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
        <span style="color:#fff;font-size:13px;font-weight:600;">🔀 queue</span>
        <div style="display:flex;gap:10px;align-items:center;">
          <span id="tss-stats-btn" style="color:#555;font-size:13px;cursor:pointer;" title="session stats">📊</span>
          <span id="tss-sidebar-count" style="color:#555;font-size:11px;"></span>
        </div>
      </div>
      <div style="display:flex;align-items:center;justify-content:center;gap:8px;margin-bottom:10px;">
        <button id="tss-ctrl-prev" style="background:#1a1a1a;border:none;color:#ccc;width:34px;height:34px;border-radius:50%;cursor:pointer;font-size:14px;">⏮</button>
        <button id="tss-ctrl-play" style="background:#f50;border:none;color:#fff;width:40px;height:40px;border-radius:50%;cursor:pointer;font-size:16px;">⏸</button>
        <button id="tss-ctrl-next" style="background:#1a1a1a;border:none;color:#ccc;width:34px;height:34px;border-radius:50%;cursor:pointer;font-size:14px;">⏭</button>
      </div>
      <div id="tss-sidebar-seekbar" style="height:6px;background:#1a1a1a;border-radius:3px;overflow:hidden;cursor:pointer;margin-bottom:8px;" title="click to seek">
        <div id="tss-progress-inner" style="height:100%;background:#f50;width:0%;transition:width 0.3s linear;pointer-events:none;"></div>
      </div>
      <input id="tss-search" placeholder="search queue…"
        style="width:100%;box-sizing:border-box;background:#1a1a1a;border:1px solid #2a2a2a;border-radius:4px;color:#ccc;font-size:12px;padding:5px 8px;outline:none;" />
    </div>
    <div id="tss-sidebar-list" style="overflow-y:auto;flex:1;padding:4px 0;scrollbar-width:thin;scrollbar-color:#222 transparent;"></div>
  `;

  document.body.appendChild(tab);
  document.body.appendChild(sidebar);

  const st = () => document.getElementById('tss-status');

  document.getElementById('tss-ctrl-play').onclick = toggle;
  document.getElementById('tss-ctrl-next').onclick = () => { state.manualAction = true; next(st()); };
  document.getElementById('tss-ctrl-prev').onclick = () => prevTrack(st());
  document.getElementById('tss-stats-btn').onclick = showStats;

  document.getElementById('tss-sidebar-seekbar').onclick = e => {
    const rect = e.currentTarget.getBoundingClientRect();
    seekTo((e.clientX - rect.left) / rect.width);
  };

  document.getElementById('tss-search').oninput = e => renderList(e.target.value);
  document.getElementById('tss-search').onclick  = e => e.stopPropagation();
}

// Toggle the sidebar open/closed and move the mini-player out of the way.
function toggleSidebar() {
  state.sidebarOpen = !state.sidebarOpen;
  const s = document.getElementById('tss-sidebar');
  const t = document.getElementById('tss-sidebar-tab');
  if (s) s.style.right = state.sidebarOpen ? '0'      : '-320px';
  if (t) t.style.right = state.sidebarOpen ? '300px'  : '0';
  shiftMiniPlayer(state.sidebarOpen);
}

// ── src/ui/list.js ────────────────────────────────────────────────────────────

// ── Queue list renderer ───────────────────────────────────────────────────────

// Render the queue inside the sidebar list, optionally filtered by `filter`.
function renderList(filter = '') {
  const list  = document.getElementById('tss-sidebar-list');
  const count = document.getElementById('tss-sidebar-count');
  if (!list) return;

  list.innerHTML = '';

  if (!state.active || !state.queue.length) {
    list.innerHTML = `<div style="color:#444;font-size:12px;padding:24px 16px;text-align:center;">start shuffle to see queue</div>`;
    if (count) count.textContent = '';
    return;
  }

  const q = filter.toLowerCase();
  if (count) count.textContent = `${state.stats.played} / ${state.queue.length}`;

  // Suspended banner — shown when an external track is playing.
  if (state.suspended && !q) {
    const banner = document.createElement('div');
    banner.style.cssText = 'padding:6px 12px;font-size:10px;color:#f50;background:rgba(255,85,0,0.07);border-bottom:1px solid #1a1a1a;';
    banner.textContent = '↩ external track playing — queue will resume after';
    list.appendChild(banner);
  }

  // "Play next" section — shown above the queue when there are pending tracks.
  if (state.playNext.length && !q) {
    const header = document.createElement('div');
    header.style.cssText = 'padding:4px 12px 2px;font-size:10px;color:#555;text-transform:uppercase;letter-spacing:0.05em;';
    header.textContent = `play next (${state.playNext.length})`;
    list.appendChild(header);

    state.playNext.forEach((ti, i) => {
      const m   = state.meta[ti] || { title: '—', artist: '—', artwork: null };
      const row = mkRow(m, -1, ti, false, false);
      row.style.opacity    = '0.7';
      row.style.borderLeft = '3px solid #333';
      // Right-click a playNext item to remove it.
      row.oncontextmenu = e => { e.preventDefault(); state.playNext.splice(i, 1); renderList(); };
      list.appendChild(row);
    });

    const divider = document.createElement('div');
    divider.style.cssText = 'height:1px;background:#1a1a1a;margin:4px 0;';
    list.appendChild(divider);
  }

  // Main queue rows.
  state.queue.forEach((ti, qi) => {
    const m = state.meta[ti] || { title: '—', artist: '—', artwork: null };
    if (q && !m.title.toLowerCase().includes(q) && !m.artist.toLowerCase().includes(q)) return;

    const cur  = qi === state.pos;
    const past = qi <  state.pos;
    const row  = mkRow(m, qi, ti, cur, past);

    // Drag-to-reorder.
    row.draggable   = true;
    row.ondragstart = e => {
      state.dragSrc = qi;
      e.dataTransfer.effectAllowed = 'move';
      row.style.opacity = '0.4';
    };
    row.ondragend   = () => { row.style.opacity = past ? '0.3' : '1'; };
    row.ondragover  = e => { e.preventDefault(); row.style.background = 'rgba(255,85,0,0.08)'; };
    row.ondragleave = () => { row.style.background = cur ? 'rgba(255,85,0,0.1)' : 'transparent'; };
    row.ondrop = e => {
      e.preventDefault();
      if (state.dragSrc === null || state.dragSrc === qi) return;
      const src     = state.dragSrc;
      const [moved] = state.queue.splice(src, 1);
      state.queue.splice(qi, 0, moved);
      if      (state.pos === src)                          state.pos = qi;
      else if (src < state.pos && qi >= state.pos)         state.pos--;
      else if (src > state.pos && qi <= state.pos)         state.pos++;
      state.dragSrc = null;
      badges();
      renderList(filter);
    };

    row.onclick       = () => jumpTo(qi, ti, document.getElementById('tss-status'));
    row.oncontextmenu = e => showCtxMenu(e, qi, ti);
    list.appendChild(row);
  });

  // Auto-scroll the current track into view (when not searching).
  if (!q) {
    let offset = state.playNext.length ? state.playNext.length + 2 : 0;
    if (state.suspended) offset++; // account for the suspended banner prepended above
    list.children[state.pos + offset]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  refreshPlayBtn();
}

// Build a single queue row element.
function mkRow(m, qi, ti, cur, past) {
  const row = document.createElement('div');
  row.style.cssText = `
    display:flex; align-items:center; gap:10px; padding:7px 12px;
    cursor:pointer;
    background:${cur ? 'rgba(255,85,0,0.1)' : 'transparent'};
    border-left:3px solid ${cur ? '#f50' : 'transparent'};
    transition:background 0.15s;
    opacity:${past ? '0.3' : '1'};
    -webkit-user-select:none;
    user-select:none;
  `;
  row.onmouseenter = () => { if (!cur) row.style.background = 'rgba(255,255,255,0.03)'; };
  row.onmouseleave = () => { if (!cur) row.style.background = 'transparent'; };

  // Artwork thumbnail.
  const art = document.createElement('div');
  art.style.cssText = 'width:38px;height:38px;border-radius:4px;flex-shrink:0;background:#1a1a1a;overflow:hidden;display:flex;align-items:center;justify-content:center;';
  if (m.artwork) {
    const img = document.createElement('img');
    img.src           = m.artwork;
    img.style.cssText = 'width:100%;height:100%;object-fit:cover;';
    img.onerror       = () => { art.innerHTML = '<span style="font-size:16px;color:#333;">♪</span>'; };
    art.appendChild(img);
  } else {
    art.innerHTML = '<span style="font-size:16px;color:#333;">♪</span>';
  }

  // Position number / playing indicator.
  const num = document.createElement('div');
  num.style.cssText = `font-size:10px;color:${cur ? '#f50' : '#444'};font-weight:${cur ? '700' : '400'};min-width:18px;text-align:center;flex-shrink:0;`;
  const displayNum  = qi >= 0 ? state.stats.played + (qi - state.pos) : '↑';
  num.textContent   = cur ? '▶' : displayNum;

  // Title + artist text block — esc() prevents XSS from track metadata.
  const txt = document.createElement('div');
  txt.style.cssText = 'overflow:hidden;flex:1;';
  txt.innerHTML = `
    <div style="font-size:12px;color:${cur ? '#fff' : '#bbb'};font-weight:${cur ? '600' : '400'};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(m.title)}</div>
    <div style="font-size:11px;color:#555;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px;">${esc(m.artist)}</div>
  `;

  row.append(art, num, txt);
  return row;
}

// ── src/ui/contextMenu.js ─────────────────────────────────────────────────────

// ── Context menu ──────────────────────────────────────────────────────────────
// Right-click a queue row to get quick track actions.

function showCtxMenu(e, qi, ti) {
  e.preventDefault();
  e.stopPropagation();
  document.getElementById('tss-ctx')?.remove();

  const m    = state.meta[ti] || {};
  const menu = document.createElement('div');
  menu.id = 'tss-ctx';
  menu.style.cssText = `
    position:fixed;
    left:${Math.min(e.clientX, window.innerWidth - 180)}px;
    top:${Math.min(e.clientY, window.innerHeight - 180)}px;
    background:#1a1a1a; border:1px solid #333; border-radius:5px;
    z-index:999999; font-size:12px; font-family:-apple-system,sans-serif;
    overflow:hidden; min-width:170px;
  `;

  const items = [
    {
      label:    '⏭ play next',
      action:   () => queueNext(ti),
    },
    {
      label:    '↑ move up',
      disabled: qi <= state.pos + 1,
      action:   () => {
        if (qi <= state.pos + 1) return;
        [state.queue[qi], state.queue[qi - 1]] = [state.queue[qi - 1], state.queue[qi]];
        if      (state.pos === qi)     state.pos--;
        else if (state.pos === qi - 1) state.pos++;
        badges();
        renderList();
      },
    },
    {
      label:    '↓ move down',
      disabled: qi >= state.queue.length - 1,
      action:   () => {
        if (qi >= state.queue.length - 1) return;
        [state.queue[qi], state.queue[qi + 1]] = [state.queue[qi + 1], state.queue[qi]];
        if      (state.pos === qi)     state.pos++;
        else if (state.pos === qi + 1) state.pos--;
        badges();
        renderList();
      },
    },
    {
      label:  '🔗 copy link',
      action: () => { if (m.link) navigator.clipboard.writeText(m.link).catch(() => {}); },
    },
    {
      label:    '✕ remove',
      disabled: qi === state.pos,
      action:   () => removeFromQueue(qi),
    },
  ];

  items.forEach(({ label, action, disabled }) => {
    const item = document.createElement('div');
    item.textContent = label;
    item.style.cssText = `
      padding:8px 14px;
      cursor:${disabled ? 'not-allowed' : 'pointer'};
      color:${disabled ? '#444' : '#ccc'};
      transition:background 0.1s;
    `;
    if (!disabled) {
      item.onmouseenter = () => { item.style.background = '#2a2a2a'; };
      item.onmouseleave = () => { item.style.background = 'transparent'; };
      item.onclick      = () => { action(); menu.remove(); };
    }
    menu.appendChild(item);
  });

  document.body.appendChild(menu);
  // Dismiss on the next click anywhere.
  setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
}

// ── src/ui/inject.js ──────────────────────────────────────────────────────────

// ── Main UI injection ─────────────────────────────────────────────────────────

function mkUI() {
  // Inject button styles once. All state changes are driven by data-state and
  // :disabled so no inline style overrides are needed anywhere else.
  if (!document.getElementById('tss-style')) {
    const s = document.createElement('style');
    s.id = 'tss-style';
    s.textContent = `
      #tss-btn {
        background: #111;
        color: #f50;
        border: 1px solid rgba(255,85,0,0.35);
        border-radius: 8px;
        padding: 8px 18px;
        font-size: 13px;
        font-weight: 600;
        font-family: -apple-system,sans-serif;
        cursor: pointer;
        transition: background 0.2s, border-color 0.2s, box-shadow 0.2s;
        box-shadow: 0 2px 8px rgba(0,0,0,0.5);
        letter-spacing: 0.01em;
        outline: none;
      }
      #tss-btn:not(:disabled):not([data-state="active"]):hover {
        background: rgba(255,85,0,0.1);
        border-color: #f50;
        box-shadow: 0 0 16px rgba(255,85,0,0.2);
      }
      #tss-btn[data-state="active"] {
        background: #f50;
        color: #fff;
        border-color: transparent;
        box-shadow: 0 2px 14px rgba(255,85,0,0.4), 0 0 0 1px rgba(255,85,0,0.15);
      }
      #tss-btn[data-state="active"]:not(:disabled):hover {
        background: #e64a00;
        box-shadow: 0 2px 18px rgba(255,85,0,0.5);
      }
      #tss-btn:disabled {
        color: #3a3a3a;
        border-color: #1e1e1e;
        background: #111;
        cursor: not-allowed;
        box-shadow: none;
        animation: tss-pulse 1.2s ease-in-out infinite;
      }
      @keyframes tss-pulse {
        0%, 100% { opacity: 1; }
        50%       { opacity: 0.4; }
      }
    `;
    document.head.appendChild(s);
  }

  const wrap = document.createElement('div');
  wrap.id = 'tss-wrapper';
  wrap.style.cssText = 'display:flex;align-items:center;gap:10px;margin:8px 0;flex-wrap:wrap;';

  const btn = document.createElement('button');
  btn.id            = 'tss-btn';
  btn.textContent   = state.active ? '⏹ Stop' : '🔀 True Shuffle';
  btn.dataset.state = state.active ? 'active'  : 'idle';

  const label = document.createElement('label');
  label.style.cssText = 'display:flex;align-items:center;gap:5px;font-size:11px;color:#555;cursor:pointer;-webkit-user-select:none;user-select:none;font-family:-apple-system,sans-serif;';
  const cb = document.createElement('input');
  cb.type          = 'checkbox';
  cb.checked       = state.autoRepeat;
  cb.style.accentColor = '#f50';
  cb.onchange      = () => { state.autoRepeat = cb.checked; };
  label.append(cb, document.createTextNode('repeat'));

  const status = document.createElement('span');
  status.id = 'tss-status';
  status.style.cssText = 'font-size:12px;color:#555;font-family:-apple-system,sans-serif;';

  btn.onclick = () => start(btn, status);
  wrap.append(btn, label, status);
  return wrap;
}

// Find a suitable container in the SoundCloud DOM and prepend the UI into it.
async function inject() {
  if (document.getElementById('tss-wrapper')) return;

  const sels = [
    '.sc-list-actions',
    '.listenEngagement__actions',
    '.trackList__tracksActions',
    '.userMain__content .sc-button-toolbar',
    '.soundActions',
    '.playlist__controls',
    '.userBadge__info',
    '.playlist__trackList',
    '.soundList',
    '.trackList',
  ];
  const container = sels.reduce((found, s) => found || document.querySelector(s), null);
  if (!container) return;

  container.prepend(mkUI());
  mkSidebar();
}

// ── src/nav.js ────────────────────────────────────────────────────────────────

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
        const status = document.getElementById('tss-status');
        // Pause the watcher while updating state.els to avoid a race where
        // next() fires mid-update and reads a partially-refreshed element array.
        // Handle both the Worker path and the setInterval fallback.
        state.worker?.postMessage('stop');
        if (state._workerInterval) {
          clearInterval(state._workerInterval);
          state._workerInterval = null;
        }
        const freshEls = await loadTracks(status);
        if (freshEls.length > 0) {
          state.els  = freshEls;
          state.meta = freshEls.map(getMeta);
        }
        if (state.worker) {
          state.worker.postMessage('start');
        } else {
          startWatcher(status);
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
          if (Date.now() - (c.ts || 0) < 30 * 60 * 1000
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

})();
