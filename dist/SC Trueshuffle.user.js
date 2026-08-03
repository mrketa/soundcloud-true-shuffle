// ==UserScript==
// @name         SoundCloud True Shuffle
// @namespace    https://greasyfork.org/scripts/soundcloud-true-shuffle
// @version      6.1.4
// @description  True full-playlist shuffle with a two-deck player, DJ crossfade, equalizer, Auto Level, queue and background playback.
// @author       keta
// @match        https://soundcloud.com/*
// @license      MIT
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @sandbox      raw
// @run-at       document-end
// ==/UserScript==

(function () {
'use strict';

const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
const CUSTOM_EQ_PRESETS_KEY = 'tss_eq_custom_presets_v1';
const BLOCKED_EQ_PRESET_NAMES = new Set(['__proto__', 'prototype', 'constructor']);

function sanitizeCustomEqPresets(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([name, values]) =>
    !BLOCKED_EQ_PRESET_NAMES.has(String(name).trim().toLowerCase())
      && Array.isArray(values) && values.length === 5
  ).slice(0, 20).map(([name, values]) => [
    String(name).slice(0, 24),
    values.map(band => Math.max(-12, Math.min(12, Number(band) || 0))),
  ]));
}

function localCustomEqPresets() {
  try {
    return sanitizeCustomEqPresets(JSON.parse(localStorage.getItem('tss_eq_custom_presets') || '{}'));
  } catch (_) {
    return {};
  }
}

function loadCustomEqPresets() {
  const localPresets = localCustomEqPresets();
  try {
    if (typeof GM_getValue !== 'function') return localPresets;
    const stored = GM_getValue(CUSTOM_EQ_PRESETS_KEY, null);
    // Once the Tampermonkey vault exists it is authoritative, including an
    // intentionally empty object after the user deleted every preset.
    if (stored !== null && stored !== undefined) return sanitizeCustomEqPresets(stored);
    if (typeof GM_setValue === 'function') GM_setValue(CUSTOM_EQ_PRESETS_KEY, localPresets);
  } catch (_) {}
  return localPresets;
}

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
  _sidebarDirty: true,
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
  _waveformBars: null,
  _lastWaveformPlayed: 0,
  _endedHandler: null,
  _manualActionAt: 0,
  _internalNavigation: false,
  _internalNavigationTarget: '',
  _internalNavigationToken: 0,
  _likeBusy: false,
  _likeStateTrack: null,
  _likeStateLastCheck: 0,
  crossfadeSeconds: Math.max(0, Math.min(12, Number(localStorage.getItem('tss_crossfade_seconds')) || 0)),
  crossfadeCurve: ['smooth', 'clean', 'dj'].includes(localStorage.getItem('tss_crossfade_curve'))
    ? localStorage.getItem('tss_crossfade_curve')
    : 'smooth',
  crossfadeManual: localStorage.getItem('tss_crossfade_manual') !== 'false',
  _playbackVolumeStored: localStorage.getItem('tss_playback_volume') !== null
    || localStorage.getItem('tss_crossfade_output') !== null,
  _playbackVolumeInitialized: false,
  playbackVolume: (() => {
    const saved = localStorage.getItem('tss_playback_volume') ?? localStorage.getItem('tss_crossfade_output');
    if (saved === null) return 0.1;
    const value = Number(saved);
    return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.1;
  })(),
  autoLevel: localStorage.getItem('tss_auto_level') === 'true',
  safetyClipper: localStorage.getItem('tss_safety_clipper') === 'true',
  eqEnabled: localStorage.getItem('tss_eq_enabled') === 'true',
  eqBands: (() => {
    try {
      const values = JSON.parse(localStorage.getItem('tss_eq_bands') || '[]');
      return Array.isArray(values) && values.length === 5
        ? values.map(value => Math.max(-12, Math.min(12, Number(value) || 0)))
        : [0, 0, 0, 0, 0];
    } catch (_) { return [0, 0, 0, 0, 0]; }
  })(),
  eqPreset: localStorage.getItem('tss_eq_preset') || 'Flat',
  customEqPresets: loadCustomEqPresets(),
  crossfadeStatus: 'off',
  _crossfadePending: false,
  _crossfading: false,
  _crossfadePausedByUser: false,
  _crossfadeSchedule: null,
  _crossfadeToken: 0,
  _deckIndex: -1,
  _deckTrack: null,
  _decks: [],
  _deckTracks: [null, null],
  _deckPrepareTokens: [0, 0],
  _crossfadePrefetchToken: 0,
  _deckGains: [0, 0],
  _audioContext: null,
  _audioMaster: null,
  _audioClipper: null,
  _deckAudioGraphs: [null, null],
  _appliedMasterGain: null,
  _autoLevelLastTick: 0,
  _autoLevelCache: (() => {
    try {
      const parsed = JSON.parse(localStorage.getItem('tss_auto_level_cache_v4') || '{}');
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_) { return {}; }
  })(),
  _autoLevelCacheTimer: null,
  _streamCache: new Map(),
  _clientId: '',
  _lastSoundCloudVolume: null,
  _soundCloudVolumeModel: null,
  _nativePlaybackFallback: null,
  _nativeGuardButtonAction: false,
  _pipBridgePlayer: null,
  _ownPipWindow: null,
  _ownPipMode: null,
  _ownPipHost: null,
  _videoPip: null,
  _playTimeLastAt: null,
  _playTimeWasAudible: false,
  _playTimeRemainderMs: 0,
  _liveSyncKnownIds: new Set(),
  _liveSyncInFlight: false,
  _liveSyncLastCheck: 0,
  _liveSyncSource: '',
  _liveSyncTimer: null,
  _playbackDiagnostics: (() => {
    try {
      const saved = JSON.parse(localStorage.getItem('tss_playback_diagnostics') || '[]');
      return Array.isArray(saved) ? saved.slice(-80) : [];
    } catch (_) { return []; }
  })(),
  _playbackDiagnosticFault: (() => {
    try {
      const saved = JSON.parse(localStorage.getItem('tss_playback_diagnostics') || '[]');
      return Array.isArray(saved) && saved.some(entry => ['crossfade-clock-stall', 'crossfade-deck-paused', 'crossfade-handoff-failed', 'recovery-exhausted', 'recovery-failed'].includes(entry?.event));
    } catch (_) { return false; }
  })(),
  _tabTitleBeforePlayback: null,
  _tabTitleValue: '',
  _browserMetadataKey: '',
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
  if (state._deckTrack !== null && state.meta[state._deckTrack]) {
    return state.meta[state._deckTrack].title || '';
  }
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
  const deck = currentDeckAudio();
  if (deck) return deck;
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
  const deck = currentDeckAudio();
  if (deck) return deck.paused;
  return soundCloudPaused();
}

function soundCloudPaused() {
  const btn = document.querySelector('.playControls__play');
  if (!btn) return false;
  const label = (btn.getAttribute('aria-label') || '').toLowerCase();
  return label.startsWith('play') || (btn.title || '').toLowerCase().startsWith('play');
}

function isTrueShuffleAudio(audio) {
  return Boolean(audio && (
    state._decks?.includes(audio) ||
    audio.dataset?.tssCrossfadeDeck !== undefined
  ));
}

function nativePlaybackFallbackActive(audio = null) {
  const fallback = state._nativePlaybackFallback;
  const trackIndex = state.queue[state.pos];
  const deckPlaying = state._decks?.some(deck => deck && !deck.paused && !deck.ended);
  const active = Boolean(
    fallback
    && Date.now() < fallback.expiresAt
    && fallback.trackIndex === trackIndex
    && !deckPlaying
  );
  if (!active && fallback) {
    clearNativePlaybackFallback();
    return false;
  }
  // The fallback grant authorizes exactly one native play event. Leaving a
  // time-wide exemption lets unrelated SoundCloud autoplay overlap our decks.
  if (active && audio) clearNativePlaybackFallback();
  return active;
}

function beginNativePlaybackFallback(trackIndex) {
  state._nativePlaybackFallback = {
    trackIndex,
    expiresAt: Date.now() + 3000,
  };
}

function clearNativePlaybackFallback() {
  state._nativePlaybackFallback = null;
}

function pauseSoundCloud() {
  const nativeAudios = [...document.querySelectorAll('audio')]
    .filter(audio => !isTrueShuffleAudio(audio));
  nativeAudios.forEach(audio => {
    if (!audio.paused) {
      try { audio.pause(); } catch (_) {}
    }
  });
}

function pauseSoundCloudTransport() {
  const button = document.querySelector('.playControls__play');
  if (!button || soundCloudPaused()) return false;
  state._nativeGuardButtonAction = true;
  try {
    button.click();
    return true;
  } finally {
    state._nativeGuardButtonAction = false;
  }
}

function installNativePlaybackGuard() {
  if (state._nativePlaybackGuardInstalled) return;
  state._nativePlaybackGuardInstalled = true;

  document.addEventListener('click', event => {
    const button = event.target?.closest?.('.playControls__play');
    if (!button || (!state.active && !state.loading) || state._nativeGuardButtonAction) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    queueMicrotask(() => {
      pauseSoundCloudTransport();
      pauseSoundCloud();
    });
  }, true);

  document.addEventListener('play', event => {
    const audio = event.target;
    if (audio?.tagName !== 'AUDIO' || (!state.active && !state.loading) || isTrueShuffleAudio(audio)) return;
    if (nativePlaybackFallbackActive(audio)) return;
    try { audio.pause(); } catch (_) {}
    queueMicrotask(() => {
      pauseSoundCloudTransport();
      pauseSoundCloud();
    });
  }, true);

  // SoundCloud may restore its native player shortly after a hard reload.
  // Catch both an already-running element and delayed autoplay initialization.
  [0, 100, 500, 1500, 3000].forEach(delay => {
    setTimeout(() => {
      if ((state.active || state.loading) && !nativePlaybackFallbackActive()) {
        pauseSoundCloudTransport();
        pauseSoundCloud();
      }
    }, delay);
  });
}

function pause() {
  const deck = currentDeckAudio();
  if (deck) {
    state._decks.forEach(audio => { if (audio && !audio.paused) audio.pause(); });
    if (state._crossfading) suspendAudioGraph();
    return;
  }
  pauseSoundCloud();
}

async function toggle() {
  const deck = currentDeckAudio();
  if (deck) {
    if (state._crossfading) {
      const mixingDecks = state._decks.filter((audio, index) =>
        audio && state._deckTracks[index] !== null
      );
      const shouldResume = mixingDecks.length > 0 && mixingDecks.every(audio => audio.paused);
      if (shouldResume) {
        state._crossfadePausedByUser = false;
        await resumeAudioGraph();
        await Promise.all(mixingDecks.map(audio => audio.play().catch(() => {})));
      } else {
        state._crossfadePausedByUser = true;
        mixingDecks.forEach(audio => { if (!audio.paused) audio.pause(); });
        await suspendAudioGraph();
      }
      setTimeout(refreshPlayBtn, 80);
      return;
    }
    if (deck.paused) {
      await resumeAudioGraph();
      await deck.play().catch(() => {});
    } else {
      deck.pause();
    }
    setTimeout(refreshPlayBtn, 80);
    return;
  }
  const nativeWasPaused = soundCloudPaused();
  if (nativeWasPaused) beginNativePlaybackFallback(state.queue[state.pos]);
  else clearNativePlaybackFallback();
  state._nativeGuardButtonAction = true;
  try {
    document.querySelector('.playControls__play')?.click();
  } finally {
    state._nativeGuardButtonAction = false;
  }
  setTimeout(refreshPlayBtn, 150);
}

function seekTo(ratio) {
  ratio = Math.max(0, Math.min(1, ratio));
  const deck = currentDeckAudio();
  if (deck && Number.isFinite(deck.duration) && deck.duration > 0) {
    deck.currentTime = deck.duration * ratio;
    updateProgressBar();
    return;
  }
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
  if (!state._waveformBars?.[0]?.isConnected) {
    state._waveformBars = [...document.querySelectorAll('#tss-wave-bars i')];
  }
  const bars = state._waveformBars;
  const played = Math.round(ratio * bars.length);
  const previous = Math.max(0, Math.min(bars.length, state._lastWaveformPlayed || 0));
  for (let index = previous; index < played; index++) {
    bars[index].dataset.played = 'true';
  }
  for (let index = played; index < previous; index++) {
    bars[index].dataset.played = 'false';
  }
  state._lastWaveformPlayed = played;
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

function getArtistLink(el) {
  const a = el.querySelector('.trackItem__username, .soundTitle__username, a.sc-link-secondary');
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
  const likeButton = el.querySelector('.sc-button-like');
  return {
    title:   el.querySelector('.trackItem__trackTitle, .soundTitle__title, .sc-link-primary')?.textContent.trim() || '—',
    artist:  el.querySelector('.trackItem__username, .soundTitle__username, .sc-link-secondary')?.textContent.trim() || '—',
    artwork: artwork(el),
    link:    getLink(el),
    artistLink: getArtistLink(el),
    waveform: waveformUrl(el),
    liked: likeButton ? soundCloudLikeButtonState(likeButton) : null,
    sourcePage: location.href.split(/[?#]/)[0].replace(/\/+$/, ''),
  };
}

const LIVE_SYNC_INTERVAL_MS = 10_000;

function playlistSnapshotFromHtml(html) {
  const match = String(html || '').match(/window\.__sc_hydration\s*=\s*(\[[\s\S]*?\]);<\/script>/);
  if (!match) return null;
  try {
    const hydration = JSON.parse(match[1]);
    const entry = hydration.find(item => item?.hydratable === 'playlist' && item?.data?.kind === 'playlist');
    const tracks = Array.isArray(entry?.data?.tracks) ? entry.data.tracks : [];
    if (!tracks.length) return null;
    const trackCount = Number(entry.data.track_count) || tracks.length;
    return {
      id: entry.data.id || null,
      trackCount,
      complete: tracks.length >= trackCount,
      tracks: tracks.filter(track => Number.isFinite(Number(track?.id))),
    };
  } catch (_) {
    return null;
  }
}

function metaFromSoundCloudTrack(track, sourcePage, playlistPosition = null) {
  if (!track?.permalink_url || !track?.title) return null;
  const artworkUrl = track.artwork_url || track.user?.avatar_url || null;
  return {
    soundcloudId: Number(track.id) || null,
    title: track.title || '—',
    artist: track.user?.username || track.publisher_metadata?.artist || '—',
    artwork: artworkUrl ? artworkUrl.replace(/-([a-z]+|t\d+x\d+)\.(jpg|png)$/i, '-t200x200.$2') : null,
    link: track.permalink_url,
    artistLink: track.user?.permalink_url || null,
    waveform: track.waveform_url || null,
    liked: typeof track.user_favorite === 'boolean' ? track.user_favorite : null,
    sourcePage,
    playlistPosition: Number.isFinite(Number(playlistPosition)) ? Number(playlistPosition) : null,
  };
}

function insertTracksRandomlyAfterCurrent(queue, pos, trackIndices, random = Math.random) {
  const start = Math.max(0, Math.min(queue.length, Number(pos) + 1));
  for (const ti of trackIndices) {
    const availableSlots = queue.length - start + 1;
    const offset = Math.floor(Math.max(0, Math.min(0.999999999, Number(random()) || 0)) * availableSlots);
    queue.splice(start + offset, 0, ti);
  }
  return queue;
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
  equalizer:`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" style="display:block;width:14px;height:14px;flex-shrink:0"><path d="M3 2v12M8 2v12M13 2v12"/><circle cx="3" cy="6" r="1.7" fill="currentColor" stroke="none"/><circle cx="8" cy="10" r="1.7" fill="currentColor" stroke="none"/><circle cx="13" cy="5" r="1.7" fill="currentColor" stroke="none"/></svg>`,
  pip:     `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linejoin="round" style="display:block;width:14px;height:14px;flex-shrink:0"><rect x="1.5" y="2.5" width="9" height="7" rx="1.4"/><rect x="5.5" y="6.5" width="9" height="7" rx="1.4" fill="currentColor" stroke="none"/></svg>`,
  note:    `<svg viewBox="0 0 16 16" fill="currentColor" style="display:block;width:18px;height:18px;flex-shrink:0;opacity:0.25"><path d="M9 3v7.27A3 3 0 1 0 11 13V6h2V3H9zm-3 12a1 1 0 110-2 1 1 0 010 2z"/></svg>`,
  shuffle: `<svg viewBox="0 0 24 24" fill="currentColor" style="display:block;width:12px;height:12px;flex-shrink:0"><path d="M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/></svg>`,
  list:    `<svg viewBox="0 0 16 16" fill="currentColor" style="display:block;width:13px;height:13px;flex-shrink:0"><rect x="1" y="2.5" width="14" height="1.5" rx="0.75"/><rect x="1" y="7.25" width="14" height="1.5" rx="0.75"/><rect x="1" y="12" width="14" height="1.5" rx="0.75"/></svg>`,
  more:    `<svg viewBox="0 0 16 16" fill="currentColor" style="display:block;width:13px;height:13px;flex-shrink:0"><circle cx="3" cy="8" r="1.25"/><circle cx="8" cy="8" r="1.25"/><circle cx="13" cy="8" r="1.25"/></svg>`,
  moon:    `<svg viewBox="0 0 16 16" fill="currentColor" style="display:block;width:11px;height:11px;flex-shrink:0"><path d="M14 10.66A6.5 6.5 0 115.34 2a5 5 0 108.66 8.66z"/></svg>`,
  plus:    `<svg viewBox="0 0 16 16" fill="currentColor" style="display:block;width:12px;height:12px;flex-shrink:0"><path d="M8 3a1 1 0 011 1v3h3a1 1 0 110 2H9v3a1 1 0 11-2 0V9H4a1 1 0 110-2h3V4a1 1 0 011-1z"/></svg>`,
  search:  `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" style="display:block;width:13px;height:13px;flex-shrink:0"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/></svg>`,
  volume:  `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" style="display:block;width:13px;height:13px;flex-shrink:0"><path d="M2 6h3l3-2.5v9L5 10H2z"/><path d="M11 5.5a4 4 0 010 5"/><path d="M13 3.5a7 7 0 010 9"/></svg>`,
  heart:   `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" style="display:block;width:14px;height:14px;flex-shrink:0"><path d="M8 13.6S2.2 10.2 2.2 5.8A3.1 3.1 0 018 4.25 3.1 3.1 0 0113.8 5.8C13.8 10.2 8 13.6 8 13.6z"/></svg>`,
  heartFilled:`<svg viewBox="0 0 16 16" fill="currentColor" style="display:block;width:14px;height:14px;flex-shrink:0"><path d="M8 14.2l-.42-.25C5.62 12.78 1.5 9.86 1.5 5.77A3.82 3.82 0 018 3.04a3.82 3.82 0 016.5 2.73c0 4.09-4.12 7.01-6.08 8.18L8 14.2z"/></svg>`,
};

function recordPlaybackDiagnostic(event, details = {}) {
  const entry = {
    at: new Date().toISOString(),
    event,
    track: Number.isInteger(state._deckTrack) ? (state.meta[state._deckTrack]?.title || '') : '',
    ...details,
  };
  state._playbackDiagnostics.push(entry);
  if (state._playbackDiagnostics.length > 80) state._playbackDiagnostics.splice(0, state._playbackDiagnostics.length - 80);
  if (['crossfade-clock-stall', 'crossfade-deck-paused', 'crossfade-handoff-failed', 'recovery-exhausted', 'recovery-failed'].includes(event)) {
    state._playbackDiagnosticFault = true;
  }
  try { localStorage.setItem('tss_playback_diagnostics', JSON.stringify(state._playbackDiagnostics)); } catch (_) {}
  updatePlaybackDiagnosticButton();
  try { console.info('[True Shuffle][playback]', entry); } catch (_) {}
}

function safeMediaUrl(value) {
  try {
    const parsed = new URL(value);
    return `${parsed.origin}${parsed.pathname}`;
  } catch (_) { return ''; }
}

function playbackDiagnosticSnapshot(reason = 'manual') {
  const schedule = state._crossfadeSchedule;
  return {
    at: new Date().toISOString(),
    reason,
    page: location.href.split(/[?#]/)[0],
    state: {
      active: state.active,
      busy: state.busy,
      suspended: state.suspended,
      crossfading: state._crossfading,
      crossfadePausedByUser: state._crossfadePausedByUser,
      crossfadeStatus: state.crossfadeStatus,
      crossfadeSeconds: state.crossfadeSeconds,
      queuePosition: state.pos,
      queueLength: state.queue.length,
      deckIndex: state._deckIndex,
      deckTrack: state._deckTrack,
      currentTrack: Number.isInteger(state._deckTrack) ? state.meta[state._deckTrack]?.title || '' : '',
    },
    audioContext: state._audioContext ? {
      state: state._audioContext.state,
      currentTime: Number(state._audioContext.currentTime) || 0,
      sampleRate: Number(state._audioContext.sampleRate) || 0,
    } : null,
    schedule: schedule ? {
      token: schedule.token,
      startTime: schedule.startTime,
      endTime: schedule.endTime,
      duration: schedule.duration,
      outgoingIndex: schedule.outgoingIndex,
      incomingIndex: schedule.incomingIndex,
      lastClockValue: schedule.lastClockValue,
      lastClockAdvanceAt: schedule.lastClockAdvanceAt,
      lastIncomingTime: schedule.lastIncomingTime,
      lastIncomingAdvanceAt: schedule.lastIncomingAdvanceAt,
    } : null,
    decks: state._decks.map((audio, index) => audio ? {
      index,
      trackIndex: state._deckTracks[index],
      title: Number.isInteger(state._deckTracks[index]) ? state.meta[state._deckTracks[index]]?.title || '' : '',
      paused: audio.paused,
      ended: audio.ended,
      seeking: audio.seeking,
      currentTime: Number(audio.currentTime) || 0,
      duration: Number(audio.duration) || 0,
      readyState: Number(audio.readyState) || 0,
      networkState: Number(audio.networkState) || 0,
      errorCode: Number(audio.error?.code) || 0,
      source: safeMediaUrl(audio.currentSrc || audio.src),
      deckGain: state._deckGains[index],
      mixGain: state._deckAudioGraphs[index]?.mixGain?.gain?.value,
      autoGain: state._deckAudioGraphs[index]?.autoGain?.gain?.value,
    } : null),
    diagnostics: state._playbackDiagnostics.slice(-40).map(entry => {
      const { diagnostics, ...summary } = entry;
      return summary;
    }),
  };
}

function updatePlaybackDiagnosticButton() {
  const button = document.getElementById('tss-playback-debug');
  if (button) button.hidden = !state._playbackDiagnosticFault;
}

function showPlaybackDiagnostics() {
  document.getElementById('tss-debug-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'tss-debug-overlay';
  const report = JSON.stringify(playbackDiagnosticSnapshot('user-opened-report'), null, 2);
  overlay.innerHTML = `
    <div class="tss-debug-dialog" role="dialog" aria-modal="true" aria-labelledby="tss-debug-title">
      <div class="tss-debug-head"><div><strong id="tss-debug-title">Playback report</strong><span>Firefox diagnostics</span></div><button id="tss-debug-close" type="button" aria-label="Close">${SVG.close}</button></div>
      <p>Copy this report if playback stops again. Stream tokens and URL parameters are removed.</p>
      <pre id="tss-debug-report"></pre>
      <div class="tss-debug-actions"><button id="tss-debug-clear" type="button">Clear</button><button id="tss-debug-copy" type="button">Copy report</button></div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#tss-debug-report').textContent = report;
  const close = () => overlay.remove();
  overlay.querySelector('#tss-debug-close').onclick = close;
  overlay.onclick = event => { if (event.target === overlay) close(); };
  overlay.querySelector('#tss-debug-clear').onclick = () => {
    state._playbackDiagnostics = [];
    state._playbackDiagnosticFault = false;
    try { localStorage.removeItem('tss_playback_diagnostics'); } catch (_) {}
    updatePlaybackDiagnosticButton();
    close();
  };
  overlay.querySelector('#tss-debug-copy').onclick = async event => {
    try {
      await navigator.clipboard.writeText(report);
      event.currentTarget.textContent = 'Copied';
    } catch (_) {
      event.currentTarget.textContent = 'Copy failed';
    }
  };
}

const EQ_BANDS = [
  { label: '60',  frequency: 60,    type: 'lowshelf',  q: 0.7 },
  { label: '250', frequency: 250,   type: 'peaking',   q: 0.9 },
  { label: '1k',  frequency: 1000,  type: 'peaking',   q: 0.9 },
  { label: '4k',  frequency: 4000,  type: 'peaking',   q: 0.9 },
  { label: '12k', frequency: 12000, type: 'highshelf', q: 0.7 },
];

const EQ_GRAPH_X = [50, 155, 260, 365, 470];

const EQ_PRESETS = {
  Flat:         [0, 0, 0, 0, 0],
  'Bass Boost': [7, 4, 0, -1, 1],
  Punch:        [5, 3, -1, 2, 1],
  Vocal:        [-2, 0, 4, 3, 1],
  Bright:       [-1, 0, 1, 4, 6],
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
  const roots = pageWindow.__sc_hydration;
  if (!Array.isArray(roots)) return null;

  const wantedUrl = normalizeTrackUrl(meta?.link);
  const seen = new WeakSet();
  const stack = [...roots];

  while (stack.length) {
    const value = stack.pop();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);

    const wave = value.waveform_url || value.waveformUrl;
    if (wave) {
      const candidateUrl = normalizeTrackUrl(value.permalink_url || value.permalinkUrl || '');
      if (wantedUrl && candidateUrl === wantedUrl) return wave;
    }

    for (const child of Object.values(value)) {
      if (child && typeof child === 'object') stack.push(child);
    }
  }
  return null;
}

async function resolveWaveformUrl(meta) {
  const direct = meta?.waveform || hydrationWaveformUrl(meta);
  if (direct) return direct;

  // Firefox often exposes less playlist hydration than Chromium. Resolve the
  // exact track through SoundCloud's API instead of reusing a title match or a
  // recently observed waveform resource from another track.
  const wantedUrl = normalizeTrackUrl(meta?.link);
  if (!wantedUrl) return null;
  const clientId = await discoverSoundCloudClientIdFromBundle();
  if (!clientId) return null;
  try {
    const response = await fetch(`https://api-v2.soundcloud.com/resolve?url=${encodeURIComponent(meta.link)}&client_id=${encodeURIComponent(clientId)}`);
    if (!response.ok) return null;
    const track = await response.json();
    const candidateUrl = normalizeTrackUrl(track?.permalink_url || track?.permalinkUrl || '');
    const resolved = candidateUrl === wantedUrl ? (track?.waveform_url || track?.waveformUrl) : null;
    if (resolved) meta.waveform = resolved;
    return resolved || null;
  } catch (_) {
    return null;
  }
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

function timedSleepRemaining(timer, now = Date.now()) {
  if (!timer || timer.type !== 'time') return Math.max(0, Number(timer?.remaining) || 0);
  const deadline = Number(timer.deadline);
  if (!Number.isFinite(deadline)) return Math.max(0, Number(timer.remaining) || 0);
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

function updateSleepDisplay(now = Date.now()) {
  const el = document.getElementById('tss-hub-sleep-display');
  if (!el) return;
  const t = state.sleepTimer;
  if (!t) { el.textContent = ''; return; }
  if (t.type === 'time') {
    t.remaining = timedSleepRemaining(t, now);
    const m = Math.floor(t.remaining / 60), s = t.remaining % 60;
    el.textContent = m > 0 ? `${m}m` : `${s}s`;
  } else {
    el.textContent = `${t.remaining}`;
  }
}

// ── playback ──────────────────────────────────────────────────────────────────

// Experimental two-deck playback. SoundCloud's normal player remains the
// fallback whenever a public progressive stream cannot be resolved.
function currentDeckAudio() {
  if (!Number.isInteger(state._deckIndex) || state._deckIndex < 0) return null;
  return state._decks[state._deckIndex] || null;
}

function sleepTimerValue() {
  const timer = state.sleepTimer;
  if (!timer) return 'off';
  if (timer.type === 'tracks') return `n${timer.remaining}`;
  const minutes = Math.max(1, Math.ceil(timer.remaining / 60));
  if (minutes <= 15) return 't15';
  if (minutes <= 30) return 't30';
  return 't60';
}

function setSleepTimer(value, now = Date.now()) {
  const raw = String(value || 'off');
  if (raw === 'off') state.sleepTimer = null;
  else if (raw.startsWith('t')) {
    const remaining = Math.max(1, parseInt(raw.slice(1), 10) || 0) * 60;
    state.sleepTimer = { type: 'time', remaining, deadline: now + remaining * 1000 };
  }
  else if (raw.startsWith('n')) state.sleepTimer = { type: 'tracks', remaining: Math.max(1, parseInt(raw.slice(1), 10) || 0) };
  updateSleepDisplay(now);
}

// Better SoundCloud Feed's PiP polls SoundCloud's page-level scPlayer rather
// than Media Session. While True Shuffle's private deck is audible, expose a
// small scPlayer-compatible view of that deck. Every wrapper delegates back to
// SoundCloud unchanged as soon as custom-deck playback is inactive.
function betterFeedPipActive() {
  return state.active && Number.isInteger(state._deckTrack) && Boolean(currentDeckAudio());
}

function betterFeedPipSound() {
  if (!betterFeedPipActive()) return null;
  const ti = state._deckTrack;
  const meta = state.meta[ti];
  if (!meta) return null;

  return {
    // SoundCloud ids are positive. A stable negative queue index lets the PiP
    // detect True Shuffle track changes without impersonating a native model.
    id: -(ti + 1),
    attributes: {
      title: meta.title || '—',
      artwork_url: meta.artwork || null,
      permalink_url: meta.link || null,
      waveform_url: meta.waveform || null,
      publisher_metadata: { artist: meta.artist || '—' },
      user: {
        username: meta.artist || '—',
        permalink_url: meta.artistLink || null,
        avatar_url: null,
      },
    },
    player: {
      getPosition: () => Math.max(0, playbackTiming().current * 1000),
      getDuration: () => Math.max(0, playbackTiming().duration * 1000),
    },
  };
}

// Better SoundCloud Feed owns the PiP UI, but its canvas progress can stop
// repainting while the SoundCloud tab is in the background. Keep that visual
// surface aligned with the same background-safe clock used by our hub. The
// selectors are deliberately scoped to Better Feed's PiP and this is a no-op
// everywhere else.
function syncBetterFeedPipWindow() {
  if (!betterFeedPipActive()) return false;

  try {
    const pipWindow = documentPipApi()?.window;
    const pipDoc = pipWindow?.document;
    if (!pipDoc) return false;

    const timing = playbackTiming();
    const current = Math.max(0, Number(timing.current) || 0);
    const duration = Math.max(0, Number(timing.duration) || 0);
    const timeLabels = pipDoc.querySelectorAll('.pip-time');
    if (timeLabels[0]) timeLabels[0].textContent = formatPlaybackClock(current);
    if (timeLabels[1]) timeLabels[1].textContent = formatPlaybackClock(duration);

    const canvas = pipDoc.querySelector('.pip-waveform');
    if (!canvas || !duration) return true;

    const rect = canvas.getBoundingClientRect();
    const width = Math.floor(rect.width || canvas.width || 0);
    const height = Math.floor(rect.height || canvas.height || 0);
    if (width <= 0 || height <= 0) return true;
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;

    const ctx = canvas.getContext('2d');
    if (!ctx) return true;

    const meta = state.meta[state._deckTrack];
    const key = trackId(meta) || meta?.title || '';
    const heights = waveformCache.get(key) || DEFAULT_WAVE_HEIGHTS;
    const styles = typeof pipWindow.getComputedStyle === 'function'
      ? pipWindow.getComputedStyle(pipDoc.documentElement)
      : null;
    const activeColor = styles?.getPropertyValue('--special-color')?.trim() || '#ff5500';
    const dimColor = styles?.getPropertyValue('--secondary-color')?.trim() || '#666';
    const barWidth = 2;
    const barGap = 1;
    const barCount = Math.max(1, Math.floor(width / (barWidth + barGap)));
    const progressX = Math.max(0, Math.min(1, current / duration)) * width;

    ctx.clearRect(0, 0, width, height);
    for (let i = 0; i < barCount; i++) {
      const sourceIndex = Math.min(
        heights.length - 1,
        Math.floor((i / barCount) * heights.length),
      );
      const barHeight = Math.max(2, (Number(heights[sourceIndex]) || 24) / 100 * height);
      const x = i * (barWidth + barGap);
      ctx.fillStyle = x < progressX ? activeColor : dimColor;
      ctx.fillRect(x, height - barHeight, barWidth, barHeight);
    }
    return true;
  } catch (_) {
    return false;
  }
}

function documentPipApi() {
  let api = null;
  try {
    if (typeof window !== 'undefined') api = window.documentPictureInPicture;
    if (api && typeof api.requestWindow === 'function') return api;
  } catch (_) {}
  try {
    api = pageWindow && pageWindow.documentPictureInPicture;
    if (api && typeof api.requestWindow === 'function') return api;
  } catch (_) {}
  try {
    const wrappedWindow = typeof window !== 'undefined' && window.wrappedJSObject;
    api = wrappedWindow && wrappedWindow.documentPictureInPicture;
    if (api && typeof api.requestWindow === 'function') return api;
  } catch (_) {}
  try {
    const wrappedPageWindow = pageWindow && pageWindow.wrappedJSObject;
    api = wrappedPageWindow && wrappedPageWindow.documentPictureInPicture;
    if (api && typeof api.requestWindow === 'function') return api;
  } catch (_) {}
  return null;
}

function standardVideoPipSupported() {
  const prototype = pageWindow.HTMLVideoElement?.prototype;
  return Boolean(
    (pageWindow.document?.pictureInPictureEnabled && typeof prototype?.requestPictureInPicture === 'function') ||
    typeof prototype?.webkitSetPresentationMode === 'function'
  );
}

function ownPipIsOpen() {
  if (state._ownPipMode === 'video') {
    const video = state._videoPip?.video;
    return Boolean(video && (
      pageWindow.document?.pictureInPictureElement === video ||
      video.webkitPresentationMode === 'picture-in-picture'
    ));
  }
  if (state._ownPipMode === 'inline') return Boolean(state._ownPipHost?.isConnected);
  try {
    return Boolean(state._ownPipWindow && !state._ownPipWindow.closed);
  } catch (_) {
    state._ownPipWindow = null;
    return false;
  }
}

function setOwnPipButtonState() {
  const button = document.getElementById('tss-hub-pip');
  if (!button) return;
  button.style.display = '';
  button.dataset.open = ownPipIsOpen() ? 'true' : 'false';
  button.setAttribute('aria-pressed', ownPipIsOpen() ? 'true' : 'false');
  const mode = state._ownPipMode === 'video' ? 'native video PiP'
    : state._ownPipMode === 'inline' ? 'floating player'
    : 'True Shuffle PiP';
  button.title = ownPipIsOpen() ? `${mode} is open` : 'Open True Shuffle PiP';
}

function closeOwnPip() {
  const pipWindow = state._ownPipWindow;
  const pipHost = state._ownPipHost;
  const videoPip = state._videoPip;
  const mode = state._ownPipMode;
  state._ownPipWindow = null;
  state._ownPipHost = null;
  state._ownPipMode = null;
  state._videoPip = null;
  if (videoPip) {
    if (videoPip.timer) clearInterval(videoPip.timer);
    try {
      if (pageWindow.document?.pictureInPictureElement === videoPip.video) {
        void pageWindow.document.exitPictureInPicture();
      } else if (videoPip.video?.webkitPresentationMode === 'picture-in-picture') {
        videoPip.video.webkitSetPresentationMode('inline');
      }
    } catch (_) {}
    try { videoPip.stream?.getTracks?.().forEach(track => track.stop()); } catch (_) {}
    try { videoPip.video?.remove(); } catch (_) {}
    try { videoPip.canvas?.remove(); } catch (_) {}
  }
  try { pipHost?.remove(); } catch (_) {}
  try {
    if (mode === 'document' && pipWindow && !pipWindow.closed) pipWindow.close();
  } catch (_) {}
  setOwnPipButtonState();
}

function drawOwnPipWaveform(canvas, meta, current, duration, accent) {
  if (!canvas || !duration) return;
  const rect = canvas.getBoundingClientRect();
  const ratio = Math.max(1, Number(state._ownPipWindow?.devicePixelRatio) || 1);
  const width = Math.max(1, Math.floor(rect.width * ratio));
  const height = Math.max(1, Math.floor(rect.height * ratio));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const key = trackId(meta) || meta?.title || '';
  const heights = waveformCache.get(key) || DEFAULT_WAVE_HEIGHTS;
  const barWidth = Math.max(2, Math.round(2 * ratio));
  const gap = Math.max(2, Math.round(2 * ratio));
  const count = Math.max(1, Math.floor(width / (barWidth + gap)));
  const playedX = Math.max(0, Math.min(1, current / duration)) * width;

  ctx.clearRect(0, 0, width, height);
  for (let index = 0; index < count; index++) {
    const sourceIndex = Math.min(heights.length - 1, Math.floor(index / count * heights.length));
    const barHeight = Math.max(3 * ratio, (Number(heights[sourceIndex]) || 24) / 100 * height);
    const x = index * (barWidth + gap);
    ctx.fillStyle = x < playedX ? accent : 'rgba(255,255,255,.2)';
    ctx.fillRect(x, (height - barHeight) / 2, barWidth, barHeight);
  }
}

function ownPipQueueOrder() {
  const upcoming = state.queue.slice(state.pos);
  if (!upcoming.length) return [];
  const current = upcoming.shift();
  const pending = [];
  const seen = new Set();
  for (const ti of state.playNext) {
    if (ti === current || seen.has(ti) || !state.meta[ti]) continue;
    seen.add(ti);
    pending.push(ti);
    const duplicate = upcoming.indexOf(ti);
    if (duplicate !== -1) upcoming.splice(duplicate, 1);
  }
  return [current, ...pending, ...upcoming];
}

function renderOwnPipQueue(pipDocument, currentTi) {
  const list = pipDocument.getElementById('tss-pip-queue-list');
  const count = pipDocument.getElementById('tss-pip-queue-count');
  if (!list || !count) return;

  const queueView = pipDocument.getElementById('tss-pip-queue-view');
  const tab = queueView?.dataset.tab === 'history' ? 'history' : 'queue';
  const query = (pipDocument.getElementById('tss-pip-queue-search')?.value || '').trim().toLowerCase();
  const source = tab === 'history' ? [...state.history].reverse() : ownPipQueueOrder();
  const order = source.filter(ti => {
    const meta = state.meta[ti];
    return meta && (!query || String(meta.title || '').toLowerCase().includes(query) || String(meta.artist || '').toLowerCase().includes(query));
  });
  count.textContent = `${order.length} ${tab === 'history' ? 'played' : `track${order.length === 1 ? '' : 's'}`}`;
  const priorityKey = order.map(ti => state.priority[ti] ?? 1).join(',');
  const key = `${tab}|${query}|${currentTi}|${order.join(',')}|${priorityKey}|${state.roundPlayed}|${state.roundTotal}`;
  if (list.dataset.key === key) return;
  list.dataset.key = key;
  list.textContent = '';

  if (!order.length) {
    const empty = pipDocument.createElement('div');
    empty.className = 'tss-pip-queue-empty';
    empty.textContent = query ? 'No matching tracks' : tab === 'history' ? 'Nothing played yet' : 'Queue is empty';
    list.appendChild(empty);
    return;
  }

  order.forEach((ti, offset) => {
    const meta = state.meta[ti];
    if (!meta) return;
    const row = pipDocument.createElement('div');
    row.className = 'tss-pip-queue-row';
    row.dataset.current = ti === currentTi ? 'true' : 'false';
    row.setAttribute('role', 'listitem');
    row.style.setProperty('--row-index', String(Math.min(offset, 8)));

    const art = pipDocument.createElement('span');
    art.className = 'tss-pip-queue-art';
    if (meta.artwork) {
      const img = pipDocument.createElement('img');
      img.src = meta.artwork;
      img.alt = '';
      img.onerror = () => { img.remove(); art.innerHTML = SVG.note; };
      art.appendChild(img);
    } else {
      art.innerHTML = SVG.note;
    }

    const copy = pipDocument.createElement('span');
    copy.className = 'tss-pip-queue-copy';
    const title = pipDocument.createElement('span');
    title.className = 'tss-pip-queue-title';
    title.textContent = meta.title || '—';
    const artist = pipDocument.createElement('span');
    artist.className = 'tss-pip-queue-artist';
    artist.textContent = meta.artist || '—';
    copy.append(title, artist);

    const number = pipDocument.createElement('span');
    number.className = 'tss-pip-queue-number';
    number.textContent = tab === 'history'
      ? String(offset + 1)
      : String(Math.min(
        Math.max(1, state.roundTotal || state.queue.length),
        Math.max(1, state.roundPlayed + offset + 1),
      ));

    const settings = pipDocument.createElement('button');
    settings.type = 'button';
    settings.className = 'tss-pip-track-settings';
    settings.innerHTML = SVG.more;
    settings.setAttribute('aria-label', `Settings for ${meta.title || 'track'}`);
    settings.title = 'Track settings';
    settings.onclick = event => {
      event.stopPropagation();
      showOwnPipTrackMenu(pipDocument, settings, ti, currentTi);
    };

    row.append(art, copy, number, settings);
    if (ti !== currentTi) {
      row.dataset.playable = 'true';
      row.setAttribute('role', 'button');
      row.tabIndex = 0;
      row.setAttribute('aria-label', `Play ${meta.title}`);
      row.onclick = () => { void jumpTo(state.queue.indexOf(ti), ti); };
      row.onkeydown = event => {
        if (event.target !== row) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          void jumpTo(state.queue.indexOf(ti), ti);
        }
      };
    } else {
      row.setAttribute('aria-current', 'true');
    }
    list.appendChild(row);
  });
}

function showOwnPipTrackMenu(pipDocument, anchor, ti, currentTi) {
  pipDocument.getElementById('tss-pip-track-menu')?.remove();
  const meta = state.meta[ti] || {};
  const menu = pipDocument.createElement('div');
  menu.id = 'tss-pip-track-menu';
  menu.className = 'tss-pip-track-menu';
  menu.setAttribute('role', 'dialog');
  menu.setAttribute('aria-label', `Settings for ${meta.title || 'track'}`);

  const priority = state.priority[ti] ?? 1;
  const pendingNext = state.playNext.includes(ti);
  const queueIndex = state.queue.indexOf(ti);
  const removable = ti !== currentTi && (pendingNext || (queueIndex !== -1 && queueIndex !== state.pos));
  menu.innerHTML = `
    <div class="tss-pip-menu-title"><span>${esc(meta.title || 'Track settings')}</span><button type="button" aria-label="Close track settings">${SVG.close}</button></div>
    <div class="tss-pip-menu-actions">
      <button type="button" data-action="play"${ti === currentTi ? ' disabled' : ''}>Play now</button>
      <button type="button" data-action="next"${ti === currentTi ? ' disabled' : ''}>Play next</button>
    </div>
    <div class="tss-pip-menu-label">Shuffle priority</div>
    <div class="tss-pip-priority" role="group" aria-label="Shuffle priority">
      <button type="button" data-priority="0.25" aria-pressed="${priority <= 0.25}">Low</button>
      <button type="button" data-priority="1" aria-pressed="${priority > 0.25 && priority < 2}">Normal</button>
      <button type="button" data-priority="2" aria-pressed="${priority >= 2}">High</button>
    </div>
    <button type="button" class="tss-pip-menu-remove" data-action="remove"${removable ? '' : ' disabled'}>Remove from queue</button>
  `;

  pipDocument.getElementById('tss-pip-player')?.appendChild(menu);
  const playerRect = pipDocument.getElementById('tss-pip-player')?.getBoundingClientRect();
  const anchorRect = anchor.getBoundingClientRect();
  if (playerRect) {
    menu.style.top = `${Math.max(44, Math.min(playerRect.height - 190, anchorRect.top - playerRect.top - 8))}px`;
    menu.style.right = `${Math.max(10, playerRect.right - anchorRect.right)}px`;
  }

  const close = () => menu.remove();
  menu.querySelector('.tss-pip-menu-title button').onclick = close;
  menu.querySelector('[data-action="play"]').onclick = () => {
    close();
    void jumpTo(state.queue.indexOf(ti), ti);
  };
  menu.querySelector('[data-action="next"]').onclick = () => {
    queueNext(ti);
    close();
    renderOwnPipQueue(pipDocument, currentTi);
  };
  menu.querySelector('[data-action="remove"]').onclick = () => {
    removeTrackFromUpcoming(ti);
    close();
    renderOwnPipQueue(pipDocument, currentTi);
  };
  menu.querySelectorAll('[data-priority]').forEach(button => {
    button.onclick = () => {
      state.priority[ti] = Number(button.dataset.priority);
      menu.querySelectorAll('[data-priority]').forEach(option => option.setAttribute('aria-pressed', option === button ? 'true' : 'false'));
      const list = pipDocument.getElementById('tss-pip-queue-list');
      if (list) delete list.dataset.key;
    };
  });

  setTimeout(() => {
    const dismiss = event => {
      if (!menu.contains(event.target) && event.target !== anchor) {
        close();
        pipDocument.removeEventListener('pointerdown', dismiss, true);
      }
    };
    pipDocument.addEventListener('pointerdown', dismiss, true);
  }, 0);
}

function showOwnPipSoundMenu(pipDocument, anchor) {
  const existing = pipDocument.getElementById('tss-pip-sound-menu');
  if (existing) {
    existing.remove();
    anchor.dataset.active = 'false';
    anchor.setAttribute('aria-pressed', 'false');
    return;
  }
  pipDocument.getElementById('tss-pip-track-menu')?.remove();
  const menu = pipDocument.createElement('section');
  menu.id = 'tss-pip-sound-menu';
  menu.className = 'tss-pip-sound-menu';
  menu.setAttribute('role', 'dialog');
  menu.setAttribute('aria-label', 'Playback settings');
  const eqNames = [...Object.keys(EQ_PRESETS), ...Object.keys(state.customEqPresets || {})];
  menu.innerHTML = `
    <div class="tss-pip-sound-head"><div><span>Playback</span><small>Sound and timer</small></div><button type="button" aria-label="Close playback settings">${SVG.close}</button></div>
    <div class="tss-pip-setting-row tss-pip-volume-row">
      <button id="tss-pip-mute" class="tss-pip-mini-icon" type="button" aria-label="Mute">${SVG.volume}</button>
      <input id="tss-pip-volume" type="range" min="0" max="100" step="1" aria-label="Volume">
      <output id="tss-pip-volume-value">0%</output>
    </div>
    <div class="tss-pip-setting-block">
      <div class="tss-pip-setting-label"><span>Crossfade</span><output id="tss-pip-crossfade-readout">off</output></div>
      <input id="tss-pip-crossfade-slider" type="range" min="0" max="12" step="1" aria-label="Crossfade seconds">
      <div class="tss-pip-segments" role="group" aria-label="Crossfade curve">${['smooth','clean','dj'].map(curve => `<button type="button" data-curve="${curve}" aria-pressed="${state.crossfadeCurve === curve}">${curve}</button>`).join('')}</div>
    </div>
    <div class="tss-pip-setting-grid">
      <button id="tss-pip-auto-toggle" class="tss-pip-setting-toggle" type="button" aria-pressed="${state.autoLevel}"><span>Auto level</span><i></i></button>
      <button id="tss-pip-eq-toggle" class="tss-pip-setting-toggle" type="button" aria-pressed="${state.eqEnabled}"><span>Equalizer</span><i></i></button>
    </div>
    <label class="tss-pip-select-row"><span>EQ preset</span><select id="tss-pip-eq-preset">${eqNames.map(name => `<option value="${esc(name)}"${state.eqPreset === name ? ' selected' : ''}>${esc(name)}</option>`).join('')}</select></label>
    <div class="tss-pip-setting-grid">
      <label class="tss-pip-check-row"><input id="tss-pip-stop-round" type="checkbox"${state.stopAfterRound ? ' checked' : ''}><span>Stop after round</span></label>
      <label class="tss-pip-select-row tss-pip-sleep-row"><span>Sleep</span><select id="tss-pip-sleep"><option value="off">off</option><option value="t15">15 min</option><option value="t30">30 min</option><option value="t60">1 hour</option><option value="n5">5 tracks</option><option value="n10">10 tracks</option><option value="n25">25 tracks</option></select></label>
    </div>
    <button id="tss-pip-full-eq" class="tss-pip-full-eq" type="button">Open full equalizer</button>
  `;
  pipDocument.getElementById('tss-pip-player')?.appendChild(menu);
  anchor.dataset.active = 'true';
  anchor.setAttribute('aria-pressed', 'true');

  const close = () => {
    menu.remove();
    anchor.dataset.active = 'false';
    anchor.setAttribute('aria-pressed', 'false');
  };
  menu.querySelector('.tss-pip-sound-head button').onclick = close;
  const volume = menu.querySelector('#tss-pip-volume');
  const volumeValue = menu.querySelector('#tss-pip-volume-value');
  const syncVolume = () => {
    const percent = Math.round(state.playbackVolume * 100);
    volume.value = String(percent);
    volume.style.setProperty('--fill', `${percent}%`);
    volumeValue.textContent = `${percent}%`;
  };
  syncVolume();
  volume.oninput = () => { setPlaybackVolume(Number(volume.value) / 100); syncVolume(); };
  menu.querySelector('#tss-pip-mute').onclick = event => {
    if (state.playbackVolume > 0) {
      event.currentTarget.dataset.previous = String(state.playbackVolume);
      setPlaybackVolume(0);
    } else {
      setPlaybackVolume(Math.max(0.01, Number(event.currentTarget.dataset.previous) || 0.1));
    }
    syncVolume();
  };

  const crossfade = menu.querySelector('#tss-pip-crossfade-slider');
  const crossfadeReadout = menu.querySelector('#tss-pip-crossfade-readout');
  const syncCrossfade = () => {
    crossfade.value = String(state.crossfadeSeconds);
    crossfade.style.setProperty('--fill', `${state.crossfadeSeconds / 12 * 100}%`);
    crossfadeReadout.textContent = state.crossfadeSeconds > 0 ? `${state.crossfadeSeconds}s` : 'off';
  };
  syncCrossfade();
  crossfade.oninput = () => { setCrossfadeSeconds(crossfade.value); syncCrossfade(); };
  menu.querySelectorAll('[data-curve]').forEach(button => {
    button.onclick = () => {
      state.crossfadeCurve = button.dataset.curve;
      localStorage.setItem('tss_crossfade_curve', state.crossfadeCurve);
      menu.querySelectorAll('[data-curve]').forEach(option => option.setAttribute('aria-pressed', option === button ? 'true' : 'false'));
      syncCrossfadeControls();
    };
  });

  const auto = menu.querySelector('#tss-pip-auto-toggle');
  auto.onclick = () => { setAutoLevelEnabled(!state.autoLevel); auto.setAttribute('aria-pressed', String(state.autoLevel)); };
  const eqToggle = menu.querySelector('#tss-pip-eq-toggle');
  eqToggle.onclick = () => {
    if (!state.eqEnabled && !ensureAutoLevelAudioGraph()) return;
    state.eqEnabled = !state.eqEnabled;
    persistEqualizer({ immediate: true });
    syncEqualizer();
    eqToggle.setAttribute('aria-pressed', String(state.eqEnabled));
  };
  const eqPreset = menu.querySelector('#tss-pip-eq-preset');
  eqPreset.onchange = () => {
    const values = EQ_PRESETS[eqPreset.value] || state.customEqPresets[eqPreset.value];
    if (!Array.isArray(values) || !ensureAutoLevelAudioGraph()) return;
    state.eqBands = values.slice(0, 5).map(value => Math.max(-12, Math.min(12, Number(value) || 0)));
    state.eqPreset = eqPreset.value;
    state.eqEnabled = true;
    persistEqualizer({ immediate: true });
    syncEqualizer();
    eqToggle.setAttribute('aria-pressed', 'true');
  };
  menu.querySelector('#tss-pip-stop-round').onchange = event => { state.stopAfterRound = event.target.checked; };
  const sleep = menu.querySelector('#tss-pip-sleep');
  sleep.value = sleepTimerValue();
  sleep.onchange = () => setSleepTimer(sleep.value);
  menu.querySelector('#tss-pip-full-eq').onclick = () => {
    try { pageWindow.focus(); } catch (_) {}
    showEqualizer();
  };
}

function soundCloudLikeButtonState(button) {
  if (!button) return null;
  const label = `${button.getAttribute('aria-label') || ''} ${button.getAttribute('title') || ''}`.trim();
  return button.classList.contains('sc-button-selected') || /\bunlike\b/i.test(label);
}

function findSoundCloudLikeButton(ti) {
  const meta = state.meta[ti];
  const wanted = normalizeTrackUrl(meta?.link);
  if (!wanted) return null;

  const bound = state.els[ti];
  if (bound && document.body.contains(bound)) {
    const button = bound.querySelector('.sc-button-like');
    if (button) return button;
  }

  const playerLink = document.querySelector('.playbackSoundBadge__titleLink');
  if (playerLink && normalizeTrackUrl(playerLink.href) === wanted) {
    const button = playerLink.closest('.playbackSoundBadge')?.querySelector('.playbackSoundBadge__like, .sc-button-like');
    if (button) return button;
  }

  if (normalizeTrackUrl(location.href) === wanted) {
    const button = document.querySelector('.listenEngagement__actions .sc-button-like, .soundActions .sc-button-like');
    if (button) return button;
  }

  for (const link of document.querySelectorAll('a[href]')) {
    if (normalizeTrackUrl(link.href) !== wanted) continue;
    const root = link.closest('.trackList__item, .soundList__item, li.sc-list-item, .sound');
    const button = root?.querySelector('.sc-button-like');
    if (button) return button;
  }
  return null;
}

function currentTrackLikeState(ti, force = false) {
  const now = Date.now();
  const meta = state.meta[ti];
  if (!meta) return { liked: false, available: false };
  if (!force && state._likeStateTrack === ti && now - state._likeStateLastCheck < 1000) {
    return { liked: meta.liked === true, available: meta.likeAvailable === true };
  }

  const button = findSoundCloudLikeButton(ti);
  state._likeStateTrack = ti;
  state._likeStateLastCheck = now;
  meta.likeAvailable = Boolean(button);
  if (button) meta.liked = soundCloudLikeButtonState(button);
  return { liked: meta.liked === true, available: Boolean(button) };
}

async function toggleCurrentTrackLike() {
  if (state._likeBusy) return false;
  const ti = Number.isInteger(state._deckTrack) ? state._deckTrack : state.queue[state.pos];
  const meta = state.meta[ti];
  const button = findSoundCloudLikeButton(ti);
  if (!meta || !button) {
    showMergeToast('like unavailable until this track is visible on SoundCloud');
    currentTrackLikeState(ti, true);
    syncOwnPipWindow();
    return false;
  }

  state._likeBusy = true;
  const before = soundCloudLikeButtonState(button);
  meta.likeAvailable = true;
  meta.liked = !before;
  syncOwnPipWindow();
  try {
    button.click();
    for (const delay of [120, 380, 800]) {
      await wait(delay);
      const currentButton = findSoundCloudLikeButton(ti);
      if (!currentButton) continue;
      const actual = soundCloudLikeButtonState(currentButton);
      meta.liked = actual;
      if (actual !== before) break;
    }
    return meta.liked !== before;
  } finally {
    state._likeBusy = false;
    state._likeStateLastCheck = 0;
    currentTrackLikeState(ti, true);
    syncOwnPipWindow();
  }
}

function ownPipWindowTitle(meta, isPaused) {
  return meta?.title && !isPaused ? `Playing: ${meta.title}` : 'True Shuffle';
}

function syncOwnPipWindow() {
  if (state._ownPipMode === 'video') {
    if (!ownPipIsOpen()) {
      if (state._videoPip) closeOwnPip();
      return false;
    }
    drawVideoPipFrame(state._videoPip?.canvas);
    return true;
  }
  if (!ownPipIsOpen()) {
    if (state._ownPipWindow) closeOwnPip();
    return false;
  }

  const pipWindow = state._ownPipWindow;
  const pipDocument = pipWindow.document;
  if (!pipDocument?.getElementById('tss-pip-player')) return false;

  const currentTi = Number.isInteger(state._deckTrack) ? state._deckTrack : state.queue[state.pos];
  const meta = state.meta[currentTi];
  const queuedNext = upcomingTrackIndex();
  const nextMeta = queuedNext !== undefined ? state.meta[queuedNext] : null;
  const timing = playbackTiming();
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--tss-a').trim() || '#ff5500';
  const total = Math.max(1, state.roundTotal || state.queue.length);
  const inRound = Math.min(total, Math.max(1, state.roundPlayed + 1));

  pipDocument.title = ownPipWindowTitle(meta, paused());
  pipDocument.documentElement.style.setProperty('--accent', accent);
  const title = pipDocument.getElementById('tss-pip-title');
  const artist = pipDocument.getElementById('tss-pip-artist');
  const position = pipDocument.getElementById('tss-pip-position');
  const currentTime = pipDocument.getElementById('tss-pip-current');
  const remaining = pipDocument.getElementById('tss-pip-remaining');
  if (title) title.textContent = meta?.title || playerTitle() || '—';
  if (artist) artist.textContent = meta?.artist || '—';
  if (position) position.textContent = `${inRound} / ${total}`;
  if (currentTime) currentTime.textContent = formatPlaybackClock(timing.current);
  if (remaining) remaining.textContent = `-${formatPlaybackClock(Math.max(0, timing.duration - timing.current))}`;

  const artwork = pipDocument.getElementById('tss-pip-artwork');
  const artworkFallback = pipDocument.getElementById('tss-pip-artwork-fallback');
  if (artwork && artwork.dataset.src !== (meta?.artwork || '')) {
    artwork.dataset.src = meta?.artwork || '';
    artwork.src = meta?.artwork || '';
    artwork.hidden = !meta?.artwork;
    if (artworkFallback) artworkFallback.hidden = Boolean(meta?.artwork);
  }

  const play = pipDocument.getElementById('tss-pip-play');
  if (play) {
    play.innerHTML = paused() ? SVG.play : SVG.pause;
    play.setAttribute('aria-label', paused() ? 'Play' : 'Pause');
  }

  const like = pipDocument.getElementById('tss-pip-like');
  if (like) {
    const likeState = currentTrackLikeState(currentTi);
    like.innerHTML = likeState.liked ? SVG.heartFilled : SVG.heart;
    like.dataset.liked = likeState.liked ? 'true' : 'false';
    like.dataset.available = likeState.available ? 'true' : 'false';
    like.disabled = state._likeBusy || !likeState.available;
    like.setAttribute('aria-pressed', likeState.liked ? 'true' : 'false');
    like.setAttribute('aria-label', likeState.liked ? 'Unlike current track' : 'Like current track');
    like.title = likeState.available
      ? (likeState.liked ? 'Unlike on SoundCloud' : 'Like on SoundCloud')
      : 'Like is available when the track is visible on SoundCloud';
  }

  const nextRow = pipDocument.getElementById('tss-pip-up-next-row');
  const nextTitle = pipDocument.getElementById('tss-pip-next-title');
  const nextArtist = pipDocument.getElementById('tss-pip-next-artist');
  const nextNumber = pipDocument.getElementById('tss-pip-next-number');
  const nextArtwork = pipDocument.getElementById('tss-pip-next-artwork');
  const nextFallback = pipDocument.getElementById('tss-pip-next-fallback');
  const nextSettings = pipDocument.getElementById('tss-pip-next-settings');
  if (nextRow) nextRow.dataset.empty = nextMeta ? 'false' : 'true';
  if (nextTitle) nextTitle.textContent = nextMeta?.title || (state.stopAfterRound ? 'End of round' : 'Fresh shuffle');
  if (nextArtist) nextArtist.textContent = nextMeta?.artist || (state.stopAfterRound ? 'Playback will stop' : 'A new round will begin');
  if (nextNumber) nextNumber.textContent = nextMeta ? String(Math.min(total, inRound + 1)) : '—';
  if (nextArtwork && nextArtwork.dataset.src !== (nextMeta?.artwork || '')) {
    nextArtwork.dataset.src = nextMeta?.artwork || '';
    nextArtwork.src = nextMeta?.artwork || '';
    nextArtwork.hidden = !nextMeta?.artwork;
    if (nextFallback) nextFallback.hidden = Boolean(nextMeta?.artwork);
  }
  if (nextSettings) {
    nextSettings.disabled = queuedNext === undefined;
    nextSettings.dataset.ti = queuedNext === undefined ? '' : String(queuedNext);
    nextSettings.setAttribute('aria-label', `Settings for ${nextMeta?.title || 'up next'}`);
  }

  const crossfade = pipDocument.getElementById('tss-pip-crossfade');
  const crossfadeValue = pipDocument.getElementById('tss-pip-crossfade-value');
  const autoLevel = pipDocument.getElementById('tss-pip-auto-level');
  const processing = pipDocument.getElementById('tss-pip-processing');
  const pipState = pipDocument.getElementById('tss-pip-state');
  if (crossfade) {
    crossfade.dataset.active = state.crossfadeSeconds > 0 ? 'true' : 'false';
    crossfade.hidden = state.crossfadeSeconds <= 0;
  }
  if (crossfadeValue) crossfadeValue.textContent = `${state.crossfadeSeconds}s fade`;
  if (autoLevel) {
    autoLevel.dataset.active = state.autoLevel ? 'true' : 'false';
    autoLevel.hidden = !state.autoLevel;
  }
  if (processing) processing.hidden = state.crossfadeSeconds <= 0 && !state.autoLevel;
  if (pipState) {
    const status = state.suspended ? 'external playback'
      : state.loading ? 'loading'
      : state._crossfading ? 'mixing'
      : state.busy ? 'switching'
      : state.crossfadeStatus === 'loading' ? 'loading next'
      : state.crossfadeStatus === 'fallback' ? 'fallback'
      : '';
    pipState.textContent = status;
    pipState.hidden = !status;
  }

  renderOwnPipQueue(pipDocument, currentTi);

  drawOwnPipWaveform(
    pipDocument.getElementById('tss-pip-waveform'),
    meta,
    Math.max(0, timing.current),
    Math.max(0, timing.duration),
    accent,
  );
  return true;
}

function drawVideoPipFrame(canvas) {
  const ctx = canvas?.getContext?.('2d');
  if (!ctx) return;
  const width = canvas.width;
  const height = canvas.height;
  const currentTi = Number.isInteger(state._deckTrack) ? state._deckTrack : state.queue[state.pos];
  const meta = state.meta[currentTi] || {};
  const nextTi = upcomingTrackIndex();
  const nextMeta = state.meta[nextTi] || {};
  const timing = playbackTiming();
  const duration = Math.max(1, timing.duration || 1);
  const ratio = Math.max(0, Math.min(1, timing.current / duration));
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--tss-a').trim() || '#ff5500';
  const key = trackId(meta) || meta.title || '';
  const heights = waveformCache.get(key) || DEFAULT_WAVE_HEIGHTS;

  ctx.fillStyle = '#080808';
  ctx.fillRect(0, 0, width, height);
  const glow = ctx.createRadialGradient(width * .2, 0, 0, width * .2, 0, width * .72);
  glow.addColorStop(0, `${accent}32`);
  glow.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = accent;
  ctx.fillRect(34, 31, 5, 24);
  ctx.fillStyle = 'rgba(255,255,255,.92)';
  ctx.font = '700 17px system-ui, sans-serif';
  ctx.fillText('TRUE SHUFFLE', 53, 50);
  ctx.fillStyle = 'rgba(255,255,255,.96)';
  ctx.font = '700 31px system-ui, sans-serif';
  ctx.fillText(String(meta.title || playerTitle() || 'Now playing').slice(0, 33), 34, 121);
  ctx.fillStyle = 'rgba(255,255,255,.5)';
  ctx.font = '500 18px system-ui, sans-serif';
  ctx.fillText(String(meta.artist || '').slice(0, 42), 35, 151);

  const waveX = 35, waveY = 187, waveW = width - 70, waveH = 62;
  const count = 96, gap = 3, barW = Math.max(2, (waveW - gap * (count - 1)) / count);
  for (let i = 0; i < count; i++) {
    const source = Math.min(heights.length - 1, Math.floor(i / count * heights.length));
    const barH = Math.max(4, (Number(heights[source]) || 24) / 100 * waveH);
    ctx.fillStyle = i / count <= ratio ? accent : 'rgba(255,255,255,.22)';
    ctx.fillRect(waveX + i * (barW + gap), waveY + waveH - barH, barW, barH);
  }
  ctx.fillStyle = 'rgba(255,255,255,.48)';
  ctx.font = '500 15px system-ui, sans-serif';
  ctx.fillText(formatPlaybackClock(timing.current), waveX, 272);
  const remaining = `-${formatPlaybackClock(Math.max(0, duration - timing.current))}`;
  ctx.fillText(remaining, width - 35 - ctx.measureText(remaining).width, 272);

  ctx.fillStyle = 'rgba(255,255,255,.28)';
  ctx.font = '700 13px system-ui, sans-serif';
  ctx.fillText('UP NEXT', 35, 316);
  ctx.fillStyle = 'rgba(255,255,255,.78)';
  ctx.font = '600 16px system-ui, sans-serif';
  ctx.fillText(String(nextMeta.title || (state.stopAfterRound ? 'End of round' : 'Fresh shuffle')).slice(0, 46), 119, 316);
}

async function openVideoPipFallback() {
  if (!standardVideoPipSupported() || typeof document.createElement('canvas').captureStream !== 'function') return false;
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 360;
  canvas.style.cssText = 'position:fixed;width:1px;height:1px;left:-9999px;top:-9999px;pointer-events:none';
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.style.cssText = canvas.style.cssText;
  document.body.append(canvas, video);
  const stream = canvas.captureStream(8);
  video.srcObject = stream;
  drawVideoPipFrame(canvas);
  try {
    await video.play();
  } catch (error) {
    try { stream.getTracks().forEach(track => track.stop()); } catch (_) {}
    video.remove();
    canvas.remove();
    throw error;
  }

  let syncing = true;
  const syncVideoState = () => {
    syncing = true;
    const shouldPause = paused();
    if (shouldPause && !video.paused) video.pause();
    else if (!shouldPause && video.paused) void video.play().catch(() => {});
    queueMicrotask(() => { syncing = false; });
  };
  video.addEventListener('pause', () => {
    if (!syncing && !paused()) pause();
  });
  video.addEventListener('play', () => {
    if (!syncing && paused()) void toggle();
  });

  try {
    if (typeof video.requestPictureInPicture === 'function') await video.requestPictureInPicture();
    else if (typeof video.webkitSetPresentationMode === 'function') video.webkitSetPresentationMode('picture-in-picture');
    else throw new Error('Video PiP unavailable');
  } catch (error) {
    try { stream.getTracks().forEach(track => track.stop()); } catch (_) {}
    video.remove();
    canvas.remove();
    throw error;
  }

  const timer = setInterval(() => {
    drawVideoPipFrame(canvas);
    syncVideoState();
  }, 250);
  state._ownPipMode = 'video';
  state._videoPip = { video, canvas, stream, timer };
  const cleanup = () => {
    if (state._videoPip?.video !== video) return;
    clearInterval(timer);
    try { stream.getTracks().forEach(track => track.stop()); } catch (_) {}
    video.remove();
    canvas.remove();
    state._videoPip = null;
    state._ownPipMode = null;
    setOwnPipButtonState();
  };
  video.addEventListener('leavepictureinpicture', cleanup, { once: true });
  video.addEventListener('webkitpresentationmodechanged', () => {
    if (video.webkitPresentationMode !== 'picture-in-picture') cleanup();
  });
  showMergeToast('using native video PiP fallback');
  setOwnPipButtonState();
  return true;
}

function openInPagePipFallback() {
  const host = document.createElement('div');
  host.id = 'tss-inline-pip';
  host.setAttribute('role', 'dialog');
  host.setAttribute('aria-label', 'True Shuffle floating player');
  host.style.cssText = 'position:fixed;right:20px;bottom:90px;width:390px;height:330px;min-width:330px;min-height:280px;max-width:min(92vw,680px);max-height:min(86vh,720px);z-index:999999;resize:both;overflow:hidden;border-radius:14px;box-shadow:0 24px 80px rgba(0,0,0,.72);background:#080808';
  const iframe = document.createElement('iframe');
  iframe.title = 'True Shuffle floating player';
  iframe.style.cssText = 'display:block;width:100%;height:100%;border:0;background:#080808';
  host.appendChild(iframe);
  document.body.appendChild(host);
  state._ownPipHost = host;
  state._ownPipMode = 'inline';
  try {
    mountOwnPipWindow(iframe.contentWindow, 'inline');
  } catch (error) {
    host.remove();
    state._ownPipHost = null;
    state._ownPipWindow = null;
    state._ownPipMode = null;
    throw error;
  }

  const header = iframe.contentDocument?.querySelector('.tss-pip-header');
  if (header) {
    header.style.cursor = 'grab';
    header.addEventListener('pointerdown', event => {
      if (event.target.closest('button')) return;
      event.preventDefault();
      const rect = host.getBoundingClientRect();
      const startX = event.screenX;
      const startY = event.screenY;
      const startLeft = rect.left;
      const startTop = rect.top;
      header.style.cursor = 'grabbing';
      const move = moveEvent => {
        const left = Math.max(0, Math.min(innerWidth - host.offsetWidth, startLeft + moveEvent.screenX - startX));
        const top = Math.max(0, Math.min(innerHeight - host.offsetHeight, startTop + moveEvent.screenY - startY));
        host.style.left = `${left}px`;
        host.style.top = `${top}px`;
        host.style.right = 'auto';
        host.style.bottom = 'auto';
      };
      const up = () => {
        header.style.cursor = 'grab';
        iframe.contentDocument.removeEventListener('pointermove', move);
        iframe.contentDocument.removeEventListener('pointerup', up);
        iframe.contentDocument.removeEventListener('pointercancel', up);
      };
      iframe.contentDocument.addEventListener('pointermove', move);
      iframe.contentDocument.addEventListener('pointerup', up);
      iframe.contentDocument.addEventListener('pointercancel', up);
    });
  }
  showMergeToast('using floating player fallback');
  return true;
}

async function openOwnPip() {
  if (!state.active) {
    showMergeToast('start True Shuffle before opening PiP');
    return false;
  }
  if (ownPipIsOpen()) {
    try { state._ownPipWindow?.focus?.(); } catch (_) {}
    return true;
  }

  const documentPip = documentPipApi();
  if (documentPip) {
    let pipWindow = null;
    try {
      pipWindow = await documentPip.requestWindow({ width: 390, height: 330 });
      return mountOwnPipWindow(pipWindow, 'document');
    } catch (error) {
      console.warn('[True Shuffle] Document PiP failed; trying fallback.', error);
      try { pipWindow?.close?.(); } catch (_) {}
      state._ownPipWindow = null;
      state._ownPipMode = null;
    }
  }
  if (standardVideoPipSupported()) {
    try {
      if (await openVideoPipFallback()) return true;
    } catch (_) {}
  }
  return openInPagePipFallback();
}

function mountOwnPipWindow(pipWindow, mode = 'document') {
  state._ownPipWindow = pipWindow;
  state._ownPipMode = mode;
  const pipDocument = pipWindow.document;
  pipDocument.title = 'True Shuffle';
  const style = pipDocument.createElement('style');
  style.textContent = `
    :root{color-scheme:dark;--accent:#ff5500;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
    *{box-sizing:border-box}
    html,body{width:100%;height:100%;margin:0;overflow:hidden;background:#080808;color:#f4f4f4}
    button{font:inherit}
    #tss-pip-player{height:100%;min-height:300px;padding:12px 14px;display:flex;flex-direction:column;position:relative;overflow:hidden;background:radial-gradient(circle at 50% -12%,rgba(255,255,255,.045),transparent 42%),#080808;border:1px solid rgba(255,255,255,.14)}
    .tss-pip-header{height:31px;display:flex;align-items:center;gap:9px;flex:0 0 auto}
    .tss-pip-brandmark,.tss-pip-close{display:flex;align-items:center;justify-content:center;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.035);color:#fff;cursor:pointer}
    .tss-pip-brandmark{width:30px;height:30px;border-radius:8px;color:var(--accent)}
    .tss-pip-brandmark svg{width:13px!important;height:13px!important}
    .tss-pip-brand{margin-right:auto;font-size:10px;font-weight:780;letter-spacing:.16em;text-transform:uppercase;white-space:nowrap}
    .tss-pip-state{max-width:78px;overflow:hidden;color:rgba(255,255,255,.3);font-size:8px;font-weight:620;white-space:nowrap;text-overflow:ellipsis}.tss-pip-state[hidden]{display:none}
    .tss-pip-live{display:flex;align-items:center;gap:6px;color:var(--accent);font-size:9px;font-weight:760;letter-spacing:.08em;text-transform:uppercase}
    .tss-pip-live svg{width:13px!important;height:13px!important}
    .tss-pip-view-toggle{width:29px;height:29px;padding:0;display:flex;align-items:center;justify-content:center;border:0;border-radius:8px;background:transparent;color:rgba(255,255,255,.52);cursor:pointer}
    .tss-pip-view-toggle:hover,.tss-pip-view-toggle[data-active="true"]{color:var(--accent);background:rgba(255,255,255,.06)}
    .tss-pip-view-toggle[data-liked="true"]{color:var(--accent);background:color-mix(in srgb,var(--accent),transparent 88%)}
    .tss-pip-view-toggle[data-liked="true"]:hover{background:color-mix(in srgb,var(--accent),transparent 82%)}
    .tss-pip-view-toggle:disabled{opacity:.3;cursor:not-allowed;background:transparent}
    .tss-pip-view-toggle svg{width:13px!important;height:13px!important}
    .tss-pip-close{width:29px;height:29px;border:0;border-radius:8px;background:transparent;color:rgba(255,255,255,.58)}
    .tss-pip-close:hover{color:#fff;background:rgba(255,255,255,.07)}
    .tss-pip-stage{flex:1;min-height:0;position:relative;margin-top:10px}
    .tss-pip-view{position:absolute;inset:0;min-height:0;transition:transform .24s cubic-bezier(.22,1,.36,1),opacity .18s ease;will-change:transform,opacity}
    #tss-pip-now-view{display:flex;flex-direction:column;transform:translateX(0);opacity:1}
    #tss-pip-queue-view{display:flex;flex-direction:column;transform:translateX(34px);opacity:0;pointer-events:none}
    .tss-pip-stage[data-view="queue"] #tss-pip-now-view{transform:translateX(-34px);opacity:0;pointer-events:none}
    .tss-pip-stage[data-view="queue"] #tss-pip-queue-view{transform:translateX(0);opacity:1;pointer-events:auto}
    .tss-pip-track{display:grid;grid-template-columns:76px minmax(0,1fr);align-items:center;gap:13px;min-height:76px}
    .tss-pip-art{width:76px;height:76px;border-radius:12px;overflow:hidden;position:relative;background:#151515;box-shadow:0 9px 24px rgba(0,0,0,.46),0 0 0 1px rgba(255,255,255,.08)}
    .tss-pip-art img{display:block;width:100%;height:100%;object-fit:cover}
    .tss-pip-art-fallback{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:rgba(255,255,255,.26)}
    .tss-pip-art-fallback[hidden],.tss-pip-art img[hidden]{display:none}
    .tss-pip-title{font-size:17px;line-height:1.15;font-weight:720;letter-spacing:-.025em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .tss-pip-artist{margin-top:4px;color:rgba(255,255,255,.48);font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .tss-pip-track-meta{display:flex;align-items:center;gap:8px;margin-top:7px;min-width:0}.tss-pip-position{color:rgba(255,255,255,.68);font-size:9px;font-weight:620;letter-spacing:.08em;white-space:nowrap}
    .tss-pip-processing{display:flex;align-items:center;gap:5px;min-width:0;color:rgba(255,255,255,.27);font-size:8px;font-weight:560;white-space:nowrap}.tss-pip-processing[hidden],.tss-pip-processing span[hidden]{display:none}.tss-pip-processing::before{content:'·';color:rgba(255,255,255,.18)}.tss-pip-processing span+span::before{content:'·';margin-right:5px;color:rgba(255,255,255,.18)}
    .tss-pip-wave{margin-top:11px}
    #tss-pip-waveform{display:block;width:100%;height:28px;cursor:pointer}
    .tss-pip-times{display:flex;justify-content:space-between;margin-top:3px;color:rgba(255,255,255,.47);font-size:8px;font-variant-numeric:tabular-nums}
    .tss-pip-controls{display:flex;align-items:center;justify-content:center;gap:22px;margin:9px 0 11px}
    .tss-pip-control{display:flex;align-items:center;justify-content:center;width:39px;height:39px;padding:0;border:1px solid rgba(255,255,255,.08);border-radius:50%;background:#1a1a1a;color:rgba(255,255,255,.82);cursor:pointer;transition:transform .14s,background .14s,color .14s}
    .tss-pip-control:hover{transform:translateY(-1px);background:#222;color:#fff}
    .tss-pip-control:active{transform:scale(.96)}
    .tss-pip-control-primary{width:52px;height:52px;background:var(--accent);border-color:color-mix(in srgb,var(--accent),white 18%);color:#fff;box-shadow:0 8px 21px color-mix(in srgb,var(--accent),transparent 72%)}
    .tss-pip-control-primary:hover{background:color-mix(in srgb,var(--accent),white 8%)}
    .tss-pip-control svg{width:15px!important;height:15px!important}
    .tss-pip-control-primary svg{width:17px!important;height:17px!important}
    .tss-pip-up-next{border-top:1px solid rgba(255,255,255,.08);padding-top:9px}
    .tss-pip-kicker{font-size:9px;font-weight:790;letter-spacing:.16em;text-transform:uppercase;color:rgba(255,255,255,.82)}
    .tss-pip-next-row{display:grid;grid-template-columns:39px minmax(0,1fr) auto 28px;align-items:center;gap:9px;margin-top:7px;min-height:39px}
    .tss-pip-next-art{width:39px;height:39px;border-radius:7px;overflow:hidden;position:relative;background:#151515;box-shadow:0 0 0 1px rgba(255,255,255,.07)}
    .tss-pip-next-art img{display:block;width:100%;height:100%;object-fit:cover}
    .tss-pip-next-art img[hidden],.tss-pip-next-art .tss-pip-art-fallback[hidden]{display:none}
    .tss-pip-next-title{font-size:11px;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .tss-pip-next-artist{margin-top:4px;color:rgba(255,255,255,.38);font-size:9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .tss-pip-next-number{color:rgba(255,255,255,.48);font-size:11px;font-variant-numeric:tabular-nums}
    button:focus-visible,#tss-pip-waveform:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
    .tss-pip-queue-head{display:flex;align-items:center;justify-content:space-between;padding:7px 1px 6px;border-top:1px solid rgba(255,255,255,.08)}
    .tss-pip-queue-count{color:rgba(255,255,255,.34);font-size:9px;font-variant-numeric:tabular-nums}
    .tss-pip-queue-tools{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;gap:8px;padding-bottom:7px;border-bottom:1px solid rgba(255,255,255,.06)}
    .tss-pip-tabs{display:flex;align-items:center;padding:2px;border-radius:7px;background:rgba(255,255,255,.035)}.tss-pip-tab{height:25px;padding:0 8px;border:0;border-radius:5px;background:transparent;color:rgba(255,255,255,.32);font-size:8px;font-weight:720;letter-spacing:.07em;text-transform:uppercase;cursor:pointer}.tss-pip-tab[aria-selected="true"]{background:rgba(255,255,255,.08);color:#fff}
    .tss-pip-search-wrap{position:relative;min-width:0}.tss-pip-search-wrap svg{position:absolute;left:8px;top:50%;width:10px!important;height:10px!important;transform:translateY(-50%);color:rgba(255,255,255,.25);pointer-events:none}.tss-pip-queue-search{width:100%;height:29px;padding:0 9px 0 25px;border:1px solid rgba(255,255,255,.08);border-radius:7px;background:rgba(255,255,255,.025);color:#fff;font:500 9px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;outline:0}.tss-pip-queue-search::placeholder{color:rgba(255,255,255,.22)}.tss-pip-queue-search:focus{border-color:color-mix(in srgb,var(--accent),transparent 35%)}
    .tss-pip-queue-list{min-height:0;overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.18) transparent}
    .tss-pip-queue-list::-webkit-scrollbar{width:5px}.tss-pip-queue-list::-webkit-scrollbar-track{background:transparent}.tss-pip-queue-list::-webkit-scrollbar-thumb{background:rgba(255,255,255,.16);border-radius:9px}
    .tss-pip-queue-row{width:100%;min-height:49px;padding:5px 3px 5px 6px;display:grid;grid-template-columns:36px minmax(0,1fr) auto 28px;align-items:center;gap:8px;border:0;border-bottom:1px solid rgba(255,255,255,.055);background:transparent;color:#fff;text-align:left;transition:background .14s,opacity .18s,transform .22s cubic-bezier(.22,1,.36,1)}
    .tss-pip-queue-row[data-playable="true"]{cursor:pointer}
    .tss-pip-queue-row:hover{background:rgba(255,255,255,.045)}
    .tss-pip-queue-row[data-current="true"]{background:color-mix(in srgb,var(--accent),transparent 92%);box-shadow:inset 2px 0 var(--accent);cursor:default}
    .tss-pip-queue-art{width:36px;height:36px;border-radius:7px;overflow:hidden;background:#151515;display:flex;align-items:center;justify-content:center;color:rgba(255,255,255,.24)}
    .tss-pip-queue-art img{display:block;width:100%;height:100%;object-fit:cover}
    .tss-pip-queue-copy{display:block;min-width:0}.tss-pip-queue-title{display:block;font-size:10px;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.tss-pip-queue-artist{display:block;margin-top:3px;color:rgba(255,255,255,.35);font-size:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .tss-pip-queue-number{color:rgba(255,255,255,.34);font-size:9px;font-variant-numeric:tabular-nums}
    .tss-pip-queue-row[data-current="true"] .tss-pip-queue-number{color:var(--accent)}
    .tss-pip-queue-empty{padding:34px 12px;text-align:center;color:rgba(255,255,255,.25);font-size:10px}
    .tss-pip-track-settings{width:28px;height:28px;padding:0;display:flex;align-items:center;justify-content:center;border:0;border-radius:7px;background:transparent;color:rgba(255,255,255,.35);cursor:pointer}
    .tss-pip-track-settings:hover,.tss-pip-track-settings[aria-expanded="true"]{background:rgba(255,255,255,.07);color:#fff}.tss-pip-track-settings:disabled{opacity:.22;cursor:default;background:transparent;color:rgba(255,255,255,.25)}
    .tss-pip-track-menu{position:absolute;z-index:20;width:210px;padding:9px;border:1px solid rgba(255,255,255,.13);border-radius:12px;background:rgba(19,19,19,.97);box-shadow:0 18px 45px rgba(0,0,0,.65);backdrop-filter:blur(18px);animation:tssPipMenuIn .16s cubic-bezier(.22,1,.36,1)}
    .tss-pip-menu-title{display:flex;align-items:center;gap:8px;padding:2px 2px 9px;color:rgba(255,255,255,.78);font-size:10px;font-weight:680;border-bottom:1px solid rgba(255,255,255,.07)}
    .tss-pip-menu-title span{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.tss-pip-menu-title button{width:24px;height:24px;padding:0;display:flex;align-items:center;justify-content:center;border:0;border-radius:6px;background:transparent;color:rgba(255,255,255,.42);cursor:pointer}.tss-pip-menu-title button:hover{background:rgba(255,255,255,.07);color:#fff}
    .tss-pip-menu-actions{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:8px}.tss-pip-menu-actions button,.tss-pip-menu-remove{height:30px;border:1px solid rgba(255,255,255,.09);border-radius:7px;background:rgba(255,255,255,.045);color:rgba(255,255,255,.78);font-size:9px;font-weight:650;cursor:pointer}.tss-pip-menu-actions button:hover{border-color:color-mix(in srgb,var(--accent),transparent 45%);color:#fff}.tss-pip-menu-actions button:disabled,.tss-pip-menu-remove:disabled{opacity:.28;cursor:default}
    .tss-pip-menu-label{margin:10px 2px 6px;color:rgba(255,255,255,.34);font-size:8px;font-weight:720;letter-spacing:.1em;text-transform:uppercase}.tss-pip-priority{display:grid;grid-template-columns:repeat(3,1fr);padding:2px;border-radius:8px;background:rgba(255,255,255,.04)}.tss-pip-priority button{height:27px;border:0;border-radius:6px;background:transparent;color:rgba(255,255,255,.35);font-size:8px;font-weight:700;cursor:pointer}.tss-pip-priority button[aria-pressed="true"]{background:var(--accent);color:#fff;box-shadow:0 3px 10px color-mix(in srgb,var(--accent),transparent 68%)}
    .tss-pip-menu-remove{width:100%;margin-top:8px;background:rgba(255,74,74,.055);border-color:rgba(255,74,74,.12);color:#d87878}.tss-pip-menu-remove:not(:disabled):hover{background:rgba(255,74,74,.11);color:#ff9292}
    .tss-pip-sound-menu{position:absolute;z-index:19;inset:48px 12px 12px;padding:12px;overflow-y:auto;overscroll-behavior:contain;border:1px solid rgba(255,255,255,.13);border-radius:13px;background:rgba(14,14,14,.985);box-shadow:0 20px 55px rgba(0,0,0,.72);backdrop-filter:blur(20px);animation:tssPipMenuIn .18s cubic-bezier(.22,1,.36,1);scrollbar-width:thin}
    .tss-pip-sound-head{display:flex;align-items:center;justify-content:space-between;padding-bottom:10px;border-bottom:1px solid rgba(255,255,255,.07)}.tss-pip-sound-head>div{display:flex;flex-direction:column;gap:2px}.tss-pip-sound-head span{font-size:11px;font-weight:720}.tss-pip-sound-head small{color:rgba(255,255,255,.3);font-size:8px}.tss-pip-sound-head button,.tss-pip-mini-icon{display:flex;align-items:center;justify-content:center;border:0;background:transparent;color:rgba(255,255,255,.45);cursor:pointer}.tss-pip-sound-head button{width:26px;height:26px;border-radius:6px}.tss-pip-sound-head button:hover,.tss-pip-mini-icon:hover{background:rgba(255,255,255,.07);color:#fff}
    .tss-pip-setting-row{display:flex;align-items:center;gap:9px;padding:11px 0}.tss-pip-mini-icon{width:28px;height:28px;border-radius:7px}.tss-pip-setting-row output,.tss-pip-setting-label output{color:rgba(255,255,255,.4);font-size:8px;font-variant-numeric:tabular-nums}.tss-pip-setting-row output{width:30px;text-align:right}
    .tss-pip-sound-menu input[type="range"]{--fill:0%;width:100%;height:3px;margin:0;appearance:none;border:0;border-radius:3px;background:linear-gradient(90deg,var(--accent) var(--fill),rgba(255,255,255,.11) var(--fill));cursor:pointer}.tss-pip-sound-menu input[type="range"]::-webkit-slider-thumb{width:12px;height:12px;appearance:none;border:2px solid #fff;border-radius:50%;background:var(--accent);box-shadow:0 2px 7px rgba(0,0,0,.5)}.tss-pip-sound-menu input[type="range"]::-moz-range-thumb{width:9px;height:9px;border:2px solid #fff;border-radius:50%;background:var(--accent)}
    .tss-pip-setting-block{padding:10px 0;border-top:1px solid rgba(255,255,255,.06)}.tss-pip-setting-label{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;color:rgba(255,255,255,.65);font-size:9px;font-weight:650}.tss-pip-segments{display:grid;grid-template-columns:repeat(3,1fr);gap:3px;margin-top:10px;padding:2px;border-radius:7px;background:rgba(255,255,255,.035)}.tss-pip-segments button{height:25px;border:0;border-radius:5px;background:transparent;color:rgba(255,255,255,.3);font-size:8px;font-weight:680;text-transform:capitalize;cursor:pointer}.tss-pip-segments button[aria-pressed="true"]{background:rgba(255,255,255,.09);color:#fff}
    .tss-pip-setting-grid{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:8px}.tss-pip-setting-toggle,.tss-pip-check-row,.tss-pip-select-row{min-height:34px;border:1px solid rgba(255,255,255,.07);border-radius:8px;background:rgba(255,255,255,.025);color:rgba(255,255,255,.58);font-size:8px;font-weight:620}.tss-pip-setting-toggle{padding:0 9px;display:flex;align-items:center;justify-content:space-between;cursor:pointer}.tss-pip-setting-toggle i{width:24px;height:14px;padding:2px;border-radius:10px;background:rgba(255,255,255,.12)}.tss-pip-setting-toggle i::after{content:'';display:block;width:10px;height:10px;border-radius:50%;background:rgba(255,255,255,.58);transition:transform .15s}.tss-pip-setting-toggle[aria-pressed="true"]{color:#fff;border-color:color-mix(in srgb,var(--accent),transparent 68%)}.tss-pip-setting-toggle[aria-pressed="true"] i{background:var(--accent)}.tss-pip-setting-toggle[aria-pressed="true"] i::after{transform:translateX(10px);background:#fff}
    .tss-pip-select-row{margin-top:8px;padding:0 8px;display:flex;align-items:center;justify-content:space-between;gap:6px}.tss-pip-select-row select{max-width:58%;border:0;background:transparent;color:rgba(255,255,255,.72);font:inherit;outline:0;text-align:right}.tss-pip-select-row option{background:#151515}.tss-pip-sleep-row{margin-top:0}.tss-pip-check-row{padding:0 8px;display:flex;align-items:center;gap:6px}.tss-pip-check-row input{accent-color:var(--accent)}.tss-pip-full-eq{width:100%;height:31px;margin-top:8px;border:1px solid rgba(255,255,255,.07);border-radius:8px;background:transparent;color:rgba(255,255,255,.38);font-size:8px;font-weight:650;cursor:pointer}.tss-pip-full-eq:hover{background:rgba(255,255,255,.04);color:#fff}
    .tss-pip-stage[data-view="queue"] .tss-pip-queue-row{animation:tssPipRowIn .26s both cubic-bezier(.22,1,.36,1);animation-delay:calc(var(--row-index) * 18ms)}
    @keyframes tssPipRowIn{from{opacity:0;transform:translateX(12px)}to{opacity:1;transform:translateX(0)}}@keyframes tssPipMenuIn{from{opacity:0;transform:translateY(-4px) scale(.98)}to{opacity:1;transform:none}}
    @media(prefers-reduced-motion:reduce){.tss-pip-view,.tss-pip-queue-row,.tss-pip-track-menu{transition:none!important;animation:none!important}}
    @media(max-width:360px){.tss-pip-header{gap:6px}.tss-pip-live span{display:none}.tss-pip-brand{font-size:9px}.tss-pip-state{max-width:52px}}
    @media(max-height:300px){#tss-pip-player{min-height:280px;padding:10px 13px}.tss-pip-stage{margin-top:6px}.tss-pip-track{grid-template-columns:70px minmax(0,1fr);min-height:70px}.tss-pip-art{width:70px;height:70px}.tss-pip-wave{margin-top:7px}#tss-pip-waveform{height:24px}.tss-pip-controls{margin:5px 0 7px}.tss-pip-control-primary{width:47px;height:47px}.tss-pip-up-next{padding-top:6px}.tss-pip-next-row{grid-template-columns:34px minmax(0,1fr) auto 28px;min-height:34px;margin-top:5px}.tss-pip-next-art{width:34px;height:34px}}
  `;
  pipDocument.head.appendChild(style);
  pipDocument.body.innerHTML = `
    <main id="tss-pip-player">
      <header class="tss-pip-header">
        <div class="tss-pip-brandmark" aria-hidden="true">${SVG.shuffle}</div>
        <div class="tss-pip-brand">True Shuffle</div>
        <div id="tss-pip-state" class="tss-pip-state" hidden></div>
        <div class="tss-pip-live" aria-label="Picture in picture">${SVG.pip}<span>PiP</span></div>
        <button id="tss-pip-like" class="tss-pip-view-toggle" type="button" aria-label="Like current track" aria-pressed="false" data-liked="false" title="Like on SoundCloud">${SVG.heart}</button>
        <button id="tss-pip-sound" class="tss-pip-view-toggle" type="button" aria-label="Playback settings" aria-pressed="false" title="Playback settings">${SVG.equalizer}</button>
        <button id="tss-pip-view-toggle" class="tss-pip-view-toggle" type="button" aria-label="Show queue" aria-pressed="false" title="Show queue">${SVG.list}</button>
        <button id="tss-pip-close" class="tss-pip-close" type="button" aria-label="Close picture in picture">${SVG.close}</button>
      </header>
      <div id="tss-pip-stage" class="tss-pip-stage" data-view="player">
      <div id="tss-pip-now-view" class="tss-pip-view" aria-hidden="false">
      <section class="tss-pip-track">
        <div class="tss-pip-art">
          <img id="tss-pip-artwork" alt="" hidden>
          <span id="tss-pip-artwork-fallback" class="tss-pip-art-fallback">${SVG.note}</span>
        </div>
        <div style="min-width:0">
          <div id="tss-pip-title" class="tss-pip-title">—</div>
          <div id="tss-pip-artist" class="tss-pip-artist">—</div>
          <div class="tss-pip-track-meta">
            <span id="tss-pip-position" class="tss-pip-position">—</span>
            <span id="tss-pip-processing" class="tss-pip-processing" hidden><span id="tss-pip-crossfade"><span id="tss-pip-crossfade-value">0s fade</span></span><span id="tss-pip-auto-level">auto level</span></span>
          </div>
        </div>
      </section>
      <section class="tss-pip-wave">
        <canvas id="tss-pip-waveform" tabindex="0" aria-label="Seek through track"></canvas>
        <div class="tss-pip-times"><span id="tss-pip-current">0:00</span><span id="tss-pip-remaining">-0:00</span></div>
      </section>
      <section class="tss-pip-controls" aria-label="Playback controls">
        <button id="tss-pip-prev" class="tss-pip-control" type="button" aria-label="Previous track">${SVG.prev}</button>
        <button id="tss-pip-play" class="tss-pip-control tss-pip-control-primary" type="button" aria-label="Play">${SVG.play}</button>
        <button id="tss-pip-next" class="tss-pip-control" type="button" aria-label="Next track">${SVG.next}</button>
      </section>
      <section class="tss-pip-up-next">
        <div class="tss-pip-kicker">Up next</div>
        <div id="tss-pip-up-next-row" class="tss-pip-next-row">
          <div class="tss-pip-next-art">
            <img id="tss-pip-next-artwork" alt="" hidden>
            <span id="tss-pip-next-fallback" class="tss-pip-art-fallback">${SVG.note}</span>
          </div>
          <div style="min-width:0"><div id="tss-pip-next-title" class="tss-pip-next-title">—</div><div id="tss-pip-next-artist" class="tss-pip-next-artist">—</div></div>
          <div id="tss-pip-next-number" class="tss-pip-next-number">—</div>
          <button id="tss-pip-next-settings" class="tss-pip-track-settings" type="button" aria-label="Settings for up next" title="Track settings">${SVG.more}</button>
        </div>
      </section>
      </div>
      <section id="tss-pip-queue-view" class="tss-pip-view" data-tab="queue" aria-hidden="true">
        <div class="tss-pip-queue-head"><span class="tss-pip-kicker">Queue</span><span id="tss-pip-queue-count" class="tss-pip-queue-count">0 tracks</span></div>
        <div class="tss-pip-queue-tools">
          <div class="tss-pip-tabs" role="tablist" aria-label="Queue view"><button id="tss-pip-tab-queue" class="tss-pip-tab" type="button" role="tab" aria-selected="true">Queue</button><button id="tss-pip-tab-history" class="tss-pip-tab" type="button" role="tab" aria-selected="false">History</button></div>
          <label class="tss-pip-search-wrap">${SVG.search}<input id="tss-pip-queue-search" class="tss-pip-queue-search" type="search" autocomplete="off" placeholder="Search tracks" aria-label="Search tracks"></label>
        </div>
        <div id="tss-pip-queue-list" class="tss-pip-queue-list" role="list"></div>
      </section>
      </div>
    </main>
  `;

  pipDocument.getElementById('tss-pip-close').onclick = closeOwnPip;
  pipDocument.getElementById('tss-pip-like').onclick = () => { void toggleCurrentTrackLike(); };
  const soundButton = pipDocument.getElementById('tss-pip-sound');
  soundButton.onclick = () => showOwnPipSoundMenu(pipDocument, soundButton);
  const viewToggle = pipDocument.getElementById('tss-pip-view-toggle');
  viewToggle.onclick = () => {
    pipDocument.getElementById('tss-pip-track-menu')?.remove();
    pipDocument.getElementById('tss-pip-sound-menu')?.remove();
    soundButton.dataset.active = 'false';
    soundButton.setAttribute('aria-pressed', 'false');
    const stage = pipDocument.getElementById('tss-pip-stage');
    const nowView = pipDocument.getElementById('tss-pip-now-view');
    const queueView = pipDocument.getElementById('tss-pip-queue-view');
    const showQueue = stage.dataset.view !== 'queue';
    stage.dataset.view = showQueue ? 'queue' : 'player';
    nowView.setAttribute('aria-hidden', showQueue ? 'true' : 'false');
    queueView.setAttribute('aria-hidden', showQueue ? 'false' : 'true');
    if ('inert' in nowView) nowView.inert = showQueue;
    if ('inert' in queueView) queueView.inert = !showQueue;
    viewToggle.dataset.active = showQueue ? 'true' : 'false';
    viewToggle.setAttribute('aria-pressed', showQueue ? 'true' : 'false');
    viewToggle.setAttribute('aria-label', showQueue ? 'Show player' : 'Show queue');
    viewToggle.title = showQueue ? 'Show player' : 'Show queue';
    viewToggle.innerHTML = showQueue ? SVG.equalizer : SVG.list;
    if (showQueue) renderOwnPipQueue(pipDocument, Number.isInteger(state._deckTrack) ? state._deckTrack : state.queue[state.pos]);
  };
  const setPipQueueTab = tab => {
    const queueView = pipDocument.getElementById('tss-pip-queue-view');
    queueView.dataset.tab = tab;
    pipDocument.getElementById('tss-pip-tab-queue').setAttribute('aria-selected', tab === 'queue' ? 'true' : 'false');
    pipDocument.getElementById('tss-pip-tab-history').setAttribute('aria-selected', tab === 'history' ? 'true' : 'false');
    const list = pipDocument.getElementById('tss-pip-queue-list');
    if (list) delete list.dataset.key;
    renderOwnPipQueue(pipDocument, Number.isInteger(state._deckTrack) ? state._deckTrack : state.queue[state.pos]);
  };
  pipDocument.getElementById('tss-pip-tab-queue').onclick = () => setPipQueueTab('queue');
  pipDocument.getElementById('tss-pip-tab-history').onclick = () => setPipQueueTab('history');
  pipDocument.getElementById('tss-pip-queue-search').oninput = () => {
    const list = pipDocument.getElementById('tss-pip-queue-list');
    if (list) delete list.dataset.key;
    renderOwnPipQueue(pipDocument, Number.isInteger(state._deckTrack) ? state._deckTrack : state.queue[state.pos]);
  };
  pipDocument.getElementById('tss-pip-play').onclick = () => { void toggle(); };
  pipDocument.getElementById('tss-pip-prev').onclick = () => { void prevTrack(); };
  pipDocument.getElementById('tss-pip-next').onclick = () => {
    if (state.busy) return;
    state.manualAction = true;
    state._manualActionAt = Date.now();
    void next();
  };
  pipDocument.getElementById('tss-pip-next-settings').onclick = event => {
    event.stopPropagation();
    const ti = Number(event.currentTarget.dataset.ti);
    if (Number.isInteger(ti) && state.meta[ti]) {
      showOwnPipTrackMenu(
        pipDocument,
        event.currentTarget,
        ti,
        Number.isInteger(state._deckTrack) ? state._deckTrack : state.queue[state.pos],
      );
    }
  };
  const currentArtwork = pipDocument.getElementById('tss-pip-artwork');
  currentArtwork.onerror = () => {
    currentArtwork.hidden = true;
    pipDocument.getElementById('tss-pip-artwork-fallback').hidden = false;
  };
  const upcomingArtwork = pipDocument.getElementById('tss-pip-next-artwork');
  upcomingArtwork.onerror = () => {
    upcomingArtwork.hidden = true;
    pipDocument.getElementById('tss-pip-next-fallback').hidden = false;
  };
  const seekFromPip = event => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width > 0) seekTo((event.clientX - rect.left) / rect.width);
  };
  pipDocument.getElementById('tss-pip-waveform').onclick = seekFromPip;
  pipDocument.getElementById('tss-pip-waveform').onkeydown = event => {
    if (event.key === 'ArrowLeft') seekTo(Math.max(0, progress() - 0.03));
    if (event.key === 'ArrowRight') seekTo(Math.min(1, progress() + 0.03));
  };
  if (mode === 'document') {
    pipWindow.addEventListener('pagehide', () => {
      if (state._ownPipWindow === pipWindow) {
        state._ownPipWindow = null;
        state._ownPipMode = null;
        setOwnPipButtonState();
      }
    }, { once: true });
  }

  setOwnPipButtonState();
  syncOwnPipWindow();
  return true;
}

function installBetterFeedPipBridge() {
  const player = pageWindow.scPlayer;
  if (!player || typeof player !== 'object') return false;
  if (state._pipBridgePlayer === player) return true;

  const methodNames = [
    'getCurrentSound', 'getCurrentQueueItem', 'isPlaying', 'toggleCurrent',
    'playNext', 'playPrev', 'seekCurrentTo', 'seekCurrentBy',
  ];
  const originals = Object.fromEntries(methodNames.map(name => [name, player[name]]));
  const callOriginal = (name, args) => {
    const fn = originals[name];
    return typeof fn === 'function' ? fn.apply(player, args) : undefined;
  };
  const evaluateAmount = callback => Number(typeof callback === 'function' ? callback() : callback);
  const seekDeck = (callback, relative) => {
    const deck = currentDeckAudio();
    if (!deck) return;
    const amountMs = evaluateAmount(callback);
    if (!Number.isFinite(amountMs)) return;
    const base = relative ? (Number(deck.currentTime) || 0) : 0;
    const duration = Number.isFinite(deck.duration) && deck.duration > 0 ? deck.duration : Infinity;
    deck.currentTime = Math.max(0, Math.min(duration, base + amountMs / 1000));
    updateProgressBar();
    updateHub();
  };

  try {
    player.getCurrentSound = (...args) => betterFeedPipActive()
      ? betterFeedPipSound()
      : callOriginal('getCurrentSound', args);
    player.getCurrentQueueItem = (...args) => betterFeedPipActive()
      ? null
      : callOriginal('getCurrentQueueItem', args);
    player.isPlaying = (...args) => betterFeedPipActive()
      ? !currentDeckAudio().paused
      : callOriginal('isPlaying', args);
    player.toggleCurrent = (...args) => {
      if (!betterFeedPipActive()) return callOriginal('toggleCurrent', args);
      void toggle();
    };
    player.playNext = (...args) => {
      if (!betterFeedPipActive()) return callOriginal('playNext', args);
      state.manualAction = true;
      state._manualActionAt = Date.now();
      void next();
    };
    player.playPrev = (...args) => {
      if (!betterFeedPipActive()) return callOriginal('playPrev', args);
      void prevTrack();
    };
    player.seekCurrentTo = (callback, ...args) => {
      if (!betterFeedPipActive()) return callOriginal('seekCurrentTo', [callback, ...args]);
      seekDeck(callback, false);
    };
    player.seekCurrentBy = (callback, ...args) => {
      if (!betterFeedPipActive()) return callOriginal('seekCurrentBy', [callback, ...args]);
      seekDeck(callback, true);
    };
  } catch (_) {
    return false;
  }

  state._pipBridgePlayer = player;
  return true;
}

function ensureCrossfadeDecks() {
  if (state._decks.length === 2 && state._decks.every(Boolean)) return state._decks;
  state._decks = [0, 1].map(index => {
    const audio = document.createElement('audio');
    audio.id = `tss-crossfade-deck-${index + 1}`;
    audio.preload = 'auto';
    audio.playsInline = true;
    audio.crossOrigin = 'anonymous';
    audio.dataset.tssCrossfadeDeck = String(index);
    audio.style.display = 'none';
    document.body.appendChild(audio);
    return audio;
  });
  state._deckTracks = [null, null];
  state._deckGains = [0, 0];
  return state._decks;
}

function autoLevelTrackKey(ti) {
  const meta = state.meta[ti];
  return trackId(meta) || normalizeTrackUrl(meta?.link) || '';
}

function calculateAutoLevelGain(rms, peak, masterVolume) {
  const level = Number(rms);
  const measuredPeak = Number(peak);
  const master = Math.max(0, Math.min(1, Number(masterVolume)));
  if (!Number.isFinite(level) || level < 0.015 || !Number.isFinite(master) || master <= 0) return 1;
  // Full master volume is a strict unity path: Auto must never make 100%
  // quieter than the browser-native output.
  if (master >= 0.999) return 1;

  const targetRms = 0.225;
  const desired = targetRms / level;
  // Chromium can report unusually low analyser RMS values for some streams.
  // Keep quiet-track correction subtle so Auto Level cannot overpower the
  // user's master-volume setting while still attenuating genuinely loud tracks.
  const maxBoost = 1.25;
  const masterHeadroom = 1 / master;
  const peakHeadroom = Number.isFinite(measuredPeak) && measuredPeak > 0
    ? 1 / (master * measuredPeak)
    : masterHeadroom;
  return Math.max(0.125, Math.min(desired, maxBoost, masterHeadroom, peakHeadroom));
}

function saveAutoLevelCacheSoon() {
  clearTimeout(state._autoLevelCacheTimer);
  state._autoLevelCacheTimer = setTimeout(() => {
    const entries = Object.entries(state._autoLevelCache)
      .sort((a, b) => (b[1]?.ts || 0) - (a[1]?.ts || 0))
      .slice(0, 300);
    state._autoLevelCache = Object.fromEntries(entries);
    try { localStorage.setItem('tss_auto_level_cache_v4', JSON.stringify(state._autoLevelCache)); } catch (_) {}
  }, 800);
}

let equalizerPersistTimer = null;
let customPresetsPending = false;

function flushEqualizerPersistence() {
  clearTimeout(equalizerPersistTimer);
  equalizerPersistTimer = null;
  const customPresets = sanitizeCustomEqPresets(state.customEqPresets);
  state.customEqPresets = customPresets;
  if (customPresetsPending) {
    try {
      if (typeof GM_setValue === 'function') GM_setValue(CUSTOM_EQ_PRESETS_KEY, customPresets);
    } catch (_) {}
    customPresetsPending = false;
  }
  try {
    localStorage.setItem('tss_eq_enabled', String(state.eqEnabled));
    localStorage.setItem('tss_eq_bands', JSON.stringify(state.eqBands));
    localStorage.setItem('tss_eq_preset', state.eqPreset);
    // Keep a local mirror for migration and non-Tampermonkey development runs.
    localStorage.setItem('tss_eq_custom_presets', JSON.stringify(customPresets));
  } catch (_) {}
}

function persistEqualizer({ customPresets = false, immediate = false } = {}) {
  customPresetsPending = customPresetsPending || customPresets;
  clearTimeout(equalizerPersistTimer);
  if (immediate) {
    flushEqualizerPersistence();
  } else {
    equalizerPersistTimer = setTimeout(flushEqualizerPersistence, 220);
  }
}

function syncEqualizer() {
  const now = state._audioContext?.currentTime || 0;
  state._deckAudioGraphs.forEach(graph => {
    if (!graph?.eqFilters) return;
    graph.eqFilters.forEach((filter, index) => {
      const value = state.eqEnabled ? state.eqBands[index] : 0;
      filter.gain.setTargetAtTime(value, now, 0.025);
    });
  });
  syncDeckProcessingRouting();

  const button = document.getElementById('tss-hub-eq');
  if (button) {
    button.dataset.active = String(state.eqEnabled);
    button.setAttribute('aria-pressed', String(state.eqEnabled));
    button.title = state.eqEnabled ? 'Equalizer on' : 'Equalizer off';
  }
}

function ensureAutoLevelAudioGraph() {
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext
    || pageWindow.AudioContext || pageWindow.webkitAudioContext;
  if (!AudioContextCtor) return false;
  const decks = ensureCrossfadeDecks();
  try {
    if (!state._audioContext) {
      const context = new AudioContextCtor();
      const master = context.createGain();
      const clipper = context.createWaveShaper();
      master.gain.value = state.playbackVolume;
      // A two-point identity curve is linear inside full scale and WaveShaper
      // clamps only samples that exceed it. Unlike a compressor, this has no
      // envelope or release tail, so EQ/crossfade overs are contained without
      // turning musical peaks into program-dependent volume pumping.
      clipper.curve = new Float32Array([-1, 1]);
      clipper.oversample = '4x';
      master.connect(state.safetyClipper ? clipper : context.destination);
      clipper.connect(context.destination);
      state._audioContext = context;
      state._audioMaster = master;
      state._audioClipper = clipper;
    }

    decks.forEach((audio, index) => {
      if (state._deckAudioGraphs[index]) return;
      const source = state._audioContext.createMediaElementSource(audio);
      const eqFilters = EQ_BANDS.map((band, bandIndex) => {
        const filter = state._audioContext.createBiquadFilter();
        filter.type = band.type;
        filter.frequency.value = band.frequency;
        filter.Q.value = band.q;
        filter.gain.value = state.eqEnabled ? state.eqBands[bandIndex] : 0;
        return filter;
      });
      const analyser = state._audioContext.createAnalyser();
      const autoGain = state._audioContext.createGain();
      const mixGain = state._audioContext.createGain();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.72;
      autoGain.gain.value = 1;
      mixGain.gain.value = state._deckGains[index] || 0;
      mixGain.connect(state._audioMaster);
      audio.volume = 1;
      state._deckAudioGraphs[index] = {
        source, eqFilters, analyser, autoGain, mixGain,
        buffer: new Float32Array(analyser.fftSize),
        smoothedRms: 0,
        peakRms: 0,
        measuredPeak: 0,
        currentGain: 1,
        samples: 0,
        settled: false,
        trackKey: '',
        appliedAutoGain: 1,
        appliedMixGain: state._deckGains[index] || 0,
        autoGainMaster: null,
      };
    });
    syncDeckProcessingRouting();
    syncEqualizer();
    if (state._audioContext.state === 'suspended') void state._audioContext.resume();
    return true;
  } catch (_) {
    return false;
  }
}

function syncDeckProcessingRouting() {
  state._deckAudioGraphs.forEach(graph => {
    if (!graph) return;
    for (const node of [graph.source, ...graph.eqFilters, graph.analyser, graph.autoGain]) {
      try { node.disconnect(); } catch (_) {}
    }

    if (!state.eqEnabled && !state.autoLevel) {
      graph.source.connect(graph.mixGain);
      setAudioParamImmediately(graph.autoGain.gain, 1, state._audioContext.currentTime);
      graph.appliedAutoGain = 1;
      return;
    }

    let tail = graph.source;
    if (state.eqEnabled) {
      for (const filter of graph.eqFilters) {
        tail.connect(filter);
        tail = filter;
      }
    }
    if (state.autoLevel) {
      tail.connect(graph.analyser);
      graph.analyser.connect(graph.autoGain);
      graph.autoGain.connect(graph.mixGain);
      setAudioParamImmediately(graph.autoGain.gain, graph.currentGain, state._audioContext.currentTime);
      graph.appliedAutoGain = graph.currentGain;
    } else {
      tail.connect(graph.mixGain);
      setAudioParamImmediately(graph.autoGain.gain, 1, state._audioContext.currentTime);
      graph.appliedAutoGain = 1;
    }
  });
}

function syncSafetyClipper() {
  if (!state._audioMaster || !state._audioContext) return;
  try {
    state._audioMaster.disconnect();
    state._audioMaster.connect(state.safetyClipper ? state._audioClipper : state._audioContext.destination);
  } catch (_) {}
}

async function resumeAudioGraph() {
  const context = state._audioContext;
  if (!context || context.state === 'running') return true;
  if (context.state === 'closed') return false;
  try {
    await context.resume();
    return context.state === 'running';
  } catch (_) {
    return false;
  }
}

async function suspendAudioGraph() {
  const context = state._audioContext;
  if (!context || context.state !== 'running') return true;
  try {
    await context.suspend();
    return context.state === 'suspended';
  } catch (_) {
    return false;
  }
}

function applyCachedAutoLevel(index, ti) {
  const graph = state._deckAudioGraphs[index];
  if (!graph) return;
  const key = autoLevelTrackKey(ti);
  const cachedRms = Number(state._autoLevelCache[key]?.rms);
  const cachedPeak = Number(state._autoLevelCache[key]?.peak);
  const hasCachedMeasurement = Number.isFinite(cachedRms) && cachedRms >= 0.015
    && Number.isFinite(cachedPeak) && cachedPeak > 0;
  graph.trackKey = key;
  graph.samples = 0;
  graph.smoothedRms = 0;
  graph.peakRms = hasCachedMeasurement ? cachedRms : 0;
  graph.measuredPeak = hasCachedMeasurement ? cachedPeak : 0;
  graph.settled = hasCachedMeasurement;
  graph.currentGain = state.autoLevel && hasCachedMeasurement
    ? calculateAutoLevelGain(cachedRms, cachedPeak, state.playbackVolume)
    : 1;
  graph.autoGainMaster = hasCachedMeasurement ? state.playbackVolume : null;
  graph.autoGain.gain.setValueAtTime(graph.currentGain, state._audioContext.currentTime);
  graph.appliedAutoGain = graph.currentGain;
}

function processAutoLevel() {
  if (!state.autoLevel || !state._audioContext) return;
  const now = performance.now();
  if (now - state._autoLevelLastTick < 60) return;
  state._autoLevelLastTick = now;

  state._deckAudioGraphs.forEach((graph, index) => {
    const audio = state._decks[index];
    if (!graph || !audio || audio.paused || !audio.currentSrc || state._deckGains[index] <= 0.001) return;
    if (graph.settled) return;
    graph.analyser.getFloatTimeDomainData(graph.buffer);
    let sum = 0;
    let peak = 0;
    for (const sample of graph.buffer) {
      sum += sample * sample;
      peak = Math.max(peak, Math.abs(sample));
    }
    const rms = Math.sqrt(sum / graph.buffer.length);
    if (rms < 0.015) return;
    graph.smoothedRms = graph.smoothedRms
      ? graph.smoothedRms * 0.55 + rms * 0.45
      : rms;
    graph.peakRms = Math.max(graph.peakRms, graph.smoothedRms);
    graph.measuredPeak = Math.max(graph.measuredPeak, peak);
    graph.samples++;
    if (graph.samples < 12) return;
    graph.settled = true;
    graph.currentGain = calculateAutoLevelGain(
      graph.peakRms,
      graph.measuredPeak,
      state.playbackVolume,
    );
    graph.autoGainMaster = state.playbackVolume;
    graph.autoGain.gain.setTargetAtTime(
      graph.currentGain,
      state._audioContext.currentTime,
      0.08,
    );
    graph.appliedAutoGain = graph.currentGain;
    if (graph.trackKey) {
      state._autoLevelCache[graph.trackKey] = {
        rms: graph.peakRms,
        peak: graph.measuredPeak,
        ts: Date.now(),
      };
      saveAutoLevelCacheSoon();
    }
  });
}

function normalizeSoundCloudVolume(value, maxValue) {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return null;

  const declaredMax = Number(maxValue);
  const scale = Number.isFinite(declaredMax) && declaredMax > 0
    ? declaredMax
    : raw > 1 ? 100 : 1;
  return Math.max(0, Math.min(1, raw / scale));
}

function soundCloudVolumeModel() {
  if (state._soundCloudVolumeModel) return state._soundCloudVolumeModel;
  const registry = pageWindow.webpackJsonp;
  if (!registry || typeof registry.push !== 'function') return null;

  let webpackRequire = null;
  try {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const moduleId = `tss-volume-module-${stamp}`;
    registry.push([
      [`tss-volume-chunk-${stamp}`],
      { [moduleId]: (module, exports, requireFn) => { webpackRequire = requireFn; } },
      [[moduleId]],
    ]);
  } catch (_) {
    return null;
  }
  if (!webpackRequire?.c) return null;

  for (const cached of Object.values(webpackRequire.c)) {
    const exported = cached?.exports;
    const candidates = [exported, exported?.default];
    if (exported && typeof exported === 'object') candidates.push(...Object.values(exported));
    for (const candidate of candidates) {
      if (candidate
          && typeof candidate.getVolume === 'function'
          && typeof candidate.getMuted === 'function'
          && typeof candidate.setVolumeAndMuted === 'function') {
        state._soundCloudVolumeModel = candidate;
        return candidate;
      }
    }
  }
  return null;
}

function soundCloudVolumeSlider() {
  return document.querySelector([
    '.volume [role="slider"][aria-valuenow]',
    '.volume__slider[aria-valuenow]',
    '[role="slider"][aria-label*="olume"][aria-valuenow]',
  ].join(', '));
}

function soundCloudVolume() {
  const model = soundCloudVolumeModel();
  if (model) {
    const value = model.getMuted() ? 0 : Number(model.getVolume());
    if (Number.isFinite(value)) return Math.max(0, Math.min(1, value));
  }
  const slider = soundCloudVolumeSlider();
  const sliderVolume = normalizeSoundCloudVolume(
    slider?.getAttribute('aria-valuenow'),
    slider?.getAttribute('aria-valuemax'),
  );
  if (sliderVolume !== null) return sliderVolume;

  const nativeAudio = [...document.querySelectorAll('audio')]
    .find(audio => !audio.dataset.tssCrossfadeDeck && audio.currentSrc);
  return Number.isFinite(nativeAudio?.volume)
    ? Math.max(0, Math.min(1, nativeAudio.volume))
    : null;
}

function setSoundCloudVolume(value) {
  const level = Math.max(0, Math.min(1, Number(value) || 0));
  const model = soundCloudVolumeModel();
  if (model) {
    model.setVolumeAndMuted({ volume: level, muted: level === 0 });
    state._lastSoundCloudVolume = level;
    return true;
  }

  const slider = soundCloudVolumeSlider();
  if (!slider) return false;

  const track = slider.querySelector('.volume__sliderBackground') || slider;
  const rect = track.getBoundingClientRect();
  if (!rect || rect.height <= 0) return false;

  const opts = {
    bubbles: true,
    cancelable: true,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + 4 + rect.height * (1 - level),
    button: 0,
    buttons: 1,
  };
  slider.dispatchEvent(new MouseEvent('mousedown', opts));
  document.dispatchEvent(new MouseEvent('mousemove', opts));
  document.dispatchEvent(new MouseEvent('mouseup', opts));
  state._lastSoundCloudVolume = level;
  return true;
}

function initializePlaybackVolume() {
  if (state._playbackVolumeInitialized) return true;
  const nativeVolume = soundCloudVolume();
  if (state._playbackVolumeStored) {
    const synchronized = setSoundCloudVolume(state.playbackVolume);
    state._playbackVolumeInitialized = synchronized;
    syncPlaybackVolumeControls();
    return synchronized;
  }
  if (!Number.isFinite(nativeVolume)) return false;
  state.playbackVolume = nativeVolume;
  state._lastSoundCloudVolume = nativeVolume;
  state._playbackVolumeStored = true;
  state._playbackVolumeInitialized = true;
  try { localStorage.setItem('tss_playback_volume', String(nativeVolume)); } catch (_) {}
  syncCrossfadeVolume();
  syncPlaybackVolumeControls();
  return true;
}

function syncPlaybackVolumeFromSoundCloud() {
  if (currentDeckAudio()) return;
  if (!state._playbackVolumeInitialized && !initializePlaybackVolume()) return;
  const nativeVolume = soundCloudVolume();
  if (!Number.isFinite(nativeVolume)) return;
  const changedOutsideHub = state._lastSoundCloudVolume === null
    || Math.abs(nativeVolume - state._lastSoundCloudVolume) > 0.004;
  state._lastSoundCloudVolume = nativeVolume;
  if (!changedOutsideHub || Math.abs(nativeVolume - state.playbackVolume) <= 0.004) return;
  state.playbackVolume = nativeVolume;
  try { localStorage.setItem('tss_playback_volume', String(nativeVolume)); } catch (_) {}
  syncCrossfadeVolume();
  syncPlaybackVolumeControls();
}

function syncCrossfadeVolume() {
  if (!state._decks.length) return;
  const master = state.playbackVolume;
  if (state._audioMaster && (
    !Number.isFinite(state._appliedMasterGain)
    || Math.abs(state._appliedMasterGain - master) > 0.0001
  )) {
    state._audioMaster.gain.setTargetAtTime(master, state._audioContext.currentTime, 0.015);
    state._appliedMasterGain = master;
  }
  state._decks.forEach((audio, index) => {
    if (!audio) return;
    const automatedGain = scheduledCrossfadeGain(index);
    const gain = automatedGain === null
      ? (Number.isFinite(state._deckGains[index]) ? state._deckGains[index] : 0)
      : automatedGain;
    if (automatedGain !== null) state._deckGains[index] = automatedGain;
    const graph = state._deckAudioGraphs?.[index];
    if (graph) {
      audio.volume = 1;
      if (state.autoLevel && graph.settled && (
        !Number.isFinite(graph.autoGainMaster)
        || Math.abs(graph.autoGainMaster - master) > 0.0001
      )) {
        graph.currentGain = calculateAutoLevelGain(
          graph.peakRms,
          graph.measuredPeak,
          master,
        );
        graph.autoGainMaster = master;
      }
      // The audio clock owns mixGain while a crossfade is scheduled. Rewriting
      // it from the UI watcher would destroy background-safe automation.
      if (automatedGain === null && (
        !Number.isFinite(graph.appliedMixGain)
        || Math.abs(graph.appliedMixGain - gain) > 0.0001
      )) {
        setAudioParamImmediately(graph.mixGain.gain, gain, state._audioContext.currentTime);
        graph.appliedMixGain = gain;
      }
      const targetAutoGain = state.autoLevel ? graph.currentGain : 1;
      if (!Number.isFinite(graph.appliedAutoGain)
          || Math.abs(graph.appliedAutoGain - targetAutoGain) > 0.0001) {
        graph.autoGain.gain.setTargetAtTime(targetAutoGain, state._audioContext.currentTime, 0.08);
        graph.appliedAutoGain = targetAutoGain;
      }
    } else {
      audio.volume = Math.max(0, Math.min(1, master * gain));
    }
  });
}

function syncPlaybackVolumeControls() {
  const percent = Math.round(state.playbackVolume * 100);
  const slider = document.getElementById('tss-hub-volume');
  const readout = document.getElementById('tss-hub-volume-value');
  if (slider) {
    if (slider.value !== String(percent)) slider.value = String(percent);
    slider.style.setProperty('--tss-volume-fill', `${percent}%`);
  }
  if (readout) readout.textContent = `${percent}%`;
  const auto = document.getElementById('tss-auto-level');
  if (auto) {
    auto.dataset.active = String(state.autoLevel);
    auto.setAttribute('aria-pressed', String(state.autoLevel));
    const label = auto.querySelector('.tss-auto-label');
    if (label) label.textContent = state.autoLevel ? 'AUTO ON' : 'AUTO OFF';
    auto.title = state.autoLevel
      ? 'Auto Level is reducing louder tracks'
      : 'Automatically reduce louder tracks';
  }
}

function setPlaybackVolume(value) {
  state.playbackVolume = Math.max(0, Math.min(1, Number(value) || 0));
  state._playbackVolumeStored = true;
  state._playbackVolumeInitialized = true;
  localStorage.setItem('tss_playback_volume', String(state.playbackVolume));
  syncCrossfadeVolume();
  setSoundCloudVolume(state.playbackVolume);
  syncPlaybackVolumeControls();
}

function setAutoLevelEnabled(enabled) {
  const nextValue = Boolean(enabled);
  if (nextValue && !ensureAutoLevelAudioGraph()) {
    state.autoLevel = false;
    localStorage.setItem('tss_auto_level', 'false');
    syncPlaybackVolumeControls();
    return false;
  }
  state.autoLevel = nextValue;
  localStorage.setItem('tss_auto_level', String(state.autoLevel));
  if (state.autoLevel && state._audioContext?.state === 'suspended') void state._audioContext.resume();
  syncDeckProcessingRouting();
  state._deckTracks.forEach((ti, index) => {
    if (Number.isInteger(ti)) applyCachedAutoLevel(index, ti);
  });
  syncCrossfadeVolume();
  syncPlaybackVolumeControls();
  return true;
}

function setCrossfadeSeconds(value) {
  const previousSeconds = state.crossfadeSeconds;
  state.crossfadeSeconds = Math.max(0, Math.min(12, Number(value) || 0));
  localStorage.setItem('tss_crossfade_seconds', String(state.crossfadeSeconds));
  if (state.crossfadeSeconds <= 0) {
    setCrossfadeStatus('off');
  } else {
    setCrossfadeStatus('armed');
    if (previousSeconds <= 0) {
      ensureAutoLevelAudioGraph();
      if (state.active && currentDeckAudio()) void prefetchUpcomingCrossfadeTrack();
    }
  }
  syncCrossfadeControls();
}

function setCrossfadeStatus(status) {
  state.crossfadeStatus = status;
  const el = document.getElementById('tss-hub-crossfade-status');
  if (!el) return;
  const labels = {
    off: 'off',
    armed: 'armed',
    loading: 'loading next',
    ready: 'next ready',
    mixing: 'mixing',
    fallback: 'normal fallback',
  };
  el.textContent = labels[status] || status;
  el.dataset.status = status;
}

function syncCrossfadeControls() {
  const seconds = Math.max(0, Math.min(12, Math.round(state.crossfadeSeconds)));
  const valueText = seconds > 0 ? `${seconds} sec` : 'off';
  const card = document.getElementById('tss-crossfade-card');
  if (card) card.dataset.enabled = seconds > 0 ? 'true' : 'false';

  const slider = document.getElementById('tss-hub-crossfade');
  if (slider) {
    if (slider.value !== String(seconds)) slider.value = String(seconds);
    slider.style.setProperty('--tss-crossfade-fill', `${(seconds / 12) * 100}%`);
  }
  const summary = document.getElementById('tss-crossfade-summary-seconds');
  const readout = document.getElementById('tss-crossfade-seconds');
  if (summary) summary.textContent = valueText;
  if (readout) readout.textContent = valueText;

  document.querySelectorAll('.tss-crossfade-mode').forEach(button => {
    const active = button.dataset.curve === state.crossfadeCurve;
    button.dataset.active = active ? 'true' : 'false';
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
  const manual = document.getElementById('tss-crossfade-manual');
  if (manual && manual.checked !== state.crossfadeManual) manual.checked = state.crossfadeManual;

}

function discoverSoundCloudClientId() {
  if (state._clientId) return state._clientId;
  try {
    const entries = performance.getEntriesByType('resource');
    for (let i = entries.length - 1; i >= 0; i--) {
      const match = String(entries[i].name || '').match(/[?&]client_id=([A-Za-z0-9_-]+)/);
      if (match) {
        state._clientId = match[1];
        return state._clientId;
      }
    }
  } catch (_) {}
  return '';
}

function syncBrowserNowPlaying() {
  const ti = Number.isInteger(state._deckTrack) ? state._deckTrack : state.queue?.[state.pos];
  const meta = state.active && Number.isInteger(ti) ? state.meta[ti] : null;

  if (!meta?.title) {
    if (state._tabTitleBeforePlayback !== null && document.title === state._tabTitleValue) {
      document.title = state._tabTitleBeforePlayback;
    }
    state._tabTitleBeforePlayback = null;
    state._tabTitleValue = '';
    state._browserMetadataKey = '';
    return false;
  }

  if (state._tabTitleBeforePlayback === null) {
    state._tabTitleBeforePlayback = document.title || 'SoundCloud';
  }
  const artist = meta.artist && meta.artist !== '—' ? String(meta.artist).trim() : '';
  const tabTitle = artist ? `${meta.title} · ${artist}` : String(meta.title);
  state._tabTitleValue = tabTitle;
  if (document.title !== tabTitle) document.title = tabTitle;

  try {
    const mediaSession = pageWindow.navigator?.mediaSession;
    const MediaMetadataCtor = pageWindow.MediaMetadata;
    const metadataKey = [meta.title, artist, meta.artwork || ''].join('\n');
    if (mediaSession && typeof MediaMetadataCtor === 'function'
        && state._browserMetadataKey !== metadataKey) {
      const init = {
        title: String(meta.title),
        artist,
        album: 'SoundCloud True Shuffle',
      };
      if (meta.artwork) init.artwork = [{ src: meta.artwork }];
      mediaSession.metadata = new MediaMetadataCtor(init);
      state._browserMetadataKey = metadataKey;
    }
    if (mediaSession && 'playbackState' in mediaSession) {
      mediaSession.playbackState = paused() ? 'paused' : 'playing';
    }
  } catch (_) {}

  return true;
}

async function discoverSoundCloudClientIdFromBundle() {
  const existing = discoverSoundCloudClientId();
  if (existing) return existing;
  const scripts = [...document.scripts]
    .map(script => script.src)
    .filter(src => /a-v2\.sndcdn\.com\/assets\/.+\.js/i.test(src))
    .slice(-8);
  for (const src of scripts) {
    try {
      const text = await fetch(src).then(response => response.ok ? response.text() : '');
      const match = text.match(/client_id["']?\s*[:=]\s*["']([A-Za-z0-9_-]{20,})["']/);
      if (match) {
        state._clientId = match[1];
        return state._clientId;
      }
    } catch (_) {}
  }
  return '';
}

async function resolveCrossfadeStream(meta, options) {
  options = options || {};
  const key = normalizeTrackUrl(meta?.link);
  if (!key) return null;
  if (options.forceRefresh) state._streamCache.delete(key);
  const cached = state._streamCache.get(key);
  if (cached && Date.now() - cached.ts < 30 * 60 * 1000) return cached.url;

  const clientId = await discoverSoundCloudClientIdFromBundle();
  if (!clientId) return null;
  try {
    const resolvedResponse = await fetch(`https://api-v2.soundcloud.com/resolve?url=${encodeURIComponent(meta.link)}&client_id=${encodeURIComponent(clientId)}`);
    if (!resolvedResponse.ok) return null;
    const track = await resolvedResponse.json();
    const transcodings = Array.isArray(track?.media?.transcodings) ? track.media.transcodings : [];
    const progressive = transcodings.find(item => item?.format?.protocol === 'progressive' && /audio\/(mpeg|mp3)/i.test(item?.format?.mime_type || ''))
      || transcodings.find(item => item?.format?.protocol === 'progressive');
    if (!progressive?.url) return null;

    const endpoint = new URL(progressive.url);
    endpoint.searchParams.set('client_id', clientId);
    if (track.track_authorization) endpoint.searchParams.set('track_authorization', track.track_authorization);
    const streamResponse = await fetch(endpoint);
    if (!streamResponse.ok) return null;
    const stream = await streamResponse.json();
    if (!stream?.url) return null;
    state._streamCache.set(key, { url: stream.url, ts: Date.now() });
    return stream.url;
  } catch (_) {
    return null;
  }
}

function resetDeck(audio, index) {
  if (!audio) return;
  audio.pause();
  audio.removeAttribute('src');
  try { audio.load(); } catch (_) {}
  if (Number.isInteger(index)) {
    state._deckTracks[index] = null;
    state._deckGains[index] = 0;
    const graph = state._deckAudioGraphs[index];
    if (graph) {
      const now = state._audioContext.currentTime;
      graph.trackKey = '';
      graph.samples = 0;
      graph.smoothedRms = 0;
      graph.peakRms = 0;
      graph.currentGain = 1;
      graph.autoGainMaster = null;
      setAudioParamImmediately(graph.autoGain.gain, 1, now);
      setAudioParamImmediately(graph.mixGain.gain, 0, now);
      graph.appliedAutoGain = 1;
      graph.appliedMixGain = 0;
    }
  }
  audio.volume = state._deckAudioGraphs[index] ? 1 : 0;
}

function stopCrossfadeDecks() {
  state._crossfadeToken++;
  state._crossfadePrefetchToken++;
  state._deckPrepareTokens = state._deckPrepareTokens.map(token => token + 1);
  state._crossfading = false;
  state._crossfadePausedByUser = false;
  state._crossfadePending = false;
  state._crossfadeSchedule?.resolve?.(false);
  state._crossfadeSchedule = null;
  state._decks.forEach((audio, index) => resetDeck(audio, index));
  state._deckIndex = -1;
  state._deckTrack = null;
  setCrossfadeStatus(state.crossfadeSeconds > 0 ? 'armed' : 'off');
}

async function prepareCrossfadeDeck(index, ti) {
  const decks = ensureCrossfadeDecks();
  if (state.autoLevel || state.eqEnabled || state.crossfadeSeconds > 0) ensureAutoLevelAudioGraph();
  const audio = decks[index];
  if (!audio || !state.meta[ti]) return null;
  const requestToken = (state._deckPrepareTokens[index] || 0) + 1;
  state._deckPrepareTokens[index] = requestToken;
  const requestIsCurrent = () => state._deckPrepareTokens[index] === requestToken
    && state._decks[index] === audio;
  if (state._deckTracks[index] === ti && audio.currentSrc && audio.readyState >= 1) return audio;

  const streamUrl = await resolveCrossfadeStream(state.meta[ti]);
  if (!requestIsCurrent() || !streamUrl) return null;
  resetDeck(audio, index);
  audio.src = streamUrl;
  audio.preload = 'auto';
  state._deckTracks[index] = ti;
  state._deckGains[index] = 0;
  applyCachedAutoLevel(index, ti);
  syncCrossfadeVolume();
  audio.load();
  return audio;
}

function cancelCrossfadeForRecovery(activeIndex) {
  state._crossfadeToken++;
  state._crossfadePrefetchToken++;
  state._crossfadeSchedule?.resolve?.(false);
  state._crossfadeSchedule = null;
  state._crossfading = false;
  state._crossfadePausedByUser = false;
  state._crossfadePending = false;
  state._decks.forEach((audio, index) => {
    if (!audio || index === activeIndex) return;
    resetDeck(audio, index);
  });
  state._deckGains[activeIndex] = 1;
  syncCrossfadeVolume();
  setCrossfadeStatus(state.crossfadeSeconds > 0 ? 'loading' : 'off');
}

async function recoverCurrentDeckStream(audio, position, reason = 'unknown', attempt = 1) {
  const index = state._decks.indexOf(audio);
  const ti = index >= 0 ? state._deckTracks[index] : null;
  if (index < 0 || !Number.isInteger(ti) || ti !== state._deckTrack || !state.meta[ti]) return false;
  const savedTime = Math.max(0, Number(position) || 0);
  recordPlaybackDiagnostic('recovery-start', {
    reason,
    attempt,
    position: Math.round(savedTime * 10) / 10,
    readyState: Number(audio.readyState) || 0,
    networkState: Number(audio.networkState) || 0,
  });
  cancelCrossfadeForRecovery(index);
  const requestToken = (state._deckPrepareTokens[index] || 0) + 1;
  state._deckPrepareTokens[index] = requestToken;
  const streamUrl = await resolveCrossfadeStream(state.meta[ti], { forceRefresh: true });
  if (!streamUrl || state._deckPrepareTokens[index] !== requestToken
      || state._deckTracks[index] !== ti || state._deckTrack !== ti) {
    recordPlaybackDiagnostic('recovery-aborted', { reason, attempt, freshStream: Boolean(streamUrl) });
    return false;
  }
  try {
    audio.pause();
    audio.src = streamUrl;
    audio.preload = 'auto';
    audio.load();
    if (!await waitForDeck(audio, 8000)) return false;
    const duration = Number(audio.duration);
    audio.currentTime = Math.min(Number.isFinite(duration) ? Math.max(0, duration - 0.1) : savedTime, savedTime);
    await resumeAudioGraph();
    await audio.play();
    state._deckGains[index] = 1;
    syncCrossfadeVolume();
    if (state.crossfadeSeconds > 0) setCrossfadeStatus('ready');
    setTimeout(() => { void prefetchUpcomingCrossfadeTrack(); }, 0);
    recordPlaybackDiagnostic('recovery-success', {
      reason,
      attempt,
      resumedAt: Math.round((Number(audio.currentTime) || 0) * 10) / 10,
    });
    return true;
  } catch (error) {
    recordPlaybackDiagnostic('recovery-failed', {
      reason,
      attempt,
      error: String(error?.name || error || 'unknown').slice(0, 80),
    });
    return false;
  }
}

async function waitForDeck(audio, timeout = 5000) {
  if (audio.readyState >= 2) return true;
  return new Promise(resolve => {
    let settled = false;
    const finish = ok => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      audio.removeEventListener('canplay', onReady);
      audio.removeEventListener('error', onError);
      resolve(ok);
    };
    const onReady = () => finish(true);
    const onError = () => finish(false);
    const timer = setTimeout(() => finish(audio.readyState >= 2), timeout);
    audio.addEventListener('canplay', onReady, { once: true });
    audio.addEventListener('error', onError, { once: true });
  });
}

function crossfadeGains(t, curve = state.crossfadeCurve) {
  const clamped = Math.max(0, Math.min(1, t));
  if (curve === 'clean') return [1 - clamped, clamped];

  const phase = curve === 'dj'
    ? Math.max(0, Math.min(1, 0.5 + (clamped - 0.5) * 1.35))
    : clamped * clamped * (3 - 2 * clamped);
  const outgoing = Math.cos(phase * Math.PI / 2);
  const incoming = Math.sin(phase * Math.PI / 2);
  const headroom = 1 / Math.max(1, outgoing + incoming);
  return [outgoing * headroom, incoming * headroom];
}

function scheduledCrossfadeGain(index) {
  const schedule = state._crossfadeSchedule;
  const context = state._audioContext;
  if (!schedule || !context) return null;
  if (index !== schedule.outgoingIndex && index !== schedule.incomingIndex) return null;
  const elapsed = Math.max(0, context.currentTime - schedule.startTime);
  const t = Math.max(0, Math.min(1, elapsed / schedule.duration));
  const gains = crossfadeGains(t, schedule.curve);
  return index === schedule.outgoingIndex ? gains[0] : gains[1];
}

function setAudioParamImmediately(param, value, now) {
  if (!param) return false;
  const target = Number.isFinite(Number(value)) ? Number(value) : 0;
  const time = Math.max(0, Number(now) || 0);
  try {
    // Firefox cannot insert setValueAtTime into an already-running
    // setValueCurveAtTime event. Clear the whole automation timeline first,
    // including events that started before `now`.
    param.cancelScheduledValues(0);
    param.setValueAtTime(target, time);
    return true;
  } catch (_) {
    // Direct assignment is a last-resort recovery for partial Web Audio
    // implementations. Future fades no longer create curve events.
    try {
      param.value = target;
      return true;
    } catch (_) {
      return false;
    }
  }
}

function scheduleAudioParamCurve(param, values, startTime, duration) {
  // Use timeline ramps instead of setValueCurveAtTime. Firefox rejects
  // setValueAtTime/cancel operations while a curve event is active, which can
  // reject the transition promise and leave the player stuck on `mixing`.
  param.cancelScheduledValues(0);
  param.setValueAtTime(values[0], startTime);
  for (let i = 1; i < values.length; i++) {
    param.linearRampToValueAtTime(values[i], startTime + duration * (i / (values.length - 1)));
  }
}

function waitForCrossfadeSchedule(schedule, token) {
  return new Promise(resolve => {
    let settled = false;
    let lastClockValue = Number(state._audioContext?.currentTime) || 0;
    let lastClockAdvanceAt = Date.now();
    const finish = completed => {
      if (settled) return;
      settled = true;
      delete schedule.resolve;
      resolve(completed);
    };
    schedule.resolve = finish;
    const poll = () => {
      if (settled) return;
      if (token !== state._crossfadeToken || state._crossfadeSchedule !== schedule) {
        finish(false);
        return;
      }
      if (state._audioContext?.currentTime >= schedule.endTime - 0.005) {
        finish(true);
        return;
      }
      const clockValue = Number(state._audioContext?.currentTime) || 0;
      if (state._crossfadePausedByUser) {
        lastClockValue = clockValue;
        lastClockAdvanceAt = Date.now();
      } else if (clockValue > lastClockValue + 0.005) {
        lastClockValue = clockValue;
        lastClockAdvanceAt = Date.now();
      } else if (Date.now() - lastClockAdvanceAt >= 2500) {
        recordPlaybackDiagnostic('crossfade-clock-stall', {
          elapsed: Math.round(Math.max(0, clockValue - schedule.startTime) * 10) / 10,
          duration: schedule.duration,
          contextState: state._audioContext?.state || 'missing',
        });
        finish(false);
        return;
      }
      setTimeout(poll, 80);
    };
    poll();
  });
}

function settleScheduledCrossfade() {
  const schedule = state._crossfadeSchedule;
  if (!schedule || typeof schedule.resolve !== 'function') return;
  const now = Date.now();
  const clockValue = Number(state._audioContext?.currentTime) || 0;
  const incoming = state._decks[schedule.incomingIndex];
  const incomingTime = Number(incoming?.currentTime) || 0;

  if (state._crossfadePausedByUser) {
    schedule.lastClockValue = clockValue;
    schedule.lastClockAdvanceAt = now;
    schedule.lastIncomingTime = incomingTime;
    schedule.lastIncomingAdvanceAt = now;
    return;
  }

  if (incoming?.paused && !incoming.ended && now - (schedule.createdAt || now) >= 350) {
    if (!schedule.faultRecorded) {
      schedule.faultRecorded = true;
      recordPlaybackDiagnostic('crossfade-deck-paused', playbackDiagnosticSnapshot('incoming-deck-paused'));
    }
    schedule.resolve(false);
    return;
  }

  if (clockValue >= schedule.endTime - 0.005) {
    schedule.resolve(true);
    return;
  }

  if (clockValue > (schedule.lastClockValue ?? clockValue) + 0.005) {
    schedule.lastClockValue = clockValue;
    schedule.lastClockAdvanceAt = now;
  }
  if (incomingTime > (schedule.lastIncomingTime ?? incomingTime) + 0.02) {
    schedule.lastIncomingTime = incomingTime;
    schedule.lastIncomingAdvanceAt = now;
  }

  const clockStalledFor = now - (schedule.lastClockAdvanceAt || schedule.createdAt || now);
  const mediaStalledFor = now - (schedule.lastIncomingAdvanceAt || schedule.createdAt || now);
  if (clockStalledFor >= 2500 && mediaStalledFor >= 2500) {
    if (!schedule.faultRecorded) {
      schedule.faultRecorded = true;
      recordPlaybackDiagnostic('crossfade-clock-stall', playbackDiagnosticSnapshot('worker-clock-stall'));
    }
    schedule.resolve(false);
  }
}

function animateDeckCrossfadeFallback(outgoing, incoming, seconds, token) {
  const duration = Math.max(0.25, seconds);
  const startedAt = Number(incoming.currentTime) || 0;
  const startedWallAt = Date.now();
  const outgoingIndex = state._decks.indexOf(outgoing);
  const incomingIndex = state._decks.indexOf(incoming);
  const curve = state.crossfadeCurve;
  return new Promise(resolve => {
    const poll = () => {
      if (token !== state._crossfadeToken) { resolve(false); return; }
      if (Date.now() - startedWallAt > (duration + 5) * 1000) { resolve(false); return; }
      const elapsed = Math.max(0, (Number(incoming.currentTime) || startedAt) - startedAt);
      const t = Math.max(0, Math.min(1, elapsed / duration));
      const [outgoingGain, incomingGain] = crossfadeGains(t, curve);
      state._deckGains[outgoingIndex] = outgoingGain;
      state._deckGains[incomingIndex] = incomingGain;
      syncCrossfadeVolume();
      if (t >= 1) { resolve(true); return; }
      setTimeout(poll, 50);
    };
    poll();
  });
}

async function animateDeckCrossfade(outgoing, incoming, seconds, token) {
  const duration = Math.max(0.25, seconds);
  const outgoingIndex = state._decks.indexOf(outgoing);
  const incomingIndex = state._decks.indexOf(incoming);
  const curve = state.crossfadeCurve;
  state._crossfading = true;
  state._crossfadePausedByUser = false;
  setCrossfadeStatus('mixing');

  const graphReady = ensureAutoLevelAudioGraph()
    && state._deckAudioGraphs[outgoingIndex]
    && state._deckAudioGraphs[incomingIndex]
    && await resumeAudioGraph();

  let completed = false;
  if (graphReady) {
    const context = state._audioContext;
    const startTime = context.currentTime + 0.015;
    const steps = 129;
    const outgoingValues = new Float32Array(steps);
    const incomingValues = new Float32Array(steps);
    for (let i = 0; i < steps; i++) {
      const [outGain, inGain] = crossfadeGains(i / (steps - 1), curve);
      outgoingValues[i] = outGain;
      incomingValues[i] = inGain;
    }
    const schedule = {
      token, outgoingIndex, incomingIndex, curve,
      startTime, duration, endTime: startTime + duration,
      createdAt: Date.now(),
      lastClockValue: context.currentTime,
      lastClockAdvanceAt: Date.now(),
      lastIncomingTime: Number(incoming.currentTime) || 0,
      lastIncomingAdvanceAt: Date.now(),
      faultRecorded: false,
    };
    state._crossfadeSchedule = schedule;
    scheduleAudioParamCurve(state._deckAudioGraphs[outgoingIndex].mixGain.gain, outgoingValues, startTime, duration);
    scheduleAudioParamCurve(state._deckAudioGraphs[incomingIndex].mixGain.gain, incomingValues, startTime, duration);
    completed = await waitForCrossfadeSchedule(schedule, token);
  } else {
    completed = await animateDeckCrossfadeFallback(outgoing, incoming, duration, token);
  }

  if (!completed || token !== state._crossfadeToken) {
    if (token !== state._crossfadeToken) return false;

    // Firefox can leave a running media element attached to a suspended Web
    // Audio clock. Never leave next() waiting forever: promote the incoming
    // deck to full gain and resume it instead of dropping into native playback.
    state._crossfadeSchedule = null;
    const context = state._audioContext;
    const now = context?.currentTime || 0;
    const outgoingGraph = state._deckAudioGraphs[outgoingIndex];
    const incomingGraph = state._deckAudioGraphs[incomingIndex];
    setAudioParamImmediately(outgoingGraph?.mixGain.gain, 0, now);
    setAudioParamImmediately(incomingGraph?.mixGain.gain, 1, now);
    state._deckGains[outgoingIndex] = 0;
    state._deckGains[incomingIndex] = 1;
    outgoing.pause();
    if (!state._crossfadePausedByUser && incoming.paused) {
      await resumeAudioGraph();
      try { await incoming.play(); } catch (_) {
        recordPlaybackDiagnostic('crossfade-handoff-failed', playbackDiagnosticSnapshot('incoming-resume-rejected'));
        const recovered = await recoverCurrentDeckStream(
          incoming,
          Number(incoming.currentTime) || 0,
          'crossfade-handoff',
          1,
        );
        if (!recovered) {
          state._crossfading = false;
          setCrossfadeStatus('fallback');
          return false;
        }
      }
    }
    syncCrossfadeVolume();
    state._crossfading = false;
    state._crossfadePausedByUser = false;
    setCrossfadeStatus('ready');
    return true;
  }
  state._crossfadeSchedule = null;
  outgoing.pause();
  state._deckGains[outgoingIndex] = 0;
  state._deckGains[incomingIndex] = 1;
  syncCrossfadeVolume();
  state._crossfading = false;
  state._crossfadePausedByUser = false;
  setCrossfadeStatus('ready');
  return true;
}

async function prefetchUpcomingCrossfadeTrack() {
  if (!state.active || state._crossfading) return;
  const nextTi = upcomingTrackIndex();
  if (nextTi === undefined) return;
  const standby = state._deckIndex === 0 ? 1 : 0;
  const requestToken = ++state._crossfadePrefetchToken;
  if (state.crossfadeSeconds > 0) setCrossfadeStatus('loading');
  const audio = await prepareCrossfadeDeck(standby, nextTi);
  if (requestToken !== state._crossfadePrefetchToken
      || !state.active
      || state._crossfading
      || standby === state._deckIndex
      || upcomingTrackIndex() !== nextTi) return;
  if (state.crossfadeSeconds > 0) setCrossfadeStatus(audio ? 'ready' : 'fallback');
}

function upcomingCrossfadeDeckReady() {
  const nextTi = upcomingTrackIndex();
  if (nextTi === undefined) return false;
  const standby = state._deckIndex === 0 ? 1 : 0;
  const audio = state._decks[standby];
  return Boolean(audio && state._deckTracks[standby] === nextTi && audio.readyState >= 2);
}

function upcomingTrackIndex() {
  return state.playNext.length ? state.playNext[0] : state.queue[state.pos + 1];
}

function refreshUpcomingCrossfadePreparation() {
  state._crossfadePrefetchToken++;
  const standby = state._deckIndex === 0 ? 1 : 0;
  if (standby < 0 || standby >= state._decks.length) return;

  state._deckPrepareTokens[standby] = (state._deckPrepareTokens[standby] || 0) + 1;
  if (state._crossfading || standby === state._deckIndex) return;

  const nextTi = upcomingTrackIndex();
  if (state._deckTracks[standby] !== null && state._deckTracks[standby] !== nextTi) {
    resetDeck(state._decks[standby], standby);
  }
  if (state.active && currentDeckAudio()) void prefetchUpcomingCrossfadeTrack();
}

async function playWithCrossfadeDeck(ti, countPlay, requestedFade) {
  const outgoing = currentDeckAudio();
  const outgoingIndex = state._deckIndex;
  const incomingIndex = outgoingIndex === 0 ? 1 : 0;
  if (state.crossfadeSeconds > 0) setCrossfadeStatus('loading');
  const incoming = await prepareCrossfadeDeck(incomingIndex, ti);
  if (!incoming || !await waitForDeck(incoming)) {
    if (state.crossfadeSeconds > 0) setCrossfadeStatus('fallback');
    return false;
  }

  const canMix = Boolean(outgoing && !outgoing.paused && !outgoing.ended && requestedFade > 0);
  const token = ++state._crossfadeToken;
  incoming.currentTime = 0;
  state._deckGains[incomingIndex] = canMix ? 0 : 1;
  if (Number.isInteger(outgoingIndex) && outgoingIndex >= 0 && !canMix) {
    state._deckGains[outgoingIndex] = 0;
  }
  syncCrossfadeVolume();
  pauseSoundCloudTransport();
  pauseSoundCloud();
  await resumeAudioGraph();
  try {
    await incoming.play();
  } catch (_) {
    if (state.crossfadeSeconds > 0) setCrossfadeStatus('fallback');
    return false;
  }

  state._deckIndex = incomingIndex;
  state._deckTrack = ti;
  installBetterFeedPipBridge();
  if (!canMix) {
    state._deckGains[incomingIndex] = 1;
    syncCrossfadeVolume();
  }
  state.lastTitle = state.meta[ti]?.title || '';
  state.lastProgress = 0;
  if (countPlay) trackPlayed(ti);

  if (canMix) {
    await animateDeckCrossfade(outgoing, incoming, requestedFade, token);
    resetDeck(outgoing, outgoingIndex);
  } else if (outgoing && outgoing !== incoming) {
    resetDeck(outgoing, outgoingIndex);
    if (state.crossfadeSeconds > 0) setCrossfadeStatus('ready');
  } else {
    if (state.crossfadeSeconds > 0) setCrossfadeStatus('ready');
  }

  setTimeout(() => { void prefetchUpcomingCrossfadeTrack(); }, 0);
  setTimeout(() => { refreshPlayBtn(); updateProgressBar(); updateHub(); }, 80);
  return true;
}

function trackPlayed(ti) {
  state.stats.played++;
  state.stats.playCounts[ti] = (state.stats.playCounts[ti] || 0) + 1;
}

function consumeCurrentQueueTrack() {
  const justPlayed = state.queue[state.pos];
  if (justPlayed === undefined) return undefined;

  state.history.push(justPlayed);
  if (state.history.length > 100) state.history.shift();

  // Spotify-style shuffle: each track plays exactly once per round.
  // The played track is removed and NOT re-inserted; only when the
  // whole round is exhausted do we reshuffle everything for a new round.
  state.queue.splice(state.pos, 1);
  state.roundPlayed = Math.min(state.roundTotal, state.roundPlayed + 1);
  if (state.meta[justPlayed]?.removedFromPlaylist) {
    state.meta[justPlayed].unavailable = true;
  }

  const remaining = state.queue.length - state.pos;
  if (!state.stopAfterRound && remaining <= 0) {
    const aliveIndices = [...Array(state.meta.length).keys()].filter(trackAvailable);
    state.queue = buildBalancedRound(aliveIndices, justPlayed);
    state.pos = 0;
    state.roundPlayed = 0;
    state.roundTotal = state.queue.length;
  }

  if (state.playNext.length > 0) {
    const ti = state.playNext.shift();
    const dup = state.queue.indexOf(ti);
    if (dup !== -1) {
      state.queue.splice(dup, 1);
      if (dup < state.pos) state.pos--;
    }
    state.queue.splice(state.pos, 0, ti);
  }

  return justPlayed;
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

function cancelInternalNavigation() {
  state._internalNavigationToken++;
  state._internalNavigation = false;
  state._internalNavigationTarget = '';
}

async function loadTrackSourcePage(idx) {
  const sourcePage = state.meta[idx]?.sourcePage;
  if (!sourcePage || playlistBase(sourcePage) === playlistBase(location.href)) return false;

  const navigationToken = ++state._internalNavigationToken;
  state._internalNavigation = true;
  state._internalNavigationTarget = sourcePage;
  state.suspended = true;
  updateHub();
  navigateToPage(sourcePage);

  try {
    for (let i = 0; i < 40; i++) {
      if (!state.active || navigationToken !== state._internalNavigationToken) return false;
      if (playlistBase(location.href) === playlistBase(sourcePage)) break;
      await wait(250);
    }
    if (playlistBase(location.href) !== playlistBase(sourcePage)) return false;

    const pageEls = await loadTracks();
    if (!state.active || navigationToken !== state._internalNavigationToken
        || playlistBase(location.href) !== playlistBase(sourcePage) || !pageEls.length) return false;
    bindCurrentPageElements(pageEls);
    state.suspended = false;
    state.playlistUrl = sourcePage;
    return Boolean(state.els[idx] && document.body.contains(state.els[idx]));
  } finally {
    if (navigationToken === state._internalNavigationToken) {
      state._internalNavigation = false;
      state._internalNavigationTarget = '';
    }
    updateHub();
  }
}

async function playAt(idx, countPlay = true) {
  if (!state.active) return;
  clearNativePlaybackFallback();

  let el = state.els[idx];
  if ((!el || !document.body.contains(el)) && state.meta[idx]?.link) {
    const requestedFade = currentDeckAudio()
      ? (state._crossfadePending
        ? Math.min(state.crossfadeSeconds, Number(state._crossfadePending) || state.crossfadeSeconds)
        : (state.crossfadeManual ? state.crossfadeSeconds : 0))
      : 0;
    if (await playWithCrossfadeDeck(idx, countPlay, requestedFade)) return;
  }
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
    refreshUpcomingCrossfadePreparation();
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

  {
    const requestedFade = currentDeckAudio()
      ? (state._crossfadePending
        ? Math.min(state.crossfadeSeconds, Number(state._crossfadePending) || state.crossfadeSeconds)
        : (state.crossfadeManual ? state.crossfadeSeconds : 0))
      : 0;
    if (await playWithCrossfadeDeck(idx, countPlay, requestedFade)) return;
    stopCrossfadeDecks();
    setCrossfadeStatus('fallback');
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
    clearNativePlaybackFallback();
    if (!wasPaused && paused()) toggle();
    state.busy = false;
    showMergeToast('play button not found for this track');
    return;
  }
  beginNativePlaybackFallback(idx);
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

  consumeCurrentQueueTrack();

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
  state.roundPlayed = Math.max(0, state.roundPlayed - 1);
  refreshUpcomingCrossfadePreparation();

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
  refreshUpcomingCrossfadePreparation();
  return true;
}

function removePlayNextOccurrences(ti) {
  const remaining = state.playNext.filter(pendingTi => pendingTi !== ti);
  if (remaining.length === state.playNext.length) return false;
  state.playNext = remaining;
  refreshUpcomingCrossfadePreparation();
  return true;
}

async function jumpTo(qi, ti) {
  if (!state.active) return;
  if (state.busy) return;
  state.busy         = true;
  state.manualAction = true;
  state._manualActionAt = Date.now();
  state.suspended    = false;
  const removedPlayNext = removePlayNextOccurrences(ti);

  if (!moveSelectedTrackToCurrent(ti)) {
    await playAt(ti, false);
    if (removedPlayNext) renderList();
    state.busy = false;
    return;
  }
  await playAt(ti);
  badges();
  renderList();
  state.busy = false;
}

function queueNext(ti) {
  const currentTi = Number.isInteger(state._deckTrack) ? state._deckTrack : state.queue[state.pos];
  if (ti === currentTi || state.playNext.includes(ti)) return false;
  const reintroducesPlayedTrack = state.history.includes(ti)
    && !state.queue.slice(state.pos + 1).includes(ti);
  state.playNext.push(ti);
  if (reintroducesPlayedTrack) state.roundTotal++;
  refreshUpcomingCrossfadePreparation();
  renderList();
  return true;
}

function removeTrackFromUpcoming(ti) {
  const currentTi = Number.isInteger(state._deckTrack) ? state._deckTrack : state.queue[state.pos];
  if (ti === currentTi) return false;

  const remainingPlayNext = state.playNext.filter(pendingTi => pendingTi !== ti);
  const removedPlayNext = remainingPlayNext.length !== state.playNext.length;
  const qi = state.queue.findIndex((queuedTi, index) => index > state.pos && queuedTi === ti);
  if (!removedPlayNext && qi === -1) return false;

  state.playNext = remainingPlayNext;
  if (qi !== -1) {
    state.queue.splice(qi, 1);
    state.roundTotal = Math.max(state.roundPlayed + 1, state.roundTotal - 1);
  } else if (removedPlayNext && state.history.includes(ti)) {
    state.roundTotal = Math.max(state.roundPlayed + 1, state.roundTotal - 1);
  }
  refreshUpcomingCrossfadePreparation();
  if (qi !== -1) badges();
  renderList();
  return true;
}

function removeFromQueue(qi) {
  if (qi === state.pos) return;
  state.queue.splice(qi, 1);
  if (qi >= state.pos) state.roundTotal = Math.max(state.roundPlayed + 1, state.roundTotal - 1);
  if (qi < state.pos) state.pos--;
  refreshUpcomingCrossfadePreparation();
  badges();
  renderList();
}

async function fetchLivePlaylistSnapshot(sourcePage) {
  if (!/soundcloud\.com\/[^/]+\/sets\//.test(sourcePage || '')) return null;
  try {
    const requestUrl = new URL(sourcePage);
    requestUrl.searchParams.set('_tss_live_sync', String(Date.now()));
    const response = await fetch(requestUrl, {
      cache: 'no-store',
      credentials: 'include',
      headers: { Accept: 'text/html' },
    });
    if (!response.ok) return null;
    return playlistSnapshotFromHtml(await response.text());
  } catch (_) {
    return null;
  }
}

async function resolveLiveTrackMeta(track, sourcePage, playlistPosition = null) {
  const hydrated = metaFromSoundCloudTrack(track, sourcePage, playlistPosition);
  if (hydrated) return hydrated;

  const id = Number(track?.id);
  if (!Number.isFinite(id)) return null;
  const clientId = await discoverSoundCloudClientIdFromBundle();
  if (!clientId) return null;
  try {
    const response = await fetch(`https://api-v2.soundcloud.com/tracks/${id}?client_id=${encodeURIComponent(clientId)}`);
    if (!response.ok) return null;
    return metaFromSoundCloudTrack(await response.json(), sourcePage, playlistPosition);
  } catch (_) {
    return null;
  }
}

async function resolvePlaylistSnapshotMetas(snapshot, sourcePage) {
  if (!snapshot?.tracks?.length) return [];
  const resolvedById = new Map();
  const unresolvedIds = [];

  snapshot.tracks.forEach((track, index) => {
    const meta = metaFromSoundCloudTrack(track, sourcePage, index + 1);
    if (meta) resolvedById.set(Number(track.id), meta);
    else unresolvedIds.push(Number(track.id));
  });

  if (unresolvedIds.length) {
    const clientId = await discoverSoundCloudClientIdFromBundle();
    if (clientId) {
      for (let start = 0; start < unresolvedIds.length; start += 50) {
        const ids = unresolvedIds.slice(start, start + 50);
        try {
          const endpoint = new URL('https://api-v2.soundcloud.com/tracks');
          endpoint.searchParams.set('ids', ids.join(','));
          endpoint.searchParams.set('client_id', clientId);
          const response = await fetch(endpoint);
          if (!response.ok) continue;
          const tracks = await response.json();
          if (!Array.isArray(tracks)) continue;
          tracks.forEach(track => {
            const position = snapshot.tracks.findIndex(item => Number(item.id) === Number(track?.id)) + 1;
            const meta = metaFromSoundCloudTrack(track, sourcePage, position);
            if (meta) resolvedById.set(Number(track.id), meta);
          });
        } catch (_) {}
      }
    }
  }

  return snapshot.tracks
    .map(track => resolvedById.get(Number(track.id)) || null)
    .filter(Boolean);
}

async function completePlaylistCollection(sourcePage, pageEls, snapshotPromise = null) {
  const domMeta = pageEls.map(getMeta);
  if (!/soundcloud\.com\/[^/]+\/sets\//.test(sourcePage || '')) {
    return { els: pageEls, meta: domMeta, complete: true };
  }

  const snapshot = await (snapshotPromise || fetchLivePlaylistSnapshot(sourcePage));
  if (!snapshot?.complete || snapshot.tracks.length <= domMeta.length) {
    return { els: pageEls, meta: domMeta, complete: Boolean(snapshot?.complete) };
  }

  const snapshotMeta = await resolvePlaylistSnapshotMetas(snapshot, sourcePage);
  if (snapshotMeta.length !== snapshot.tracks.length) {
    return { els: pageEls, meta: domMeta, complete: false };
  }

  const elementsByLink = new Map();
  pageEls.forEach(el => {
    const id = trackId(getMeta(el));
    if (id && !elementsByLink.has(id)) elementsByLink.set(id, el);
  });
  return {
    els: snapshotMeta.map(meta => elementsByLink.get(trackId(meta)) || null),
    meta: snapshotMeta,
    complete: true,
  };
}

function applyLiveQueueTracks(metas, pageEls = [], notify = true) {
  if (!state.active || state.suspended || !Array.isArray(metas) || !metas.length) return 0;

  const existingById = new Map();
  state.meta.forEach((meta, ti) => {
    const id = trackId(meta);
    if (id) existingById.set(id, ti);
  });
  const elementsById = new Map();
  pageEls.forEach(el => {
    const id = trackId(getMeta(el));
    if (id && !elementsById.has(id)) elementsById.set(id, el);
  });

  const added = [];
  for (const meta of metas) {
    const id = trackId(meta);
    if (!id || existingById.has(id)) continue;
    const ti = state.meta.length;
    state.meta.push(meta);
    state.els.push(elementsById.get(id) || null);
    existingById.set(id, ti);
    added.push(ti);
  }
  if (!added.length) return 0;

  insertTracksRandomlyAfterCurrent(state.queue, state.pos, fisherYates(added));
  state.roundTotal += added.length;
  refreshUpcomingCrossfadePreparation();
  badges();
  renderList();
  updateHub();
  if (notify) showMergeToast(`${added.length} new track${added.length === 1 ? '' : 's'} added to this round`);
  return added.length;
}

function reconcileLivePlaylistSnapshot(snapshot, sourcePage, pageEls = []) {
  const snapshotIds = new Set(snapshot.tracks.map(track => Number(track.id)));
  const positions = new Map(snapshot.tracks.map((track, index) => [Number(track.id), index + 1]));
  const elementsByLink = new Map();
  pageEls.forEach(el => {
    const id = trackId(getMeta(el));
    if (id && !elementsByLink.has(id)) elementsByLink.set(id, el);
  });

  const currentTi = Number.isInteger(state._deckTrack) ? state._deckTrack : state.queue[state.pos];
  let removed = 0;
  let removedFromRound = 0;

  for (const knownId of snapshot.complete === false ? [] : [...state._liveSyncKnownIds]) {
    if (snapshotIds.has(knownId)) continue;
    state._liveSyncKnownIds.delete(knownId);
    const ti = state.meta.findIndex(meta => Number(meta?.soundcloudId) === knownId
      && playlistBase(meta?.sourcePage || '') === playlistBase(sourcePage));
    if (ti === -1) continue;

    const meta = state.meta[ti];
    meta.removedFromPlaylist = true;
    if (ti !== currentTi) meta.unavailable = true;
    state.els[ti] = null;

    let removedQueued = 0;
    for (let qi = state.queue.length - 1; qi >= 0; qi--) {
      if (state.queue[qi] !== ti || qi === state.pos) continue;
      if (qi >= state.pos) removedQueued++;
      state.queue.splice(qi, 1);
      if (qi < state.pos) state.pos = Math.max(0, state.pos - 1);
    }
    const hadPlayNext = state.playNext.includes(ti);
    state.playNext = state.playNext.filter(pendingTi => pendingTi !== ti);
    removedFromRound += removedQueued;
    if (!removedQueued && hadPlayNext && state.history.includes(ti)) removedFromRound++;
    removed++;
  }

  state.meta.forEach((meta, ti) => {
    const id = Number(meta?.soundcloudId);
    if (!snapshotIds.has(id)) return;
    meta.playlistPosition = positions.get(id);
    if (playlistBase(meta.sourcePage || '') !== playlistBase(sourcePage)) return;
    delete meta.removedFromPlaylist;
    delete meta.unavailable;
    const el = elementsByLink.get(trackId(meta));
    if (el) state.els[ti] = el;
  });

  if (removedFromRound) {
    const minimum = state.roundPlayed + (state.queue[state.pos] === undefined ? 0 : 1);
    state.roundTotal = Math.max(minimum, state.roundTotal - removedFromRound);
  }
  return removed;
}

function showLiveSyncResult(added, removed) {
  const parts = [];
  if (added) parts.push(`${added} new track${added === 1 ? '' : 's'} added`);
  if (removed) parts.push(`${removed} track${removed === 1 ? '' : 's'} removed`);
  if (parts.length) showMergeToast(`${parts.join(', ')} in this round`);
}

async function syncLiveQueue(options) {
  options = options || {};
  const sourcePage = String(state.playlistUrl || '').split(/[?#]/)[0].replace(/\/+$/, '');
  if (!state.active || state.loading || state.busy || state.suspended
      || !/soundcloud\.com\/[^/]+\/sets\//.test(sourcePage)) return 0;
  if (state._liveSyncInFlight) return 0;

  const now = Date.now();
  if (!options.force && now - state._liveSyncLastCheck < LIVE_SYNC_INTERVAL_MS) return 0;
  state._liveSyncInFlight = true;
  state._liveSyncLastCheck = now;
  try {
    const snapshot = await fetchLivePlaylistSnapshot(sourcePage);
    if (!snapshot?.tracks?.length || !state.active || state.playlistUrl.split(/[?#]/)[0].replace(/\/+$/, '') !== sourcePage) return 0;

    const pageEls = playlistBase(location.href) === playlistBase(sourcePage)
      ? [...document.querySelectorAll('.trackList__item, .soundList__item, li.sc-list-item')]
      : [];
    const sourceChanged = state._liveSyncSource !== sourcePage;
    const initializing = sourceChanged || !state._liveSyncKnownIds.size;
    if (initializing) {
      state._liveSyncSource = sourcePage;
      state._liveSyncKnownIds = new Set();
      const sourceIndices = state.meta
        .map((meta, ti) => ({ meta, ti }))
        .filter(item => playlistBase(item.meta?.sourcePage || sourcePage) === playlistBase(sourcePage));
      sourceIndices.forEach(({ meta }) => {
        const id = Number(meta?.soundcloudId);
        if (Number.isFinite(id)) state._liveSyncKnownIds.add(id);
      });
      if (snapshot.tracks.length === sourceIndices.length) {
        snapshot.tracks.forEach((track, index) => {
          const meta = state.meta[sourceIndices[index].ti];
          if (!Number.isFinite(Number(meta.soundcloudId))) meta.soundcloudId = Number(track.id);
          meta.playlistPosition = index + 1;
          if (Number(meta.soundcloudId) === Number(track.id)) {
            state._liveSyncKnownIds.add(Number(track.id));
          }
        });
      }
    }

    const removed = reconcileLivePlaylistSnapshot(snapshot, sourcePage, pageEls);
    const candidates = snapshot.tracks.filter(track => !state._liveSyncKnownIds.has(Number(track.id)));
    if (!candidates.length) {
      if (removed) {
        refreshUpcomingCrossfadePreparation();
        badges();
        renderList();
        updateHub();
        showLiveSyncResult(0, removed);
      } else {
        badges();
        if (initializing) renderList();
      }
      return 0;
    }

    const metas = [];
    for (const track of candidates) {
      const playlistPosition = snapshot.tracks.findIndex(item => Number(item.id) === Number(track.id)) + 1;
      const meta = await resolveLiveTrackMeta(track, sourcePage, playlistPosition);
      if (meta) metas.push(meta);
    }
    if (!state.active || state.suspended) return 0;

    const added = applyLiveQueueTracks(metas, pageEls, false);
    for (const meta of metas) {
      const id = Number(meta?.soundcloudId);
      const represented = Number.isFinite(id) && state.meta.some(existing =>
        Number(existing?.soundcloudId) === id
        && playlistBase(existing?.sourcePage || sourcePage) === playlistBase(sourcePage));
      if (represented) state._liveSyncKnownIds.add(id);
    }
    if (removed && !added) {
      refreshUpcomingCrossfadePreparation();
      badges();
      renderList();
      updateHub();
    } else if (initializing && !added) {
      badges();
      renderList();
    }
    showLiveSyncResult(added, removed);
    return added;
  } finally {
    state._liveSyncInFlight = false;
  }
}

function resetLiveQueueSync() {
  if (state._liveSyncTimer) clearTimeout(state._liveSyncTimer);
  state._liveSyncKnownIds = new Set();
  state._liveSyncInFlight = false;
  state._liveSyncLastCheck = 0;
  state._liveSyncSource = '';
  state._liveSyncTimer = null;
}

async function mergeCurrentPage() {
  if (!state.active) { showMergeToast(-1); return; }

  const btn = document.getElementById('tss-merge-btn');
  if (btn) { btn.style.opacity = '0.35'; btn.style.pointerEvents = 'none'; }

  const pageUrl = location.href.split(/[?#]/)[0].replace(/\/+$/, '');
  const snapshotPromise = /soundcloud\.com\/[^/]+\/sets\//.test(pageUrl)
    ? fetchLivePlaylistSnapshot(pageUrl)
    : null;
  const pageEls = await loadTracks();
  const collection = await completePlaylistCollection(pageUrl, pageEls, snapshotPromise);

  if (btn) { btn.style.opacity = ''; btn.style.pointerEvents = ''; }

  if (!state.active) return;
  if (!collection.meta.length) { showMergeToast(0); return; }

  const existingById = new Map();
  state.meta.forEach((m, ti) => {
    const id = trackId(m);
    if (id) existingById.set(id, ti);
  });
  const added = [];

  collection.meta.forEach((m, index) => {
    const el = collection.els[index] || null;
    const id = trackId(m);
    if (id && existingById.has(id)) {
      const ti = existingById.get(id);
      if (el) state.els[ti] = el;
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
    refreshUpcomingCrossfadePreparation();

    // adopt this page as the active playlist context and resume
    state.playlistUrl = location.href.split(/[?#]/)[0];
    state.suspended   = false;
    state.lastTitle   = playerTitle();
    resetLiveQueueSync();
    void syncLiveQueue({ force: true });

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
      const alive = [...Array(state.meta.length).keys()].filter(trackAvailable);
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
      refreshUpcomingCrossfadePreparation();
      badges();
      renderList();
      updateHub();
      showMergeToast(`${Math.max(0, state.queue.length - 1)} upcoming tracks reshuffled`);
      return;
    }

    state.loading = true;
    state.busy = true;
    updateHub();
    const snapshotPromise = /soundcloud\.com\/[^/]+\/sets\//.test(pageUrl)
      ? fetchLivePlaylistSnapshot(pageUrl)
      : null;
    const pageEls = await loadTracks();
    const collection = await completePlaylistCollection(pageUrl, pageEls, snapshotPromise);
    if (!collection.meta.length) {
      showMergeToast('no tracks found on this page');
      return;
    }

    const newQueue = buildReshuffledQueue([...Array(collection.meta.length).keys()]);
    if (!newQueue.length) {
      showMergeToast('no tracks found on this page');
      return;
    }

    state.els = collection.els;
    state.meta = collection.meta;
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
    refreshUpcomingCrossfadePreparation();
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

function remapCachedQueue(cache, meta) {
  const idToNew = {};
  meta.forEach((m, ti) => { const id = trackId(m); if (id) idToNew[id] = ti; });

  const metaKeys = cache.metaKeys;
  const remapOld = oldTi => {
    const id = metaKeys[oldTi];
    return (id && idToNew[id] !== undefined) ? idToNew[id] : null;
  };
  const remappedQueue = cache.queue.map(remapOld).filter(ti => ti !== null);
  if (!remappedQueue.length) return null;

  // A snapshot contains only the unplayed part of the current round. Add
  // genuinely new playlist entries, never old entries already consumed.
  const cachedIds = new Set(metaKeys.filter(Boolean));
  const extras = fisherYates([...Array(meta.length).keys()].filter(ti => {
    const id = trackId(meta[ti]);
    return !id || !cachedIds.has(id);
  }));
  const finalQueue = remappedQueue.concat(extras);

  const cachedPos = typeof cache.pos === 'number' ? cache.pos : 0;
  const posId = metaKeys[cache.queue[cachedPos]] || '';
  let newPos = finalQueue.findIndex(newTi => trackId(meta[newTi]) === posId);
  if (newPos === -1) newPos = 0;

  const history = (Array.isArray(cache.history) ? cache.history : [])
    .map(remapOld).filter(ti => ti !== null);
  const priority = {};
  for (const [key, weight] of Object.entries(cache.priority || {})) {
    const newTi = remapOld(+key);
    if (newTi !== null) priority[newTi] = weight;
  }

  return {
    queue: finalQueue,
    pos: newPos,
    history,
    priority,
    roundPlayed: Math.max(0, Number(cache.roundPlayed) || 0),
    roundTotal: Math.max(finalQueue.length, Number(cache.roundTotal) || finalQueue.length),
  };
}

async function start() {
  if (!validPage()) return;

  if (state.active) {
    stop();
    renderList();
    return;
  }

  state.loading = true;
  pauseSoundCloudTransport();
  pauseSoundCloud();
  updateHub();

  const pageUrl = location.href.split(/[?#]/)[0].replace(/\/+$/, '');
  const snapshotPromise = /soundcloud\.com\/[^/]+\/sets\//.test(pageUrl)
    ? fetchLivePlaylistSnapshot(pageUrl)
    : null;
  const pageEls = await loadTracks();
  const collection = await completePlaylistCollection(pageUrl, pageEls, snapshotPromise);
  if (!collection.meta.length || playlistBase(location.href) !== playlistBase(pageUrl)) {
    state.loading = false;
    updateHub();
    return;
  }

  state.els  = collection.els;
  state.meta = collection.meta;

  let _cached = null;
  try {
    const _raw = sessionStorage.getItem('tss_queue_cache');
    if (_raw) {
      const _c = JSON.parse(_raw);
      if (Date.now() - (_c.ts || 0) < 30 * 60 * 1000
          && playlistBase(location.href) === playlistBase(_c.playlistUrl || '')
          && Array.isArray(_c.queue) && _c.queue.length > 0
          && Array.isArray(_c.metaKeys)) {

        const restored = remapCachedQueue(_c, state.meta);
        if (restored) {
          sessionStorage.removeItem('tss_queue_cache');
          _cached = restored;
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
    state.queue    = fisherYates([...Array(state.meta.length).keys()]);
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

  initializePlaybackVolume();
  await playAt(state.queue[state.pos]);
  if (!state.active) return;
  badges();
  renderList();
  startWatcher();
  updateHub();
  void syncLiveQueue({ force: true });
}

function stop() {
  closeOwnPip();
  clearNativePlaybackFallback();
  stopCrossfadeDecks();
  state.active     = false;
  state.busy       = false;
  state.loading    = false;
  state.sleepTimer = null;
  syncBrowserNowPlaying();
  resetLiveQueueSync();
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
  const deckStall = { deck: null, current: 0, observedAt: 0, stalledSince: 0, recoveryAttempts: 0, recovering: false };
  const resetDeckStall = (deck = null, current = 0, now = Date.now()) => {
    deckStall.deck = deck;
    deckStall.current = current;
    deckStall.observedAt = now;
    deckStall.stalledSince = 0;
    deckStall.recoveryAttempts = 0;
    deckStall.recovering = false;
  };

  const deckHasBufferedAhead = (deck, current, seconds = 1) => {
    try {
      for (let i = 0; i < deck.buffered.length; i++) {
        if (deck.buffered.start(i) <= current + 0.05
            && deck.buffered.end(i) >= current + seconds) return true;
      }
    } catch (_) {}
    return false;
  };

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

  const returnToQueuePage = (consumeCurrent = false) => {
    if (consumeCurrent) consumeCurrentQueueTrack();

    const worker = state.worker;
    state.worker = null;
    if (worker) worker.terminate();
    if (state._workerInterval) { clearInterval(state._workerInterval); state._workerInterval = null; }
    if (state._endedHandler) {
      document.removeEventListener('ended', state._endedHandler, true);
      state._endedHandler = null;
    }

    try {
      if (state.queue.length) {
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
      } else {
        sessionStorage.removeItem('tss_queue_cache');
      }
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
          returnToQueuePage(true);
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
    if (e.target?.tagName !== 'AUDIO') return;
    if (Number.isInteger(state._deckTrack) && e.target !== currentDeckAudio()) return;
    void advanceAtNaturalEnd();
  };
  state._endedHandler = onMediaEnded;
  document.addEventListener('ended', onMediaEnded, true);

  const tick = async () => {
    if (!state.active) return;
    if (checkSleepTimerDeadline()) return;
    if (!state.busy && Number.isFinite(state._liveSyncLastCheck)
        && Date.now() - state._liveSyncLastCheck >= LIVE_SYNC_INTERVAL_MS) {
      void syncLiveQueue();
    }

    // Better SoundCloud Feed discovers scPlayer asynchronously and may replace
    // the object after True Shuffle started, so re-check the cheap bridge guard.
    installBetterFeedPipBridge();

    // Worker ticks continue in background tabs and release next() as soon as
    // Web Audio's independent clock reaches the end of the scheduled fade.
    settleScheduledCrossfade();

    // A manual transition normally clears when the title changes. Tracks can
    // legitimately share the same displayed title, so never keep the guard
    // alive long enough to swallow the next natural end.
    if (state.manualAction && Date.now() - state._manualActionAt > 3000) {
      state.manualAction = false;
    }

    // End detection runs at 50 ms; visual refreshes keep their old cadence.
    if (++uiTicks >= 6) {
      uiTicks = 0;
      syncPlaybackVolumeFromSoundCloud();
      refreshPlayBtn();
      updateHub();
      syncOwnPipWindow();
      syncBetterFeedPipWindow();
    }

    if (Number.isInteger(state._deckTrack)) {
      syncCrossfadeVolume();
      processAutoLevel();
    }

    if (state.busy) return;

    const title  = playerTitle();
    const timing = playbackTiming();
    const p      = timing.duration ? timing.current / timing.duration : 0;

    if (timing.ended) {
      await advanceAtNaturalEnd();
      return;
    }

    const remainingSeconds = timing.duration > 0
      ? Math.max(0, timing.duration - timing.current)
      : Infinity;
    const shouldCrossfade = state.crossfadeSeconds > 0
      && Number.isInteger(state._deckTrack)
      && !state._crossfading
      && !nearEnd
      && !paused()
      && upcomingCrossfadeDeckReady()
      && !(state.stopAfterRound && state.pos >= state.queue.length - 1)
      && !(state.sleepTimer?.type === 'tracks' && state.sleepTimer.remaining <= 1)
      && timing.current > 0
      && remainingSeconds > 0.05
      && remainingSeconds <= state.crossfadeSeconds;
    if (shouldCrossfade) {
      nearEnd = true;
      state._crossfadePending = remainingSeconds;
      try {
        await next(true);
      } finally {
        state._crossfadePending = false;
        await resetEndGuard();
      }
      return;
    }

    // A custom media element can remain "playing" with either decoded audio
    // buffered ahead or a depleted/failed progressive response. Both cases
    // need a fresh authorized URL; replaying the expired URL is insufficient.
    const deck = currentDeckAudio();
    const stallNow = Date.now();
    const bufferedAhead = deck ? deckHasBufferedAhead(deck, timing.current) : false;
    const stallKind = bufferedAhead ? 'decoder' : 'network';
    const stallEligible = Boolean(deck
      && timing.source === 'audio'
      && !state.loading
      && !state.suspended
      && !state.manualAction
      && !nearEnd
      && !deck.paused
      && !deck.ended
      && !deck.seeking
      && (Number(deck.playbackRate) || 1) > 0
      && timing.current >= 1
      && timing.duration - timing.current > Math.max(2, state.crossfadeSeconds + 1));
    const observationGap = deckStall.observedAt ? stallNow - deckStall.observedAt : 0;
    const progressed = deck !== deckStall.deck || Math.abs(timing.current - deckStall.current) >= 0.05;
    if (!stallEligible || progressed || observationGap > 4000) {
      resetDeckStall(deck, timing.current, stallNow);
    } else if (!deckStall.recovering) {
      deckStall.observedAt = stallNow;
      if (!deckStall.stalledSince) deckStall.stalledSince = stallNow;
      const stalledFor = stallNow - deckStall.stalledSince;
      const stallThreshold = stallKind === 'decoder' ? 15000 : 12000;
      if (stalledFor >= stallThreshold && deckStall.recoveryAttempts >= 2) {
        recordPlaybackDiagnostic('recovery-exhausted', {
          reason: stallKind,
          attempts: deckStall.recoveryAttempts,
          position: Math.round(timing.current * 10) / 10,
        });
        resetDeckStall();
        await advanceAtNaturalEnd();
        return;
      }
      if (stalledFor >= stallThreshold) {
        deckStall.recoveryAttempts++;
        deckStall.recovering = true;
        const attempts = deckStall.recoveryAttempts;
        void recoverCurrentDeckStream(deck, timing.current, stallKind, attempts).then(recovered => {
          if (deckStall.deck !== deck) return;
          deckStall.recovering = false;
          deckStall.recoveryAttempts = attempts;
          deckStall.current = Number(deck.currentTime) || timing.current;
          deckStall.observedAt = Date.now();
          deckStall.stalledSince = recovered ? 0 : deckStall.observedAt - stallThreshold;
        }).catch(() => {
          if (deckStall.deck !== deck) return;
          deckStall.recovering = false;
          deckStall.recoveryAttempts = attempts;
          deckStall.observedAt = Date.now();
          deckStall.stalledSince = deckStall.observedAt - stallThreshold;
        });
        return;
      }
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
    const queuedDeckActive = Number.isInteger(state._deckTrack)
      && state.queue[state.pos] === state._deckTrack;
    if (state.suspended && queuedDeckActive) state.suspended = false;


    if (state.suspended) {
      if (title && title !== lastTitle) lastTitle = title;
      titleTicks = 0;
      lastRemaining = timing.duration ? Math.max(0, timing.duration - timing.current) : Infinity;
      state.lastProgress = p;
      return;
    }

    if (title && lastTitle && title !== lastTitle) {
      // Custom-deck metadata changes are internal queue transitions. The native
      // SoundCloud title-change heuristic must never classify them as external
      // playback, especially after a long manual crossfade clears its guard.
      if (queuedDeckActive) {
        titleTicks = 0;
        lastTitle = title;
        state.lastTitle = title;
        state.manualAction = false;
        return;
      }
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

function tickPlayTime(now = Date.now()) {
  const currentAt = Number(now);
  const audible = state.active && !state.suspended && !paused();
  const previousAt = Number(state._playTimeLastAt);
  const elapsedMs = audible && state._playTimeWasAudible && Number.isFinite(previousAt)
    ? Math.max(0, currentAt - previousAt)
    : 0;

  state._playTimeLastAt = currentAt;
  state._playTimeWasAudible = audible;

  if (elapsedMs > 0) {
    const totalMs = (state._playTimeRemainderMs || 0) + elapsedMs;
    const wholeSeconds = Math.floor(totalMs / 1000);
    state._playTimeRemainderMs = totalMs - wholeSeconds * 1000;
    if (wholeSeconds > 0) state.stats.elapsed = (state.stats.elapsed || 0) + wholeSeconds;
  }

  checkSleepTimerDeadline(currentAt);
}

function checkSleepTimerDeadline(now = Date.now()) {
  const timer = state.sleepTimer;
  if (!state.active || timer?.type !== 'time') return false;

  timer.remaining = timedSleepRemaining(timer, now);
  updateSleepDisplay(now);
  if (timer.remaining > 0) return false;

  // Clear first so simultaneous worker/window/catch-up ticks cannot stop twice.
  state.sleepTimer = null;
  const sel = document.getElementById('tss-hub-sleep');
  if (sel) sel.value = 'off';
  pause();
  stop();
  updateHub();
  renderList();
  return true;
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
  closeEqualizer();

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
    state._playTimeLastAt = Date.now();
    state._playTimeWasAudible = false;
    state._playTimeRemainderMs = 0;
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

function equalizerPresetName() {
  for (const [name, values] of Object.entries({ ...EQ_PRESETS, ...state.customEqPresets })) {
    if (values.every((value, index) => value === state.eqBands[index])) return name;
  }
  return 'Custom';
}

function renderEqualizerPresetButtons() {
  const container = document.querySelector('#tss-eq-overlay .tss-eq-presets');
  if (!container) return;
  const signature = JSON.stringify(Object.keys(state.customEqPresets));
  if (container.dataset.signature === signature) return;
  const builtIns = Object.keys(EQ_PRESETS).map(name =>
    `<button type="button" class="tss-eq-preset" data-preset="${esc(name)}">${esc(name)}</button>`
  ).join('');
  const custom = Object.keys(state.customEqPresets).map(name => `
    <span class="tss-eq-custom-preset">
      <button type="button" class="tss-eq-preset" data-preset="${esc(name)}">${esc(name)}</button>
      <button type="button" class="tss-eq-preset-remove" data-remove-preset="${esc(name)}" aria-label="Delete ${esc(name)} preset">${SVG.close}</button>
    </span>
  `).join('');
  container.innerHTML = `${builtIns}${custom}<button type="button" id="tss-eq-save-open">+ Save preset</button>`;
  container.dataset.signature = signature;
}

function equalizerGraphY(value) {
  return 107.5 - (Math.max(-12, Math.min(12, Number(value) || 0)) / 12) * 82.5;
}

function equalizerGraphPath(values = state.eqBands) {
  const points = EQ_GRAPH_X.map((x, index) => ({ x, y: equalizerGraphY(values[index]) }));
  let path = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length; i++) {
    const previous = points[i - 1], current = points[i];
    const midpoint = (previous.x + current.x) / 2;
    path += ` C ${midpoint} ${previous.y}, ${midpoint} ${current.y}, ${current.x} ${current.y}`;
  }
  return { line: path, area: `${path} L ${points.at(-1).x} 190 L ${points[0].x} 190 Z`, points };
}

function renderEqualizerGraph() {
  const overlay = document.getElementById('tss-eq-overlay');
  if (!overlay) return;
  const graph = equalizerGraphPath();
  const line = overlay.querySelector('#tss-eq-curve');
  const area = overlay.querySelector('#tss-eq-area');
  if (line) line.setAttribute('d', graph.line);
  if (area) area.setAttribute('d', graph.area);
  graph.points.forEach((point, index) => {
    overlay.querySelectorAll(`.tss-eq-point[data-band="${index}"]`).forEach(circle => {
      circle.setAttribute('cy', String(point.y));
      circle.setAttribute('aria-valuenow', String(state.eqBands[index]));
      circle.setAttribute('aria-valuetext', `${state.eqBands[index] > 0 ? '+' : ''}${state.eqBands[index]} dB`);
    });
    const value = overlay.querySelector(`.tss-eq-point-value[data-band="${index}"]`);
    if (value) {
      value.setAttribute('y', String(Math.max(16, point.y - 15)));
      value.textContent = `${state.eqBands[index] > 0 ? '+' : ''}${state.eqBands[index]}`;
    }
  });
}

function closeEqualizer() {
  const overlay = document.getElementById('tss-eq-overlay');
  overlay?._cancelDrag?.();
  if (overlay?._onKeydown) document.removeEventListener('keydown', overlay._onKeydown);
  overlay?.remove();
  document.getElementById('tss-modal-backdrop')?.remove();
}

function setEqualizerBand(index, value) {
  if (!ensureAutoLevelAudioGraph()) return;
  state.eqBands[index] = Math.max(-12, Math.min(12, Math.round(Number(value) || 0)));
  state.eqPreset = equalizerPresetName();
  state.eqEnabled = true;
  persistEqualizer();
  syncEqualizer();
  updateEqualizerPopup();
}

function updateEqualizerPopup() {
  const overlay = document.getElementById('tss-eq-overlay');
  if (!overlay) return;
  renderEqualizerPresetButtons();
  const power = overlay.querySelector('#tss-eq-power');
  if (power) {
    power.dataset.active = String(state.eqEnabled);
    power.setAttribute('aria-pressed', String(state.eqEnabled));
    power.textContent = state.eqEnabled ? 'EQ ON' : 'EQ OFF';
  }
  const clipper = overlay.querySelector('#tss-safety-clipper');
  if (clipper) clipper.checked = state.safetyClipper;
  overlay.querySelectorAll('.tss-eq-preset').forEach(button => {
    button.dataset.active = String(button.dataset.preset === state.eqPreset);
  });
  renderEqualizerGraph();
}

function showEqualizer() {
  const existing = document.getElementById('tss-eq-overlay');
  if (existing) { closeEqualizer(); return; }
  document.getElementById('tss-stats-overlay')?.remove();

  const backdrop = document.createElement('div');
  backdrop.id = 'tss-modal-backdrop';
  document.body.appendChild(backdrop);

  const overlay = document.createElement('div');
  overlay.id = 'tss-eq-overlay';
  overlay.innerHTML = `
    <div class="tss-eq-head">
      <div>
        <div class="tss-eq-kicker">True Shuffle</div>
        <div class="tss-eq-title">5-band equalizer</div>
      </div>
      <div class="tss-eq-head-actions">
        <button id="tss-eq-power" type="button" aria-pressed="false">EQ OFF</button>
        <button id="tss-eq-close" class="tss-stats-close" aria-label="Close equalizer">${SVG.close}</button>
      </div>
    </div>
    <div class="tss-eq-body">
      <div class="tss-eq-presets" role="group" aria-label="Equalizer presets">
        ${Object.keys(EQ_PRESETS).map(name => `<button type="button" class="tss-eq-preset" data-preset="${esc(name)}">${esc(name)}</button>`).join('')}
      </div>
      <div id="tss-eq-save-row" data-open="false">
        <label class="tss-eq-save-field"><span>Preset name</span><input id="tss-eq-save-name" type="text" maxlength="24" autocomplete="off" placeholder="My sound"></label>
        <button id="tss-eq-save-confirm" type="button">Save</button>
        <button id="tss-eq-save-cancel" type="button" aria-label="Cancel saving preset">${SVG.close}</button>
        <span id="tss-eq-save-error" role="alert"></span>
      </div>
      <div class="tss-eq-graph-wrap">
        <svg id="tss-eq-graph" class="tss-eq-graph" viewBox="0 0 520 230" role="group" aria-label="Five band equalizer curve">
          <defs>
            <linearGradient id="tss-eq-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="#ff5500" stop-opacity=".48"/>
              <stop offset="100%" stop-color="#ff5500" stop-opacity=".025"/>
            </linearGradient>
          </defs>
          <g class="tss-eq-grid" aria-hidden="true">
            <line x1="50" y1="25" x2="50" y2="190"/><line x1="155" y1="25" x2="155" y2="190"/>
            <line x1="260" y1="25" x2="260" y2="190"/><line x1="365" y1="25" x2="365" y2="190"/>
            <line x1="470" y1="25" x2="470" y2="190"/><line class="tss-eq-zero" x1="28" y1="107.5" x2="492" y2="107.5"/>
          </g>
          <path id="tss-eq-area" fill="url(#tss-eq-fill)" aria-hidden="true"/>
          <path id="tss-eq-curve" fill="none" stroke="#ff5b0a" stroke-width="3" stroke-linecap="round" aria-hidden="true"/>
          ${EQ_BANDS.map((band, index) => `
            <text class="tss-eq-point-value" data-band="${index}" x="${EQ_GRAPH_X[index]}" y="90" text-anchor="middle">0</text>
            <circle class="tss-eq-point tss-eq-point-visible" data-band="${index}" cx="${EQ_GRAPH_X[index]}" cy="107.5" r="5" aria-hidden="true"/>
            <circle class="tss-eq-point tss-eq-point-hit" data-band="${index}" cx="${EQ_GRAPH_X[index]}" cy="107.5" r="17" tabindex="0" role="slider" aria-label="${band.label} hertz" aria-valuemin="-12" aria-valuemax="12" aria-valuenow="0"/>
            <text class="tss-eq-frequency" x="${EQ_GRAPH_X[index]}" y="218" text-anchor="middle">${band.label}</text>
          `).join('')}
          <text class="tss-eq-axis-label" x="1" y="29">+12</text>
          <text class="tss-eq-axis-label" x="8" y="111">0</text>
          <text class="tss-eq-axis-label" x="1" y="194">-12</text>
        </svg>
      </div>
      <label class="tss-eq-safety" for="tss-safety-clipper">
        <span><strong>Safety clipper</strong><small id="tss-safety-clipper-help">Contain peaks above full scale. Off by default for transparent playback.</small></span>
        <input id="tss-safety-clipper" type="checkbox" aria-describedby="tss-safety-clipper-help">
      </label>
      <div class="tss-eq-footer"><span>Drag points to fine-tune</span><button id="tss-eq-reset" type="button">Reset</button></div>
    </div>
  `;
  document.body.appendChild(overlay);

  backdrop.onclick = closeEqualizer;
  overlay.querySelector('#tss-eq-close').onclick = closeEqualizer;
  overlay.querySelector('#tss-eq-power').onclick = () => {
    const enabling = !state.eqEnabled;
    if (enabling && !ensureAutoLevelAudioGraph()) return;
    state.eqEnabled = enabling;
    persistEqualizer({ immediate: true });
    syncEqualizer();
    updateEqualizerPopup();
  };
  overlay.querySelector('#tss-safety-clipper').onchange = event => {
    state.safetyClipper = event.currentTarget.checked;
    localStorage.setItem('tss_safety_clipper', String(state.safetyClipper));
    if (ensureAutoLevelAudioGraph()) syncSafetyClipper();
    updateEqualizerPopup();
  };
  const presets = overlay.querySelector('.tss-eq-presets');
  const saveRow = overlay.querySelector('#tss-eq-save-row');
  const saveName = overlay.querySelector('#tss-eq-save-name');
  const saveError = overlay.querySelector('#tss-eq-save-error');
  presets.onclick = event => {
    const remove = event.target.closest('[data-remove-preset]');
    if (remove) {
      const name = remove.dataset.removePreset;
      delete state.customEqPresets[name];
      if (state.eqPreset === name) state.eqPreset = equalizerPresetName();
      persistEqualizer({ customPresets: true, immediate: true });
      presets.dataset.signature = '';
      updateEqualizerPopup();
      return;
    }
    if (event.target.closest('#tss-eq-save-open')) {
      saveRow.dataset.open = 'true';
      saveError.textContent = '';
      saveName.value = state.customEqPresets[state.eqPreset] ? state.eqPreset : '';
      saveName.focus();
      saveName.select();
      return;
    }
    const button = event.target.closest('.tss-eq-preset');
    if (!button || !ensureAutoLevelAudioGraph()) return;
    const values = EQ_PRESETS[button.dataset.preset] || state.customEqPresets[button.dataset.preset];
    if (!values) return;
    state.eqBands = values.slice();
    state.eqPreset = button.dataset.preset;
    state.eqEnabled = true;
    persistEqualizer({ immediate: true });
    syncEqualizer();
    updateEqualizerPopup();
  };
  const savePreset = () => {
    const requested = saveName.value.trim().replace(/\s+/g, ' ').slice(0, 24);
    if (!requested) { saveError.textContent = 'Enter a name'; return; }
    if (Object.keys(EQ_PRESETS).some(name => name.toLowerCase() === requested.toLowerCase())) {
      saveError.textContent = 'Built-in names cannot be replaced';
      return;
    }
    if (BLOCKED_EQ_PRESET_NAMES.has(requested.toLowerCase())) {
      saveError.textContent = 'Choose a different preset name';
      return;
    }
    const existingName = Object.keys(state.customEqPresets).find(name => name.toLowerCase() === requested.toLowerCase());
    if (!existingName && Object.keys(state.customEqPresets).length >= 20) {
      saveError.textContent = 'Maximum 20 custom presets';
      return;
    }
    const name = existingName || requested;
    state.customEqPresets[name] = state.eqBands.slice();
    state.eqPreset = name;
    persistEqualizer({ customPresets: true, immediate: true });
    saveRow.dataset.open = 'false';
    presets.dataset.signature = '';
    updateEqualizerPopup();
  };
  overlay.querySelector('#tss-eq-save-confirm').onclick = savePreset;
  overlay.querySelector('#tss-eq-save-cancel').onclick = () => { saveRow.dataset.open = 'false'; saveError.textContent = ''; };
  saveName.onkeydown = event => {
    if (event.key === 'Enter') { event.preventDefault(); savePreset(); }
    if (event.key === 'Escape') { event.stopPropagation(); saveRow.dataset.open = 'false'; }
  };
  overlay.querySelector('#tss-eq-reset').onclick = () => {
    if (!ensureAutoLevelAudioGraph()) return;
    state.eqBands = EQ_PRESETS.Flat.slice();
    state.eqPreset = 'Flat';
    state.eqEnabled = true;
    persistEqualizer({ immediate: true });
    syncEqualizer();
    updateEqualizerPopup();
  };

  const svg = overlay.querySelector('#tss-eq-graph');
  let draggingBand = null;
  let draggingPoint = null;
  let draggingPointerId = null;
  const valueFromPointer = event => {
    const rect = svg.getBoundingClientRect();
    const y = (event.clientY - rect.top) * (230 / rect.height);
    return Math.round(((107.5 - y) / 82.5) * 12);
  };
  const move = event => {
    if (draggingBand === null) return;
    event.preventDefault();
    setEqualizerBand(draggingBand, valueFromPointer(event));
  };
  const up = () => {
    if (draggingPoint && draggingPointerId !== null && typeof draggingPoint.releasePointerCapture === 'function') {
      try { draggingPoint.releasePointerCapture(draggingPointerId); } catch (_) {}
    }
    draggingBand = null;
    draggingPoint = null;
    draggingPointerId = null;
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    document.removeEventListener('pointercancel', up);
    window.removeEventListener('blur', up);
  };
  overlay._cancelDrag = up;
  overlay.querySelectorAll('.tss-eq-point-hit').forEach(point => {
    point.onpointerdown = event => {
      event.preventDefault();
      draggingBand = Number(point.dataset.band);
      draggingPoint = point;
      draggingPointerId = event.pointerId;
      if (typeof point.setPointerCapture === 'function') {
        try { point.setPointerCapture(event.pointerId); } catch (_) {}
      }
      document.addEventListener('pointermove', move, { passive: false });
      document.addEventListener('pointerup', up);
      document.addEventListener('pointercancel', up);
      window.addEventListener('blur', up);
      setEqualizerBand(draggingBand, valueFromPointer(event));
    };
    point.onkeydown = event => {
      if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const index = Number(point.dataset.band);
      const nextValue = event.key === 'Home' ? -12
        : event.key === 'End' ? 12
          : state.eqBands[index] + (event.key === 'ArrowUp' ? 1 : -1);
      setEqualizerBand(index, nextValue);
    };
  });
  overlay._onKeydown = event => { if (event.key === 'Escape') closeEqualizer(); };
  document.addEventListener('keydown', overlay._onKeydown);
  updateEqualizerPopup();
}

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
      #tss-hub-pip[data-open="true"] { color:var(--tss-a,#ff5500) !important;border-color:rgba(var(--tss-ar,255),var(--tss-ag,85),var(--tss-ab,0),.44) !important;background:rgba(var(--tss-ar,255),var(--tss-ag,85),var(--tss-ab,0),.12) !important; }

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

      .tss-crossfade-card {
        margin:0 14px 13px;border:1px solid rgba(255,255,255,.075);
        border-radius:10px;background:rgba(255,255,255,.025);overflow:hidden;
        transition:border-color .18s ease,background .18s ease;
      }
      .tss-crossfade-card[data-open="true"] {
        border-color:rgba(var(--tss-ar,255),var(--tss-ag,85),var(--tss-ab,0),.22);
        background:rgba(255,255,255,.035);
      }
      #tss-crossfade-summary {
        width:100%;min-height:38px;padding:0 10px;border:0;background:transparent;color:#fff;
        display:flex;align-items:center;justify-content:space-between;gap:10px;cursor:pointer;
        font-family:-apple-system,'Segoe UI',system-ui,sans-serif;text-align:left;
      }
      #tss-crossfade-summary:hover { background:rgba(255,255,255,.025); }
      #tss-crossfade-summary:focus-visible { outline:2px solid var(--tss-a,#ff5500);outline-offset:-2px; }
      .tss-crossfade-copy { display:flex;align-items:center;gap:8px;min-width:0; }
      .tss-crossfade-dot { width:6px;height:6px;border-radius:50%;background:rgba(255,255,255,.16);box-shadow:0 0 0 3px rgba(255,255,255,.035); }
      .tss-crossfade-card[data-enabled="true"] .tss-crossfade-dot { background:var(--tss-a,#ff5500);box-shadow:0 0 0 3px rgba(var(--tss-ar,255),var(--tss-ag,85),var(--tss-ab,0),.12); }
      .tss-crossfade-label { color:rgba(255,255,255,.72);font-size:8px;font-weight:760;letter-spacing:.1em;text-transform:uppercase;white-space:nowrap; }
      #tss-hub-crossfade-status { color:rgba(255,255,255,.3);font-size:8px;white-space:nowrap; }
      #tss-hub-crossfade-status[data-status="mixing"] { color:var(--tss-a,#ff5500); }
      #tss-hub-crossfade-status[data-status="fallback"] { color:#d39a62; }
      .tss-crossfade-summary-value { display:flex;align-items:center;gap:7px;color:rgba(255,255,255,.48);font-size:9px;font-weight:700; }
      #tss-crossfade-chevron { width:10px;height:10px;transition:transform .18s ease; }
      .tss-crossfade-card[data-open="true"] #tss-crossfade-chevron { transform:rotate(180deg); }
      .tss-crossfade-reveal { display:grid;grid-template-rows:0fr;transition:grid-template-rows .2s ease; }
      .tss-crossfade-card[data-open="true"] .tss-crossfade-reveal { grid-template-rows:1fr; }
      .tss-crossfade-settings { min-height:0;overflow:hidden; }
      .tss-crossfade-settings-inner { padding:2px 10px 11px;border-top:1px solid rgba(255,255,255,.06); }
      .tss-crossfade-setting-head { display:flex;align-items:center;justify-content:space-between;margin:9px 0 7px;color:rgba(255,255,255,.42);font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:.08em; }
      #tss-crossfade-seconds { color:#fff;font-size:9px;letter-spacing:0;text-transform:none; }
      #tss-hub-crossfade {
        width:100%;height:16px;margin:0;appearance:none;background:transparent;cursor:pointer;accent-color:var(--tss-a,#ff5500);
      }
      #tss-hub-crossfade::-webkit-slider-runnable-track { height:3px;border-radius:3px;background:linear-gradient(90deg,var(--tss-a,#ff5500) var(--tss-crossfade-fill,0%),rgba(255,255,255,.11) var(--tss-crossfade-fill,0%)); }
      #tss-hub-crossfade::-webkit-slider-thumb { appearance:none;width:12px;height:12px;margin-top:-4.5px;border-radius:50%;background:#fff;border:2px solid rgba(0,0,0,.35);box-shadow:0 1px 5px rgba(0,0,0,.6); }
      #tss-hub-crossfade:focus-visible { outline:2px solid var(--tss-a,#ff5500);outline-offset:3px;border-radius:4px; }
      .tss-crossfade-ticks { display:flex;justify-content:space-between;color:rgba(255,255,255,.22);font-size:7px;margin-top:1px; }
      .tss-crossfade-modes { display:grid;grid-template-columns:repeat(3,1fr);gap:3px;padding:3px;background:rgba(0,0,0,.26);border-radius:7px; }
      .tss-crossfade-mode { border:0;border-radius:5px;padding:6px 3px;background:transparent;color:rgba(255,255,255,.34);font:700 8px/1 -apple-system,'Segoe UI',system-ui,sans-serif;cursor:pointer;transition:background .15s,color .15s; }
      .tss-crossfade-mode:hover { color:rgba(255,255,255,.72); }
      .tss-crossfade-mode[data-active="true"] { color:#fff;background:rgba(255,255,255,.09);box-shadow:0 1px 4px rgba(0,0,0,.25); }
      .tss-crossfade-mode:focus-visible { outline:2px solid var(--tss-a,#ff5500);outline-offset:1px; }
      .tss-crossfade-manual { display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:9px;color:rgba(255,255,255,.42);font-size:8px;cursor:pointer; }
      .tss-crossfade-manual input { width:13px;height:13px;margin:0;accent-color:var(--tss-a,#ff5500);cursor:pointer; }
      #tss-playback-debug {
        width:100%;margin-top:6px;padding:7px 10px;border:1px solid rgba(255,118,82,.24);border-radius:8px;
        background:rgba(255,92,54,.07);color:#ff9a7d;font:750 8px/1 -apple-system,'Segoe UI',system-ui,sans-serif;
        letter-spacing:.08em;text-transform:uppercase;cursor:pointer;
      }
      #tss-playback-debug:hover { background:rgba(255,92,54,.12);border-color:rgba(255,118,82,.38); }
      #tss-playback-debug[hidden] { display:none!important; }
      #tss-debug-overlay { position:fixed;inset:0;z-index:1000002;display:flex;align-items:center;justify-content:center;padding:22px;background:rgba(0,0,0,.72);backdrop-filter:blur(10px); }
      .tss-debug-dialog { width:min(620px,calc(100vw - 28px));max-height:min(680px,calc(100vh - 28px));display:flex;flex-direction:column;gap:10px;padding:15px;border:1px solid rgba(255,255,255,.11);border-radius:13px;background:#0b0b0b;box-shadow:0 22px 70px rgba(0,0,0,.75);color:#eee;font-family:-apple-system,'Segoe UI',system-ui,sans-serif; }
      .tss-debug-head { display:flex;align-items:center;justify-content:space-between;gap:15px; }
      .tss-debug-head strong { display:block;font-size:13px;letter-spacing:.02em; }
      .tss-debug-head span { display:block;margin-top:2px;color:rgba(255,255,255,.38);font-size:9px; }
      .tss-debug-head button { width:28px;height:28px;display:grid;place-items:center;border:0;border-radius:7px;background:rgba(255,255,255,.06);color:rgba(255,255,255,.65);cursor:pointer; }
      .tss-debug-dialog p { margin:0;color:rgba(255,255,255,.45);font-size:10px;line-height:1.45; }
      #tss-debug-report { min-height:180px;max-height:460px;margin:0;padding:11px;overflow:auto;border:1px solid rgba(255,255,255,.07);border-radius:8px;background:#050505;color:#b7c3cc;font:9px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;word-break:break-word; }
      .tss-debug-actions { display:flex;justify-content:flex-end;gap:7px; }
      .tss-debug-actions button { min-width:92px;padding:8px 11px;border:1px solid rgba(255,255,255,.1);border-radius:7px;background:#151515;color:#ddd;font:700 9px/1 -apple-system,'Segoe UI',system-ui,sans-serif;cursor:pointer; }
      #tss-debug-copy { border-color:rgba(var(--tss-ar,255),var(--tss-ag,85),var(--tss-ab,0),.35);background:rgba(var(--tss-ar,255),var(--tss-ag,85),var(--tss-ab,0),.13);color:#fff; }
      @media (prefers-reduced-motion:reduce) {
        .tss-crossfade-reveal,#tss-crossfade-chevron { transition:none; }
      }

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
      .tss-master-volume { display:grid;grid-template-columns:14px minmax(0,1fr) 31px 62px;align-items:center;gap:9px;margin:-3px 14px 13px;color:rgba(255,255,255,.38); }
      #tss-hub-volume { width:100%;height:18px;margin:0;appearance:none;background:transparent;cursor:pointer; }
      #tss-hub-volume::-webkit-slider-runnable-track { height:3px;border-radius:3px;background:linear-gradient(90deg,var(--tss-a,#ff5500) var(--tss-volume-fill,10%),rgba(255,255,255,.12) var(--tss-volume-fill,10%)); }
      #tss-hub-volume::-webkit-slider-thumb { appearance:none;width:12px;height:12px;margin-top:-4.5px;border-radius:50%;background:#fff;border:2px solid rgba(0,0,0,.35);box-shadow:0 1px 5px rgba(0,0,0,.6); }
      #tss-hub-volume:focus-visible { outline:2px solid var(--tss-a,#ff5500);outline-offset:3px;border-radius:4px; }
      #tss-hub-volume-value { color:rgba(255,255,255,.48);font-size:9px;font-weight:700;text-align:right;font-variant-numeric:tabular-nums; }
      #tss-auto-level {
        height:22px;padding:0 7px;display:flex;align-items:center;justify-content:center;gap:5px;
        border:1px solid #555;border-radius:7px;background:#171717;
        color:#c8c8c8;font:700 8px/1 Arial,sans-serif;letter-spacing:.06em;cursor:pointer;
        box-shadow:0 1px 3px rgba(0,0,0,.55);transition:color .16s,border-color .16s,background .16s,box-shadow .16s;
      }
      #tss-auto-level:hover { color:#fff;background:#242424;border-color:#777; }
      #tss-auto-level[data-active="true"] { color:#fff;border-color:#ff7a33;background:#e84d00;box-shadow:0 0 0 1px rgba(255,255,255,.16),0 0 10px rgba(255,85,0,.34); }
      #tss-auto-level:focus-visible { outline:2px solid var(--tss-a,#ff5500);outline-offset:2px; }
      .tss-auto-dot { width:5px;height:5px;border-radius:50%;background:currentColor;box-shadow:0 0 0 0 currentColor; }
      #tss-auto-level[data-active="true"] .tss-auto-dot { box-shadow:0 0 6px currentColor; }
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
      #tss-merge-btn {
        color:rgba(255,255,255,.45) !important;display:flex !important;align-items:center;justify-content:center;
        min-height:30px;padding:0 9px !important;border:1px solid rgba(255,255,255,.09);border-radius:8px !important;
        background:rgba(255,255,255,.025) !important;cursor:pointer;transition:color .18s,border-color .18s,background .18s;
      }
      #tss-merge-btn:hover { color:#fff !important;border-color:rgba(255,255,255,.18);background:rgba(255,255,255,.065) !important; }
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

      #tss-hub-eq[data-active="true"] { color:#fff !important;border-color:#ff7a33 !important;background:#e84d00 !important;box-shadow:0 0 9px rgba(255,85,0,.3); }
      #tss-modal-backdrop { position:fixed;inset:0;z-index:999998;background:rgba(0,0,0,.42);-webkit-backdrop-filter:blur(5px);backdrop-filter:blur(5px);animation:tss-backdrop-in .18s ease-out; }
      @keyframes tss-backdrop-in { from { opacity:0; } to { opacity:1; } }
      #tss-eq-overlay {
        position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:999999;
        width:560px;max-width:calc(100vw - 28px);box-sizing:border-box;color:#eee;
        background:rgba(9,9,9,.99);border:1px solid rgba(255,255,255,.12);border-radius:18px;
        box-shadow:0 30px 90px rgba(0,0,0,.82),0 0 0 1px rgba(255,85,0,.035);
        font-family:-apple-system,'Segoe UI',system-ui,sans-serif;-webkit-user-select:none;user-select:none;
        -webkit-backdrop-filter:blur(20px);backdrop-filter:blur(20px);
        animation:tss-eq-in .18s cubic-bezier(.2,.8,.2,1);
      }
      @keyframes tss-eq-in { from { opacity:0;transform:translate(-50%,-48%) scale(.985); } to { opacity:1;transform:translate(-50%,-50%) scale(1); } }
      .tss-eq-head { display:flex;align-items:center;justify-content:space-between;padding:17px 18px 14px;border-bottom:1px solid rgba(255,255,255,.075); }
      .tss-eq-kicker { color:#ff6a1f;font-size:8px;font-weight:760;letter-spacing:.13em;text-transform:uppercase; }
      .tss-eq-title { margin-top:4px;color:#f3f3f3;font-size:17px;font-weight:680;letter-spacing:-.02em; }
      .tss-eq-head-actions { display:flex;align-items:center;gap:7px; }
      #tss-eq-power { height:32px;padding:0 10px;border:1px solid #555;border-radius:8px;background:#171717;color:#c8c8c8;cursor:pointer;font:750 8px/1 -apple-system,'Segoe UI',system-ui,sans-serif;letter-spacing:.08em;transition:all .18s; }
      #tss-eq-power[data-active="true"] { color:#fff;border-color:#ff7a33;background:#e84d00;box-shadow:0 0 9px rgba(255,85,0,.3); }
      #tss-eq-power:focus-visible,.tss-eq-preset:focus-visible,.tss-eq-point-hit:focus-visible,#tss-eq-reset:focus-visible { outline:2px solid #ff6a1f;outline-offset:2px; }
      .tss-eq-body { position:relative;padding:15px 18px 16px; }
      .tss-eq-presets { display:flex;gap:7px;overflow-x:auto;padding:1px 1px 12px;scrollbar-width:none; }
      .tss-eq-presets::-webkit-scrollbar { display:none; }
      .tss-eq-preset { flex:0 0 auto;height:30px;padding:0 11px;border:1px solid rgba(255,255,255,.1);border-radius:8px;background:rgba(255,255,255,.035);color:rgba(255,255,255,.56);cursor:pointer;font:700 9px/1 -apple-system,'Segoe UI',system-ui,sans-serif;letter-spacing:.02em;transition:color .18s,border-color .18s,background .18s; }
      .tss-eq-preset:hover { color:#fff;border-color:rgba(255,255,255,.22);background:rgba(255,255,255,.07); }
      .tss-eq-preset[data-active="true"] { color:#fff;border-color:rgba(255,106,31,.7);background:rgba(255,85,0,.18); }
      .tss-eq-custom-preset { display:inline-flex;flex:0 0 auto; }
      .tss-eq-custom-preset .tss-eq-preset { border-radius:8px 0 0 8px;border-right:0; }
      .tss-eq-preset-remove { width:25px;height:30px;padding:0;display:flex;align-items:center;justify-content:center;border:1px solid rgba(255,255,255,.1);border-radius:0 8px 8px 0;background:rgba(255,255,255,.035);color:rgba(255,255,255,.3);cursor:pointer;transition:color .18s,border-color .18s,background .18s; }
      .tss-eq-preset-remove:hover { color:#ff8050;border-color:rgba(255,128,80,.4);background:rgba(255,85,0,.1); }
      #tss-eq-save-open { flex:0 0 auto;height:30px;padding:0 11px;border:1px dashed rgba(255,255,255,.2);border-radius:8px;background:transparent;color:rgba(255,255,255,.48);cursor:pointer;font:700 9px/1 -apple-system,'Segoe UI',system-ui,sans-serif;transition:color .18s,border-color .18s,background .18s; }
      #tss-eq-save-open:hover { color:#fff;border-color:#ff6a1f;background:rgba(255,85,0,.08); }
      #tss-eq-save-row { display:none;grid-template-columns:minmax(0,1fr) auto 30px;align-items:end;gap:7px;margin:-2px 1px 12px;padding:10px;border:1px solid rgba(255,255,255,.09);border-radius:10px;background:rgba(255,255,255,.025); }
      #tss-eq-save-row[data-open="true"] { display:grid; }
      .tss-eq-save-field { display:grid;gap:5px;min-width:0; }
      .tss-eq-save-field span { color:rgba(255,255,255,.38);font-size:8px;font-weight:700;letter-spacing:.08em;text-transform:uppercase; }
      #tss-eq-save-name { width:100%;height:31px;box-sizing:border-box;padding:0 9px;border:1px solid rgba(255,255,255,.14);border-radius:7px;background:#111;color:#eee;outline:none;font:500 10px/1 -apple-system,'Segoe UI',system-ui,sans-serif; }
      #tss-eq-save-name:focus { border-color:#ff6a1f;box-shadow:0 0 0 2px rgba(255,85,0,.12); }
      #tss-eq-save-confirm,#tss-eq-save-cancel { height:31px;border:1px solid rgba(255,255,255,.13);border-radius:7px;cursor:pointer;font:700 9px/1 -apple-system,'Segoe UI',system-ui,sans-serif; }
      #tss-eq-save-confirm { padding:0 12px;background:#e84d00;border-color:#ff7130;color:#fff; }
      #tss-eq-save-cancel { width:30px;padding:0;display:flex;align-items:center;justify-content:center;background:#171717;color:rgba(255,255,255,.5); }
      #tss-eq-save-error { grid-column:1/-1;min-height:0;color:#ff805f;font-size:8px; }
      .tss-eq-graph-wrap { border-top:1px solid rgba(255,255,255,.055);border-bottom:1px solid rgba(255,255,255,.055);padding:4px 0 1px; }
      .tss-eq-safety { display:flex;align-items:center;justify-content:space-between;gap:18px;padding:11px 2px 0;color:#ddd;cursor:pointer; }
      .tss-eq-safety span { display:grid;gap:3px; }
      .tss-eq-safety strong { font-size:10px;font-weight:750; }
      .tss-eq-safety small { color:rgba(255,255,255,.38);font-size:8px;line-height:1.35; }
      .tss-eq-safety input { width:15px;height:15px;flex:0 0 auto;accent-color:var(--tss-a,#ff5500); }
      .tss-eq-graph { display:block;width:100%;height:auto;overflow:visible;touch-action:none; }
      .tss-eq-grid line { stroke:rgba(255,255,255,.105);stroke-width:1;stroke-dasharray:3 4; }
      .tss-eq-grid .tss-eq-zero { stroke:rgba(255,255,255,.28);stroke-dasharray:none; }
      .tss-eq-point-visible { fill:#ff5b0a;stroke:#fff;stroke-width:2.5;filter:drop-shadow(0 2px 4px rgba(0,0,0,.8));pointer-events:none; }
      .tss-eq-point-hit { fill:transparent;stroke:transparent;cursor:ns-resize;pointer-events:all;touch-action:none; }
      .tss-eq-point-visible:has(+ .tss-eq-point-hit:hover),.tss-eq-point-visible:has(+ .tss-eq-point-hit:focus-visible) { fill:#fff; }
      .tss-eq-point-value { fill:rgba(255,255,255,.72);font-size:9px;font-weight:750;font-variant-numeric:tabular-nums;pointer-events:none; }
      .tss-eq-frequency { fill:rgba(255,255,255,.48);font-size:10px;font-weight:700;pointer-events:none; }
      .tss-eq-axis-label { fill:rgba(255,255,255,.3);font-size:8px;font-weight:700;pointer-events:none; }
      .tss-eq-footer { display:flex;align-items:center;justify-content:space-between;margin-top:11px;color:rgba(255,255,255,.3);font-size:8px;font-weight:700;letter-spacing:.07em;text-transform:uppercase; }
      #tss-eq-reset { height:30px;padding:0 13px;border:1px solid rgba(255,255,255,.16);border-radius:8px;background:transparent;color:rgba(255,255,255,.68);cursor:pointer;font:700 9px/1 -apple-system,'Segoe UI',system-ui,sans-serif;transition:color .18s,border-color .18s,background .18s; }
      #tss-eq-reset:hover { color:#fff;border-color:rgba(255,255,255,.34);background:rgba(255,255,255,.055); }
      @media (max-width:520px) { #tss-eq-overlay { width:calc(100vw - 20px); } .tss-eq-body { padding-inline:10px; } .tss-eq-head { padding-inline:12px; } .tss-eq-preset { padding-inline:9px; } }

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
          <button id="tss-hub-pip" class="tss-hub-btn tss-hub-btn-icon" data-open="false" aria-label="Open True Shuffle picture in picture" aria-pressed="false" title="Open True Shuffle PiP" style="display:none;">${SVG.pip}</button>
          <button id="tss-hub-eq" class="tss-hub-btn tss-hub-btn-icon" data-active="false" aria-label="Equalizer" aria-pressed="false" title="Equalizer off">${SVG.equalizer}</button>
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

          <div class="tss-master-volume">
            <span aria-hidden="true">${SVG.volume}</span>
            <input id="tss-hub-volume" type="range" min="0" max="100" step="1" value="10" aria-label="True Shuffle volume">
            <span id="tss-hub-volume-value" aria-live="polite">10%</span>
            <button id="tss-auto-level" type="button" aria-pressed="false" title="Automatically reduce louder tracks"><span class="tss-auto-dot" aria-hidden="true"></span><span class="tss-auto-label">AUTO OFF</span></button>
          </div>

          <div class="tss-crossfade-card" id="tss-crossfade-card" data-open="false" data-enabled="false">
            <button id="tss-crossfade-summary" type="button" aria-expanded="false" aria-controls="tss-crossfade-settings">
              <span class="tss-crossfade-copy">
                <span class="tss-crossfade-dot" aria-hidden="true"></span>
                <span class="tss-crossfade-label">Crossfade</span>
                <span id="tss-hub-crossfade-status" data-status="off" aria-live="polite">off</span>
              </span>
              <span class="tss-crossfade-summary-value">
                <span id="tss-crossfade-summary-seconds">off</span>
                <svg id="tss-crossfade-chevron" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
              </span>
            </button>
            <div class="tss-crossfade-reveal" id="tss-crossfade-settings">
              <div class="tss-crossfade-settings">
                <div class="tss-crossfade-settings-inner">
                  <div class="tss-crossfade-setting-head"><span>Duration</span><span id="tss-crossfade-seconds">off</span></div>
                  <input id="tss-hub-crossfade" type="range" min="0" max="12" step="1" value="0" aria-label="Crossfade duration in seconds">
                  <div class="tss-crossfade-ticks" aria-hidden="true"><span>off</span><span>3</span><span>6</span><span>9</span><span>12s</span></div>
                  <div class="tss-crossfade-setting-head"><span>Mix style</span></div>
                  <div class="tss-crossfade-modes" role="group" aria-label="Crossfade mix style">
                    <button type="button" class="tss-crossfade-mode" data-curve="smooth" title="Gentle, rounded handoff">Smooth</button>
                    <button type="button" class="tss-crossfade-mode" data-curve="clean" title="Linear blend with minimal coloration">Clean</button>
                    <button type="button" class="tss-crossfade-mode" data-curve="dj" title="Faster handoff around the midpoint">DJ</button>
                  </div>
                  <label class="tss-crossfade-manual"><span>Fade manual skips</span><input id="tss-crossfade-manual" type="checkbox"></label>
                </div>
              </div>
            </div>
          </div>
          <button id="tss-playback-debug" type="button" hidden>Playback issue detected · open report</button>

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
  document.getElementById('tss-hub-eq').onclick = showEqualizer;
  document.getElementById('tss-hub-pip').onclick = () => { void openOwnPip(); };
  setOwnPipButtonState();
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

  document.getElementById('tss-hub-start').onclick = () => {
    if (state.autoLevel || state.eqEnabled || state.crossfadeSeconds > 0) ensureAutoLevelAudioGraph();
    if (!state.loading) start();
  };

  document.getElementById('tss-hub-sleep').onchange = e => {
    setSleepTimer(e.target.value);
  };

  const crossfadeCard = document.getElementById('tss-crossfade-card');
  const crossfadeSummary = document.getElementById('tss-crossfade-summary');
  crossfadeSummary.onclick = () => {
    const open = crossfadeCard.dataset.open !== 'true';
    crossfadeCard.dataset.open = open ? 'true' : 'false';
    crossfadeSummary.setAttribute('aria-expanded', open ? 'true' : 'false');
  };
  document.getElementById('tss-playback-debug').onclick = showPlaybackDiagnostics;
  updatePlaybackDiagnosticButton();

  const crossfadeSlider = document.getElementById('tss-hub-crossfade');
  crossfadeSlider.oninput = e => {
    setCrossfadeSeconds(e.target.value);
  };

  document.querySelectorAll('.tss-crossfade-mode').forEach(button => {
    button.onclick = () => {
      state.crossfadeCurve = button.dataset.curve;
      localStorage.setItem('tss_crossfade_curve', state.crossfadeCurve);
      syncCrossfadeControls();
    };
  });

  const crossfadeManual = document.getElementById('tss-crossfade-manual');
  crossfadeManual.onchange = () => {
    state.crossfadeManual = crossfadeManual.checked;
    localStorage.setItem('tss_crossfade_manual', String(state.crossfadeManual));
    syncCrossfadeControls();
  };

  const playbackVolume = document.getElementById('tss-hub-volume');
  playbackVolume.oninput = () => {
    setPlaybackVolume(Number(playbackVolume.value) / 100);
  };
  const autoLevel = document.getElementById('tss-auto-level');
  autoLevel.onclick = () => {
    setAutoLevelEnabled(!state.autoLevel);
  };
  syncCrossfadeControls();
  syncPlaybackVolumeControls();
  syncEqualizer();
  initializePlaybackVolume();

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
  syncBrowserNowPlaying();
  if (!document.getElementById('tss-hub')) return;
  setOwnPipButtonState();

  const active  = state.active;
  const loading = state.loading;

  const onDifferentPlaylist = active && isCollectionPage(location.href)
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

  syncCrossfadeControls();
  syncPlaybackVolumeControls();
  if (state.crossfadeSeconds > 0 && state.crossfadeStatus === 'off') {
    setCrossfadeStatus('armed');
  } else if (state.crossfadeSeconds <= 0 && !currentDeckAudio()) {
    setCrossfadeStatus('off');
  } else {
    setCrossfadeStatus(state.crossfadeStatus);
  }

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

  const nextTi = upcomingTrackIndex();
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
    if (state.sidebarOpen) {
      if (state._sidebarDirty) renderList();
      syncSidebarToHub();
    }
  }
  if (!state.sidebarOpen) {
    const hub = document.getElementById('tss-hub');
    if (hub) delete hub.dataset.sidebarSide;
  }
  updateHub();
}

// ── list ──────────────────────────────────────────────────────────────────────

function renderList(filter) {
  if (!state.sidebarOpen) {
    state._sidebarDirty = true;
    return;
  }
  state._sidebarDirty = false;
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
      row.oncontextmenu = e => {
        e.preventDefault();
        state.playNext.splice(i, 1);
        refreshUpcomingCrossfadePreparation();
        renderList();
      };
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
      refreshUpcomingCrossfadePreparation();
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
        refreshUpcomingCrossfadePreparation();
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
        refreshUpcomingCrossfadePreparation();
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

const validPage    = () => isSoundCloudPage(location.href);
const playlistBase = url => url.split(/[?#]/)[0].replace(/\/+$/, '');

function soundCloudPathParts(url) {
  try {
    const parsed = new URL(String(url || ''), 'https://soundcloud.com');
    if (parsed.hostname !== 'soundcloud.com') return null;
    return parsed.pathname.split('/').filter(Boolean);
  } catch (_) {
    return null;
  }
}

function isSoundCloudPage(url) {
  return soundCloudPathParts(url) !== null;
}

function isCollectionPage(url) {
  const parts = soundCloudPathParts(url);
  if (!parts) return false;

  // A concrete playlist/album or one of SoundCloud's user track collections
  // can replace the queue and therefore keeps the existing merge workflow.
  if (parts.length >= 3 && parts[1] === 'sets' && Boolean(parts[2])) return true;
  return parts.length === 2 && ['likes', 'tracks', 'reposts'].includes(parts[1]);
}

function isPassiveBrowsePage(url) {
  return isSoundCloudPage(url) && !isCollectionPage(url);
}

let navLock = false;
let navPending = false;
async function onNav() {
  if (state._internalNavigation) {
    if (playlistBase(location.href) === playlistBase(state._internalNavigationTarget || '')) return;
    // A user navigation supersedes a track-source navigation that True Shuffle
    // started internally. Never let the old async load overwrite the new page.
    cancelInternalNavigation();
  }
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

      // Passive browse navigation does not replace the shuffled collection. The
      // custom deck remains authoritative there, and live sync can continue to
      // poll the persisted source playlist without its DOM being visible.
      if (isPassiveBrowsePage(location.href)) {
        state.suspended = false;
        await wait(1500);
        inject();
        updateHub();
        void syncLiveQueue({ force: true });
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
function checkForNavigation() {
  if (location.href === lastUrl) return false;
  lastUrl = location.href;
  void onNav();
  return true;
}

function scheduleLiveQueueSync(delay = 250) {
  if (!state.active || state.suspended) return;
  if (state._liveSyncTimer) clearTimeout(state._liveSyncTimer);
  state._liveSyncTimer = setTimeout(() => {
    state._liveSyncTimer = null;
    if (state.loading || state.busy || state._liveSyncInFlight) {
      scheduleLiveQueueSync(300);
      return;
    }
    void syncLiveQueue({ force: true });
  }, delay);
}

function mutationChangesPlaylistTracks(records) {
  const selector = '.trackList__item, .soundList__item, li.sc-list-item';
  return records.some(record => [...record.addedNodes, ...record.removedNodes].some(node =>
    node?.nodeType === 1 && (node.matches?.(selector) || node.querySelector?.(selector))));
}

function mutationsAreTrueShuffleOnly(records) {
  return records.length > 0 && records.every(record =>
    record.target?.closest?.('#tss-hub, #tss-sidebar, #tss-stats-overlay, #tss-eq-overlay'));
}

function scheduleLiveQueueSyncFromMutation(records) {
  if (playlistBase(location.href) !== playlistBase(state.playlistUrl)
      || !mutationChangesPlaylistTracks(records)) return false;
  scheduleLiveQueueSync();
  return true;
}

new MutationObserver(records => {
  if (mutationsAreTrueShuffleOnly(records)) return;
  if (checkForNavigation()) return;
  else if (validPage() && !document.getElementById('tss-hub') && !injectRetryTimer) {
    injectRetryTimer = setTimeout(() => {
      injectRetryTimer = null;
      inject();
    }, 250);
  }
  scheduleLiveQueueSyncFromMutation(records);
}).observe(document, { subtree: true, childList: true });

// SoundCloud can update history before it renders the next route. Polling the
// URL keeps navigation responsive even when that transition produces no DOM
// mutation, including while the custom player is active in the background.
setInterval(checkForNavigation, 250);
window.addEventListener('popstate', checkForNavigation);

window.addEventListener('pagehide', () => {
  if (equalizerPersistTimer || customPresetsPending) flushEqualizerPersistence();
});

document.addEventListener('visibilitychange', () => {
  checkSleepTimerDeadline();
  if (document.visibilityState === 'visible') scheduleLiveQueueSync(250);
  const deck = currentDeckAudio();
  if (document.visibilityState === 'visible' && state.active && deck && !deck.paused
      && state._audioContext && state._audioContext.state !== 'running') {
    void resumeAudioGraph();
  }
});

window.addEventListener('pageshow', () => {
  checkSleepTimerDeadline();
  scheduleLiveQueueSync(250);
});

installNativePlaybackGuard();
onNav();

})();
