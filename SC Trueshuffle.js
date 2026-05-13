// ==UserScript==
// @name         SoundCloud True Shuffle
// @namespace    https://greasyfork.org/scripts/soundcloud-true-shuffle
// @version      5.0.0
// @description  Fixes SoundCloud's broken shuffle. Loads all tracks, actually random, works in background tabs.
// @author       keta
// @match        https://soundcloud.com/*
// @license      MIT
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
'use strict';

// init accent CSS vars early so all CSS can reference them
document.documentElement.style.setProperty('--tss-a',  '#ff5500');
document.documentElement.style.setProperty('--tss-ar', '255');
document.documentElement.style.setProperty('--tss-ag', '85');
document.documentElement.style.setProperty('--tss-ab', '0');

// ── state ─────────────────────────────────────────────────────────────────────

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
  sidebarTab:   'queue',
  manualAction: false,
  dragSrc:      null,
  history:      [],
  priority:     {},
  skipCounts:   {},
  sleepTimer:   null,
  suspended:    false,
  playlistUrl:  '',
  _savedStats:  null,
  _lifetimeBase: null,
  _lastAccentArtwork: '',
  _qnd:         false,
  stats: {
    played:     0,
    playCounts: {},
    elapsed:    0,
  },
};

// ── utils ─────────────────────────────────────────────────────────────────────

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
  if (p) p.innerHTML = paused() ? SVG.play : SVG.pause;
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

// ── icons ─────────────────────────────────────────────────────────────────────

const SVG = {
  play:    `<svg viewBox="0 0 16 16" fill="currentColor" style="display:block;width:14px;height:14px;flex-shrink:0"><path d="M3 2.5v11l10-5.5z"/></svg>`,
  pause:   `<svg viewBox="0 0 16 16" fill="currentColor" style="display:block;width:14px;height:14px;flex-shrink:0"><rect x="3" y="2" width="4" height="12" rx="1"/><rect x="9" y="2" width="4" height="12" rx="1"/></svg>`,
  prev:    `<svg viewBox="0 0 16 16" fill="currentColor" style="display:block;width:14px;height:14px;flex-shrink:0"><rect x="2" y="2" width="2.5" height="12" rx="1"/><path d="M5 8l8 5V3z"/></svg>`,
  next:    `<svg viewBox="0 0 16 16" fill="currentColor" style="display:block;width:14px;height:14px;flex-shrink:0"><rect x="11.5" y="2" width="2.5" height="12" rx="1"/><path d="M3 3v10l8-5z"/></svg>`,
  close:   `<svg viewBox="0 0 16 16" fill="currentColor" style="display:block;width:12px;height:12px;flex-shrink:0"><path d="M12.7 3.3a1 1 0 00-1.4 0L8 6.6 4.7 3.3a1 1 0 00-1.4 1.4L6.6 8l-3.3 3.3a1 1 0 101.4 1.4L8 9.4l3.3 3.3a1 1 0 001.4-1.4L9.4 8l3.3-3.3a1 1 0 000-1.4z"/></svg>`,
  chart:   `<svg viewBox="0 0 16 16" fill="currentColor" style="display:block;width:13px;height:13px;flex-shrink:0"><rect x="1" y="8" width="3" height="7" rx="1"/><rect x="6" y="5" width="3" height="10" rx="1"/><rect x="11" y="2" width="3" height="13" rx="1"/></svg>`,
  note:    `<svg viewBox="0 0 16 16" fill="currentColor" style="display:block;width:18px;height:18px;flex-shrink:0;opacity:0.25"><path d="M9 3v7.27A3 3 0 1 0 11 13V6h2V3H9zm-3 12a1 1 0 110-2 1 1 0 010 2z"/></svg>`,
  shuffle: `<svg viewBox="0 0 24 24" fill="currentColor" style="display:block;width:12px;height:12px;flex-shrink:0"><path d="M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/></svg>`,
  list:    `<svg viewBox="0 0 16 16" fill="currentColor" style="display:block;width:13px;height:13px;flex-shrink:0"><rect x="1" y="2.5" width="14" height="1.5" rx="0.75"/><rect x="1" y="7.25" width="14" height="1.5" rx="0.75"/><rect x="1" y="12" width="14" height="1.5" rx="0.75"/></svg>`,
  moon:    `<svg viewBox="0 0 16 16" fill="currentColor" style="display:block;width:11px;height:11px;flex-shrink:0"><path d="M14 10.66A6.5 6.5 0 115.34 2a5 5 0 108.66 8.66z"/></svg>`,
  plus:    `<svg viewBox="0 0 16 16" fill="currentColor" style="display:block;width:12px;height:12px;flex-shrink:0"><path d="M8 3a1 1 0 011 1v3h3a1 1 0 110 2H9v3a1 1 0 11-2 0V9H4a1 1 0 110-2h3V4a1 1 0 011-1z"/></svg>`,
};

// ── worker ────────────────────────────────────────────────────────────────────

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
    return null;
  }
}

// ── persistent stats ──────────────────────────────────────────────────────────

const LIFETIME_KEY = 'tss_lifetime';

function loadLifetimeStats() {
  try {
    const raw = localStorage.getItem(LIFETIME_KEY);
    if (!raw) return { played: 0, playCounts: {}, elapsed: 0 };
    return JSON.parse(raw);
  } catch (_) { return { played: 0, playCounts: {}, elapsed: 0 }; }
}

function saveLifetimeStats() {
  try {
    const lt   = loadLifetimeStats();
    const base = state._lifetimeBase || { played: 0, elapsed: 0, playCounts: {} };
    const merged = {
      played:     (lt.played  || 0) + Math.max(0, (state.stats.played  || 0) - (base.played  || 0)),
      elapsed:    (lt.elapsed || 0) + Math.max(0, (state.stats.elapsed || 0) - (base.elapsed || 0)),
      playCounts: { ...lt.playCounts },
      _ts:        Date.now(),
    };
    for (const [k, v] of Object.entries(state.stats.playCounts || {})) {
      const delta = v - (base.playCounts?.[k] || 0);
      if (delta > 0) merged.playCounts[k] = (merged.playCounts[k] || 0) + delta;
    }
    localStorage.setItem(LIFETIME_KEY, JSON.stringify(merged));
  } catch (_) {}
}

// ── accent color ──────────────────────────────────────────────────────────────

function extractAccentColor(imgUrl, cb) {
  try {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 12;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, 12, 12);
        const data = ctx.getImageData(0, 0, 12, 12).data;
        let best = null, bestScore = -1;
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i], g = data[i + 1], b = data[i + 2];
          const max = Math.max(r, g, b) / 255;
          const min = Math.min(r, g, b) / 255;
          const sat = max > 0 ? (max - min) / max : 0;
          const midScore = 1 - Math.abs(max - 0.55);
          const score = sat * midScore;
          if (score > bestScore) { bestScore = score; best = [r, g, b]; }
        }
        if (best && bestScore > 0.05) cb(best);
      } catch (_) {}
    };
    img.src = imgUrl;
  } catch (_) {}
}

function applyAccentColor(r, g, b) {
  const hex = '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
  document.documentElement.style.setProperty('--tss-a',  hex);
  document.documentElement.style.setProperty('--tss-ar', String(r));
  document.documentElement.style.setProperty('--tss-ag', String(g));
  document.documentElement.style.setProperty('--tss-ab', String(b));
}

// ── merge toast ───────────────────────────────────────────────────────────────

function showMergeToast(count) {
  let toast = document.getElementById('tss-merge-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'tss-merge-toast';
    toast.style.cssText = `
      position:fixed; bottom:24px; left:50%; transform:translateX(-50%);
      background:rgba(12,12,12,0.96); color:#c0c0c0;
      border-radius:8px; font-size:12px; font-weight:500;
      padding:8px 20px; z-index:999999;
      border:1px solid rgba(255,255,255,0.07);
      -webkit-backdrop-filter:blur(14px); backdrop-filter:blur(14px);
      white-space:nowrap; pointer-events:none;
      transition:opacity 0.3s;
      font-family:-apple-system,'Segoe UI',system-ui,sans-serif;
    `;
    document.body.appendChild(toast);
  }
  toast.style.opacity = '1';
  toast.textContent = count < 0  ? 'start shuffle first'
                    : count > 0  ? `+${count} tracks added to queue`
                    : 'no new tracks found';
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { toast.style.opacity = '0'; }, 2600);
}

// ── sleep timer ───────────────────────────────────────────────────────────────

function updateSleepDisplay() {
  const el = document.getElementById('tss-hub-sleep-display');
  if (!el) return;
  const t = state.sleepTimer;
  if (!t) { el.textContent = ''; return; }
  if (t.type === 'time') {
    const m = Math.floor(t.remaining / 60), s = t.remaining % 60;
    el.textContent = m > 0 ? `${m}m` : `${s}s`;
  } else {
    el.textContent = `${t.remaining}`;
  }
}

// ── playback ──────────────────────────────────────────────────────────────────

function trackPlayed(ti) {
  state.stats.played++;
  state.stats.playCounts[ti] = (state.stats.playCounts[ti] || 0) + 1;
}

async function loadTracks() {
  const sel = '.trackList__item, .soundList__item, li.sc-list-item';
  for (let i = 0; i < 20; i++) {
    if (document.querySelectorAll(sel).length > 0) break;
    await wait(500);
  }
  let last = 0, stable = 0, iters = 0;
  while (stable < 2 && iters < 60) {
    window.scrollTo(0, document.body.scrollHeight);
    await wait(900);
    const n = document.querySelectorAll(sel).length;
    n === last ? stable++ : (stable = 0, last = n);
    iters++;
  }
  window.scrollTo(0, 0);
  return [...document.querySelectorAll(sel)];
}

async function playAt(idx, countPlay = true) {
  if (!state.active) return;

  const el = state.els[idx];
  if (!el || !document.body.contains(el)) {
    state.els[idx] = null;
    // Remove all occurrences of this dead index from queue/playNext so autoRepeat never re-inserts it
    for (let i = state.queue.length - 1; i >= 0; i--) {
      if (state.queue[i] === idx) {
        state.queue.splice(i, 1);
        if (i < state.pos) state.pos = Math.max(0, state.pos - 1);
      }
    }
    state.playNext = state.playNext.filter(ti => ti !== idx);
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

  // detect quick skip before anything changes
  const isQuickSkip = !fromWatcher && state.manualAction && state.lastProgress < 0.15;

  if (!state.els.some(e => e && document.body.contains(e))) {
    state.suspended = true;
    updateHub();
    return;
  }

  state.suspended = false;
  state.busy      = true;

  const justPlayed = state.queue[state.pos];

  // skip counter → auto-deprioritize after 2 quick skips
  if (isQuickSkip && justPlayed !== undefined) {
    state.skipCounts[justPlayed] = (state.skipCounts[justPlayed] || 0) + 1;
    if (state.skipCounts[justPlayed] >= 2) {
      state.priority[justPlayed] = 0.25;
      delete state.skipCounts[justPlayed];
    }
  }

  // sleep timer: track countdown
  if (state.sleepTimer?.type === 'tracks') {
    state.sleepTimer.remaining--;
    updateSleepDisplay();
    if (state.sleepTimer.remaining <= 0) {
      state.sleepTimer = null;
      const sel = document.getElementById('tss-hub-sleep');
      if (sel) sel.value = 'off';
      pause();
      stop();
      updateHub();
      renderList();
      state.busy = false;
      return;
    }
  }

  if (justPlayed !== undefined) {
    state.history.push(justPlayed);
    if (state.history.length > 100) state.history.shift();
  }

  if (justPlayed !== undefined) {
    state.queue.splice(state.pos, 1);

    // Don't re-insert dead tracks (element nulled out by playAt when not in DOM)
    const isAlive = state.els[justPlayed] != null;
    if (state.autoRepeat && isAlive) {
      const remaining = state.queue.length - state.pos;
      if (remaining > 0) {
        const weight     = state.priority[justPlayed] ?? 1.0;
        const rangeStart = weight >= 1.0 ? 0 : Math.floor(remaining * (1 - weight));
        const rangeEnd   = weight <= 1.0 ? remaining : Math.ceil(remaining / weight);
        const span       = Math.max(1, rangeEnd - rangeStart);
        const insertAt   = state.pos + 1 + rangeStart + Math.floor(Math.random() * span);
        state.queue.splice(Math.min(insertAt, state.queue.length), 0, justPlayed);
      } else {
        // Only re-shuffle alive tracks
        const aliveIndices = [...Array(state.meta.length).keys()].filter(ti => state.els[ti] !== null);
        state.queue = fisherYates(aliveIndices);
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
    if (state.history.length > 100) state.history.shift();
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

async function mergeCurrentPage() {
  if (!state.active) { showMergeToast(-1); return; }

  const btn = document.getElementById('tss-merge-btn');
  if (btn) { btn.style.opacity = '0.35'; btn.style.pointerEvents = 'none'; }

  const newEls = await loadTracks();

  if (btn) { btn.style.opacity = ''; btn.style.pointerEvents = ''; }

  if (!state.active) return;
  if (!newEls.length) { showMergeToast(0); return; }

  const existingIds = new Set(state.meta.map(m => trackId(m)).filter(Boolean));
  const added = [];

  newEls.forEach(el => {
    const m  = getMeta(el);
    const id = trackId(m);
    if (id && existingIds.has(id)) return;
    const ti = state.els.length;
    state.els.push(el);
    state.meta.push(m);
    if (id) existingIds.add(id);
    added.push(ti);
  });

  if (added.length > 0) {
    const shuffled = fisherYates(added);
    state.queue.splice(state.pos + 1, 0, ...shuffled);

    // adopt this page as the active playlist context and resume
    state.playlistUrl = location.href.split(/[?#]/)[0];
    state.suspended   = false;
    state.lastTitle   = playerTitle();

    // restart watcher if it died during suspension navigation
    if (!state.worker && !state._workerInterval) startWatcher();

    badges();
    renderList();
    updateHub();
  }

  showMergeToast(added.length);
}

async function start() {
  if (!validPage()) return;

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
  state.skipCounts   = {};
  state.active       = true;
  state.loading      = false;
  state.suspended    = false;
  state.busy         = false;
  state.manualAction = false;
  state.playlistUrl  = location.href.split(/[?#]/)[0];

  // resume session stats if stopped recently, else start fresh
  const prev = state._savedStats;
  if (prev && (Date.now() - (prev._ts || 0)) < 600_000) {
    state.stats = { ...prev };
  } else {
    state.stats = { played: 0, playCounts: {}, elapsed: 0 };
  }
  state._savedStats  = null;
  state._lifetimeBase = { played: state.stats.played, elapsed: state.stats.elapsed, playCounts: { ...state.stats.playCounts } };

  await playAt(state.queue[state.pos]);
  if (!state.active) return;
  badges();
  renderList();
  startWatcher();
  updateHub();
}

function stop() {
  state.active     = false;
  state.busy       = false;
  state.loading    = false;
  state.sleepTimer = null;
  const sleepSel = document.getElementById('tss-hub-sleep');
  if (sleepSel) sleepSel.value = 'off';
  state.worker?.postMessage('stop');
  state.worker?.terminate();
  state.worker = null;
  if (state._workerInterval) {
    clearInterval(state._workerInterval);
    state._workerInterval = null;
  }
  document.querySelectorAll('.tss-badge').forEach(b => b.remove());
  state._savedStats = { ...state.stats, _ts: Date.now() };
  saveLifetimeStats();
  updateHub();
}

// ── watcher ───────────────────────────────────────────────────────────────────

function startWatcher() {
  if (state.worker) { state.worker.terminate(); state.worker = null; }
  if (state._workerInterval) { clearInterval(state._workerInterval); state._workerInterval = null; }

  state.lastTitle = playerTitle();
  let lastTitle  = state.lastTitle;
  let titleTicks = 0;
  let nearEnd    = false;

  const tick = async () => {
    if (!state.active) return;

    // always refresh display — even while busy/transitioning
    refreshPlayBtn();
    updateHub();

    if (state.busy) return;

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
            // wait for DOM progress to reset so stale p≥0.99 doesn't retrigger
            for (let i = 0; i < 10; i++) {
              if (progress() < 0.1) break;
              await wait(100);
            }
            nearEnd = false;
          }
        } else {
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
      }
      return;
    }

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
        // wait for DOM progress to reset so stale p≥0.99 doesn't retrigger
        for (let i = 0; i < 10; i++) {
          if (progress() < 0.1) break;
          await wait(100);
        }
        nearEnd = false;
      }
      return;
    }

    if (state.lastProgress > 0.5 && p < 0.1) nearEnd = false;
    state.lastProgress = p;
    if (title) lastTitle = title;
  };

  state.worker = mkWorker();
  if (state.worker) {
    state.worker.onmessage = tick;
    state.worker.postMessage('start');
  } else {
    state._workerInterval = setInterval(tick, 300);
  }
}

// ── badges ────────────────────────────────────────────────────────────────────

function badges() {
  document.querySelectorAll('.tss-badge').forEach(b => b.remove());

  state.queue.forEach((ti, qi) => {
    const el = state.els[ti];
    if (!el || !document.body.contains(el) || el.querySelector('.tss-badge')) return;

    const cur = qi === state.pos;
    const b   = document.createElement('span');
    b.className = `tss-badge${cur ? ' tss-badge-cur' : ''}`;
    const n = state.stats.played + (qi - state.pos);
    b.textContent = cur ? `▶ ${n}` : `${n}`;

    const t = el.querySelector('.trackItem__trackTitle, .soundTitle__title, .sc-link-primary');
    if (t) t.parentNode.insertBefore(b, t);
  });
}

// ── stats ─────────────────────────────────────────────────────────────────────

function tickPlayTime() {
  if (state.active && !state.suspended && !paused()) {
    state.stats.elapsed = (state.stats.elapsed || 0) + 1;

    // sleep timer: time countdown
    if (state.sleepTimer?.type === 'time') {
      state.sleepTimer.remaining--;
      updateSleepDisplay();
      if (state.sleepTimer.remaining <= 0) {
        state.sleepTimer = null;
        const sel = document.getElementById('tss-hub-sleep');
        if (sel) sel.value = 'off';
        pause();
        stop();
        updateHub();
        renderList();
      }
    }
  }
}
setInterval(tickPlayTime, 1000);

function fmtTime(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function renderStats() {
  const overlay = document.getElementById('tss-stats-overlay');
  if (!overlay) return;

  const tp = overlay.querySelector('#tss-stats-played');
  const tt = overlay.querySelector('#tss-stats-time');
  if (tp) tp.textContent = state.stats.played;
  if (tt) tt.textContent = fmtTime(state.stats.elapsed || 0);

  // all-time row
  const ltEl = overlay.querySelector('#tss-stats-lifetime');
  if (ltEl) {
    const lt = loadLifetimeStats();
    const totalPlayed  = (lt.played  || 0) + (state.stats.played  || 0);
    const totalElapsed = (lt.elapsed || 0) + (state.stats.elapsed || 0);
    ltEl.textContent = `${totalPlayed} tracks · ${fmtTime(totalElapsed)}`;
  }

  const top = Object.entries(state.stats.playCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);

  const list = overlay.querySelector('#tss-stats-toplist');
  if (!list) return;

  list.innerHTML = top.map(([ti, count]) => {
    const meta  = state.meta[+ti] || {};
    const w     = state.priority[+ti] ?? 1.0;
    const label = w <= 0.25 ? 'low' : w >= 2.0 ? 'high' : 'normal';
    const col   = w <= 0.25 ? '#ff5500' : w >= 2.0 ? '#4caf50' : '#505050';
    return `
      <div style="display:flex;align-items:center;gap:6px;padding:5px 0;border-bottom:1px solid #161616;">
        <span style="color:#909090;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;">${esc(meta.title || '—')}</span>
        <span style="color:#ff5500;font-size:11px;flex-shrink:0;">${count}×</span>
        <button data-ti="${ti}" style="background:#1a1a1a;border:1px solid #252525;color:${col};border-radius:4px;padding:2px 8px;font-size:10px;cursor:pointer;flex-shrink:0;white-space:nowrap;font-family:-apple-system,sans-serif;transition:background 0.15s;">${label}</button>
      </div>`;
  }).join('');

  list.querySelectorAll('[data-ti]').forEach(btn => {
    btn.onclick = e => {
      e.stopPropagation();
      const ti  = +btn.getAttribute('data-ti');
      const cur = state.priority[ti] ?? 1.0;
      let next2, label, col;
      if      (cur >= 2.0) { next2 = 1.0;  label = 'normal'; col = '#505050'; }
      else if (cur >= 1.0) { next2 = 0.25; label = 'low';    col = '#ff5500'; }
      else                 { next2 = 2.0;  label = 'high';   col = '#4caf50'; }
      state.priority[ti] = next2;
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
    background:rgba(11,11,11,0.97); border:1px solid rgba(255,255,255,0.07);
    border-radius:14px; padding:0; z-index:999999;
    font-family:-apple-system,'Segoe UI',system-ui,sans-serif;
    min-width:290px; box-shadow:0 24px 64px rgba(0,0,0,0.92),0 0 0 1px rgba(255,85,0,0.04);
    cursor:default; -webkit-user-select:none; user-select:none;
    -webkit-backdrop-filter:blur(20px); backdrop-filter:blur(20px);
  `;

  overlay.innerHTML = `
    <div id="tss-stats-header" style="display:flex;justify-content:space-between;align-items:center;padding:14px 18px 12px;cursor:move;border-bottom:1px solid #1a1a1a;background:linear-gradient(180deg,#161616 0%,transparent 100%);border-radius:14px 14px 0 0;">
      <span style="color:#f0f0f0;font-size:13px;font-weight:600;display:flex;align-items:center;gap:8px;letter-spacing:0.01em;">session stats</span>
      <span id="tss-stats-close" style="color:#3a3a3a;cursor:pointer;display:flex;transition:color 0.15s;" onmouseenter="this.style.color='#848484'" onmouseleave="this.style.color='#3a3a3a'">${SVG.close}</span>
    </div>
    <div style="padding:14px 18px 18px;">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px;">
        <div style="background:#141414;border-radius:8px;padding:12px 14px;border:1px solid #1e1e1e;">
          <div style="color:#464646;font-size:10px;margin-bottom:5px;text-transform:uppercase;letter-spacing:0.07em;">tracks played</div>
          <div id="tss-stats-played" style="color:#f0f0f0;font-size:22px;font-weight:700;">0</div>
        </div>
        <div style="background:#141414;border-radius:8px;padding:12px 14px;border:1px solid #1e1e1e;">
          <div style="color:#464646;font-size:10px;margin-bottom:5px;text-transform:uppercase;letter-spacing:0.07em;">session time</div>
          <div id="tss-stats-time" style="color:#f0f0f0;font-size:22px;font-weight:700;">0s</div>
        </div>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0 4px;border-top:1px solid #181818;">
        <span style="color:#333;font-size:10px;text-transform:uppercase;letter-spacing:0.07em;">all time</span>
        <span id="tss-stats-lifetime" style="color:#444;font-size:11px;"></span>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;margin-top:10px;">
        <span style="color:#3e3e3e;font-size:10px;text-transform:uppercase;letter-spacing:0.07em;">most played</span>
        <span style="color:#3e3e3e;font-size:10px;text-transform:uppercase;letter-spacing:0.07em;">priority</span>
      </div>
      <div id="tss-stats-toplist"></div>
      <button id="tss-stats-reset" style="margin-top:14px;width:100%;background:#141414;border:1px solid #222;color:#464646;border-radius:6px;padding:7px;cursor:pointer;font-size:11px;font-family:-apple-system,'Segoe UI',system-ui,sans-serif;transition:background 0.15s,color 0.15s;" onmouseenter="this.style.background='#1c1c1c';this.style.color='#7e7e7e'" onmouseleave="this.style.background='#141414';this.style.color='#464646'">reset session &amp; all-time stats</button>
    </div>
  `;

  document.body.appendChild(overlay);
  renderStats();

  document.getElementById('tss-stats-close').onclick = () => overlay.remove();
  document.getElementById('tss-stats-reset').onclick = () => {
    state.stats        = { played: 0, playCounts: {}, elapsed: 0 };
    state._savedStats  = null;
    state._lifetimeBase = { played: 0, elapsed: 0, playCounts: {} };
    try { localStorage.removeItem(LIFETIME_KEY); } catch (_) {}
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

// ── hub ───────────────────────────────────────────────────────────────────────

function mkHub() {
  if (document.getElementById('tss-hub')) return;

  if (!document.getElementById('tss-hub-style')) {
    const s = document.createElement('style');
    s.id = 'tss-hub-style';
    s.textContent = `
      #tss-hub-bg { position:absolute; inset:0; z-index:0; overflow:hidden; border-radius:18px; }
      #tss-hub-bgimg {
        position:absolute; inset:-30px;
        background-color:#111; background-size:cover; background-position:center;
        filter:blur(44px) brightness(0.2) saturate(2);
        opacity:0; transition:opacity 0.7s ease;
      }
      #tss-hub-bgmask {
        position:absolute; inset:0;
        background:linear-gradient(160deg, rgba(6,6,6,0.55) 0%, rgba(6,6,6,0.78) 100%);
      }
      #tss-hub-inner { position:relative; z-index:1; }

      .tss-hub-btn {
        border:none; cursor:pointer; flex-shrink:0;
        display:flex; align-items:center; justify-content:center;
        transition:background 0.15s, color 0.15s, transform 0.1s;
        -webkit-user-select:none; user-select:none;
      }
      .tss-hub-btn:active { transform:scale(0.86); }
      .tss-hub-btn-icon {
        background:none; color:rgba(255,255,255,0.28);
        padding:5px; border-radius:6px;
      }
      .tss-hub-btn-icon:hover { color:rgba(255,255,255,0.72); background:rgba(255,255,255,0.08); }
      .tss-hub-btn-sm {
        width:36px; height:36px; border-radius:50%;
        background:rgba(255,255,255,0.08); color:rgba(255,255,255,0.72);
      }
      .tss-hub-btn-sm:hover { background:rgba(255,255,255,0.16); }
      .tss-hub-btn-lg {
        width:46px; height:46px; border-radius:50%;
        background:var(--tss-a,#ff5500); color:#fff;
        box-shadow:0 4px 18px rgba(var(--tss-ar,255),var(--tss-ag,85),var(--tss-ab,0),0.45);
      }
      .tss-hub-btn-lg:hover {
        filter:brightness(1.12);
        box-shadow:0 4px 22px rgba(var(--tss-ar,255),var(--tss-ag,85),var(--tss-ab,0),0.6);
      }

      #tss-hub-start {
        width:100%; border:none; border-radius:10px;
        padding:9px 14px; font-size:12px; font-weight:600;
        font-family:-apple-system,'Segoe UI',system-ui,sans-serif;
        cursor:pointer; letter-spacing:0.02em;
        transition:background 0.2s, color 0.2s;
      }
      #tss-hub-start:not([data-active="true"]):not([data-loading="true"]) {
        background:rgba(var(--tss-ar,255),var(--tss-ag,85),var(--tss-ab,0),0.14);
        color:var(--tss-a,#ff5500);
        border:1px solid rgba(var(--tss-ar,255),var(--tss-ag,85),var(--tss-ab,0),0.28);
      }
      #tss-hub-start:not([data-active="true"]):not([data-loading="true"]):hover {
        background:rgba(var(--tss-ar,255),var(--tss-ag,85),var(--tss-ab,0),0.26);
      }
      #tss-hub-start[data-active="true"] {
        background:rgba(255,255,255,0.05); color:rgba(255,255,255,0.32);
        border:1px solid rgba(255,255,255,0.07);
      }
      #tss-hub-start[data-active="true"]:hover {
        background:rgba(255,255,255,0.1); color:rgba(255,255,255,0.55);
      }
      #tss-hub-start[data-loading="true"] {
        background:transparent; color:rgba(255,255,255,0.18);
        border:1px solid rgba(255,255,255,0.05);
        cursor:not-allowed; animation:tss-pulse 1.2s ease-in-out infinite;
      }
      @keyframes tss-pulse { 0%,100%{opacity:1} 50%{opacity:0.38} }

      #tss-hub-seekbar { transform-origin:center; transition:transform 0.15s; }
      #tss-hub-seekbar:hover { transform:scaleY(2.5); }

      #tss-hub-qico[data-open="true"] { color:var(--tss-a,#ff5500) !important; }

      .tss-badge {
        display:inline-flex; align-items:center; justify-content:center;
        background:#1e1e1e; color:#545454;
        border-radius:4px; font-size:9.5px; padding:1px 6px;
        margin-right:6px; font-weight:700; vertical-align:middle;
        border:1px solid #2a2a2a; letter-spacing:0.03em;
      }
      .tss-badge-cur {
        background:rgba(var(--tss-ar,255),var(--tss-ag,85),var(--tss-ab,0),0.12);
        color:var(--tss-a,#ff5500);
        border-color:rgba(var(--tss-ar,255),var(--tss-ag,85),var(--tss-ab,0),0.28);
      }

      #tss-sidebar-list::-webkit-scrollbar { width:3px; }
      #tss-sidebar-list::-webkit-scrollbar-thumb { background:#282828; border-radius:2px; }
      #tss-sidebar-list::-webkit-scrollbar-track { background:transparent; }

      #tss-ctx {
        position:fixed; background:#181818; border:1px solid #2c2c2c;
        border-radius:8px; z-index:999999; overflow:hidden; min-width:172px;
        font-family:-apple-system,'Segoe UI',system-ui,sans-serif;
        box-shadow:0 8px 28px rgba(0,0,0,0.78);
      }
      .tss-ctx-item { padding:9px 15px; cursor:pointer; color:#c0c0c0; font-size:12px; transition:background 0.1s; }
      .tss-ctx-item:hover { background:#222; }
      .tss-ctx-disabled { color:#3a3a3a !important; cursor:not-allowed; }
      .tss-ctx-disabled:hover { background:transparent !important; }

      #tss-hub-sleep {
        background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.08);
        color:rgba(255,255,255,0.38); font-size:10px; border-radius:4px;
        padding:2px 5px; cursor:pointer; outline:none;
        font-family:-apple-system,'Segoe UI',system-ui,sans-serif;
        transition:border-color 0.15s;
      }
      #tss-hub-sleep:hover { border-color:rgba(255,255,255,0.18); }
      #tss-hub-sleep option { background:#1a1a1a; }
    `;
    document.head.appendChild(s);
  }

  const hub = document.createElement('div');
  hub.id = 'tss-hub';
  hub.style.cssText = `
    position:fixed; bottom:80px; left:20px; width:280px;
    background:#0d0d0d; border:1px solid rgba(255,255,255,0.06);
    border-radius:18px; z-index:99994;
    overflow:hidden; -webkit-user-select:none; user-select:none;
    box-shadow:0 24px 64px rgba(0,0,0,0.9), 0 0 0 1px rgba(255,85,0,0.03);
    font-family:-apple-system,'Segoe UI',system-ui,sans-serif;
  `;

  hub.innerHTML = `
    <div id="tss-hub-bg">
      <div id="tss-hub-bgimg"></div>
      <div id="tss-hub-bgmask"></div>
    </div>

    <div id="tss-hub-inner">

      <div id="tss-hub-hdr" style="cursor:move; padding:11px 11px 9px; display:flex; align-items:center; justify-content:space-between;">
        <span style="color:rgba(255,255,255,0.2); font-size:10px; font-weight:700; letter-spacing:0.1em; text-transform:uppercase; display:flex; align-items:center; gap:5px; pointer-events:none;">${SVG.shuffle} True Shuffle</span>
        <div style="display:flex; gap:1px; align-items:center;">
          <button id="tss-hub-stats" class="tss-hub-btn tss-hub-btn-icon" title="session stats">${SVG.chart}</button>
          <button id="tss-hub-qico"  class="tss-hub-btn tss-hub-btn-icon" data-open="false" title="queue panel">${SVG.list}</button>
          <button id="tss-hub-col"   class="tss-hub-btn tss-hub-btn-icon" title="collapse" style="font-size:15px; line-height:1; padding:3px 6px;">−</button>
        </div>
      </div>

      <div id="tss-hub-body">

        <div id="tss-hub-active-view" style="display:none;">

          <div style="display:flex; gap:13px; align-items:center; padding:4px 14px 10px;">
            <div id="tss-hub-art" style="
              width:58px; height:58px; border-radius:13px; flex-shrink:0;
              background:#1a1a1a; overflow:hidden;
              display:flex; align-items:center; justify-content:center;
              box-shadow:0 8px 24px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.05);
            ">${SVG.note}</div>
            <div style="min-width:0; flex:1;">
              <div id="tss-hub-title"  style="color:#fff; font-size:13px; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; line-height:1.3;">—</div>
              <div id="tss-hub-artist" style="color:rgba(255,255,255,0.38); font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; margin-top:3px; line-height:1.3;">—</div>
              <div style="display:flex; justify-content:space-between; align-items:center; margin-top:8px; gap:6px;">
                <span id="tss-hub-qpos"   style="color:rgba(255,255,255,0.18); font-size:10px; flex-shrink:0;">—</span>
                <span id="tss-hub-nextup" style="color:rgba(255,255,255,0.18); font-size:10px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; text-align:right; min-width:0;">—</span>
              </div>
            </div>
          </div>

          <div id="tss-hub-seekbar" title="seek" style="
            margin:2px 14px 16px; height:3px;
            background:rgba(255,255,255,0.09); border-radius:2px;
            cursor:pointer; position:relative;
          ">
            <div id="tss-hub-prog" style="height:100%; background:var(--tss-a,#ff5500); width:0%; border-radius:2px; transition:width 0.3s linear; pointer-events:none;"></div>
          </div>

          <div style="display:flex; align-items:center; justify-content:center; gap:10px; padding:0 14px 16px;">
            <button id="tss-hub-prev" class="tss-hub-btn tss-hub-btn-sm">${SVG.prev}</button>
            <button id="tss-hub-play" class="tss-hub-btn tss-hub-btn-lg">${SVG.play}</button>
            <button id="tss-hub-next" class="tss-hub-btn tss-hub-btn-sm">${SVG.next}</button>
          </div>

          <div style="height:1px; background:rgba(255,255,255,0.04); margin:0 14px;"></div>

        </div>

        <div style="padding:12px 12px 13px;">
          <button id="tss-hub-start" data-active="false" data-loading="false">True Shuffle</button>
          <div style="display:flex; align-items:center; justify-content:space-between; margin-top:8px; padding:0 2px;">
            <label style="display:flex; align-items:center; gap:7px; font-size:10px; color:rgba(255,255,255,0.22); cursor:pointer;">
              <input id="tss-hub-repeat" type="checkbox" style="accent-color:var(--tss-a,#ff5500);"> repeat
            </label>
            <label style="display:flex; align-items:center; gap:5px; font-size:10px; color:rgba(255,255,255,0.22);">
              ${SVG.moon}
              <select id="tss-hub-sleep">
                <option value="off">sleep: off</option>
                <option value="t15">15 min</option>
                <option value="t30">30 min</option>
                <option value="t60">1 hour</option>
                <option value="n5">5 tracks</option>
                <option value="n10">10 tracks</option>
                <option value="n25">25 tracks</option>
              </select>
              <span id="tss-hub-sleep-display" style="font-size:10px; color:var(--tss-a,#ff5500); min-width:24px; text-align:right;"></span>
            </label>
          </div>
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

  document.getElementById('tss-hub-sleep').onchange = e => {
    const v = e.target.value;
    if (v === 'off') {
      state.sleepTimer = null;
    } else if (v.startsWith('t')) {
      state.sleepTimer = { type: 'time',   remaining: parseInt(v.slice(1)) * 60 };
    } else {
      state.sleepTimer = { type: 'tracks', remaining: parseInt(v.slice(1)) };
    }
    updateSleepDisplay();
  };

  const colBtn  = document.getElementById('tss-hub-col');
  const hubBody = document.getElementById('tss-hub-body');
  colBtn.onclick = () => {
    const open            = hubBody.style.display !== 'none';
    hubBody.style.display = open ? 'none' : '';
    colBtn.textContent    = open ? '+' : '−';
  };

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

  const av = document.getElementById('tss-hub-active-view');
  if (av) av.style.display = active ? '' : 'none';

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
    qi.title        = state.sidebarOpen ? 'close queue panel' : 'open queue panel';
  }

  if (!active) {
    const prog  = document.getElementById('tss-hub-prog');
    if (prog) prog.style.width = '0%';
    const bgimg = document.getElementById('tss-hub-bgimg');
    if (bgimg) { bgimg.style.backgroundImage = ''; bgimg.style.opacity = '0'; }
    // reset accent
    if (state._lastAccentArtwork) {
      state._lastAccentArtwork = '';
      document.documentElement.style.setProperty('--tss-a',  '#ff5500');
      document.documentElement.style.setProperty('--tss-ar', '255');
      document.documentElement.style.setProperty('--tss-ag', '85');
      document.documentElement.style.setProperty('--tss-ab', '0');
    }
    return;
  }

  const pb = document.getElementById('tss-hub-play');
  if (pb) pb.innerHTML = paused() ? SVG.play : SVG.pause;

  if (state.suspended) {
    const tEl = document.getElementById('tss-hub-title');
    const aEl = document.getElementById('tss-hub-artist');
    if (tEl) tEl.textContent = playerTitle() || '—';
    if (aEl) aEl.textContent = '↩ not in queue';
    const art = document.getElementById('tss-hub-art');
    if (art && art.dataset.src) {
      delete art.dataset.src;
      art.innerHTML = SVG.note;
      const bgimg = document.getElementById('tss-hub-bgimg');
      if (bgimg) { bgimg.style.backgroundImage = ''; bgimg.style.opacity = '0'; }
    }
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
      img.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;';
      img.onerror       = () => { art.innerHTML = SVG.note; delete art.dataset.src; };
      art.appendChild(img);
      const bgimg = document.getElementById('tss-hub-bgimg');
      if (bgimg) { bgimg.style.backgroundImage = `url("${m.artwork}")`; bgimg.style.opacity = '1'; }

      // extract and apply accent color from new artwork
      if (state._lastAccentArtwork !== m.artwork) {
        state._lastAccentArtwork = m.artwork;
        extractAccentColor(m.artwork, ([r, g, b]) => applyAccentColor(r, g, b));
      }
    } else if (!m?.artwork && art.dataset.src) {
      delete art.dataset.src;
      art.innerHTML = SVG.note;
      const bgimg = document.getElementById('tss-hub-bgimg');
      if (bgimg) { bgimg.style.backgroundImage = ''; bgimg.style.opacity = '0'; }
    }
  }

  const prog = document.getElementById('tss-hub-prog');
  if (prog) prog.style.width = `${Math.min(100, progress() * 100).toFixed(1)}%`;

  const nextTi = state.queue[state.pos + 1];
  const nextM  = nextTi !== undefined ? state.meta[nextTi] : null;
  const qpos   = document.getElementById('tss-hub-qpos');
  const nextup = document.getElementById('tss-hub-nextup');
  if (qpos)   qpos.textContent   = `${state.stats.played} / ${state.queue.length}`;
  if (nextup) nextup.textContent = nextM ? nextM.title : '—';
}

// ── sidebar ───────────────────────────────────────────────────────────────────

function mkSidebar() {
  if (document.getElementById('tss-sidebar')) return;

  const sidebar = document.createElement('div');
  sidebar.id = 'tss-sidebar';
  sidebar.style.cssText = `
    position:fixed; right:-320px; top:0;
    width:300px; height:calc(100vh - 50px);
    background:#0c0c0c; border-left:1px solid #1e1e1e;
    z-index:99997; display:flex; flex-direction:column;
    transition:right 0.25s cubic-bezier(0.4,0,0.2,1);
    font-family:-apple-system,'Segoe UI',system-ui,sans-serif;
    box-shadow:-8px 0 32px rgba(0,0,0,0.55);
  `;

  sidebar.innerHTML = `
    <div style="padding:12px 14px 10px;border-bottom:1px solid #191919;flex-shrink:0;background:linear-gradient(180deg,#151515 0%,transparent 100%);">
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px;">
        <button id="tss-tab-queue"   style="background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);color:#f0f0f0;border-radius:5px;padding:3px 10px;font-size:11px;font-weight:600;cursor:pointer;font-family:-apple-system,'Segoe UI',system-ui,sans-serif;transition:all 0.15s;">queue</button>
        <button id="tss-tab-history" style="background:transparent;border:1px solid transparent;color:#464646;border-radius:5px;padding:3px 10px;font-size:11px;font-weight:600;cursor:pointer;font-family:-apple-system,'Segoe UI',system-ui,sans-serif;transition:all 0.15s;">history</button>
        <span style="flex:1;"></span>
        <span id="tss-merge-btn" style="color:#464646;cursor:pointer;display:flex;padding:4px;border-radius:5px;transition:color 0.15s,background 0.15s;" title="add current page to queue" onmouseenter="this.style.color='#c8c8c8';this.style.background='rgba(255,255,255,0.06)'" onmouseleave="this.style.color='#464646';this.style.background='transparent'">${SVG.plus}</span>
        <span id="tss-stats-btn"  style="color:#464646;cursor:pointer;display:flex;padding:4px;border-radius:5px;transition:color 0.15s,background 0.15s;" title="session stats" onmouseenter="this.style.color='#c8c8c8';this.style.background='rgba(255,255,255,0.06)'" onmouseleave="this.style.color='#464646';this.style.background='transparent'">${SVG.chart}</span>
        <span id="tss-sidebar-count" style="color:#464646;font-size:11px;min-width:28px;text-align:right;"></span>
      </div>
      <input id="tss-search" placeholder="search…"
        style="width:100%;box-sizing:border-box;background:#171717;border:1px solid #242424;border-radius:6px;color:#c0c0c0;font-size:12px;padding:6px 10px;outline:none;font-family:-apple-system,'Segoe UI',system-ui,sans-serif;transition:border-color 0.15s;"
        onfocus="this.style.borderColor='#333'" onblur="this.style.borderColor='#242424'" />
    </div>
    <div id="tss-sidebar-list" style="overflow-y:auto;flex:1;padding:4px 0;scrollbar-width:thin;scrollbar-color:#242424 transparent;"></div>
  `;

  document.body.appendChild(sidebar);

  document.getElementById('tss-stats-btn').onclick  = showStats;
  document.getElementById('tss-merge-btn').onclick  = () => mergeCurrentPage();
  document.getElementById('tss-search').oninput     = e => renderList(e.target.value);
  document.getElementById('tss-search').onclick     = e => e.stopPropagation();

  document.getElementById('tss-tab-queue').onclick = () => {
    state.sidebarTab = 'queue';
    updateTabStyles();
    renderList(document.getElementById('tss-search')?.value || '');
  };
  document.getElementById('tss-tab-history').onclick = () => {
    state.sidebarTab = 'history';
    updateTabStyles();
    renderList(document.getElementById('tss-search')?.value || '');
  };
}

function updateTabStyles() {
  const qBtn = document.getElementById('tss-tab-queue');
  const hBtn = document.getElementById('tss-tab-history');
  if (qBtn) {
    const active = state.sidebarTab === 'queue';
    qBtn.style.background   = active ? 'rgba(255,255,255,0.06)' : 'transparent';
    qBtn.style.color        = active ? '#f0f0f0' : '#464646';
    qBtn.style.borderColor  = active ? 'rgba(255,255,255,0.12)' : 'transparent';
  }
  if (hBtn) {
    const active = state.sidebarTab === 'history';
    hBtn.style.background   = active ? 'rgba(255,255,255,0.06)' : 'transparent';
    hBtn.style.color        = active ? '#f0f0f0' : '#464646';
    hBtn.style.borderColor  = active ? 'rgba(255,255,255,0.12)' : 'transparent';
  }
}

function toggleSidebar() {
  state.sidebarOpen = !state.sidebarOpen;
  const s = document.getElementById('tss-sidebar');
  if (s) s.style.right = state.sidebarOpen ? '0' : '-320px';
  updateHub();
}

// ── list ──────────────────────────────────────────────────────────────────────

function renderList(filter = '') {
  if (state.sidebarTab === 'history') {
    renderHistory(filter);
    return;
  }

  const list  = document.getElementById('tss-sidebar-list');
  const count = document.getElementById('tss-sidebar-count');
  if (!list) return;

  list.innerHTML = '';

  if (!state.active || !state.queue.length) {
    list.innerHTML = `<div style="color:#363636;font-size:12px;padding:28px 18px;text-align:center;line-height:1.7;">start shuffle<br>to see the queue</div>`;
    if (count) count.textContent = '';
    return;
  }

  const q = filter.toLowerCase();
  if (count) count.textContent = `${state.stats.played} / ${state.queue.length}`;

  if (state.suspended && !q) {
    const banner = document.createElement('div');
    banner.style.cssText = 'padding:6px 14px;font-size:10px;color:var(--tss-a,#ff5500);background:rgba(var(--tss-ar,255),var(--tss-ag,85),var(--tss-ab,0),0.06);border-bottom:1px solid #1a1a1a;';
    banner.textContent = '↩ external track playing — queue will resume after';
    list.appendChild(banner);
  }

  if (state.playNext.length && !q) {
    const header = document.createElement('div');
    header.style.cssText = 'padding:7px 14px 3px;font-size:10px;color:#444;text-transform:uppercase;letter-spacing:0.07em;';
    header.textContent = `play next (${state.playNext.length})`;
    list.appendChild(header);

    state.playNext.forEach((ti, i) => {
      const m   = state.meta[ti] || { title: '—', artist: '—', artwork: null };
      const row = mkRow(m, -1, ti, false, false);
      row.style.opacity    = '0.65';
      row.style.borderLeft = '2px solid #2e2e2e';
      row.oncontextmenu = e => { e.preventDefault(); state.playNext.splice(i, 1); renderList(); };
      list.appendChild(row);
    });

    const divider = document.createElement('div');
    divider.style.cssText = 'height:1px;background:#191919;margin:4px 0;';
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
      row.style.opacity = '0.35';
    };
    row.ondragend   = () => { row.style.opacity = past ? '0.3' : '1'; };
    row.ondragover  = e => { e.preventDefault(); row.style.background = 'rgba(var(--tss-ar,255),var(--tss-ag,85),var(--tss-ab,0),0.07)'; };
    row.ondragleave = () => { row.style.background = cur ? 'rgba(var(--tss-ar,255),var(--tss-ag,85),var(--tss-ab,0),0.07)' : 'transparent'; };
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

function renderHistory(filter = '') {
  const list  = document.getElementById('tss-sidebar-list');
  const count = document.getElementById('tss-sidebar-count');
  if (!list) return;

  list.innerHTML = '';
  if (count) count.textContent = state.history.length ? `${state.history.length}` : '';

  if (!state.history.length) {
    list.innerHTML = `<div style="color:#363636;font-size:12px;padding:28px 18px;text-align:center;line-height:1.7;">no history yet</div>`;
    return;
  }

  const q        = filter.toLowerCase();
  const reversed = [...state.history].reverse();
  let shown      = 0;

  reversed.forEach((ti, i) => {
    const m = state.meta[ti] || { title: '—', artist: '—', artwork: null };
    if (q && !m.title.toLowerCase().includes(q) && !m.artist.toLowerCase().includes(q)) return;
    shown++;

    const row = document.createElement('div');
    row.style.cssText = `
      display:flex; align-items:center; gap:10px; padding:7px 14px;
      cursor:pointer; background:transparent; transition:background 0.12s;
      -webkit-user-select:none; user-select:none;
    `;
    row.title = 'add to play next';
    row.onmouseenter = () => { row.style.background = 'rgba(255,255,255,0.025)'; };
    row.onmouseleave = () => { row.style.background = 'transparent'; };
    row.onclick = () => { queueNext(ti); };

    const artEl = document.createElement('div');
    artEl.style.cssText = 'width:38px;height:38px;border-radius:6px;flex-shrink:0;background:#1a1a1a;overflow:hidden;display:flex;align-items:center;justify-content:center;color:#2c2c2c;';
    if (m.artwork) {
      const img = document.createElement('img');
      img.src           = m.artwork;
      img.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;';
      img.onerror       = () => { artEl.innerHTML = SVG.note; };
      artEl.appendChild(img);
    } else {
      artEl.innerHTML = SVG.note;
    }

    const num = document.createElement('div');
    num.style.cssText = 'font-size:10px;color:#3e3e3e;font-weight:600;min-width:20px;text-align:center;flex-shrink:0;';
    num.textContent   = String(state.history.length - i);

    const txt = document.createElement('div');
    txt.style.cssText = 'overflow:hidden;flex:1;';
    txt.innerHTML = `
      <div style="font-size:12px;color:#b8b8b8;font-weight:400;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.4;">${esc(m.title)}</div>
      <div style="font-size:11px;color:#4e4e4e;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px;">${esc(m.artist)}</div>
    `;

    row.append(artEl, num, txt);
    list.appendChild(row);
  });

  if (!shown) {
    list.innerHTML = `<div style="color:#363636;font-size:12px;padding:28px 18px;text-align:center;">no results</div>`;
  }
}

function mkRow(m, qi, ti, cur, past) {
  const row = document.createElement('div');
  row.style.cssText = `
    display:flex; align-items:center; gap:10px; padding:7px 14px;
    cursor:pointer;
    background:${cur ? 'rgba(var(--tss-ar,255),var(--tss-ag,85),var(--tss-ab,0),0.07)' : 'transparent'};
    border-left:2px solid ${cur ? 'var(--tss-a,#ff5500)' : 'transparent'};
    transition:background 0.12s;
    opacity:${past ? '0.3' : '1'};
    -webkit-user-select:none; user-select:none;
  `;
  row.onmouseenter = () => { if (!cur) row.style.background = 'rgba(255,255,255,0.025)'; };
  row.onmouseleave = () => { if (!cur) row.style.background = 'transparent'; };

  const art = document.createElement('div');
  art.style.cssText = 'width:38px;height:38px;border-radius:6px;flex-shrink:0;background:#1a1a1a;overflow:hidden;display:flex;align-items:center;justify-content:center;color:#2c2c2c;';
  if (m.artwork) {
    const img = document.createElement('img');
    img.src           = m.artwork;
    img.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;';
    img.onerror       = () => { art.innerHTML = SVG.note; };
    art.appendChild(img);
  } else {
    art.innerHTML = SVG.note;
  }

  const num = document.createElement('div');
  num.style.cssText = `font-size:10px;color:${cur ? 'var(--tss-a,#ff5500)' : '#3e3e3e'};font-weight:${cur ? '700' : '600'};min-width:20px;text-align:center;flex-shrink:0;display:flex;align-items:center;justify-content:center;`;
  const displayNum  = qi >= 0 ? state.stats.played + (qi - state.pos) : '↑';
  if (cur) num.innerHTML = SVG.play;
  else num.textContent = String(displayNum);

  const txt = document.createElement('div');
  txt.style.cssText = 'overflow:hidden;flex:1;';
  txt.innerHTML = `
    <div style="font-size:12px;color:${cur ? '#f0f0f0' : '#b8b8b8'};font-weight:${cur ? '600' : '400'};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.4;">${esc(m.title)}</div>
    <div style="font-size:11px;color:#4e4e4e;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px;">${esc(m.artist)}</div>
  `;

  row.append(art, num, txt);
  return row;
}

// ── context menu ──────────────────────────────────────────────────────────────

function showCtxMenu(e, qi, ti) {
  e.preventDefault();
  e.stopPropagation();
  document.getElementById('tss-ctx')?.remove();

  const m    = state.meta[ti] || {};
  const menu = document.createElement('div');
  menu.id = 'tss-ctx';
  menu.style.cssText = `
    left:${Math.min(e.clientX, window.innerWidth - 180)}px;
    top:${Math.min(e.clientY, window.innerHeight - 180)}px;
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
    item.className = `tss-ctx-item${disabled ? ' tss-ctx-disabled' : ''}`;
    item.textContent = label;
    if (!disabled) {
      item.onclick = () => { action(); menu.remove(); };
    }
    menu.appendChild(item);
  });

  document.body.appendChild(menu);
  setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
}

// ── inject ────────────────────────────────────────────────────────────────────

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

// ── nav ───────────────────────────────────────────────────────────────────────

const validPage    = () => /soundcloud\.com\/(feed|stream|[^/]+\/(sets\/|likes|tracks|reposts))/.test(location.href);
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

      // different valid playlist: suspend queue so user can merge tracks, don't stop
      state.suspended = true;
      await wait(1500);
      inject();
      updateHub();
      return;
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
