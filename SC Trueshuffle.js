// ==UserScript==
// @name         SoundCloud True Shuffle
// @namespace    https://greasyfork.org/scripts/soundcloud-true-shuffle
// @version      10.1.0
// @description  Fixes SoundCloud's broken shuffle. Loads all tracks, actually random, works in background tabs.
// @author       keta
// @match        https://soundcloud.com/*
// @license      MIT
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
'use strict';

const state = {
  active: false,
  autoRepeat: true,
  queue: [],
  playNext: [],
  pos: 0,
  els: [],
  meta: [],
  worker: null,
  busy: false,
  lastTitle: '',
  lastProgress: 0,
  sidebarOpen: false,
  manualAction: false,
  dragSrc: null,
  history: [],
  priority: {}, // ti -> weight: 1.0 normal, 0.25 low, 2.0 high
  stats: { started: null, played: 0, playCounts: {} },
};

// ── worker ───────────────────────────────────────────────────────────────────

function mkWorker() {
  const src = `
    let t = null;
    self.onmessage = e => {
      if (e.data === 'start') { clearInterval(t); t = setInterval(() => self.postMessage(0), 300); }
      else { clearInterval(t); t = null; }
    };
  `;
  return new Worker(URL.createObjectURL(new Blob([src], { type: 'application/javascript' })));
}

// ── utils ────────────────────────────────────────────────────────────────────

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
    if (el) return el.textContent.trim();
  }
  return '';
}

function progress() {
  const passed = document.querySelector('.playbackTimeline__timePassed');
  const total = document.querySelector('.playbackTimeline__duration');
  if (passed && total) {
    const toSec = el => { const m = el.textContent.match(/(\d+):(\d{2})$/); return m ? +m[1]*60 + +m[2] : 0; };
    const d = toSec(total);
    if (d) return toSec(passed) / d;
  }
  return 0;
}

function paused() {
  const btn = document.querySelector('.playControls__play');
  if (!btn) return false;
  const label = (btn.getAttribute('aria-label') || '').toLowerCase();
  return label.startsWith('play') || (btn.title || '').toLowerCase().startsWith('play');
}

function pause() { const b = document.querySelector('.playControls__play'); if (b && !paused()) b.click(); }
function toggle() { document.querySelector('.playControls__play')?.click(); setTimeout(refreshPlayBtn, 150); }

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
  const a = el.querySelector('.trackItem__trackTitle, a.sc-link-primary');
  if (!a) return null;
  const href = a.getAttribute('href');
  if (!href) return null;
  return href.startsWith('http') ? href : 'https://soundcloud.com' + href;
}

function getMeta(el) {
  return {
    title: el.querySelector('.trackItem__trackTitle, .soundTitle__title, .sc-link-primary')?.textContent.trim() || '—',
    artist: el.querySelector('.trackItem__username, .soundTitle__username, .sc-link-secondary')?.textContent.trim() || '—',
    artwork: artwork(el),
    link: getLink(el),
  };
}

// ── stats ────────────────────────────────────────────────────────────────────

function trackPlayed(ti) {
  state.stats.played++;
  state.stats.playCounts[ti] = (state.stats.playCounts[ti] || 0) + 1;
}

// accumulated play time in seconds — only counts when music is actually playing
function tickPlayTime() {
  if (state.active && !paused()) {
    state.stats.elapsed = (state.stats.elapsed || 0) + 1;
  }
}

setInterval(tickPlayTime, 1000);

function renderStats() {
  const overlay = document.getElementById('tss-stats-overlay');
  if (!overlay) return;

  const elapsed = state.stats.elapsed || 0;
  const h = Math.floor(elapsed / 3600), m = Math.floor((elapsed % 3600) / 60), s = elapsed % 60;
  const duration = h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
  const top = Object.entries(state.stats.playCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);

  const tp = overlay.querySelector('#tss-stats-played');
  const tt = overlay.querySelector('#tss-stats-time');
  if (tp) tp.textContent = state.stats.played;
  if (tt) tt.textContent = duration;

  const list = overlay.querySelector('#tss-stats-toplist');
  if (!list) return;
  list.innerHTML = top.map(([ti, count]) => {
    const m2 = state.meta[+ti] || {};
    const w = state.priority[+ti] ?? 1.0;
    const label = w <= 0.25 ? '🔻 low' : w >= 2.0 ? '🔺 high' : '▪ normal';
    const col = w <= 0.25 ? '#f50' : w >= 2.0 ? '#4caf50' : '#555';
    return `<div style="display:flex;align-items:center;gap:6px;padding:5px 0;border-bottom:1px solid #1a1a1a;">
      <span style="color:#bbb;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;">${m2.title||'—'}</span>
      <span style="color:#f50;font-size:11px;flex-shrink:0;">${count}×</span>
      <button data-ti="${ti}" style="background:#1a1a1a;border:1px solid #333;color:${col};border-radius:4px;padding:2px 7px;font-size:10px;cursor:pointer;flex-shrink:0;white-space:nowrap;">${label}</button>
    </div>`;
  }).join('');

  list.querySelectorAll('[data-ti]').forEach(btn => {
    btn.onclick = e => {
      e.stopPropagation();
      const ti = +btn.getAttribute('data-ti');
      const cur = state.priority[ti] ?? 1.0;
      let next, label, col;
      if (cur >= 2.0)      { next = 1.0;  label = '▪ normal'; col = '#555'; }
      else if (cur >= 1.0) { next = 0.25; label = '🔻 low';   col = '#f50'; }
      else                 { next = 2.0;  label = '🔺 high';  col = '#4caf50'; }
      state.priority[ti] = next;
      btn.textContent = label;
      btn.style.color = col;
    };
  });
}

// real-time stats update interval
setInterval(renderStats, 1000);

function showStats() {
  // toggle if already open
  const existing = document.getElementById('tss-stats-overlay');
  if (existing) { existing.remove(); return; }

  const overlay = document.createElement('div');
  overlay.id = 'tss-stats-overlay';
  overlay.style.cssText = `
    position:fixed; top:50%; left:50%; transform:translate(-50%,-50%);
    background:#111; border:1px solid #2a2a2a; border-radius:10px;
    padding:0; z-index:999999; font-family:-apple-system,sans-serif;
    min-width:280px; box-shadow:0 8px 40px rgba(0,0,0,0.8);
    cursor:default; user-select:none;
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
    // restore stats if restarting within 10 minutes
  const prev = state._savedStats;
  if (prev && (Date.now() - (prev._ts || 0)) < 600000) {
    state.stats = { ...prev };
  } else {
    state.stats = { played: 0, playCounts: {}, elapsed: 0 };
  }
  state._savedStats = null;
    renderStats();
  };

  // drag via header
  const header = document.getElementById('tss-stats-header');
  header.onmousedown = e => {
    if (e.target.id === 'tss-stats-close') return;
    e.preventDefault();
    const rect = overlay.getBoundingClientRect();
    overlay.style.transform = 'none';
    overlay.style.left = rect.left + 'px';
    overlay.style.top = rect.top + 'px';
    const startX = e.clientX, startY = e.clientY;
    const origL = rect.left, origT = rect.top;
    const move = ev => {
      overlay.style.left = Math.max(0, Math.min(window.innerWidth - overlay.offsetWidth, origL + (ev.clientX - startX))) + 'px';
      overlay.style.top = Math.max(0, Math.min(window.innerHeight - overlay.offsetHeight, origT + (ev.clientY - startY))) + 'px';
    };
    const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  };
}


// ── mini player ───────────────────────────────────────────────────────────────

function seekTo(ratio) {
  ratio = Math.max(0, Math.min(1, ratio));
  const bar = document.querySelector('.playControls .playbackTimeline__progressWrapper');
  if (!bar) return;
  const rect = bar.getBoundingClientRect();
  const x = rect.left + rect.width * ratio;
  const y = rect.top + rect.height / 2;
  const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y };
  bar.dispatchEvent(new MouseEvent('mousedown', opts));
  bar.dispatchEvent(new MouseEvent('mousemove', opts));
  bar.dispatchEvent(new MouseEvent('mouseup', opts));
}

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
        <div id="tss-mini-title" style="color:#fff;font-size:11px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.3;">—</div>
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
      <button id="tss-mini-prev" style="background:none;border:none;color:#888;font-size:14px;cursor:pointer;padding:2px 6px;">⏮</button>
      <button id="tss-mini-play" style="background:#f50;border:none;color:#fff;width:30px;height:30px;border-radius:50%;cursor:pointer;font-size:13px;">⏸</button>
      <button id="tss-mini-next" style="background:none;border:none;color:#888;font-size:14px;cursor:pointer;padding:2px 6px;">⏭</button>
      <button id="tss-mini-stats" style="background:none;border:none;color:#555;font-size:12px;cursor:pointer;padding:2px 4px;" title="stats">📊</button>
    </div>
    <div id="tss-mini-seekbar" style="height:6px;background:#1a1a1a;border-radius:3px;overflow:hidden;cursor:pointer;" title="seek">
      <div id="tss-mini-progress" style="height:100%;background:#f50;width:0%;transition:width 0.3s linear;pointer-events:none;"></div>
    </div>
    <div id="tss-mini-rzl" style="position:absolute;bottom:0;left:0;width:14px;height:14px;cursor:sw-resize;display:flex;align-items:flex-end;justify-content:flex-start;padding:2px;opacity:0.4;font-size:9px;color:#666;">◤</div>
    <div id="tss-mini-rzr" style="position:absolute;bottom:0;right:0;width:14px;height:14px;cursor:se-resize;display:flex;align-items:flex-end;justify-content:flex-end;padding:2px;opacity:0.4;font-size:9px;color:#666;">◥</div>
  `;

  document.body.appendChild(mini);

  const st = () => document.getElementById('tss-status');
  document.getElementById('tss-mini-play').onclick = toggle;
  document.getElementById('tss-mini-next').onclick = () => { state.manualAction = true; next(st()); };
  document.getElementById('tss-mini-prev').onclick = () => prevTrack(st());
  document.getElementById('tss-mini-stats').onclick = showStats;
  document.getElementById('tss-mini-close').onclick = () => {
    mini.style.display = 'none';
    let tab = document.getElementById('tss-mini-tab');
    if (!tab) {
      tab = document.createElement('div');
      tab.id = 'tss-mini-tab';
      tab.style.cssText = `position:fixed;bottom:60px;right:20px;background:#111;border:1px solid #222;border-radius:8px;padding:6px 10px;z-index:99996;font-family:-apple-system,sans-serif;display:flex;align-items:center;gap:8px;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,0.6);`;
      tab.innerHTML = '<span style="font-size:13px;">🔀</span><span style="color:#ccc;font-size:11px;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" id="tss-mini-tab-title">—</span>';
      tab.onclick = () => { mini.style.display = 'flex'; tab.style.display = 'none'; updateMiniPlayer(); };
      document.body.appendChild(tab);
    }
    const m = state.meta[state.queue?.[state.pos]];
    const t = document.getElementById('tss-mini-tab-title');
    if (t && m) t.textContent = m.title;
    tab.style.display = 'flex';
  };

  // drag — only triggered on the player body, not buttons/handles
  mini.onmousedown = e => {
    const ignore = ['BUTTON', 'SPAN', 'INPUT'];
    if (ignore.includes(e.target.tagName)) return;
    if (e.target.id === 'tss-mini-rzl' || e.target.id === 'tss-mini-rzr') return;

    e.preventDefault();
    const startX = e.clientX, startY = e.clientY;
    const rect = mini.getBoundingClientRect();
    // work in top/left space
    let curLeft = rect.left, curTop = rect.top;
    mini.style.left = curLeft + 'px';
    mini.style.top = curTop + 'px';
    mini.style.right = 'auto';
    mini.style.bottom = 'auto';

    const move = ev => {
      curLeft = rect.left + (ev.clientX - startX);
      curTop = rect.top + (ev.clientY - startY);
      curLeft = Math.max(0, Math.min(window.innerWidth - mini.offsetWidth, curLeft));
      curTop = Math.max(0, Math.min(window.innerHeight - mini.offsetHeight, curTop));
      mini.style.left = curLeft + 'px';
      mini.style.top = curTop + 'px';
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  };

  // resize — only changes width, never touches position
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
        const newW = Math.max(220, Math.min(400, startW + delta));
        mini.style.width = newW + 'px';
        const extra = document.getElementById('tss-mini-extra');
        if (extra) extra.style.display = newW > 280 ? 'flex' : 'none';
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    };
  };

  addResize('tss-mini-rzl', true);
  addResize('tss-mini-rzr', false);

}

function updateMiniPlayer() {
  const mini = document.getElementById('tss-mini');
  if (!mini || mini.style.display === 'none') {
    // update tab title
    const tab = document.getElementById('tss-mini-tab');
    const m = state.meta[state.queue?.[state.pos]];
    const t = document.getElementById('tss-mini-tab-title');
    if (tab && tab.style.display !== 'none' && m && t) t.textContent = m.title;
    return;
  }

  // use playerTitle() as source of truth to stay in sync with what's actually playing
  const currentTitle = playerTitle();
  const m = state.meta[state.queue?.[state.pos]];

  const el = id => document.getElementById(id);
  if (el('tss-mini-title')) el('tss-mini-title').textContent = currentTitle || m?.title || '—';
  if (el('tss-mini-artist')) el('tss-mini-artist').textContent = m?.artist || '—';
  if (el('tss-mini-play')) el('tss-mini-play').textContent = paused() ? '▶' : '⏸';

  const art = el('tss-mini-art');
  if (art && m?.artwork) {
    if (art.dataset.src !== m.artwork) {
      art.dataset.src = m.artwork;
      art.innerHTML = '';
      const img = document.createElement('img');
      img.src = m.artwork;
      img.style.cssText = 'width:100%;height:100%;object-fit:cover;';
      img.onerror = () => { art.innerHTML = '♪'; };
      art.appendChild(img);
    }
  }

  const nextTi = state.queue[state.pos + 1];
  const nextM = nextTi !== undefined ? state.meta[nextTi] : null;
  if (el('tss-mini-nextup')) el('tss-mini-nextup').textContent = nextM ? `${nextM.artist} — ${nextM.title}` : 'end of queue';
  if (el('tss-mini-queuepos')) el('tss-mini-queuepos').textContent = `${state.pos + 1} / ${state.queue.length}`;
}

function shiftMiniPlayer(sidebarOpen) {
  const mini = document.getElementById('tss-mini');
  const tab = document.getElementById('tss-mini-tab');
  [mini, tab].forEach(el => {
    if (!el || el.style.display === 'none') return;
    const rect = el.getBoundingClientRect();
    if (sidebarOpen && rect.right > window.innerWidth - 308) {
      // shift left, but stay in left/top space so drag stays consistent
      el.style.left = (window.innerWidth - 320 - el.offsetWidth) + 'px';
      el.style.top = rect.top + 'px';
      el.style.right = 'auto';
      el.style.bottom = 'auto';
    }
  });
}

// ── playback ─────────────────────────────────────────────────────────────────

async function loadTracks(status) {
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

async function playAt(idx) {
  const el = state.els[idx];
  if (!el || !document.body.contains(el)) {
    // track removed from playlist — skip to next
    state.els[idx] = null;
    state.busy = false;
    const status = document.getElementById('tss-status');
    await next(status, false);
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
  for (let i = 0; i < 15; i++) {
    await wait(150);
    const t = playerTitle();
    if (t && t !== prev) break;
  }

  state.lastTitle = playerTitle();
  state.lastProgress = 0;
  trackPlayed(idx);
  setTimeout(() => { refreshPlayBtn(); updateProgressBar(); updateMiniPlayer(); }, 300);
}

async function next(status, fromWatcher = false) {
  if (state.busy) return;
  if (fromWatcher && state.manualAction) { state.manualAction = false; return; }
  state.busy = true;

  // push current to history for prev() support
  if (state.queue[state.pos] !== undefined) {
    state.history.push(state.queue[state.pos]);
    if (state.history.length > 50) state.history.shift(); // cap history
  }

  // reshuffle the just-played track into a position based on priority weight
  const justPlayed = state.queue[state.pos];
  if (justPlayed !== undefined) {
    state.queue.splice(state.pos, 1);
    const remaining = state.queue.length - state.pos;
    if (remaining > 0) {
      const weight = state.priority[justPlayed] ?? 1.0;
      // low weight = insert further back (higher min offset)
      // weight 0.25 = starts at 75% of remaining, weight 1.0 = starts at 0%
      const minOffset = Math.floor(remaining * (1 - weight));
      const insertAt = state.pos + 1 + minOffset + Math.floor(Math.random() * (remaining - minOffset));
      state.queue.splice(Math.min(insertAt, state.queue.length), 0, justPlayed);
    } else {
      state.queue.push(justPlayed);
    }
  }

  if (state.playNext.length > 0) {
    const ti = state.playNext.shift();
    state.pos++;
    state.queue.splice(state.pos, 0, ti);
  }

  if (state.pos >= state.queue.length) {
    if (!state.autoRepeat) {
      stop();
      if (status) status.textContent = '';
      const btn = document.getElementById('tss-btn');
      if (btn) btn.textContent = '🔀 True Shuffle';
      state.busy = false;
      return;
    }
    state.queue = fisherYates(state.queue);
    state.pos = 0;
  }

  await playAt(state.queue[state.pos]);
  badges();
  renderList();
  if (status) status.textContent = `▶ ${state.pos + 1} / ${state.queue.length}`;
  state.busy = false;
}

async function prevTrack(status) {
  if (state.busy) return;
  if (!state.history.length) return;
  state.busy = true;
  state.manualAction = true;
  state._goingBack = true; // flag so next() skips history push

  const prevTi = state.history.pop();
  state.queue.splice(state.pos, 0, prevTi);

  await playAt(state.queue[state.pos]);
  badges();
  renderList();
  if (status) status.textContent = `▶ ${state.pos + 1} / ${state.queue.length}`;
  state.busy = false;
}

async function jumpTo(qi, ti, status) {
  if (state.busy) return;
  state.busy = true;
  state.manualAction = true;
  state.pos = qi;
  await playAt(ti);
  badges();
  renderList();
  if (status) status.textContent = `▶ ${qi + 1} / ${state.queue.length}`;
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

// ── watcher ───────────────────────────────────────────────────────────────────

function startWatcher(status) {
  if (state.worker) { state.worker.terminate(); state.worker = null; }
  state.lastTitle = playerTitle();
  let lastTitle = state.lastTitle, titleTicks = 0, nearEnd = false;

  state.worker = mkWorker();
  state.worker.onmessage = async () => {
    if (!state.active || state.busy) return;

    const title = playerTitle();
    const p = progress();

    // SC switched track on its own
    if (title && lastTitle && title !== lastTitle) {
      if (++titleTicks >= 2) {
        titleTicks = 0; nearEnd = false; lastTitle = title;
        await next(status, true);
        lastTitle = playerTitle();
      }
      return;
    }
    titleTicks = 0;

    // track near end — pause before SC auto-advances
    if (p >= 0.99 && !nearEnd && !paused()) {
      nearEnd = true;
      pause();
      await wait(150);
      await next(status, true);
      lastTitle = playerTitle();
      nearEnd = false;
      return;
    }

    if (state.lastProgress > 0.5 && p < 0.1) nearEnd = false;
    state.lastProgress = p;
    if (title) lastTitle = title;

    refreshPlayBtn();
    updateProgressBar();
    updateMiniPlayer();
  };

  state.worker.postMessage('start');
}

// ── start / stop ─────────────────────────────────────────────────────────────

async function start(btn, status) {
  if (state.active) {
    stop();
    btn.textContent = '🔀 True Shuffle';
    if (status) status.textContent = '';
    renderList();
    const mini = document.getElementById('tss-mini');
    if (mini) mini.style.display = 'none';
    return;
  }

  btn.disabled = true; btn.textContent = '⏳ loading…';
  const els = await loadTracks(status);
  if (!els.length) {
    if (status) status.textContent = '❌ no tracks found';
    btn.textContent = '🔀 True Shuffle'; btn.disabled = false;
    return;
  }

  state.els = els;
  state.meta = els.map(getMeta);
  state.queue = fisherYates([...Array(els.length).keys()]);
  state.playNext = []; state.pos = 0; state.history = []; state.priority = {};
  state.active = true; state.busy = false; state.manualAction = false;
  // restore stats if restarting within 10 minutes
  const prev = state._savedStats;
  if (prev && (Date.now() - (prev._ts || 0)) < 600000) {
    state.stats = { ...prev };
  } else {
    state.stats = { played: 0, playCounts: {}, elapsed: 0 };
  }
  state._savedStats = null;

  btn.textContent = '⏹ Stop'; btn.disabled = false;
  await playAt(state.queue[0]);
  badges(); renderList();
  if (status) status.textContent = `▶ 1 / ${state.queue.length}`;
  startWatcher(status);

  const mini = document.getElementById('tss-mini');
  if (mini) mini.style.display = 'flex';
  else mkMiniPlayer();
  updateMiniPlayer();
}

function stop() {
  state.active = false; state.busy = false;
  state.worker?.postMessage('stop');
  state.worker?.terminate();
  state.worker = null;
  document.querySelectorAll('.tss-badge').forEach(b => b.remove());
  // save stats snapshot so they persist if user restarts
  state._savedStats = { ...state.stats, _ts: Date.now() };
}

// ── badges ───────────────────────────────────────────────────────────────────

function badges() {
  document.querySelectorAll('.tss-badge').forEach(b => b.remove());
  state.queue.forEach((ti, qi) => {
    const el = state.els[ti];
    if (!el || el.querySelector('.tss-badge')) return;
    const cur = qi === state.pos;
    const b = document.createElement('span');
    b.className = 'tss-badge';
    b.style.cssText = `display:inline-block;background:${cur?'#f50':'#2a2a2a'};color:${cur?'#fff':'#888'};border-radius:3px;font-size:10px;padding:1px 5px;margin-right:5px;font-weight:bold;vertical-align:middle;border:1px solid ${cur?'#f50':'#444'};`;
    b.textContent = cur ? `▶ ${qi+1}` : `${qi+1}`;
    const t = el.querySelector('.trackItem__trackTitle, .soundTitle__title, .sc-link-primary');
    if (t) t.parentNode.insertBefore(b, t);
  });
}

// ── sidebar ───────────────────────────────────────────────────────────────────

function refreshPlayBtn() {
  const isPaused = paused();
  const s = document.getElementById('tss-ctrl-play');
  const m = document.getElementById('tss-mini-play');
  if (s) s.textContent = isPaused ? '▶' : '⏸';
  if (m) m.textContent = isPaused ? '▶' : '⏸';
}

function updateProgressBar() {
  const p = `${Math.min(100, progress() * 100)}%`;
  const s = document.getElementById('tss-progress-inner');
  const m = document.getElementById('tss-mini-progress');
  if (s) s.style.width = p;
  if (m) m.style.width = p;
}

function mkSidebar() {
  if (document.getElementById('tss-sidebar')) return;

  const tab = document.createElement('div');
  tab.id = 'tss-sidebar-tab';
  tab.textContent = '🔀';
  tab.style.cssText = `position:fixed;right:0;top:50%;transform:translateY(-50%);background:#f50;color:#fff;width:28px;height:60px;display:flex;align-items:center;justify-content:center;border-radius:6px 0 0 6px;cursor:pointer;z-index:99998;font-size:16px;box-shadow:-2px 0 8px rgba(0,0,0,0.4);transition:right 0.25s;`;
  tab.onmouseenter = () => tab.style.background = '#e64a00';
  tab.onmouseleave = () => tab.style.background = '#f50';
  tab.onclick = toggleSidebar;

  const sidebar = document.createElement('div');
  sidebar.id = 'tss-sidebar';
  sidebar.style.cssText = `position:fixed;right:-320px;top:0;width:300px;height:calc(100vh - 50px);background:#0d0d0d;border-left:1px solid #1a1a1a;z-index:99997;display:flex;flex-direction:column;transition:right 0.25s;font-family:-apple-system,sans-serif;box-shadow:-4px 0 20px rgba(0,0,0,0.7);`;

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
      <div id="tss-sidebar-seekbar" style="height:6px;background:#1a1a1a;border-radius:3px;overflow:hidden;cursor:pointer;margin-bottom:8px;" title="seek">
        <div id="tss-progress-inner" style="height:100%;background:#f50;width:0%;transition:width 0.3s linear;pointer-events:none;"></div>
      </div>
      <input id="tss-search" placeholder="search queue…" style="width:100%;box-sizing:border-box;background:#1a1a1a;border:1px solid #2a2a2a;border-radius:4px;color:#ccc;font-size:12px;padding:5px 8px;outline:none;" />
    </div>
    <div id="tss-sidebar-list" style="overflow-y:auto;flex:1;padding:4px 0;scrollbar-width:thin;scrollbar-color:#222 transparent;"></div>
  `;

  document.body.appendChild(tab);
  document.body.appendChild(sidebar);

  const st = () => document.getElementById('tss-status');
  document.getElementById('tss-ctrl-play').onclick = toggle;
  document.getElementById('tss-ctrl-next').onclick = () => { state.manualAction = true; next(st()); };
  document.getElementById('tss-ctrl-prev').onclick = () => prevTrack(st());
  document.getElementById('tss-search').oninput = e => renderList(e.target.value);
  document.getElementById('tss-search').onclick = e => e.stopPropagation();
  document.getElementById('tss-stats-btn').onclick = showStats;
}

function toggleSidebar() {
  state.sidebarOpen = !state.sidebarOpen;
  const s = document.getElementById('tss-sidebar');
  const t = document.getElementById('tss-sidebar-tab');
  if (s) s.style.right = state.sidebarOpen ? '0' : '-320px';
  if (t) t.style.right = state.sidebarOpen ? '300px' : '0';
  if (state.sidebarOpen) shiftMiniPlayer(true);
}

// ── context menu ──────────────────────────────────────────────────────────────

function showCtxMenu(e, qi, ti) {
  e.preventDefault();
  e.stopPropagation();
  document.getElementById('tss-ctx')?.remove();

  const m = state.meta[ti] || {};
  const menu = document.createElement('div');
  menu.id = 'tss-ctx';
  menu.style.cssText = `position:fixed;left:${e.clientX}px;top:${Math.min(e.clientY, window.innerHeight - 180)}px;background:#1a1a1a;border:1px solid #333;border-radius:5px;z-index:999999;font-size:12px;font-family:-apple-system,sans-serif;overflow:hidden;min-width:170px;`;

  const items = [
    { label: '⏭ play next', action: () => queueNext(ti) },
    { label: '↑ move up', action: () => { if (qi > 0) { [state.queue[qi], state.queue[qi-1]] = [state.queue[qi-1], state.queue[qi]]; if (state.pos===qi) state.pos--; else if (state.pos===qi-1) state.pos++; badges(); renderList(); } }, disabled: qi <= 0 },
    { label: '↓ move down', action: () => { if (qi < state.queue.length-1) { [state.queue[qi], state.queue[qi+1]] = [state.queue[qi+1], state.queue[qi]]; if (state.pos===qi) state.pos++; else if (state.pos===qi+1) state.pos--; badges(); renderList(); } }, disabled: qi >= state.queue.length-1 },
    { label: '🔗 copy link', action: () => { if (m.link) navigator.clipboard.writeText(m.link).catch(() => {}); } },
    { label: '✕ remove', action: () => removeFromQueue(qi), disabled: qi === state.pos },
  ];

  items.forEach(({ label, action, disabled }) => {
    const item = document.createElement('div');
    item.textContent = label;
    item.style.cssText = `padding:8px 14px;cursor:${disabled?'not-allowed':'pointer'};color:${disabled?'#444':'#ccc'};transition:background 0.1s;`;
    if (!disabled) {
      item.onmouseenter = () => item.style.background = '#2a2a2a';
      item.onmouseleave = () => item.style.background = 'transparent';
      item.onclick = () => { action(); menu.remove(); };
    }
    menu.appendChild(item);
  });

  document.body.appendChild(menu);
  setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
}

// ── render list ───────────────────────────────────────────────────────────────

function renderList(filter = '') {
  const list = document.getElementById('tss-sidebar-list');
  const count = document.getElementById('tss-sidebar-count');
  if (!list) return;

  list.innerHTML = '';

  if (!state.active || !state.queue.length) {
    list.innerHTML = `<div style="color:#444;font-size:12px;padding:24px 16px;text-align:center;">start shuffle to see queue</div>`;
    if (count) count.textContent = '';
    return;
  }

  const q = filter.toLowerCase();
  if (count) count.textContent = `${state.pos + 1} / ${state.queue.length}`;

  if (state.playNext.length && !q) {
    const pn = document.createElement('div');
    pn.style.cssText = 'padding:4px 12px 2px;font-size:10px;color:#555;text-transform:uppercase;letter-spacing:0.05em;';
    pn.textContent = `play next (${state.playNext.length})`;
    list.appendChild(pn);
    state.playNext.forEach((ti, i) => {
      const m = state.meta[ti] || { title: '—', artist: '—', artwork: null };
      const row = mkRow(m, -1, ti, false, false);
      row.style.opacity = '0.7';
      row.style.borderLeft = '3px solid #333';
      row.oncontextmenu = e => { e.preventDefault(); state.playNext.splice(i, 1); renderList(); };
      list.appendChild(row);
    });
    const div = document.createElement('div');
    div.style.cssText = 'height:1px;background:#1a1a1a;margin:4px 0;';
    list.appendChild(div);
  }

  state.queue.forEach((ti, qi) => {
    const m = state.meta[ti] || { title: '—', artist: '—', artwork: null };
    if (q && !m.title.toLowerCase().includes(q) && !m.artist.toLowerCase().includes(q)) return;

    const cur = qi === state.pos, past = qi < state.pos;
    const row = mkRow(m, qi, ti, cur, past);

    row.draggable = true;
    row.ondragstart = e => { state.dragSrc = qi; e.dataTransfer.effectAllowed = 'move'; row.style.opacity = '0.4'; };
    row.ondragend = () => row.style.opacity = past ? '0.3' : '1';
    row.ondragover = e => { e.preventDefault(); row.style.background = 'rgba(255,85,0,0.08)'; };
    row.ondragleave = () => row.style.background = cur ? 'rgba(255,85,0,0.1)' : 'transparent';
    row.ondrop = e => {
      e.preventDefault();
      if (state.dragSrc === null || state.dragSrc === qi) return;
      const src = state.dragSrc;
      const [moved] = state.queue.splice(src, 1);
      state.queue.splice(qi, 0, moved);
      if (state.pos === src) state.pos = qi;
      else if (src < state.pos && qi >= state.pos) state.pos--;
      else if (src > state.pos && qi <= state.pos) state.pos++;
      state.dragSrc = null;
      badges(); renderList(filter);
    };

    row.onclick = () => jumpTo(qi, ti, document.getElementById('tss-status'));
    row.oncontextmenu = e => showCtxMenu(e, qi, ti);
    list.appendChild(row);
  });

  if (!q) {
    // offset: playNext label(1) + playNext items + separator(1)
    const offset = state.playNext.length ? state.playNext.length + 2 : 0;
    list.children[state.pos + offset]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  refreshPlayBtn();
}

function mkRow(m, qi, ti, cur, past) {
  const row = document.createElement('div');
  row.style.cssText = `display:flex;align-items:center;gap:10px;padding:7px 12px;cursor:pointer;background:${cur?'rgba(255,85,0,0.1)':'transparent'};border-left:3px solid ${cur?'#f50':'transparent'};transition:background 0.15s;opacity:${past?'0.3':'1'};user-select:none;`;
  row.onmouseenter = () => { if (!cur) row.style.background = 'rgba(255,255,255,0.03)'; };
  row.onmouseleave = () => { if (!cur) row.style.background = 'transparent'; };

  const art = document.createElement('div');
  art.style.cssText = `width:38px;height:38px;border-radius:4px;flex-shrink:0;background:#1a1a1a;overflow:hidden;display:flex;align-items:center;justify-content:center;`;
  if (m.artwork) {
    const img = document.createElement('img');
    img.src = m.artwork;
    img.style.cssText = 'width:100%;height:100%;object-fit:cover;';
    img.onerror = () => { art.innerHTML = '<span style="font-size:16px;color:#333;">♪</span>'; };
    art.appendChild(img);
  } else {
    art.innerHTML = '<span style="font-size:16px;color:#333;">♪</span>';
  }

  const num = document.createElement('div');
  num.style.cssText = `font-size:10px;color:${cur?'#f50':'#444'};font-weight:${cur?'700':'400'};min-width:18px;text-align:center;flex-shrink:0;`;
  num.textContent = cur ? '▶' : (qi >= 0 ? qi + 1 : '↑');

  const txt = document.createElement('div');
  txt.style.cssText = 'overflow:hidden;flex:1;';
  txt.innerHTML = `
    <div style="font-size:12px;color:${cur?'#fff':'#bbb'};font-weight:${cur?'600':'400'};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${m.title}</div>
    <div style="font-size:11px;color:#555;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px;">${m.artist}</div>
  `;

  row.append(art, num, txt);
  return row;
}

// ── main UI ───────────────────────────────────────────────────────────────────

function mkUI() {
  const wrap = document.createElement('div');
  wrap.id = 'tss-wrapper';
  wrap.style.cssText = 'display:flex;align-items:center;gap:10px;margin:8px 0;flex-wrap:wrap;';

  const btn = document.createElement('button');
  btn.id = 'tss-btn';
  btn.textContent = '🔀 True Shuffle';
  btn.style.cssText = `background:#f50;color:#fff;border:none;border-radius:4px;padding:6px 14px;font-size:13px;font-weight:bold;cursor:pointer;transition:background 0.2s;`;
  btn.onmouseenter = () => { if (!btn.disabled) btn.style.background = '#e64a00'; };
  btn.onmouseleave = () => { if (!btn.disabled) btn.style.background = '#f50'; };

  const label = document.createElement('label');
  label.style.cssText = 'display:flex;align-items:center;gap:5px;font-size:12px;color:#ccc;cursor:pointer;user-select:none;';
  const cb = document.createElement('input');
  cb.type = 'checkbox'; cb.checked = state.autoRepeat; cb.style.accentColor = '#f50';
  cb.onchange = () => state.autoRepeat = cb.checked;
  label.append(cb, document.createTextNode('repeat'));

  const status = document.createElement('span');
  status.id = 'tss-status';
  status.style.cssText = 'font-size:12px;color:#999;';

  btn.onclick = () => start(btn, status);
  wrap.append(btn, label, status);
  return wrap;
}

// ── inject & nav ──────────────────────────────────────────────────────────────

async function inject() {
  if (document.getElementById('tss-wrapper')) return;
  const sels = ['.sc-list-actions','.listenEngagement__actions','.trackList__tracksActions','.userMain__content .sc-button-toolbar','.soundActions','.playlist__controls','.userBadge__info','.playlist__trackList','.soundList','.trackList'];
  const container = sels.reduce((found, s) => found || document.querySelector(s), null);
  if (!container) return;
  container.prepend(mkUI());
  mkSidebar();
}

let lastUrl = location.href;
const validPage = () => /soundcloud\.com\/[^/]+\/(sets\/|likes|tracks|reposts)/.test(location.href);

async function onNav() {
  if (state.active) stop();
  await wait(1500);
  if (validPage()) inject();
}

new MutationObserver(() => {
  if (location.href !== lastUrl) { lastUrl = location.href; onNav(); }
}).observe(document, { subtree: true, childList: true });

onNav();

})();