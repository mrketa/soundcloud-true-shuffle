// ==UserScript==
// @name         SoundCloud True Shuffle
// @namespace    https://greasyfork.org/scripts/soundcloud-true-shuffle
// @version      4.1.0
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

const state = {
  active:       false,
  autoRepeat:   true,
  queue:        [],
  playNext:     [],
  pos:          0,
  els:          [],
  meta:         [],
  worker:       null,
  busy:         false,
  loading:      false,
  lastTitle:    '',
  lastProgress: 0,
  sidebarOpen:  false,
  manualAction: false,
  dragSrc:      null,
  history:      [],
  priority:     {},    // ti → weight: 0.25 low, 1.0 normal, 2.0 high
  suspended:    false,
  playlistUrl:  '',
  _savedStats:  null,
  stats: {
    played:     0,
    playCounts: {},
    elapsed:    0,
  },
};

// ── src/utils.js ──────────────────────────────────────────────────────────────

function fisherYates(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const wait = ms => new Promise(r => setTimeout(r, ms));

function playerTitle() {
  for (const s of ['.playbackSoundBadge__titleLink', '.playbackSoundBadge a[title]', '.playerTrackName']) {
    const el = document.querySelector(s);
    if (!el) continue;
    // SC's textContent includes an accessibility prefix we don't want
    const t = (el.getAttribute('title') || el.textContent)
      .trim()
      .replace(/^current\s+track:\s*/i, '');
    if (t) return t;
  }
  return '';
}

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

function currentSec() {
  const el = document.querySelector('.playbackTimeline__timePassed');
  if (!el) return 0;
  const m = el.textContent.match(/(\d+):(\d{2})$/);
  return m ? +m[1] * 60 + +m[2] : 0;
}

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

function refreshPlayBtn() {
  const p = document.getElementById('tss-hub-play');
  if (p) p.textContent = paused() ? '▶' : '⏸';
}

function updateProgressBar() {
  const p = document.getElementById('tss-hub-prog');
  if (p) p.style.width = `${Math.min(100, progress() * 100).toFixed(1)}%`;
}

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

function getLink(el) {
  const a = el.querySelector('.trackItem__trackTitle, .soundTitle__title, a.sc-link-primary');
  if (!a) return null;
  const href = a.getAttribute('href');
  if (!href) return null;
  return href.startsWith('http') ? href : 'https://soundcloud.com' + href;
}

// Stable identity for a track across page reloads — prefers permalink URL.
function trackId(m) {
  if (!m) return null;
  if (m.link) return m.link;
  const t = m.title, a = m.artist;
  if ((t && t !== '—') || (a && a !== '—')) return `${t}|||${a}`;
  return null;
}

function getMeta(el) {
  return {
    title:   el.querySelector('.trackItem__trackTitle, .soundTitle__title, .sc-link-primary')?.textContent.trim() || '—',
    artist:  el.querySelector('.trackItem__username, .soundTitle__username, .sc-link-secondary')?.textContent.trim() || '—',
    artwork: artwork(el),
    link:    getLink(el),
  };
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── src/worker.js ─────────────────────────────────────────────────────────────

// Fires a message every 300 ms so the watcher polls even in background tabs.
function mkWorker() {
  try {
    const src = `
      let t = null;
      self.onmessage = e => {
        if (e.data === 'start') { clearInterval(t); t = setInterval(() => self.postMessage(0), 300); }
        else                    { clearInterval(t); t = null; }
      };
    `;
    const url = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
    const w   = new Worker(url);
    URL.revokeObjectURL(url);
    return w;
  } catch (_) {
    return null; // CSP blocked — caller falls back to setInterval
  }
}

// ── src/playback.js ───────────────────────────────────────────────────────────

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

// ── src/watcher.js ────────────────────────────────────────────────────────────

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

// ── src/ui/badges.js ──────────────────────────────────────────────────────────

function badges() {
  document.querySelectorAll('.tss-badge').forEach(b => b.remove());

  state.queue.forEach((ti, qi) => {
    const el = state.els[ti];
    if (!el || !document.body.contains(el) || el.querySelector('.tss-badge')) return;

    const cur = qi === state.pos;
    const b   = document.createElement('span');
    b.className    = 'tss-badge';
    b.style.cssText = [
      'display:inline-block',
      `background:${cur ? '#f50' : '#2a2a2a'}`,
      `color:${cur ? '#fff' : '#888'}`,
      `border:1px solid ${cur ? '#f50' : '#444'}`,
      'border-radius:3px',
      'font-size:10px',
      'font-weight:bold',
      'padding:1px 5px',
      'margin-right:5px',
      'vertical-align:middle',
    ].join(';');
    const n       = state.stats.played + (qi - state.pos);
    b.textContent = cur ? `▶ ${n}` : `${n}`;

    const t = el.querySelector('.trackItem__trackTitle, .soundTitle__title, .sc-link-primary');
    if (t) t.parentNode.insertBefore(b, t);
  });
}

// ── src/ui/stats.js ───────────────────────────────────────────────────────────

function tickPlayTime() {
  if (state.active && !state.suspended && !paused()) {
    state.stats.elapsed = (state.stats.elapsed || 0) + 1;
  }
}
setInterval(tickPlayTime, 1000);

function renderStats() {
  const overlay = document.getElementById('tss-stats-overlay');
  if (!overlay) return;

  const elapsed  = state.stats.elapsed || 0;
  const h        = Math.floor(elapsed / 3600);
  const m        = Math.floor((elapsed % 3600) / 60);
  const s        = elapsed % 60;
  const duration = h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;

  const top = Object.entries(state.stats.playCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);

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
    const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup',   up);
  };
}

// ── src/ui/hub.js ─────────────────────────────────────────────────────────────

// Hub — central floating panel. Draggable, collapsible sections.
// Remove: delete file, remove mkHub() from inject.js, remove updateHub() call sites.

function mkHub() {
  if (document.getElementById('tss-hub')) return;

  if (!document.getElementById('tss-hub-style')) {
    const s = document.createElement('style');
    s.id = 'tss-hub-style';
    s.textContent = `
      .tss-hub-sh {
        display:flex; align-items:center; justify-content:space-between;
        padding:6px 12px; cursor:pointer;
        font-size:9px; color:#444;
        text-transform:uppercase; letter-spacing:0.07em;
        border-bottom:1px solid #1a1a1a;
      }
      .tss-hub-sh:hover { background:rgba(255,255,255,0.02); }
      .tss-hub-arr { font-size:9px; color:#333; transition:transform 0.15s; }
      .tss-hub-sec { border-top:1px solid #1a1a1a; }
      #tss-hub-start { transition:background 0.2s, color 0.2s, border-color 0.2s; }
      #tss-hub-start[data-active="true"] {
        background:#f50 !important; color:#fff !important; border-color:transparent !important;
      }
      #tss-hub-start[data-active="true"]:hover { background:#e64a00 !important; }
      #tss-hub-start:not([data-active="true"]):not([data-loading="true"]):hover {
        background:rgba(255,85,0,0.1) !important; border-color:#f50 !important;
      }
      #tss-hub-start[data-loading="true"] {
        color:#555 !important; border-color:#1e1e1e !important;
        cursor:not-allowed !important;
        animation:tss-pulse 1.2s ease-in-out infinite;
      }
      #tss-hub-qico {
        font-size:10px; color:#555; cursor:pointer;
        padding:2px 7px; border-radius:3px;
        background:#1a1a1a; border:1px solid #2a2a2a;
        transition:color 0.15s, background 0.15s, border-color 0.15s;
        line-height:1.6; flex-shrink:0;
      }
      #tss-hub-qico:hover { color:#bbb; border-color:#444; }
      #tss-hub-qico[data-open="true"] {
        color:#f50; background:rgba(255,85,0,0.08); border-color:rgba(255,85,0,0.35);
      }
    `;
    document.head.appendChild(s);
  }

  const hub = document.createElement('div');
  hub.id = 'tss-hub';
  hub.style.cssText = `
    position:fixed; bottom:60px; left:20px; width:230px;
    background:#111; border:1px solid #222; border-radius:10px;
    z-index:99994; font-family:-apple-system,sans-serif;
    box-shadow:0 4px 20px rgba(0,0,0,0.7);
    overflow:hidden; -webkit-user-select:none; user-select:none;
  `;

  hub.innerHTML = `
    <div id="tss-hub-hdr" style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:#0d0d0d;cursor:move;">
      <span style="color:#f50;font-size:12px;font-weight:700;letter-spacing:0.02em;">♫ True Shuffle</span>
      <span id="tss-hub-col" style="color:#555;cursor:pointer;font-size:15px;line-height:1;padding:2px 4px;" title="collapse">−</span>
    </div>

    <div id="tss-hub-body">

      <div id="tss-hub-s-np" class="tss-hub-sec" style="display:none;">
        <div class="tss-hub-sh" data-body="tss-hub-s-np-b">
          <span>now playing</span><span class="tss-hub-arr">▾</span>
        </div>
        <div id="tss-hub-s-np-b" style="padding:10px 12px 12px;">
          <div style="display:flex;gap:10px;align-items:center;margin-bottom:8px;">
            <div id="tss-hub-art" style="width:40px;height:40px;border-radius:5px;background:#1a1a1a;flex-shrink:0;overflow:hidden;display:flex;align-items:center;justify-content:center;font-size:18px;color:#333;">♪</div>
            <div style="overflow:hidden;flex:1;min-width:0;">
              <div id="tss-hub-title" style="color:#fff;font-size:11px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.4;">—</div>
              <div id="tss-hub-artist" style="color:#555;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:3px;line-height:1.4;">—</div>
            </div>
          </div>
          <div id="tss-hub-seekbar" style="height:4px;background:#1a1a1a;border-radius:2px;overflow:hidden;cursor:pointer;" title="seek">
            <div id="tss-hub-prog" style="height:100%;background:#f50;width:0%;transition:width 0.3s linear;pointer-events:none;"></div>
          </div>
        </div>
      </div>

      <div id="tss-hub-s-ctrl" class="tss-hub-sec" style="display:none;">
        <div class="tss-hub-sh" data-body="tss-hub-s-ctrl-b">
          <span>controls</span><span class="tss-hub-arr">▾</span>
        </div>
        <div id="tss-hub-s-ctrl-b" style="display:flex;align-items:center;justify-content:center;gap:10px;padding:10px 12px 12px;">
          <button id="tss-hub-prev"  style="background:#1a1a1a;border:none;color:#aaa;width:32px;height:32px;border-radius:50%;cursor:pointer;font-size:13px;">⏮</button>
          <button id="tss-hub-play"  style="background:#f50;border:none;color:#fff;width:38px;height:38px;border-radius:50%;cursor:pointer;font-size:16px;">⏸</button>
          <button id="tss-hub-next"  style="background:#1a1a1a;border:none;color:#aaa;width:32px;height:32px;border-radius:50%;cursor:pointer;font-size:13px;">⏭</button>
          <button id="tss-hub-stats" style="background:none;border:none;color:#555;cursor:pointer;font-size:13px;padding:4px;" title="session stats">📊</button>
        </div>
      </div>

      <div id="tss-hub-s-queue" class="tss-hub-sec" style="display:none;">
        <div class="tss-hub-sh" data-body="tss-hub-s-queue-b">
          <span>queue</span>
          <div style="display:flex;align-items:center;gap:4px;">
            <span id="tss-hub-qico" data-open="false" title="toggle queue panel">→</span>
            <span class="tss-hub-arr">▾</span>
          </div>
        </div>
        <div id="tss-hub-s-queue-b" style="padding:10px 12px 12px;display:flex;flex-direction:column;gap:8px;">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <span style="color:#555;font-size:10px;">played</span>
            <span id="tss-hub-qpos" style="color:#bbb;font-size:10px;">—</span>
          </div>
          <div style="display:flex;align-items:center;gap:6px;">
            <span style="color:#555;font-size:10px;flex-shrink:0;">next</span>
            <span id="tss-hub-nextup" style="color:#bbb;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;text-align:right;min-width:0;">—</span>
          </div>
        </div>
      </div>

      <div id="tss-hub-s-shuffle" class="tss-hub-sec">
        <div class="tss-hub-sh" data-body="tss-hub-s-shuffle-b">
          <span>shuffle</span><span class="tss-hub-arr">▾</span>
        </div>
        <div id="tss-hub-s-shuffle-b" style="padding:10px 12px 12px;display:flex;flex-direction:column;gap:8px;">
          <button id="tss-hub-start" data-active="false" data-loading="false" style="
            background:#111; color:#f50;
            border:1px solid rgba(255,85,0,0.35); border-radius:6px;
            padding:7px 10px; font-size:11px; font-weight:600;
            font-family:-apple-system,sans-serif; cursor:pointer; width:100%;
          ">True Shuffle</button>
          <label style="display:flex;align-items:center;gap:6px;font-size:10px;color:#555;cursor:pointer;">
            <input id="tss-hub-repeat" type="checkbox" style="accent-color:#f50;">
            repeat
          </label>
        </div>
      </div>

    </div>
  `;

  document.body.appendChild(hub);

  document.getElementById('tss-hub-play').onclick  = toggle;
  document.getElementById('tss-hub-prev').onclick  = () => prevTrack();
  document.getElementById('tss-hub-next').onclick  = () => { state.manualAction = true; next(); };
  document.getElementById('tss-hub-stats').onclick = showStats;
  document.getElementById('tss-hub-seekbar').onclick = e => {
    const r = e.currentTarget.getBoundingClientRect();
    seekTo((e.clientX - r.left) / r.width);
  };

  document.getElementById('tss-hub-qico').onclick = e => { e.stopPropagation(); toggleSidebar(); };

  const hubRepeat = document.getElementById('tss-hub-repeat');
  hubRepeat.checked  = state.autoRepeat;
  hubRepeat.onchange = () => { state.autoRepeat = hubRepeat.checked; };

  document.getElementById('tss-hub-start').onclick = () => { if (!state.loading) start(); };

  const colBtn  = document.getElementById('tss-hub-col');
  const hubBody = document.getElementById('tss-hub-body');
  colBtn.onclick = () => {
    const open            = hubBody.style.display !== 'none';
    hubBody.style.display = open ? 'none' : '';
    colBtn.textContent    = open ? '+' : '−';
  };

  hub.querySelectorAll('.tss-hub-sh').forEach(sh => {
    sh.onclick = () => {
      const b   = document.getElementById(sh.dataset.body);
      const arr = sh.querySelector('.tss-hub-arr');
      if (!b) return;
      const open = b.style.display !== 'none';
      b.style.display              = open ? 'none' : '';
      if (arr) arr.style.transform = open ? 'rotate(-90deg)' : '';
    };
  });

  const hubHdr = document.getElementById('tss-hub-hdr');
  hubHdr.onmousedown = e => {
    if (e.target.id === 'tss-hub-col') return;
    e.preventDefault();
    const rect = hub.getBoundingClientRect();
    hub.style.left   = rect.left + 'px';
    hub.style.top    = rect.top  + 'px';
    hub.style.bottom = 'auto';
    hub.style.right  = 'auto';
    const ox = e.clientX - rect.left, oy = e.clientY - rect.top;
    const move = ev => {
      hub.style.left = Math.max(0, Math.min(window.innerWidth  - hub.offsetWidth,  ev.clientX - ox)) + 'px';
      hub.style.top  = Math.max(0, Math.min(window.innerHeight - hub.offsetHeight, ev.clientY - oy)) + 'px';
    };
    const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup',   up);
  };

  updateHub();
}

function updateHub() {
  if (!document.getElementById('tss-hub')) return;

  const active  = state.active;
  const loading = state.loading;

  ['tss-hub-s-np', 'tss-hub-s-ctrl', 'tss-hub-s-queue'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = active ? '' : 'none';
  });

  const startBtn = document.getElementById('tss-hub-start');
  if (startBtn) {
    if (loading) {
      startBtn.textContent     = '⏳ loading…';
      startBtn.dataset.active  = 'false';
      startBtn.dataset.loading = 'true';
    } else if (active) {
      startBtn.textContent     = '⏹ Stop Shuffle';
      startBtn.dataset.active  = 'true';
      startBtn.dataset.loading = 'false';
    } else {
      startBtn.textContent     = 'True Shuffle';
      startBtn.dataset.active  = 'false';
      startBtn.dataset.loading = 'false';
    }
  }

  const cb = document.getElementById('tss-hub-repeat');
  if (cb && cb.checked !== state.autoRepeat) cb.checked = state.autoRepeat;

  const qi = document.getElementById('tss-hub-qico');
  if (qi) {
    qi.dataset.open = state.sidebarOpen ? 'true' : 'false';
    qi.textContent  = state.sidebarOpen ? '←' : '→';
    qi.title        = state.sidebarOpen ? 'close queue panel' : 'open queue panel';
  }

  if (!active) {
    const prog = document.getElementById('tss-hub-prog');
    if (prog) prog.style.width = '0%';
    return;
  }

  const pb = document.getElementById('tss-hub-play');
  if (pb) pb.textContent = paused() ? '▶' : '⏸';

  if (state.suspended) {
    const tEl = document.getElementById('tss-hub-title');
    const aEl = document.getElementById('tss-hub-artist');
    if (tEl) tEl.textContent = playerTitle() || '—';
    if (aEl) aEl.textContent = '↩ not in queue';
    const art = document.getElementById('tss-hub-art');
    if (art && art.dataset.src) { delete art.dataset.src; art.innerHTML = '♪'; }
    return;
  }

  const m   = state.meta[state.queue?.[state.pos]];
  const tEl = document.getElementById('tss-hub-title');
  const aEl = document.getElementById('tss-hub-artist');
  if (tEl) tEl.textContent = playerTitle() || m?.title  || '—';
  if (aEl) aEl.textContent = m?.artist || '—';

  const art = document.getElementById('tss-hub-art');
  if (art) {
    if (m?.artwork && art.dataset.src !== m.artwork) {
      art.dataset.src = m.artwork;
      art.innerHTML   = '';
      const img = document.createElement('img');
      img.src           = m.artwork;
      img.style.cssText = 'width:100%;height:100%;object-fit:cover;';
      img.onerror       = () => { art.innerHTML = '♪'; };
      art.appendChild(img);
    } else if (!m?.artwork && art.dataset.src) {
      delete art.dataset.src;
      art.innerHTML = '♪';
    }
  }

  const prog = document.getElementById('tss-hub-prog');
  if (prog) prog.style.width = `${Math.min(100, progress() * 100).toFixed(1)}%`;

  const nextTi = state.queue[state.pos + 1];
  const nextM  = nextTi !== undefined ? state.meta[nextTi] : null;
  const qpos   = document.getElementById('tss-hub-qpos');
  const nextup = document.getElementById('tss-hub-nextup');
  if (qpos)   qpos.textContent   = `${state.stats.played} / ${state.queue.length}`;
  if (nextup) nextup.textContent = nextM ? nextM.title : 'end of queue';
}

// ── src/ui/sidebar.js ─────────────────────────────────────────────────────────

// Slide-in queue panel — toggled via the hub. No playback controls here.

function mkSidebar() {
  if (document.getElementById('tss-sidebar')) return;

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
    <div style="padding:12px 14px 10px;border-bottom:1px solid #1a1a1a;flex-shrink:0;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
        <span style="color:#fff;font-size:13px;font-weight:600;">queue</span>
        <div style="display:flex;gap:10px;align-items:center;">
          <span id="tss-stats-btn" style="color:#555;font-size:13px;cursor:pointer;" title="session stats">📊</span>
          <span id="tss-sidebar-count" style="color:#555;font-size:11px;"></span>
        </div>
      </div>
      <input id="tss-search" placeholder="search queue…"
        style="width:100%;box-sizing:border-box;background:#1a1a1a;border:1px solid #2a2a2a;border-radius:4px;color:#ccc;font-size:12px;padding:5px 8px;outline:none;" />
    </div>
    <div id="tss-sidebar-list" style="overflow-y:auto;flex:1;padding:4px 0;scrollbar-width:thin;scrollbar-color:#222 transparent;"></div>
  `;

  document.body.appendChild(sidebar);

  document.getElementById('tss-stats-btn').onclick = showStats;
  document.getElementById('tss-search').oninput = e => renderList(e.target.value);
  document.getElementById('tss-search').onclick  = e => e.stopPropagation();
}

function toggleSidebar() {
  state.sidebarOpen = !state.sidebarOpen;
  const s = document.getElementById('tss-sidebar');
  if (s) s.style.right = state.sidebarOpen ? '0' : '-320px';
  updateHub();
}

// ── src/ui/list.js ────────────────────────────────────────────────────────────

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

  if (state.suspended && !q) {
    const banner = document.createElement('div');
    banner.style.cssText = 'padding:6px 12px;font-size:10px;color:#f50;background:rgba(255,85,0,0.07);border-bottom:1px solid #1a1a1a;';
    banner.textContent = '↩ external track playing — queue will resume after';
    list.appendChild(banner);
  }

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
      row.oncontextmenu = e => { e.preventDefault(); state.playNext.splice(i, 1); renderList(); };
      list.appendChild(row);
    });

    const divider = document.createElement('div');
    divider.style.cssText = 'height:1px;background:#1a1a1a;margin:4px 0;';
    list.appendChild(divider);
  }

  state.queue.forEach((ti, qi) => {
    const m = state.meta[ti] || { title: '—', artist: '—', artwork: null };
    if (q && !m.title.toLowerCase().includes(q) && !m.artist.toLowerCase().includes(q)) return;

    const cur  = qi === state.pos;
    const past = qi <  state.pos;
    const row  = mkRow(m, qi, ti, cur, past);

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
      if      (state.pos === src)                  state.pos = qi;
      else if (src < state.pos && qi >= state.pos) state.pos--;
      else if (src > state.pos && qi <= state.pos) state.pos++;
      state.dragSrc = null;
      badges();
      renderList(filter);
    };

    row.onclick       = () => jumpTo(qi, ti);
    row.oncontextmenu = e => showCtxMenu(e, qi, ti);
    list.appendChild(row);
  });

  if (!q) {
    let offset = state.playNext.length ? state.playNext.length + 2 : 0;
    if (state.suspended) offset++;
    list.children[state.pos + offset]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  refreshPlayBtn();
}

function mkRow(m, qi, ti, cur, past) {
  const row = document.createElement('div');
  row.style.cssText = `
    display:flex; align-items:center; gap:10px; padding:7px 12px;
    cursor:pointer;
    background:${cur ? 'rgba(255,85,0,0.1)' : 'transparent'};
    border-left:3px solid ${cur ? '#f50' : 'transparent'};
    transition:background 0.15s;
    opacity:${past ? '0.3' : '1'};
    -webkit-user-select:none; user-select:none;
  `;
  row.onmouseenter = () => { if (!cur) row.style.background = 'rgba(255,255,255,0.03)'; };
  row.onmouseleave = () => { if (!cur) row.style.background = 'transparent'; };

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

  const num = document.createElement('div');
  num.style.cssText = `font-size:10px;color:${cur ? '#f50' : '#444'};font-weight:${cur ? '700' : '400'};min-width:18px;text-align:center;flex-shrink:0;`;
  const displayNum  = qi >= 0 ? state.stats.played + (qi - state.pos) : '↑';
  num.textContent   = cur ? '▶' : displayNum;

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
    { label: '⏭ play next',  action: () => queueNext(ti) },
    {
      label:    '↑ move up',
      disabled: qi <= state.pos + 1,
      action:   () => {
        if (qi <= state.pos + 1) return;
        [state.queue[qi], state.queue[qi - 1]] = [state.queue[qi - 1], state.queue[qi]];
        if      (state.pos === qi)     state.pos--;
        else if (state.pos === qi - 1) state.pos++;
        badges(); renderList();
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
        badges(); renderList();
      },
    },
    { label: '🔗 copy link', action: () => { if (m.link) navigator.clipboard.writeText(m.link).catch(() => {}); } },
    { label: '✕ remove',    disabled: qi === state.pos, action: () => removeFromQueue(qi) },
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
  setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
}

// ── src/ui/inject.js ──────────────────────────────────────────────────────────

async function inject() {
  if (document.getElementById('tss-hub')) return;

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
  if (!sels.some(s => document.querySelector(s))) return;

  mkSidebar();
  mkHub();
}

// ── src/nav.js ────────────────────────────────────────────────────────────────

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

})();
