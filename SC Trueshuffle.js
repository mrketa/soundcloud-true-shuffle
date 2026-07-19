// ==UserScript==
// @name         SoundCloud True Shuffle
// @namespace    https://greasyfork.org/scripts/soundcloud-true-shuffle
// @version      5.1.0
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
  stopAfterRound: false,
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
  sidebarWidth: 320,
  sidebarHeight: 0,
  manualAction: false,
  dragSrc:      null,
  history:      [],
  priority:     {},
  skipCounts:   {},
  roundStarts:  {},
  roundPlayed:  0,
  roundTotal:   0,
  sleepTimer:   null,
  suspended:    false,
  playlistUrl:  '',
  _savedStats:  null,
  _lifetimeBase: null,
  _lastAccentArtwork: '',
  _lastWaveformKey: '',
  _qnd:         false,
  _endedHandler: null,
  _manualActionAt: 0,
  _internalNavigation: false,
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

// weighted shuffle (Efraimidis-Spirakis): every track appears exactly once,
// but higher-priority tracks tend to land earlier in the round, lower later
function weightedShuffle(indices) {
  return indices
    .map(ti => ({ ti, k: Math.random() ** (1 / (state.priority[ti] ?? 1.0)) }))
    .sort((a, b) => b.k - a.k)
    .map(x => x.ti);
}

function buildReshuffledQueue(indices, currentTi = null) {
  const pool = indices.filter(ti => ti !== currentTi);
  const shuffled = fisherYates(pool);
  return currentTi === null || currentTi === undefined
    ? shuffled
    : [currentTi, ...shuffled];
}

// Keep the first position balanced across rounds. Small playlists make normal
// randomness look biased very quickly, so choose the least-used eligible
// starter first and shuffle the rest normally (including explicit priorities).
function buildBalancedRound(indices, previousTi = null) {
  if (!indices.length) return [];

  const eligible = indices.length > 1
    ? indices.filter(ti => ti !== previousTi)
    : indices.slice();
  const fewestStarts = Math.min(...eligible.map(ti => state.roundStarts[ti] || 0));
  const starterPool = eligible.filter(ti => (state.roundStarts[ti] || 0) === fewestStarts);
  const first = fisherYates(starterPool)[0];
  state.roundStarts[first] = (state.roundStarts[first] || 0) + 1;

  return [first, ...weightedShuffle(indices.filter(ti => ti !== first))];
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

function parseTimeText(text) {
  const match = String(text || '').trim().match(/(?:^|[^\d:])(\d+(?::\d+){1,2})$/);
  if (!match) return 0;
  const parts = match[1].split(':').map(Number);
  if (parts.length < 2 || parts.length > 3 || parts.some(n => !Number.isFinite(n))) return 0;
  return parts.reduce((seconds, part) => seconds * 60 + part, 0);
}

function activeAudio() {
  const audios = [...document.querySelectorAll('audio')];
  return audios.find(a => !a.paused && a.currentSrc)
      || audios.find(a => a.currentSrc)
      || audios[0]
      || null;
}

function playbackTiming() {
  const audio = activeAudio();
  if (audio && Number.isFinite(audio.duration) && audio.duration > 0) {
    return {
      current:  Number.isFinite(audio.currentTime) ? audio.currentTime : 0,
      duration: audio.duration,
      ended:    audio.ended,
      source:   'audio',
    };
  }

  const passed = document.querySelector('.playbackTimeline__timePassed');
  const total  = document.querySelector('.playbackTimeline__duration');
  return {
    current:  passed ? parseTimeText(passed.textContent) : 0,
    duration: total  ? parseTimeText(total.textContent)  : 0,
    ended:    false,
    source:   'dom',
  };
}

function progress() {
  const timing = playbackTiming();
  return timing.duration ? timing.current / timing.duration : 0;
}

function currentSec() {
  return playbackTiming().current;
}

function formatPlaybackClock(seconds) {
  const safe = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
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
  const ratio = Math.max(0, Math.min(1, progress()));
  const p = document.getElementById('tss-hub-prog');
  if (p) p.style.width = `${(ratio * 100).toFixed(1)}%`;
  const bars = document.querySelectorAll('#tss-wave-bars i');
  const played = Math.round(ratio * bars.length);
  bars.forEach((bar, index) => { bar.dataset.played = index < played ? 'true' : 'false'; });
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

function waveformUrl(el) {
  const direct = el.querySelector('[data-waveform-url]')?.getAttribute('data-waveform-url');
  if (direct) return direct;
  const match = el.outerHTML.match(/https?:\/\/wave\.sndcdn\.com\/[^"'\s<>)]+/i);
  return match ? match[0].replace(/&amp;/g, '&') : null;
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
    waveform: waveformUrl(el),
    sourcePage: location.href.split(/[?#]/)[0].replace(/\/+$/, ''),
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
  search:  `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" style="display:block;width:13px;height:13px;flex-shrink:0"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/></svg>`,
};

const DEFAULT_WAVE_HEIGHTS = [34,58,82,48,72,96,62,42,78,54,88,66,38,74,100,56,84,46,68,92,52,76,40,86,64,98,44,72,58,90,50,80,36,70,94,60,84,46,76,54,100,68,42,88,58,74,48,92,64,82,38,70,56,86];
const waveformCache = new Map();
let waveformRequest = 0;

function normalizeTrackUrl(url) {
  try {
    const parsed = new URL(url, location.origin);
    return `${parsed.origin}${parsed.pathname}`.replace(/\/$/, '').toLowerCase();
  } catch (_) {
    return String(url || '').split(/[?#]/)[0].replace(/\/$/, '').toLowerCase();
  }
}

function hydrationWaveformUrl(meta) {
  const roots = window.__sc_hydration;
  if (!Array.isArray(roots)) return null;

  const wantedUrl = normalizeTrackUrl(meta?.link);
  const wantedTitle = String(meta?.title || '').trim().toLowerCase();
  const wantedArtist = String(meta?.artist || '').trim().toLowerCase();
  const seen = new WeakSet();
  const stack = [...roots];
  let titleMatch = null;

  while (stack.length) {
    const value = stack.pop();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);

    const wave = value.waveform_url || value.waveformUrl;
    if (wave) {
      const candidateUrl = normalizeTrackUrl(value.permalink_url || value.permalinkUrl || '');
      const candidateTitle = String(value.title || '').trim().toLowerCase();
      const candidateArtist = String(value.user?.username || value.publisher_metadata?.artist || '').trim().toLowerCase();
      if (wantedUrl && candidateUrl === wantedUrl) return wave;
      if (wantedTitle && candidateTitle === wantedTitle && (!wantedArtist || !candidateArtist || candidateArtist === wantedArtist)) {
        titleMatch = titleMatch || wave;
      }
    }

    for (const child of Object.values(value)) {
      if (child && typeof child === 'object') stack.push(child);
    }
  }
  return titleMatch;
}

async function resolveWaveformUrl(meta) {
  const direct = meta?.waveform || hydrationWaveformUrl(meta);
  if (direct) return direct;

  // Never guess from the most recently requested SoundCloud waveform. Feed and
  // playlist scrolling can load unrelated waveform resources in parallel.
  return null;
}

function downsampleWaveform(samples, count = DEFAULT_WAVE_HEIGHTS.length) {
  if (!Array.isArray(samples) || !samples.length) return null;
  const clean = samples.map(Number).filter(Number.isFinite).map(Math.abs);
  if (!clean.length) return null;
  const result = [];
  for (let i = 0; i < count; i++) {
    const start = Math.floor(i * clean.length / count);
    const end = Math.max(start + 1, Math.floor((i + 1) * clean.length / count));
    let peak = 0;
    for (let j = start; j < Math.min(end, clean.length); j++) peak = Math.max(peak, clean[j]);
    result.push(peak);
  }
  const max = Math.max(...result, 1);
  return result.map(value => Math.round(18 + Math.pow(value / max, 0.72) * 82));
}

function renderWaveform(heights = DEFAULT_WAVE_HEIGHTS) {
  const bars = document.querySelectorAll('#tss-wave-bars i');
  bars.forEach((bar, index) => bar.style.setProperty('--h', `${heights[index] ?? 24}%`));
  updateProgressBar();
}

async function loadTrackWaveform(meta) {
  const key = trackId(meta) || meta?.title || '';
  const request = ++waveformRequest;
  if (!key) { renderWaveform(); return; }
  if (waveformCache.has(key)) { renderWaveform(waveformCache.get(key)); return; }

  const url = await resolveWaveformUrl(meta);
  if (!url) { renderWaveform(); return; }
  try {
    const response = await fetch(url, { credentials: 'omit' });
    if (!response.ok) throw new Error(`waveform ${response.status}`);
    const payload = await response.json();
    const heights = downsampleWaveform(payload.samples || payload.data || payload);
    if (!heights) throw new Error('waveform samples missing');
    waveformCache.set(key, heights);
    if (request === waveformRequest) renderWaveform(heights);
  } catch (_) {
    if (request === waveformRequest) renderWaveform();
  }
}

// ── worker ────────────────────────────────────────────────────────────────────

function mkWorker() {
  try {
    const src = `
      let t = null;
      self.onmessage = e => {
        if (e.data === 'start') { clearInterval(t); t = setInterval(() => self.postMessage(0), 50); }
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
    state._lifetimeBase = {
      played: state.stats.played || 0,
      elapsed: state.stats.elapsed || 0,
      playCounts: { ...(state.stats.playCounts || {}) },
    };
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

function normalizeAccentColor(r, g, b) {
  [r, g, b] = [r, g, b].map(value => Math.max(0, Math.min(255, Math.round(value || 0))));
  const perceived = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  if (perceived < 0.38) {
    const mix = (0.38 - perceived) / (1 - perceived);
    r = Math.round(r + (255 - r) * mix);
    g = Math.round(g + (255 - g) * mix);
    b = Math.round(b + (255 - b) * mix);
  }
  return [r, g, b];
}

function applyAccentColor(r, g, b) {
  [r, g, b] = normalizeAccentColor(r, g, b);
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
  toast.textContent = typeof count === 'string' ? count
                    : count < 0  ? 'start shuffle first'
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

function bindCurrentPageElements(pageEls) {
  const byId = new Map();
  pageEls.forEach(el => {
    const id = trackId(getMeta(el));
    if (id && !byId.has(id)) byId.set(id, el);
  });
  state.els = state.meta.map(meta => {
    const el = byId.get(trackId(meta)) || null;
    if (el) delete meta.unavailable;
    return el;
  });
}

function trackAvailable(ti) {
  const meta = state.meta[ti];
  return Boolean(meta && !meta.unavailable && (meta.sourcePage || state.els[ti]));
}

function reconnectTrackElement(idx) {
  const id = trackId(state.meta[idx]);
  if (!id) return null;
  for (const el of document.querySelectorAll('.trackList__item, .soundList__item, li.sc-list-item')) {
    if (trackId(getMeta(el)) === id) {
      state.els[idx] = el;
      delete state.meta[idx].unavailable;
      return el;
    }
  }
  return null;
}

function navigateToPage(url) {
  const a = document.createElement('a');
  a.href = url;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => a.remove(), 2000);
}

async function loadTrackSourcePage(idx) {
  const sourcePage = state.meta[idx]?.sourcePage;
  if (!sourcePage || playlistBase(sourcePage) === playlistBase(location.href)) return false;

  state._internalNavigation = true;
  state.suspended = true;
  updateHub();
  navigateToPage(sourcePage);

  try {
    for (let i = 0; i < 40; i++) {
      if (!state.active) return false;
      if (playlistBase(location.href) === playlistBase(sourcePage)) break;
      await wait(250);
    }
    if (playlistBase(location.href) !== playlistBase(sourcePage)) return false;

    const pageEls = await loadTracks();
    if (!state.active || !pageEls.length) return false;
    bindCurrentPageElements(pageEls);
    state.suspended = false;
    state.playlistUrl = sourcePage;
    return Boolean(state.els[idx] && document.body.contains(state.els[idx]));
  } finally {
    state._internalNavigation = false;
    updateHub();
  }
}

async function playAt(idx, countPlay = true) {
  if (!state.active) return;

  let el = state.els[idx];
  if (!el || !document.body.contains(el)) {
    el = reconnectTrackElement(idx);
    if (!el && await loadTrackSourcePage(idx)) el = state.els[idx];
  }

  if (!el || !document.body.contains(el)) {
    state.els[idx] = null;
    if (state.meta[idx]) state.meta[idx].unavailable = true;
    // Remove all occurrences of this dead index so future rounds never include it.
    let removedUpcoming = 0;
    for (let i = state.queue.length - 1; i >= 0; i--) {
      if (state.queue[i] === idx) {
        if (i >= state.pos) removedUpcoming++;
        state.queue.splice(i, 1);
        if (i < state.pos) state.pos = Math.max(0, state.pos - 1);
      }
    }
    state.roundTotal = Math.max(state.roundPlayed, state.roundTotal - removedUpcoming);
    state.playNext = state.playNext.filter(ti => ti !== idx);
    const anyPlayable = state.queue.some(trackAvailable);
    if (!anyPlayable) {
      state.suspended = true;
      state.busy      = false;
      updateHub();
      return;
    }
    const replacement = state.queue[state.pos];
    if (replacement !== undefined) await playAt(replacement, countPlay);
    return;
  }

  const wasPaused = paused();
  pause();
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  await wait(80);

  const btn = el.querySelector([
    'button.sc-button-play',
    '.playButton',
    'button[title*="Play"]',
    'button[aria-label*="Play"]',
    '.trackItem__coverArt button',
    '.sound__coverArt button',
  ].join(', '));
  if (!btn) {
    if (!wasPaused && paused()) toggle();
    state.busy = false;
    showMergeToast('play button not found for this track');
    return;
  }
  btn.click();

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

  if (!state.queue.some(trackAvailable)) {
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
    // Spotify-style shuffle: each track plays exactly once per round.
    // The played track is removed and NOT re-inserted; only when the
    // whole round is exhausted do we reshuffle everything for a new round.
    state.queue.splice(state.pos, 1);
    state.roundPlayed = Math.min(state.roundTotal, state.roundPlayed + 1);

    const remaining = state.queue.length - state.pos;
    if (!state.stopAfterRound && remaining <= 0) {
      // round complete → fresh shuffle with a balanced starting position
      const aliveIndices = [...Array(state.meta.length).keys()].filter(trackAvailable);
      state.queue = buildBalancedRound(aliveIndices, justPlayed);
      state.pos   = 0;
      state.roundPlayed = 0;
      state.roundTotal = state.queue.length;
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
  state._manualActionAt = Date.now();

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

function moveSelectedTrackToCurrent(ti) {
  const current = state.queue[state.pos];
  if (current === ti) return false;

  if (current !== undefined) {
    state.history.push(current);
    if (state.history.length > 100) state.history.shift();
    state.queue.splice(state.pos, 1);
    state.roundPlayed = Math.min(state.roundTotal, state.roundPlayed + 1);
  }

  const targetIndex = state.queue.indexOf(ti);
  if (targetIndex !== -1) state.queue.splice(targetIndex, 1);
  state.queue.splice(state.pos, 0, ti);
  return true;
}

async function jumpTo(qi, ti) {
  if (!state.active) return;
  if (state.busy) return;
  state.busy         = true;
  state.manualAction = true;
  state._manualActionAt = Date.now();
  state.suspended    = false;

  if (!moveSelectedTrackToCurrent(ti)) {
    await playAt(ti, false);
    state.busy = false;
    return;
  }
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
  if (qi >= state.pos) state.roundTotal = Math.max(state.roundPlayed + 1, state.roundTotal - 1);
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

  const existingById = new Map();
  state.meta.forEach((m, ti) => {
    const id = trackId(m);
    if (id) existingById.set(id, ti);
  });
  const added = [];

  newEls.forEach(el => {
    const m  = getMeta(el);
    const id = trackId(m);
    if (id && existingById.has(id)) {
      const ti = existingById.get(id);
      state.els[ti] = el;
      state.meta[ti] = { ...state.meta[ti], ...m };
      delete state.meta[ti].unavailable;
      return;
    }
    const ti = state.els.length;
    state.els.push(el);
    state.meta.push(m);
    if (id) existingById.set(id, ti);
    added.push(ti);
  });

  if (added.length > 0) {
    const shuffled = fisherYates(added);
    state.queue.splice(state.pos + 1, 0, ...shuffled);
    state.roundTotal += added.length;

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

async function reshuffleCurrentPage() {
  if (!validPage() || state.loading || state.busy) return;

  if (!state.active) {
    await start();
    return;
  }

  const btn = document.getElementById('tss-hub-reshuffle');
  const setLoading = loading => {
    if (!btn) return;
    btn.dataset.loading = loading ? 'true' : 'false';
    btn.disabled = loading;
  };

  setLoading(true);
  const pageUrl = location.href.split(/[?#]/)[0];
  const samePlaylist = playlistBase(pageUrl) === playlistBase(state.playlistUrl);

  try {
    if (samePlaylist && !state.suspended) {
      const alive = [...Array(state.els.length).keys()]
        .filter(ti => state.els[ti] && document.body.contains(state.els[ti]));
      const currentTi = state.queue[state.pos];
      if (!alive.length || currentTi === undefined) {
        showMergeToast('nothing to reshuffle');
        return;
      }

      state.queue = buildReshuffledQueue(alive, currentTi);
      state.pos = 0;
      state.playNext = [];
      state.priority = {};
      state.skipCounts = {};
      state.roundStarts = {};
      state.roundPlayed = 0;
      state.roundTotal = state.queue.length;
      state.suspended = false;
      badges();
      renderList();
      updateHub();
      showMergeToast(`${Math.max(0, state.queue.length - 1)} upcoming tracks reshuffled`);
      return;
    }

    state.loading = true;
    state.busy = true;
    updateHub();
    const newEls = await loadTracks();
    if (!newEls.length) {
      showMergeToast('no tracks found on this page');
      return;
    }

    const newMeta = newEls.map(getMeta);
    const newQueue = buildReshuffledQueue([...Array(newEls.length).keys()]);
    if (!newQueue.length) {
      showMergeToast('no tracks found on this page');
      return;
    }

    state.els = newEls;
    state.meta = newMeta;
    state.queue = newQueue;
    state.pos = 0;
    state.playNext = [];
    state.history = [];
    state.priority = {};
    state.skipCounts = {};
    state.roundStarts = {};
    state.roundPlayed = 0;
    state.roundTotal = state.queue.length;
    state.suspended = false;
    state.manualAction = false;
    state.playlistUrl = pageUrl;
    saveLifetimeStats();
    state.stats.playCounts = {};
    state._lifetimeBase = {
      played: state.stats.played,
      elapsed: state.stats.elapsed,
      playCounts: {},
    };

    await playAt(state.queue[0]);
    if (!state.active) return;

    state.busy = false;
    badges();
    renderList();
    startWatcher();
    updateHub();
    showMergeToast(`${state.queue.length} tracks loaded & reshuffled`);
  } catch (_) {
    showMergeToast('could not re-shuffle this page');
  } finally {
    state.loading = false;
    state.busy = false;
    setLoading(false);
    updateHub();
  }
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
          _cached = {
            queue: finalQueue,
            pos: newPos,
            history: newHistory,
            priority: newPriority,
            roundPlayed: Math.max(0, Number(_c.roundPlayed) || 0),
            roundTotal: Math.max(finalQueue.length, Number(_c.roundTotal) || finalQueue.length),
          };
        }
      }
    }
  } catch (_) {}

  if (_cached) {
    state.queue    = _cached.queue;
    state.pos      = _cached.pos;
    state.history  = _cached.history;
    state.priority = _cached.priority;
    state.roundPlayed = _cached.roundPlayed;
    state.roundTotal = _cached.roundTotal;
  } else {
    state.priority = {};
    state.queue    = fisherYates([...Array(els.length).keys()]);
    state.pos      = 0;
    state.history  = [];
    state.roundPlayed = 0;
    state.roundTotal = state.queue.length;
  }

  state.playNext     = [];
  state.skipCounts   = {};
  state.roundStarts  = {};
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
  if (state._endedHandler) {
    document.removeEventListener('ended', state._endedHandler, true);
    state._endedHandler = null;
  }
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
  if (state._endedHandler) {
    document.removeEventListener('ended', state._endedHandler, true);
    state._endedHandler = null;
  }

  state.lastTitle = playerTitle();
  let lastTitle  = state.lastTitle;
  let titleTicks = 0;
  let nearEnd    = false;
  let lastRemaining = Infinity;
  let endpointTicks = 0;
  let uiTicks = 0;

  const resetEndGuard = async () => {
    lastTitle = playerTitle();
    endpointTicks = 0;
    if (!state.active) { nearEnd = false; return; }
    for (let i = 0; i < 10; i++) {
      if (progress() < 0.1) break;
      await wait(100);
    }
    nearEnd = false;
  };

  const returnToQueuePage = () => {
    const worker = state.worker;
    state.worker = null;
    if (worker) worker.terminate();
    if (state._workerInterval) { clearInterval(state._workerInterval); state._workerInterval = null; }
    if (state._endedHandler) {
      document.removeEventListener('ended', state._endedHandler, true);
      state._endedHandler = null;
    }

    try {
      sessionStorage.setItem('tss_queue_cache', JSON.stringify({
        queue:       state.queue.slice(),
        pos:         state.pos,
        history:     state.history.slice(),
        priority:    { ...state.priority },
        playlistUrl: state.playlistUrl,
        ts:          Date.now(),
        metaKeys:    state.meta.map(m => trackId(m) || ''),
        roundPlayed: state.roundPlayed,
        roundTotal:  state.roundTotal,
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
  };

  const advanceAtNaturalEnd = async () => {
    if (!state.active || state.busy || nearEnd) return;
    nearEnd = true;

    try {
      if (state.suspended) {
        if (state.els.some(e => e && document.body.contains(e))) {
          state.suspended = false;
          await next(true);
        } else {
          returnToQueuePage();
          return;
        }
      } else {
        await next(true);
      }
    } finally {
      await resetEndGuard();
    }
  };

  const onMediaEnded = e => {
    if (e.target?.tagName === 'AUDIO') void advanceAtNaturalEnd();
  };
  state._endedHandler = onMediaEnded;
  document.addEventListener('ended', onMediaEnded, true);

  const tick = async () => {
    if (!state.active) return;

    // A manual transition normally clears when the title changes. Tracks can
    // legitimately share the same displayed title, so never keep the guard
    // alive long enough to swallow the next natural end.
    if (state.manualAction && Date.now() - state._manualActionAt > 3000) {
      state.manualAction = false;
    }

    // End detection runs at 50 ms; visual refreshes keep their old cadence.
    if (++uiTicks >= 6) {
      uiTicks = 0;
      refreshPlayBtn();
      updateHub();
    }

    if (state.busy) return;

    const title  = playerTitle();
    const timing = playbackTiming();
    const p      = timing.duration ? timing.current / timing.duration : 0;

    if (timing.ended) {
      await advanceAtNaturalEnd();
      return;
    }

    // SoundCloud can leave a completed stream parked at its exact endpoint
    // without surfacing audio.ended or changing the title. Require both the
    // paused player state and two endpoint polls so seeking near the end does
    // not revive the old percentage-based early skip.
    const parkedAtEnd = timing.duration > 0
      && timing.current >= timing.duration - 0.05
      && paused();
    if (parkedAtEnd) {
      if (++endpointTicks >= 2) await advanceAtNaturalEnd();
      return;
    }
    endpointTicks = 0;

    if (state.suspended) {
      if (title && title !== lastTitle) lastTitle = title;
      titleTicks = 0;
      lastRemaining = timing.duration ? Math.max(0, timing.duration - timing.current) : Infinity;
      state.lastProgress = p;
      return;
    }

    if (title && lastTitle && title !== lastTitle) {
      const naturalEndTitleChange = lastRemaining <= 5 || state.lastProgress >= 0.999;
      if (!state.manualAction && naturalEndTitleChange) {
        titleTicks = 0;
        lastTitle = title;
        pause();
        await advanceAtNaturalEnd();
        return;
      }
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

    if (state.lastProgress > 0.5 && p < 0.1) nearEnd = false;
    state.lastProgress = p;
    lastRemaining = timing.duration ? Math.max(0, timing.duration - timing.current) : Infinity;
    if (title) lastTitle = title;
  };

  state.worker = mkWorker();
  if (state.worker) {
    state.worker.onmessage = tick;
    state.worker.postMessage('start');
  } else {
    state._workerInterval = setInterval(tick, 50);
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
    const base = state._lifetimeBase || { played: 0, elapsed: 0 };
    const totalPlayed  = (lt.played  || 0) + Math.max(0, (state.stats.played  || 0) - (base.played  || 0));
    const totalElapsed = (lt.elapsed || 0) + Math.max(0, (state.stats.elapsed || 0) - (base.elapsed || 0));
    ltEl.textContent = `${totalPlayed} tracks / ${fmtTime(totalElapsed)}`;
  }

  const top = Object.entries(state.stats.playCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);

  const list = overlay.querySelector('#tss-stats-toplist');
  if (!list) return;

  list.innerHTML = top.map(([ti, count]) => {
    const meta  = state.meta[+ti] || {};
    const w     = state.priority[+ti] ?? 1.0;
    const label = w <= 0.25 ? 'low' : w >= 2.0 ? 'high' : 'normal';
    const col   = w <= 0.25 ? '#ff7b58' : w >= 2.0 ? '#65d5a3' : 'rgba(255,255,255,.38)';
    return `
      <div class="tss-stat-track" style="grid-template-columns:minmax(0,1fr) auto auto;">
        <span style="color:#909090;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;">${esc(meta.title || '—')}</span>
        <span style="color:#ff5500;font-size:11px;flex-shrink:0;">${count}×</span>
        <button class="tss-stat-priority" data-ti="${ti}" style="color:${col};">${label}</button>
      </div>`;
  }).join('');

  if (!top.length) list.innerHTML = '<div class="tss-stats-empty">No listening data yet</div>';

  list.querySelectorAll('[data-ti]').forEach(btn => {
    btn.onclick = e => {
      e.stopPropagation();
      const ti  = +btn.getAttribute('data-ti');
      const cur = state.priority[ti] ?? 1.0;
      let next2, label, col;
      if      (cur >= 2.0) { next2 = 1.0;  label = 'normal'; col = 'rgba(255,255,255,.38)'; }
      else if (cur >= 1.0) { next2 = 0.25; label = 'low';    col = '#ff7b58'; }
      else                 { next2 = 2.0;  label = 'high';   col = '#65d5a3'; }
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
    background:rgba(10,10,10,0.98); border:1px solid rgba(255,255,255,0.09);
    border-radius:18px; padding:0; z-index:999999;
    font-family:-apple-system,'Segoe UI',system-ui,sans-serif;
    width:340px; max-width:calc(100vw - 32px); box-sizing:border-box;
    box-shadow:0 30px 90px rgba(0,0,0,0.78),0 0 0 1px rgba(var(--tss-ar,255),var(--tss-ag,85),var(--tss-ab,0),0.035);
    cursor:default; -webkit-user-select:none; user-select:none;
    -webkit-backdrop-filter:blur(20px); backdrop-filter:blur(20px);
  `;

  overlay.innerHTML = `
    <div id="tss-stats-header" class="tss-stats-head">
      <div>
        <div class="tss-stats-kicker">True Shuffle</div>
        <div class="tss-stats-title">Listening stats</div>
      </div>
      <button id="tss-stats-close" class="tss-stats-close" aria-label="Close stats">${SVG.close}</button>
    </div>
    <div class="tss-stats-body">
      <div class="tss-stats-metrics">
        <div>
          <div id="tss-stats-played" class="tss-stats-value">0</div>
          <div class="tss-stats-label">Tracks played</div>
        </div>
        <div class="tss-stats-divider"></div>
        <div>
          <div id="tss-stats-time" class="tss-stats-value">0s</div>
          <div class="tss-stats-label">Listening time</div>
        </div>
      </div>
      <div class="tss-stats-lifetime">
        <span class="tss-stats-lifetime-label">All time</span>
        <span id="tss-stats-lifetime"></span>
      </div>
      <div class="tss-stats-section">
        <span class="tss-stats-section-label">Most played</span>
        <span class="tss-stats-section-label">Priority</span>
      </div>
      <div id="tss-stats-toplist"></div>
      <button id="tss-stats-reset" class="tss-stats-reset">Reset session and all-time stats</button>
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
    if (e.target.closest('#tss-stats-close')) return;
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
        filter:blur(48px) brightness(0.12) saturate(0.65);
        opacity:0; transition:opacity 0.7s ease;
      }
      #tss-hub-bgmask {
        position:absolute; inset:0;
        background:linear-gradient(160deg, rgba(9,9,9,0.86) 0%, rgba(7,7,7,0.97) 100%);
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

      #tss-hub-reshuffle {
        width:28px; height:28px; padding:0; border-radius:8px;
        color:rgba(255,255,255,0.28); background:transparent;
      }
      #tss-hub-reshuffle:hover {
        color:var(--tss-a,#ff5500);
        background:rgba(var(--tss-ar,255),var(--tss-ag,85),var(--tss-ab,0),0.12);
      }
      #tss-hub-reshuffle:focus-visible {
        outline:2px solid var(--tss-a,#ff5500); outline-offset:2px;
      }
      #tss-hub-reshuffle:disabled { cursor:wait; opacity:0.55; }
      #tss-hub-reshuffle[data-loading="true"] svg { animation:tss-spin 0.8s linear infinite; }
      @keyframes tss-spin { to { transform:rotate(360deg); } }
      @media (prefers-reduced-motion:reduce) {
        #tss-hub-reshuffle[data-loading="true"] svg { animation:none; }
      }

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

      /* v5 deck concept — visual layer only */
      #tss-hub {
        --tss-panel:rgba(10,10,10,0.96);
        --tss-line:rgba(255,255,255,0.09);
        --tss-muted:rgba(255,255,255,0.48);
        box-sizing:border-box;
      }
      #tss-hub-bgmask {
        background:linear-gradient(155deg,rgba(11,11,11,0.9) 0%,rgba(7,7,7,0.985) 72%);
      }
      #tss-hub-hdr { min-height:34px; }
      .tss-deck-brand { display:flex;align-items:center;gap:9px;min-width:0; }
      .tss-deck-brandmark {
        width:32px !important;height:32px !important;border-radius:9px !important;
        color:rgba(255,255,255,0.8) !important;
        border:1px solid rgba(255,255,255,0.12) !important;
        background:rgba(255,255,255,0.035) !important;
      }
      .tss-deck-brandmark:hover {
        color:var(--tss-a,#ff5500) !important;
        border-color:rgba(var(--tss-ar,255),var(--tss-ag,85),var(--tss-ab,0),0.42) !important;
        background:rgba(var(--tss-ar,255),var(--tss-ag,85),var(--tss-ab,0),0.1) !important;
      }
      .tss-deck-label {
        color:rgba(255,255,255,0.88);font-size:10px;font-weight:760;
        letter-spacing:0.14em;text-transform:uppercase;white-space:nowrap;
      }
      .tss-deck-track {
        display:grid;grid-template-columns:78px minmax(0,1fr);gap:13px;
        align-items:center;padding:5px 14px 12px;
      }
      #tss-hub-art {
        width:78px !important;height:78px !important;border-radius:13px !important;
        box-shadow:0 14px 34px rgba(0,0,0,0.56),0 0 0 1px rgba(255,255,255,0.08) !important;
      }
      #tss-hub-title { font-size:15.5px !important;font-weight:740 !important;letter-spacing:-0.02em;line-height:1.16 !important; }
      #tss-hub-artist { font-size:11px !important;color:rgba(255,255,255,.52) !important;margin-top:4px !important; }
      .tss-round-pill {
        display:inline-flex;align-items:center;max-width:100%;margin-top:10px;
        border:1px solid rgba(255,255,255,0.11);border-radius:999px;
        background:rgba(255,255,255,0.035);padding:4px 9px;
        color:var(--tss-a,#ff5500);font-size:9px;font-weight:750;
        letter-spacing:0.08em;text-transform:uppercase;
      }
      #tss-hub-qpos {
        display:inline-block;max-width:100%;margin-top:8px;
        border:0;border-radius:0;background:transparent;padding:0;
        color:rgba(255,255,255,0.42) !important;font-size:10px !important;font-weight:650;
        letter-spacing:0.045em;text-transform:none;font-variant-numeric:tabular-nums;
      }
      #tss-hub-nextup { display:none !important; }
      .tss-deck-timeline { padding:0 14px 1px; }
      #tss-hub-seekbar {
        margin:0 !important;height:13px !important;border-radius:2px !important;
        background:transparent !important;
        overflow:hidden;transform:none !important;
      }
      #tss-hub-seekbar:hover { transform:none !important; }
      #tss-hub-prog { position:absolute;left:0;bottom:0;height:1px;background:transparent !important;opacity:0;pointer-events:none; }
      .tss-wave-bars { position:absolute;inset:0;display:flex;align-items:center;gap:3px; }
      .tss-wave-bars i { display:block;flex:1;min-width:1px;height:var(--h);border-radius:2px;background:rgba(255,255,255,.2);transition:background .12s ease,filter .12s ease; }
      .tss-wave-bars i[data-played="true"] { background:var(--tss-a,#ff5500);filter:drop-shadow(0 0 3px rgba(var(--tss-ar,255),var(--tss-ag,85),var(--tss-ab,0),.42)); }
      .tss-deck-times { display:flex;justify-content:space-between;margin-top:5px;color:rgba(255,255,255,.5);font-size:9px;font-variant-numeric:tabular-nums; }
      .tss-deck-controls { display:flex;align-items:center;justify-content:center;gap:16px;padding:9px 14px 15px; }
      .tss-deck-controls .tss-hub-btn-sm { width:40px;height:40px;background:rgba(255,255,255,0.095);color:rgba(255,255,255,.82); }
      .tss-deck-controls .tss-hub-btn-lg { width:54px;height:54px;box-shadow:0 7px 24px rgba(var(--tss-ar,255),var(--tss-ag,85),var(--tss-ab,0),.34),0 0 0 1px rgba(255,255,255,.14); }
      .tss-hub-btn:focus-visible,#tss-hub-start:focus-visible,#tss-hub-sleep:focus-visible {
        outline:2px solid var(--tss-a,#ff5500);outline-offset:2px;
      }
      .tss-deck-utilities {
        display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 9px 14px;
        border-top:1px solid rgba(255,255,255,0.055);
      }
      #tss-hub-stop-after {
        appearance:none;-webkit-appearance:none;width:31px;height:18px;margin:0;
        border-radius:999px;background:rgba(255,255,255,0.1);
        border:1px solid rgba(255,255,255,0.09);position:relative;cursor:pointer;
        transition:background .18s,border-color .18s;vertical-align:middle;
      }
      #tss-hub-stop-after::after {
        content:'';position:absolute;width:12px;height:12px;left:2px;top:2px;border-radius:50%;
        background:rgba(255,255,255,0.72);transition:transform .18s,background .18s;
      }
      #tss-hub-stop-after:checked {
        background:rgba(var(--tss-ar,255),var(--tss-ag,85),var(--tss-ab,0),0.35);
        border-color:rgba(var(--tss-ar,255),var(--tss-ag,85),var(--tss-ab,0),0.58);
      }
      #tss-hub-stop-after:checked::after { transform:translateX(13px);background:#fff; }
      #tss-hub-stop-after:focus-visible { outline:2px solid var(--tss-a,#ff5500);outline-offset:2px; }
      .tss-deck-switch { display:flex;align-items:center;gap:8px;min-width:0;cursor:pointer;position:relative;left:-37px; }
      .tss-deck-switch input { position:absolute;opacity:0;pointer-events:none; }
      .tss-deck-switch-track {
        width:30px;height:18px;border-radius:999px;background:rgba(255,255,255,0.1);
        border:1px solid rgba(255,255,255,0.09);box-sizing:border-box;position:relative;flex-shrink:0;transition:background .18s,border-color .18s;
      }
      .tss-deck-switch-track::after {
        content:'';position:absolute;width:12px;height:12px;left:2px;top:2px;border-radius:50%;
        background:rgba(255,255,255,0.72);transition:transform .18s,background .18s;
      }
      .tss-deck-switch input:checked + .tss-deck-switch-track {
        background:rgba(var(--tss-ar,255),var(--tss-ag,85),var(--tss-ab,0),0.35);
        border-color:rgba(var(--tss-ar,255),var(--tss-ag,85),var(--tss-ab,0),0.58);
      }
      .tss-deck-switch input:checked + .tss-deck-switch-track::after { transform:translateX(12px);background:#fff; }
      .tss-deck-switch input:focus-visible + .tss-deck-switch-track { outline:2px solid var(--tss-a,#ff5500);outline-offset:2px; }
      .tss-deck-switch-label { color:rgba(255,255,255,0.46);font-size:8px;font-weight:680;letter-spacing:0.045em;text-transform:uppercase;white-space:nowrap; }
      .tss-deck-sleep {
        display:flex;align-items:center;gap:6px;margin-left:auto;flex-shrink:0;
      }
      #tss-hub-sleep-display:empty { display:none; }
      #tss-hub-sleep { border-radius:7px;padding:5px 7px;font-size:9px; }
      #tss-hub-start { min-height:44px;border-radius:10px;text-transform:uppercase;letter-spacing:0.08em;font-size:10px; }
      #tss-hub-start[data-active="true"] {
        display:none;
      }
      #tss-hub-start[data-active="true"]:hover { color:rgba(255,255,255,0.78);border-color:rgba(255,255,255,0.16); }
      .tss-deck-utilities label { color:rgba(255,255,255,0.4) !important;font-size:9px !important; }

      .tss-side-head { padding:14px 14px 11px;border-bottom:1px solid var(--tss-line);flex-shrink:0; }
      #tss-sidebar > div:first-child {
        padding:14px 14px 11px !important;border-bottom:1px solid rgba(255,255,255,.08) !important;
        background:linear-gradient(180deg,rgba(255,255,255,.025),transparent) !important;
      }
      .tss-side-titlebar { display:flex;align-items:center;gap:8px;margin-bottom:9px; }
      .tss-side-title { color:rgba(255,255,255,0.9);font-size:11px;font-weight:780;letter-spacing:.13em;text-transform:uppercase; }
      .tss-side-action {
        display:flex;align-items:center;justify-content:center;gap:7px;min-height:34px;padding:0 11px;
        border:1px solid rgba(255,255,255,.1);border-radius:8px;background:rgba(255,255,255,.035);
        color:rgba(255,255,255,.52);cursor:pointer;font-size:9px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;
        transition:color .18s,border-color .18s,background .18s;
      }
      .tss-side-action:hover { color:#fff;border-color:rgba(255,255,255,.2);background:rgba(255,255,255,.07); }
      .tss-side-tabs { display:flex;align-items:center;gap:24px;border-bottom:1px solid rgba(255,255,255,.07); }
      .tss-side-tab {
        border:0;background:transparent;color:rgba(255,255,255,.32);padding:0 0 10px;cursor:pointer;
        font:700 10px/1 -apple-system,'Segoe UI',system-ui,sans-serif;letter-spacing:.1em;text-transform:uppercase;
        border-bottom:2px solid transparent;transition:color .18s,border-color .18s;
      }
      .tss-side-tab[data-active="true"] { color:var(--tss-a,#ff5500);border-bottom-color:var(--tss-a,#ff5500); }
      #tss-tab-queue,#tss-tab-history {
        background:transparent !important;border:0 !important;border-radius:0 !important;
        padding:5px 0 10px !important;color:rgba(255,255,255,.3) !important;
        font-size:9px !important;font-weight:750 !important;letter-spacing:.09em;text-transform:uppercase;
        border-bottom:2px solid transparent !important;
      }
      #tss-tab-queue[data-active="true"],#tss-tab-history[data-active="true"] {
        color:var(--tss-a,#ff5500) !important;border-bottom-color:var(--tss-a,#ff5500) !important;
      }
      #tss-merge-btn,#tss-stats-btn {
        color:rgba(255,255,255,.45) !important;display:flex !important;align-items:center;justify-content:center;
        min-height:30px;padding:0 9px !important;border:1px solid rgba(255,255,255,.09);border-radius:8px !important;
        background:rgba(255,255,255,.025) !important;cursor:pointer;transition:color .18s,border-color .18s,background .18s;
      }
      #tss-merge-btn:hover,#tss-stats-btn:hover { color:#fff !important;border-color:rgba(255,255,255,.18);background:rgba(255,255,255,.065) !important; }
      .tss-side-searchwrap { position:relative;margin-top:13px; }
      .tss-side-searchicon { position:absolute;left:11px;top:50%;transform:translateY(-50%);color:rgba(255,255,255,.28);pointer-events:none;display:flex; }
      #tss-search { width:100% !important;box-sizing:border-box !important;background:rgba(255,255,255,.025) !important;border:1px solid rgba(255,255,255,.09) !important;border-radius:9px !important;color:#dedede !important;font-size:11px !important;padding:9px 11px !important;outline:none !important;font-family:-apple-system,'Segoe UI',system-ui,sans-serif !important;transition:border-color .18s,background .18s !important; }
      #tss-search:focus { border-color:rgba(var(--tss-ar,255),var(--tss-ag,85),var(--tss-ab,0),.55);background:rgba(255,255,255,.04); }
      .tss-queue-row { border-bottom:1px solid rgba(255,255,255,.055); }
      .tss-queue-handle { color:rgba(255,255,255,.18);font-size:14px;letter-spacing:-2px;width:10px;overflow:hidden;flex-shrink:0; }
      .tss-queue-status { border-radius:5px;padding:3px 7px;font-size:8px;font-weight:750;letter-spacing:.07em;text-transform:uppercase;flex-shrink:0; }
      #tss-sidebar[data-side="left"] { border-radius:16px 0 0 16px !important; }
      #tss-sidebar[data-side="right"] { border-radius:0 16px 16px 0 !important; }
      #tss-hub[data-sidebar-side="right"] { border-radius:18px 0 0 18px !important; }
      #tss-hub[data-sidebar-side="left"] { border-radius:0 18px 18px 0 !important; }
      #tss-hub[data-sidebar-side="right"] #tss-hub-bg { border-radius:18px 0 0 18px; }
      #tss-hub[data-sidebar-side="left"] #tss-hub-bg { border-radius:0 18px 18px 0; }
      #tss-sidebar[data-open="false"] { opacity:0;pointer-events:none;transform:translateX(-8px); }
      #tss-sidebar[data-open="true"] { opacity:1;pointer-events:auto;transform:translateX(0); }
      #tss-sidebar { box-sizing:border-box; }
      #tss-sidebar-list { min-height:0; }
      .tss-sidebar-resize {
        position:absolute;top:0;bottom:0;width:10px;padding:0;border:0;background:transparent;
        cursor:ew-resize;z-index:5;outline:none;
      }
      #tss-sidebar[data-side="right"] .tss-sidebar-resize { right:-1px; }
      #tss-sidebar[data-side="left"] .tss-sidebar-resize { left:-1px; }
      .tss-sidebar-resize::after {
        content:'';position:absolute;top:50%;left:50%;width:2px;height:36px;border-radius:999px;
        background:rgba(255,255,255,.11);transform:translate(-50%,-50%);transition:height .18s,background .18s;
      }
      .tss-sidebar-resize:hover::after,.tss-sidebar-resize[data-dragging="true"]::after {
        height:54px;background:var(--tss-a,#ff5500);
      }
      .tss-sidebar-height-resize {
        position:absolute;left:50%;top:-1px;width:76px;height:10px;padding:0;border:0;background:transparent;
        cursor:ns-resize;z-index:6;outline:none;transform:translateX(-50%);
      }
      .tss-sidebar-height-resize::after {
        content:'';position:absolute;left:50%;top:50%;width:36px;height:2px;border-radius:999px;
        background:rgba(255,255,255,.11);transform:translate(-50%,-50%);transition:width .18s,background .18s;
      }
      .tss-sidebar-height-resize:hover::after,.tss-sidebar-height-resize[data-dragging="true"]::after {
        width:54px;background:var(--tss-a,#ff5500);
      }

      #tss-stats-overlay {
        color:#eeeeee;background:rgba(10,10,10,.985) !important;
        border:1px solid rgba(255,255,255,.09) !important;border-radius:18px !important;
        box-shadow:0 30px 90px rgba(0,0,0,.78),0 0 0 1px rgba(var(--tss-ar,255),var(--tss-ag,85),var(--tss-ab,0),.035) !important;
      }
      .tss-stats-head {
        display:flex;align-items:center;justify-content:space-between;padding:14px 15px 12px;
        border-bottom:1px solid rgba(255,255,255,.07);cursor:move;
      }
      .tss-stats-kicker { color:var(--tss-a,#ff5500);font-size:8px;font-weight:760;letter-spacing:.13em;text-transform:uppercase; }
      .tss-stats-title { margin-top:3px;color:#f1f1f1;font-size:14px;font-weight:680;letter-spacing:-.01em; }
      .tss-stats-close {
        width:32px;height:32px;border:1px solid rgba(255,255,255,.08);border-radius:8px;
        display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,.025);
        color:rgba(255,255,255,.38);cursor:pointer;transition:color .18s,border-color .18s,background .18s;
      }
      .tss-stats-close:hover { color:#fff;border-color:rgba(255,255,255,.16);background:rgba(255,255,255,.06); }
      .tss-stats-close:focus-visible { outline:2px solid var(--tss-a,#ff5500);outline-offset:2px; }
      .tss-stats-body { padding:15px; }
      .tss-stats-metrics { display:grid;grid-template-columns:1fr 1px 1fr;align-items:end;gap:15px;padding:2px 2px 14px; }
      .tss-stats-divider { width:1px;height:42px;background:rgba(255,255,255,.08);align-self:center; }
      .tss-stats-value { color:#f3f3f3;font-size:25px;font-weight:680;letter-spacing:-.035em;line-height:1;font-variant-numeric:tabular-nums; }
      .tss-stats-label { margin-top:7px;color:rgba(255,255,255,.34);font-size:8px;font-weight:700;letter-spacing:.1em;text-transform:uppercase; }
      .tss-stats-lifetime { display:flex;align-items:center;justify-content:space-between;padding:11px 0;border-top:1px solid rgba(255,255,255,.065);border-bottom:1px solid rgba(255,255,255,.065); }
      .tss-stats-lifetime-label,.tss-stats-section-label { color:rgba(255,255,255,.34);font-size:8px;font-weight:720;letter-spacing:.1em;text-transform:uppercase; }
      #tss-stats-lifetime { color:rgba(255,255,255,.54);font-size:10px;font-variant-numeric:tabular-nums; }
      .tss-stats-section { display:flex;align-items:center;justify-content:space-between;padding:13px 0 6px; }
      .tss-stat-track { display:grid;grid-template-columns:30px minmax(0,1fr) auto auto;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid rgba(255,255,255,.05); }
      .tss-stat-art { width:30px;height:30px;border-radius:7px;overflow:hidden;background:rgba(255,255,255,.04);display:flex;align-items:center;justify-content:center; }
      .tss-stat-art img { width:100%;height:100%;object-fit:cover;display:block; }
      .tss-stat-copy { min-width:0; }
      .tss-stat-title { color:rgba(255,255,255,.72);font-size:10.5px;font-weight:590;overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
      .tss-stat-artist { margin-top:2px;color:rgba(255,255,255,.28);font-size:9px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
      .tss-stat-count { color:var(--tss-a,#ff5500);font-size:10px;font-weight:700;font-variant-numeric:tabular-nums; }
      .tss-stat-priority { min-width:52px;border:1px solid rgba(255,255,255,.08);border-radius:6px;padding:4px 7px;background:rgba(255,255,255,.025);font:700 8px/1 -apple-system,'Segoe UI',system-ui,sans-serif;letter-spacing:.06em;text-transform:uppercase;cursor:pointer; }
      .tss-stat-priority:hover { background:rgba(255,255,255,.06);border-color:rgba(255,255,255,.15); }
      .tss-stat-track > span:first-child { color:rgba(255,255,255,.7) !important;font-size:10.5px !important;font-weight:560; }
      .tss-stat-track > span:nth-child(2) { color:var(--tss-a,#ff5500) !important;font-size:10px !important;font-weight:700; }
      .tss-stats-empty { padding:18px 0;color:rgba(255,255,255,.25);font-size:10px;text-align:center; }
      .tss-stats-reset { width:100%;margin-top:15px;border:0;background:transparent;color:rgba(255,255,255,.26);padding:7px;cursor:pointer;font-size:9px;font-family:-apple-system,'Segoe UI',system-ui,sans-serif;transition:color .18s; }
      .tss-stats-reset:hover { color:rgba(255,255,255,.62); }
      .tss-stats-reset:focus-visible { outline:2px solid var(--tss-a,#ff5500);outline-offset:2px;border-radius:6px; }
      @media (prefers-reduced-motion:reduce) {
        #tss-hub *,#tss-sidebar * { animation-duration:0.01ms !important;transition-duration:0.01ms !important;scroll-behavior:auto !important; }
      }
    `;
    document.head.appendChild(s);
  }

  const hub = document.createElement('div');
  hub.id = 'tss-hub';
  hub.style.cssText = `
    position:fixed; bottom:80px; left:20px; width:min(330px,calc(100vw - 24px));
    background:rgba(9,9,9,0.985); border:1px solid rgba(195,176,142,0.18);
    border-radius:18px; z-index:99994;
    overflow:hidden; -webkit-user-select:none; user-select:none;
    box-shadow:0 30px 82px rgba(0,0,0,0.84), 0 0 0 1px rgba(255,255,255,0.02);
    -webkit-backdrop-filter:blur(24px); backdrop-filter:blur(24px);
    font-family:-apple-system,'Segoe UI',system-ui,sans-serif;
  `;

  const waveform = DEFAULT_WAVE_HEIGHTS.map(height => `<i style="--h:${height}%" data-played="false"></i>`).join('');

  hub.innerHTML = `
    <div id="tss-hub-bg">
      <div id="tss-hub-bgimg"></div>
      <div id="tss-hub-bgmask"></div>
    </div>

    <div id="tss-hub-inner">

      <div id="tss-hub-hdr" style="cursor:move; padding:11px 13px 8px; display:flex; align-items:center; justify-content:space-between;">
        <div class="tss-deck-brand">
          <button id="tss-hub-reshuffle" class="tss-hub-btn tss-deck-brandmark" data-loading="false" aria-label="Re-shuffle current playlist" title="Re-shuffle upcoming tracks">${SVG.shuffle}</button>
          <span class="tss-deck-label">True Shuffle</span>
        </div>
        <div style="display:flex; gap:3px; align-items:center;">
          <button id="tss-hub-stats" class="tss-hub-btn tss-hub-btn-icon" aria-label="Session stats" title="session stats">${SVG.chart}</button>
          <button id="tss-hub-qico"  class="tss-hub-btn tss-hub-btn-icon" data-open="false" aria-label="Queue panel" title="queue panel">${SVG.list}</button>
          <button id="tss-hub-col"   class="tss-hub-btn tss-hub-btn-icon" title="collapse" style="font-size:15px; line-height:1; padding:3px 6px;">−</button>
        </div>
      </div>

      <div id="tss-hub-body">

        <div id="tss-hub-active-view" style="display:none;">

          <div class="tss-deck-track">
            <div id="tss-hub-art" style="
              width:76px; height:76px; border-radius:14px; flex-shrink:0;
              background:#1a1a1a; overflow:hidden;
              display:flex; align-items:center; justify-content:center;
              box-shadow:0 14px 34px rgba(0,0,0,0.56), 0 0 0 1px rgba(255,255,255,0.08);
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

          <div class="tss-deck-timeline">
          <div id="tss-hub-seekbar" title="seek" style="
            height:3px;
            background:rgba(255,255,255,0.09); border-radius:2px;
            cursor:pointer; position:relative;
          ">
            <div id="tss-wave-bars" class="tss-wave-bars" aria-hidden="true">${waveform}</div>
            <div id="tss-hub-prog" style="width:0%;"></div>
          </div>
          <div class="tss-deck-times">
            <span id="tss-hub-time-current">0:00</span>
            <span id="tss-hub-time-remaining">-0:00</span>
          </div>
          </div>

          <div class="tss-deck-controls">
            <button id="tss-hub-prev" class="tss-hub-btn tss-hub-btn-sm" aria-label="Previous track">${SVG.prev}</button>
            <button id="tss-hub-play" class="tss-hub-btn tss-hub-btn-lg" aria-label="Play or pause">${SVG.play}</button>
            <button id="tss-hub-next" class="tss-hub-btn tss-hub-btn-sm" aria-label="Next track">${SVG.next}</button>
          </div>

        </div>

        <div id="tss-hub-actions" style="padding:0 14px 14px;">
          <button id="tss-hub-start" data-active="false" data-loading="false">True Shuffle</button>
          <div class="tss-deck-utilities">
            <label class="tss-deck-switch">
              <input id="tss-hub-stop-after" type="checkbox">
              <span class="tss-deck-switch-track"></span>
              <span class="tss-deck-switch-label">Stop after this round</span>
            </label>
            <label class="tss-deck-sleep">
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
  document.getElementById('tss-hub-next').onclick  = () => {
    state.manualAction = true;
    state._manualActionAt = Date.now();
    next();
  };
  document.getElementById('tss-hub-stats').onclick = showStats;
  document.getElementById('tss-hub-reshuffle').onclick = e => {
    e.stopPropagation();
    reshuffleCurrentPage();
  };
  document.getElementById('tss-hub-seekbar').onclick = e => {
    const r = e.currentTarget.getBoundingClientRect();
    seekTo((e.clientX - r.left) / r.width);
  };

  document.getElementById('tss-hub-qico').onclick = e => { e.stopPropagation(); toggleSidebar(); };

  const stopAfterRound = document.getElementById('tss-hub-stop-after');
  stopAfterRound.checked  = state.stopAfterRound;
  stopAfterRound.onchange = () => { state.stopAfterRound = stopAfterRound.checked; };

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
    requestAnimationFrame(syncSidebarToHub);
    colBtn.textContent    = open ? '+' : '−';
  };

  const hubHdr = document.getElementById('tss-hub-hdr');
  hubHdr.onmousedown = e => {
    if (e.target.closest('button')) return;
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
      syncSidebarToHub();
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

  const onDifferentPlaylist = active
    && playlistBase(location.href) !== playlistBase(state.playlistUrl);
  const reshuffleTitle = onDifferentPlaylist
    ? 'Load & re-shuffle this playlist'
    : 'Re-shuffle upcoming tracks';
  for (const reshuffleBtn of [
    document.getElementById('tss-hub-reshuffle'),
  ]) {
    if (!reshuffleBtn) continue;
    reshuffleBtn.dataset.loading = loading ? 'true' : 'false';
    reshuffleBtn.disabled = loading;
    reshuffleBtn.title = reshuffleTitle;
  }

  const av = document.getElementById('tss-hub-active-view');
  if (av) av.style.display = active ? '' : 'none';

  const startBtn = document.getElementById('tss-hub-start');
  const actions  = document.getElementById('tss-hub-actions');
  if (startBtn) {
    startBtn.style.display = active ? 'none' : '';
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

  if (actions) actions.style.padding = active ? '0' : '0 14px 14px';

  const cb = document.getElementById('tss-hub-stop-after');
  if (cb && cb.checked !== state.stopAfterRound) cb.checked = state.stopAfterRound;

  const qi = document.getElementById('tss-hub-qico');
  if (qi) {
    qi.dataset.open = state.sidebarOpen ? 'true' : 'false';
    qi.title        = state.sidebarOpen ? 'close queue panel' : 'open queue panel';
  }
  syncSidebarToHub();

  if (!active) {
    const prog  = document.getElementById('tss-hub-prog');
    if (prog) prog.style.width = '0%';
    if (state._lastWaveformKey) {
      state._lastWaveformKey = '';
      waveformRequest++;
      renderWaveform();
    }
    const currentTime = document.getElementById('tss-hub-time-current');
    const remainingTime = document.getElementById('tss-hub-time-remaining');
    if (currentTime) currentTime.textContent = '0:00';
    if (remainingTime) remainingTime.textContent = '-0:00';
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

  const waveformKey = trackId(m) || m?.title || '';
  if (waveformKey && state._lastWaveformKey !== waveformKey) {
    state._lastWaveformKey = waveformKey;
    renderWaveform();
    loadTrackWaveform(m);
  }

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

  updateProgressBar();

  const timing = playbackTiming();
  const currentTime = document.getElementById('tss-hub-time-current');
  const remainingTime = document.getElementById('tss-hub-time-remaining');
  if (currentTime) currentTime.textContent = formatPlaybackClock(timing.current);
  if (remainingTime) remainingTime.textContent = `-${formatPlaybackClock(Math.max(0, timing.duration - timing.current))}`;

  const nextTi = state.queue[state.pos + 1];
  const nextM  = nextTi !== undefined ? state.meta[nextTi] : null;
  const qpos   = document.getElementById('tss-hub-qpos');
  const nextup = document.getElementById('tss-hub-nextup');
  if (qpos) {
    const total = Math.max(1, state.roundTotal || state.queue.length);
    const inRound = Math.min(total, Math.max(1, state.roundPlayed + 1));
    qpos.textContent = `${inRound} / ${total}`;
  }
  if (nextup) nextup.textContent = nextM ? nextM.title : '—';
}

// ── sidebar ───────────────────────────────────────────────────────────────────

function syncSidebarToHub() {
  if (!state.sidebarOpen) return;
  const hub = document.getElementById('tss-hub');
  const sidebar = document.getElementById('tss-sidebar');
  if (!hub || !sidebar) return;

  const rect = hub.getBoundingClientRect();
  const requestedWidth = Math.max(260, Math.min(620, state.sidebarWidth || 320));
  const rightSpace = Math.max(0, window.innerWidth - rect.right - 12);
  const leftSpace = Math.max(0, rect.left - 12);
  const fitsRight = rightSpace >= 220 || rightSpace >= leftSpace;
  const available = fitsRight ? rightSpace : leftSpace;
  const canDock = available >= 220;
  const viewportWidth = Math.max(120, window.innerWidth - 24);
  const width = canDock ? Math.min(requestedWidth, available) : Math.min(requestedWidth, viewportWidth);
  const left = canDock
    ? (fitsRight ? rect.right - 1 : rect.left - width + 1)
    : Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
  const requestedHeight = state.sidebarHeight > 0 ? state.sidebarHeight : rect.height;
  const maxHeight = Math.max(120, rect.bottom - 12);
  const height = Math.min(Math.max(Math.min(rect.height, maxHeight), requestedHeight), maxHeight);
  const top = rect.bottom - height;

  sidebar.style.width  = `${width}px`;
  sidebar.style.left   = `${left}px`;
  sidebar.style.top    = `${top}px`;
  sidebar.style.height = `${height}px`;
  sidebar.dataset.side = fitsRight ? 'right' : 'left';
  hub.dataset.sidebarSide = fitsRight ? 'right' : 'left';
}

function setupSidebarResize() {
  const sidebar = document.getElementById('tss-sidebar');
  const handle = document.getElementById('tss-sidebar-resize');
  const heightHandle = document.getElementById('tss-sidebar-height-resize');
  if (!sidebar || !handle || !heightHandle) return;

  try {
    const saved = Number(localStorage.getItem('tss_sidebar_width'));
    if (Number.isFinite(saved) && saved >= 120 && saved <= 620) state.sidebarWidth = saved;
    const savedHeight = Number(localStorage.getItem('tss_sidebar_height'));
    if (Number.isFinite(savedHeight) && savedHeight >= 300) state.sidebarHeight = savedHeight;
  } catch (_) {}

  handle.onmousedown = e => {
    e.preventDefault();
    e.stopPropagation();
    const hub = document.getElementById('tss-hub');
    if (!hub) return;

    const side = sidebar.dataset.side || 'right';
    const startX = e.clientX;
    const startWidth = sidebar.getBoundingClientRect().width;
    const hubRect = hub.getBoundingClientRect();
    const available = side === 'right'
      ? window.innerWidth - hubRect.right - 12
      : hubRect.left - 12;
    const maxWidth = Math.max(120, Math.min(620, available || window.innerWidth - 24));
    const minWidth = Math.min(260, maxWidth);
    const previousTransition = sidebar.style.transition;

    handle.dataset.dragging = 'true';
    sidebar.style.transition = 'none';
    document.body.style.cursor = 'ew-resize';

    const move = ev => {
      const delta = side === 'right' ? ev.clientX - startX : startX - ev.clientX;
      state.sidebarWidth = Math.max(minWidth, Math.min(maxWidth, startWidth + delta));
      syncSidebarToHub();
    };
    const up = () => {
      delete handle.dataset.dragging;
      sidebar.style.transition = previousTransition;
      document.body.style.cursor = '';
      try { localStorage.setItem('tss_sidebar_width', String(Math.round(state.sidebarWidth))); } catch (_) {}
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  };

  handle.ondblclick = e => {
    e.preventDefault();
    e.stopPropagation();
    state.sidebarWidth = 320;
    try { localStorage.setItem('tss_sidebar_width', '320'); } catch (_) {}
    syncSidebarToHub();
  };

  heightHandle.onmousedown = e => {
    e.preventDefault();
    e.stopPropagation();
    const hub = document.getElementById('tss-hub');
    if (!hub) return;

    const startY = e.clientY;
    const startHeight = sidebar.getBoundingClientRect().height;
    const maxHeight = Math.max(120, hub.getBoundingClientRect().bottom - 12);
    const minHeight = Math.min(hub.getBoundingClientRect().height, maxHeight);
    const previousTransition = sidebar.style.transition;

    heightHandle.dataset.dragging = 'true';
    sidebar.style.transition = 'none';
    document.body.style.cursor = 'ns-resize';

    const move = ev => {
      state.sidebarHeight = Math.max(minHeight, Math.min(maxHeight, startHeight + (startY - ev.clientY)));
      syncSidebarToHub();
    };
    const up = () => {
      delete heightHandle.dataset.dragging;
      sidebar.style.transition = previousTransition;
      document.body.style.cursor = '';
      try { localStorage.setItem('tss_sidebar_height', String(Math.round(state.sidebarHeight))); } catch (_) {}
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  };

  heightHandle.ondblclick = e => {
    e.preventDefault();
    e.stopPropagation();
    state.sidebarHeight = 0;
    try { localStorage.removeItem('tss_sidebar_height'); } catch (_) {}
    syncSidebarToHub();
  };
}

function mkSidebar() {
  if (document.getElementById('tss-sidebar')) return;

  const sidebar = document.createElement('div');
  sidebar.id = 'tss-sidebar';
  sidebar.dataset.open = 'false';
  sidebar.dataset.side = 'right';
  sidebar.style.cssText = `
    position:fixed; left:-9999px; top:12px;
    width:min(320px,calc(100vw - 24px)); height:380px;
    background:rgba(9,9,9,0.99); border:1px solid rgba(195,176,142,0.18);
    border-radius:0 16px 16px 0; overflow:hidden;
    z-index:99997; display:flex; flex-direction:column;
    transition:opacity 0.2s ease,transform 0.2s ease;
    font-family:-apple-system,'Segoe UI',system-ui,sans-serif;
    box-shadow:24px 28px 72px rgba(0,0,0,0.72);
    -webkit-backdrop-filter:blur(24px); backdrop-filter:blur(24px);
  `;

  sidebar.innerHTML = `
    <button id="tss-sidebar-resize" class="tss-sidebar-resize" aria-label="Resize queue panel" title="Drag to resize · double-click to reset"></button>
    <button id="tss-sidebar-height-resize" class="tss-sidebar-height-resize" aria-label="Resize queue height" title="Drag upward for more tracks · double-click to reset"></button>
    <div class="tss-side-head">
      <div class="tss-side-titlebar">
        <span class="tss-side-title">Up next</span>
        <span style="flex:1;"></span>
        <button id="tss-merge-btn" class="tss-side-action" title="add current page to queue">${SVG.plus}<span>Merge playlist</span></button>
      </div>
      <div class="tss-side-tabs">
        <button id="tss-tab-queue" class="tss-side-tab" data-active="true">Queue</button>
        <button id="tss-tab-history" class="tss-side-tab" data-active="false">History</button>
        <span style="flex:1;"></span>
        <span id="tss-sidebar-count" style="color:rgba(255,255,255,.32);font-size:10px;font-variant-numeric:tabular-nums;padding-bottom:9px;"></span>
      </div>
      <div class="tss-side-searchwrap">
        <span class="tss-side-searchicon">${SVG.search}</span>
        <input id="tss-search" placeholder="Search tracks" style="padding-left:33px !important;" />
      </div>
    </div>
    <div id="tss-sidebar-list" style="overflow-y:auto;flex:1;padding:6px 0;scrollbar-width:thin;scrollbar-color:#242424 transparent;"></div>
  `;

  document.body.appendChild(sidebar);
  setupSidebarResize();

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
  window.addEventListener('resize', syncSidebarToHub);
}

function updateTabStyles() {
  const qBtn = document.getElementById('tss-tab-queue');
  const hBtn = document.getElementById('tss-tab-history');
  if (qBtn) {
    const active = state.sidebarTab === 'queue';
    qBtn.dataset.active       = active ? 'true' : 'false';
    qBtn.style.background   = active ? 'rgba(255,255,255,0.06)' : 'transparent';
    qBtn.style.color        = active ? '#f0f0f0' : '#464646';
    qBtn.style.borderColor  = active ? 'rgba(255,255,255,0.12)' : 'transparent';
  }
  if (hBtn) {
    const active = state.sidebarTab === 'history';
    hBtn.dataset.active       = active ? 'true' : 'false';
    hBtn.style.background   = active ? 'rgba(255,255,255,0.06)' : 'transparent';
    hBtn.style.color        = active ? '#f0f0f0' : '#464646';
    hBtn.style.borderColor  = active ? 'rgba(255,255,255,0.12)' : 'transparent';
  }
}

function toggleSidebar() {
  state.sidebarOpen = !state.sidebarOpen;
  const s = document.getElementById('tss-sidebar');
  if (s) {
    s.dataset.open = state.sidebarOpen ? 'true' : 'false';
    if (state.sidebarOpen) syncSidebarToHub();
  }
  if (!state.sidebarOpen) {
    const hub = document.getElementById('tss-hub');
    if (hub) delete hub.dataset.sidebarSide;
  }
  updateHub();
}

// ── list ──────────────────────────────────────────────────────────────────────

function renderList(filter) {
  // no explicit filter → keep whatever is currently typed in the search box
  if (filter === undefined) filter = document.getElementById('tss-search')?.value || '';

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
  if (count) {
    const total = Math.max(1, state.roundTotal || state.queue.length);
    const current = Math.min(total, Math.max(1, state.roundPlayed + 1));
    count.textContent = `${current} / ${total}`;
  }

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
      display:flex; align-items:center; gap:9px; padding:7px 12px;
      cursor:pointer; background:transparent; transition:background 0.12s;
      -webkit-user-select:none; user-select:none;
    `;
    row.title = 'add to play next';
    row.onmouseenter = () => { row.style.background = 'rgba(255,255,255,0.025)'; };
    row.onmouseleave = () => { row.style.background = 'transparent'; };
    row.onclick = () => { queueNext(ti); };

    const artEl = document.createElement('div');
    artEl.style.cssText = 'width:42px;height:42px;border-radius:8px;flex-shrink:0;background:#1a1a1a;overflow:hidden;display:flex;align-items:center;justify-content:center;color:#2c2c2c;';
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
  row.className = 'tss-queue-row';
  row.style.cssText = `
      display:flex; align-items:center; gap:9px; padding:7px 12px;
    cursor:pointer;
    background:${cur ? 'rgba(var(--tss-ar,255),var(--tss-ag,85),var(--tss-ab,0),0.09)' : 'transparent'};
    border-left:2px solid ${cur ? 'var(--tss-a,#ff5500)' : 'transparent'};
    transition:background 0.12s;
    opacity:${past ? '0.3' : '1'};
    -webkit-user-select:none; user-select:none;
  `;
  row.onmouseenter = () => { if (!cur) row.style.background = 'rgba(255,255,255,0.025)'; };
  row.onmouseleave = () => { if (!cur) row.style.background = 'transparent'; };

  const art = document.createElement('div');
  art.style.cssText = 'width:42px;height:42px;border-radius:8px;flex-shrink:0;background:#1a1a1a;overflow:hidden;display:flex;align-items:center;justify-content:center;color:#2c2c2c;box-shadow:0 5px 14px rgba(0,0,0,.28);';
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
    <div style="font-size:12px;color:${cur ? '#f4f4f4' : '#c8c8c8'};font-weight:${cur ? '680' : '520'};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.35;">${esc(m.title)}</div>
    <div style="font-size:10px;color:rgba(255,255,255,.38);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:3px;">${esc(m.artist)}</div>
  `;

  const handle = document.createElement('span');
  handle.className = 'tss-queue-handle';
  handle.textContent = '::';

  const status = document.createElement('span');
  status.className = 'tss-queue-status';
  status.textContent = cur ? 'playing' : qi < 0 ? 'next' : '';
  status.style.cssText = cur
    ? 'color:var(--tss-a,#ff5500);background:rgba(var(--tss-ar,255),var(--tss-ag,85),var(--tss-ab,0),.12);'
    : qi < 0
      ? 'color:var(--tss-a,#ff5500);background:rgba(var(--tss-ar,255),var(--tss-ag,85),var(--tss-ab,0),.1);'
      : 'display:none;';

  row.append(handle, art, txt, status, num);
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
let navPending = false;
async function onNav() {
  if (state._internalNavigation) return;
  if (navLock) { navPending = true; return; }
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
        if (freshEls.length > 0) bindCurrentPageElements(freshEls);
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
    if (navPending) {
      navPending = false;
      queueMicrotask(() => onNav());
    }
  }
}

let lastUrl = location.href;
let injectRetryTimer = null;
new MutationObserver(() => {
  if (location.href !== lastUrl) { lastUrl = location.href; onNav(); }
  else if (validPage() && !document.getElementById('tss-hub') && !injectRetryTimer) {
    injectRetryTimer = setTimeout(() => {
      injectRetryTimer = null;
      inject();
    }, 250);
  }
}).observe(document, { subtree: true, childList: true });

onNav();

})();
