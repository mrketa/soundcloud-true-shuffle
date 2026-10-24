// ==UserScript==
// @name         SoundCloud True Shuffle (Temporary Diagnostic)
// @namespace    https://greasyfork.org/scripts/soundcloud-true-shuffle
// @version      6.3.0
// @require      https://cdn.jsdelivr.net/npm/hls.js@1.7.3/dist/hls.min.js
// @description  Temporary diagnostic copy; disable the stable script while diagnosing playback.
// @author       keta
// @match        https://soundcloud.com/*
// @license      MIT
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @sandbox      raw
// @run-at       document-start
// ==/UserScript==

(function () {
'use strict';

const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
const DIAGNOSTIC_BUILD = true;
// Preserve time for the incoming track's fade-out while allowing short bumpers to fade in.
const CROSSFADE_MIN_DURATION_SECONDS = 0.25;
const CUSTOM_EQ_PRESETS_KEY = 'tss_eq_custom_presets_v1';
const BLOCKED_EQ_PRESET_NAMES = new Set(['__proto__', 'prototype', 'constructor']);
const PLAYBACK_DIAGNOSTIC_FAULTS = new Set([
  'crossfade-clock-stall', 'crossfade-deck-paused', 'crossfade-handoff-failed',
  'recovery-exhausted', 'recovery-failed', 'playback-operation-failed',
  'custom-start-exhausted', 'custom-start-candidate-failed', 'hls-playback-failed',
  'audio-graph-failed', 'audio-context-resume-failed', 'audio-context-suspend-failed',
  'native-fallback-unavailable', 'native-track-not-acknowledged', 'native-start-failed',
  'prefetch-failed', 'stop-cleanup-failed',
]);

// Accessing localStorage itself can throw in restricted browser contexts.
const safeStorage = {
  getItem(key) {
    try { return localStorage.getItem(key); } catch (_) { return null; }
  },
  setItem(key, value) {
    try { localStorage.setItem(key, value); return true; } catch (_) { return false; }
  },
  removeItem(key) {
    try { localStorage.removeItem(key); return true; } catch (_) { return false; }
  },
};

const DIAGNOSTIC_NUMBER_FIELDS = new Set([
  'schemaVersion', 'attemptId', 'operationId', 'playbackEpoch', 'collectionEpoch',
  'trackIndex', 'deckTrack', 'nativeTrackIndex',
  'attempt', 'attempted', 'priorFailedCandidates', 'precedingFailedCandidates',
  'queuePosition', 'queueLength', 'deckIndex', 'outgoingIndex', 'incomingIndex', 'index',
  'deckCount', 'deckGain', 'mixGain', 'autoGain', 'elapsedMs', 'durationMs', 'duration', 'position', 'resumedAt',
  'stallThresholdMs',
  'readyState', 'networkState', 'mediaErrorCode', 'errorCode', 'status', 'hlsStatus', 'stalledFor',
  'requestCount', 'credentialAttempts', 'progressiveCandidates', 'progressiveUrls',
  'hlsCandidates', 'hlsAac160Candidates', 'hlsAac96Candidates', 'hlsOtherCandidates',
  'hlsStreamUrls', 'streamCandidateCount', 'mediaCandidateOrdinal', 'delayMs',
  'startTime', 'endTime', 'lastClockValue', 'lastClockAdvanceAt', 'lastIncomingTime',
  'lastIncomingAdvanceAt', 'sampleRate', 'currentTime', 'mediaCurrentTime',
  'incomingCurrentTime', 'outgoingCurrentTime', 'incomingReadyState', 'incomingNetworkState',
  'clockElapsed', 'clockStalledFor',
  'mediaStalledFor', 'crossfadeSeconds', 'crossfadeDuration', 'crossfadeToken', 'token',
  'levelCount', 'currentLevel', 'bandwidthEstimate', 'hlsErrorCount',
  'hlsNonFatalErrorCount', 'hlsFatalErrorCount', 'hlsLevelCount', 'hlsCurrentLevel',
  'hlsBandwidthEstimate', 'hlsBufferedFragmentCount', 'hlsMediaAttachedElapsedMs',
  'hlsManifestParsedElapsedMs', 'hlsFirstFragmentBufferedElapsedMs', 'mediaWaitElapsedMs',
  'playElapsedMs', 'pollCount', 'nativePollCount', 'pollLimit', 'maxPolls', 'attempts',
  'recoveryAttempts', 'elapsed', 'timeoutMs', 'waitMs', 'remainingMs', 'bufferedAhead',
  'playbackRate', 'browserMajorVersion', 'monotonicMs', 'previousToken', 'incomingDuration',
  'sampledSchedulingLeadMs', 'schedulingSubmissionMs', 'estimatedSchedulingLeadMs',
  'observationElapsedMs', 'audioClockFromFadeStartMs',
  'incomingBaselineTime', 'incomingScheduledTime', 'incomingAdvanceMs',
]);
const DIAGNOSTIC_BOOLEAN_FIELDS = new Set([
  'passExhausted', 'clientIdFound', 'authFailed', 'trackMetadataFound',
  'progressiveMetadataAvailable', 'authorizationPresent', 'retryPending', 'active', 'loading',
  'crossfadePending',
  'busy', 'suspended', 'crossfading', 'crossfadePausedByUser', 'paused', 'ended',
  'seeking', 'hlsSupported', 'hlsLibraryAvailable', 'hlsMediaAttached', 'hlsLoading',
  'hlsManifestParsed', 'hlsFirstFragmentBuffered', 'hlsReady', 'hlsMseSupported', 'mseSupported',
  'mediaSourceAvailable', 'nativeHlsSupported', 'audioContextAvailable',
  'sourceNodeConnected', 'graphFailed', 'audioGraphFailed', 'playFulfilled', 'ready',
  'userPaused', 'visible', 'focused', 'onLine', 'buttonFound', 'clickIssued',
  'acknowledged', 'hasCurrentSrc', 'sourceBound', 'fallbackAvailable', 'automatic',
  'crossfadeManual', 'diagnosticsEnabled', 'graphAvailable', 'recoveredSchedule', 'incomingPaused',
  'outgoingPaused', 'nativeAudioFound', 'playerMatched', 'elementFound', 'elementAttached',
  'trackElementPresent', 'playButtonFound', 'playClickIssued', 'nativeAcknowledged', 'nativeTransportPaused',
  'bufferedDataAvailable',
  'autoLevel', 'eqEnabled', 'safetyClipper', 'foreground', 'detached', 'fatal', 'transitionDiagnosticsEnabled',
  'progressAlreadyAtSchedule',
]);
const DIAGNOSTIC_STRING_FIELDS = new Set([
  'event', 'operation', 'stage', 'failureStage', 'failureReason', 'reason',
  'streamSource', 'clientIdSource', 'mediaWaitOutcome', 'nativeOutcome',
  'nativeFallbackReason', 'hlsMode', 'hlsErrorType', 'hlsErrorDetail',
  'hlsLastErrorType', 'hlsLastErrorDetail', 'errorName', 'error', 'contextState',
  'contextStateBefore', 'contextStateAfter', 'audioContextState', 'crossfadeStatus',
  'crossfadeCurve', 'startedVia', 'pageKind', 'streamKind', 'streamQuality',
  'qualityClass', 'streamProtocol', 'browser', 'platform', 'manager',
  'managerVersion', 'scriptVersion', 'hlsLibraryVersion', 'graphPhase', 'graphReason',
  'phase', 'outcome', 'result', 'recoveryOutcome', 'recoveryReason', 'stateName',
  'sourceKind', 'errorType', 'errorDetail', 'nativeReason', 'nativeAction',
  'hlsStage', 'audioGraphPhase', 'audioGraphReason', 'requestStage', 'crossfadeOutcome',
  'crossfadeMode',
]);
const DIAGNOSTIC_NESTED_FIELDS = new Set([
  'requests', 'audioFeatures', 'state', 'audioContext', 'schedule', 'decks',
  'diagnostics', 'environment', 'capabilities', 'incident', 'fault',
]);
const DIAGNOSTIC_SAFE_LABELS = {
  browser: new Set(['chrome', 'chromium', 'edge', 'firefox', 'opera', 'safari', 'other', 'unknown']),
  platform: new Set(['windows', 'macos', 'linux', 'android', 'ios', 'other', 'unknown']),
  manager: new Set(['tampermonkey', 'violentmonkey', 'greasemonkey', 'other', 'unknown']),
  pageKind: new Set(['home', 'likes', 'reposts', 'feed', 'playlist', 'tracks', 'user-tracks', 'profile', 'other']),
  streamKind: new Set(['progressive', 'hls-mse', 'native', 'blob', 'none', 'unknown']),
  qualityClass: new Set(['aac-160k', 'aac-96k', 'mp3', 'opus', 'other', 'unknown']),
  hlsMode: new Set(['not-used', 'mse', 'unsupported']),
  crossfadeCurve: new Set(['smooth', 'clean', 'dj']),
  contextState: new Set(['running', 'suspended', 'closed', 'interrupted', 'missing', 'unknown']),
};

function safeDiagnosticVersion(value) {
  const version = String(value || '');
  return version.length <= 64 && /^\d{1,3}\.\d{1,3}\.\d{1,3}(?:\.\d{1,3})?(?:[-+][A-Za-z0-9.-]+)?$/.test(version) ? version : 'unknown';
}

function safeDiagnosticString(key, value) {
  if (typeof value !== 'string') return '';
  if (key === 'error' || key === 'errorName') return playbackErrorName({ name: value });
  if (key === 'scriptVersion' || key === 'managerVersion' || key === 'hlsLibraryVersion') {
    return safeDiagnosticVersion(value);
  }
  const text = value.trim();
  if (!text || text.length > 64) return '';
  const normalized = key === 'operation' ? text.toLowerCase().replace(/\s+/g, '-') : text;
  if (DIAGNOSTIC_SAFE_LABELS[key]) {
    const label = normalized.toLowerCase();
    return DIAGNOSTIC_SAFE_LABELS[key].has(label) ? label : '';
  }
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(normalized) ? normalized : '';
}

function sanitizeDiagnosticRecord(value, depth = 0) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 3) return {};
  const clean = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'at') {
      if (typeof item === 'string' && Number.isFinite(Date.parse(item))) clean.at = new Date(item).toISOString();
      continue;
    }
    if (DIAGNOSTIC_NUMBER_FIELDS.has(key)) {
      if (typeof item === 'number' && Number.isFinite(item) && Math.abs(item) <= 1e9) {
        clean[key] = Math.round(item * 1000) / 1000;
      }
      continue;
    }
    if (DIAGNOSTIC_BOOLEAN_FIELDS.has(key)) {
      if (typeof item === 'boolean') clean[key] = item;
      continue;
    }
    if (DIAGNOSTIC_STRING_FIELDS.has(key)) {
      const safe = safeDiagnosticString(key, item);
      if (safe && (key !== 'error' || !clean.errorName)) clean[key === 'error' ? 'errorName' : key] = safe;
      continue;
    }
    if (!DIAGNOSTIC_NESTED_FIELDS.has(key)) continue;
    if (key === 'requests') {
      if (Array.isArray(item)) {
        clean.requests = item.slice(-8)
          .map(entry => sanitizeDiagnosticRecord(entry, depth + 1))
          .filter(entry => Object.keys(entry).length > 0);
      }
    } else if (key === 'decks') {
      if (Array.isArray(item)) {
        clean.decks = item.slice(0, 2).map(entry =>
          entry && typeof entry === 'object' ? sanitizeDiagnosticRecord(entry, depth + 1) : null);
      }
    } else if (key === 'diagnostics') {
      if (Array.isArray(item)) {
        clean.diagnostics = item.slice(-80)
          .map(entry => sanitizeDiagnosticRecord(entry, depth + 1))
          .filter(entry => typeof entry.event === 'string' && typeof entry.at === 'string');
      }
    } else if (item && typeof item === 'object' && !Array.isArray(item)) {
      clean[key] = sanitizeDiagnosticRecord(item, depth + 1);
    }
  }
  return clean;
}

function sanitizePlaybackDiagnostics(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(-80).map(entry => sanitizeDiagnosticRecord(entry))
    .filter(entry => typeof entry.event === 'string' && typeof entry.at === 'string');
}

function sanitizeAutoLevelCache(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([key, entry]) =>
    !BLOCKED_EQ_PRESET_NAMES.has(key) && entry && typeof entry === 'object'
      && Number.isFinite(entry.rms) && entry.rms >= 0.015
      && Number.isFinite(entry.peak) && entry.peak >= entry.rms
      && Number.isFinite(entry.ts) && entry.ts >= 0
  ).sort((a, b) => b[1].ts - a[1].ts).slice(0, 300));
}

// Bound the complete operation, including response bodies and browser promises.
// Aborting an old session must settle even if the underlying API ignores abort.
function withDeadline(operation, timeoutMs = 10000, signal = null) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    let settled = false;
    let timer;
    const finish = (ok, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (ok) resolve(value);
      else reject(value);
    };
    const onAbort = () => {
      const error = signal.reason || new DOMException('Operation cancelled', 'AbortError');
      finish(false, error);
      controller.abort(error);
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      const error = new DOMException('Operation timed out', 'TimeoutError');
      finish(false, error);
      controller.abort(error);
    }, timeoutMs);
    try {
      Promise.resolve(operation(controller.signal)).then(
        value => finish(true, value),
        error => finish(false, error),
      );
    } catch (error) {
      finish(false, error);
    }
  });
}

async function fetchSoundCloudResource(url, format = 'json', options = {}) {
  const {
    signal, timeoutMs = 10000, diagnosticTrace = null,
    diagnosticStage = 'soundcloud-resource', ...requestOptions
  } = options;
  const startedAt = diagnosticTrace ? performance.now() : 0;
  let responseStatus = null;
  try {
    return await withDeadline(async requestSignal => {
      const response = await fetch(url, { ...requestOptions, signal: requestSignal });
      responseStatus = Number(response.status);
      const data = response.ok ? await response[format]() : null;
      if (diagnosticTrace) {
        recordCustomStartRequest(
          diagnosticTrace, diagnosticStage, responseStatus, performance.now() - startedAt,
        );
      }
      return { ok: response.ok, status: response.status, data };
    }, timeoutMs, signal);
  } catch (error) {
    if (diagnosticTrace) {
      recordCustomStartRequest(
        diagnosticTrace, diagnosticStage, responseStatus, performance.now() - startedAt,
        playbackErrorName(error),
      );
    }
    throw error;
  }
}

function invalidatePlaybackSession() {
  state._playbackEpoch++;
  state._collectionEpoch++;
  state._playbackAbort.abort();
  state._playbackAbort = new AbortController();
  return state._playbackEpoch;
}

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
    return sanitizeCustomEqPresets(JSON.parse(safeStorage.getItem('tss_eq_custom_presets') || '{}'));
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



const state = {
  _diagnosticBuild: DIAGNOSTIC_BUILD,
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
  _playbackEpoch: 0,
  _playbackAbort: new AbortController(),
  _collectionEpoch: 0,
  _userPaused: false,
  lastTitle:    '',
  lastProgress: 0,
  sidebarOpen:  false,
  reduceVisualEffects: safeStorage.getItem('tss_reduce_visual_effects') === 'true',
  scrollLongTitles: safeStorage.getItem('tss_scroll_long_titles') !== 'false',
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
  _lastWaveformKey: '',
  _waveformBars: null,
  _lastWaveformPlayed: 0,
  _endedHandler: null,
  _manualActionAt: 0,
  _likeBusy: false,
  _likeStateTrack: null,
  _likeStateLastCheck: 0,
  crossfadeSeconds: Math.max(0, Math.min(12, Number(safeStorage.getItem('tss_crossfade_seconds')) || 0)),
  crossfadeCurve: ['smooth', 'clean', 'dj'].includes(safeStorage.getItem('tss_crossfade_curve'))
    ? safeStorage.getItem('tss_crossfade_curve')
    : 'smooth',
  crossfadeManual: safeStorage.getItem('tss_crossfade_manual') !== 'false',
  _playbackVolumeStored: safeStorage.getItem('tss_playback_volume') !== null
    || safeStorage.getItem('tss_crossfade_output') !== null,
  _playbackVolumeInitialized: false,
  playbackVolume: (() => {
    const saved = safeStorage.getItem('tss_playback_volume') ?? safeStorage.getItem('tss_crossfade_output');
    if (saved === null) return 0.1;
    const value = Number(saved);
    return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.1;
  })(),
  autoLevel: safeStorage.getItem('tss_auto_level') === 'true',
  safetyClipper: safeStorage.getItem('tss_safety_clipper') === 'true',
  eqEnabled: safeStorage.getItem('tss_eq_enabled') === 'true',
  eqBands: (() => {
    try {
      const values = JSON.parse(safeStorage.getItem('tss_eq_bands') || '[]');
      return Array.isArray(values) && values.length === 5
        ? values.map(value => Math.max(-12, Math.min(12, Number(value) || 0)))
        : [0, 0, 0, 0, 0];
    } catch (_) { return [0, 0, 0, 0, 0]; }
  })(),
  eqPreset: safeStorage.getItem('tss_eq_preset') || 'Flat',
  customEqPresets: loadCustomEqPresets(),
  _equalizerSaveFailed: false,
  crossfadeStatus: 'off',
  _crossfadePending: false,
  _crossfading: false,
  _crossfadePausedByUser: false,
  _crossfadePauseGeneration: 0,
  _crossfadeSchedule: null,
  _crossfadeToken: 0,
  _deckIndex: -1,
  _deckTrack: null,
  _nativeTrack: null,
  _nativeSessionNoticeShown: false,
  _decks: [],
  _deckHlsPlayers: [null, null],
  _deckHlsFailed: [false, false],
  _deckPrepareTokens: [0, 0],
  _deckTracks: [null, null],
  _crossfadeStreamWarmup: null,
  _crossfadePrefetchToken: 0,
  _deckGains: [0, 0],
  _audioContext: null,
  _audioGraphFailed: false,
  _audioMaster: null,
  _audioClipper: null,
  _deckAudioGraphs: [null, null],
  _appliedMasterGain: null,
  _autoLevelLastTick: 0,
  _autoLevelCache: (() => {
    try {
      const parsed = JSON.parse(safeStorage.getItem('tss_auto_level_cache_v4') || '{}');
      return sanitizeAutoLevelCache(parsed);
    } catch (_) { return {}; }
  })(),
  _autoLevelCacheTimer: null,
  _streamCache: new Map(),
  _clientId: '',
  _lastSoundCloudVolume: null,
  _soundCloudVolumeModel: null,
  _customPlaybackRetryTimer: null,
  _pipBridgePlayer: null,
  _pipBridgeOriginals: null,
  _pipBridgeWrappers: null,
  _ownPipWindow: null,
  _ownPipMode: null,
  pipArtworkMode: ['compact', 'full', 'focus'].includes(safeStorage.getItem('tss_pip_artwork_mode'))
    ? safeStorage.getItem('tss_pip_artwork_mode')
    : 'compact',
  _ownPipHost: null,
  _videoPip: null,
  _pipOpenTransaction: null,
  _ownPipCleanup: null,
  _pipTrackMenuClose: null,
  _ctxMenuClose: null,
  _browserMediaOwner: null,
  _playTimeLastAt: null,
  _playTimeWasAudible: false,
  _playTimeRemainderMs: 0,
  _liveSyncSources: new Map(),
  _liveSyncInFlight: false,
  _liveSyncLastCheck: 0,
  _liveSyncTimer: null,
  _playbackDiagnostics: (() => {
    safeStorage.removeItem('tss_playback_diagnostics');
    return [];
  })(),
  _playbackDiagnosticFault: false,
  _playbackDiagnosticIncident: null,
  _transitionDiagnostics: true,
  _tabTitleBeforePlayback: null,
  _tabTitleValue: '',
  _browserMetadataKey: '',
  stats: {
    played:     0,
    playCounts: {},
    elapsed:    0,
  },
};


function fisherYates(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Efraimidis-Spirakis weighted sampling without replacement.
function weightedShuffle(indices) {
  return indices
    .map(ti => ({ ti, k: Math.random() ** (1 / (state.priority[ti] ?? 1.0)) }))
    .sort((a, b) => b.k - a.k)
    .map(x => x.ti);
}

function trackSpacingKey(ti, meta = state.meta) {
  const title = String(meta[ti]?.title || '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
  if (title.includes('[tss-bumper]')) return '\u0000group:tss-bumper';
  return title && title !== '—' ? title : `\u0000track:${ti}`;
}

function spaceDuplicateTitles(queue, meta = state.meta, previousTi = null) {
  const previousKey = previousTi === null || previousTi === undefined
    ? null
    : trackSpacingKey(previousTi, meta);
  const arrangeAdjacentGroups = (items, boundaryKey = null) => {
    let lastKey = boundaryKey;
    let hasAdjacentDuplicates = false;
    for (const ti of items) {
      const key = trackSpacingKey(ti, meta);
      hasAdjacentDuplicates ||= key === lastKey;
      lastKey = key;
    }
    if (!hasAdjacentDuplicates) return items;

    const byTitle = new Map();
    items.forEach((ti, order) => {
      const key = trackSpacingKey(ti, meta);
      if (!byTitle.has(key)) byTitle.set(key, { key, items: [], next: 0, order });
      byTitle.get(key).items.push(ti);
    });

    const remaining = group => group.items.length - group.next;
    const higherPriority = (a, b) => remaining(a) > remaining(b)
      || (remaining(a) === remaining(b) && a.order < b.order);
    const heap = [];
    const push = group => {
      heap.push(group);
      for (let child = heap.length - 1; child > 0;) {
        const parent = Math.floor((child - 1) / 2);
        if (!higherPriority(heap[child], heap[parent])) break;
        [heap[parent], heap[child]] = [heap[child], heap[parent]];
        child = parent;
      }
    };
    const pop = () => {
      const top = heap[0];
      const last = heap.pop();
      if (heap.length && last) {
        heap[0] = last;
        for (let parent = 0;;) {
          const left = parent * 2 + 1;
          const right = left + 1;
          let best = parent;
          if (left < heap.length && higherPriority(heap[left], heap[best])) best = left;
          if (right < heap.length && higherPriority(heap[right], heap[best])) best = right;
          if (best === parent) break;
          [heap[parent], heap[best]] = [heap[best], heap[parent]];
          parent = best;
        }
      }
      return top;
    };
    byTitle.forEach(push);

    const spaced = [];
    lastKey = boundaryKey;
    while (heap.length) {
      let group = pop();
      if (group.key === lastKey) {
        const alternative = pop();
        if (!alternative) return items;
        push(group);
        group = alternative;
      }
      spaced.push(group.items[group.next++]);
      lastKey = group.key;
      if (remaining(group)) push(group);
    }
    return spaced;
  };

  const bumperKey = '\u0000group:tss-bumper';
  const groupsByKey = new Map();
  queue.forEach((ti, order) => {
    const key = trackSpacingKey(ti, meta);
    if (!groupsByKey.has(key)) groupsByKey.set(key, { key, items: [], order });
    groupsByKey.get(key).items.push(ti);
  });

  const markedBumpers = groupsByKey.get(bumperKey);
  const repeatedTitles = [...groupsByKey.values()]
    .filter(group => group.key !== bumperKey && group.items.length > 1)
    .sort((a, b) => b.items.length - a.items.length || a.order - b.order);
  const dominantRepeatedTitle = repeatedTitles.length === 1
    || repeatedTitles[0]?.items.length > repeatedTitles[1]?.items.length
    ? repeatedTitles[0]
    : null;
  const spreadGroup = markedBumpers?.items.length > 1
    ? markedBumpers
    : dominantRepeatedTitle;

  // A no-adjacency heap naturally alternates a repeated group until it runs
  // out. Explicitly marked bumpers and an unambiguously dominant repeated
  // title need a stronger guarantee: span the complete shuffled round.
  if (spreadGroup) {
    const repeatedTracks = spreadGroup.items;
    const otherTracks = queue.filter(ti => trackSpacingKey(ti, meta) !== spreadGroup.key);
    const requiredSeparators = repeatedTracks.length - 1 + (previousKey === spreadGroup.key ? 1 : 0);
    if (otherTracks.length >= requiredSeparators) {
      const arrangedOthers = arrangeAdjacentGroups(otherTracks, previousKey);
      const gaps = new Array(repeatedTracks.length + 1).fill(0);
      for (let i = 1; i < repeatedTracks.length; i++) gaps[i] = 1;
      if (previousKey === spreadGroup.key) gaps[0] = 1;

      const mandatory = gaps.reduce((sum, count) => sum + count, 0);
      const extras = arrangedOthers.length - mandatory;
      for (let i = 0; i < gaps.length; i++) {
        gaps[i] += Math.floor(((i + 1) * extras) / gaps.length)
          - Math.floor((i * extras) / gaps.length);
      }

      const spaced = [];
      let otherIndex = 0;
      for (let i = 0; i < repeatedTracks.length; i++) {
        spaced.push(...arrangedOthers.slice(otherIndex, otherIndex + gaps[i]));
        otherIndex += gaps[i];
        spaced.push(repeatedTracks[i]);
      }
      spaced.push(...arrangedOthers.slice(otherIndex));
      queue.splice(0, queue.length, ...spaced);
      return queue;
    }
  }

  const spaced = arrangeAdjacentGroups(queue, previousKey);
  if (spaced !== queue) queue.splice(0, queue.length, ...spaced);
  return queue;
}

function buildReshuffledQueue(indices, currentTi = null, meta = state.meta) {
  const pool = indices.filter(ti => ti !== currentTi);
  const shuffled = fisherYates(pool);
  if (currentTi === null || currentTi === undefined) {
    return spaceDuplicateTitles(shuffled, meta);
  }
  return [currentTi, ...spaceDuplicateTitles(shuffled, meta, currentTi)];
}

// Least-used eligible starters keep small playlists balanced across rounds.
function buildBalancedRound(indices, previousTi = null) {
  if (!indices.length) return [];

  const eligible = indices.length > 1
    ? indices.filter(ti => ti !== previousTi)
    : indices.slice();
  const fewestStarts = Math.min(...eligible.map(ti => state.roundStarts[ti] || 0));
  const starterPool = eligible.filter(ti => (state.roundStarts[ti] || 0) === fewestStarts);
  const first = fisherYates(starterPool)[0];
  const round = spaceDuplicateTitles(
    [first, ...weightedShuffle(indices.filter(ti => ti !== first))],
    state.meta,
    previousTi,
  );
  const actualFirst = round[0];
  state.roundStarts[actualFirst] = (state.roundStarts[actualFirst] || 0) + 1;
  return round;
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
  let nativeAudioFound = false;
  for (const audio of document.querySelectorAll('audio')) {
    if (isTrueShuffleAudio(audio) || !audio.currentSrc) continue;
    nativeAudioFound = true;
    if (!audio.paused) return false;
  }
  if (nativeAudioFound) return true;
  return soundCloudPaused() !== false;
}

function soundCloudPaused() {
  const btn = document.querySelector('.playControls__play');
  if (!btn) return null;
  const labels = [btn.getAttribute('aria-label') || '', btn.title || ''].map(value => value.trim().toLowerCase());
  if (labels.some(label => label.startsWith('pause'))) return false;
  if (labels.some(label => label.startsWith('play'))) return true;
  return null;
}

function isTrueShuffleAudio(audio) {
  return Boolean(audio && (
    state._decks?.includes(audio) ||
    audio.dataset?.tssCrossfadeDeck !== undefined
  ));
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
  if (!button || soundCloudPaused() !== false) return false;
  state._nativeGuardButtonAction = true;
  try {
    button.click();
    return true;
  } finally {
    state._nativeGuardButtonAction = false;
  }
}

function nativePlaybackAllowed() {
  return Boolean(state.active && !state.suspended && !state._userPaused
    && Number.isInteger(state._nativeTrack) && state.queue[state.pos] === state._nativeTrack);
}

function installNativePlaybackGuard() {
  if (state._nativePlaybackGuardInstalled) return;
  state._nativePlaybackGuardInstalled = true;

  document.addEventListener('click', event => {
    const button = event.target?.closest?.('.playControls__play');
    if (!button || state._nativeGuardButtonAction || nativePlaybackAllowed()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    queueMicrotask(() => {
      if (nativePlaybackAllowed()) return;
      pauseSoundCloudTransport();
      pauseSoundCloud();
    });
  }, true);

  document.addEventListener('play', event => {
    const audio = event.target;
    if (audio?.tagName !== 'AUDIO' || isTrueShuffleAudio(audio) || nativePlaybackAllowed()) return;
    // Native autoplay is blocked even before True Shuffle starts. Only an
    // explicitly selected native fallback may use SoundCloud's player.
    try { audio.pause(); } catch (_) {}
    queueMicrotask(() => {
      if (nativePlaybackAllowed()) return;
      pauseSoundCloudTransport();
      pauseSoundCloud();
    });
  }, true);

  // SoundCloud may restore its native player shortly after a hard reload.
  // Catch both an already-running element and delayed autoplay initialization.
  [0, 100, 500, 1500, 3000].forEach(delay => {
    setTimeout(() => {
      if (!nativePlaybackAllowed()) {
        pauseSoundCloudTransport();
        pauseSoundCloud();
      }
    }, delay);
  });
}

function pause() {
  state._userPaused = true;
  state._crossfadePauseGeneration = (state._crossfadePauseGeneration || 0) + 1;
  if (state._crossfading) state._crossfadePausedByUser = true;
  if (state._crossfadeSchedule?.incomingClockObservation) delete state._crossfadeSchedule.incomingClockObservation;
  const deck = currentDeckAudio();
  if (deck) {
    state._decks.forEach(audio => {
      try { if (audio && !audio.paused) audio.pause(); } catch (_) {}
    });
    if (state._crossfading) void suspendAudioGraph(state._playbackAbort.signal);
    return;
  }
  pauseSoundCloud();
}

async function toggle() {
  const epoch = state._playbackEpoch;
  if (!state.active) return;
  const signal = state._playbackAbort.signal;
  const deck = currentDeckAudio();
  const pending = state._pendingPlaybackTrack;
  const pendingCurrent = pending?.epoch === epoch;
  const retryGraph = Number.isInteger(state._deckTrack)
    && (state._userPaused || !deck || deck.paused)
    && (state._audioGraphFailed || state._audioContext?.state === 'closed');
  if ((pendingCurrent || retryGraph) && !state.busy) {
    const ti = pendingCurrent ? pending.ti : state._deckTrack;
    const countPlay = pendingCurrent ? pending.countPlay : false;
    const position = pendingCurrent ? pending.position : (Number(deck?.currentTime) || 0);
    const initialSeek = state._deckSeekRequest;
    state._pendingPlaybackTrack = null;
    state._userPaused = false;
    state._crossfadePausedByUser = false;
    await runPlaybackOperation('resume prepared', async isCurrent => {
      const played = await playAt(ti, countPlay);
      if (!isCurrent()) return played;
      if (played === true && Number.isFinite(position)) {
        const resumedDeck = currentDeckAudio();
        const latestSeek = state._deckSeekRequest;
        if (resumedDeck) {
          const desiredTime = latestSeek !== initialSeek && latestSeek?.epoch === epoch
            && latestSeek.audio === resumedDeck ? latestSeek.time : position;
          const duration = Number(resumedDeck.duration);
          resumedDeck.currentTime = Math.min(Math.max(0, desiredTime),
            Number.isFinite(duration) ? Math.max(0, duration - 0.1) : desiredTime);
        }
      } else if (state._pendingPlaybackTrack?.epoch === epoch
          && state._pendingPlaybackTrack.ti === ti) {
        state._pendingPlaybackTrack.position = position;
      }
      return played;
    });
    return;
  }
  if (deck) {
    const resume = state._userPaused || deck.paused;
    if (!resume) {
      pause();
      refreshPlayBtn();
      return;
    }
    state._userPaused = false;
    state._crossfadePausedByUser = false;
    const decks = state._crossfading
      ? state._decks.filter((audio, index) => audio && state._deckTracks[index] !== null)
      : [deck];
    const identities = decks.map(audio => {
      const index = state._decks.indexOf(audio);
      return { audio, index, token: state._deckPrepareTokens[index], track: state._deckTracks[index] };
    });
    const isCurrent = () => state.active && state._playbackEpoch === epoch
      && !signal.aborted && !state._userPaused
      && identities.every(({ audio, index, token, track }) => state._decks[index] === audio
        && state._deckPrepareTokens[index] === token && state._deckTracks[index] === track);
    try {
      if (!await resumeAudioGraph(signal) || !isCurrent()) return;
      await Promise.all(identities.map(({ audio, index }) =>
        playDeckWithDeadline(audio, index, signal, isCurrent)));
      if (!isCurrent()) return;
    } catch (_) {
      if (!isCurrent()) return;
    } finally {
      if (state._playbackEpoch === epoch) refreshPlayBtn();
    }
    return;
  }
  if (!state.suspended && Number.isInteger(state._nativeTrack)
      && state.queue[state.pos] === state._nativeTrack) {
    if (!paused()) {
      pause();
    } else {
      const meta = state.meta[state._nativeTrack];
      const playerMatched = soundCloudPlayerMatches(meta);
      const button = document.querySelector('.playControls__play');
      if (!button || soundCloudPaused() !== true || !playerMatched) {
        showMergeToast('SoundCloud playback is unavailable until this track is visible');
        refreshPlayBtn();
        return false;
      }
      const userPaused = state._userPaused;
      state._nativeGuardButtonAction = true;
      state._userPaused = false;
      try {
        button.click();
      } catch (error) {
        state._userPaused = userPaused;
        throw error;
      } finally {
        state._nativeGuardButtonAction = false;
      }
    }
    setTimeout(() => { if (state._playbackEpoch === epoch) refreshPlayBtn(); }, 150);
    return;
  }
  const ti = state.queue[state.pos];
  if (ti === undefined || state.busy) return;
  state._userPaused = false;
  await runPlaybackOperation('resume', () => playAt(ti, false));
}

function seekTo(ratio) {
  ratio = Math.max(0, Math.min(1, ratio));
  const deck = currentDeckAudio();
  if (deck && ((Number.isFinite(deck.duration) && deck.duration > 0) || ratio === 0)) {
    const time = ratio === 0 ? 0 : deck.duration * ratio;
    state._deckSeekRequest = { epoch: state._playbackEpoch, audio: deck, time };
    deck.currentTime = time;
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
  if (!p) return;
  const label = paused() ? 'Play' : 'Pause';
  if (p.getAttribute('aria-label') !== label) p.setAttribute('aria-label', label);
  const icon = paused() ? SVG.play : SVG.pause;
  // SVG serialization expands self-closing tags; compare the actual last render.
  if (p._tssPlayIcon === icon && p.innerHTML === p._tssPlayMarkup) return;
  p.innerHTML = icon;
  p._tssPlayIcon = icon;
  p._tssPlayMarkup = p.innerHTML;
}

function updateProgressBar(timing = playbackTiming()) {
  const ratio = Math.max(0, Math.min(1, timing.duration ? timing.current / timing.duration : 0));
  const p = document.getElementById('tss-hub-prog');
  const width = `${(ratio * 100).toFixed(1)}%`;
  if (p && p.style.width !== width) p.style.width = width;
  const seekbar = document.getElementById('tss-hub-seekbar');
  const percent = String(Math.round(ratio * 100));
  if (seekbar && seekbar.getAttribute('aria-valuenow') !== percent) seekbar.setAttribute('aria-valuenow', percent);
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

function soundCloudInteger(value, minimum = 0) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value.trim()))) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= minimum ? number : null;
}

function soundCloudHref(href) {
  if (typeof href !== 'string' || !href.trim()) return null;
  try {
    const url = new URL(href, 'https://soundcloud.com/');
    return /^https?:$/.test(url.protocol) ? url.href : null;
  } catch (_) { return null; }
}

function getLink(el) {
  const a = el.querySelector('.trackItem__trackTitle, .soundTitle__title, a.sc-link-primary');
  if (!a) return null;
  return soundCloudHref(a.getAttribute('href'));
}

function waveformUrl(el) {
  const direct = el.querySelector('[data-waveform-url]')?.getAttribute('data-waveform-url');
  if (direct) return direct;
  const match = el.outerHTML.match(/https?:\/\/wave\.sndcdn\.com\/[^"'\s<>)]+/i);
  return match ? match[0].replace(/&amp;/g, '&') : null;
}

function getArtistLink(el) {
  const a = el.querySelector('.trackItem__username, .soundTitle__username')
    || el.querySelector('a.sc-link-secondary');
  if (!a) return null;
  return soundCloudHref(a.getAttribute('href'));
}

function trackId(m) {
  if (!m) return null;
  if (m.link) return m.link;
  const t = m.title, a = m.artist;
  if ((t && t !== '—') || (a && a !== '—')) return `${t}|||${a}`;
  return null;
}

function trackCacheKey(meta) {
  const id = soundCloudInteger(meta?.soundcloudId ?? meta?.id, 1);
  return id !== null ? `soundcloud:${id}` : trackId(meta);
}

function indexTrackMeta(index, meta, ti) {
  const key = trackCacheKey(meta);
  const previousKey = index.keys[ti];
  if (previousKey && previousKey !== key && index.byKey.get(previousKey) === ti) index.byKey.delete(previousKey);
  index.keys[ti] = key;
  if (key) index.byKey.set(key, ti);
  const link = normalizeTrackUrl(meta?.link || meta?.permalink_url || meta?.permalinkUrl);
  const previousLink = index.links[ti];
  if (previousLink && previousLink !== link) index.byLink.get(previousLink)?.delete(ti);
  index.links[ti] = link;
  if (!link) return;
  let members = index.byLink.get(link);
  if (!members) index.byLink.set(link, members = new Set());
  members.add(ti);
}

function trackIdentityIndex(metas) {
  const index = { metas, byKey: new Map(), byLink: new Map(), keys: [], links: [] };
  metas.forEach((meta, ti) => indexTrackMeta(index, meta, ti));
  return index;
}

function matchingTrackIndex(index, meta) {
  const key = trackCacheKey(meta);
  if (!key) return undefined;
  const exact = index.byKey.get(key);
  if (exact !== undefined) return exact;
  const link = normalizeTrackUrl(meta?.link || meta?.permalink_url || meta?.permalinkUrl);
  const candidates = index.byLink.get(link);
  if (!candidates) return undefined;
  let match;
  for (const ti of candidates) {
    if (!soundCloudTrackMatches(meta, index.metas[ti])) continue;
    if (match !== undefined) return undefined;
    match = ti;
  }
  return match;
}

function getMeta(el) {
  const likeButton = el.querySelector('.sc-button-like');
  const artistNames = [...new Set([...el.querySelectorAll('.trackItem__username, .soundTitle__username')]
    .map(node => node.textContent.trim())
    .filter(name => name && name !== '—'))];
  const fallbackArtist = artistNames.length ? '' : el.querySelector('.sc-link-secondary')?.textContent.trim();
  return {
    title:   el.querySelector('.trackItem__trackTitle, .soundTitle__title, .sc-link-primary')?.textContent.trim() || '—',
    artist:  artistNames.join(', ') || fallbackArtist || '—',
    artwork: artwork(el),
    link:    getLink(el),
    artistLink: getArtistLink(el),
    waveform: waveformUrl(el),
    liked: likeButton ? soundCloudLikeButtonState(likeButton) : null,
    sourcePage: location.href.split(/[?#]/)[0].replace(/\/+$/, ''),
  };
}

const LIVE_SYNC_INTERVAL_MS = 10_000;

function playlistSnapshotFromHtml(html, sourcePage = '') {
  const match = String(html || '').match(/window\.__sc_hydration\s*=\s*(\[[\s\S]*?\])\s*;\s*<\/script\s*>/);
  if (!match) return null;
  try {
    const hydration = JSON.parse(match[1]);
    if (!Array.isArray(hydration)) return null;
    const entries = hydration.filter(item => item?.hydratable === 'playlist' && item?.data?.kind === 'playlist');
    const wanted = normalizeTrackUrl(sourcePage);
    const matching = wanted ? entries.filter(item => normalizeTrackUrl(item.data.permalink_url || item.data.permalinkUrl) === wanted) : [];
    const entry = matching.length === 1 ? matching[0]
      : matching.length ? null
        : entries.length === 1 && (!wanted || !normalizeTrackUrl(entries[0].data.permalink_url || entries[0].data.permalinkUrl)) ? entries[0] : null;
    if (!Array.isArray(entry?.data?.tracks)) return null;
    const rawTracks = entry.data.tracks;
    const tracks = rawTracks.filter(track => soundCloudInteger(track?.id, 1) !== null);
    const trackCount = soundCloudInteger(entry.data.track_count);
    if (!tracks.length && !(trackCount === 0 && rawTracks.length === 0)) return null;
    return {
      id: entry.data.id || null,
      trackCount,
      complete: trackCount !== null && rawTracks.length === tracks.length && tracks.length === trackCount,
      tracks,
    };
  } catch (_) {
    return null;
  }
}

function syncTrackPlaybackAccess(meta, track) {
  if (!meta || !track) return false;
  const access = String(track.access || '').toLowerCase();
  const policy = String(track.policy || '').toUpperCase();
  const durationMs = Number(track.duration || track.full_duration);
  const transcodings = Array.isArray(track.media?.transcodings)
    ? track.media.transcodings
    : (Array.isArray(track.transcodings) ? track.transcodings : []);
  const preview = access === 'preview'
    || policy === 'SNIP'
    || transcodings.some(item => item?.snipped === true
      || item?.is_snipped === true
      || /(?:^|[\/_-])preview(?:[\/_-]|$)/i.test(String(item?.url || '')));

  if (Number.isFinite(durationMs) && durationMs > 0) meta.durationMs = durationMs;
  if (access) meta.access = access;
  if (policy) meta.policy = policy;
  if (access || policy || preview) {
    meta.requiresNativePlayback = preview;
    if (preview) meta.nativePlaybackReason = 'preview-only';
    else if (meta.nativePlaybackReason === 'preview-only') delete meta.nativePlaybackReason;
  }
  return preview;
}

function metaFromSoundCloudTrack(track, sourcePage, playlistPosition = null) {
  if (!track?.permalink_url || !track?.title) return null;
  const artworkUrl = track.artwork_url || track.user?.avatar_url || null;
  const meta = {
    soundcloudId: soundCloudInteger(track.id, 1),
    title: track.title || '—',
    artist: String(track.publisher_metadata?.artist || '').trim() || String(track.user?.username || '').trim() || '—',
    artwork: artworkUrl ? artworkUrl.replace(/-([a-z]+|t\d+x\d+)\.(jpg|png)$/i, '-t200x200.$2') : null,
    link: track.permalink_url,
    artistLink: track.user?.permalink_url || null,
    waveform: track.waveform_url || null,
    trackAuthorization: track.track_authorization || null,
    hls_aac_160_url: track.hls_aac_160_url || track.streams?.hls_aac_160_url
      || track.media?.hls_aac_160_url || track.media?.streams?.hls_aac_160_url || null,
    hls_aac_96_url: track.hls_aac_96_url || track.streams?.hls_aac_96_url
      || track.media?.hls_aac_96_url || track.media?.streams?.hls_aac_96_url || null,
    transcodings: Array.isArray(track.media?.transcodings)
      ? track.media.transcodings.map(item => ({
        url: item?.url || '',
        protocol: item?.format?.protocol || '',
        mimeType: item?.format?.mime_type || '',
        preset: item?.preset || '',
        quality: item?.quality || '',
        snipped: item?.snipped === true || item?.is_snipped === true,
      })).filter(item => item.url)
      : [],
    liked: typeof track.user_favorite === 'boolean' ? track.user_favorite : null,
    sourcePage,
    playlistPosition: Number.isFinite(Number(playlistPosition)) ? Number(playlistPosition) : null,
  };
  syncTrackPlaybackAccess(meta, track);
  return meta;
}

function spaceUpcomingDuplicateTitles(queue, pos, meta = state.meta) {
  const start = Math.max(0, Math.min(queue.length, Number(pos) + 1));
  const previousTi = start > 0 ? queue[start - 1] : null;
  const upcoming = spaceDuplicateTitles(queue.slice(start), meta, previousTi);
  queue.splice(start, queue.length - start, ...upcoming);
  return queue;
}

function insertTracksRandomlyAfterCurrent(queue, pos, trackIndices, random = Math.random) {
  const start = Math.max(0, Math.min(queue.length, Number(pos) + 1));
  for (const ti of trackIndices) {
    const availableSlots = queue.length - start + 1;
    const offset = Math.floor(Math.max(0, Math.min(0.999999999, Number(random()) || 0)) * availableSlots);
    queue.splice(start + offset, 0, ti);
  }
  return spaceUpcomingDuplicateTitles(queue, pos);
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}


const SVG = {
  play:    `<svg viewBox="0 0 16 16" fill="currentColor" style="display:block;width:14px;height:14px;flex-shrink:0"><path d="M3 2.5v11l10-5.5z"/></svg>`,
  pause:   `<svg viewBox="0 0 16 16" fill="currentColor" style="display:block;width:14px;height:14px;flex-shrink:0"><rect x="3" y="2" width="4" height="12" rx="1"/><rect x="9" y="2" width="4" height="12" rx="1"/></svg>`,
  prev:    `<svg viewBox="0 0 16 16" fill="currentColor" style="display:block;width:14px;height:14px;flex-shrink:0"><rect x="2" y="2" width="2.5" height="12" rx="1"/><path d="M5 8l8 5V3z"/></svg>`,
  next:    `<svg viewBox="0 0 16 16" fill="currentColor" style="display:block;width:14px;height:14px;flex-shrink:0"><rect x="11.5" y="2" width="2.5" height="12" rx="1"/><path d="M3 3v10l8-5z"/></svg>`,
  close:   `<svg viewBox="0 0 16 16" fill="currentColor" style="display:block;width:12px;height:12px;flex-shrink:0"><path d="M12.7 3.3a1 1 0 00-1.4 0L8 6.6 4.7 3.3a1 1 0 00-1.4 1.4L6.6 8l-3.3 3.3a1 1 0 101.4 1.4L8 9.4l3.3 3.3a1 1 0 001.4-1.4L9.4 8l3.3-3.3a1 1 0 000-1.4z"/></svg>`,
  chart:   `<svg viewBox="0 0 16 16" fill="currentColor" style="display:block;width:13px;height:13px;flex-shrink:0"><rect x="1" y="8" width="3" height="7" rx="1"/><rect x="6" y="5" width="3" height="10" rx="1"/><rect x="11" y="2" width="3" height="13" rx="1"/></svg>`,
  equalizer:`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true" style="display:block;width:14px;height:14px;flex-shrink:0"><path d="M3 2v12M8 2v12M13 2v12"/><circle cx="3" cy="6" r="1.7" fill="currentColor" stroke="none"/><circle cx="8" cy="10" r="1.7" fill="currentColor" stroke="none"/><circle cx="13" cy="5" r="1.7" fill="currentColor" stroke="none"/></svg>`,
  pip:     `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linejoin="round" aria-hidden="true" style="display:block;width:14px;height:14px;flex-shrink:0"><rect x="1.5" y="2.5" width="9" height="7" rx="1.4"/><rect x="5.5" y="6.5" width="9" height="7" rx="1.4" fill="currentColor" stroke="none"/></svg>`,
  gear:    `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linejoin="round" aria-hidden="true" style="display:block;width:14px;height:14px;flex-shrink:0"><path d="m6.6 1.5-.4 1.8-1.4.8L3 3.6 1.6 6l1.4 1.3v1.4L1.6 10 3 12.4l1.8-.5 1.4.8.4 1.8h2.8l.4-1.8 1.4-.8 1.8.5 1.4-2.4L13 8.7V7.3L14.4 6 13 3.6l-1.8.5-1.4-.8-.4-1.8z"/><circle cx="8" cy="8" r="2.25"/></svg>`,
  back:    `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="display:block;width:14px;height:14px;flex-shrink:0"><path d="M13 8H3m4-4L3 8l4 4"/></svg>`,
  timer:   `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="display:block;width:14px;height:14px;flex-shrink:0"><circle cx="8" cy="9" r="5"/><path d="M6 1.5h4M8 1.5V4m3.7 1.3L13 4M8 6v3l2 1"/></svg>`,
  info:    `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" aria-hidden="true" style="display:block;width:14px;height:14px;flex-shrink:0"><circle cx="8" cy="8" r="6"/><path d="M8 7.5v4"/><circle cx="8" cy="4.8" r=".8" fill="currentColor" stroke="none"/></svg>`,
  note:    `<svg viewBox="0 0 16 16" fill="currentColor" style="display:block;width:18px;height:18px;flex-shrink:0;opacity:0.25"><path d="M9 3v7.27A3 3 0 1 0 11 13V6h2V3H9zm-3 12a1 1 0 110-2 1 1 0 010 2z"/></svg>`,
  shuffle: `<svg viewBox="0 0 24 24" fill="currentColor" style="display:block;width:12px;height:12px;flex-shrink:0"><path d="M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/></svg>`,
  artwork: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linejoin="round" style="display:block;width:14px;height:14px;flex-shrink:0"><rect x="2" y="2" width="12" height="12" rx="2"/><circle cx="5.3" cy="5.3" r="1.3" fill="currentColor" stroke="none"/><path d="M3.5 12l3.2-3.5 2.1 2 1.5-1.6 2.2 3.1"/></svg>`,
  list:    `<svg viewBox="0 0 16 16" fill="currentColor" style="display:block;width:13px;height:13px;flex-shrink:0"><rect x="1" y="2.5" width="14" height="1.5" rx="0.75"/><rect x="1" y="7.25" width="14" height="1.5" rx="0.75"/><rect x="1" y="12" width="14" height="1.5" rx="0.75"/></svg>`,
  more:    `<svg viewBox="0 0 16 16" fill="currentColor" style="display:block;width:13px;height:13px;flex-shrink:0"><circle cx="3" cy="8" r="1.25"/><circle cx="8" cy="8" r="1.25"/><circle cx="13" cy="8" r="1.25"/></svg>`,
  plus:    `<svg viewBox="0 0 16 16" fill="currentColor" style="display:block;width:12px;height:12px;flex-shrink:0"><path d="M8 3a1 1 0 011 1v3h3a1 1 0 110 2H9v3a1 1 0 11-2 0V9H4a1 1 0 110-2h3V4a1 1 0 011-1z"/></svg>`,
  search:  `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" style="display:block;width:13px;height:13px;flex-shrink:0"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/></svg>`,
  volume:  `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" style="display:block;width:13px;height:13px;flex-shrink:0"><path d="M2 6h3l3-2.5v9L5 10H2z"/><path d="M11 5.5a4 4 0 010 5"/><path d="M13 3.5a7 7 0 010 9"/></svg>`,
  heart:   `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" style="display:block;width:14px;height:14px;flex-shrink:0"><path d="M8 13.6S2.2 10.2 2.2 5.8A3.1 3.1 0 018 4.25 3.1 3.1 0 0113.8 5.8C13.8 10.2 8 13.6 8 13.6z"/></svg>`,
  heartFilled:`<svg viewBox="0 0 16 16" fill="currentColor" style="display:block;width:14px;height:14px;flex-shrink:0"><path d="M8 14.2l-.42-.25C5.62 12.78 1.5 9.86 1.5 5.77A3.82 3.82 0 018 3.04a3.82 3.82 0 016.5 2.73c0 4.09-4.12 7.01-6.08 8.18L8 14.2z"/></svg>`,
};

function recordPlaybackDiagnostic(event, details = {}) {
  const safeDetails = details && typeof details === 'object' && !Array.isArray(details) ? details : {};
  const entry = sanitizeDiagnosticRecord({
    ...safeDetails,
    at: new Date().toISOString(),
    event,
  });
  if (!entry.event || !entry.at) return null;
  state._playbackDiagnostics ||= [];
  state._playbackDiagnostics.push(entry);
  if (state._playbackDiagnostics.length > 80) {
    state._playbackDiagnostics.splice(0, state._playbackDiagnostics.length - 80);
  }
  if (PLAYBACK_DIAGNOSTIC_FAULTS.has(entry.event)) {
    state._playbackDiagnosticFault = true;
    try { capturePlaybackDiagnosticIncident(entry); } catch (_) {}
    try { updatePlaybackDiagnosticButton(); } catch (_) {}
    try { console.info('[True Shuffle][playback]', entry); } catch (_) {}
  }
  return entry;
}

// Event-only observations share the existing memory ring; they never imply silence.
function recordTransitionDiagnostic(event, details = {}) {
  if (!state._transitionDiagnostics) return null;
  switch (event) {
    case 'preparation-start': case 'preparation-result': case 'preparation-reused':
    case 'preparation-promoted': case 'preparation-replaced': case 'preparation-cancelled':
    case 'streams-resolved': case 'deck-reset':
    case 'hls-load': case 'hls-adopted': case 'hls-attached':
    case 'hls-manifest': case 'hls-first-fragment-loaded': case 'hls-first-fragment-buffered': case 'hls-error':
    case 'media-waiting': case 'media-stalled': case 'media-playing':
    case 'transition-requested': case 'fade-window': case 'fade-trigger':
    case 'fade-scheduled': case 'incoming-clock-progress': case 'fade-completed': case 'fade-fallback':
    case 'transition-no-mix': case 'natural-end': case 'watcher-delay':
      break;
    default: return null;
  }
  const now = typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : 0;
  if (!Number.isFinite(state._transitionDiagnosticOrigin)) state._transitionDiagnosticOrigin = now;
  const clean = {};
  for (const [key, value] of Object.entries(details)) {
    if (DIAGNOSTIC_NUMBER_FIELDS.has(key) && typeof value === 'number' && Number.isFinite(value)) clean[key] = value;
    else if (DIAGNOSTIC_BOOLEAN_FIELDS.has(key) && typeof value === 'boolean') clean[key] = value;
    else if (event === 'hls-error' && (key === 'errorType' || key === 'errorDetail')) clean[key] = hlsDiagnosticCode(value);
  }
  return recordPlaybackDiagnostic(event, {
    playbackEpoch: state._playbackEpoch,
    operationId: state._playbackRequest?.operationId,
    ...clean,
    monotonicMs: Math.max(0, now - state._transitionDiagnosticOrigin),
  });
}

function observeTransitionMedia(audio, index) {
  if (!state._transitionDiagnostics || audio._tssTransitionMedia) return;
  const observation = { waiting: -Infinity, stalled: -Infinity, playing: -Infinity, token: null };
  audio._tssTransitionMedia = observation;
  for (const type of ['waiting', 'stalled', 'playing']) {
    audio.addEventListener(type, () => {
      if (!state._transitionDiagnostics || state._decks[index] !== audio || !audio.currentSrc) return;
      const now = performance.now();
      const token = state._deckPrepareTokens[index];
      if (observation.token !== token) {
        observation.waiting = observation.stalled = observation.playing = -Infinity;
      }
      if (now - observation[type] < 1000) return;
      observation[type] = now;
      observation.token = token;
      recordTransitionDiagnostic(`media-${type}`, {
        deckIndex: index, trackIndex: state._deckTracks[index], token,
        readyState: audio.readyState, networkState: audio.networkState,
        currentTime: audio.currentTime, paused: audio.paused,
      });
    });
  }
}

function observeTransitionHls(player, events, details) {
  if (!state._transitionDiagnostics) return;
  details.playbackEpoch = state._playbackEpoch;
  if (player._tssTransitionHls) {
    player._tssTransitionHls.previousToken = player._tssTransitionHls.details.token;
    Object.assign(player._tssTransitionHls.details, details);
    return;
  }
  const observation = { details, startedAt: performance.now(), errorAt: -Infinity, errors: 0, fatal: false };
  player._tssTransitionHls = observation;
  for (const [type, event] of [
    [events.MEDIA_ATTACHED, 'hls-attached'],
    [events.MANIFEST_PARSED, 'hls-manifest'],
    [events.FRAG_LOADED, 'hls-first-fragment-loaded'],
    [events.FRAG_BUFFERED, 'hls-first-fragment-buffered'],
  ]) {
    if (!type) continue;
    const once = () => {
      player.off(type, once);
      recordTransitionDiagnostic(event, { ...observation.details, elapsedMs: performance.now() - observation.startedAt });
    };
    player.on(type, once);
  }
  if (events.ERROR) player.on(events.ERROR, (_event, data) => {
    if (!data) return;
    const now = performance.now();
    if (data.fatal ? observation.fatal : observation.errors >= 8 || now - observation.errorAt < 1000) return;
    if (data.fatal) observation.fatal = true;
    else { observation.errors++; observation.errorAt = now; }
    recordTransitionDiagnostic('hls-error', {
      ...observation.details, fatal: Boolean(data.fatal),
      errorType: hlsDiagnosticCode(data.type), errorDetail: hlsDiagnosticCode(data.details),
      status: Number(data.response?.code),
    });
  });
}
function playbackErrorName(error) {
  const name = typeof error?.name === 'string' ? error.name : '';
  return /^(?:AbortError|TimeoutError|NotAllowedError|NotSupportedError|NotReadableError|InvalidStateError|SecurityError|NetworkError|EncodingError|OperationError|QuotaExceededError|UnknownError|Error|TypeError|RangeError|SyntaxError|ReferenceError|EvalError|DataError|IndexSizeError|NotFoundError|InvalidAccessError|InvalidModificationError|ConstraintError|NoModificationAllowedError|InvalidCharacterError|OverconstrainedError)$/.test(name)
    ? name : 'UnknownError';
}

function playbackDiagnosticHostWindow() {
  if (typeof pageWindow !== 'undefined' && pageWindow) return pageWindow;
  if (typeof window !== 'undefined' && window) return window;
  return globalThis;
}

function playbackDiagnosticPageKind() {
  const host = playbackDiagnosticHostWindow();
  const pathname = String(host.location?.pathname || (typeof location !== 'undefined' ? location.pathname : ''));
  const segments = pathname.toLowerCase().split('/').filter(Boolean);
  if (!segments.length) return 'home';
  if (segments[0] === 'you' && segments[1] === 'likes') return 'likes';
  if (segments[0] === 'you' && segments[1] === 'reposts') return 'reposts';
  if (segments[0] === 'feed') return 'feed';
  if (segments.includes('sets')) return 'playlist';
  if (segments[segments.length - 1] === 'tracks') return segments[0] === 'you' ? 'tracks' : 'user-tracks';
  if (segments[0] === 'you') return 'profile';
  return 'other';
}

function playbackDiagnosticEnvironment() {
  const host = playbackDiagnosticHostWindow();
  const navigatorObject = host.navigator || (typeof navigator !== 'undefined' ? navigator : null);
  const userAgent = String(navigatorObject?.userAgent || '');
  const browserPatterns = [
    [/Edg(?:A|iOS)?\/(\d+)/i, 'edge'],
    [/OPR\/(\d+)/i, 'opera'],
    [/Firefox\/(\d+)/i, 'firefox'],
    [/(?:Chrome|CriOS)\/(\d+)/i, 'chromium'],
    [/Version\/(\d+).*Safari/i, 'safari'],
  ];
  let browser = 'other';
  let browserMajorVersion = null;
  for (const [pattern, family] of browserPatterns) {
    const match = userAgent.match(pattern);
    if (!match) continue;
    browser = family;
    browserMajorVersion = Number(match[1]) || null;
    break;
  }
  const rawPlatform = String(navigatorObject?.userAgentData?.platform || navigatorObject?.platform || '').toLowerCase();
  const platform = rawPlatform.includes('win') ? 'windows'
    : (rawPlatform.includes('android') ? 'android'
      : (rawPlatform.includes('iphone') || rawPlatform.includes('ipad') || rawPlatform.includes('ios') ? 'ios'
        : (rawPlatform.includes('mac') ? 'macos' : (rawPlatform.includes('linux') ? 'linux' : 'other'))));
  const managerInfo = typeof GM_info !== 'undefined' && GM_info && typeof GM_info === 'object' ? GM_info : null;
  const rawManager = String(managerInfo?.scriptHandler || '').toLowerCase();
  const manager = rawManager.includes('tampermonkey') ? 'tampermonkey'
    : (rawManager.includes('violentmonkey') ? 'violentmonkey'
      : (rawManager.includes('greasemonkey') ? 'greasemonkey' : (rawManager ? 'other' : 'unknown')));
  const managerVersion = safeDiagnosticVersion(managerInfo?.scriptHandlerVersion || '');
  const scriptVersion = safeDiagnosticVersion(managerInfo?.script?.version || '');
  const doc = typeof document !== 'undefined' ? document : null;
  return {
    browser, browserMajorVersion, platform, manager, managerVersion, scriptVersion,
    visible: doc?.visibilityState === 'visible',
    focused: Boolean(doc?.hasFocus?.()),
    onLine: navigatorObject?.onLine !== false,
  };
}

function playbackDiagnosticCapabilities() {
  const host = playbackDiagnosticHostWindow();
  const audio = state._decks?.find(Boolean) || null;
  const HlsCtor = typeof hlsJsConstructor === 'function' ? hlsJsConstructor() : null;
  let hlsMseSupported = false;
  let nativeHlsSupported = false;
  try { hlsMseSupported = Boolean(HlsCtor?.isSupported()); } catch (_) {}
  try { nativeHlsSupported = Boolean(audio?.canPlayType?.('application/vnd.apple.mpegurl')); } catch (_) {}
  return {
    hlsLibraryAvailable: Boolean(HlsCtor),
    hlsLibraryVersion: safeDiagnosticVersion(HlsCtor?.version || ''),
    hlsMseSupported,
    mediaSourceAvailable: Boolean(host.MediaSource || host.ManagedMediaSource),
    nativeHlsSupported,
    audioContextAvailable: Boolean(state._audioContext || host.AudioContext || host.webkitAudioContext),
  };
}

function diagnosticDeckStreamKind(audio, index) {
  if (!audio || !(audio.currentSrc || audio.src)) return 'none';
  if (state._deckHlsPlayers?.[index]) return 'hls-mse';
  if (String(audio.currentSrc || audio.src).startsWith('blob:')) return 'blob';
  return 'progressive';
}

function diagnosticStreamQuality(value) {
  try {
    const pathname = new URL(value).pathname.toLowerCase();
    if (/aac[_-]?160|160k/.test(pathname)) return 'aac-160k';
    if (/aac[_-]?96|96k/.test(pathname)) return 'aac-96k';
    if (/opus/.test(pathname)) return 'opus';
    if (/mp3/.test(pathname)) return 'mp3';
  } catch (_) {}
  return 'unknown';
}

function createCustomStartTrace(trackIndex) {
  if (!state._diagnosticBuild) return null;
  state._diagnosticAttemptSequence = (Number(state._diagnosticAttemptSequence) || 0) + 1;
  return {
    attemptId: state._diagnosticAttemptSequence,
    operationId: Number(state._playbackRequest?.operationId) || 0,
    trackIndex,
    startedAt: performance.now(),
    stage: 'custom-deck',
    reason: 'not-started',
    streamSource: 'unknown',
    streamKind: 'unknown',
    streamQuality: 'unknown',
    clientIdFound: false,
    clientIdSource: 'unknown',
    credentialAttempts: 0,
    authFailed: false,
    progressiveCandidates: 0,
    hlsCandidates: 0,
    hlsAac160Candidates: 0,
    hlsAac96Candidates: 0,
    hlsOtherCandidates: 0,
    hlsStreamUrls: 0,
    hlsMode: 'not-used',
    hlsLibraryAvailable: false,
    hlsLibraryVersion: 'unknown',
    hlsSupported: false,
    hlsMediaAttached: false,
    hlsMediaAttachedElapsedMs: null,
    hlsManifestParsed: false,
    hlsManifestParsedElapsedMs: null,
    hlsFirstFragmentBuffered: false,
    hlsFirstFragmentBufferedElapsedMs: null,
    hlsBufferedFragmentCount: 0,
    hlsReady: false,
    hlsErrorCount: 0,
    hlsNonFatalErrorCount: 0,
    hlsFatalErrorCount: 0,
    hlsStatus: null,
    hlsErrorType: '',
    hlsErrorDetail: '',
    hlsLastErrorType: '',
    hlsLastErrorDetail: '',
    hlsLevelCount: 0,
    hlsCurrentLevel: -1,
    hlsBandwidthEstimate: null,
    trackMetadataFound: false,
    progressiveMetadataAvailable: false,
    progressiveUrls: 0,
    streamCandidateCount: 0,
    mediaCandidateOrdinal: 0,
    authorizationPresent: false,
    requestCount: 0,
    requests: [],
    mediaWaitOutcome: 'not-started',
    mediaWaitElapsedMs: 0,
    readyState: null,
    networkState: null,
    mediaErrorCode: 0,
    playElapsedMs: 0,
    errorName: '',
    audioGraphPhase: '',
    audioGraphReason: '',
    nativeOutcome: 'not-attempted',
    nativeFallbackReason: '',
  };
}

function recordCustomStartRequest(trace, stage, status, elapsedMs, errorName = '') {
  if (!trace) return;
  trace.requestCount++;
  const request = {
    stage,
    status: Number.isFinite(status) ? status : null,
    elapsedMs: Math.max(0, Math.round(Number(elapsedMs) || 0)),
  };
  if (errorName) request.errorName = playbackErrorName({ name: errorName });
  if (trace.requests.length >= 8) trace.requests.shift();
  trace.requests.push(request);
}

function customStartDiagnosticDetails(trace, outcome = 'failed') {
  if (!trace) return null;
  const stageDetails = outcome === 'started'
    ? { stage: trace.stage, reason: trace.reason }
    : { failureStage: trace.stage, failureReason: trace.reason };
  return {
    attemptId: trace.attemptId,
    operationId: trace.operationId,
    ...stageDetails,
    streamSource: trace.streamSource,
    streamKind: trace.streamKind,
    streamQuality: trace.streamQuality,
    clientIdFound: trace.clientIdFound,
    clientIdSource: trace.clientIdSource,
    credentialAttempts: trace.credentialAttempts,
    authFailed: trace.authFailed,
    progressiveCandidates: trace.progressiveCandidates,
    progressiveUrls: trace.progressiveUrls,
    hlsCandidates: trace.hlsCandidates,
    hlsAac160Candidates: trace.hlsAac160Candidates,
    hlsAac96Candidates: trace.hlsAac96Candidates,
    hlsOtherCandidates: trace.hlsOtherCandidates,
    hlsStreamUrls: trace.hlsStreamUrls,
    hlsMode: trace.hlsMode,
    hlsLibraryAvailable: trace.hlsLibraryAvailable,
    hlsLibraryVersion: trace.hlsLibraryVersion,
    hlsSupported: trace.hlsSupported,
    hlsMediaAttached: trace.hlsMediaAttached,
    hlsMediaAttachedElapsedMs: trace.hlsMediaAttachedElapsedMs,
    hlsManifestParsed: trace.hlsManifestParsed,
    hlsManifestParsedElapsedMs: trace.hlsManifestParsedElapsedMs,
    hlsFirstFragmentBuffered: trace.hlsFirstFragmentBuffered,
    hlsFirstFragmentBufferedElapsedMs: trace.hlsFirstFragmentBufferedElapsedMs,
    hlsBufferedFragmentCount: trace.hlsBufferedFragmentCount,
    hlsReady: trace.hlsReady,
    hlsErrorCount: trace.hlsErrorCount,
    hlsNonFatalErrorCount: trace.hlsNonFatalErrorCount,
    hlsFatalErrorCount: trace.hlsFatalErrorCount,
    hlsStatus: trace.hlsStatus,
    hlsErrorType: trace.hlsErrorType,
    hlsErrorDetail: trace.hlsErrorDetail,
    hlsLastErrorType: trace.hlsLastErrorType,
    hlsLastErrorDetail: trace.hlsLastErrorDetail,
    hlsLevelCount: trace.hlsLevelCount,
    hlsCurrentLevel: trace.hlsCurrentLevel,
    hlsBandwidthEstimate: trace.hlsBandwidthEstimate,
    trackMetadataFound: trace.trackMetadataFound,
    progressiveMetadataAvailable: trace.progressiveMetadataAvailable,
    streamCandidateCount: trace.streamCandidateCount,
    mediaCandidateOrdinal: trace.mediaCandidateOrdinal,
    authorizationPresent: trace.authorizationPresent,
    requestCount: trace.requestCount,
    requests: trace.requests.slice(-8),
    mediaWaitOutcome: trace.mediaWaitOutcome,
    mediaWaitElapsedMs: trace.mediaWaitElapsedMs,
    readyState: trace.readyState,
    networkState: trace.networkState,
    mediaErrorCode: trace.mediaErrorCode,
    playElapsedMs: trace.playElapsedMs,
    errorName: trace.errorName,
    audioGraphPhase: trace.audioGraphPhase,
    audioGraphReason: trace.audioGraphReason,
    nativeOutcome: trace.nativeOutcome,
    nativeFallbackReason: trace.nativeFallbackReason,
    audioFeatures: {
      autoLevel: Boolean(state.autoLevel),
      eqEnabled: Boolean(state.eqEnabled),
      safetyClipper: Boolean(state.safetyClipper),
      crossfadeSeconds: Number(state.crossfadeSeconds) || 0,
    },
    elapsedMs: Math.max(0, Math.round(performance.now() - trace.startedAt)),
  };
}

function playbackDiagnosticContext() {
  const schedule = state._crossfadeSchedule;
  const activeDeck = Number.isInteger(state._deckIndex) ? state._decks?.[state._deckIndex] || null : null;
  const host = playbackDiagnosticHostWindow();
  const documentObject = host.document || (typeof document !== 'undefined' ? document : null);
  const navigatorObject = host.navigator || (typeof navigator !== 'undefined' ? navigator : null);
  return {
    state: {
      active: state.active,
      loading: state.loading,
      visible: documentObject?.visibilityState ? documentObject.visibilityState === 'visible' : undefined,
      onLine: typeof navigatorObject?.onLine === 'boolean' ? navigatorObject.onLine : undefined,
      userPaused: Boolean(state._userPaused),
      crossfadePending: Boolean(state._crossfadePending),
      playbackEpoch: Number(state._playbackEpoch) || 0,
      collectionEpoch: Number(state._collectionEpoch) || 0,
      operationId: Number(state._playbackRequest?.operationId) || 0,
      busy: state.busy,
      suspended: state.suspended,
      crossfading: state._crossfading,
      crossfadePausedByUser: state._crossfadePausedByUser,
      crossfadeStatus: state.crossfadeStatus,
      crossfadeCurve: state.crossfadeCurve,
      crossfadeManual: Boolean(state.crossfadeManual),
      crossfadeSeconds: state.crossfadeSeconds,
      queuePosition: state.pos,
      queueLength: state.queue?.length || 0,
      deckIndex: state._deckIndex,
      deckTrack: state._deckTrack,
      nativeTrackIndex: Number.isInteger(state._nativeTrack) ? state._nativeTrack : null,
      nativeFallbackReason: Number.isInteger(state._nativeTrack)
        ? state.meta?.[state._nativeTrack]?.nativePlaybackReason || 'native-player'
        : null,
      streamKind: activeDeck ? diagnosticDeckStreamKind(activeDeck, state._deckIndex) : 'none',
      retryPending: Boolean(state._customPlaybackRetryTimer),
      diagnosticsEnabled: Boolean(state._diagnosticBuild),
      transitionDiagnosticsEnabled: Boolean(state._transitionDiagnostics),
      audioGraphFailed: Boolean(state._audioGraphFailed),
      contextState: state._audioContext?.state || 'missing',
      audioFeatures: {
        autoLevel: Boolean(state.autoLevel),
        eqEnabled: Boolean(state.eqEnabled),
        safetyClipper: Boolean(state.safetyClipper),
        crossfadeSeconds: Number(state.crossfadeSeconds) || 0,
      },
    },
    audioContext: state._audioContext ? {
      contextState: state._audioContext.state,
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
    decks: (state._decks || []).slice(0, 2).map((audio, index) => {
      if (!audio) return null;
      const hls = state._deckHlsPlayers?.[index];
      let bufferedAhead = null;
      try {
        const buffered = audio.buffered;
        const time = audio.currentTime;
        for (let range = 0; range < Math.min(buffered?.length || 0, 64); range++) {
          if (buffered.start(range) <= time && buffered.end(range) >= time) {
            bufferedAhead = Math.max(0, buffered.end(range) - time);
            break;
          }
        }
      } catch (_) {}
      return {
        index,
        trackIndex: state._deckTracks?.[index],
        streamKind: diagnosticDeckStreamKind(audio, index),
        paused: audio.paused,
        ended: audio.ended,
        seeking: audio.seeking,
        currentTime: Number(audio.currentTime) || 0,
        duration: Number(audio.duration) || 0,
        readyState: Number(audio.readyState) || 0,
        bufferedAhead,
        networkState: Number(audio.networkState) || 0,
        errorCode: Number(audio.error?.code) || 0,
        hasCurrentSrc: Boolean(audio.currentSrc || audio.src),
        playbackRate: Number(audio.playbackRate) || 1,
        deckGain: state._deckGains?.[index],
        mixGain: state._deckAudioGraphs?.[index]?.mixGain?.gain?.value,
        autoGain: state._deckAudioGraphs?.[index]?.autoGain?.gain?.value,
        hlsMediaAttached: Boolean(hls?.media === audio),
        hlsLoading: Boolean(hls?.loadingEnabled),
        hlsLevelCount: Array.isArray(hls?.levels) ? hls.levels.length : 0,
        hlsCurrentLevel: Number.isFinite(Number(hls?.currentLevel)) ? Number(hls.currentLevel) : null,
        hlsBandwidthEstimate: Number.isFinite(Number(hls?.bandwidthEstimate))
          ? Math.round(Number(hls.bandwidthEstimate)) : null,
      };
    }),
  };
}

// Capture once per real fault, never from routine observations or a recursive snapshot.
function capturePlaybackDiagnosticIncident(entry) {
  const fault = sanitizeDiagnosticRecord(entry);
  if (!PLAYBACK_DIAGNOSTIC_FAULTS.has(fault.event) || !fault.at) return null;
  const prior = sanitizePlaybackDiagnostics(state._playbackDiagnostics);
  if (prior.at(-1)?.event === fault.event && prior.at(-1)?.at === fault.at) prior.pop();
  const incident = sanitizeDiagnosticRecord({
    fault,
    ...playbackDiagnosticContext(),
    diagnostics: prior.slice(-12),
  });
  state._playbackDiagnosticIncident = incident;
  return incident;
}

function playbackDiagnosticSnapshot(reason = 'manual') {
  const environment = playbackDiagnosticEnvironment();
  return sanitizeDiagnosticRecord({
    schemaVersion: 2,
    scriptVersion: environment.scriptVersion,
    at: new Date().toISOString(),
    reason: safeDiagnosticString('reason', reason) || 'manual',
    pageKind: playbackDiagnosticPageKind(),
    environment,
    capabilities: playbackDiagnosticCapabilities(),
    ...playbackDiagnosticContext(),
    incident: state._playbackDiagnosticIncident,
    diagnostics: sanitizePlaybackDiagnostics(state._playbackDiagnostics),
  });
}

// Plain text for direct posting; sanitize again so malformed callers cannot bypass the allowlist.
function compactPlaybackReport(snapshot) {
  let report;
  try { report = sanitizeDiagnosticRecord(snapshot); } catch (_) { report = {}; }
  const environment = report.environment || {};
  const events = sanitizePlaybackDiagnostics(report.diagnostics);
  const saved = report.incident;
  const incident = saved?.fault && PLAYBACK_DIAGNOSTIC_FAULTS.has(saved.fault.event) ? saved : null;
  const fault = incident?.fault || events.slice().reverse().find(entry => PLAYBACK_DIAGNOSTIC_FAULTS.has(entry.event));
  const context = incident || report;
  const playback = context.state || {};
  const audioContext = context.audioContext || {};
  const schedule = context.schedule || {};
  const number = value => typeof value === 'number' && Number.isFinite(value) ? String(value) : '?';
  const flag = value => value === true ? 'yes' : value === false ? 'no' : '?';
  const lines = [];
  let length = 0;
  const append = line => {
    if (length + line.length + (lines.length ? 1 : 0) > 1800) return false;
    length += line.length + (lines.length ? 1 : 0);
    lines.push(line);
    return true;
  };
  append(`True Shuffle playback report ${report.scriptVersion || environment.scriptVersion || 'unknown'}`);
  append(`Browser: ${environment.browser || 'unknown'} ${number(environment.browserMajorVersion)}; OS: ${environment.platform || 'unknown'}; manager: ${environment.manager || 'unknown'} ${environment.managerVersion || 'unknown'}`);
  append(fault ? `Latest fault: ${fault.event} at ${fault.at || 'unknown'}` : 'Latest fault: none recorded');
  if (fault) {
    const identity = [];
    for (const [label, key] of [['stage', 'failureStage'], ['reason', 'failureReason'], ['reason', 'reason'], ['error', 'errorName']]) {
      if (fault[key] && !(label === 'reason' && identity.some(item => item.startsWith('reason=')))) identity.push(`${label}=${fault[key]}`);
    }
    if (identity.length) append(`Fault: ${identity.join('; ')}`);
    const errors = [];
    for (const [label, key] of [['HTTP', 'status'], ['HLS HTTP', 'hlsStatus'], ['media error', 'mediaErrorCode'], ['error code', 'errorCode']]) {
      if (typeof fault[key] === 'number') errors.push(`${label}=${number(fault[key])}`);
    }
    for (const [label, key] of [['HLS type', 'hlsErrorType'], ['HLS detail', 'hlsErrorDetail'], ['type', 'errorType'], ['detail', 'errorDetail']]) {
      if (fault[key]) errors.push(`${label}=${fault[key]}`);
    }
    if (errors.length) append(`Errors: ${errors.join('; ')}`);
  }
  const prefix = incident ? 'At fault' : 'Current';
  append(`${prefix}: active=${flag(playback.active)}; user paused=${flag(playback.userPaused)}; busy=${flag(playback.busy)}; visible=${flag(playback.visible)}; online=${flag(playback.onLine)}; deck=${number(playback.deckIndex)}; queue=${number(playback.queuePosition)}/${number(playback.queueLength)}; stream=${playback.streamKind || 'unknown'}`);
  append(`Audio context: ${audioContext.contextState || playback.contextState || fault?.contextState || 'unknown'}; time=${number(audioContext.currentTime)}s; rate=${number(audioContext.sampleRate)}Hz; graph failed=${flag(playback.audioGraphFailed)}`);
  const decks = Array.isArray(context.decks) ? context.decks : [];
  for (let index = 0; index < 2; index++) {
    const deck = decks[index];
    if (!deck) { append(`Deck ${index}: unavailable`); continue; }
    append(`Deck ${index}: ${deck.streamKind || 'unknown'}; paused=${flag(deck.paused)}; ready=${number(deck.readyState)}; network=${number(deck.networkState)}; error=${number(deck.errorCode)}; time=${number(deck.currentTime)}/${number(deck.duration)}s; buffered ahead=${number(deck.bufferedAhead)}s`);
  }
  append(`Crossfade: ${playback.crossfadeStatus || 'unknown'} ${number(playback.crossfadeSeconds)}s/${playback.crossfadeCurve || 'unknown'}; pending=${flag(playback.crossfadePending)}; mixing=${flag(playback.crossfading)}; decks=${number(schedule.outgoingIndex)}>${number(schedule.incomingIndex)}; clock=${number(schedule.startTime)}>${number(schedule.endTime)}s`);
  const faultTime = fault?.at ? Date.parse(fault.at) : NaN;
  if (incident && Number.isFinite(schedule.token) && Number.isFinite(faultTime)) {
    const fades = (incident.diagnostics || []).filter(entry => entry.event === 'fade-scheduled'
      && entry.crossfadeToken === schedule.token && Date.parse(entry.at) <= faultTime);
    const metrics = ['sampledSchedulingLeadMs', 'schedulingSubmissionMs', 'estimatedSchedulingLeadMs'];
    if (fades.length === 1 && metrics.every(key => typeof fades[0][key] === 'number')) {
      const fade = fades[0];
      append(`Fade timing (main thread): sampled lead=${number(fade.sampledSchedulingLeadMs)}ms; submission=${number(fade.schedulingSubmissionMs)}ms; estimated lead=${number(fade.estimatedSchedulingLeadMs)}ms`);
    }
  }
  if (fault) {
    const timing = [];
    for (const [label, key] of [['elapsed', 'elapsedMs'], ['clock stalled', 'clockStalledFor'], ['media stalled', 'mediaStalledFor'], ['stalled', 'stalledFor']]) {
      if (typeof fault[key] === 'number') timing.push(`${label}=${number(fault[key])}ms`);
    }
    if (typeof fault.elapsed === 'number') timing.push(`fade elapsed=${number(fault.elapsed)}s`);
    if (typeof fault.duration === 'number') timing.push(`duration=${number(fault.duration)}s`);
    if (timing.length) append(`Fault timing: ${timing.join('; ')}`);
  }
  const before = Number.isFinite(faultTime)
    ? (incident?.diagnostics || events).filter(entry => Date.parse(entry.at) < faultTime
      || (incident && Date.parse(entry.at) === faultTime))
    : [];
  // Record order disambiguates observations sharing the fault's millisecond.
  let faultIndex = -1;
  if (fault) {
    for (let index = events.length - 1; index >= 0; index--) {
      if (events[index].event === fault.event && events[index].at === fault.at) {
        faultIndex = index;
        break;
      }
    }
  }
  const after = (faultIndex >= 0 ? events.slice(faultIndex + 1)
    : events.filter(entry => !Number.isFinite(faultTime) || Date.parse(entry.at) > faultTime))
    .filter(entry => !(entry.event === fault?.event && entry.at === fault?.at));
  const timelineLines = entries => {
    const seen = new Set();
    const relevant = [];
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index];
      if (!/^(?:recovery-|crossfade-|custom-start-|hls-|audio-|native-|playback-|fade-|transition-|preparation-|media-(?:waiting|stalled))/.test(entry.event || '')) continue;
      const detail = entry.failureReason || entry.reason || entry.recoveryOutcome || entry.outcome || entry.errorName || entry.errorDetail || '';
      const key = `${entry.event}|${detail}|${entry.status ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const delta = Number.isFinite(faultTime) ? Math.round(Date.parse(entry.at) - faultTime) : null;
      let line = `${delta === null ? entry.at : `${delta >= 0 ? '+' : ''}${delta}ms`}: ${entry.event}`;
      if (detail) line += ` ${detail}`;
      if (typeof entry.status === 'number') line += ` HTTP=${number(entry.status)}`;
      if (typeof entry.elapsedMs === 'number') line += ` elapsed=${number(entry.elapsedMs)}ms`;
      relevant.unshift(line);
      if (relevant.length >= 3) break;
    }
    return relevant;
  };
  // Preserve each causal side independently: later repetitions cannot erase pre-fault evidence.
  const selected = [];
  let remaining = 1800 - length - '\nTimeline (relative to fault):'.length;
  for (const group of [timelineLines(before), timelineLines(after)]) {
    const side = [];
    for (let index = group.length - 1; index >= 0; index--) {
      if (group[index].length + 1 > remaining) continue;
      side.unshift(group[index]);
      remaining -= group[index].length + 1;
    }
    selected.push(...side);
  }
  if (selected.length) {
    append('Timeline (relative to fault):');
    for (const line of selected) append(line);
  }
  return lines.join('\n');
}

function updatePlaybackDiagnosticButton() {
  const button = document.getElementById('tss-playback-debug');
  if (!button) return;
  button.hidden = !state._playbackDiagnosticFault;
  button.dataset.status = state._playbackDiagnosticFault ? 'current' : 'none';
  button.setAttribute('aria-label', state._playbackDiagnosticFault ? 'Playback issue: open report' : 'Playback report');
  button.title = state._playbackDiagnosticFault ? 'Playback issue: open report'
    : 'Playback report — copy soon after an audible issue; timings cannot detect silence';
}

function showPlaybackReportHelp() {
  document.getElementById('tss-debug-help-close')?.click();
  const opener = document.activeElement;
  const reportDialog = document.querySelector('#tss-debug-overlay .tss-debug-dialog');
  const overlay = document.createElement('div');
  overlay.id = 'tss-debug-help-overlay';
  overlay.innerHTML = `
    <div class="tss-debug-dialog tss-debug-help-dialog" role="dialog" aria-modal="true" aria-labelledby="tss-debug-help-title">
      <div class="tss-debug-head"><strong id="tss-debug-help-title">How to report a playback issue</strong><button id="tss-debug-help-close" type="button" aria-label="Close reporting instructions">${SVG.close}</button></div>
      <ol class="tss-debug-help-steps">
        <li><strong>Keep this page open.</strong> Reports exist only until you reload or close the page. Copy the report first.</li>
        <li><strong>Copy soon after the issue.</strong> The latest fault keeps its playback context and nearby events. Timings describe activity; they cannot detect silence or prove a CPU cause.</li>
        <li><strong>Choose “Copy report”.</strong> Paste this short report directly into your message. “Full technical details” is optional; use “Copy full report” only if more detail is requested. If copying is blocked, copy the selected report text manually.</li>
        <li><strong>Add what happened.</strong> Describe what you clicked and what you expected versus what happened. Mention whether the tab was in the background. Browser, OS and userscript-manager details are already included when available.</li>
        <li><strong>Post on <a href="https://greasyfork.org/en/scripts/568821-soundcloud-true-shuffle/feedback" target="_blank" rel="noopener noreferrer">Greasy Fork feedback</a>.</strong> Open the feedback page in a new tab, sign in if needed, and start a new discussion. Paste the copied report as a code block together with the details above.</li>
      </ol>
      <p>Greasy Fork feedback is public. Reports exclude track titles, account/page paths, media and stream URLs, query strings, credentials, and exception text. They contain technical browser/OS and playback details. Nothing is transmitted automatically; review the copied report before posting.</p>
      <div class="tss-debug-actions"><button id="tss-debug-help-back" type="button">Back to report</button></div>
    </div>`;
  const close = () => {
    overlay.remove();
    reportDialog?.removeAttribute('inert');
    reportDialog?.removeAttribute('aria-hidden');
    if (opener?.isConnected) opener.focus();
  };
  overlay.querySelector('#tss-debug-help-close').onclick = close;
  overlay.querySelector('#tss-debug-help-back').onclick = close;
  overlay.onclick = event => { if (event.target === overlay) close(); };
  overlay.onkeydown = event => {
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    if (event.key === 'Tab') {
      const first = overlay.querySelector('#tss-debug-help-close');
      const last = overlay.querySelector('#tss-debug-help-back');
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  };
  reportDialog?.setAttribute('inert', '');
  reportDialog?.setAttribute('aria-hidden', 'true');
  document.body.appendChild(overlay);
  overlay.querySelector('#tss-debug-help-close').focus();
}

function showPlaybackDiagnostics() {
  document.getElementById('tss-debug-overlay')?.remove();
  const opener = document.activeElement;
  const overlay = document.createElement('div');
  overlay.id = 'tss-debug-overlay';
  const snapshot = playbackDiagnosticSnapshot('user-opened-report');
  const report = compactPlaybackReport(snapshot);
  let fullReport = null;
  overlay.innerHTML = `
    <div class="tss-debug-dialog" role="dialog" aria-modal="true" aria-labelledby="tss-debug-title">
      <div class="tss-debug-head"><div><strong id="tss-debug-title">Playback report</strong><span>Browser diagnostics</span></div><button id="tss-debug-close" type="button" aria-label="Close">${SVG.close}</button></div>
      <p>Copy this short report directly into your message, with a description of what happened. It keeps the latest fault context until Clear or reload. No track titles, URLs, credentials or exception text; timings cannot detect silence.</p>
      <pre id="tss-debug-report" tabindex="0" aria-label="Short playback report"></pre>
      <details id="tss-debug-details"><summary>Full technical details (optional)</summary><pre id="tss-debug-full-report" tabindex="0" aria-label="Full sanitized playback report"></pre><div class="tss-debug-actions"><button id="tss-debug-copy-full" type="button" hidden>Copy full report</button></div></details>
      <p id="tss-debug-copy-status" role="status" aria-live="polite" hidden></p>
      <div class="tss-debug-actions"><button id="tss-debug-help" type="button">How to report</button><button id="tss-debug-clear" type="button">Clear</button><button id="tss-debug-copy" type="button">Copy report</button></div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#tss-debug-report').textContent = report;
  const close = () => {
    document.getElementById('tss-debug-help-close')?.click();
    overlay.remove();
    const target = opener?.isConnected && !opener.hidden && !opener.closest?.('[hidden]') && !opener.closest?.('[inert]')
      ? opener : document.getElementById('tss-hub-settings');
    target?.focus();
  };
  overlay.querySelector('#tss-debug-close').onclick = close;
  overlay.onclick = event => { if (event.target === overlay) close(); };
  overlay.onkeydown = event => {
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    if (event.key === 'Tab') {
      const first = overlay.querySelector('#tss-debug-close');
      const last = overlay.querySelector('#tss-debug-copy');
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  };
  overlay.querySelector('#tss-debug-help').onclick = showPlaybackReportHelp;
  overlay.querySelector('#tss-debug-clear').onclick = () => {
    state._playbackDiagnostics = [];
    state._playbackDiagnosticFault = false;
    state._playbackDiagnosticIncident = null;
    updatePlaybackDiagnosticButton();
    close();
  };
  const details = overlay.querySelector('#tss-debug-details');
  const fullText = overlay.querySelector('#tss-debug-full-report');
  const fullButton = overlay.querySelector('#tss-debug-copy-full');
  const ensureFullReport = () => {
    if (fullReport === null) {
      fullReport = JSON.stringify(snapshot, null, 2);
      fullText.textContent = fullReport;
    }
    return fullReport;
  };
  details.ontoggle = () => {
    fullButton.hidden = !details.open;
    if (details.open) ensureFullReport();
  };
  const copy = async (event, verbose) => {
    const button = event.currentTarget;
    if (verbose && !details.open) return;
    const text = verbose ? ensureFullReport() : report;
    const reportElement = verbose ? fullText : overlay.querySelector('#tss-debug-report');
    try {
      await navigator.clipboard.writeText(text);
      if (overlay.isConnected && button.isConnected) button.textContent = 'Copied';
    } catch (_) {
      if (!overlay.isConnected || !button.isConnected) return;
      button.textContent = 'Copy blocked';
      reportElement.focus();
      let selected = false;
      try {
        const selection = document.getSelection?.() || window.getSelection?.();
        if (selection) {
          const range = document.createRange();
          range.selectNodeContents(reportElement);
          selection.removeAllRanges();
          selection.addRange(range);
          selected = true;
        }
      } catch (_) {}
      const status = overlay.querySelector('#tss-debug-copy-status');
      status.hidden = false;
      status.textContent = selected
        ? 'Copy blocked. Report selected — press Ctrl+C or Cmd+C to copy.'
        : 'Copy blocked. Select the report text, then press Ctrl+C or Cmd+C to copy.';
    }
  };
  overlay.querySelector('#tss-debug-copy').onclick = event => copy(event, false);
  fullButton.onclick = event => copy(event, true);
  overlay.querySelector('#tss-debug-copy').focus();
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
const WAVEFORM_CACHE_LIMIT = 300;
const waveformCache = new Map();
let waveformRequest = 0;

function waveformTrackKey(meta) {
  const id = soundCloudInteger(meta?.soundcloudId, 1);
  return id !== null ? `soundcloud:${id}` : trackId(meta) || meta?.title || '';
}

function normalizeTrackUrl(url) {
  if (typeof url !== 'string' || !url.trim()) return '';
  try {
    const parsed = new URL(url, location.origin);
    return /^https?:$/.test(parsed.protocol)
      ? `${parsed.origin}${parsed.pathname}`.replace(/\/$/, '').toLowerCase() : '';
  } catch (_) { return ''; }
}

function soundCloudTrackMatches(meta, track) {
  if (!meta || !track) return false;
  if (track === meta) return true;
  const expectedId = soundCloudInteger(meta.soundcloudId ?? meta.id, 1);
  const actualId = soundCloudInteger(track.id ?? track.soundcloudId, 1);
  if (expectedId !== null && actualId !== null) return expectedId === actualId;
  const expectedUrl = normalizeTrackUrl(meta.link || meta.permalink_url || meta.permalinkUrl);
  const actualUrl = normalizeTrackUrl(track.permalink_url || track.permalinkUrl || track.link);
  return Boolean(expectedUrl && actualUrl === expectedUrl);
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

async function resolveWaveformUrl(meta, options = {}) {
  const direct = meta?.waveform || hydrationWaveformUrl(meta);
  if (direct) return direct;
  const wantedUrl = normalizeTrackUrl(meta?.link);
  if (!wantedUrl) return null;
  const isCurrent = options.isCurrent || (() => !options.signal?.aborted);
  try {
    const clientId = await discoverSoundCloudClientIdFromBundle(new Set(), options);
    if (!clientId || !isCurrent()) return null;
    const response = await fetchSoundCloudResource(`https://api-v2.soundcloud.com/resolve?url=${encodeURIComponent(meta.link)}&client_id=${encodeURIComponent(clientId)}`, 'json', options);
    if (!response.ok || !isCurrent()) return null;
    const track = response.data;
    const candidateUrl = normalizeTrackUrl(track?.permalink_url || track?.permalinkUrl || '');
    const resolved = candidateUrl === wantedUrl ? (track?.waveform_url || track?.waveformUrl) : null;
    if (resolved) meta.waveform = resolved;
    return resolved || null;
  } catch (error) {
    if (error?.name !== 'AbortError') recordPlaybackDiagnostic('waveform-resolution-failed', { errorName: playbackErrorName(error) });
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
  const key = waveformTrackKey(meta);
  const request = ++waveformRequest;
  const epoch = state._playbackEpoch;
  const signal = state._playbackAbort?.signal;
  const isCurrent = () => request === waveformRequest && epoch === state._playbackEpoch && !signal?.aborted;
  if (!key) { renderWaveform(); return; }
  if (waveformCache.has(key)) { renderWaveform(waveformCache.get(key)); return; }
  try {
    const url = await resolveWaveformUrl(meta, { signal, isCurrent });
    if (!isCurrent()) return;
    if (!url) { renderWaveform(); return; }
    const response = await fetchSoundCloudResource(url, 'json', { signal, credentials: 'omit' });
    if (!isCurrent()) return;
    if (!response.ok) throw new Error(`waveform ${response.status}`);
    const payload = response.data;
    const heights = downsampleWaveform(payload?.samples || payload?.data || payload);
    if (!heights) throw new Error('waveform samples missing');
    waveformCache.set(key, heights);
    // Older evicted waveforms can be fetched again when revisited.
    if (waveformCache.size > WAVEFORM_CACHE_LIMIT) waveformCache.delete(waveformCache.keys().next().value);
    renderWaveform(heights);
  } catch (error) {
    if (isCurrent()) {
      recordPlaybackDiagnostic('waveform-load-failed', { errorName: playbackErrorName(error) });
      renderWaveform();
    }
  }
}


function mkWorker() {
  let url;
  try {
    const src = `
      let t = null;
      self.onmessage = e => {
        clearInterval(t);
        t = null;
        if (e.data === 'start') {
          self.postMessage('ready');
          t = setInterval(() => self.postMessage(0), 50);
        }
      };
    `;
    url = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
    return new Worker(url);
  } catch (_) {
    return null;
  } finally {
    if (url) URL.revokeObjectURL(url);
  }
}


const LIFETIME_KEY = 'tss_lifetime';

function sanitizeLifetimeStats(value) {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const count = number => typeof number === 'number' && Number.isFinite(number) && number >= 0
    ? Math.floor(number) : 0;
  const counts = record.playCounts && typeof record.playCounts === 'object' && !Array.isArray(record.playCounts)
    ? record.playCounts : {};
  return {
    played: count(record.played),
    elapsed: count(record.elapsed),
    playCounts: Object.fromEntries(Object.entries(counts).filter(([key, value]) =>
      /^(0|[1-9]\d*)$/.test(key) && count(value) > 0
    ).map(([key, value]) => [key, count(value)])),
  };
}

function loadLifetimeStats() {
  try {
    const raw = safeStorage.getItem(LIFETIME_KEY);
    return sanitizeLifetimeStats(raw ? JSON.parse(raw) : null);
  } catch (_) { return sanitizeLifetimeStats(null); }
}

function saveLifetimeStats() {
  try {
    const lt   = loadLifetimeStats();
    const base = sanitizeLifetimeStats(state._lifetimeBase);
    const current = sanitizeLifetimeStats(state.stats);
    const merged = {
      played:     lt.played + Math.max(0, current.played - base.played),
      elapsed:    lt.elapsed + Math.max(0, current.elapsed - base.elapsed),
      playCounts: { ...lt.playCounts },
      _ts:        Date.now(),
    };
    for (const [k, v] of Object.entries(current.playCounts)) {
      const delta = v - (base.playCounts?.[k] || 0);
      if (delta > 0) merged.playCounts[k] = (merged.playCounts[k] || 0) + delta;
    }
    if (!safeStorage.setItem(LIFETIME_KEY, JSON.stringify(merged))) return false;
    state._lifetimeBase = current;
    return true;
  } catch (_) { return false; }
}




function showMergeToast(count) {
  let toast = document.getElementById('tss-merge-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'tss-merge-toast';
    toast.style.cssText = `
      position:fixed; bottom:24px; left:50%; transform:translateX(-50%);
      background:var(--tss-glass-surface,#080b12); color:#d3d7df;
      border-radius:8px; font-size:12px; font-weight:500;
      padding:8px 20px; z-index:999999;
      border:1px solid var(--tss-glass-rim,rgba(183,199,232,.12));
      box-shadow:var(--tss-glass-shadow);
      -webkit-backdrop-filter:var(--tss-glass-filter,none); backdrop-filter:var(--tss-glass-filter,none);
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
  let text = '';
  if (t?.type === 'time') {
    t.remaining = timedSleepRemaining(t, now);
    const m = Math.floor(t.remaining / 60), s = t.remaining % 60;
    text = m > 0 ? `${m}m` : `${s}s`;
  } else if (t) {
    text = `${t.remaining}`;
  }
  if (el.textContent !== text) el.textContent = text;
}


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

// Better SoundCloud Feed's PiP reads scPlayer, not Media Session. Expose the
// private deck while active; otherwise delegate to SoundCloud unchanged.
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

// Better Feed's PiP canvas can stop repainting in background tabs.
// Sync its scoped visual surface with our background-safe hub clock.
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
    const key = waveformTrackKey(meta);
    const heights = waveformCache.get(key) || DEFAULT_WAVE_HEIGHTS;
    const styles = typeof pipWindow.getComputedStyle === 'function'
      ? pipWindow.getComputedStyle(pipDoc.documentElement)
      : null;
    const activeColor = getComputedStyle(document.documentElement).getPropertyValue('--tss-a').trim() || '#aebaf3';
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
  const open = ownPipIsOpen();
  const openValue = String(open);
  if (button.style.display !== '') button.style.display = '';
  if (button.dataset.open !== openValue) button.dataset.open = openValue;
  if (button.getAttribute('aria-pressed') !== openValue) button.setAttribute('aria-pressed', openValue);
  const label = open ? 'Show True Shuffle picture in picture' : 'Open True Shuffle picture in picture';
  if (button.getAttribute('aria-label') !== label) button.setAttribute('aria-label', label);
  const mode = state._ownPipMode === 'video' ? 'native video PiP'
    : state._ownPipMode === 'inline' ? 'floating player'
    : 'True Shuffle PiP';
  const title = open ? `${mode} is open` : 'Open True Shuffle PiP';
  if (button.title !== title) button.title = title;
}

function pipTransactionIsCurrent(transaction) {
  return state.active && state._playbackEpoch === transaction.epoch
    && state._pipOpenTransaction === transaction && !transaction.controller.signal.aborted;
}

function exitOwnedVideoPip(video) {
  try {
    if (pageWindow.document?.pictureInPictureElement === video) {
      void withDeadline(() => pageWindow.document.exitPictureInPicture(), 5000).catch(() => {});
    } else if (video?.webkitPresentationMode === 'picture-in-picture') {
      video.webkitSetPresentationMode('inline');
    }
  } catch (_) {}
}

function closeOwnPip() {
  const transaction = state._pipOpenTransaction;
  state._pipOpenTransaction = null;
  transaction?.controller.abort();
  try { transaction?.dispose?.(); } catch (_) {}
  const pipWindow = state._ownPipWindow;
  const pipHost = state._ownPipHost;
  const videoPip = state._videoPip;
  const mode = state._ownPipMode;
  try { state._pipTrackMenuClose?.(); } catch (_) {}
  try { state._ownPipCleanup?.(); } catch (_) {}
  state._ownPipWindow = null;
  state._ownPipHost = null;
  state._ownPipMode = null;
  state._videoPip = null;
  state._ownPipCleanup = null;
  try { videoPip?.dispose(); } catch (_) {}
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
  const key = waveformTrackKey(meta);
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
  const countText = `${order.length} ${tab === 'history' ? 'played' : `track${order.length === 1 ? '' : 's'}`}`;
  if (count.textContent !== countText) count.textContent = countText;
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
  state._pipTrackMenuClose?.();
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

  let registration = null;
  const dismiss = event => {
    if (!menu.contains(event.target) && !anchor.contains(event.target)) close();
  };
  const close = () => {
    clearTimeout(registration);
    pipDocument.removeEventListener('pointerdown', dismiss, true);
    menu.remove();
    if (state._pipTrackMenuClose === close) state._pipTrackMenuClose = null;
  };
  state._pipTrackMenuClose = close;
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

  registration = setTimeout(() => {
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
  state._pipTrackMenuClose?.();
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
      safeStorage.setItem('tss_crossfade_curve', state.crossfadeCurve);
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

function soundCloudPermalinkConflicts(meta, metas = state.meta) {
  const wanted = normalizeTrackUrl(meta?.link);
  if (!wanted) return false;
  const ids = new Set();
  const ownId = soundCloudInteger(meta?.soundcloudId, 1);
  if (ownId !== null) ids.add(ownId);
  const indexed = !Array.isArray(metas);
  const candidates = indexed ? metas.byLink.get(wanted) || [] : metas;
  for (const candidate of candidates) {
    const item = indexed ? metas.metas[candidate] : candidate;
    if (normalizeTrackUrl(item?.link) !== wanted) continue;
    const id = soundCloudInteger(item.soundcloudId, 1);
    if (id !== null) ids.add(id);
    if (ids.size > 1) return true;
  }
  return false;
}

function soundCloudLinkMatches(meta, href, metas = state.meta) {
  const wanted = normalizeTrackUrl(meta?.link);
  // SoundCloud exposes no independently verified ID in these DOM bindings.
  // A permalink shared by known IDs therefore cannot authorize a native action.
  return Boolean(wanted && normalizeTrackUrl(href) === wanted && !soundCloudPermalinkConflicts(meta, metas));
}

function soundCloudPlayerMatches(meta) {
  const link = document.querySelector('.playbackSoundBadge__titleLink');
  return soundCloudLinkMatches(meta, link?.href);
}

function soundCloudRowsByLink(rows) {
  const byLink = new Map();
  for (const row of rows) {
    const link = normalizeTrackUrl(getLink(row));
    if (link && !byLink.has(link)) byLink.set(link, row);
  }
  return byLink;
}

function matchingSoundCloudRow(meta, rowsByLink, metas = state.meta) {
  if (soundCloudPermalinkConflicts(meta, metas)) return null;
  return rowsByLink.get(normalizeTrackUrl(meta?.link)) || null;
}

function boundSoundCloudRow(ti) {
  const meta = state.meta[ti];
  const wanted = normalizeTrackUrl(meta?.link);
  if (!wanted) return null;
  const matches = row => row && document.body.contains(row) && soundCloudLinkMatches(meta, getLink(row));
  const bound = state.els[ti];
  if (matches(bound)) return bound;
  for (const link of document.querySelectorAll('a[href]')) {
    if (normalizeTrackUrl(link.href) !== wanted) continue;
    const row = link.closest('.trackList__item, .soundList__item, li.sc-list-item, .sound');
    if (!matches(row)) continue;
    state.els[ti] = row;
    return row;
  }
  return null;
}

function findSoundCloudLikeButton(ti) {
  const meta = state.meta[ti];
  const wanted = normalizeTrackUrl(meta?.link);
  if (!wanted || soundCloudPermalinkConflicts(meta)) return null;

  const bound = boundSoundCloudRow(ti);
  if (bound) {
    const button = bound.querySelector('.sc-button-like');
    if (button) return button;
  }

  const playerLink = document.querySelector('.playbackSoundBadge__titleLink');
  if (playerLink && soundCloudPlayerMatches(meta)) {
    const button = playerLink.closest('.playbackSoundBadge')?.querySelector('.playbackSoundBadge__like, .sc-button-like');
    if (button) return button;
  }

  if (normalizeTrackUrl(location.href) === wanted && !soundCloudPermalinkConflicts(meta)) {
    const button = document.querySelector('.listenEngagement__actions .sc-button-like, .soundActions .sc-button-like');
    if (button) return button;
  }

  for (const link of document.querySelectorAll('a[href]')) {
    if (normalizeTrackUrl(link.href) !== wanted) continue;
    const root = link.closest('.trackList__item, .soundList__item, li.sc-list-item, .sound');
    const button = root && soundCloudLinkMatches(meta, getLink(root)) ? root.querySelector('.sc-button-like') : null;
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

function ownPipArtworkSource(url, mode = state.pipArtworkMode) {
  if (!url || !['full', 'focus'].includes(mode)) return url || '';
  return String(url).replace(/-t\d+x\d+(?=\.(?:jpg|png)(?:$|\?))/i, '-t500x500');
}

function ownPipDimensions(mode = state.pipArtworkMode) {
  if (mode === 'focus') return { width: 380, height: 460 };
  return mode === 'full' ? { width: 420, height: 660 } : { width: 440, height: 360 };
}

function nextOwnPipArtworkMode(mode = state.pipArtworkMode) {
  return mode === 'compact' ? 'full' : mode === 'full' ? 'focus' : 'compact';
}

function setOwnPipArtworkMode(mode, pipDocument = state._ownPipWindow?.document) {
  const nextMode = ['compact', 'full', 'focus'].includes(mode) ? mode : 'compact';
  state.pipArtworkMode = nextMode;
  try { safeStorage.setItem('tss_pip_artwork_mode', nextMode); } catch (_) {}

  const player = pipDocument?.getElementById('tss-pip-player');
  if (player) player.dataset.artworkMode = nextMode;
  if (nextMode === 'focus') {
    const stage = pipDocument?.getElementById('tss-pip-stage');
    const nowView = pipDocument?.getElementById('tss-pip-now-view');
    const queueView = pipDocument?.getElementById('tss-pip-queue-view');
    const viewToggle = pipDocument?.getElementById('tss-pip-view-toggle');
    if (stage) stage.dataset.view = 'player';
    if (nowView) {
      nowView.setAttribute('aria-hidden', 'false');
      if ('inert' in nowView) nowView.inert = false;
    }
    if (queueView) {
      queueView.setAttribute('aria-hidden', 'true');
      if ('inert' in queueView) queueView.inert = true;
    }
    if (viewToggle) {
      viewToggle.dataset.active = 'false';
      viewToggle.setAttribute('aria-pressed', 'false');
    }
  }

  const dimensions = ownPipDimensions(nextMode);
  if (state._ownPipMode === 'document') {
    try { state._ownPipWindow?.resizeTo?.(dimensions.width, dimensions.height); } catch (_) {}
  } else if (state._ownPipMode === 'inline' && state._ownPipHost) {
    state._ownPipHost.style.width = `${dimensions.width}px`;
    state._ownPipHost.style.height = `${dimensions.height}px`;
  }
  const toggle = pipDocument?.getElementById('tss-pip-artwork-toggle');
  if (toggle) {
    const followingMode = nextOwnPipArtworkMode(nextMode);
    const label = followingMode === 'full' ? 'Use full artwork layout'
      : followingMode === 'focus' ? 'Use focus artwork layout'
      : 'Use compact artwork layout';
    toggle.dataset.active = nextMode === 'compact' ? 'false' : 'true';
    toggle.setAttribute('aria-pressed', nextMode === 'compact' ? 'false' : 'true');
    toggle.setAttribute('aria-label', label);
    toggle.title = label;
  }
  return nextMode;
}

function syncOwnPipMarquee(viewport, text) {
  if (!viewport || !text) return false;
  const value = text.textContent || '—';
  if (viewport.title !== value) viewport.title = value;
  if (viewport.getAttribute('aria-label') !== value) viewport.setAttribute('aria-label', value);
  const width = Math.max(0, Number(viewport.clientWidth) || 0);
  const overflow = Math.max(0, (Number(text.scrollWidth) || 0) - width);
  const stage = viewport.ownerDocument?.getElementById('tss-pip-stage');
  const active = state.scrollLongTitles && stage?.dataset.view === 'player' && width > 0 && overflow > 2;
  const activeValue = active ? 'true' : 'false';
  if (viewport.dataset.overflow !== activeValue) viewport.dataset.overflow = activeValue;
  if (active) {
    const distance = `${-overflow}px`;
    const duration = `${Math.max(7, Math.min(18, 5 + overflow / 18)).toFixed(1)}s`;
    if (text.style.getPropertyValue('--tss-pip-marquee-distance') !== distance) text.style.setProperty('--tss-pip-marquee-distance', distance);
    if (text.style.getPropertyValue('--tss-pip-marquee-duration') !== duration) text.style.setProperty('--tss-pip-marquee-duration', duration);
  }
  return active;
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
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--tss-a').trim() || '#aebaf3';
  const total = Math.max(1, state.roundTotal || state.queue.length);
  const inRound = Math.min(total, Math.max(1, state.roundPlayed + 1));

  const windowTitle = ownPipWindowTitle(meta, paused());
  if (pipDocument.title !== windowTitle) pipDocument.title = windowTitle;
  if (pipDocument.documentElement.style.getPropertyValue('--accent') !== accent) {
    pipDocument.documentElement.style.setProperty('--accent', accent);
  }
  const titleViewport = pipDocument.getElementById('tss-pip-title');
  const title = pipDocument.getElementById('tss-pip-title-text');
  const artist = pipDocument.getElementById('tss-pip-artist');
  const position = pipDocument.getElementById('tss-pip-position');
  const currentTime = pipDocument.getElementById('tss-pip-current');
  const remaining = pipDocument.getElementById('tss-pip-remaining');
  const titleText = meta?.title || playerTitle() || '—';
  const artistText = meta?.artist || '—';
  const positionText = `${inRound} / ${total}`;
  const currentText = formatPlaybackClock(timing.current);
  const remainingText = `-${formatPlaybackClock(Math.max(0, timing.duration - timing.current))}`;
  if (title && title.textContent !== titleText) title.textContent = titleText;
  syncOwnPipMarquee(titleViewport, title);
  if (artist && artist.textContent !== artistText) artist.textContent = artistText;
  if (position && position.textContent !== positionText) position.textContent = positionText;
  if (currentTime && currentTime.textContent !== currentText) currentTime.textContent = currentText;
  if (remaining && remaining.textContent !== remainingText) remaining.textContent = remainingText;

  const artwork = pipDocument.getElementById('tss-pip-artwork');
  const artworkFallback = pipDocument.getElementById('tss-pip-artwork-fallback');
  const artworkSource = ownPipArtworkSource(meta?.artwork);
  if (artwork && artwork.dataset.src !== artworkSource) {
    artwork.dataset.src = artworkSource;
    artwork.src = artworkSource;
    artwork.hidden = !artworkSource;
    if (artworkFallback) artworkFallback.hidden = Boolean(artworkSource);
  }

  const play = pipDocument.getElementById('tss-pip-play');
  if (play) {
    const isPaused = paused();
    const icon = isPaused ? SVG.play : SVG.pause;
    if (play._tssPlayIcon !== icon || play.innerHTML !== play._tssPlayMarkup) {
      play.innerHTML = icon;
      play._tssPlayIcon = icon;
      play._tssPlayMarkup = play.innerHTML;
    }
    const label = isPaused ? 'Play' : 'Pause';
    if (play.getAttribute('aria-label') !== label) play.setAttribute('aria-label', label);
  }

  const like = pipDocument.getElementById('tss-pip-like');
  if (like) {
    const likeState = currentTrackLikeState(currentTi);
    const icon = likeState.liked ? SVG.heartFilled : SVG.heart;
    if (like._tssLikeIcon !== icon || like.innerHTML !== like._tssLikeMarkup) {
      like.innerHTML = icon;
      like._tssLikeIcon = icon;
      like._tssLikeMarkup = like.innerHTML;
    }
    const liked = likeState.liked ? 'true' : 'false';
    const available = likeState.available ? 'true' : 'false';
    const disabled = state._likeBusy || !likeState.available;
    const label = likeState.liked ? 'Unlike current track' : 'Like current track';
    const title = likeState.available
      ? (likeState.liked ? 'Unlike on SoundCloud' : 'Like on SoundCloud')
      : 'Like is available when the track is visible on SoundCloud';
    if (like.dataset.liked !== liked) like.dataset.liked = liked;
    if (like.dataset.available !== available) like.dataset.available = available;
    if (like.disabled !== disabled) like.disabled = disabled;
    if (like.getAttribute('aria-pressed') !== liked) like.setAttribute('aria-pressed', liked);
    if (like.getAttribute('aria-label') !== label) like.setAttribute('aria-label', label);
    if (like.title !== title) like.title = title;
  }

  const nextRow = pipDocument.getElementById('tss-pip-up-next-row');
  const nextTitle = pipDocument.getElementById('tss-pip-next-title');
  const nextArtist = pipDocument.getElementById('tss-pip-next-artist');
  const nextNumber = pipDocument.getElementById('tss-pip-next-number');
  const nextArtwork = pipDocument.getElementById('tss-pip-next-artwork');
  const nextFallback = pipDocument.getElementById('tss-pip-next-fallback');
  const nextSettings = pipDocument.getElementById('tss-pip-next-settings');
  const empty = nextMeta ? 'false' : 'true';
  const nextTitleText = nextMeta?.title || (state.stopAfterRound ? 'End of round' : 'Fresh shuffle');
  const nextArtistText = nextMeta?.artist || (state.stopAfterRound ? 'Playback will stop' : 'A new round will begin');
  const nextNumberText = nextMeta ? String(Math.min(total, inRound + 1)) : '—';
  if (nextRow && nextRow.dataset.empty !== empty) nextRow.dataset.empty = empty;
  if (nextTitle && nextTitle.textContent !== nextTitleText) nextTitle.textContent = nextTitleText;
  if (nextArtist && nextArtist.textContent !== nextArtistText) nextArtist.textContent = nextArtistText;
  if (nextNumber && nextNumber.textContent !== nextNumberText) nextNumber.textContent = nextNumberText;
  if (nextArtwork && nextArtwork.dataset.src !== (nextMeta?.artwork || '')) {
    nextArtwork.dataset.src = nextMeta?.artwork || '';
    nextArtwork.src = nextMeta?.artwork || '';
    nextArtwork.hidden = !nextMeta?.artwork;
    if (nextFallback) nextFallback.hidden = Boolean(nextMeta?.artwork);
  }
  if (nextSettings) {
    const disabled = queuedNext === undefined;
    const ti = disabled ? '' : String(queuedNext);
    const label = `Settings for ${nextMeta?.title || 'up next'}`;
    if (nextSettings.disabled !== disabled) nextSettings.disabled = disabled;
    if (nextSettings.dataset.ti !== ti) nextSettings.dataset.ti = ti;
    if (nextSettings.getAttribute('aria-label') !== label) nextSettings.setAttribute('aria-label', label);
  }

  const crossfade = pipDocument.getElementById('tss-pip-crossfade');
  const crossfadeValue = pipDocument.getElementById('tss-pip-crossfade-value');
  const autoLevel = pipDocument.getElementById('tss-pip-auto-level');
  const processing = pipDocument.getElementById('tss-pip-processing');
  const pipState = pipDocument.getElementById('tss-pip-state');
  if (crossfade) {
    const active = state.crossfadeSeconds > 0 ? 'true' : 'false';
    const hidden = state.crossfadeSeconds <= 0;
    if (crossfade.dataset.active !== active) crossfade.dataset.active = active;
    if (crossfade.hidden !== hidden) crossfade.hidden = hidden;
  }
  const fadeText = `${state.crossfadeSeconds}s fade`;
  if (crossfadeValue && crossfadeValue.textContent !== fadeText) crossfadeValue.textContent = fadeText;
  if (autoLevel) {
    const active = state.autoLevel ? 'true' : 'false';
    if (autoLevel.dataset.active !== active) autoLevel.dataset.active = active;
    if (autoLevel.hidden !== !state.autoLevel) autoLevel.hidden = !state.autoLevel;
  }
  const processingHidden = state.crossfadeSeconds <= 0 && !state.autoLevel;
  if (processing && processing.hidden !== processingHidden) processing.hidden = processingHidden;
  if (pipState) {
    const status = state.suspended ? 'external playback'
      : state.loading ? 'loading'
      : state._crossfading ? 'mixing'
      : state.busy ? 'switching'
      : state.crossfadeStatus === 'loading' ? 'loading next'
      : state.crossfadeStatus === 'fallback' ? 'fallback'
      : '';
    if (pipState.textContent !== status) pipState.textContent = status;
    if (pipState.hidden !== !status) pipState.hidden = !status;
  }

  if (pipDocument.getElementById('tss-pip-stage')?.dataset.view === 'queue') renderOwnPipQueue(pipDocument, currentTi);

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
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--tss-a').trim() || '#aebaf3';
  const key = waveformTrackKey(meta);
  const heights = waveformCache.get(key) || DEFAULT_WAVE_HEIGHTS;

  ctx.fillStyle = '#05080e';
  ctx.fillRect(0, 0, width, height);
  const glow = ctx.createRadialGradient(width * .2, 0, 0, width * .2, 0, width * .72);
  glow.addColorStop(0, `${accent}1a`);
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

async function openVideoPipFallback(transaction) {
  if (!pipTransactionIsCurrent(transaction) || !standardVideoPipSupported()) return false;
  const canvas = document.createElement('canvas');
  if (typeof canvas.captureStream !== 'function') return false;
  canvas.width = 640;
  canvas.height = 360;
  canvas.style.cssText = 'position:fixed;width:1px;height:1px;left:-9999px;top:-9999px;pointer-events:none';
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.style.cssText = canvas.style.cssText;
  let stream = null;
  let timer = null;
  let disposed = false;
  let syncing = true;
  let playPending = false;
  const playbackController = new AbortController();
  const onPause = () => {
    if (!disposed && !syncing && !paused()) pause();
  };
  const onPlay = () => {
    if (!disposed && !syncing && paused()) void toggle();
  };
  const onPresentationChange = () => {
    if (video.webkitPresentationMode !== 'picture-in-picture') dispose();
  };
  const dispose = () => {
    if (disposed) { exitOwnedVideoPip(video); return; }
    disposed = true;
    playbackController.abort();
    clearInterval(timer);
    video.removeEventListener('pause', onPause);
    video.removeEventListener('play', onPlay);
    video.removeEventListener('leavepictureinpicture', dispose);
    video.removeEventListener('webkitpresentationmodechanged', onPresentationChange);
    exitOwnedVideoPip(video);
    try { video.pause(); } catch (_) {}
    try { stream?.getTracks().forEach(track => track.stop()); } catch (_) {}
    video.srcObject = null;
    video.remove();
    canvas.remove();
    if (state._videoPip?.video === video) {
      state._videoPip = null;
      state._ownPipMode = null;
      setOwnPipButtonState();
    }
  };
  transaction.dispose = dispose;
  try {
    document.body.append(canvas, video);
    stream = canvas.captureStream(8);
    video.srcObject = stream;
    drawVideoPipFrame(canvas);
    await withDeadline(signal => Promise.resolve(video.play()).then(() => {
      if (signal.aborted || disposed || !pipTransactionIsCurrent(transaction)) {
        video.pause();
        throw new DOMException('PiP cancelled', 'AbortError');
      }
    }), 5000, transaction.controller.signal);
    if (!pipTransactionIsCurrent(transaction)) { dispose(); return false; }
    video.addEventListener('pause', onPause);
    video.addEventListener('play', onPlay);
    video.addEventListener('leavepictureinpicture', dispose);
    video.addEventListener('webkitpresentationmodechanged', onPresentationChange);
    if (typeof video.requestPictureInPicture === 'function') {
      await withDeadline(signal => Promise.resolve(video.requestPictureInPicture()).then(() => {
        if (signal.aborted || disposed || !pipTransactionIsCurrent(transaction)) {
          dispose();
          throw new DOMException('PiP cancelled', 'AbortError');
        }
      }), 5000, transaction.controller.signal);
    } else if (typeof video.webkitSetPresentationMode === 'function') {
      video.webkitSetPresentationMode('picture-in-picture');
    } else throw new Error('Video PiP unavailable');
    if (disposed || !pipTransactionIsCurrent(transaction)) { dispose(); return false; }
    timer = setInterval(() => {
      if (disposed) return;
      drawVideoPipFrame(canvas);
      syncing = true;
      if (paused() && !video.paused) video.pause();
      else if (!paused() && video.paused && !playPending) {
        playPending = true;
        void withDeadline(signal => Promise.resolve(video.play()).then(() => {
          if (signal.aborted || disposed || paused()) video.pause();
        }), 5000, playbackController.signal).catch(() => {}).finally(() => { playPending = false; });
      }
      queueMicrotask(() => { syncing = false; });
    }, 250);
    state._ownPipMode = 'video';
    state._videoPip = { video, canvas, stream, timer, dispose };
    showMergeToast('using native video PiP fallback');
    setOwnPipButtonState();
    return true;
  } catch (error) {
    dispose();
    throw error;
  }
}

function openInPagePipFallback() {
  const host = document.createElement('div');
  host.id = 'tss-inline-pip';
  host.setAttribute('role', 'dialog');
  host.setAttribute('aria-label', 'True Shuffle floating player');
  const dimensions = ownPipDimensions();
  host.style.cssText = `position:fixed;right:20px;bottom:90px;width:${dimensions.width}px;height:${dimensions.height}px;min-width:330px;min-height:280px;max-width:min(92vw,760px);max-height:min(86vh,820px);z-index:999999;resize:both;overflow:hidden;border-radius:14px;--tss-glass-base:#090a0c;--tss-glass-filter:none;box-shadow:var(--tss-glass-shadow);background:var(--tss-glass-surface,#090a0c);-webkit-backdrop-filter:var(--tss-glass-filter,none);backdrop-filter:var(--tss-glass-filter,none)`;
  const iframe = document.createElement('iframe');
  iframe.title = 'True Shuffle floating player';
  iframe.style.cssText = 'display:block;width:100%;height:100%;border:0;background:transparent';
  host.appendChild(iframe);
  document.body.appendChild(host);
  state._ownPipHost = host;
  state._ownPipMode = 'inline';
  try {
    mountOwnPipWindow(iframe.contentWindow, 'inline');
  } catch (error) {
    state._ownPipCleanup?.();
    host.remove();
    state._ownPipHost = null;
    state._ownPipWindow = null;
    state._ownPipMode = null;
    throw error;
  }

  const header = iframe.contentDocument?.querySelector('.tss-pip-header');
  if (header) {
    let finishDrag = null;
    const disposeMount = state._ownPipCleanup;
    state._ownPipCleanup = () => {
      finishDrag?.();
      disposeMount?.();
    };
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
      finishDrag?.();
      const up = () => {
        finishDrag = null;
        header.style.cursor = 'grab';
        iframe.contentDocument.removeEventListener('pointermove', move);
        iframe.contentDocument.removeEventListener('pointerup', up);
        iframe.contentDocument.removeEventListener('pointercancel', up);
      };
      finishDrag = up;
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
  if (state._pipOpenTransaction) return state._pipOpenTransaction.promise;
  if (ownPipIsOpen()) {
    try { state._ownPipWindow?.focus?.(); } catch (_) {}
    return true;
  }
  const transaction = { epoch: state._playbackEpoch, controller: new AbortController(), dispose: null, promise: null };
  state._pipOpenTransaction = transaction;
  transaction.promise = (async () => {
    const documentPip = documentPipApi();
    if (documentPip) {
      let pipWindow = null;
      try {
        pipWindow = await withDeadline(signal => Promise.resolve(documentPip.requestWindow(ownPipDimensions())).then(acquired => {
          if (signal.aborted || !pipTransactionIsCurrent(transaction)) {
            try { acquired?.close?.(); } catch (_) {}
            throw new DOMException('PiP cancelled', 'AbortError');
          }
          return acquired;
        }), 5000, transaction.controller.signal);
        transaction.dispose = () => {
          if (state._ownPipWindow === pipWindow) state._ownPipCleanup?.();
          try { pipWindow?.close?.(); } catch (_) {}
        };
        if (!pipTransactionIsCurrent(transaction)) { transaction.dispose(); return false; }
        return mountOwnPipWindow(pipWindow, 'document');
      } catch (error) {
        transaction.dispose?.();
        transaction.dispose = null;
        if (!pipTransactionIsCurrent(transaction)) return false;
        console.warn('[True Shuffle] Document PiP failed; trying fallback.', error);
      }
    }
    if (standardVideoPipSupported()) {
      try {
        if (await openVideoPipFallback(transaction)) return true;
      } catch (_) {}
    }
    if (!pipTransactionIsCurrent(transaction)) return false;
    return openInPagePipFallback();
  })().catch(error => {
    try { transaction.dispose?.(); } catch (_) {}
    console.warn('[True Shuffle] PiP unavailable.', error);
    return false;
  }).finally(() => {
    if (state._pipOpenTransaction === transaction) state._pipOpenTransaction = null;
  });
  return transaction.promise;
}

function mountOwnPipWindow(pipWindow, mode = 'document') {
  const pipDocument = pipWindow.document;
  state._ownPipWindow = pipWindow;
  state._ownPipMode = mode;
  const dispose = () => {
    pipWindow.removeEventListener('resize', syncOwnPipWindow);
    pipWindow.removeEventListener('pagehide', onPageHide);
    if (state._ownPipWindow === pipWindow) {
      state._pipTrackMenuClose?.();
      state._ownPipWindow = null;
      state._ownPipMode = null;
      state._ownPipCleanup = null;
    }
  };
  const onPageHide = () => {
    dispose();
    setOwnPipButtonState();
  };
  state._ownPipCleanup = dispose;
  pipDocument.title = 'True Shuffle';
  const style = pipDocument.createElement('style');
  style.textContent = `
    :root{color-scheme:dark;--accent:#aebaf3;--pip-glass-base:#090a0c;--pip-glass-light:linear-gradient(180deg,rgba(255,255,255,.04),rgba(255,255,255,0) 40%);--pip-glass-surface:var(--pip-glass-light),var(--pip-glass-base);--pip-glass-inset:rgba(0,0,0,.08);--pip-menu-surface:var(--pip-glass-light),rgba(9,10,12,.12);--pip-glass-filter:none;--pip-glass-rim:rgba(255,255,255,.12);--pip-glass-edge:inset 0 1px 0 rgba(255,255,255,.07),inset 0 0 0 1px rgba(255,255,255,.025),inset 0 -1px 0 rgba(0,0,0,.12);--pip-glass-shadow:var(--pip-glass-edge),0 20px 54px rgba(0,0,0,.38);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
    *{box-sizing:border-box}
    html,body{width:100%;height:100%;margin:0;overflow:hidden;background:#090a0c;color:#f4f4f4}
    button{font:inherit}
    #tss-pip-player{height:100%;min-height:300px;padding:12px 14px;display:flex;flex-direction:column;position:relative;overflow:hidden;background:var(--pip-glass-surface);border:1px solid var(--pip-glass-rim);box-shadow:${mode === 'inline' ? 'none' : 'var(--pip-glass-edge)'};-webkit-backdrop-filter:var(--pip-glass-filter);backdrop-filter:var(--pip-glass-filter)}
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
    #tss-pip-player[data-artwork-mode="full"] .tss-pip-track{flex:0 0 auto;min-height:0;display:flex;flex-direction:column;align-items:stretch;gap:9px}
    #tss-pip-player[data-artwork-mode="full"] .tss-pip-track-copy{order:-1;flex:0 0 auto;width:100%}
    #tss-pip-player[data-artwork-mode="full"] .tss-pip-art{flex:0 0 auto;width:100%;height:auto;min-height:0;aspect-ratio:1;border-radius:0;background:transparent;box-shadow:none}
    #tss-pip-player[data-artwork-mode="full"] .tss-pip-art img{object-fit:cover}
    #tss-pip-player[data-artwork-mode="full"] .tss-pip-wave{margin-top:8px}
    #tss-pip-player[data-artwork-mode="full"] .tss-pip-controls{margin:6px 0 7px}
    #tss-pip-player[data-artwork-mode="full"] .tss-pip-up-next{display:none}
    #tss-pip-player[data-artwork-mode="focus"]{padding:12px}
    #tss-pip-player[data-artwork-mode="focus"] .tss-pip-header{position:absolute;top:8px;right:8px;z-index:12;width:68px;height:32px;padding:1px;gap:2px;border:1px solid var(--pip-glass-rim);border-radius:9px;background:var(--pip-menu-surface);box-shadow:inset 0 1px 0 rgba(232,239,255,.06),0 5px 16px rgba(2,5,12,.28);opacity:0;transform:translateY(-4px);transition:opacity .18s ease,transform .18s cubic-bezier(.22,1,.36,1)}
    #tss-pip-player[data-artwork-mode="focus"] .tss-pip-header:hover,#tss-pip-player[data-artwork-mode="focus"] .tss-pip-header:focus-within{opacity:1;transform:none}
    #tss-pip-player[data-artwork-mode="focus"] .tss-pip-header>*{display:none}
    #tss-pip-player[data-artwork-mode="focus"] .tss-pip-header #tss-pip-artwork-toggle,#tss-pip-player[data-artwork-mode="focus"] .tss-pip-header #tss-pip-close{display:flex}
    #tss-pip-player[data-artwork-mode="focus"] .tss-pip-stage{margin-top:0}
    #tss-pip-player[data-artwork-mode="focus"] #tss-pip-now-view{display:flex}
    #tss-pip-player[data-artwork-mode="focus"] .tss-pip-track{height:100%;min-height:0;display:flex;flex-direction:column;align-items:stretch;justify-content:center;gap:12px}
    #tss-pip-player[data-artwork-mode="focus"] .tss-pip-art{flex:0 0 auto;width:100%;height:auto;min-height:0;aspect-ratio:1;border-radius:12px;background:rgba(255,255,255,.035);box-shadow:0 12px 34px rgba(0,0,0,.52),0 0 0 1px rgba(255,255,255,.08)}
    #tss-pip-player[data-artwork-mode="focus"] .tss-pip-track-copy{order:-1;flex:0 0 auto;width:100%;padding:1px 2px 0;display:flex;flex-direction:column;align-items:center;text-align:center}
    #tss-pip-player[data-artwork-mode="focus"] .tss-pip-artist{order:-1;margin:0 0 5px;color:var(--accent);font-size:11px;font-weight:650;text-align:center}
    #tss-pip-player[data-artwork-mode="focus"] .tss-pip-title{width:100%;font-size:19px;line-height:1.18;text-align:center}
    #tss-pip-player[data-artwork-mode="focus"] .tss-pip-track-meta,#tss-pip-player[data-artwork-mode="focus"] .tss-pip-wave,#tss-pip-player[data-artwork-mode="focus"] .tss-pip-controls,#tss-pip-player[data-artwork-mode="focus"] .tss-pip-up-next{display:none}
    .tss-pip-close{width:29px;height:29px;border:0;border-radius:8px;background:transparent;color:rgba(255,255,255,.58)}
    .tss-pip-close:hover{color:#fff;background:rgba(255,255,255,.07)}
    .tss-pip-stage{flex:1;min-height:0;position:relative;margin-top:10px}
    .tss-pip-view{position:absolute;inset:0;min-height:0;transition:transform .24s cubic-bezier(.22,1,.36,1),opacity .18s ease;will-change:transform,opacity}
    #tss-pip-now-view{display:flex;flex-direction:column;transform:translateX(0);opacity:1}
    #tss-pip-queue-view{display:flex;flex-direction:column;transform:translateX(34px);opacity:0;pointer-events:none}
    .tss-pip-stage[data-view="queue"] #tss-pip-now-view{transform:translateX(-34px);opacity:0;pointer-events:none}
    .tss-pip-stage[data-view="queue"] #tss-pip-queue-view{transform:translateX(0);opacity:1;pointer-events:auto}
    .tss-pip-track{display:grid;grid-template-columns:clamp(96px,28vw,124px) minmax(0,1fr);align-items:center;gap:15px;min-height:96px}
    .tss-pip-art{width:100%;height:auto;aspect-ratio:1;border-radius:12px;overflow:hidden;position:relative;background:rgba(255,255,255,.035);box-shadow:0 9px 24px rgba(0,0,0,.46),0 0 0 1px rgba(255,255,255,.08)}
    .tss-pip-art img{display:block;width:100%;height:100%;object-fit:cover}
    .tss-pip-art-fallback{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:rgba(255,255,255,.26)}
    .tss-pip-art-fallback[hidden],.tss-pip-art img[hidden]{display:none}
    .tss-pip-title{min-width:0;overflow:hidden;white-space:nowrap;font-size:18px;line-height:1.2;font-weight:720;letter-spacing:-.025em}
    .tss-pip-title-text{display:inline-block;min-width:100%;width:max-content}
    .tss-pip-stage[data-view="player"] .tss-pip-title[data-overflow="true"] .tss-pip-title-text{animation:tssPipMarquee var(--tss-pip-marquee-duration,9s) ease-in-out infinite alternate}
    .tss-pip-artist{margin-top:5px;color:rgba(255,255,255,.58);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .tss-pip-track-meta{display:flex;align-items:center;gap:8px;margin-top:7px;min-width:0}.tss-pip-position{color:rgba(255,255,255,.68);font-size:9px;font-weight:620;letter-spacing:.08em;white-space:nowrap}
    .tss-pip-processing{display:flex;align-items:center;gap:5px;min-width:0;color:rgba(255,255,255,.27);font-size:8px;font-weight:560;white-space:nowrap}.tss-pip-processing[hidden],.tss-pip-processing span[hidden]{display:none}.tss-pip-processing::before{content:'·';color:rgba(255,255,255,.18)}.tss-pip-processing span+span::before{content:'·';margin-right:5px;color:rgba(255,255,255,.18)}
    .tss-pip-wave{margin-top:11px}
    #tss-pip-waveform{display:block;width:100%;height:28px;cursor:pointer}
    .tss-pip-times{display:flex;justify-content:space-between;margin-top:3px;color:rgba(255,255,255,.47);font-size:8px;font-variant-numeric:tabular-nums}
    .tss-pip-controls{display:flex;align-items:center;justify-content:center;gap:22px;margin:9px 0 11px}
    .tss-pip-control{display:flex;align-items:center;justify-content:center;width:39px;height:39px;padding:0;border:1px solid rgba(255,255,255,.10);border-radius:50%;background:rgba(0,0,0,.12);box-shadow:inset 0 1px 0 rgba(255,255,255,.025),0 3px 9px rgba(0,0,0,.2);color:rgba(255,255,255,.82);cursor:pointer;transition:transform .14s,background .14s,color .14s}
    .tss-pip-control:hover{transform:translateY(-1px);background:rgba(255,255,255,.13);color:#fff}
    .tss-pip-control:active{transform:scale(.96)}
    .tss-pip-control-primary{width:52px;height:52px;background:color-mix(in srgb,var(--accent) 80%,transparent);border-color:color-mix(in srgb,var(--accent),white 18%);color:#101522;box-shadow:0 8px 21px color-mix(in srgb,var(--accent),transparent 72%)}
    .tss-pip-control-primary:hover{background:color-mix(in srgb,var(--accent) 90%,transparent);color:#101522}
    .tss-pip-control svg{width:15px!important;height:15px!important}
    .tss-pip-control-primary svg{width:17px!important;height:17px!important}
    .tss-pip-up-next{border-top:1px solid rgba(255,255,255,.08);padding-top:9px}
    .tss-pip-kicker{font-size:9px;font-weight:790;letter-spacing:.16em;text-transform:uppercase;color:rgba(255,255,255,.82)}
    .tss-pip-next-row{display:grid;grid-template-columns:39px minmax(0,1fr) auto 28px;align-items:center;gap:9px;margin-top:7px;min-height:39px}
    .tss-pip-next-art{width:39px;height:39px;border-radius:7px;overflow:hidden;position:relative;background:rgba(255,255,255,.035);box-shadow:0 0 0 1px rgba(255,255,255,.07)}
    .tss-pip-next-art img{display:block;width:100%;height:100%;object-fit:cover}
    .tss-pip-next-art img[hidden],.tss-pip-next-art .tss-pip-art-fallback[hidden]{display:none}
    .tss-pip-next-title{font-size:11px;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .tss-pip-next-artist{margin-top:4px;color:rgba(255,255,255,.38);font-size:9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .tss-pip-next-number{color:rgba(255,255,255,.48);font-size:11px;font-variant-numeric:tabular-nums}
    button:focus-visible,#tss-pip-waveform:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
    .tss-pip-queue-head{display:flex;align-items:center;justify-content:space-between;padding:7px 1px 6px;border-top:1px solid rgba(255,255,255,.08)}
    .tss-pip-queue-count{color:rgba(255,255,255,.34);font-size:9px;font-variant-numeric:tabular-nums}
    .tss-pip-queue-tools{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;gap:8px;padding-bottom:7px;border-bottom:1px solid rgba(255,255,255,.06)}
    .tss-pip-tabs{display:flex;align-items:center;padding:2px;border-radius:7px;background:var(--pip-glass-inset)}.tss-pip-tab{height:25px;padding:0 8px;border:0;border-radius:5px;background:transparent;color:rgba(255,255,255,.72);font-size:8px;font-weight:720;letter-spacing:.07em;text-transform:uppercase;cursor:pointer}.tss-pip-tab[aria-selected="true"]{background:rgba(174,186,243,.12);color:#fff}
    .tss-pip-search-wrap{position:relative;min-width:0}.tss-pip-search-wrap svg{position:absolute;left:8px;top:50%;width:10px!important;height:10px!important;transform:translateY(-50%);color:rgba(255,255,255,.25);pointer-events:none}.tss-pip-queue-search{width:100%;height:29px;padding:0 9px 0 25px;border:1px solid rgba(204,218,255,.10);border-radius:7px;background:var(--pip-glass-inset);color:#fff;font:500 9px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;outline:0}.tss-pip-queue-search::placeholder{color:rgba(255,255,255,.22)}.tss-pip-queue-search:focus{border-color:color-mix(in srgb,var(--accent),transparent 35%)}
    .tss-pip-queue-list{min-height:0;overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.18) transparent}
    .tss-pip-queue-list::-webkit-scrollbar{width:5px}.tss-pip-queue-list::-webkit-scrollbar-track{background:transparent}.tss-pip-queue-list::-webkit-scrollbar-thumb{background:rgba(255,255,255,.16);border-radius:9px}
    .tss-pip-queue-row{width:100%;min-height:49px;padding:5px 3px 5px 6px;display:grid;grid-template-columns:36px minmax(0,1fr) auto 28px;align-items:center;gap:8px;border:0;border-bottom:1px solid rgba(255,255,255,.055);background:transparent;color:#fff;text-align:left;transition:background .14s,opacity .18s,transform .22s cubic-bezier(.22,1,.36,1)}
    .tss-pip-queue-row[data-playable="true"]{cursor:pointer}
    .tss-pip-queue-row:hover{background:rgba(255,255,255,.045)}
    .tss-pip-queue-row[data-current="true"]{background:color-mix(in srgb,var(--accent),transparent 92%);box-shadow:inset 2px 0 var(--accent);cursor:default}
    .tss-pip-queue-art{width:36px;height:36px;border-radius:7px;overflow:hidden;background:rgba(255,255,255,.035);display:flex;align-items:center;justify-content:center;color:rgba(255,255,255,.24)}
    .tss-pip-queue-art img{display:block;width:100%;height:100%;object-fit:cover}
    .tss-pip-queue-copy{display:block;min-width:0}.tss-pip-queue-title{display:block;font-size:10px;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.tss-pip-queue-artist{display:block;margin-top:3px;color:rgba(255,255,255,.35);font-size:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .tss-pip-queue-number{color:rgba(255,255,255,.34);font-size:9px;font-variant-numeric:tabular-nums}
    .tss-pip-queue-row[data-current="true"] .tss-pip-queue-number{color:var(--accent)}
    .tss-pip-queue-empty{padding:34px 12px;text-align:center;color:rgba(255,255,255,.25);font-size:10px}
    .tss-pip-track-settings{width:28px;height:28px;padding:0;display:flex;align-items:center;justify-content:center;border:0;border-radius:7px;background:transparent;color:rgba(255,255,255,.35);cursor:pointer}
    .tss-pip-track-settings:hover,.tss-pip-track-settings[aria-expanded="true"]{background:rgba(255,255,255,.07);color:#fff}.tss-pip-track-settings:disabled{opacity:.22;cursor:default;background:transparent;color:rgba(255,255,255,.25)}
    .tss-pip-track-menu{position:absolute;z-index:20;width:210px;padding:9px;border:1px solid var(--pip-glass-rim);border-radius:12px;background:var(--pip-menu-surface);box-shadow:var(--pip-glass-shadow);animation:tssPipMenuIn .16s cubic-bezier(.22,1,.36,1)}
    .tss-pip-menu-title{display:flex;align-items:center;gap:8px;padding:2px 2px 9px;color:rgba(255,255,255,.78);font-size:10px;font-weight:680;border-bottom:1px solid rgba(255,255,255,.07)}
    .tss-pip-menu-title span{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.tss-pip-menu-title button{width:24px;height:24px;padding:0;display:flex;align-items:center;justify-content:center;border:0;border-radius:6px;background:transparent;color:rgba(255,255,255,.42);cursor:pointer}.tss-pip-menu-title button:hover{background:rgba(255,255,255,.07);color:#fff}
    .tss-pip-menu-actions{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:8px}.tss-pip-menu-actions button,.tss-pip-menu-remove{height:30px;border:1px solid rgba(255,255,255,.09);border-radius:7px;background:var(--pip-glass-inset);color:rgba(255,255,255,.78);font-size:9px;font-weight:650;cursor:pointer}.tss-pip-menu-actions button:hover{border-color:color-mix(in srgb,var(--accent),transparent 45%);color:#fff}.tss-pip-menu-actions button:disabled,.tss-pip-menu-remove:disabled{opacity:.28;cursor:default}
    .tss-pip-menu-label{margin:10px 2px 6px;color:rgba(255,255,255,.34);font-size:8px;font-weight:720;letter-spacing:.1em;text-transform:uppercase}.tss-pip-priority{display:grid;grid-template-columns:repeat(3,1fr);padding:2px;border-radius:8px;background:rgba(255,255,255,.04)}.tss-pip-priority button{height:27px;border:0;border-radius:6px;background:transparent;color:rgba(255,255,255,.35);font-size:8px;font-weight:700;cursor:pointer}.tss-pip-priority button[aria-pressed="true"]{background:color-mix(in srgb,var(--accent) 72%,transparent);color:#101522;box-shadow:0 3px 10px color-mix(in srgb,var(--accent),transparent 68%)}
    .tss-pip-menu-remove{width:100%;margin-top:8px;background:rgba(255,74,74,.055);border-color:rgba(255,74,74,.12);color:#d87878}.tss-pip-menu-remove:not(:disabled):hover{background:rgba(255,74,74,.11);color:#ff9292}
    .tss-pip-sound-menu{position:absolute;z-index:19;inset:48px 12px 12px;padding:12px;overflow-y:auto;overscroll-behavior:contain;border:1px solid var(--pip-glass-rim);border-radius:13px;background:var(--pip-menu-surface);box-shadow:var(--pip-glass-shadow);animation:tssPipMenuIn .18s cubic-bezier(.22,1,.36,1);scrollbar-width:thin}
    .tss-pip-sound-head{display:flex;align-items:center;justify-content:space-between;padding-bottom:10px;border-bottom:1px solid rgba(255,255,255,.07)}.tss-pip-sound-head>div{display:flex;flex-direction:column;gap:2px}.tss-pip-sound-head span{font-size:11px;font-weight:720}.tss-pip-sound-head small{color:rgba(255,255,255,.3);font-size:8px}.tss-pip-sound-head button,.tss-pip-mini-icon{display:flex;align-items:center;justify-content:center;border:0;background:transparent;color:rgba(255,255,255,.45);cursor:pointer}.tss-pip-sound-head button{width:26px;height:26px;border-radius:6px}.tss-pip-sound-head button:hover,.tss-pip-mini-icon:hover{background:rgba(255,255,255,.07);color:#fff}
    .tss-pip-setting-row{display:flex;align-items:center;gap:9px;padding:11px 0}.tss-pip-mini-icon{width:28px;height:28px;border-radius:7px}.tss-pip-setting-row output,.tss-pip-setting-label output{color:rgba(255,255,255,.4);font-size:8px;font-variant-numeric:tabular-nums}.tss-pip-setting-row output{width:30px;text-align:right}
    .tss-pip-sound-menu input[type="range"]{--fill:0%;width:100%;height:3px;margin:0;appearance:none;border:0;border-radius:3px;background:linear-gradient(90deg,var(--accent) var(--fill),rgba(114,130,165,.18) var(--fill));box-shadow:inset 0 1px 2px rgba(3,4,10,.3);cursor:pointer}.tss-pip-sound-menu input[type="range"]::-webkit-slider-thumb{width:12px;height:12px;appearance:none;border:2px solid #fff;border-radius:50%;background:var(--accent);box-shadow:0 2px 7px rgba(0,0,0,.5)}.tss-pip-sound-menu input[type="range"]::-moz-range-thumb{width:9px;height:9px;border:2px solid #fff;border-radius:50%;background:var(--accent)}
    .tss-pip-setting-block{padding:10px 0;border-top:1px solid rgba(255,255,255,.06)}.tss-pip-setting-label{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;color:rgba(255,255,255,.78);font-size:9px;font-weight:650}.tss-pip-segments{display:grid;grid-template-columns:repeat(3,1fr);gap:3px;margin-top:10px;padding:2px;border-radius:7px;background:rgba(0,0,0,.04)}.tss-pip-segments button{height:25px;border:0;border-radius:5px;background:transparent;color:rgba(255,255,255,.72);font-size:8px;font-weight:680;text-transform:capitalize;cursor:pointer}.tss-pip-segments button[aria-pressed="true"]{background:rgba(174,186,243,.12);box-shadow:inset 0 1px 0 rgba(255,255,255,.025);color:#fff}
    .tss-pip-setting-grid{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:8px}.tss-pip-setting-toggle,.tss-pip-check-row,.tss-pip-select-row{min-height:34px;border:1px solid rgba(255,255,255,.075);border-radius:8px;background:var(--pip-glass-inset);box-shadow:inset 0 1px 0 rgba(255,255,255,.025);color:rgba(255,255,255,.78);font-size:8px;font-weight:620}.tss-pip-setting-toggle{padding:0 9px;display:flex;align-items:center;justify-content:space-between;cursor:pointer}.tss-pip-setting-toggle i{width:24px;height:14px;padding:2px;border-radius:10px;background:rgba(0,0,0,.12);box-shadow:inset 0 1px 3px rgba(0,0,0,.12)}.tss-pip-setting-toggle i::after{content:'';display:block;width:10px;height:10px;border-radius:50%;background:rgba(255,255,255,.78);transition:transform .15s}.tss-pip-setting-toggle[aria-pressed="true"]{color:#fff;border-color:color-mix(in srgb,var(--accent),transparent 68%)}.tss-pip-setting-toggle[aria-pressed="true"] i{background:var(--accent)}.tss-pip-setting-toggle[aria-pressed="true"] i::after{transform:translateX(10px);background:#fff}
    .tss-pip-select-row{margin-top:8px;padding:0 8px;display:flex;align-items:center;justify-content:space-between;gap:6px}.tss-pip-select-row select{max-width:58%;border:0;background:transparent;color:rgba(255,255,255,.78);font:inherit;outline:0;text-align:right}.tss-pip-select-row option{background:#101113}.tss-pip-sleep-row{margin-top:0}.tss-pip-check-row{padding:0 8px;display:flex;align-items:center;gap:6px}.tss-pip-check-row input{accent-color:var(--accent)}.tss-pip-full-eq{width:100%;height:31px;margin-top:8px;border:1px solid rgba(255,255,255,.07);border-radius:8px;background:transparent;color:rgba(255,255,255,.72);font-size:8px;font-weight:650;cursor:pointer}.tss-pip-full-eq:hover{background:rgba(255,255,255,.04);color:#fff}
    .tss-pip-stage[data-view="queue"] .tss-pip-queue-row{animation:tssPipRowIn .26s both cubic-bezier(.22,1,.36,1);animation-delay:calc(var(--row-index) * 18ms)}
    @keyframes tssPipMarquee{0%,15%{transform:translateX(0)}85%,100%{transform:translateX(var(--tss-pip-marquee-distance,0))}}
    @keyframes tssPipRowIn{from{opacity:0;transform:translateX(12px)}to{opacity:1;transform:translateX(0)}}@keyframes tssPipMenuIn{from{opacity:0;transform:translateY(-4px) scale(.98)}to{opacity:1;transform:none}}
    @media(prefers-reduced-motion:reduce){.tss-pip-view,.tss-pip-queue-row,.tss-pip-track-menu,.tss-pip-title-text{transition:none!important;animation:none!important}.tss-pip-title{overflow:hidden;text-overflow:ellipsis}}
    :root[data-tss-reduce-visual-effects="true"]{--pip-menu-surface:var(--pip-glass-surface)}
    :root[data-tss-reduce-visual-effects="true"] *, :root[data-tss-reduce-visual-effects="true"] *::before, :root[data-tss-reduce-visual-effects="true"] *::after{transition:none!important;animation:none!important;scroll-behavior:auto!important;-webkit-backdrop-filter:none!important;backdrop-filter:none!important}
    :root[data-tss-reduce-visual-effects="true"] .tss-pip-control{transform:none!important}
    @media(prefers-reduced-motion:no-preference){:root[data-tss-reduce-visual-effects="true"] .tss-pip-stage[data-view="player"] .tss-pip-title[data-overflow="true"] .tss-pip-title-text{animation:tssPipMarquee var(--tss-pip-marquee-duration,9s) ease-in-out infinite alternate!important}}
    @media(max-width:420px){.tss-pip-brand{display:none}.tss-pip-header{gap:6px}.tss-pip-state{max-width:58px}.tss-pip-live span{display:none}.tss-pip-track{grid-template-columns:88px minmax(0,1fr);min-height:88px}}
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
        <button id="tss-pip-artwork-toggle" class="tss-pip-view-toggle" type="button" aria-label="Use full artwork layout" aria-pressed="false" title="Use full artwork layout">${SVG.artwork}</button>
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
        <div class="tss-pip-track-copy" style="min-width:0">
          <div id="tss-pip-title" class="tss-pip-title"><span id="tss-pip-title-text" class="tss-pip-title-text">—</span></div>
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
  const artworkToggle = pipDocument.getElementById('tss-pip-artwork-toggle');
  artworkToggle.onclick = () => {
    setOwnPipArtworkMode(nextOwnPipArtworkMode(), pipDocument);
    const artwork = pipDocument.getElementById('tss-pip-artwork');
    if (artwork) artwork.dataset.src = '';
    syncOwnPipWindow();
  };
  const viewToggle = pipDocument.getElementById('tss-pip-view-toggle');
  viewToggle.onclick = () => {
    state._pipTrackMenuClose?.();
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
    if (showQueue) {
      const list = pipDocument.getElementById('tss-pip-queue-list');
      if (list) delete list.dataset.key;
      renderOwnPipQueue(pipDocument, Number.isInteger(state._deckTrack) ? state._deckTrack : state.queue[state.pos]);
    }
    syncOwnPipMarquee(pipDocument.getElementById('tss-pip-title'), pipDocument.getElementById('tss-pip-title-text'));
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
  pipWindow.addEventListener('resize', syncOwnPipWindow);
  if (mode === 'document') pipWindow.addEventListener('pagehide', onPageHide, { once: true });

  applyVisualEffects(pipDocument);
  setOwnPipArtworkMode(state.pipArtworkMode, pipDocument);
  setOwnPipButtonState();
  syncOwnPipWindow();
  return true;
}

function installBetterFeedPipBridge() {
  const player = pageWindow.scPlayer;
  if (!player || typeof player !== 'object') return false;
  const samePlayer = state._pipBridgePlayer === player;

  const methodNames = [
    'getCurrentSound', 'getCurrentQueueItem', 'isPlaying', 'toggleCurrent',
    'playNext', 'playPrev', 'seekCurrentTo', 'seekCurrentBy',
  ];
  const originals = {};
  const descriptors = {};
  try {
    if (samePlayer && state._pipBridgeWrappers
        && methodNames.every(name => player[name] === state._pipBridgeWrappers[name])) return true;
    for (const name of methodNames) {
      const descriptor = Object.getOwnPropertyDescriptor(player, name);
      if (descriptor ? !('value' in descriptor) || !descriptor.writable : !Object.isExtensible(player)) return false;
      descriptors[name] = descriptor;
      originals[name] = samePlayer && player[name] === state._pipBridgeWrappers?.[name]
        ? state._pipBridgeOriginals[name] : player[name];
    }
  } catch (_) { return false; }
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

  const patched = {};
  const installed = [];
  try {
    patched.getCurrentSound = (...args) => betterFeedPipActive()
      ? betterFeedPipSound()
      : callOriginal('getCurrentSound', args);
    patched.getCurrentQueueItem = (...args) => betterFeedPipActive()
      ? null
      : callOriginal('getCurrentQueueItem', args);
    patched.isPlaying = (...args) => betterFeedPipActive()
      ? !currentDeckAudio().paused
      : callOriginal('isPlaying', args);
    patched.toggleCurrent = (...args) => {
      if (!betterFeedPipActive()) return callOriginal('toggleCurrent', args);
      void toggle();
    };
    patched.playNext = (...args) => {
      if (!betterFeedPipActive()) return callOriginal('playNext', args);
      state.manualAction = true;
      state._manualActionAt = Date.now();
      void next();
    };
    patched.playPrev = (...args) => {
      if (!betterFeedPipActive()) return callOriginal('playPrev', args);
      void prevTrack();
    };
    patched.seekCurrentTo = (callback, ...args) => {
      if (!betterFeedPipActive()) return callOriginal('seekCurrentTo', [callback, ...args]);
      seekDeck(callback, false);
    };
    patched.seekCurrentBy = (callback, ...args) => {
      if (!betterFeedPipActive()) return callOriginal('seekCurrentBy', [callback, ...args]);
      seekDeck(callback, true);
    };
    for (const name of methodNames) {
      Object.defineProperty(player, name, descriptors[name]
        ? { ...descriptors[name], value: patched[name] }
        : { value: patched[name], writable: true, enumerable: true, configurable: true });
      installed.push(name);
    }
  } catch (_) {
    for (const name of installed.reverse()) {
      try {
        if (descriptors[name]) Object.defineProperty(player, name, descriptors[name]);
        else delete player[name];
      } catch (_) {}
    }
    return false;
  }

  state._pipBridgePlayer = player;
  state._pipBridgeOriginals = originals;
  state._pipBridgeWrappers = patched;
  return true;
}

function ensureCrossfadeDecks() {
  if (state._decks.length === 2 && state._decks.every(Boolean)) {
    state._deckHlsPlayers ||= [null, null];
    if (state._transitionDiagnostics) state._decks.forEach(observeTransitionMedia);
    state._deckHlsFailed ||= [false, false];
    return state._decks;
  }
  state._decks = [0, 1].map(index => {
    const audio = document.createElement('audio');
    audio.id = `tss-crossfade-deck-${index + 1}`;
    audio.preload = 'auto';
    audio.playsInline = true;
    audio.crossOrigin = 'anonymous';
    audio.dataset.tssCrossfadeDeck = String(index);
    audio.style.display = 'none';
    document.body.appendChild(audio);
    if (state._transitionDiagnostics) observeTransitionMedia(audio, index);
    return audio;
  });
  state._deckHlsPlayers = [null, null];
  state._deckHlsFailed = [false, false];
  state._deckTracks = [null, null];
  state._deckGains = [0, 0];
  return state._decks;
}

function autoLevelTrackKey(ti) {
  const meta = state.meta[ti];
  const identity = trackId(meta) || normalizeTrackUrl(meta?.link) || '';
  const equalizer = state.eqEnabled ? state.eqBands.join(',') : '0,0,0,0,0';
  return identity ? JSON.stringify([identity, equalizer]) : '';
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
  // Chromium can underreport analyser RMS; cap boosts to respect master volume.
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
    try { safeStorage.setItem('tss_auto_level_cache_v4', JSON.stringify(state._autoLevelCache)); } catch (_) {}
  }, 800);
}

let equalizerPersistTimer = null;
let customPresetsPending = false;

function flushEqualizerPersistence() {
  clearTimeout(equalizerPersistTimer);
  equalizerPersistTimer = null;
  const customPresets = sanitizeCustomEqPresets(state.customEqPresets);
  state.customEqPresets = customPresets;
  const mirrorSaved = safeStorage.setItem('tss_eq_custom_presets', JSON.stringify(customPresets));
  if (customPresetsPending) {
    let saved = false;
    try {
      if (typeof GM_setValue === 'function') {
        GM_setValue(CUSTOM_EQ_PRESETS_KEY, customPresets);
        saved = true;
      } else if (typeof GM_getValue !== 'function') {
        saved = mirrorSaved;
      }
    } catch (_) {}
    customPresetsPending = !saved;
    state._equalizerSaveFailed = !saved;
  }
  safeStorage.setItem('tss_eq_enabled', String(state.eqEnabled));
  safeStorage.setItem('tss_eq_bands', JSON.stringify(state.eqBands));
  safeStorage.setItem('tss_eq_preset', state.eqPreset);
  updateEqualizerPersistenceStatus();
  return !customPresetsPending;
}

function updateEqualizerPersistenceStatus() {
  const overlay = document.getElementById('tss-eq-overlay');
  const error = overlay?.querySelector('#tss-eq-save-error');
  if (!error) return;
  if (state._equalizerSaveFailed) {
    overlay.querySelector('#tss-eq-save-row').dataset.open = 'true';
    error.textContent = 'Preset changes are unsaved. Try again before leaving this page.';
    error.dataset.persistence = 'true';
  } else if (error.dataset.persistence === 'true') {
    error.textContent = '';
    delete error.dataset.persistence;
  }
}

function persistEqualizer({ customPresets = false, immediate = false } = {}) {
  customPresetsPending = customPresetsPending || customPresets;
  clearTimeout(equalizerPersistTimer);
  if (immediate) {
    return flushEqualizerPersistence();
  } else {
    equalizerPersistTimer = setTimeout(flushEqualizerPersistence, 220);
  }
}

function syncEqualizer() {
  const now = state._audioContext?.currentTime || 0;
  state._deckAudioGraphs.forEach((graph, deckIndex) => {
    if (!graph?.eqFilters) return;
    graph.eqFilters.forEach((filter, index) => {
      const value = state.eqEnabled ? state.eqBands[index] : 0;
      filter.gain.setTargetAtTime(value, now, 0.025);
    });
    const ti = state._deckTracks[deckIndex];
    if (Number.isInteger(ti) && graph.trackKey !== autoLevelTrackKey(ti)) {
      applyCachedAutoLevel(deckIndex, ti);
    }
  });
  syncDeckProcessingRouting();

  const button = document.getElementById('tss-hub-eq');
  if (button) {
    button.dataset.active = String(state.eqEnabled);
    button.setAttribute('aria-pressed', String(state.eqEnabled));
    button.title = state.eqEnabled ? 'Equalizer on' : 'Equalizer off';
  }
}

function retireAudioGraph() {
  const context = state._audioContext;
  state._crossfadeToken++;
  state._crossfadePrefetchToken++;
  destroyCrossfadePreflight(state._crossfadeStreamWarmup);
  state._crossfadeStreamWarmup?.controller?.abort();
  state._deckPrepareTokens = state._deckPrepareTokens.map(token => token + 1);
  for (const controller of state._deckPrepareAborts || []) {
    try { controller?.abort(); } catch (_) {}
  }
  try { state._crossfadeSchedule?.resolve?.(false); } catch (_) {}
  state._crossfadeSchedule = null;
  state._crossfading = false;
  state._crossfadePending = false;
  for (const graph of state._deckAudioGraphs) {
    if (!graph) continue;
    for (const node of [graph.source, ...graph.eqFilters, graph.analyser, graph.autoGain, graph.mixGain]) {
      try { node?.disconnect(); } catch (_) {}
    }
  }
  for (const hls of state._deckHlsPlayers || []) {
    try { hls?.destroy?.(); } catch (_) {}
  }
  state._deckHlsPlayers = [null, null];
  for (const audio of state._decks) {
    try { audio.pause(); } catch (_) {}
    try { audio.removeAttribute('src'); audio.load(); } catch (_) {}
    try { audio.remove(); } catch (_) {}
  }
  state._decks = [];
  state._deckAudioGraphs = [null, null];
  state._deckTracks = [null, null];
  state._deckGains = [0, 0];
  state._deckIndex = -1;
  state._deckTrack = null;
  state._audioContext = null;
  state._audioMaster = null;
  state._audioClipper = null;
  state._appliedMasterGain = null;
  state._audioGraphFailed = false;
  try { void Promise.resolve(context?.close()).catch(() => {}); } catch (_) {}
}

function ensureAutoLevelAudioGraph() {
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext
    || pageWindow.AudioContext || pageWindow.webkitAudioContext;
  if (state._audioContext?.state === 'closed' || state._audioGraphFailed) retireAudioGraph();
  let context = state._audioContext;
  const created = !context;
  let published = Boolean(context);
  let phase = 'select-audio-context';
  let failedDeckIndex = null;
  if (!AudioContextCtor) {
    recordPlaybackDiagnostic('audio-graph-failed', {
      phase: 'constructor-unavailable',
      reason: 'audio-context-unavailable',
      contextState: 'missing',
      deckCount: state._decks.length,
    });
    return false;
  }
  const decks = ensureCrossfadeDecks();
  try {
    if (!context) {
      phase = 'create-context';
      context = new AudioContextCtor();
      phase = 'create-master-nodes';
      const master = context.createGain();
      const clipper = context.createWaveShaper();
      master.gain.value = state.playbackVolume;
      // Identity inside full scale, clipping only overs: no compressor envelope.
      clipper.curve = new Float32Array([-1, 1]);
      clipper.oversample = '4x';
      phase = 'connect-master-routing';
      master.connect(state.safetyClipper ? clipper : context.destination);
      clipper.connect(context.destination);
      phase = 'allocate-deck-processing-nodes';
      const graphs = decks.map((audio, index) => {
        failedDeckIndex = index;
        const eqFilters = EQ_BANDS.map((band, bandIndex) => {
          const filter = context.createBiquadFilter();
          filter.type = band.type;
          filter.frequency.value = band.frequency;
          filter.Q.value = band.q;
          filter.gain.value = state.eqEnabled ? state.eqBands[bandIndex] : 0;
          return filter;
        });
        const analyser = context.createAnalyser();
        const autoGain = context.createGain();
        const mixGain = context.createGain();
        analyser.fftSize = 2048;
        analyser.smoothingTimeConstant = 0.72;
        autoGain.gain.value = 1;
        mixGain.gain.value = state._deckGains[index] || 0;
        mixGain.connect(master);
        return {
          source: null, eqFilters, analyser, autoGain, mixGain,
          buffer: new Float32Array(analyser.fftSize),
          smoothedRms: 0, peakRms: 0, measuredPeak: 0, currentGain: 1,
          samples: 0, settled: false, trackKey: '',
          appliedAutoGain: 1, appliedMixGain: state._deckGains[index] || 0,
          autoGainMaster: null,
        };
      });
      state._audioContext = context;
      state._audioMaster = master;
      state._audioClipper = clipper;
      state._deckAudioGraphs = graphs;
      published = true;
      phase = 'bind-media-element-source';
      decks.forEach((audio, index) => {
        failedDeckIndex = index;
        graphs[index].source = context.createMediaElementSource(audio);
        audio.volume = 1;
      });
    }
    phase = 'apply-processing-routing';
    syncEqualizer();
    if (context.state === 'suspended' && !state._userPaused) void resumeAudioGraph();
    if (created) {
      recordPlaybackDiagnostic('audio-graph-ready', {
        phase: 'ready',
        contextState: context.state,
        sampleRate: Number(context.sampleRate) || 0,
        deckCount: decks.length,
        sourceNodeConnected: true,
      });
    }
    return true;
  } catch (error) {
    recordPlaybackDiagnostic('audio-graph-failed', {
      phase,
      deckIndex: failedDeckIndex,
      errorName: playbackErrorName(error),
      contextState: context?.state || 'missing',
      sourceBound: published,
    });
    if (published) retireAudioGraph();
    else {
      // Native output is still intact because neither media element was bound.
      try { void Promise.resolve(context?.close()).catch(() => {}); } catch (_) {}
    }
    return false;
  }
}

function syncDeckProcessingRouting() {
  state._deckAudioGraphs.forEach(graph => {
    if (!graph) return;
    // Each new graph starts unrouted; EQ band targets are applied separately.
    if (graph.routedEq === state.eqEnabled && graph.routedAutoLevel === state.autoLevel) return;
    for (const node of [graph.source, ...graph.eqFilters, graph.analyser, graph.autoGain]) {
      try { node.disconnect(); } catch (_) {}
    }

    if (!state.eqEnabled && !state.autoLevel) {
      graph.source.connect(graph.mixGain);
      setAudioParamImmediately(graph.autoGain.gain, 1, state._audioContext.currentTime);
      graph.routedEq = state.eqEnabled;
      graph.routedAutoLevel = state.autoLevel;
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
    graph.routedEq = state.eqEnabled;
    graph.routedAutoLevel = state.autoLevel;
  });
}

function syncSafetyClipper() {
  if (!state._audioMaster || !state._audioContext) return;
  try {
    state._audioMaster.disconnect();
    state._audioMaster.connect(state.safetyClipper ? state._audioClipper : state._audioContext.destination);
  } catch (_) {}
}

async function resumeAudioGraph(signal = state._playbackAbort?.signal, diagnosticTrace = null) {
  const context = state._audioContext;
  const fail = (reason, error = null, contextStateBefore = context?.state || 'missing') => {
    const errorName = error ? playbackErrorName(error) : '';
    if (diagnosticTrace) {
      diagnosticTrace.stage = 'audio-context-resume';
      diagnosticTrace.reason = reason;
      diagnosticTrace.audioGraphPhase = 'resume';
      diagnosticTrace.audioGraphReason = reason;
      if (errorName) diagnosticTrace.errorName = errorName;
    }
    if (!signal?.aborted && !state._userPaused) {
      recordPlaybackDiagnostic('audio-context-resume-failed', {
        attemptId: diagnosticTrace?.attemptId,
        reason,
        errorName,
        contextStateBefore,
        contextStateAfter: context?.state || 'missing',
        audioGraphFailed: Boolean(state._audioGraphFailed),
      });
    }
    return false;
  };
  if (signal?.aborted || state._userPaused) return false;
  if (state._audioGraphFailed) return fail('graph-marked-failed');
  if (!context || context.state === 'running') return true;
  if (context.state === 'closed') return fail('context-closed');
  const contextStateBefore = context.state;
  const startedAt = typeof performance !== 'undefined' ? performance.now() : 0;
  if (diagnosticTrace) {
    diagnosticTrace.stage = 'audio-context-resume';
    diagnosticTrace.reason = 'resume-pending';
    diagnosticTrace.audioGraphPhase = 'resume';
  }
  try {
    await withDeadline(() => context.resume(), 5000, signal);
    const current = !signal?.aborted && state._audioContext === context;
    if (!current || state._userPaused) return false;
    if (context.state !== 'running') {
      state._audioGraphFailed = true;
      return fail('context-not-running', null, contextStateBefore);
    }
    if (diagnosticTrace) {
      diagnosticTrace.reason = 'audio-context-resumed';
      diagnosticTrace.audioGraphReason = 'resumed';
    }
    recordPlaybackDiagnostic('audio-context-resumed', {
      attemptId: diagnosticTrace?.attemptId,
      contextStateBefore,
      contextStateAfter: context.state,
      sampleRate: Number(context.sampleRate) || 0,
      elapsedMs: typeof performance !== 'undefined'
        ? Math.max(0, Math.round(performance.now() - startedAt)) : 0,
    });
    return true;
  } catch (error) {
    if (signal?.aborted || state._userPaused) return false;
    if (state._audioContext === context) state._audioGraphFailed = true;
    const reason = error?.name === 'TimeoutError' ? 'resume-timeout' : 'resume-rejected';
    return fail(reason, error, contextStateBefore);
  }
}

async function suspendAudioGraph(signal = state._playbackAbort?.signal) {
  const context = state._audioContext;
  const fail = (reason, error = null, contextStateBefore = context?.state || 'missing') => {
    if (!signal?.aborted) {
      recordPlaybackDiagnostic('audio-context-suspend-failed', {
        reason,
        errorName: error ? playbackErrorName(error) : '',
        contextStateBefore,
        contextStateAfter: context?.state || 'missing',
      });
    }
    return false;
  };
  if (signal?.aborted) return false;
  if (!context || context.state === 'suspended') return true;
  if (context.state === 'closed') return fail('context-closed');
  const contextStateBefore = context.state;
  const startedAt = typeof performance !== 'undefined' ? performance.now() : 0;
  try {
    await withDeadline(() => context.suspend(), 5000, signal);
    const current = !signal?.aborted && state._audioContext === context;
    if (!current) return false;
    if (context.state !== 'suspended') {
      state._audioGraphFailed = true;
      return fail('context-not-suspended', null, contextStateBefore);
    }
    recordPlaybackDiagnostic('audio-context-suspended', {
      contextStateBefore,
      contextStateAfter: context.state,
      elapsedMs: typeof performance !== 'undefined'
        ? Math.max(0, Math.round(performance.now() - startedAt)) : 0,
    });
    return true;
  } catch (error) {
    if (signal?.aborted) return false;
    if (state._audioContext === context) state._audioGraphFailed = true;
    return fail(error?.name === 'TimeoutError' ? 'suspend-timeout' : 'suspend-rejected',
      error, contextStateBefore);
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
  const cachedModel = state._soundCloudVolumeModel;
  if (cachedModel) {
    try {
      if (typeof cachedModel.getVolume === 'function' && typeof cachedModel.getMuted === 'function'
          && typeof cachedModel.setVolumeAndMuted === 'function') return cachedModel;
    } catch (_) {}
    state._soundCloudVolumeModel = null;
    return null;
  }
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
    try {
      const value = model.getMuted() ? 0 : Number(model.getVolume());
      if (Number.isFinite(value)) return Math.max(0, Math.min(1, value));
    } catch (_) {}
    state._soundCloudVolumeModel = null;
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
    try {
      model.setVolumeAndMuted({ volume: level, muted: level === 0 });
      state._lastSoundCloudVolume = level;
      return true;
    } catch (_) {
      state._soundCloudVolumeModel = null;
    }
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
  try { safeStorage.setItem('tss_playback_volume', String(nativeVolume)); } catch (_) {}
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
  try { safeStorage.setItem('tss_playback_volume', String(nativeVolume)); } catch (_) {}
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
      if (audio.volume !== 1) audio.volume = 1;
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
      const volume = Math.max(0, Math.min(1, master * gain));
      if (audio.volume !== volume) audio.volume = volume;
    }
  });
}

function syncPlaybackVolumeControls() {
  const percent = Math.round(state.playbackVolume * 100);
  const slider = document.getElementById('tss-hub-volume');
  const readout = document.getElementById('tss-hub-volume-value');
  if (slider) {
    if (slider.value !== String(percent)) slider.value = String(percent);
    const fill = `${percent}%`;
    if (slider.style.getPropertyValue('--tss-volume-fill') !== fill) slider.style.setProperty('--tss-volume-fill', fill);
  }
  const text = `${percent}%`;
  if (readout && readout.textContent !== text) readout.textContent = text;
  const auto = document.getElementById('tss-auto-level');
  if (auto) {
    const active = String(state.autoLevel);
    if (auto.dataset.active !== active) auto.dataset.active = active;
    if (auto.getAttribute('aria-pressed') !== active) auto.setAttribute('aria-pressed', active);
    const label = auto.querySelector('.tss-auto-label');
    const labelText = state.autoLevel ? 'On' : 'Off';
    if (label && label.textContent !== labelText) label.textContent = labelText;
    const title = state.autoLevel
      ? 'Auto Level is reducing louder tracks'
      : 'Automatically reduce louder tracks';
    if (auto.title !== title) auto.title = title;
  }
}

function setPlaybackVolume(value) {
  state.playbackVolume = Math.max(0, Math.min(1, Number(value) || 0));
  state._playbackVolumeStored = true;
  state._playbackVolumeInitialized = true;
  safeStorage.setItem('tss_playback_volume', String(state.playbackVolume));
  syncCrossfadeVolume();
  setSoundCloudVolume(state.playbackVolume);
  syncPlaybackVolumeControls();
}

function setAutoLevelEnabled(enabled) {
  const nextValue = Boolean(enabled);
  if (nextValue && !ensureAutoLevelAudioGraph()) {
    state.autoLevel = false;
    safeStorage.setItem('tss_auto_level', 'false');
    syncPlaybackVolumeControls();
    return false;
  }
  state.autoLevel = nextValue;
  safeStorage.setItem('tss_auto_level', String(state.autoLevel));
  if (state.autoLevel && state._audioContext?.state === 'suspended') void resumeAudioGraph();
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
  safeStorage.setItem('tss_crossfade_seconds', String(state.crossfadeSeconds));
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
    fallback: 'custom retry',
  };
  const text = labels[status] || status;
  if (el.textContent !== text) el.textContent = text;
  if (el.dataset.status !== status) el.dataset.status = status;
}

function syncCrossfadeControls() {
  const seconds = Math.max(0, Math.min(12, Math.round(state.crossfadeSeconds)));
  const valueText = seconds > 0 ? `${seconds} sec` : 'off';
  const card = document.getElementById('tss-crossfade-card');
  const enabled = seconds > 0 ? 'true' : 'false';
  if (card && card.dataset.enabled !== enabled) card.dataset.enabled = enabled;

  const slider = document.getElementById('tss-hub-crossfade');
  if (slider) {
    if (slider.value !== String(seconds)) slider.value = String(seconds);
    const fill = `${(seconds / 12) * 100}%`;
    if (slider.style.getPropertyValue('--tss-crossfade-fill') !== fill) slider.style.setProperty('--tss-crossfade-fill', fill);
  }
  const readout = document.getElementById('tss-crossfade-seconds');
  if (readout && readout.textContent !== valueText) readout.textContent = valueText;

  document.querySelectorAll('.tss-crossfade-mode').forEach(button => {
    const active = button.dataset.curve === state.crossfadeCurve;
    const value = active ? 'true' : 'false';
    if (button.dataset.active !== value) button.dataset.active = value;
    if (button.getAttribute('aria-pressed') !== value) button.setAttribute('aria-pressed', value);
  });
  const manual = document.getElementById('tss-crossfade-manual');
  if (manual && manual.checked !== state.crossfadeManual) manual.checked = state.crossfadeManual;

}

function discoverSoundCloudClientId(excluded = new Set()) {
  const rejected = excluded;
  const usable = id => id && !rejected.has(id);
  if (usable(state._clientId)) return state._clientId;
  try {
    const entries = performance.getEntriesByType('resource');
    for (let i = entries.length - 1; i >= 0; i--) {
      try {
        const url = new URL(entries[i].name);
        if (!/^https?:$/.test(url.protocol) || !['api-v2.soundcloud.com', 'api.soundcloud.com'].includes(url.hostname)) continue;
        const id = url.searchParams.get('client_id');
        if (id && /^[A-Za-z0-9_-]+$/.test(id) && usable(id)) {
          state._clientId = id;
          return id;
        }
      } catch (_) {}
    }
  } catch (_) {}
  return '';
}

function syncBrowserNowPlaying() {
  const ti = Number.isInteger(state._deckTrack) ? state._deckTrack : state.queue?.[state.pos];
  const meta = state.active && Number.isInteger(ti) ? state.meta[ti] : null;

  if (!meta?.title) {
    state._ctxMenuClose?.();
    const owner = state._browserMediaOwner;
    state._browserMediaOwner = null;
    if (owner) {
      try {
        const session = owner.session;
        // Native SoundCloud may already have replaced our metadata on Stop.
        if (session.metadata === owner.metadataValue) {
          if (session.playbackState === owner.playbackValue) {
            session.playbackState = owner.playbackBefore === 'playing' ? 'paused' : owner.playbackBefore;
          }
          session.metadata = owner.metadataBefore;
        }
      } catch (_) {}
    }
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
    if (mediaSession && state._browserMediaOwner?.session !== mediaSession) {
      state._browserMediaOwner = {
        session: mediaSession,
        metadataBefore: mediaSession.metadata,
        metadataValue: mediaSession.metadata,
        playbackBefore: mediaSession.playbackState || 'none',
        playbackValue: null,
      };
    }
    const owner = state._browserMediaOwner;
    if (mediaSession && typeof MediaMetadataCtor === 'function'
        && (state._browserMetadataKey !== metadataKey || mediaSession.metadata !== owner.metadataValue)) {
      const init = {
        title: String(meta.title),
        artist,
        album: 'SoundCloud True Shuffle',
      };
      if (meta.artwork) init.artwork = [{ src: meta.artwork }];
      const metadata = new MediaMetadataCtor(init);
      mediaSession.metadata = metadata;
      owner.metadataValue = metadata;
      state._browserMetadataKey = metadataKey;
    }
    if (mediaSession && 'playbackState' in mediaSession) {
      const playbackState = paused() ? 'paused' : 'playing';
      if (mediaSession.playbackState !== playbackState) mediaSession.playbackState = playbackState;
      owner.playbackValue = playbackState;
    }
  } catch (_) {}

  return true;
}

async function discoverSoundCloudClientIdFromBundle(excluded = new Set(), options = {}) {
  const rejected = excluded;
  if (options.signal?.aborted) throw new DOMException('Playback canceled', 'AbortError');
  const existing = options.bundleOnly ? '' : discoverSoundCloudClientId(rejected);
  if (existing) {
    if (options.diagnosticTrace) {
      options.diagnosticTrace.clientIdFound = true;
      options.diagnosticTrace.clientIdSource = 'resource-history';
    }
    return existing;
  }
  const scripts = [...document.scripts]
    .map(script => script.src)
    .filter(src => /a-v2\.sndcdn\.com\/assets\/.+\.js/i.test(src))
    .slice(-8);
  for (const src of scripts) {
    try {
      const response = await fetchSoundCloudResource(src, 'text', {
        ...options, diagnosticStage: 'client-bundle',
      });
      if (options.signal?.aborted) throw new DOMException('Playback canceled', 'AbortError');
      const matches = String(response.data || '').matchAll(/client_id["']?\s*[:=]\s*["']([A-Za-z0-9_-]{20,})["']/g);
      const match = [...matches].find(candidate => !rejected.has(candidate[1]));
      if (match) {
        state._clientId = match[1];
        if (options.diagnosticTrace) {
          options.diagnosticTrace.clientIdFound = true;
          options.diagnosticTrace.clientIdSource = 'bundle';
        }
        return state._clientId;
      }
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      recordPlaybackDiagnostic('client-discovery-failed', { error: playbackErrorName(error) });
    }
  }
  if (options.diagnosticTrace) options.diagnosticTrace.clientIdFound = false;
  return '';
}

async function resolveProgressiveStreams(track, clientId, options = {}) {
  const transcodings = Array.isArray(track?.media?.transcodings)
    ? track.media.transcodings
    : (Array.isArray(track?.transcodings)
      ? track.transcodings.map(item => ({
        url: item?.url,
        format: { protocol: item?.protocol, mime_type: item?.mimeType },
      }))
      : []);
  const progressive = transcodings
    .filter(item => item?.url && item?.format?.protocol === 'progressive')
    .sort((a, b) => {
      const aMpeg = /audio\/(mpeg|mp3)/i.test(a?.format?.mime_type || '') ? 1 : 0;
      const bMpeg = /audio\/(mpeg|mp3)/i.test(b?.format?.mime_type || '') ? 1 : 0;
      return bMpeg - aMpeg;
    });
  const urls = [];
  let authFailed = false;
  const diagnosticTrace = options.diagnosticTrace;
  if (diagnosticTrace) {
    diagnosticTrace.stage = 'stream-resolution';
    diagnosticTrace.progressiveCandidates += progressive.length;
    diagnosticTrace.authorizationPresent ||= Boolean(track.track_authorization || track.trackAuthorization);
  }
  for (const transcoding of progressive) {
    try {
      const endpoint = new URL(transcoding.url);
      endpoint.searchParams.set('client_id', clientId);
      const authorization = track.track_authorization || track.trackAuthorization;
      if (authorization) endpoint.searchParams.set('track_authorization', authorization);
      const response = await fetchSoundCloudResource(endpoint, 'json', {
        ...options, diagnosticStage: 'progressive-stream',
      });
      if (options.signal?.aborted) throw new DOMException('Playback canceled', 'AbortError');
      if (response.status === 401 || response.status === 403) authFailed = true;
      if (!response.ok) continue;
      const stream = response.data;
      const streamUrl = typeof stream?.url === 'string' && stream.url.trim() ? new URL(stream.url) : null;
      if (streamUrl && /^https?:$/.test(streamUrl.protocol) && !urls.includes(streamUrl.href)) {
        urls.push(streamUrl.href);
        if (diagnosticTrace) diagnosticTrace.progressiveUrls++;
      }
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      recordPlaybackDiagnostic('stream-endpoint-failed', { error: playbackErrorName(error) });
    }
  }
  return { urls, authFailed };
}

function hlsJsConstructor() {
  const candidate = pageWindow?.Hls || globalThis.Hls;
  return candidate && typeof candidate.isSupported === 'function'
    && typeof candidate.Events?.ERROR === 'string' ? candidate : null;
}

function isHlsStreamUrl(value) {
  try {
    const segments = new URL(value).pathname.toLowerCase().split('/');
    return segments.some(segment => segment === 'hls' || segment.startsWith('hls_'))
      || segments.at(-1)?.endsWith('.m3u8');
  } catch (_) {
    return false;
  }
}

function isHlsManifestUrl(value) {
  try {
    if (typeof value !== 'string') return false;
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) && url.pathname.toLowerCase().endsWith('.m3u8');
  } catch (_) {
    return false;
  }
}

function directHlsStreamUrls(track) {
  return [
    track?.hls_aac_160_url, track?.hls_aac_96_url,
    track?.streams?.hls_aac_160_url, track?.streams?.hls_aac_96_url,
    track?.media?.streams?.hls_aac_160_url, track?.media?.streams?.hls_aac_96_url,
    track?.media?.hls_aac_160_url, track?.media?.hls_aac_96_url,
  ].filter(isHlsManifestUrl);
}

async function resolveHlsStreamUrls(track, clientId, options = {}) {
  const urls = directHlsStreamUrls(track);
  if (urls.length) return { urls, authFailed: false };
  const transcodings = Array.isArray(track?.media?.transcodings)
    ? track.media.transcodings
    : (Array.isArray(track?.transcodings) ? track.transcodings : []);
  const candidates = [];
  for (const transcoding of transcodings) {
    const protocol = String(transcoding?.format?.protocol || transcoding?.protocol || '').toLowerCase();
    if (!transcoding?.url || (!protocol.includes('hls') && !isHlsStreamUrl(transcoding.url))) continue;
    try {
      const endpoint = new URL(transcoding.url);
      endpoint.searchParams.set('client_id', clientId);
      const authorization = track.track_authorization || track.trackAuthorization;
      if (authorization) endpoint.searchParams.set('track_authorization', authorization);
      const quality = `${transcoding.preset || ''} ${transcoding.quality || ''} ${endpoint.pathname}`.toLowerCase();
      const priority = /aac[_-]?160|160k/.test(quality) ? 0
        : (/aac[_-]?96|96k/.test(quality) ? 1 : 2);
      candidates.push({ url: endpoint, priority });
    } catch (_) {}
  }
  candidates.sort((a, b) => a.priority - b.priority);
  let authFailed = false;
  for (const candidate of candidates) {
    try {
      const response = await fetchSoundCloudResource(candidate.url, 'json', {
        ...options, diagnosticStage: 'hls-stream',
      });
      if (options.signal?.aborted) throw new DOMException('Playback canceled', 'AbortError');
      if (response.status === 401 || response.status === 403) authFailed = true;
      if (!response.ok) continue;
      const data = response.data;
      const resolvedUrls = typeof data === 'string' ? [data] : [
        data?.url, data?.hls_aac_160_url, data?.hls_aac_96_url,
      ];
      for (const url of resolvedUrls) {
        if (isHlsManifestUrl(url) && !urls.includes(url)) urls.push(url);
      }
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      recordPlaybackDiagnostic('hls-endpoint-failed', { error: playbackErrorName(error) });
    }
  }
  return { urls, authFailed };
}

function hlsDiagnosticCode(value) {
  const code = String(value || '');
  return /^[A-Za-z0-9_-]{1,48}$/.test(code) ? code : 'unknown';
}

async function prepareHlsDeck(audio, index, streamUrl, timeout, signal, isCurrent, diagnosticTrace, options = {}) {
  const HlsCtor = hlsJsConstructor();
  if (diagnosticTrace) {
    diagnosticTrace.hlsLibraryAvailable = Boolean(HlsCtor);
    diagnosticTrace.hlsLibraryVersion = safeDiagnosticVersion(HlsCtor?.version || '');
  }
  let supported = false;
  try { supported = Boolean(HlsCtor?.isSupported()); } catch (_) {}
  if (diagnosticTrace) diagnosticTrace.hlsSupported = supported;
  if (!supported) {
    if (diagnosticTrace) {
      diagnosticTrace.stage = 'hls-mse';
      diagnosticTrace.reason = 'hls-mse-unavailable';
      diagnosticTrace.hlsMode = 'unsupported';
    }
    return { supported: false, ready: false, player: null, source: '' };
  }
  let player;
  const preflight = options.preflight?.streamUrl === streamUrl
    && !options.preflight.failed && !options.preflight.adopted ? options.preflight : null;
  if (preflight?.player) {
    player = preflight.player;
    try { if (preflight.onError) player.off(HlsCtor.Events.ERROR, preflight.onError); } catch (_) {}
    preflight.onError = null;
  } else {
    try {
      player = new HlsCtor({ enableWorker: true, lowLatencyMode: false });
    } catch (error) {
      if (diagnosticTrace) {
        diagnosticTrace.stage = 'hls-mse';
        diagnosticTrace.reason = 'hls-initialization-error';
        diagnosticTrace.hlsMode = 'unsupported';
        diagnosticTrace.errorName = playbackErrorName(error);
      }
      return { supported: false, ready: false, player: null, source: '' };
    }
  }
  state._deckHlsPlayers ||= [null, null];
  state._deckHlsFailed ||= [false, false];
  state._deckHlsFailed[index] = false;
  state._deckHlsPlayers[index] = player;
  if (preflight) preflight.adopted = true;
  if (state._transitionDiagnostics) {
    const details = { deckIndex: index, trackIndex: state._deckTracks[index], token: state._deckPrepareTokens[index], detached: false };
    observeTransitionHls(player, HlsCtor.Events, details);
    recordTransitionDiagnostic(preflight ? 'hls-adopted' : 'hls-load', {
      ...details, previousToken: preflight?.player?._tssTransitionHls?.previousToken,
    });
  }
  const waitController = new AbortController();
  const abortWait = () => { if (!waitController.signal.aborted) waitController.abort(); };
  signal?.addEventListener('abort', abortWait, { once: true });
  let fatalError = null;
  const hlsStartedAt = diagnosticTrace && typeof performance !== 'undefined' ? performance.now() : 0;
  const hlsElapsedMs = () => typeof performance !== 'undefined'
    ? Math.max(0, Math.round(performance.now() - hlsStartedAt)) : 0;
  let readinessSettled = false;
  let reportedFatal = false;
  const onHlsError = (_event, data) => {
    if (!data || state._deckHlsPlayers[index] !== player) return;
    const errorType = hlsDiagnosticCode(data.type);
    const errorDetail = hlsDiagnosticCode(data.details);
    const status = Number(data.response?.code) || null;
    if (diagnosticTrace) {
      diagnosticTrace.hlsErrorCount = (Number(diagnosticTrace.hlsErrorCount) || 0) + 1;
      diagnosticTrace.hlsLastErrorType = errorType;
      diagnosticTrace.hlsLastErrorDetail = errorDetail;
      if (status !== null) diagnosticTrace.hlsStatus = status;
      if (data.fatal) {
        diagnosticTrace.hlsFatalErrorCount = (Number(diagnosticTrace.hlsFatalErrorCount) || 0) + 1;
        diagnosticTrace.hlsErrorType = errorType;
        diagnosticTrace.hlsErrorDetail = errorDetail;
      } else {
        diagnosticTrace.hlsNonFatalErrorCount = (Number(diagnosticTrace.hlsNonFatalErrorCount) || 0) + 1;
      }
    }
    if (!data.fatal || fatalError) return;
    fatalError = data;
    const trackIndex = state._deckTracks[index];
    if (readinessSettled) {
      state._deckHlsFailed ||= [false, false];
      state._deckHlsFailed[index] = true;
      if (state.active && Number.isInteger(trackIndex) && !reportedFatal) {
        reportedFatal = true;
        recordPlaybackDiagnostic('hls-playback-failed', {
          attemptId: diagnosticTrace?.attemptId,
          trackIndex,
          streamKind: 'hls-mse',
          stage: 'hls-stream',
          reason: 'fatal-hls-error',
          errorType,
          errorDetail,
          status,
          hlsLibraryVersion: safeDiagnosticVersion(HlsCtor.version || ''),
          hlsLevelCount: Array.isArray(player.levels) ? player.levels.length : 0,
          hlsCurrentLevel: Number.isFinite(Number(player.currentLevel)) ? Number(player.currentLevel) : -1,
          hlsBandwidthEstimate: Number.isFinite(Number(player.bandwidthEstimate))
            ? Math.round(Number(player.bandwidthEstimate)) : null,
          hlsErrorCount: diagnosticTrace?.hlsErrorCount || 1,
          hlsNonFatalErrorCount: diagnosticTrace?.hlsNonFatalErrorCount || 0,
          hlsFatalErrorCount: diagnosticTrace?.hlsFatalErrorCount || 1,
          hlsMediaAttached: diagnosticTrace?.hlsMediaAttached || false,
          hlsMediaAttachedElapsedMs: diagnosticTrace?.hlsMediaAttachedElapsedMs,
          hlsManifestParsed: diagnosticTrace?.hlsManifestParsed || false,
          hlsManifestParsedElapsedMs: diagnosticTrace?.hlsManifestParsedElapsedMs,
          hlsFirstFragmentBuffered: diagnosticTrace?.hlsFirstFragmentBuffered || false,
          hlsFirstFragmentBufferedElapsedMs: diagnosticTrace?.hlsFirstFragmentBufferedElapsedMs,
          hlsBufferedFragmentCount: diagnosticTrace?.hlsBufferedFragmentCount || 0,
          readyState: Number(audio.readyState) || 0,
          networkState: Number(audio.networkState) || 0,
        });
      }
      if (state.active && state._deckIndex !== index && state.crossfadeSeconds > 0) {
        setCrossfadeStatus('fallback');
      }
    } else {
      abortWait();
    }
  };
  const onMediaAttached = () => {
    if (diagnosticTrace && state._deckHlsPlayers[index] === player) {
      diagnosticTrace.hlsMediaAttached = true;
      diagnosticTrace.hlsMediaAttachedElapsedMs = hlsElapsedMs();
    }
  };
  const onManifestParsed = () => {
    if (!diagnosticTrace || state._deckHlsPlayers[index] !== player) return;
    diagnosticTrace.hlsManifestParsed = true;
    diagnosticTrace.hlsManifestParsedElapsedMs = hlsElapsedMs();
    diagnosticTrace.hlsLevelCount = Array.isArray(player.levels) ? player.levels.length : 0;
    diagnosticTrace.hlsCurrentLevel = Number.isFinite(Number(player.currentLevel)) ? Number(player.currentLevel) : -1;
    diagnosticTrace.hlsBandwidthEstimate = Number.isFinite(Number(player.bandwidthEstimate))
      ? Math.round(Number(player.bandwidthEstimate)) : 0;
  };
  const onFragmentBuffered = () => {
    if (!diagnosticTrace || state._deckHlsPlayers[index] !== player) return;
    diagnosticTrace.hlsBufferedFragmentCount = (Number(diagnosticTrace.hlsBufferedFragmentCount) || 0) + 1;
    if (!diagnosticTrace.hlsFirstFragmentBuffered) {
      diagnosticTrace.hlsFirstFragmentBuffered = true;
      diagnosticTrace.hlsFirstFragmentBufferedElapsedMs = hlsElapsedMs();
    }
    if (Number.isFinite(Number(player.bandwidthEstimate))) {
      diagnosticTrace.hlsBandwidthEstimate = Math.round(Number(player.bandwidthEstimate));
    }
  };
  if (diagnosticTrace) {
    diagnosticTrace.stage = 'hls-mse';
    diagnosticTrace.reason = 'attaching-hls-media';
    diagnosticTrace.hlsMode = 'mse';
  }
  try {
    player.on(HlsCtor.Events.ERROR, onHlsError);
    if (HlsCtor.Events.MEDIA_ATTACHED) player.on(HlsCtor.Events.MEDIA_ATTACHED, onMediaAttached);
    if (HlsCtor.Events.MANIFEST_PARSED) player.on(HlsCtor.Events.MANIFEST_PARSED, onManifestParsed);
    if (HlsCtor.Events.FRAG_BUFFERED) player.on(HlsCtor.Events.FRAG_BUFFERED, onFragmentBuffered);
    const readiness = waitForDeck(audio, timeout, waitController.signal, isCurrent, diagnosticTrace);
    if (!preflight) player.loadSource(streamUrl);
    player.attachMedia(audio);
    const ready = await readiness;
    readinessSettled = true;
    if (diagnosticTrace) diagnosticTrace.hlsReady = ready;
    if (fatalError) {
      if (diagnosticTrace) {
        diagnosticTrace.stage = 'hls-stream';
        diagnosticTrace.reason = 'hls-fatal-error';
        diagnosticTrace.mediaWaitOutcome = 'hls-fatal';
      }
      const trackIndex = state._deckTracks[index];
      if (!reportedFatal && state.active && state._deckIndex === index
          && state._deckTrack === trackIndex && Number.isInteger(trackIndex)) {
        reportedFatal = true;
        recordPlaybackDiagnostic('hls-playback-failed', {
          attemptId: diagnosticTrace?.attemptId,
          trackIndex,
          streamKind: 'hls-mse',
          stage: 'hls-stream',
          reason: 'fatal-hls-error',
          errorType: hlsDiagnosticCode(fatalError.type),
          errorDetail: hlsDiagnosticCode(fatalError.details),
          status: Number(fatalError.response?.code) || null,
          hlsLibraryVersion: safeDiagnosticVersion(player.version || ''),
          hlsLevelCount: Array.isArray(player.levels) ? player.levels.length : 0,
          hlsCurrentLevel: Number.isFinite(Number(player.currentLevel)) ? Number(player.currentLevel) : -1,
          hlsBandwidthEstimate: Number.isFinite(Number(player.bandwidthEstimate))
            ? Math.round(Number(player.bandwidthEstimate)) : null,
          hlsErrorCount: diagnosticTrace?.hlsErrorCount || 1,
          hlsNonFatalErrorCount: diagnosticTrace?.hlsNonFatalErrorCount || 0,
          hlsFatalErrorCount: diagnosticTrace?.hlsFatalErrorCount || 1,
          hlsMediaAttached: diagnosticTrace?.hlsMediaAttached || false,
          hlsMediaAttachedElapsedMs: diagnosticTrace?.hlsMediaAttachedElapsedMs,
          hlsManifestParsed: diagnosticTrace?.hlsManifestParsed || false,
          hlsManifestParsedElapsedMs: diagnosticTrace?.hlsManifestParsedElapsedMs,
          hlsFirstFragmentBuffered: diagnosticTrace?.hlsFirstFragmentBuffered || false,
          hlsFirstFragmentBufferedElapsedMs: diagnosticTrace?.hlsFirstFragmentBufferedElapsedMs,
          hlsBufferedFragmentCount: diagnosticTrace?.hlsBufferedFragmentCount || 0,
          readyState: Number(audio.readyState) || 0,
          networkState: Number(audio.networkState) || 0,
        });
      }
      return { supported: true, ready: false, player, source: audio.src, failed: true };
    }
    return { supported: true, ready, player, source: audio.src, failed: !ready };
  } catch (error) {
    readinessSettled = true;
    if (diagnosticTrace) {
      diagnosticTrace.stage = 'hls-stream';
      diagnosticTrace.reason = 'hls-initialization-error';
      diagnosticTrace.errorName = playbackErrorName(error);
    }
    return { supported: true, ready: false, player, source: audio.src, failed: true };
  } finally {
    signal?.removeEventListener('abort', abortWait);
  }
}

async function loadStreamOnDeck(audio, index, streamUrl, timeout, signal, isCurrent, diagnosticTrace, options = {}) {
  audio.preload = 'auto';
  if (isHlsStreamUrl(streamUrl)) {
    return prepareHlsDeck(audio, index, streamUrl, timeout, signal, isCurrent, diagnosticTrace, options);
  }
  audio.src = streamUrl;
  const source = audio.src;
  audio.load();
  const ready = await waitForDeck(audio, timeout, signal, isCurrent, diagnosticTrace);
  return { supported: true, ready, player: null, source, failed: !ready };
}

function hydrationTrackForPlayback(meta) {
  const roots = pageWindow.__sc_hydration;
  if (!Array.isArray(roots)) return null;
  const seen = new WeakSet();
  const stack = [...roots];
  while (stack.length) {
    const value = stack.pop();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    if (soundCloudTrackMatches(meta, value) && Array.isArray(value.media?.transcodings)) return value;
    for (const child of Object.values(value)) {
      if (child && typeof child === 'object') stack.push(child);
    }
  }
  return null;
}

async function fetchPlaybackTrack(url, options = {}) {
  try {
    const response = await fetchSoundCloudResource(url, 'json', options);
    if (options.signal?.aborted) throw new DOMException('Playback canceled', 'AbortError');
    return {
      track: response.data,
      authFailed: response.status === 401 || response.status === 403,
    };
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    recordPlaybackDiagnostic('track-request-failed', { error: playbackErrorName(error) });
    return { track: null, authFailed: false };
  }
}

async function resolveCrossfadeStreams(meta, options = {}) {
  const epoch = state._playbackEpoch;
  const signal = options.signal || state._playbackAbort?.signal;
  const diagnosticTrace = options.diagnosticTrace;
  const checkCurrent = () => {
    if (epoch !== state._playbackEpoch || signal?.aborted || (options.isCurrent && !options.isCurrent())) {
      throw new DOMException('Playback canceled', 'AbortError');
    }
  };
  const requestOptions = { ...options, signal };
  if (diagnosticTrace) {
    diagnosticTrace.stage = 'stream-resolution';
    diagnosticTrace.reason = 'resolving';
  }
  checkCurrent();
  const key = normalizeTrackUrl(meta?.link);
  if (!key) {
    if (diagnosticTrace) diagnosticTrace.reason = 'missing-track-link';
    return [];
  }
  const now = Date.now();
  for (const [cachedKey, value] of state._streamCache) {
    if (now - value.ts >= 30 * 60 * 1000) state._streamCache.delete(cachedKey);
  }
  if (options.forceRefresh) state._streamCache.delete(key);
  let cached = state._streamCache.get(key);
  const expectedId = soundCloudInteger(meta.soundcloudId, 1);
  const cachedId = soundCloudInteger(cached?.soundcloudId, 1);
  if (cached && expectedId !== null && cachedId !== null && expectedId !== cachedId) {
    state._streamCache.delete(key);
    cached = null;
  }
  if (cached?.urls?.length) {
    state._streamCache.delete(key);
    state._streamCache.set(key, cached);
    if (diagnosticTrace) {
      diagnosticTrace.streamSource = 'stream-cache';
      for (const url of cached.urls) {
        if (isHlsStreamUrl(url)) diagnosticTrace.hlsStreamUrls++;
        else diagnosticTrace.progressiveUrls++;
      }
      if (diagnosticTrace.hlsStreamUrls) diagnosticTrace.hlsMode = 'mse';
      diagnosticTrace.reason = 'cached-stream';
    }
    return cached.urls;
  }

  const rejected = new Set();
  let trackMetadataFound = false;
  let hlsAvailable = false;
  let progressiveMetadataAvailable = false;
  // After two resource-history candidates, inspect current bundles rather than
  // repeatedly cycling expired IDs from our own failed resource requests.
  for (let credentialAttempt = 0; credentialAttempt < 8; credentialAttempt++) {
    if (diagnosticTrace) diagnosticTrace.credentialAttempts++;
    const clientId = await discoverSoundCloudClientIdFromBundle(rejected, {
      ...requestOptions, bundleOnly: credentialAttempt >= 2,
    });
    checkCurrent();
    if (!clientId) {
      if (diagnosticTrace) diagnosticTrace.reason = 'client-id-unavailable';
      return [];
    }
    let authFailed = false;
    const resolveTrack = async (track, source) => {
      checkCurrent();
      if (diagnosticTrace && source) diagnosticTrace.streamSource = source;
      if (!soundCloudTrackMatches(meta, track)) return [];
      trackMetadataFound = true;
      if (diagnosticTrace) diagnosticTrace.trackMetadataFound = true;
      if (!meta.artist || meta.artist === '—') {
        Object.assign(meta, mergeTrackMeta(meta, metaFromSoundCloudTrack(track, meta.sourcePage, meta.playlistPosition)));
      }
      if (syncTrackPlaybackAccess(meta, track)) {
        if (diagnosticTrace) {
          diagnosticTrace.stage = 'access-classification';
          diagnosticTrace.reason = 'native-preview-required';
          diagnosticTrace.nativeFallbackReason = meta.nativePlaybackReason || 'preview-only';
        }
        return [];
      }
      const transcodings = Array.isArray(track.media?.transcodings)
        ? track.media.transcodings
        : (Array.isArray(track.transcodings) ? track.transcodings : []);
      const directHlsUrls = directHlsStreamUrls(track);
      let hlsCandidateCount = directHlsUrls.length;
      const hasHls160 = Boolean(track.hls_aac_160_url || track.streams?.hls_aac_160_url
        || track.media?.hls_aac_160_url || track.media?.streams?.hls_aac_160_url);
      const hasHls96 = Boolean(track.hls_aac_96_url || track.streams?.hls_aac_96_url
        || track.media?.hls_aac_96_url || track.media?.streams?.hls_aac_96_url);
      for (const transcoding of transcodings) {
        const protocol = String(transcoding?.format?.protocol || transcoding?.protocol || '');
        if (!transcoding?.url) continue;
        if (protocol === 'progressive') progressiveMetadataAvailable = true;
        if (!protocol.toLowerCase().includes('hls') && !isHlsStreamUrl(transcoding.url)) continue;
        hlsCandidateCount++;
        const quality = `${transcoding.preset || ''} ${transcoding.quality || ''}`.toLowerCase();
        if (diagnosticTrace && /aac[_-]?160|160k/.test(quality)) diagnosticTrace.hlsAac160Candidates++;
        else if (diagnosticTrace && /aac[_-]?96|96k/.test(quality)) diagnosticTrace.hlsAac96Candidates++;
        else if (diagnosticTrace) diagnosticTrace.hlsOtherCandidates++;
      }
      if (diagnosticTrace) {
        diagnosticTrace.hlsAac160Candidates += Number(hasHls160);
        diagnosticTrace.hlsAac96Candidates += Number(hasHls96);
        diagnosticTrace.hlsOtherCandidates += Math.max(0, directHlsUrls.length - Number(hasHls160) - Number(hasHls96));
      }
      if (diagnosticTrace) diagnosticTrace.progressiveMetadataAvailable = progressiveMetadataAvailable;
      if (hlsCandidateCount) hlsAvailable = true;
      if (diagnosticTrace) diagnosticTrace.hlsCandidates += hlsCandidateCount;
      const result = await resolveProgressiveStreams(track, clientId, requestOptions);
      checkCurrent();
      authFailed = authFailed || result.authFailed;
      let urls = result.urls;
      if (!urls.length && hlsCandidateCount) {
        const hlsResult = await resolveHlsStreamUrls(track, clientId, requestOptions);
        checkCurrent();
        authFailed = authFailed || hlsResult.authFailed;
        urls = hlsResult.urls;
        if (urls.length && diagnosticTrace) {
          diagnosticTrace.hlsStreamUrls += urls.length;
          diagnosticTrace.hlsMode = 'mse';
          diagnosticTrace.reason = 'hls-mse-candidate';
        } else if (!urls.length && diagnosticTrace) {
          diagnosticTrace.stage = 'stream-classification';
          diagnosticTrace.reason = 'hls-url-unavailable';
        }
      }
      if (urls.length) {
        state._streamCache.delete(key);
        state._streamCache.set(key, {
          urls, ts: Date.now(),
          soundcloudId: soundCloudInteger(track.id, 1) ?? soundCloudInteger(track.soundcloudId, 1)
            ?? soundCloudInteger(meta.soundcloudId, 1),
        });
        while (state._streamCache.size > 128) state._streamCache.delete(state._streamCache.keys().next().value);
      }
      return urls;
    };
    const hydrated = hydrationTrackForPlayback(meta);
    const embedded = hydrated || (Array.isArray(meta.transcodings) && meta.transcodings.length ? meta : null);
    let urls = await resolveTrack(embedded, hydrated ? 'hydration' : (embedded ? 'track-metadata' : 'none'));
    checkCurrent();
    if (urls.length) return urls;
    if (meta.requiresNativePlayback) {
      if (diagnosticTrace) {
        diagnosticTrace.stage = 'stream-classification';
        diagnosticTrace.reason = 'native-fallback-required';
        diagnosticTrace.nativeFallbackReason = meta.nativePlaybackReason || 'preview-only';
      }
      return [];
    }
    if (soundCloudInteger(meta.soundcloudId, 1) !== null) {
      const endpoint = new URL(`https://api-v2.soundcloud.com/tracks/${soundCloudInteger(meta.soundcloudId, 1)}`);
      endpoint.searchParams.set('client_id', clientId);
      if (meta.trackAuthorization) endpoint.searchParams.set('track_authorization', meta.trackAuthorization);
      const result = await fetchPlaybackTrack(endpoint, {
        ...requestOptions, diagnosticStage: 'track-lookup',
      });
      checkCurrent();
      authFailed = authFailed || result.authFailed;
      urls = await resolveTrack(result.track, 'track-api');
      checkCurrent();
      if (urls.length) return urls;
      if (meta.requiresNativePlayback) {
        if (diagnosticTrace) {
          diagnosticTrace.stage = 'stream-classification';
          diagnosticTrace.reason = 'native-fallback-required';
          diagnosticTrace.nativeFallbackReason = meta.nativePlaybackReason || 'preview-only';
        }
        return [];
      }
    }
    const resolveEndpoint = new URL('https://api-v2.soundcloud.com/resolve');
    resolveEndpoint.searchParams.set('url', meta.link);
    resolveEndpoint.searchParams.set('client_id', clientId);
    const resolved = await fetchPlaybackTrack(resolveEndpoint, {
      ...requestOptions, diagnosticStage: 'url-resolve',
    });
    checkCurrent();
    authFailed = authFailed || resolved.authFailed;
    urls = await resolveTrack(resolved.track, 'url-resolve');
    checkCurrent();
    if (urls.length) return urls;
    if (meta.requiresNativePlayback) {
      if (diagnosticTrace) {
        diagnosticTrace.stage = 'stream-classification';
        diagnosticTrace.reason = 'native-fallback-required';
        diagnosticTrace.nativeFallbackReason = meta.nativePlaybackReason || 'preview-only';
      }
      return [];
    }
    if (!authFailed) {
      if (diagnosticTrace) {
        const statuses = diagnosticTrace.requests.map(request => request.status);
        if (statuses.includes(429)) diagnosticTrace.reason = 'http-rate-limited';
        else if (statuses.some(status => status >= 500 && status <= 599)) diagnosticTrace.reason = 'http-server-error';
        else if (diagnosticTrace.requests.some(request => request.errorName)) diagnosticTrace.reason = 'request-error';
        else if (hlsAvailable) diagnosticTrace.reason = 'hls-url-unavailable';
        else if (progressiveMetadataAvailable) diagnosticTrace.reason = 'progressive-url-unavailable';
        else diagnosticTrace.reason = trackMetadataFound ? 'unsupported-stream-protocol' : 'track-not-found';
      }
      return [];
    }
    if (diagnosticTrace) diagnosticTrace.authFailed = true;
    rejected.add(clientId);
    if (state._clientId === clientId) state._clientId = '';
  }
  if (diagnosticTrace) diagnosticTrace.reason = 'authorization-rejected';
  return [];
}


function resetDeck(audio, index) {
  if (!audio) return;
  const schedule = state._crossfadeSchedule;
  if (schedule && (schedule.incomingIndex === index || schedule.outgoingIndex === index)) delete schedule.incomingClockObservation;
  if (state._transitionDiagnostics) recordTransitionDiagnostic('deck-reset', {
    deckIndex: index, trackIndex: state._deckTracks[index], token: state._deckPrepareTokens[index],
  });
  const safely = operation => {
    try { operation(); } catch (error) {
      recordPlaybackDiagnostic('deck-reset-failed', { errorName: playbackErrorName(error) });
    }
  };
  if (Number.isInteger(index) && state._deckHlsPlayers?.[index]) {
    const hls = state._deckHlsPlayers[index];
    state._deckHlsPlayers[index] = null;
    safely(() => hls.destroy());
  }
  safely(() => audio.pause());
  safely(() => audio.removeAttribute('src'));
  safely(() => audio.load());
  if (Number.isInteger(index)) {
    state._deckHlsFailed ||= [false, false];
    state._deckHlsFailed[index] = false;
    state._deckTracks[index] = null;
    state._deckGains[index] = 0;
    const graph = state._deckAudioGraphs[index];
    if (graph && state._audioContext) {
      const now = state._audioContext.currentTime;
      graph.trackKey = '';
      graph.samples = 0;
      graph.smoothedRms = 0;
      graph.peakRms = 0;
      graph.currentGain = 1;
      graph.autoGainMaster = null;
      safely(() => setAudioParamImmediately(graph.autoGain.gain, 1, now));
      safely(() => setAudioParamImmediately(graph.mixGain.gain, 0, now));
      graph.appliedAutoGain = 1;
      graph.appliedMixGain = 0;
    }
  }
  safely(() => { audio.volume = state._deckAudioGraphs[index] ? 1 : 0; });
}


function deckIsPreviewLimited(meta, audio) {
  if (meta?.requiresNativePlayback) return true;
  const expected = Number(meta?.durationMs) / 1000;
  const actual = Number(audio?.duration);
  return Number.isFinite(expected) && expected >= 60
    && Number.isFinite(actual) && actual > 0 && actual <= 31.5
    && expected - actual >= 15;
}
function stopCrossfadeDecks() {
  state._crossfadeToken++;
  state._crossfadePrefetchToken++;
  state._deckPrepareTokens = state._deckPrepareTokens.map(token => token + 1);
  state._deckPrepareAborts?.forEach(controller => controller?.abort());
  state._crossfading = false;
  state._crossfadePausedByUser = false;
  state._crossfadePending = false;
  state._crossfadeSchedule?.resolve?.(false);
  destroyCrossfadePreflight(state._crossfadeStreamWarmup);
  state._crossfadeStreamWarmup?.controller?.abort();
  state._crossfadeStreamWarmup = null;
  state._crossfadeSchedule = null;
  state._decks.forEach((audio, index) => resetDeck(audio, index));
  state._deckIndex = -1;
  state._deckTrack = null;
  state._nativeTrack = null;
  setCrossfadeStatus(state.crossfadeSeconds > 0 ? 'armed' : 'off');
}

function crossfadePreparationMatches(record, index, ti) {
  return Boolean(record && record.epoch === state._playbackEpoch
    && record.index === index && record.ti === ti && record.meta === state.meta[ti]
    && record.audio === state._decks[index]
    && record.token === state._deckPrepareTokens[index]
    && !record.controller?.signal.aborted && !record.signal?.aborted);
}

function prepareCrossfadeDeck(index, ti, options = {}) {
  const signal = options.signal || state._playbackAbort?.signal;
  if (!state.active || signal?.aborted || (options.isCurrent && !options.isCurrent())) return Promise.resolve(null);
  const records = state._deckPreparations || (state._deckPreparations = []);
  const previous = records[index];
  if (!options.forceRefresh && crossfadePreparationMatches(previous, index, ti)
      && previous.pending && previous.signal === signal
      && (options.foreground || !previous.isCurrent || previous.isCurrent())) {
    if (options.foreground) {
      if (state._transitionDiagnostics && !previous.foreground) recordTransitionDiagnostic('preparation-promoted', {
        deckIndex: index, trackIndex: ti, token: previous.token,
      });
      // next() consumes the upcoming item before entering here. Transfer ownership
      // rather than retaining the speculative "still upcoming" predicate.
      previous.isCurrent = options.isCurrent;
      previous.foreground = true;
      const warmup = previous.warmup;
      if (warmup && warmup === state._crossfadeStreamWarmup
          && warmup.epoch === previous.epoch && warmup.nextTi === ti
          && warmup.meta === previous.meta) warmup.isCurrent = () => !options.isCurrent || options.isCurrent();
    }
    if (state._transitionDiagnostics) recordTransitionDiagnostic('preparation-reused', {
      deckIndex: index, trackIndex: ti, token: previous.token, ready: false, foreground: Boolean(options.foreground),
    });
    return previous.promise;
  }
  if (state._transitionDiagnostics && previous && (options.forceRefresh || !crossfadePreparationMatches(previous, index, ti))) {
    recordTransitionDiagnostic('preparation-replaced', {
      deckIndex: index, trackIndex: previous.ti, token: previous.token, foreground: Boolean(options.foreground),
    });
  }
  if (state._transitionDiagnostics && options.foreground && !previous?.foreground
      && crossfadePreparationMatches(previous, index, ti)) recordTransitionDiagnostic('preparation-promoted', {
    deckIndex: index, trackIndex: ti, token: previous.token,
  });
  const record = {
    epoch: state._playbackEpoch, index, ti, meta: state.meta[ti],
    audio: state._decks[index], signal, isCurrent: options.isCurrent,
    foreground: Boolean(options.foreground), warmup: state._crossfadeStreamWarmup,
    pending: true, promise: null, token: null, controller: null,
  };
  records[index] = record;
  const startedAt = state._transitionDiagnostics ? performance.now() : 0;
  const isCurrent = () => records[index] === record
    && (!record.isCurrent || record.isCurrent());
  const preparation = runCrossfadeDeckPreparation(index, ti, {
    ...options, isCurrent,
    preparedMeta: crossfadePreparationMatches(previous, index, ti) ? previous.meta : null,
  });
  record.promise = (state._transitionDiagnostics ? preparation.then(audio => {
    if (state._transitionDiagnostics) recordTransitionDiagnostic(
      record.controller?.signal.aborted || signal?.aborted || !isCurrent() ? 'preparation-cancelled' : 'preparation-result', {
        playbackEpoch: record.epoch, deckIndex: index, trackIndex: ti, token: record.token, foreground: record.foreground,
        ready: Boolean(audio), elapsedMs: performance.now() - startedAt,
      });
    return audio;
  }) : preparation).finally(() => { record.pending = false; });
  record.audio = state._decks[index];
  record.token = state._deckPrepareTokens[index];
  record.controller = state._deckPrepareAborts?.[index];
  return record.promise;
}

async function runCrossfadeDeckPreparation(index, ti, options = {}) {
  const epoch = state._playbackEpoch;
  const warmup = state._crossfadeStreamWarmup;
  const sessionSignal = options.signal || state._playbackAbort?.signal;
  const diagnosticTrace = options.diagnosticTrace || null;
  if (!state.active || sessionSignal?.aborted || (options.isCurrent && !options.isCurrent())) return null;
  if (diagnosticTrace) {
    diagnosticTrace.stage = 'audio-graph';
    diagnosticTrace.reason = 'checking-audio-graph';
  }
  if (state.autoLevel || state.eqEnabled || state.safetyClipper || state.crossfadeSeconds > 0
      || state._audioContext?.state === 'closed' || state._audioGraphFailed) {
    if (!ensureAutoLevelAudioGraph()) {
      if (diagnosticTrace) {
        diagnosticTrace.audioGraphPhase = 'prepare';
        diagnosticTrace.audioGraphReason = 'graph-unavailable';
        diagnosticTrace.reason = 'audio-graph-unavailable';
      }
      return null;
    }
  }
  const audio = ensureCrossfadeDecks()[index];
  const meta = state.meta[ti];
  if (!audio || !meta) {
    if (diagnosticTrace) {
      diagnosticTrace.stage = 'deck-preparation';
      diagnosticTrace.reason = 'missing-deck-or-metadata';
    }
    return null;
  }
  state._deckPrepareAborts ||= [];
  state._deckPrepareAborts[index]?.abort();
  const controller = new AbortController();
  state._deckPrepareAborts[index] = controller;
  const abort = () => controller.abort();
  sessionSignal?.addEventListener('abort', abort, { once: true });
  const requestToken = (state._deckPrepareTokens[index] || 0) + 1;
  state._deckPrepareTokens[index] = requestToken;
  if (state._transitionDiagnostics) recordTransitionDiagnostic('preparation-start', {
    deckIndex: index, trackIndex: ti, token: requestToken, foreground: Boolean(options.foreground),
  });
  const requestIsCurrent = () => state.active && epoch === state._playbackEpoch
    && !controller.signal.aborted && !sessionSignal?.aborted
    && state._deckPrepareTokens[index] === requestToken
    && state._decks[index] === audio && state.meta[ti] === meta
    && (!options.isCurrent || options.isCurrent());
  try {
    if (!options.forceRefresh && options.preparedMeta === meta && state._deckTracks[index] === ti
        && audio.currentSrc && audio.readyState >= 2 && !state._deckHlsFailed?.[index]) {
      if (state._transitionDiagnostics) recordTransitionDiagnostic('preparation-reused', {
        deckIndex: index, trackIndex: ti, token: requestToken, ready: true, foreground: Boolean(options.foreground),
      });
      if (diagnosticTrace) {
        diagnosticTrace.stage = 'deck-readiness';
        diagnosticTrace.reason = 'prepared-deck-reused';
        diagnosticTrace.mediaWaitOutcome = 'already-ready';
        diagnosticTrace.readyState = Number(audio.readyState) || 0;
        diagnosticTrace.networkState = Number(audio.networkState) || 0;
        diagnosticTrace.mediaErrorCode = Number(audio.error?.code) || 0;
        diagnosticTrace.streamKind = diagnosticDeckStreamKind(audio, index);
        diagnosticTrace.hlsMode = state._deckHlsPlayers?.[index] ? 'mse' : 'not-used';
        diagnosticTrace.hlsReady = Boolean(state._deckHlsPlayers?.[index]);
      }
      return audio;
    }
    if (diagnosticTrace) {
      diagnosticTrace.stage = 'stream-resolution';
      diagnosticTrace.reason = 'resolving-streams';
    }
    const streamsStartedAt = state._transitionDiagnostics ? performance.now() : 0;
    let streamUrls = options.resolvedStreamPromise
      ? await options.resolvedStreamPromise
      : null;
    if (!streamUrls?.length) {
      streamUrls = await resolveCrossfadeStreams(meta, {
        ...options, signal: controller.signal, isCurrent: requestIsCurrent,
      });
    }
    if (state._transitionDiagnostics) recordTransitionDiagnostic('streams-resolved', {
      deckIndex: index, trackIndex: ti, token: requestToken,
      streamCandidateCount: streamUrls?.length || 0, elapsedMs: performance.now() - streamsStartedAt,
    });
    if (!requestIsCurrent()) return null;
    if (!streamUrls.length) {
      if (diagnosticTrace && diagnosticTrace.reason === 'resolving-streams') {
        diagnosticTrace.reason = 'no-stream-url';
      }
      return null;
    }
    if (diagnosticTrace) {
      diagnosticTrace.streamCandidateCount = streamUrls.length;
      diagnosticTrace.stage = 'deck-readiness';
      diagnosticTrace.reason = 'loading-media';
    }
    let hlsCandidatesFailed = false;
    for (let candidateIndex = 0; candidateIndex < streamUrls.length; candidateIndex++) {
      const streamUrl = streamUrls[candidateIndex];
      if (!requestIsCurrent()) return null;
      if (diagnosticTrace) diagnosticTrace.mediaCandidateOrdinal = candidateIndex + 1;
      resetDeck(audio, index);
      const hlsStream = isHlsStreamUrl(streamUrl);
      if (diagnosticTrace) {
        diagnosticTrace.streamKind = hlsStream ? 'hls-mse' : 'progressive';
        diagnosticTrace.streamQuality = diagnosticStreamQuality(streamUrl);
      }
      state._deckTracks[index] = ti;
      state._deckGains[index] = 0;
      applyCachedAutoLevel(index, ti);
      syncCrossfadeVolume();
      const preflight = warmup && warmup === state._crossfadeStreamWarmup
          && warmup.epoch === epoch && warmup.nextTi === ti
          && warmup.meta === meta && warmup.preflight?.streamUrl === streamUrl
          && !warmup.preflight.adopted
        ? warmup.preflight : null;
      const loaded = await loadStreamOnDeck(
        audio, index, streamUrl, options.timeout || 5000,
        controller.signal, requestIsCurrent, diagnosticTrace, { preflight },
      );
      if (preflight && loaded.player === preflight.player) {
        preflight.adopted = true;
        warmup.preflight = null;
      }
      const sourceIsCurrent = loaded.player
        ? state._deckHlsPlayers[index] === loaded.player
        : audio.src === loaded.source;
      if (!requestIsCurrent() || !sourceIsCurrent || state._deckTracks[index] !== ti) return null;
      if (!loaded.supported) {
        meta.requiresNativePlayback = true;
        meta.nativePlaybackReason = 'hls-mse-unavailable';
        if (diagnosticTrace) diagnosticTrace.nativeFallbackReason = meta.nativePlaybackReason;
        resetDeck(audio, index);
        return null;
      }
      const ready = loaded.ready;
      if (!ready && hlsStream) hlsCandidatesFailed = true;
      if (ready) {
        if (!deckIsPreviewLimited(meta, audio)) {
          if (diagnosticTrace) diagnosticTrace.reason = 'media-ready';
          return audio;
        }
        meta.requiresNativePlayback = true;
        meta.nativePlaybackReason = 'preview-limited';
        if (diagnosticTrace) {
          diagnosticTrace.stage = 'stream-classification';
          diagnosticTrace.reason = 'preview-limited';
        }
        state._streamCache.delete(normalizeTrackUrl(meta.link));
        resetDeck(audio, index);
        return null;
      }
      if (diagnosticTrace) {
        if (hlsStream && !['hls-fatal-error', 'hls-initialization-error'].includes(diagnosticTrace.reason)) {
          diagnosticTrace.stage = 'hls-readiness';
          diagnosticTrace.reason = diagnosticTrace.mediaWaitOutcome === 'error'
            ? 'hls-media-error' : 'hls-readiness-timeout';
        } else if (!hlsStream) {
          diagnosticTrace.stage = 'deck-readiness';
          diagnosticTrace.reason = diagnosticTrace.mediaWaitOutcome === 'error'
            ? 'media-error' : 'readiness-timeout';
        }
      }
    }
    if (!requestIsCurrent()) return null;
    if (hlsCandidatesFailed && options.forceRefresh) {
      meta.requiresNativePlayback = true;
      meta.nativePlaybackReason = 'hls-custom-playback-failed';
      if (diagnosticTrace) diagnosticTrace.nativeFallbackReason = meta.nativePlaybackReason;
    }
    state._streamCache.delete(normalizeTrackUrl(meta.link));
    resetDeck(audio, index);
    return null;
  } catch (error) {
    if (!requestIsCurrent() || error?.name === 'AbortError') return null;
    if (diagnosticTrace) {
      diagnosticTrace.stage = 'deck-preparation';
      diagnosticTrace.reason = 'preparation-error';
      diagnosticTrace.errorName = playbackErrorName(error);
    }
    recordPlaybackDiagnostic('deck-preparation-failed', { error: playbackErrorName(error) });
    resetDeck(audio, index);
    return null;
  } finally {
    sessionSignal?.removeEventListener('abort', abort);
  }
}

function cancelCrossfadeForRecovery(activeIndex) {
  state._crossfadeToken++;
  state._crossfadePrefetchToken++;
  state._crossfadeSchedule?.resolve?.(false);
  state._crossfadeSchedule = null;
  state._crossfading = false;
  state._crossfadePausedByUser = Boolean(state._userPaused);
  state._crossfadePending = false;
  state._decks.forEach((audio, index) => {
    if (!audio || index === activeIndex) return;
    state._deckPrepareTokens[index] = (state._deckPrepareTokens[index] || 0) + 1;
    resetDeck(audio, index);
  });
  state._deckGains[activeIndex] = 1;
  syncCrossfadeVolume();
  setCrossfadeStatus(state.crossfadeSeconds > 0 ? 'loading' : 'off');
}

async function recoverCurrentDeckStream(audio, position, reason = 'unknown', attempt = 1) {
  const index = state._decks.indexOf(audio);
  const ti = index >= 0 ? state._deckTracks[index] : null;
  const meta = state.meta[ti];
  const epoch = state._playbackEpoch;
  const foreground = state._playbackRequest;
  const sessionSignal = state._playbackAbort.signal;
  if (!state.active || state._userPaused || index < 0
      || !Number.isInteger(ti) || ti !== state._deckTrack || !meta) return null;
  const savedTime = Math.max(0, Number(position) || 0);
  const initialSeek = state._deckSeekRequest;
  const diagnosticTrace = state._diagnosticBuild ? createCustomStartTrace(ti) : null;
  const startedAt = diagnosticTrace?.startedAt
    ?? (state._diagnosticBuild && typeof performance !== 'undefined' ? performance.now() : 0);
  let recoveryOutcome = 'pending';
  const ownsDeck = () => state.active && state._playbackEpoch === epoch
    && state._playbackRequest === foreground && !sessionSignal.aborted
    && state._decks[index] === audio && state.meta[ti] === meta
    && state._deckPrepareTokens[index] === requestToken
    && state._deckTracks[index] === ti && state._deckTrack === ti;
  const requestToken = (state._deckPrepareTokens[index] || 0) + 1;
  state._deckPrepareTokens[index] = requestToken;
  const reportRecoveryResult = result => {
    if (!state._diagnosticBuild || result === null) return;
    recordPlaybackDiagnostic('recovery-result', {
      ...(customStartDiagnosticDetails(diagnosticTrace, result === true ? 'started' : 'failed') || {}),
      attemptId: diagnosticTrace?.attemptId,
      operationId: diagnosticTrace?.operationId,
      trackIndex: ti,
      attempt,
      result: recoveryOutcome,
      recoveryReason: reason,
      elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
      position: Math.round((Number(audio.currentTime) || savedTime) * 10) / 10,
      readyState: Number(audio.readyState) || 0,
      networkState: Number(audio.networkState) || 0,
      mediaErrorCode: Number(audio.error?.code) || 0,
    });
  };
  const finish = (result, outcome) => {
    recoveryOutcome = outcome;
    if (diagnosticTrace) diagnosticTrace.recoveryOutcome = outcome;
    return result;
  };
  try {
    recordPlaybackDiagnostic('recovery-start', {
      attemptId: diagnosticTrace?.attemptId,
      operationId: diagnosticTrace?.operationId,
      trackIndex: ti,
      reason,
      attempt,
      position: Math.round(savedTime * 10) / 10,
      streamKind: diagnosticDeckStreamKind(audio, index),
      readyState: Number(audio.readyState) || 0,
      networkState: Number(audio.networkState) || 0,
      mediaErrorCode: Number(audio.error?.code) || 0,
      audioContextState: state._audioContext?.state || 'missing',
    });
    cancelCrossfadeForRecovery(index);
    const result = await withDeadline(async signal => {
      const isCurrent = () => ownsDeck() && !signal.aborted && !state._userPaused;
      const streamUrls = await resolveCrossfadeStreams(meta, {
        forceRefresh: true, signal, diagnosticTrace,
      });
      if (!isCurrent()) return null;
      if (!streamUrls.length) return finish(false, 'stream-unavailable');
      let loaded = null;
      for (const streamUrl of streamUrls) {
        if (!isCurrent()) return null;
        audio.pause();
        const previousHls = state._deckHlsPlayers?.[index];
        if (previousHls) {
          state._deckHlsPlayers[index] = null;
          previousHls.destroy();
        }
        audio.removeAttribute('src');
        audio.load();
        if (diagnosticTrace) {
          diagnosticTrace.streamKind = isHlsStreamUrl(streamUrl) ? 'hls-mse' : 'progressive';
          diagnosticTrace.streamQuality = diagnosticStreamQuality(streamUrl);
        }
        const candidate = await loadStreamOnDeck(
          audio, index, streamUrl, 8000, signal, isCurrent, diagnosticTrace,
        );
        if (!isCurrent()) return null;
        if (!candidate.supported) {
          meta.requiresNativePlayback = true;
          meta.nativePlaybackReason = 'hls-mse-unavailable';
          recordPlaybackDiagnostic('hls-playback-failed', {
            attemptId: diagnosticTrace?.attemptId,
            trackIndex: ti,
            streamKind: 'hls-mse',
            reason: 'hls-mse-unavailable',
            errorType: 'runtime',
            errorDetail: 'mse-unavailable',
            status: null,
            readyState: Number(audio.readyState) || 0,
            networkState: Number(audio.networkState) || 0,
          });
          return finish(false, 'hls-mse-unavailable');
        }
        const sourceIsCurrent = candidate.player
          ? state._deckHlsPlayers[index] === candidate.player
          : audio.src === candidate.source;
        if (!sourceIsCurrent) return null;
        loaded = candidate;
        if (loaded.ready) break;
      }
      if (!loaded?.ready) return finish(false, diagnosticTrace?.reason || 'media-not-ready');
      const duration = Number(audio.duration);
      const latestSeek = state._deckSeekRequest;
      const resumeTime = latestSeek !== initialSeek && latestSeek?.epoch === epoch
        && latestSeek.audio === audio ? latestSeek.time : savedTime;
      audio.currentTime = Math.min(Number.isFinite(duration) ? Math.max(0, duration - 0.1) : resumeTime, resumeTime);
      const graphReady = await resumeAudioGraph(signal, diagnosticTrace);
      if (!isCurrent()) return null;
      if (!graphReady) return finish(false, 'audio-context-resume-failed');
      const played = await playDeckWithDeadline(audio, index, signal, isCurrent, diagnosticTrace);
      if (!isCurrent()) return null;
      if (!played) return finish(false, diagnosticTrace?.reason || 'media-play-failed');
      state._deckGains[index] = 1;
      syncCrossfadeVolume();
      if (state.crossfadeSeconds > 0) setCrossfadeStatus('ready');
      setTimeout(() => {
        if (isCurrent()) void prefetchUpcomingCrossfadeTrack().catch(error =>
          recordPlaybackDiagnostic('prefetch-failed', { errorName: playbackErrorName(error) }));
      }, 0);
      recoveryOutcome = 'recovered';
      if (diagnosticTrace) {
        diagnosticTrace.stage = 'recovery';
        diagnosticTrace.reason = 'recovered';
        diagnosticTrace.recoveryOutcome = recoveryOutcome;
      }
      recordPlaybackDiagnostic('recovery-success', {
        attemptId: diagnosticTrace?.attemptId,
        trackIndex: ti,
        reason,
        attempt,
        streamKind: diagnosticDeckStreamKind(audio, index),
        resumedAt: Math.round((Number(audio.currentTime) || 0) * 10) / 10,
        readyState: Number(audio.readyState) || 0,
        networkState: Number(audio.networkState) || 0,
      });
      return true;
    }, 15000, sessionSignal);
    if (result === null) return null;
    if (recoveryOutcome === 'pending') recoveryOutcome = result ? 'recovered' : 'recovery-failed';
    reportRecoveryResult(result);
    return result;
  } catch (error) {
    if (!ownsDeck() || state._userPaused) return null;
    const errorName = playbackErrorName(error);
    recoveryOutcome = errorName === 'TimeoutError' ? 'recovery-timeout' : 'recovery-exception';
    if (diagnosticTrace) {
      diagnosticTrace.stage = 'recovery';
      diagnosticTrace.reason = recoveryOutcome;
      diagnosticTrace.errorName = errorName;
      diagnosticTrace.recoveryOutcome = recoveryOutcome;
    }
    recordPlaybackDiagnostic('recovery-failed', {
      attemptId: diagnosticTrace?.attemptId,
      trackIndex: ti,
      reason,
      attempt,
      errorName,
      streamKind: diagnosticDeckStreamKind(audio, index),
      readyState: Number(audio.readyState) || 0,
      networkState: Number(audio.networkState) || 0,
      mediaErrorCode: Number(audio.error?.code) || 0,
    });
    reportRecoveryResult(false);
    return false;
  }
}
async function waitForDeck(audio, timeout = 5000, signal = null, isCurrent = () => true, diagnosticTrace = null) {
  const startedAt = diagnosticTrace && typeof performance !== 'undefined' ? performance.now() : 0;
  const recordState = outcome => {
    if (!diagnosticTrace) return;
    diagnosticTrace.mediaWaitOutcome = outcome;
    diagnosticTrace.mediaWaitElapsedMs = typeof performance !== 'undefined'
      ? Math.max(0, Math.round(performance.now() - startedAt)) : 0;
    diagnosticTrace.readyState = Number(audio.readyState) || 0;
    diagnosticTrace.networkState = Number(audio.networkState) || 0;
    diagnosticTrace.mediaErrorCode = Number(audio.error?.code) || 0;
  };
  if (signal?.aborted || !isCurrent()) {
    recordState('aborted');
    return false;
  }
  if (audio.readyState >= 2) {
    recordState('already-ready');
    return true;
  }
  return new Promise(resolve => {
    let settled = false;
    const finish = outcome => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      audio.removeEventListener('canplay', onReady);
      audio.removeEventListener('error', onError);
      signal?.removeEventListener('abort', onAbort);
      recordState(outcome);
      const ready = outcome === 'canplay' || outcome === 'timeout-ready';
      resolve(ready && !signal?.aborted && isCurrent());
    };
    const onReady = () => finish('canplay');
    const onError = () => finish('error');
    const onAbort = () => finish('aborted');
    const timer = setTimeout(() => finish(audio.readyState >= 2 ? 'timeout-ready' : 'timeout'), timeout);
    audio.addEventListener('canplay', onReady, { once: true });
    audio.addEventListener('error', onError, { once: true });
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted || !isCurrent()) onAbort();
  });
}

function crossfadeGains(t, curve = state.crossfadeCurve) {
  const clamped = Math.max(0, Math.min(1, t));
  if (clamped === 0) return [1, 0];
  if (clamped === 1) return [0, 1];
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

function crossfadeAutomationPlan(curve) {
  // Shared knots keep both decks complementary between every pair of ramps.
  // Clean is exactly linear; nonlinear profiles need only 49 uniform knots.
  const times = curve === 'clean' ? [0, 1] : Array.from({ length: 49 }, (_, i) => i / 48);
  if (curve === 'dj') {
    times.push(0.5 - 0.5 / 1.35, 0.5 + 0.5 / 1.35);
    times.sort((a, b) => a - b);
  }
  const outgoing = [];
  const incoming = [];
  for (const time of times) {
    const gains = crossfadeGains(time, curve);
    outgoing.push(gains[0]);
    incoming.push(gains[1]);
  }
  return { times, outgoing, incoming };
}

function schedulePairedCrossfade(outParam, inParam, plan, startTime, rampDuration) {
  // Cancelable LINEAR ramps only: active curve events cannot be cancelled
  // safely in Firefox. Pair submissions so neither deck waits for a full curve.
  outParam.cancelScheduledValues(0);
  inParam.cancelScheduledValues(0);
  outParam.setValueAtTime(plan.outgoing[0], startTime);
  inParam.setValueAtTime(plan.incoming[0], startTime);
  for (let i = 1; i < plan.times.length; i++) {
    const time = startTime + rampDuration * plan.times[i];
    outParam.linearRampToValueAtTime(plan.outgoing[i], time);
    inParam.linearRampToValueAtTime(plan.incoming[i], time);
  }
}

function crossfadeAutomationTiming(context, anchorAudioTime, anchorMonotonicMs, windowDuration, monotonicNow) {
  const sampledNow = Number(context.currentTime);
  if (!Number.isFinite(anchorAudioTime) || !Number.isFinite(windowDuration)) return null;
  const elapsed = context.state === 'running' && Number.isFinite(anchorMonotonicMs) && Number.isFinite(monotonicNow)
    ? Math.max(0, monotonicNow - anchorMonotonicMs) / 1000 : 0;
  const estimatedNow = Math.max(Number.isFinite(sampledNow) ? sampledNow : anchorAudioTime, anchorAudioTime + elapsed);
  const endTime = anchorAudioTime + windowDuration;
  const remaining = endTime - estimatedNow;
  if (!(remaining > 0)) return null;
  // Lead is part of the requested window, not extra overlap. Tiny windows
  // trade active-ramp length for submission headroom without moving the end.
  // An unpredictable main-thread interruption can still outlast this bounded
  // lead; neither this estimate nor a cached clock proves render delivery.
  const lead = Math.min(0.128, remaining / 2);
  const startTime = estimatedNow + lead;
  const duration = endTime - startTime;
  if (!(duration > 0) || !(startTime > estimatedNow)) return null;
  return { startTime, endTime, duration, estimatedNow, lead };
}

function waitForCrossfadeSchedule(schedule, token) {
  const epoch = state._playbackEpoch;
  const signal = state._playbackAbort.signal;
  const context = state._audioContext;
  return new Promise(resolve => {
    let settled = false;
    let timer;
    let lastClockValue = Number(context?.currentTime) || 0;
    let lastClockAdvanceAt = Date.now();
    const finish = completed => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      delete schedule.resolve;
      delete schedule.incomingClockObservation;
      resolve(completed);
    };
    const onAbort = () => finish(false);
    schedule.resolve = finish;
    signal.addEventListener('abort', onAbort, { once: true });
    const poll = () => {
      if (settled) return;
      if (!state.active || state._playbackEpoch !== epoch || signal.aborted
          || state._audioContext !== context || token !== state._crossfadeToken
          || state._crossfadeSchedule !== schedule || (schedule.isCurrent && !schedule.isCurrent())) {
        finish(false);
        return;
      }
      const sampledClock = context?.currentTime;
      const clockValue = Number(sampledClock) || 0;
      const observation = schedule.incomingClockObservation;
      if (observation) {
        const incoming = state._decks[schedule.incomingIndex];
        if (!state._transitionDiagnostics || state._userPaused || state._crossfadePausedByUser
            || incoming !== observation.audio || incoming.paused || incoming.ended || incoming.seeking
            || !observation.isCurrent()) {
          delete schedule.incomingClockObservation;
        } else {
          const incomingTime = incoming.currentTime;
          if (!Number.isFinite(incomingTime) || incomingTime < observation.scheduledTime) {
            delete schedule.incomingClockObservation;
          } else if (observation.progressAlreadyAtSchedule || incomingTime > observation.scheduledTime) {
            // This is sampled media-clock movement, not proof of audible output.
            // Already-running media has an unknown first-advance time before this sample.
            delete schedule.incomingClockObservation;
            const observedAt = typeof performance !== 'undefined' && typeof performance.now === 'function'
              ? performance.now() : null;
            recordTransitionDiagnostic('incoming-clock-progress', {
              outgoingIndex: schedule.outgoingIndex, incomingIndex: schedule.incomingIndex,
              token: observation.token, crossfadeToken: token,
              progressAlreadyAtSchedule: observation.progressAlreadyAtSchedule,
              observationElapsedMs: Number.isFinite(observedAt) && Number.isFinite(observation.scheduledAt)
                ? observedAt - observation.scheduledAt : undefined,
              audioClockFromFadeStartMs: Number.isFinite(sampledClock)
                ? (sampledClock - schedule.startTime) * 1000 : undefined,
              incomingBaselineTime: observation.baselineTime, incomingScheduledTime: observation.scheduledTime,
              incomingCurrentTime: incomingTime, incomingAdvanceMs: (incomingTime - observation.baselineTime) * 1000,
            });
          }
        }
      }
      if (state._userPaused || state._crossfadePausedByUser) {
        lastClockValue = clockValue;
        lastClockAdvanceAt = Date.now();
      } else if (clockValue >= schedule.endTime - 0.005) {
        finish(true);
        return;
      } else if (clockValue > lastClockValue + 0.005) {
        lastClockValue = clockValue;
        lastClockAdvanceAt = Date.now();
      } else if (Date.now() - lastClockAdvanceAt >= 2500) {
        recordPlaybackDiagnostic('crossfade-clock-stall', {
          attemptId: schedule.attemptId,
          reason: 'audio-context-clock-stalled',
          outgoingIndex: schedule.outgoingIndex,
          incomingIndex: schedule.incomingIndex,
          elapsed: Math.round(Math.max(0, clockValue - schedule.startTime) * 10) / 10,
          duration: schedule.duration,
          contextState: context?.state || 'missing',
          incomingPaused: Boolean(state._decks[schedule.incomingIndex]?.paused),
          incomingCurrentTime: Number(state._decks[schedule.incomingIndex]?.currentTime) || 0,
          incomingReadyState: Number(state._decks[schedule.incomingIndex]?.readyState) || 0,
          incomingNetworkState: Number(state._decks[schedule.incomingIndex]?.networkState) || 0,
        });
        finish(false);
        return;
      }
      timer = setTimeout(poll, 80);
    };
    poll();
  });
}

function settleScheduledCrossfade() {
  const schedule = state._crossfadeSchedule;
  if (!schedule || typeof schedule.resolve !== 'function') return;
  if (!state.active || (schedule.isCurrent && !schedule.isCurrent())) {
    schedule.resolve(false);
    return;
  }
  const now = Date.now();
  const clockValue = Number(state._audioContext?.currentTime) || 0;
  const incoming = state._decks[schedule.incomingIndex];
  const incomingTime = Number(incoming?.currentTime) || 0;

  if (state._userPaused || state._crossfadePausedByUser) {
    schedule.lastClockValue = clockValue;
    schedule.lastClockAdvanceAt = now;
    schedule.lastIncomingTime = incomingTime;
    schedule.lastIncomingAdvanceAt = now;
    return;
  }

  if (incoming?.paused && !incoming.ended && now - (schedule.createdAt ?? now) >= 350) {
    if (!schedule.faultRecorded) {
      schedule.faultRecorded = true;
      recordPlaybackDiagnostic('crossfade-deck-paused', {
        attemptId: schedule.attemptId,
        reason: 'incoming-deck-paused',
        outgoingIndex: schedule.outgoingIndex,
        incomingIndex: schedule.incomingIndex,
        duration: schedule.duration,
        contextState: state._audioContext?.state || 'missing',
        incomingPaused: Boolean(incoming.paused),
        incomingCurrentTime: incomingTime,
        readyState: Number(incoming.readyState) || 0,
        networkState: Number(incoming.networkState) || 0,
        mediaErrorCode: Number(incoming.error?.code) || 0,
        streamKind: diagnosticDeckStreamKind(incoming, schedule.incomingIndex),
      });
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

  const clockStalledFor = now - (schedule.lastClockAdvanceAt ?? schedule.createdAt ?? now);
  const mediaStalledFor = now - (schedule.lastIncomingAdvanceAt ?? schedule.createdAt ?? now);
  if (clockStalledFor >= 2500 && mediaStalledFor >= 2500) {
    if (!schedule.faultRecorded) {
      schedule.faultRecorded = true;
      recordPlaybackDiagnostic('crossfade-clock-stall', {
        attemptId: schedule.attemptId,
        reason: 'worker-clock-and-media-stalled',
        outgoingIndex: schedule.outgoingIndex,
        incomingIndex: schedule.incomingIndex,
        duration: schedule.duration,
        contextState: state._audioContext?.state || 'missing',
        clockStalledFor: Math.round(clockStalledFor),
        mediaStalledFor: Math.round(mediaStalledFor),
        currentTime: Math.round(clockValue * 1000) / 1000,
        incomingCurrentTime: incomingTime,
        incomingPaused: Boolean(incoming?.paused),
        readyState: Number(incoming?.readyState) || 0,
        networkState: Number(incoming?.networkState) || 0,
        mediaErrorCode: Number(incoming?.error?.code) || 0,
        streamKind: diagnosticDeckStreamKind(incoming, schedule.incomingIndex),
      });
    }
    schedule.resolve(false);
  }
}

function animateDeckCrossfadeFallback(outgoing, incoming, seconds, token) {
  const duration = Math.max(0.25, seconds);
  const startedAt = Number(incoming.currentTime) || 0;
  const epoch = state._playbackEpoch;
  const signal = state._playbackAbort.signal;
  const outgoingIndex = state._decks.indexOf(outgoing);
  const incomingIndex = state._decks.indexOf(incoming);
  const outgoingToken = state._deckPrepareTokens[outgoingIndex];
  const incomingToken = state._deckPrepareTokens[incomingIndex];
  const curve = state.crossfadeCurve;
  let lastWallAt = Date.now();
  let activeWallMs = 0;
  let wasPaused = Boolean(state._userPaused || state._crossfadePausedByUser);
  return new Promise((resolve, reject) => {
    let timer;
    let settled = false;
    const finish = (completed, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(completed);
    };
    const onAbort = () => finish(false);
    signal.addEventListener('abort', onAbort, { once: true });
    const poll = () => {
      if (settled) return;
      if (!state.active || state._playbackEpoch !== epoch || signal.aborted
          || token !== state._crossfadeToken || state._decks[outgoingIndex] !== outgoing
          || state._decks[incomingIndex] !== incoming
          || state._deckPrepareTokens[outgoingIndex] !== outgoingToken
          || state._deckPrepareTokens[incomingIndex] !== incomingToken) {
        finish(false);
        return;
      }
      const now = Date.now();
      const userPaused = Boolean(state._userPaused || state._crossfadePausedByUser);
      if (!wasPaused && !userPaused) activeWallMs += Math.max(0, now - lastWallAt);
      lastWallAt = now;
      wasPaused = userPaused;
      if (!userPaused) {
        const elapsed = Math.max(0, (Number(incoming.currentTime) || 0) - startedAt);
        const t = Math.max(0, Math.min(1, elapsed / duration));
        try {
          const [outgoingGain, incomingGain] = crossfadeGains(t, curve);
          state._deckGains[outgoingIndex] = outgoingGain;
          state._deckGains[incomingIndex] = incomingGain;
          syncCrossfadeVolume();
        } catch (error) { finish(false, error); return; }
        if (t >= 1) { finish(true); return; }
        if (activeWallMs > (duration + 5) * 1000) { finish(false); return; }
      }
      timer = setTimeout(poll, 50);
    };
    poll();
  });
}

async function animateDeckCrossfade(outgoing, incoming, seconds, token, diagnosticTrace = null, incomingBaselineTime = null) {
  // AudioContext.currentTime can be cached for this entire JS task. Anchor
  // before status/graph/curve work, then account for monotonic elapsed time.
  const entryContext = state._audioContext;
  const entryWasRunning = entryContext?.state === 'running';
  const pauseGeneration = state._crossfadePauseGeneration || 0;
  let anchorAudioTime = Number(entryContext?.currentTime);
  let anchorMonotonicMs = typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now() : null;
  const outgoingRemaining = Number.isFinite(outgoing.duration)
    ? Math.max(0, outgoing.duration - (Number(outgoing.currentTime) || 0)) : Infinity;
  const incomingHalfRemaining = Number.isFinite(incoming.duration)
    ? Math.max(0, incoming.duration / 2 - (Number(incoming.currentTime) || 0)) : Infinity;
  const epoch = state._playbackEpoch;
  const signal = state._playbackAbort.signal;
  const foreground = state._playbackRequest;
  const duration = Math.max(0, Number(seconds) || 0);
  let windowDuration = Math.min(duration, outgoingRemaining, incomingHalfRemaining);
  const graphAvailable = ensureAutoLevelAudioGraph();
  const outgoingIndex = state._decks.indexOf(outgoing);
  const incomingIndex = state._decks.indexOf(incoming);
  if (outgoingIndex < 0 || incomingIndex < 0) return null;
  const outgoingToken = state._deckPrepareTokens[outgoingIndex];
  const incomingToken = state._deckPrepareTokens[incomingIndex];
  const context = state._audioContext;
  const wasRunning = context === entryContext && entryWasRunning;
  if (context !== entryContext) anchorAudioTime = Number(context?.currentTime);
  const curve = state.crossfadeCurve;
  const ownsTransition = () => state.active && state._playbackEpoch === epoch
    && !signal.aborted && state._playbackRequest === foreground && token === state._crossfadeToken
    && state._decks[outgoingIndex] === outgoing && state._decks[incomingIndex] === incoming
    && state._deckPrepareTokens[outgoingIndex] === outgoingToken
    && state._deckPrepareTokens[incomingIndex] === incomingToken && state._audioContext === context;
  if (!ownsTransition() || state._userPaused) return null;
  if (state._transitionDiagnostics && !Number.isFinite(incomingBaselineTime)) incomingBaselineTime = incoming.currentTime;
  let schedule = null;
  let succeeded = false;
  state._crossfading = true;
  state._crossfadePausedByUser = false;
  let failureStage = 'crossfade-start';
  let recoveredSchedule = false;
  const startedAt = (diagnosticTrace || state._transitionDiagnostics) && typeof performance !== 'undefined'
    && typeof performance.now === 'function' ? performance.now() : 0;
  if (diagnosticTrace) {
    diagnosticTrace.stage = 'crossfade';
    diagnosticTrace.reason = 'handoff-started';
  }
  if (state._transitionDiagnostics) recordTransitionDiagnostic('fade-trigger', {
    outgoingIndex, incomingIndex, token: incomingToken, crossfadeToken: token, duration,
    incomingDuration: incoming.duration, remainingMs: (outgoing.duration - outgoing.currentTime) * 1000,
    crossfadeSeconds: state.crossfadeSeconds,
  });
  if (state._diagnosticBuild) {
    recordPlaybackDiagnostic('crossfade-started', {
      attemptId: diagnosticTrace?.attemptId,
      trackIndex: state._deckTrack,
      outgoingIndex,
      incomingIndex,
      duration,
      crossfadeCurve: curve,
      graphAvailable: Boolean(graphAvailable),
      crossfadeMode: graphAvailable ? 'audio-clock' : 'media-clock',
      contextState: context?.state || 'missing',
      outgoingPaused: Boolean(outgoing.paused),
      incomingPaused: Boolean(incoming.paused),
      outgoingCurrentTime: Number(outgoing.currentTime) || 0,
      incomingCurrentTime: Number(incoming.currentTime) || 0,
      streamKind: diagnosticDeckStreamKind(incoming, incomingIndex),
    });
  }
  const reportHandoffFailure = (stage, failureReason, error = null) => {
    if (state._transitionDiagnostics) recordTransitionDiagnostic('fade-fallback', {
      outgoingIndex, incomingIndex, token: incomingToken, crossfadeToken: token, duration,
      ready: false, incomingPaused: Boolean(incoming.paused), incomingCurrentTime: incoming.currentTime,
    });
    if (diagnosticTrace) {
      diagnosticTrace.stage = 'crossfade';
      diagnosticTrace.reason = failureReason;
      if (error) diagnosticTrace.errorName = playbackErrorName(error);
    }
    if (state._diagnosticBuild) {
      recordPlaybackDiagnostic('crossfade-handoff-failed', {
        attemptId: diagnosticTrace?.attemptId,
        trackIndex: state._deckTrack,
        failureStage: stage,
        failureReason,
        errorName: error ? playbackErrorName(error) : '',
        outgoingIndex,
        incomingIndex,
        duration,
        crossfadeCurve: curve,
        graphAvailable: Boolean(graphAvailable),
        crossfadeMode: graphAvailable ? 'audio-clock' : 'media-clock',
        contextState: context?.state || 'missing',
        incomingPaused: Boolean(incoming.paused),
        incomingCurrentTime: Number(incoming.currentTime) || 0,
        elapsedMs: typeof performance !== 'undefined'
          ? Math.max(0, Math.round(performance.now() - startedAt)) : 0,
      });
    }
  };
  try {
    setCrossfadeStatus('mixing');
    let completed;
    if (graphAvailable && state._deckAudioGraphs[outgoingIndex] && state._deckAudioGraphs[incomingIndex]) {
      failureStage = 'audio-context-resume';
      const resumed = await resumeAudioGraph(signal, diagnosticTrace);
      if (!ownsTransition() || state._userPaused) return null;
      if (!resumed) {
        reportHandoffFailure(failureStage, 'audio-context-resume-failed');
        return false;
      }
      if (!wasRunning || (state._crossfadePauseGeneration || 0) !== pauseGeneration) {
        // Never extrapolate across suspension/resume or a replacement graph.
        if (wasRunning) windowDuration = Math.max(0, anchorAudioTime + windowDuration - Number(context.currentTime));
        anchorAudioTime = Number(context.currentTime);
        anchorMonotonicMs = typeof performance !== 'undefined' && typeof performance.now === 'function'
          ? performance.now() : null;
      }
      const plan = crossfadeAutomationPlan(curve);
      const schedulingAt = typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now() : null;
      let timing = crossfadeAutomationTiming(context, anchorAudioTime, anchorMonotonicMs, windowDuration, schedulingAt);
      if (timing) {
        // Fresh media samples may reveal more consumption than the elapsed
        // estimate. Never extend the original window or either media budget.
        const sampledRemaining = Math.min(
          Number.isFinite(outgoing.duration) ? Math.max(0, outgoing.duration - outgoing.currentTime) : Infinity,
          Number.isFinite(incoming.duration) ? Math.max(0, incoming.duration / 2 - incoming.currentTime) : Infinity,
        );
        windowDuration = Math.min(windowDuration, timing.estimatedNow - anchorAudioTime + sampledRemaining);
        timing = crossfadeAutomationTiming(context, anchorAudioTime, anchorMonotonicMs, windowDuration, schedulingAt);
      }
      if (!timing) {
        // The existing schedule-recovery handoff retains a playing incoming
        // track. An exhausted overlap is not a failed playback/track rotation.
        completed = false;
      } else {
        const { startTime, endTime } = timing;
        schedule = {
          token, attemptId: diagnosticTrace?.attemptId, outgoingIndex, incomingIndex, curve,
          startTime, duration: timing.duration, endTime, createdAt: Date.now(),
          lastClockValue: context.currentTime, lastClockAdvanceAt: Date.now(),
          lastIncomingTime: Number(incoming.currentTime) || 0, lastIncomingAdvanceAt: Date.now(),
          faultRecorded: false,
        };
        state._crossfadeSchedule = schedule;
        failureStage = 'audio-clock-schedule';
        schedulePairedCrossfade(state._deckAudioGraphs[outgoingIndex].mixGain.gain,
          state._deckAudioGraphs[incomingIndex].mixGain.gain, plan, startTime, timing.duration);
        if (state._transitionDiagnostics) {
          // Sample after BOTH submissions. The monotonic estimate accounts for
          // cached clocks; it does not prove render-thread delivery or output.
          const submittedClock = context.currentTime;
          const scheduledAt = typeof performance !== 'undefined' && typeof performance.now === 'function'
            ? performance.now() : null;
          const submittedElapsed = context.state === 'running' && Number.isFinite(anchorMonotonicMs) && Number.isFinite(scheduledAt)
            ? Math.max(0, scheduledAt - anchorMonotonicMs) / 1000 : 0;
          const estimatedSubmittedClock = Math.max(Number.isFinite(submittedClock) ? submittedClock : anchorAudioTime,
            anchorAudioTime + submittedElapsed);
          const scheduledTime = incoming.currentTime;
          if (Number.isFinite(incomingBaselineTime) && Number.isFinite(scheduledTime)
              && scheduledTime >= incomingBaselineTime) {
            schedule.incomingClockObservation = {
              audio: incoming, token: incomingToken, isCurrent: ownsTransition,
              baselineTime: incomingBaselineTime, scheduledTime, scheduledAt,
              progressAlreadyAtSchedule: scheduledTime > incomingBaselineTime,
            };
          }
          recordTransitionDiagnostic('fade-scheduled', {
            outgoingIndex, incomingIndex, token: incomingToken, crossfadeToken: token, duration: timing.duration, startTime,
            sampledSchedulingLeadMs: Number.isFinite(submittedClock) ? (startTime - submittedClock) * 1000 : undefined,
            schedulingSubmissionMs: Number.isFinite(scheduledAt) && Number.isFinite(schedulingAt)
              ? Math.max(0, scheduledAt - schedulingAt) : undefined,
            estimatedSchedulingLeadMs: Number.isFinite(estimatedSubmittedClock)
              ? (startTime - estimatedSubmittedClock) * 1000 : undefined,
            incomingBaselineTime, incomingScheduledTime: scheduledTime,
            progressAlreadyAtSchedule: schedule.incomingClockObservation?.progressAlreadyAtSchedule,
          });
        }
        completed = await waitForCrossfadeSchedule(schedule, token);
      }
    } else {
      failureStage = 'media-clock-fallback';
      if (state._transitionDiagnostics) recordTransitionDiagnostic('fade-fallback', {
        outgoingIndex, incomingIndex, token: incomingToken, crossfadeToken: token, duration,
      });
      completed = await animateDeckCrossfadeFallback(outgoing, incoming, duration, token);
    }
    if (!ownsTransition() || state._userPaused) return null;
    if (!completed) {
      recoveredSchedule = true;
      if (state._transitionDiagnostics) recordTransitionDiagnostic('fade-fallback', {
        outgoingIndex, incomingIndex, token: incomingToken, crossfadeToken: token, recoveredSchedule: true,
      });
      failureStage = 'crossfade-recovery-resume';
      if (diagnosticTrace) {
        diagnosticTrace.stage = 'crossfade';
        diagnosticTrace.reason = 'schedule-recovery';
      }
      // Media can report playing while its output graph is suspended. Resume
      // output even when no additional media play() call is necessary.
      const resumed = await resumeAudioGraph(signal, diagnosticTrace);
      if (!ownsTransition() || state._userPaused) return null;
      if (!resumed) {
        reportHandoffFailure(failureStage, 'audio-context-resume-failed');
        return false;
      }
      if (incoming.paused) {
        failureStage = 'incoming-deck-replay';
        const played = await playDeckWithDeadline(incoming, incomingIndex, signal,
          () => ownsTransition() && !state._userPaused, diagnosticTrace);
        if (!ownsTransition() || state._userPaused) return null;
        if (!played) {
          reportHandoffFailure(failureStage, 'incoming-play-failed');
          return false;
        }
      }
    }
    if (state._crossfadeSchedule === schedule) state._crossfadeSchedule = null;
    const now = context?.currentTime || 0;
    setAudioParamImmediately(state._deckAudioGraphs[outgoingIndex]?.mixGain.gain, 0, now);
    setAudioParamImmediately(state._deckAudioGraphs[incomingIndex]?.mixGain.gain, 1, now);
    outgoing.pause();
    state._deckGains[outgoingIndex] = 0;
    state._deckGains[incomingIndex] = 1;
    syncCrossfadeVolume();
    if (diagnosticTrace) {
      diagnosticTrace.stage = 'crossfade';
      diagnosticTrace.reason = 'handoff-completed';
    }
    if (state._diagnosticBuild) {
      recordPlaybackDiagnostic('crossfade-completed', {
        attemptId: diagnosticTrace?.attemptId,
        trackIndex: state._deckTrack,
        result: 'completed',
        outgoingIndex,
        incomingIndex,
        duration,
        crossfadeCurve: curve,
        graphAvailable: Boolean(graphAvailable),
        recoveredSchedule,
        crossfadeMode: graphAvailable ? 'audio-clock' : 'media-clock',
        elapsedMs: typeof performance !== 'undefined'
          ? Math.max(0, Math.round(performance.now() - startedAt)) : 0,
        contextState: context?.state || 'missing',
        incomingCurrentTime: Number(incoming.currentTime) || 0,
      });
    }
    if (state._transitionDiagnostics) recordTransitionDiagnostic('fade-completed', {
      outgoingIndex, incomingIndex, token: incomingToken, crossfadeToken: token, duration, recoveredSchedule,
      elapsedMs: typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now() - startedAt : undefined,
    });
    succeeded = true;
    return true;
  } catch (error) {
    if (!ownsTransition() || state._userPaused) return null;
    reportHandoffFailure(failureStage, 'handoff-exception', error);
    return false;
  } finally {
    if (ownsTransition()) {
      if (state._crossfadeSchedule === schedule) {
        schedule?.resolve?.(false);
        state._crossfadeSchedule = null;
      }
      state._crossfading = false;
      state._crossfadePausedByUser = Boolean(state._userPaused);
      try { setCrossfadeStatus(succeeded ? 'ready' : 'fallback'); } catch (_) {}
    }
  }
}
function destroyCrossfadePreflight(record) {
  const preflight = record?.preflight;
  if (!preflight) return;
  record.preflight = null;
  if (preflight.adopted) return;
  if (state._transitionDiagnostics) recordTransitionDiagnostic('preparation-cancelled', {
    playbackEpoch: record.epoch, trackIndex: record.nextTi, token: record.token, detached: true, ready: false,
  });
  try {
    if (preflight.onError) preflight.player?.off?.(preflight.events?.ERROR, preflight.onError);
  } catch (_) {}
  try { preflight.player?.destroy?.(); } catch (_) {}
}

function preflightCrossfadeHls(record, streamUrls) {
  if (!record || record.preflight || record.controller.signal.aborted) return;
  const streamUrl = streamUrls.find(isHlsStreamUrl);
  if (!streamUrl) return;
  const configuredFadeSeconds = Number(state.crossfadeSeconds) || 0;
  const currentAudio = state._decks[state._deckIndex];
  const mediaDuration = Number(currentAudio?.duration);
  const currentDuration = Number.isFinite(mediaDuration) && mediaDuration > 0
    ? mediaDuration : Number(state.meta[record.currentTi]?.durationMs) / 1000;
  if (configuredFadeSeconds <= 0 || !Number.isFinite(currentDuration)
      || currentDuration <= 0 || currentDuration > configuredFadeSeconds * 2) return;
  const HlsCtor = hlsJsConstructor();
  let supported = false;
  try { supported = Boolean(HlsCtor?.isSupported()); } catch (_) {}
  if (!supported) return;
  let player;
  try {
    player = new HlsCtor({ enableWorker: true, lowLatencyMode: false, startFragPrefetch: true });
    const preflight = {
      player, streamUrl, failed: false, adopted: false,
      events: HlsCtor.Events, onError: null,
    };
    if (state._transitionDiagnostics) observeTransitionHls(player, HlsCtor.Events, {
      trackIndex: record.nextTi, deckIndex: state._deckIndex === 0 ? 1 : 0,
      token: record.token, detached: true,
    });
    preflight.onError = (_event, data) => {
      if (record.preflight !== preflight || preflight.adopted || !data?.fatal) return;
      preflight.failed = true;
      destroyCrossfadePreflight(record);
    };
    player.on(HlsCtor.Events.ERROR, preflight.onError);
    record.preflight = preflight;
    if (state._transitionDiagnostics) recordTransitionDiagnostic('hls-load', {
      trackIndex: record.nextTi, deckIndex: state._deckIndex === 0 ? 1 : 0, token: record.token, detached: true,
    });
    player.loadSource(streamUrl);
  } catch (_) {
    if (record.preflight?.player === player) destroyCrossfadePreflight(record);
    else { try { player?.destroy?.(); } catch (_) {} }
  }
}


function warmUpcomingCrossfadeStreams() {
  // Resolve stream candidates during the fade; only load media after the outgoing deck is free.
  destroyCrossfadePreflight(state._crossfadeStreamWarmup);
  state._crossfadeStreamWarmup?.controller?.abort();
  state._crossfadeStreamWarmup = null;
  const nextTi = upcomingTrackIndex();
  if (!state.active || !Number.isInteger(state._deckTrack) || nextTi === undefined) return;
  const meta = state.meta[nextTi];
  if (!meta) return;
  const epoch = state._playbackEpoch;
  const currentTi = state._deckTrack;
  const sessionSignal = state._playbackAbort?.signal;
  const controller = new AbortController();
  const record = { epoch, currentTi, nextTi, meta, controller, promise: null, preflight: null };
  if (state._transitionDiagnostics) record.token = (state._deckPrepareTokens[state._deckIndex === 0 ? 1 : 0] || 0) + 1;
  const streamsStartedAt = state._transitionDiagnostics ? performance.now() : 0;
  record.isCurrent = () => state._crossfadeStreamWarmup === record
    && state.active && state._playbackEpoch === epoch
    && state._deckTrack === currentTi && state.meta[nextTi] === meta
    && upcomingTrackIndex() === nextTi;
  state._crossfadeStreamWarmup = record;
  const abort = () => {
    controller.abort();
    if (state._transitionDiagnostics && !record.preflight) recordTransitionDiagnostic('preparation-cancelled', {
      playbackEpoch: record.epoch, trackIndex: nextTi, token: record.token, detached: true, ready: false,
    });
    destroyCrossfadePreflight(record);
  };
  if (sessionSignal?.aborted) abort();
  else sessionSignal?.addEventListener('abort', abort, { once: true });
  record.promise = Promise.resolve().then(() => resolveCrossfadeStreams(meta, {
    signal: controller.signal,
    isCurrent: () => record.isCurrent(),
  })).then(urls => {
    if (state._transitionDiagnostics) recordTransitionDiagnostic('streams-resolved', {
      trackIndex: nextTi, token: record.token, detached: true,
      streamCandidateCount: urls.length, elapsedMs: performance.now() - streamsStartedAt,
    });
    if (state._crossfadeStreamWarmup === record && !controller.signal.aborted
        && record.isCurrent()) preflightCrossfadeHls(record, urls);
    return urls;
  }).catch(() => []).finally(() => {
    sessionSignal?.removeEventListener('abort', abort);
  });
}

async function prefetchUpcomingCrossfadeTrack() {
  if (!state.active || state._crossfading) return;
  const nextTi = upcomingTrackIndex();
  if (nextTi === undefined) return;
  const standby = state._deckIndex === 0 ? 1 : 0;
  const preparation = state._deckPreparations?.[standby];
  if (crossfadePreparationMatches(preparation, standby, nextTi)
      && preparation.pending && (!preparation.isCurrent || preparation.isCurrent())) {
    return preparation.promise;
  }
  const requestToken = ++state._crossfadePrefetchToken;
  const diagnosticTrace = state._diagnosticBuild ? createCustomStartTrace(nextTi) : null;
  const isCurrent = () => requestToken === state._crossfadePrefetchToken
    && state.active && !state._crossfading && standby !== state._deckIndex
    && upcomingTrackIndex() === nextTi;
  if (state.crossfadeSeconds > 0) setCrossfadeStatus('loading');
  let audio = null;
  let warmup = null;
  try {
    warmup = state._crossfadeStreamWarmup;
    const resolvedStreamPromise = warmup?.epoch === state._playbackEpoch
      && warmup.currentTi === state._deckTrack && warmup.nextTi === nextTi
      && warmup.meta === state.meta[nextTi] && upcomingTrackIndex() === nextTi
      ? warmup.promise : null;
    audio = await prepareCrossfadeDeck(standby, nextTi, {
      diagnosticTrace, isCurrent, warmup,
      ...(resolvedStreamPromise ? { resolvedStreamPromise } : {}),
    });
  } catch (error) {
    recordPlaybackDiagnostic('prefetch-failed', {
      attemptId: diagnosticTrace?.attemptId,
      trackIndex: nextTi,
      deckIndex: standby,
      reason: 'prefetch-exception',
      errorName: playbackErrorName(error),
      elapsedMs: diagnosticTrace
        ? Math.max(0, Math.round(performance.now() - diagnosticTrace.startedAt)) : 0,
    });
    destroyCrossfadePreflight(warmup);
    if (state._crossfadeStreamWarmup === warmup) {
      state._crossfadeStreamWarmup = null;
      warmup?.controller?.abort();
    }
    return null;
  }
  destroyCrossfadePreflight(warmup);
  if (state._crossfadeStreamWarmup === warmup) {
    state._crossfadeStreamWarmup = null;
    warmup?.controller?.abort();
  }
  if (!isCurrent()) return null;
  if (state._diagnosticBuild) {
    recordPlaybackDiagnostic('prefetch-result', {
      ...(customStartDiagnosticDetails(diagnosticTrace, audio ? 'started' : 'failed') || {}),
      trackIndex: nextTi,
      deckIndex: standby,
      result: audio ? 'ready' : 'not-ready',
    });
  }
  if (state.crossfadeSeconds > 0) setCrossfadeStatus(audio ? 'ready' : 'fallback');
  return audio;
}

function upcomingCrossfadeDeckReady() {
  const nextTi = upcomingTrackIndex();
  if (nextTi === undefined) return false;
  const standby = state._deckIndex === 0 ? 1 : 0;
  const audio = state._decks[standby];
  return Boolean(audio && state._deckTracks[standby] === nextTi
    && audio.readyState >= 2 && !state._deckHlsFailed?.[standby]);
}

function upcomingTrackIndex() {
  return state.playNext.length ? state.playNext[0] : state.queue[state.pos + 1];
}

function refreshUpcomingCrossfadePreparation() {
  const nextTi = upcomingTrackIndex();
  const warmup = state._crossfadeStreamWarmup;
  const warmupMatches = warmup && !warmup.controller.signal.aborted
    && warmup.epoch === state._playbackEpoch && warmup.currentTi === state._deckTrack
    && warmup.nextTi === nextTi && warmup.meta === state.meta[nextTi];
  // Both decks belong to a running fade. Queue changes may retire stale
  // lookahead, but must not invalidate either transition preparation token.
  if (!warmupMatches && warmup && !(
    state.busy && state._deckPreparations?.some(record =>
      record?.pending && record.foreground && record.warmup === warmup
      && crossfadePreparationMatches(record, record.index, record.ti)
      && (!record.isCurrent || record.isCurrent()))
  )) {
    destroyCrossfadePreflight(warmup);
    state._crossfadeStreamWarmup = null;
    warmup.controller.abort();
  }
  if (state._crossfading || state.busy) return;
  const standby = state._deckIndex === 0 ? 1 : 0;
  if (standby < 0 || standby >= state._decks.length || standby === state._deckIndex) return;
  const preparation = state._deckPreparations?.[standby];
  if (crossfadePreparationMatches(preparation, standby, nextTi)
      && (preparation.pending || upcomingCrossfadeDeckReady())) return;

  state._crossfadePrefetchToken++;
  state._deckPrepareTokens[standby] = (state._deckPrepareTokens[standby] || 0) + 1;
  state._deckPrepareAborts?.[standby]?.abort();
  if (state._deckTracks[standby] !== null) resetDeck(state._decks[standby], standby);
  if (state.active && currentDeckAudio()) {
    void prefetchUpcomingCrossfadeTrack().catch(error => recordPlaybackDiagnostic('prefetch-failed', { errorName: playbackErrorName(error) }));
  }
}

async function runPlaybackOperation(label, operation) {
  const epoch = state._playbackEpoch;
  state._diagnosticOperationSequence = (Number(state._diagnosticOperationSequence) || 0) + 1;
  const operationId = state._diagnosticOperationSequence;
  const request = { operationId };
  const startedAt = state._diagnosticBuild && typeof performance !== 'undefined' ? performance.now() : 0;
  state._playbackRequest = request;
  state.busy = true;
  const isCurrent = () => state.active && epoch === state._playbackEpoch && state._playbackRequest === request;
  let result = 'unknown';
  if (state._diagnosticBuild) {
    recordPlaybackDiagnostic('playback-operation-started', {
      operationId,
      operation: label,
      trackIndex: state.queue[state.pos] ?? null,
      queuePosition: state.pos,
      queueLength: state.queue.length,
      deckIndex: state._deckIndex,
      userPaused: Boolean(state._userPaused),
      audioContextState: state._audioContext?.state || 'missing',
    });
  }
  try {
    const value = await operation(isCurrent);
    result = value === true ? 'succeeded' : (value === false ? 'failed' : (value === null ? 'cancelled' : 'completed'));
    return value;
  } catch (error) {
    result = error?.name === 'AbortError' ? 'cancelled' : 'exception';
    if (isCurrent() && error?.name !== 'AbortError') {
      recordPlaybackDiagnostic('playback-operation-failed', {
        operationId, operation: label, errorName: playbackErrorName(error),
      });
    }
    return false;
  } finally {
    if (isCurrent()) {
      if (state._diagnosticBuild) {
        recordPlaybackDiagnostic('playback-operation-finished', {
          operationId,
          operation: label,
          result,
          elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
          suspended: Boolean(state.suspended),
          deckIndex: state._deckIndex,
          trackIndex: state._deckTrack,
          audioContextState: state._audioContext?.state || 'missing',
        });
      }
      state.busy = false;
      try { updateHub(); } catch (error) {
        recordPlaybackDiagnostic('playback-ui-failed', { operationId, operation: label, errorName: playbackErrorName(error) });
      }
    }
  }
}

async function playDeckWithDeadline(audio, index, signal, isCurrent, diagnosticTrace = null) {
  const source = audio.src;
  const preparation = state._deckPrepareTokens[index];
  const startedAt = diagnosticTrace && typeof performance !== 'undefined' ? performance.now() : 0;
  if (!isCurrent() || signal?.aborted || state._userPaused) return null;
  const playTokens = state._deckPlayTokens || (state._deckPlayTokens = []);
  const playToken = (playTokens[index] || 0) + 1;
  playTokens[index] = playToken;
  let abandoned = false;
  if (diagnosticTrace) {
    diagnosticTrace.stage = 'audio-play';
    diagnosticTrace.reason = 'play-pending';
  }
  try {
    await withDeadline(() => {
      const playing = audio.play();
      Promise.resolve(playing).then(() => {
        const eligibleSource = !audio.src || (state._deckPrepareTokens[index] === preparation && audio.src === source);
        if ((abandoned || !isCurrent() || state._userPaused)
            && state._deckPlayTokens[index] === playToken
            && state._decks[index] === audio && eligibleSource) {
          try { audio.pause(); } catch (error) {
            recordPlaybackDiagnostic('late-play-cleanup-failed', { error: playbackErrorName(error) });
          }
        }
      }, () => {});
      return playing;
    }, 5000, signal);
    if (!isCurrent() || state._userPaused) return null;
    if (diagnosticTrace) {
      diagnosticTrace.reason = 'play-fulfilled';
      diagnosticTrace.playElapsedMs = typeof performance !== 'undefined'
        ? Math.max(0, Math.round(performance.now() - startedAt)) : 0;
    }
    return true;
  } catch (error) {
    const owned = isCurrent();
    if (diagnosticTrace) {
      diagnosticTrace.stage = 'audio-play';
      diagnosticTrace.reason = error?.name === 'TimeoutError' ? 'play-timeout' : 'play-rejected';
      diagnosticTrace.errorName = playbackErrorName(error);
      diagnosticTrace.playElapsedMs = typeof performance !== 'undefined'
        ? Math.max(0, Math.round(performance.now() - startedAt)) : 0;
    }
    if (owned && state._deckPlayTokens[index] === playToken
        && state._decks[index] === audio && audio.src === source) {
      abandoned = true;
      // Abort pending media startup without discarding the recovery owner.
      try { audio.pause(); audio.load(); } catch (_) {}
    }
    if (!owned || signal?.aborted || state._userPaused) return null;
    throw error;
  }
}

async function playWithCrossfadeDeck(ti, countPlay, requestedFade, diagnosticTrace = null) {
  const epoch = state._playbackEpoch;
  const request = state._playbackRequest;
  const signal = state._playbackAbort?.signal;
  const meta = state.meta[ti];
  const isCurrent = () => state.active && epoch === state._playbackEpoch
    && state._playbackRequest === request && state.meta[ti] === meta && !signal?.aborted;
  if (!isCurrent()) return null;
  if (state._transitionDiagnostics) {
    const observedOutgoing = state._decks[state._deckIndex];
    recordTransitionDiagnostic('transition-requested', {
      trackIndex: ti, outgoingIndex: state._deckIndex, incomingIndex: state._deckIndex === 0 ? 1 : 0,
      token: state._deckPrepareTokens[state._deckIndex === 0 ? 1 : 0],
      crossfadeSeconds: state.crossfadeSeconds, crossfadeDuration: requestedFade,
      incomingDuration: Number(meta?.durationMs) / 1000,
      remainingMs: observedOutgoing ? (observedOutgoing.duration - observedOutgoing.currentTime) * 1000 : 0,
    });
  }
  if (meta?.requiresNativePlayback) {
    if (diagnosticTrace) {
      diagnosticTrace.stage = 'native-fallback';
      diagnosticTrace.reason = 'native-fallback-required';
      diagnosticTrace.nativeFallbackReason = meta.nativePlaybackReason || 'preview-only';
    }
    return false;
  }
  if (state.autoLevel || state.eqEnabled || state.safetyClipper || state.crossfadeSeconds > 0
      || state._audioContext?.state === 'closed' || state._audioGraphFailed) {
    if (!ensureAutoLevelAudioGraph()) {
      if (diagnosticTrace) {
        diagnosticTrace.stage = 'audio-graph';
        diagnosticTrace.audioGraphPhase = 'playback';
        diagnosticTrace.audioGraphReason = 'graph-unavailable';
        diagnosticTrace.reason = 'audio-graph-unavailable';
      }
      return false;
    }
  }
  const outgoing = currentDeckAudio();
  const outgoingIndex = state._deckIndex;
  const incomingIndex = outgoingIndex === 0 ? 1 : 0;
  if (state.crossfadeSeconds > 0) setCrossfadeStatus('loading');
  let incoming = null;
  let canMix = false;
  let incomingBaselineTime = null;
  let ownsIncoming = isCurrent;
  const deferPaused = () => {
    if (isCurrent() && state._userPaused) state._pendingPlaybackTrack = { ti, countPlay, epoch };
    return null;
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!isCurrent()) return null;
    const prepareOptions = { forceRefresh: attempt > 0, signal, isCurrent, foreground: true };
    if (diagnosticTrace) prepareOptions.diagnosticTrace = diagnosticTrace;
    incoming = await prepareCrossfadeDeck(incomingIndex, ti, prepareOptions);
    if (!isCurrent()) return null;
    if (state._userPaused) return deferPaused();
    if (!incoming) {
      if (meta.requiresNativePlayback) {
        if (diagnosticTrace) {
          diagnosticTrace.stage = 'native-fallback';
          diagnosticTrace.reason = 'native-fallback-required';
          diagnosticTrace.nativeFallbackReason = meta.nativePlaybackReason || 'preview-only';
        }
        return false;
      }
      continue;
    }
    const preparedToken = state._deckPrepareTokens[incomingIndex];
    const source = incoming.src;
    ownsIncoming = () => isCurrent() && state._decks[incomingIndex] === incoming
      && state._deckPrepareTokens[incomingIndex] === preparedToken
      && state._deckTracks[incomingIndex] === ti && incoming.src === source;
    if (!ownsIncoming()) return null;
    canMix = Boolean(outgoing && state._decks[outgoingIndex] === outgoing
      && !outgoing.paused && !outgoing.ended && requestedFade > 0);
    incoming.currentTime = 0;
    state._deckGains[incomingIndex] = canMix ? 0 : 1;
    syncCrossfadeVolume();
    pauseSoundCloudTransport();
    pauseSoundCloud();
    try {
      if (diagnosticTrace) {
        diagnosticTrace.stage = 'audio-context-resume';
        diagnosticTrace.reason = 'resume-pending';
      }
      const resumed = await resumeAudioGraph(signal, diagnosticTrace);
      if (!ownsIncoming()) return null;
      if (state._userPaused) return deferPaused();
      if (!resumed) {
        if (diagnosticTrace) diagnosticTrace.reason = 'audio-context-resume-failed';
        throw new Error('Audio graph did not resume');
      }
      if (state._transitionDiagnostics) incomingBaselineTime = incoming.currentTime;
      const played = await playDeckWithDeadline(incoming, incomingIndex, signal, ownsIncoming, diagnosticTrace);
      if (!ownsIncoming()) return null;
      if (state._userPaused) return deferPaused();
      if (!played) return null;
      break;
    } catch (error) {
      if (!isCurrent() || state._decks[incomingIndex] !== incoming
          || state._deckPrepareTokens[incomingIndex] !== preparedToken) return null;
      if (diagnosticTrace) {
        diagnosticTrace.errorName = playbackErrorName(error);
        if (diagnosticTrace.stage === 'audio-context-resume' && diagnosticTrace.reason === 'resume-pending') {
          diagnosticTrace.reason = 'audio-context-resume-error';
        }
      }
      recordPlaybackDiagnostic('custom-start-retry', {
        attempt: attempt + 1,
        errorName: playbackErrorName(error),
        ...(diagnosticTrace ? {
          stage: diagnosticTrace.stage,
          reason: diagnosticTrace.reason,
        } : {}),
      });
      resetDeck(incoming, incomingIndex);
      incoming = null;
    }
  }
  if (!isCurrent()) return null;
  if (!incoming) {
    if (state.crossfadeSeconds > 0) setCrossfadeStatus('fallback');
    return false;
  }
  if (state._userPaused) return deferPaused();
  const token = ++state._crossfadeToken;
  if (outgoingIndex >= 0 && !canMix) {
    state._deckGains[outgoingIndex] = 0;
    state._deckGains[incomingIndex] = 1;
    syncCrossfadeVolume();
  }
  state._deckIndex = incomingIndex;
  state._deckTrack = ti;
  state._nativeTrack = null;
  installBetterFeedPipBridge();
  if (canMix) {
    warmUpcomingCrossfadeStreams();
    const mixed = await animateDeckCrossfade(outgoing, incoming, requestedFade, token, diagnosticTrace, incomingBaselineTime);
    if (!ownsIncoming() || state._crossfadeToken !== token) return null;
    if (state._userPaused) return deferPaused();
    if (mixed !== true) {
      return mixed === false ? false : null;
    }
  }
  else if (state._transitionDiagnostics) recordTransitionDiagnostic('transition-no-mix', {
    trackIndex: ti, outgoingIndex, incomingIndex, token: state._deckPrepareTokens[incomingIndex],
    crossfadeDuration: requestedFade, outgoingPaused: Boolean(outgoing?.paused), ended: Boolean(outgoing?.ended),
  });
  if (!ownsIncoming()) return null;
  if (outgoing && outgoing !== incoming && state._decks[outgoingIndex] === outgoing) resetDeck(outgoing, outgoingIndex);
  if (state.crossfadeSeconds > 0) setCrossfadeStatus('ready');
  state._pendingPlaybackTrack = null;
  state.lastTitle = meta?.title || '';
  state.lastProgress = 0;
  if (countPlay) trackPlayed(ti);
  clearTimeout(state._customPlaybackRetryTimer);
  state._customPlaybackRetryTimer = null;
  state.suspended = false;
  if (diagnosticTrace) {
    diagnosticTrace.stage = 'custom-deck';
    diagnosticTrace.reason = 'started';
  }
  if (isCurrent()) {
    void prefetchUpcomingCrossfadeTrack().catch(error =>
      recordPlaybackDiagnostic('prefetch-failed', { errorName: playbackErrorName(error) }));
  }
  setTimeout(() => {
    if (isCurrent()) { refreshPlayBtn(); updateProgressBar(); updateHub(); }
  }, 80);
  return true;
}

function trackPlayed(ti) {
  state.stats.played++;
  state.stats.playCounts[ti] = (state.stats.playCounts[ti] || 0) + 1;
}

function finalizeLeavingCurrentTrack(ti) {
  if (state.meta[ti]?.removedFromPlaylist) state.meta[ti].unavailable = true;
}

function recountRoundTotal() {
  const remaining = state.queue.slice(state.pos);
  const queued = new Set(remaining);
  const pending = new Set(state.playNext.filter(ti => !queued.has(ti)));
  state.roundTotal = state.roundPlayed + remaining.length + pending.size;
}

function consumeCurrentQueueTrack() {
  const justPlayed = state.queue[state.pos];
  if (justPlayed === undefined) return undefined;

  state.history.push(justPlayed);
  if (state.history.length > 100) state.history.shift();

  state.queue.splice(state.pos, 1);
  state.roundPlayed = Math.min(state.roundTotal, state.roundPlayed + 1);
  finalizeLeavingCurrentTrack(justPlayed);

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
  recountRoundTotal();

  return justPlayed;
}

function isLikedTracksPage(url = location.href) {
  const parts = soundCloudPathParts(url);
  return Boolean(parts && parts.length === 2 && parts[1] === 'likes');
}

function currentPageTrackElements() {
  const elements = [
    ...document.querySelectorAll('.trackList__item, .soundList__item, li.sc-list-item, .badgeList__item'),
  ];

  // Likes cards lack a stable list-item class; locate them by action controls.
  if (isLikedTracksPage()) {
    for (const control of document.querySelectorAll('.soundActions .sc-button-more, button[title="More"]')) {
      const card = control.closest('.sound');
      if (card && getLink(card)) elements.push(card);
    }
  }

  const seen = new Set();
  return elements.filter(el => {
    const id = trackCacheKey(getMeta(el)) || el;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function beginCollectionRequest(sourcePage, ownsLoading = true, ownsBusy = false) {
  cancelCollectionRequest();
  const controller = new AbortController();
  const playbackSignal = state._playbackAbort.signal;
  let request;
  const abort = () => {
    controller.abort();
    if (request) finishCollectionRequest(request);
  };
  playbackSignal.addEventListener('abort', abort, { once: true });
  request = {
    sourcePage, epoch: ++state._collectionEpoch,
    playbackEpoch: state._playbackEpoch, routeEpoch: state._routeEpoch || 0,
    signal: controller.signal, controller, playbackSignal, abort, ownsLoading, ownsBusy,
  };
  state._collectionRequest = request;
  if (ownsLoading) state.loading = true;
  if (ownsBusy) state.busy = true;
  return request;
}

function collectionRequestCurrent(request) {
  return !request.signal.aborted && state._collectionRequest === request
    && request.epoch === state._collectionEpoch && request.playbackEpoch === state._playbackEpoch
    && request.routeEpoch === (state._routeEpoch || 0)
    && playlistBase(location.href) === playlistBase(request.sourcePage);
}

function finishCollectionRequest(request) {
  request.playbackSignal.removeEventListener('abort', request.abort);
  if (state._collectionRequest !== request) return;
  state._collectionRequest = null;
  if (request.ownsLoading) state.loading = false;
  if (request.ownsBusy) state.busy = false;
  try { updateHub(); } catch (_) {}
}

function cancelCollectionRequest() {
  const request = state._collectionRequest;
  if (!request) return;
  request.controller.abort();
  finishCollectionRequest(request);
}

async function loadTracks(request = null) {
  const sourcePage = request?.sourcePage || location.href;
  const currentRequest = () => !request || collectionRequestCurrent(request);
  const pause = ms => request ? withDeadline(() => wait(ms), ms + 1000, request.signal) : wait(ms);
  const preserveScrolledLikes = isLikedTracksPage(sourcePage);
  const seen = new Map();
  let current = [];
  const collect = () => {
    if (!currentRequest()) return;
    current = currentPageTrackElements();
    if (!preserveScrolledLikes) return;
    for (const el of current) {
      const id = trackCacheKey(getMeta(el));
      if (id && !seen.has(id)) seen.set(id, el);
    }
  };

  for (let i = 0; i < 20; i++) {
    collect();
    if ((preserveScrolledLikes ? seen.size : current.length) > 0) break;
    await pause(500);
    if (!currentRequest()) return [];
  }
  let last = 0, stable = 0, iters = 0;
  while (stable < 2 && iters < 60) {
    window.scrollTo(0, document.body.scrollHeight);
    await pause(900);
    if (!currentRequest()) return [];
    collect();
    const n = preserveScrolledLikes ? seen.size : current.length;
    n === last ? stable++ : (stable = 0, last = n);
    iters++;
  }
  window.scrollTo(0, 0);
  return preserveScrolledLikes ? [...seen.values()] : current;
}

function bindCurrentPageElements(pageEls) {
  const identities = trackIdentityIndex(state.meta);
  const rows = soundCloudRowsByLink(pageEls);
  state.els = state.meta.map(meta => {
    const el = matchingSoundCloudRow(meta, rows, identities);
    if (el && !meta.removedFromPlaylist) delete meta.unavailable;
    return el;
  });
}

function trackAvailable(ti) {
  const meta = state.meta[ti];
  return Boolean(meta && !meta.unavailable && (meta.sourcePage || state.els[ti]));
}

async function playWithSoundCloudSession(ti, countPlay = true, diagnosticTrace = null) {
  const epoch = state._playbackEpoch;
  const request = state._playbackRequest;
  const signal = state._playbackAbort?.signal;
  const meta = state.meta[ti];
  const el = boundSoundCloudRow(ti);
  const isCurrent = () => state.active && epoch === state._playbackEpoch && state._playbackRequest === request
    && state.meta[ti] === meta && !signal?.aborted;
  if (!isCurrent()) return null;
  if (!meta?.requiresNativePlayback) return false;
  if (!el || !document.body.contains(el)) {
    recordPlaybackDiagnostic('native-fallback-unavailable', {
      attemptId: diagnosticTrace?.attemptId,
      trackIndex: ti,
      reason: el ? 'track-element-detached' : 'track-element-missing',
      elementFound: Boolean(el),
      elementAttached: Boolean(el && document.body.contains(el)),
    });
    return false;
  }
  if (state._userPaused) return null;
  stopCrossfadeDecks();
  pauseSoundCloudTransport();
  pauseSoundCloud();
  state.suspended = false;
  let started = false;
  let buttonFound = false;
  let clickIssued = false;
  let nativeAudioFound = false;
  let playerMatched = false;
  let nativeTransportPaused = null;
  let pollCount = 0;
  state._nativeTrack = ti;
  recordPlaybackDiagnostic('native-fallback-started', {
    attemptId: diagnosticTrace?.attemptId,
    trackIndex: ti,
    reason: meta.nativePlaybackReason || 'preview-only',
    elementFound: true,
    elementAttached: true,
    pollLimit: 20,
  });
  try {
    el.scrollIntoView({ block: 'center', behavior: motionIsInstant() ? 'instant' : 'smooth' });
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    await withDeadline(() => wait(80), 1000, signal);
    if (!isCurrent() || state._nativeTrack !== ti || state._userPaused) return null;
    if (!document.body.contains(el) || !soundCloudLinkMatches(meta, getLink(el))) return false;
    const button = el.querySelector(
      'button.sc-button-play, .playButton, button[title*="Play"], .trackItem__coverArt, .sound__coverArt',
    ) || el.querySelector('.trackItem__trackTitle, .soundTitle__title, .sc-link-primary');
    buttonFound = Boolean(button);
    if (!buttonFound) {
      recordPlaybackDiagnostic('native-fallback-unavailable', {
        attemptId: diagnosticTrace?.attemptId,
        trackIndex: ti,
        reason: 'play-button-missing',
        elementFound: true,
        elementAttached: true,
        buttonFound: false,
        clickIssued: false,
      });
      return false;
    }
    button.click();
    clickIssued = true;
    recordPlaybackDiagnostic('native-fallback-command-issued', {
      attemptId: diagnosticTrace?.attemptId,
      trackIndex: ti,
      reason: meta.nativePlaybackReason || 'preview-only',
      buttonFound,
      clickIssued,
      pollLimit: 20,
    });
    for (let attempt = 0; attempt < 20; attempt++) {
      pollCount = attempt + 1;
      await withDeadline(() => wait(150), 1000, signal);
      if (!isCurrent() || state._nativeTrack !== ti || state._userPaused) return null;
      const nativeAudio = [...document.querySelectorAll('audio')]
        .find(audio => !isTrueShuffleAudio(audio) && !audio.paused && audio.currentSrc);
      nativeAudioFound = Boolean(nativeAudio);
      playerMatched = soundCloudPlayerMatches(meta);
      nativeTransportPaused = soundCloudPaused();
      if (playerMatched && (nativeAudioFound || nativeTransportPaused === false)) {
        started = true;
        break;
      }
    }
    if (!started) {
      recordPlaybackDiagnostic('native-track-not-acknowledged', {
        attemptId: diagnosticTrace?.attemptId,
        trackIndex: ti,
        reason: meta.nativePlaybackReason || 'preview-only',
        buttonFound,
        clickIssued,
        pollCount,
        playerMatched,
        nativeAudioFound,
        nativeTransportPaused,
      });
      return false;
    }
    state._pendingPlaybackTrack = null;
    state.lastTitle = meta.title || playerTitle();
    state.lastProgress = 0;
    state.suspended = false;
    if (countPlay) trackPlayed(ti);
    recordPlaybackDiagnostic('native-fallback-succeeded', {
      attemptId: diagnosticTrace?.attemptId,
      trackIndex: ti,
      reason: meta.nativePlaybackReason || 'preview-only',
      buttonFound,
      clickIssued,
      pollCount,
      playerMatched,
      nativeAudioFound,
      nativeTransportPaused,
    });
    if (!state._nativeSessionNoticeShown) {
      state._nativeSessionNoticeShown = true;
      showMergeToast('SoundCloud playback for this track; True Shuffle crossfade and audio processing are paused');
    }
    setTimeout(() => {
      if (isCurrent()) { refreshPlayBtn(); updateProgressBar(); updateHub(); }
    }, 80);
    return true;
  } catch (error) {
    if (!isCurrent() || state._nativeTrack !== ti || signal?.aborted) return null;
    recordPlaybackDiagnostic('native-start-failed', {
      attemptId: diagnosticTrace?.attemptId,
      trackIndex: ti,
      errorName: playbackErrorName(error),
      reason: meta.nativePlaybackReason || 'preview-only',
      buttonFound,
      clickIssued,
      pollCount,
    });
    return false;
  } finally {
    if (isCurrent() && state._nativeTrack === ti && state._userPaused) state._pendingPlaybackTrack = { ti, countPlay, epoch };
    if (isCurrent() && state._nativeTrack === ti && !started) {
      state._nativeTrack = null;
      pauseSoundCloudTransport();
      pauseSoundCloud();
    }
  }
}


async function playAt(idx, countPlay = true, attemptedCustomTracks = null, priorFailedCandidates = 0) {
  const epoch = state._playbackEpoch;
  const request = state._playbackRequest;
  const meta = state.meta[idx];
  const isCurrent = () => state.active && epoch === state._playbackEpoch
    && state._playbackRequest === request && state.meta[idx] === meta;
  if (!isCurrent() || !meta || !trackAvailable(idx)) return null;
  if (state._userPaused) {
    state._pendingPlaybackTrack = { ti: idx, countPlay, epoch };
    return null;
  }
  const diagnosticTrace = state._diagnosticBuild ? createCustomStartTrace(idx) : null;
  priorFailedCandidates = Math.max(0, Number(priorFailedCandidates) || 0);
  const requestedFade = currentDeckAudio()
    ? (state._crossfadePending
      ? Math.min(state.crossfadeSeconds, Number(state._crossfadePending) || state.crossfadeSeconds)
      : (state.crossfadeManual ? state.crossfadeSeconds : 0))
    : 0;
  const custom = await playWithCrossfadeDeck(idx, countPlay, requestedFade, diagnosticTrace);
  if (!isCurrent() || state._userPaused || custom === null) return null;
  if (custom) {
    if (state._diagnosticBuild) {
      const precedingFailedCandidates = priorFailedCandidates + (attemptedCustomTracks?.size || 0);
      recordPlaybackDiagnostic('custom-start-succeeded', {
        ...(customStartDiagnosticDetails(diagnosticTrace, 'started') || {}),
        trackIndex: idx,
        deckIndex: state._deckIndex,
        startedVia: 'custom-deck',
        outcome: 'started',
        precedingFailedCandidates,
      });
      if (precedingFailedCandidates) {
        recordPlaybackDiagnostic('custom-start-recovered', {
          attemptId: diagnosticTrace?.attemptId,
          trackIndex: idx,
          startedVia: 'custom-deck',
          precedingFailedCandidates,
        });
      }
    }
    return true;
  }
  stopCrossfadeDecks();
  setCrossfadeStatus('fallback');
  if (meta.requiresNativePlayback) {
    if (diagnosticTrace) {
      diagnosticTrace.stage = 'native-fallback';
      diagnosticTrace.reason = 'native-start-pending';
      diagnosticTrace.nativeFallbackReason = meta.nativePlaybackReason || 'preview-only';
    }
    const native = await playWithSoundCloudSession(idx, countPlay, diagnosticTrace);
    if (!isCurrent() || state._userPaused || native === null) return null;
    if (native) {
      if (diagnosticTrace) diagnosticTrace.nativeOutcome = 'started';
      if (state._diagnosticBuild) {
        const precedingFailedCandidates = priorFailedCandidates + (attemptedCustomTracks?.size || 0);
        recordPlaybackDiagnostic('custom-start-succeeded', {
          ...(customStartDiagnosticDetails(diagnosticTrace, 'started') || {}),
          trackIndex: idx,
          deckIndex: state._deckIndex,
          startedVia: 'native-fallback',
          outcome: 'started',
          nativeFallbackReason: meta.nativePlaybackReason || 'preview-only',
          precedingFailedCandidates,
        });
        if (precedingFailedCandidates) {
          recordPlaybackDiagnostic('custom-start-recovered', {
            attemptId: diagnosticTrace?.attemptId,
            trackIndex: idx,
            startedVia: 'native-fallback',
            precedingFailedCandidates,
          });
        }
      }
      return true;
    }
    if (diagnosticTrace) {
      diagnosticTrace.stage = 'native-fallback';
      diagnosticTrace.reason = 'native-start-failed';
      diagnosticTrace.nativeOutcome = 'not-acknowledged';
    }
  }
  const attempted = attemptedCustomTracks || new Set();
  attempted.add(idx);
  const currentQueueIndex = state.queue.indexOf(idx, state.pos);
  if (currentQueueIndex === state.pos && state.queue.length - state.pos > 1) {
    state.queue.splice(currentQueueIndex, 1);
    state.queue.push(idx);
  }
  const replacement = state.queue.slice(state.pos).find(ti => trackAvailable(ti) && !attempted.has(ti));
  if (state._diagnosticBuild) {
    const details = {
      trackIndex: idx,
      attempted: attempted.size,
      priorFailedCandidates,
      passExhausted: replacement === undefined,
      queuePosition: state.pos,
      queueLength: state.queue.length,
    };
    if (diagnosticTrace) Object.assign(details, customStartDiagnosticDetails(diagnosticTrace));
    recordPlaybackDiagnostic(
      replacement === undefined ? 'custom-start-exhausted' : 'custom-start-candidate-failed',
      details,
    );
  } else {
    recordPlaybackDiagnostic('custom-start-exhausted', { trackIndex: idx, attempted: attempted.size });
  }
  if (replacement !== undefined) return playAt(replacement, countPlay, attempted, priorFailedCandidates);
  state.suspended = true;
  showMergeToast('Custom playback unavailable — retrying shortly');
  updateHub();
  clearTimeout(state._customPlaybackRetryTimer);
  if (state._diagnosticBuild) {
    recordPlaybackDiagnostic('custom-retry-scheduled', {
      trackIndex: state.queue[state.pos] ?? null,
      attempted: attempted.size,
      delayMs: 5000,
      priorFailedCandidates: priorFailedCandidates + attempted.size,
      queuePosition: state.pos,
      queueLength: state.queue.length,
    });
  }
  const timer = setTimeout(() => {
    if (!isCurrent() || state._customPlaybackRetryTimer !== timer) return;
    state._customPlaybackRetryTimer = null;
    const retryTrack = state.queue[state.pos];
    if (state._diagnosticBuild) {
      recordPlaybackDiagnostic('custom-retry-fired', {
        trackIndex: retryTrack ?? null,
        queuePosition: state.pos,
        queueLength: state.queue.length,
        priorFailedCandidates: priorFailedCandidates + attempted.size,
        busy: Boolean(state.busy),
        userPaused: Boolean(state._userPaused),
      });
    }
    if (state.busy || state._userPaused) {
      if (state._diagnosticBuild) {
        recordPlaybackDiagnostic('custom-retry-skipped', {
          reason: state.busy ? 'busy' : 'user-paused',
          priorFailedCandidates: priorFailedCandidates + attempted.size,
          trackIndex: retryTrack ?? null,
        });
      }
      return;
    }
    if (retryTrack === undefined) {
      if (state._diagnosticBuild) {
        recordPlaybackDiagnostic('custom-retry-skipped', {
          reason: 'empty-queue',
          priorFailedCandidates: priorFailedCandidates + attempted.size,
        });
      }
      return;
    }
    state.suspended = false;
    void runPlaybackOperation('automatic retry', () =>
      playAt(retryTrack, countPlay, null, priorFailedCandidates + attempted.size));
  }, 5000);
  state._customPlaybackRetryTimer = timer;
  return false;
}

async function next(fromWatcher = false) {
  if (!state.active || state.busy || (fromWatcher && state._userPaused)) return;
  if (fromWatcher && state.manualAction) { state.manualAction = false; return; }
  if (!fromWatcher) state._userPaused = false;
  return runPlaybackOperation('next', async isCurrent => {
    const isQuickSkip = !fromWatcher && state.manualAction && state.lastProgress < 0.15;
    if (!state.queue.some(trackAvailable)) {
      state.suspended = true;
      return;
    }
    state.suspended = false;
    const justPlayed = state.queue[state.pos];
    if (isQuickSkip && justPlayed !== undefined) {
      state.skipCounts[justPlayed] = (state.skipCounts[justPlayed] || 0) + 1;
      if (state.skipCounts[justPlayed] >= 2) {
        state.priority[justPlayed] = 0.25;
        delete state.skipCounts[justPlayed];
      }
    }
    if (state.sleepTimer?.type === 'tracks') {
      state.sleepTimer.remaining--;
      updateSleepDisplay();
      if (state.sleepTimer.remaining <= 0) {
        state.sleepTimer = null;
        const sel = document.getElementById('tss-hub-sleep');
        if (sel) sel.value = 'off';
        pause();
        stop();
        renderList();
        return;
      }
    }
    consumeCurrentQueueTrack();
    if (state.pos >= state.queue.length) { stop(); renderList(); return; }
    await playAt(state.queue[state.pos]);
    if (!isCurrent()) return;
    badges();
    renderList();
  });
}

async function prevTrack() {
  if (!state.active || state.busy) return;
  let historyIndex;
  try {
    if (currentSec() > 3 || !state.history.length) { seekTo(0); return; }
    historyIndex = state.history.length - 1;
    while (historyIndex >= 0 && !trackAvailable(state.history[historyIndex])) historyIndex--;
    if (historyIndex < 0) { seekTo(0); return; }
  } catch (error) {
    recordPlaybackDiagnostic('playback-operation-failed', {
      operation: 'previous', errorName: playbackErrorName(error),
    });
    return false;
  }
  return runPlaybackOperation('previous', async isCurrent => {
    state._userPaused = false;
    state.manualAction = true;
    state._manualActionAt = Date.now();
    const prevTi = state.history.splice(historyIndex, 1)[0];
    const current = state.queue[state.pos];
    finalizeLeavingCurrentTrack(current);
    if (current !== undefined && !trackAvailable(current)) state.queue.splice(state.pos, 1);
    removePlayNextOccurrences(prevTi);
    const existingIdx = state.queue.indexOf(prevTi);
    if (existingIdx !== -1) {
      state.queue.splice(existingIdx, 1);
      if (existingIdx < state.pos) state.pos--;
    }
    state.queue.splice(state.pos, 0, prevTi);
    state.roundPlayed = Math.max(0, state.roundPlayed - 1);
    recountRoundTotal();
    refreshUpcomingCrossfadePreparation();
    await playAt(prevTi, false);
    if (!isCurrent()) return;
    badges();
    renderList();
  });
}

function moveSelectedTrackToCurrent(ti) {
  const current = state.queue[state.pos];
  if (current === ti) return false;

  if (current !== undefined) {
    state.history.push(current);
    if (state.history.length > 100) state.history.shift();
    state.queue.splice(state.pos, 1);
    state.roundPlayed = Math.min(state.roundTotal, state.roundPlayed + 1);
    finalizeLeavingCurrentTrack(current);
  }

  const targetIndex = state.queue.indexOf(ti);
  if (targetIndex !== -1) state.queue.splice(targetIndex, 1);
  state.queue.splice(state.pos, 0, ti);
  recountRoundTotal();
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
  if (!state.active || state.busy || !trackAvailable(ti)) return;
  state._userPaused = false;
  return runPlaybackOperation('jump', async isCurrent => {
    state.manualAction = true;
    state._manualActionAt = Date.now();
    state.suspended = false;
    removePlayNextOccurrences(ti);
    const moved = moveSelectedTrackToCurrent(ti);
    recountRoundTotal();
    await playAt(ti, moved);
    if (!isCurrent()) return;
    badges();
    renderList();
  });
}

function queueNext(ti) {
  const currentTi = Number.isInteger(state._deckTrack) ? state._deckTrack : state.queue[state.pos];
  if (!trackAvailable(ti) || ti === currentTi || state.playNext.includes(ti)) return false;
  state.playNext.push(ti);
  recountRoundTotal();
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

async function fetchLivePlaylistSnapshot(sourcePage, signal = null) {
  if (!/soundcloud\.com\/[^/]+\/sets\//.test(sourcePage || '')) return null;
  try {
    const requestUrl = new URL(sourcePage);
    requestUrl.searchParams.set('_tss_live_sync', String(Date.now()));
    const response = await fetchSoundCloudResource(requestUrl, 'text', {
      signal,
      cache: 'no-store',
      credentials: 'include',
      headers: { Accept: 'text/html' },
    });
    if (!response.ok) return null;
    return playlistSnapshotFromHtml(response.data, sourcePage);
  } catch (_) {
    return null;
  }
}

function mergeTrackMeta(primary, fallback) {
  if (!primary) return fallback ? { ...fallback } : null;
  const merged = { ...primary };
  for (const [key, value] of Object.entries(fallback || {})) {
    const current = merged[key];
    if (current == null || (typeof current === 'string' && (!current.trim() || current.trim() === '—'))
        || (Array.isArray(current) && !current.length)) {
      merged[key] = value;
    }
  }
  return merged;
}

async function resolveLiveTrackMeta(track, sourcePage, playlistPosition = null, signal = null) {
  const hydrated = metaFromSoundCloudTrack(track, sourcePage, playlistPosition);
  if (hydrated?.artist && hydrated.artist !== '—') return hydrated;

  const id = soundCloudInteger(track?.id, 1);
  if (id === null) return hydrated;
  const clientId = await discoverSoundCloudClientIdFromBundle(new Set(), { signal });
  if (!clientId || signal?.aborted) return hydrated;
  try {
    const response = await fetchSoundCloudResource(`https://api-v2.soundcloud.com/tracks/${id}?client_id=${encodeURIComponent(clientId)}`, 'json', { signal });
    if (!response.ok || signal?.aborted || !soundCloudTrackMatches(track, response.data)) return hydrated;
    return mergeTrackMeta(hydrated, metaFromSoundCloudTrack(response.data, sourcePage, playlistPosition));
  } catch (_) {
    return hydrated;
  }
}

async function resolvePlaylistSnapshotMetas(snapshot, sourcePage, existingMetas = [], signal = null) {
  if (!snapshot?.tracks?.length) return [];
  const resolvedById = new Map();
  const positionsById = new Map();
  const unresolvedIds = [];
  const existingIndex = trackIdentityIndex(existingMetas);

  snapshot.tracks.forEach((track, index) => {
    const id = Number(track.id);
    positionsById.set(id, index + 1);
    const existing = existingMetas[matchingTrackIndex(existingIndex, track)];
    const meta = mergeTrackMeta(existing, metaFromSoundCloudTrack(track, sourcePage, index + 1));
    if (meta) {
      meta.soundcloudId = id;
      meta.sourcePage = sourcePage;
      meta.playlistPosition = index + 1;
      resolvedById.set(id, meta);
    }
    if (!meta?.artist || meta.artist === '—') unresolvedIds.push(id);
  });

  if (unresolvedIds.length) {
    const clientId = await discoverSoundCloudClientIdFromBundle(new Set(), { signal });
    if (clientId) {
      for (let start = 0; start < unresolvedIds.length; start += 50) {
        if (signal?.aborted) break;
        const ids = unresolvedIds.slice(start, start + 50);
        try {
          const endpoint = new URL('https://api-v2.soundcloud.com/tracks');
          endpoint.searchParams.set('ids', ids.join(','));
          endpoint.searchParams.set('client_id', clientId);
          const response = await fetchSoundCloudResource(endpoint, 'json', { signal });
          if (!response.ok || signal?.aborted) continue;
          const tracks = response.data;
          if (!Array.isArray(tracks)) continue;
          tracks.forEach(track => {
            const id = Number(track?.id);
            const position = positionsById.get(id);
            if (!position) return;
            const meta = metaFromSoundCloudTrack(track, sourcePage, position);
            if (meta) {
              const existing = existingMetas[matchingTrackIndex(existingIndex, track)];
              resolvedById.set(id, mergeTrackMeta(existing, mergeTrackMeta(resolvedById.get(id), meta)));
            }
          });
        } catch (_) {}
      }
    }
  }

  return snapshot.tracks
    .map(track => resolvedById.get(Number(track.id)) || null)
    .filter(Boolean);
}

async function completePlaylistCollection(sourcePage, pageEls, snapshotPromise = null, signal = null) {
  const domByLink = new Map();
  for (const el of pageEls) {
    const meta = getMeta(el);
    const key = trackCacheKey(meta);
    if (!key) continue;
    const previous = domByLink.get(key);
    domByLink.set(key, { el: previous?.el || el, meta: mergeTrackMeta(previous?.meta, meta) });
  }
  const dom = [...domByLink.values()];
  const domMeta = dom.map(item => item.meta);
  const fallback = () => ({ els: dom.map(item => item.el), meta: dom.map(item => item.meta), complete: false });
  if (!/soundcloud\.com\/[^/]+\/sets\//.test(sourcePage || '')) {
    return { ...fallback(), complete: true };
  }
  const snapshot = await (snapshotPromise || fetchLivePlaylistSnapshot(sourcePage, signal));
  if (signal?.aborted || !snapshot?.complete) return fallback();
  const snapshotMeta = await resolvePlaylistSnapshotMetas(snapshot, sourcePage, domMeta, signal);
  if (signal?.aborted) return fallback();
  const resolved = new Map();
  const domIndex = trackIdentityIndex(domMeta);
  const snapshotIndex = trackIdentityIndex(snapshotMeta);
  const rows = soundCloudRowsByLink(pageEls);
  for (const meta of snapshotMeta) {
    const key = trackCacheKey(meta);
    if (!key || resolved.has(key)) continue;
    const matching = soundCloudPermalinkConflicts(meta, snapshotIndex)
      ? null : dom[matchingTrackIndex(domIndex, meta)];
    const merged = mergeTrackMeta(matching?.meta, meta);
    merged.sourcePage = sourcePage;
    merged.playlistPosition = meta.playlistPosition;
    if (meta.soundcloudId != null) merged.soundcloudId = meta.soundcloudId;
    resolved.set(key, { el: matchingSoundCloudRow(meta, rows, snapshotIndex), meta: merged });
  }
  const complete = resolved.size === new Set(snapshot.tracks.map(track => Number(track.id))).size;
  // A complete identity snapshot is authoritative; counts of rendered rows are not.
  if (!complete) {
    for (const [key, item] of domByLink) {
      if (!resolved.has(key)) resolved.set(key, item);
    }
  }
  const result = [...resolved.values()];
  return { els: result.map(item => item.el), meta: result.map(item => item.meta), complete };
}

function applyLiveQueueTracks(metas, pageEls = [], notify = true) {
  if (!state.active || state.suspended || !Array.isArray(metas) || !metas.length) return 0;

  const identities = trackIdentityIndex(state.meta);
  const rows = soundCloudRowsByLink(pageEls);
  const added = [];
  for (const meta of metas) {
    if (!trackCacheKey(meta) || matchingTrackIndex(identities, meta) !== undefined) continue;
    const ti = state.meta.length;
    state.meta.push(meta);
    indexTrackMeta(identities, meta, ti);
    state.els.push(matchingSoundCloudRow(meta, rows, identities));
    added.push(ti);
  }
  state.els.forEach((el, ti) => {
    if (el && soundCloudPermalinkConflicts(state.meta[ti], identities)) state.els[ti] = null;
  });
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

function registerLiveQueueSource(sourcePage, indices) {
  const source = playlistBase(sourcePage);
  if (!source) return;
  let members = state._liveSyncSources.get(source);
  if (!members) {
    members = new Set();
    state._liveSyncSources.set(source, members);
  }
  for (const ti of indices) members.add(ti);
}

function reviveRemovedQueueTrack(ti) {
  const meta = state.meta[ti];
  const restoreUpcoming = meta.removedFromPlaylist && meta._restoreUpcoming;
  delete meta.removedFromPlaylist;
  delete meta.unavailable;
  delete meta._restoreUpcoming;
  if (!restoreUpcoming || state.queue.slice(state.pos).includes(ti) || state.playNext.includes(ti)) return false;
  insertTracksRandomlyAfterCurrent(state.queue, state.pos, [ti]);
  recountRoundTotal();
  refreshUpcomingCrossfadePreparation();
  return true;
}

function reconcileLivePlaylistSnapshot(snapshot, sourcePage, pageEls = []) {
  const members = state._liveSyncSources.get(playlistBase(sourcePage));
  if (!members) return 0;
  const snapshotIds = new Set(snapshot.tracks.map(track => Number(track.id)));
  const positions = new Map(snapshot.tracks.map((track, index) => [Number(track.id), index + 1]));
  const identities = trackIdentityIndex(state.meta);
  const rows = soundCloudRowsByLink(pageEls);

  const currentTi = Number.isInteger(state._deckTrack) ? state._deckTrack : state.queue[state.pos];
  let removed = 0;

  for (const ti of snapshot.complete === true ? members : []) {
    const knownId = Number(state.meta[ti]?.soundcloudId);
    if (!Number.isFinite(knownId) || snapshotIds.has(knownId)) continue;
    members.delete(ti);
    let retained = false;
    for (const otherMembers of state._liveSyncSources.values()) {
      if (otherMembers.has(ti)) { retained = true; break; }
    }
    if (retained) continue;

    const meta = state.meta[ti];
    meta.removedFromPlaylist = true;
    if (ti !== currentTi) meta.unavailable = true;
    state.els[ti] = null;

    let removedQueued = 0;
    for (let qi = state.queue.length - 1; qi > state.pos; qi--) {
      if (state.queue[qi] !== ti) continue;
      removedQueued++;
      state.queue.splice(qi, 1);
    }
    const hadPlayNext = state.playNext.includes(ti);
    state.playNext = state.playNext.filter(pendingTi => pendingTi !== ti);
    if (removedQueued || hadPlayNext) meta._restoreUpcoming = true;
    removed++;
  }

  state.meta.forEach((meta, ti) => {
    const id = Number(meta?.soundcloudId);
    if (!members.has(ti) || !snapshotIds.has(id)) return;
    if (playlistBase(meta.sourcePage || '') === playlistBase(sourcePage)) {
      meta.playlistPosition = positions.get(id);
    }
    reviveRemovedQueueTrack(ti);
    const el = matchingSoundCloudRow(meta, rows, identities);
    if (el || soundCloudPermalinkConflicts(meta, identities)) state.els[ti] = el;
  });

  recountRoundTotal();
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
  const sources = state._liveSyncSources;
  const epoch = state._playbackEpoch;
  const signal = state._playbackAbort.signal;
  const routeEpoch = state._routeEpoch || 0;
  if (!state.active || state.loading || state.busy || state.suspended || !sources.size) return 0;
  if (state._liveSyncInFlight) return 0;

  const now = Date.now();
  if (!options.force && now - state._liveSyncLastCheck < LIVE_SYNC_INTERVAL_MS) return 0;
  state._liveSyncInFlight = true;
  state._liveSyncLastCheck = now;
  const currentQueue = () => state.active && !state.suspended && !state.loading && !state.busy
    && state._liveSyncSources === sources && state._playbackEpoch === epoch && !signal.aborted
    && (state._routeEpoch || 0) === routeEpoch;
  try {
    const snapshots = await Promise.all([...sources.keys()]
      .filter(sourcePage => /soundcloud\.com\/[^/]+\/sets\//.test(sourcePage))
      .map(async sourcePage => {
        try {
          return { sourcePage, snapshot: await fetchLivePlaylistSnapshot(sourcePage, signal) };
        } catch (_) {
          return { sourcePage, snapshot: null };
        }
      }));
    if (!currentQueue()) return 0;

    const knownIds = new Set(state.meta.map(meta => Number(meta?.soundcloudId)));
    const resolved = new Map();
    const updates = snapshots.filter(({ snapshot }) => Array.isArray(snapshot?.tracks));
    for (const { sourcePage, snapshot } of updates) {
      for (let index = 0; index < snapshot.tracks.length; index++) {
        const track = snapshot.tracks[index];
        const id = Number(track.id);
        if (!Number.isFinite(id) || knownIds.has(id) || resolved.has(id)) continue;
        let meta = null;
        try {
          meta = await resolveLiveTrackMeta(track, sourcePage, index + 1, signal);
        } catch (_) {}
        if (!currentQueue()) return 0;
        if (meta) resolved.set(id, meta);
      }
    }

    const pageSource = playlistBase(location.href);
    const pageEls = sources.has(pageSource)
      ? currentPageTrackElements()
      : [];
    const existingById = new Map();
    const identities = trackIdentityIndex(state.meta);
    state.meta.forEach((meta, ti) => {
      const id = Number(meta?.soundcloudId);
      if (Number.isFinite(id)) existingById.set(id, ti);
    });
    const metas = [];
    for (const [id, meta] of resolved) {
      if (!meta || existingById.has(id)) continue;
      const ti = matchingTrackIndex(identities, meta);
      if (ti === undefined) {
        if (meta.link && identities.byLink.has(normalizeTrackUrl(meta.link))) {
          state._streamCache.delete(normalizeTrackUrl(meta.link));
        }
        metas.push(meta);
      } else {
        state.meta[ti].soundcloudId = id;
        indexTrackMeta(identities, state.meta[ti], ti);
        existingById.set(id, ti);
      }
    }
    const firstNewIndex = state.meta.length;
    const added = applyLiveQueueTracks(metas, pageEls, false);
    for (let ti = firstNewIndex; ti < state.meta.length; ti++) {
      existingById.set(Number(state.meta[ti].soundcloudId), ti);
    }

    // Record membership in every source before removing anything. A track can
    // move between playlists, or belong to several, without leaving the queue.
    for (const { sourcePage, snapshot } of updates) {
      const members = sources.get(sourcePage);
      for (const track of snapshot.tracks) {
        const ti = existingById.get(Number(track.id));
        if (ti !== undefined) members.add(ti);
      }
    }
    let removed = 0;
    for (const { sourcePage, snapshot } of updates) {
      removed += reconcileLivePlaylistSnapshot(snapshot, sourcePage, sourcePage === pageSource ? pageEls : []);
    }
    if (removed) {
      refreshUpcomingCrossfadePreparation();
      updateHub();
    }
    if (updates.length) {
      badges();
      renderList();
    }
    showLiveSyncResult(added, removed);
    return added;
  } finally {
    if (state._liveSyncSources === sources) state._liveSyncInFlight = false;
  }
}

function resetLiveQueueSync() {
  if (state._liveSyncTimer) clearTimeout(state._liveSyncTimer);
  state._liveSyncSources = new Map();
  state._liveSyncInFlight = false;
  state._liveSyncLastCheck = 0;
  state._liveSyncTimer = null;
}

async function mergeCurrentPage() {
  if (!state.active) { showMergeToast(-1); return; }
  if (state.loading || state.busy) return;
  const btn = document.getElementById('tss-merge-btn');
  const pageUrl = playlistBase(location.href);
  const request = beginCollectionRequest(pageUrl, false, false);
  if (btn) { btn.style.opacity = '0.35'; btn.style.pointerEvents = 'none'; }
  try {
    const snapshotPromise = fetchLivePlaylistSnapshot(pageUrl, request.signal);
    const pageEls = await loadTracks(request);
    if (!collectionRequestCurrent(request) || !state.active) return;
    const collection = await completePlaylistCollection(pageUrl, pageEls, snapshotPromise, request.signal);
    if (!collectionRequestCurrent(request) || !state.active) return;
    if (!collection.meta.length && !collection.complete) { showMergeToast(0); return; }
    const identities = trackIdentityIndex(state.meta);
    const added = [];
    const members = [];
    collection.meta.forEach((meta, index) => {
      let ti = matchingTrackIndex(identities, meta);
      if (ti !== undefined) {
        if (collection.els[index]) state.els[ti] = collection.els[index];
        const previous = state.meta[ti];
        Object.assign(previous, mergeTrackMeta(previous, meta));
        if (playlistBase(previous.sourcePage || '') === pageUrl) {
          state.meta[ti].playlistPosition = meta.playlistPosition;
        }
        reviveRemovedQueueTrack(ti);
      } else {
        ti = state.meta.length;
        state.meta.push(meta);
        state.els.push(collection.els[index] || null);
        added.push(ti);
      }
      indexTrackMeta(identities, state.meta[ti], ti);
      members.push(ti);
    });
    state.els.forEach((el, ti) => {
      if (el && soundCloudPermalinkConflicts(state.meta[ti], identities)) state.els[ti] = null;
    });
    registerLiveQueueSource(pageUrl, members);
    if (added.length) {
      state.queue.splice(state.pos + 1, 0, ...fisherYates(added));
      spaceUpcomingDuplicateTitles(state.queue, state.pos);
      recountRoundTotal();
      refreshUpcomingCrossfadePreparation();
    }
    state.playlistUrl = pageUrl;
    state.suspended = false;
    state.lastTitle = playerTitle();
    if (!state.worker && !state._workerInterval) startWatcher();
    badges();
    renderList();
    showMergeToast(added.length);
    finishCollectionRequest(request);
    void syncLiveQueue({ force: true });
  } catch (_) {
    if (collectionRequestCurrent(request)) showMergeToast('could not merge this page');
  } finally {
    if (btn && (!state._collectionRequest || state._collectionRequest === request)) {
      btn.style.opacity = ''; btn.style.pointerEvents = '';
    }
    finishCollectionRequest(request);
  }
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
  const samePlaylist = playlistBase(pageUrl) === playlistBase(state.playlistUrl)
    || state._liveSyncSources.has(playlistBase(pageUrl));
  let request = null;
  let acceptedEpoch = null;

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

    request = beginCollectionRequest(pageUrl, true, true);
    state._userPaused = false;
    updateHub();
    const snapshotPromise = fetchLivePlaylistSnapshot(pageUrl, request.signal);
    const pageEls = await loadTracks(request);
    if (!collectionRequestCurrent(request) || !state.active) return;
    const collection = await completePlaylistCollection(pageUrl, pageEls, snapshotPromise, request.signal);
    if (!collectionRequestCurrent(request) || !state.active) return;
    if (!collection.meta.length) {
      showMergeToast('no tracks found on this page');
      return;
    }

    const newQueue = buildReshuffledQueue([...Array(collection.meta.length).keys()], null, collection.meta);
    if (!newQueue.length) {
      showMergeToast('no tracks found on this page');
      return;
    }

    finishCollectionRequest(request);
    acceptedEpoch = invalidatePlaybackSession();
    stopCrossfadeDecks();
    state.busy = true;
    resetLiveQueueSync();
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
    registerLiveQueueSource(pageUrl, [...Array(state.meta.length).keys()]);
    saveLifetimeStats();
    state.stats.playCounts = {};
    state._lifetimeBase = {
      played: state.stats.played,
      elapsed: state.stats.elapsed,
      playCounts: {},
    };

    startWatcher();
    await runPlaybackOperation('replace queue', () => playAt(state.queue[0]));
    if (!state.active || state._playbackEpoch !== acceptedEpoch) return;
    badges();
    renderList();
    updateHub();
    showMergeToast(`${state.queue.length} tracks loaded & reshuffled`);
  } catch (_) {
    if (request && collectionRequestCurrent(request)) showMergeToast('could not re-shuffle this page');
    if (acceptedEpoch !== null && state._playbackEpoch === acceptedEpoch) state.busy = false;
  } finally {
    if (request) finishCollectionRequest(request);
    if (!state._collectionRequest) setLoading(false);
  }
}

function remapCachedQueue(cache, meta) {
  const identities = trackIdentityIndex(meta);
  const cachedMeta = Array.isArray(cache.meta) ? cache.meta : null;
  const cachedKeys = cachedMeta ? cachedMeta.map(trackCacheKey) : cache.metaKeys;
  const remapOld = oldTi => cachedMeta
    ? matchingTrackIndex(identities, cachedMeta[oldTi]) : identities.byKey.get(cachedKeys[oldTi]);
  const available = ti => ti !== undefined && !meta[ti].unavailable;
  const cachedPos = Math.max(0, Number(cache.pos) || 0);
  const prefix = cache.queue.slice(0, cachedPos).map(remapOld).filter(ti => ti !== undefined);
  const remainingSet = new Set(cache.queue.slice(cachedPos).map(remapOld).filter(available));
  const remaining = [...remainingSet];
  const cachedIndices = new Set(cachedKeys.map((_, ti) => remapOld(ti)));
  const extras = fisherYates(meta.map((_, ti) => ti).filter(ti => available(ti)
    && (!cachedIndices.has(ti)
      || (meta[ti]._restoreUpcoming && !meta[ti].removedFromPlaylist && !remainingSet.has(ti)))));
  const currentTi = remaining[0];
  const upcoming = remaining.slice(1).concat(extras);
  const finalQueue = prefix.concat(currentTi === undefined
    ? spaceDuplicateTitles(upcoming, meta)
    : [currentTi, ...spaceDuplicateTitles(upcoming, meta, currentTi)]);
  const playNext = [...new Set((cache.playNext || []).map(remapOld).filter(available))]
    .filter(ti => ti !== finalQueue[prefix.length]);
  if (finalQueue.length <= prefix.length && !playNext.length) return null;
  if (finalQueue.length <= prefix.length) finalQueue.push(playNext.shift());
  const history = (cache.history || []).map(remapOld).filter(ti => ti !== undefined);
  const priority = {};
  for (const [key, weight] of Object.entries(cache.priority || {})) {
    const ti = remapOld(+key);
    if (ti !== undefined) priority[ti] = weight;
  }
  const roundPlayed = Math.max(0, Number(cache.roundPlayed) || 0);
  const scheduled = new Set(finalQueue.slice(prefix.length));
  return {
    queue: finalQueue, pos: prefix.length, history, priority, playNext, roundPlayed,
    roundTotal: roundPlayed + finalQueue.length - prefix.length + playNext.filter(ti => !scheduled.has(ti)).length,
  };
}

function saveQueueSessionCache() {
  try {
    if (state.queue[state.pos] === undefined && !state.playNext.length) {
      sessionStorage.removeItem('tss_queue_cache');
      return false;
    }
    sessionStorage.setItem('tss_queue_cache', JSON.stringify({
      queue: state.queue, pos: state.pos, history: state.history, priority: state.priority,
      playNext: state.playNext, playlistUrl: state.playlistUrl, ts: Date.now(),
      meta: state.meta, metaKeys: state.meta.map(trackCacheKey),
      sources: [...state._liveSyncSources].map(([sourcePage, members]) => [sourcePage, [...members]]),
      roundPlayed: state.roundPlayed, roundTotal: state.roundTotal,
    }));
    return true;
  } catch (_) { return false; }
}

function restoreQueueSessionCache(cache, collection, pageUrl) {
  if (!Array.isArray(cache.meta) || !Array.isArray(cache.sources)) return remapCachedQueue(cache, state.meta);
  const meta = cache.meta.map(item => ({ ...item }));
  const identities = trackIdentityIndex(meta);
  const els = meta.map(() => null);
  const pageMembers = new Set();
  collection.meta.forEach((item, index) => {
    let ti = matchingTrackIndex(identities, item);
    if (ti === undefined) {
      ti = meta.length;
      meta.push(item);
      els.push(null);
    } else {
      meta[ti] = mergeTrackMeta(meta[ti], item);
      if (playlistBase(meta[ti].sourcePage || '') === pageUrl) meta[ti].playlistPosition = item.playlistPosition;
      delete meta[ti].removedFromPlaylist;
      delete meta[ti].unavailable;
    }
    indexTrackMeta(identities, meta[ti], ti);
    els[ti] = collection.els[index] || null;
    pageMembers.add(ti);
  });
  els.forEach((el, ti) => {
    if (el && soundCloudPermalinkConflicts(meta[ti], identities)) els[ti] = null;
  });
  const sources = new Map(cache.sources.map(([sourcePage, members]) => [sourcePage, new Set(members.filter(ti => meta[ti]))]));
  if (collection.complete) sources.set(pageUrl, pageMembers);
  else {
    const retained = sources.get(pageUrl) || new Set();
    for (const ti of pageMembers) retained.add(ti);
    sources.set(pageUrl, retained);
  }
  const allMembers = new Set();
  for (const members of sources.values()) for (const ti of members) allMembers.add(ti);
  const cachedUpcoming = new Set(cache.queue.slice(Math.max(0, Number(cache.pos) || 0)).concat(cache.playNext || []));
  meta.forEach((item, ti) => {
    if (allMembers.has(ti)) return;
    item.removedFromPlaylist = true;
    item.unavailable = true;
    if (cachedUpcoming.has(ti)) item._restoreUpcoming = true;
  });
  const restored = remapCachedQueue(cache, meta);
  if (!restored) return null;
  for (let qi = restored.pos; qi < restored.queue.length; qi++) {
    delete meta[restored.queue[qi]]._restoreUpcoming;
  }
  for (const ti of restored.playNext) delete meta[ti]._restoreUpcoming;
  state.meta = meta;
  state.els = els;
  state._liveSyncSources = sources;
  return restored;
}

async function start() {
  if (!validPage()) return;
  if (state.active || state.loading) {
    stop();
    renderList();
    return;
  }
  state._userPaused = false;
  invalidatePlaybackSession();
  resetLiveQueueSync();
  const pageUrl = playlistBase(location.href);
  const request = beginCollectionRequest(pageUrl);
  let acceptedEpoch = null;
  try {
    pauseSoundCloudTransport();
    pauseSoundCloud();
    updateHub();
    const snapshotPromise = fetchLivePlaylistSnapshot(pageUrl, request.signal);
    const pageEls = await loadTracks(request);
    if (!collectionRequestCurrent(request)) return;
    const collection = await completePlaylistCollection(pageUrl, pageEls, snapshotPromise, request.signal);
    if (!collectionRequestCurrent(request)) return;
    finishCollectionRequest(request);
    acceptedEpoch = invalidatePlaybackSession();
    stopCrossfadeDecks();
    state.els = collection.els;
    state.meta = collection.meta;
    registerLiveQueueSource(pageUrl, state.meta.map((_, ti) => ti));
    let cached = null;
    try {
      const raw = sessionStorage.getItem('tss_queue_cache');
      const cache = raw ? JSON.parse(raw) : null;
      if (cache && Date.now() - (cache.ts || 0) < 30 * 60 * 1000
          && playlistBase(cache.playlistUrl || '') === pageUrl
          && Array.isArray(cache.queue) && cache.queue.length && Array.isArray(cache.metaKeys)) {
        cached = restoreQueueSessionCache(cache, collection, pageUrl);
        if (cached) sessionStorage.removeItem('tss_queue_cache');
      }
    } catch (_) {}
    if (cached) {
      Object.assign(state, cached);
    } else {
      state.priority = {};
      state.queue = buildReshuffledQueue(state.meta.map((_, ti) => ti).filter(trackAvailable));
      state.pos = 0;
      state.history = [];
      state.playNext = [];
      state.roundPlayed = 0;
      state.roundTotal = state.queue.length;
    }
    if (state.queue[state.pos] === undefined) return;
    state.skipCounts = {};
    state.roundStarts = {};
    state.active = true;
    state.busy = true;
    state.suspended = false;
    state.manualAction = false;
    state.playlistUrl = pageUrl;
    const previous = state._savedStats;
    state.stats = previous && Date.now() - (previous._ts || 0) < 600_000
      ? { ...previous } : { played: 0, playCounts: {}, elapsed: 0 };
    state._savedStats = null;
    state._lifetimeBase = { played: state.stats.played, elapsed: state.stats.elapsed, playCounts: { ...state.stats.playCounts } };
    await runPlaybackOperation('start', () => {
      initializePlaybackVolume();
      startWatcher();
      return playAt(state.queue[state.pos]);
    });
    if (!state.active || state._playbackEpoch !== acceptedEpoch) return;
    badges();
    renderList();
    updateHub();
    void syncLiveQueue({ force: true });
  } catch (_) {
    if (collectionRequestCurrent(request)) showMergeToast('could not load this page');
    if (acceptedEpoch !== null && state._playbackEpoch === acceptedEpoch) state.busy = false;
  } finally {
    finishCollectionRequest(request);
  }
}

function stop() {
  invalidatePlaybackSession();
  state.active = false;
  state.busy = false;
  state.loading = false;
  state._userPaused = true;
  state._pendingPlaybackTrack = null;
  state._playbackRequest = null;
  state.sleepTimer = null;
  clearTimeout(state._customPlaybackRetryTimer);
  state._customPlaybackRetryTimer = null;
  const safely = operation => {
    try { operation(); } catch (error) {
      recordPlaybackDiagnostic('stop-cleanup-failed', { errorName: playbackErrorName(error) });
    }
  };
  safely(() => state._watcherCleanup?.());
  state._watcherCleanup = null;
  safely(closeOwnPip);
  safely(pauseSoundCloudTransport);
  safely(pauseSoundCloud);
  safely(stopCrossfadeDecks);
  safely(syncBrowserNowPlaying);
  safely(resetLiveQueueSync);
  safely(() => {
    const sleepSel = document.getElementById('tss-hub-sleep');
    if (sleepSel) sleepSel.value = 'off';
  });
  const worker = state.worker;
  state.worker = null;
  safely(() => worker?.postMessage('stop'));
  safely(() => worker?.terminate());
  if (state._endedHandler) {
    safely(() => document.removeEventListener('ended', state._endedHandler, true));
    state._endedHandler = null;
  }
  if (state._workerInterval) {
    clearInterval(state._workerInterval);
    state._workerInterval = null;
  }
  safely(() => document.querySelectorAll('.tss-badge').forEach(b => b.remove()));
  state._savedStats = { ...state.stats, _ts: Date.now() };
  safely(saveLifetimeStats);
  safely(updateHub);
}


function startWatcher() {
  state._watcherCleanup?.();
  if (state.worker) { state.worker.terminate(); state.worker = null; }
  if (state._workerInterval) { clearInterval(state._workerInterval); state._workerInterval = null; }
  if (state._endedHandler) {
    document.removeEventListener('ended', state._endedHandler, true);
    state._endedHandler = null;
  }
  const epoch = state._playbackEpoch;
  const watcherToken = (state._watcherToken || 0) + 1;
  state._watcherToken = watcherToken;
  const watcherIsCurrent = () => state.active && state._playbackEpoch === epoch
    && state._watcherToken === watcherToken;

  state.lastTitle = playerTitle();
  let lastTitle  = state.lastTitle;
  let titleTicks = 0;
  let nearEnd    = false;
  let lastRemaining = Infinity;
  let endpointTicks = 0;
  let uiTicks = 0;
  let lastDiagnosticTick = state._transitionDiagnostics ? performance.now() : 0;
  let lastDiagnosticDelay = -Infinity;
  let fadeWindowTrack = null, fadeWindowToken = null;
  let deckStall;
  const resetDeckStall = (deck = null, current = 0, now = Date.now()) => {
    const index = deck ? state._decks.indexOf(deck) : -1;
    deckStall = {
      deck, index, track: state._deckTrack, meta: state.meta[state._deckTrack],
      preparation: state._deckPrepareTokens[index], foreground: state._playbackRequest,
      current, position: current, observedAt: now, stalledSince: null,
      recoveryAttempts: 0, recovering: false, retryPending: false,
    };
  };
  resetDeckStall();

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
    if (!watcherIsCurrent()) return;
    lastTitle = playerTitle();
    endpointTicks = 0;
    if (!state.active) { nearEnd = false; return; }
    for (let i = 0; i < 10; i++) {
      if (progress() < 0.1) break;
      await wait(100);
      if (!watcherIsCurrent()) return;
    }
    nearEnd = false;
  };

  const returnToQueuePage = (consumeCurrent = false) => {
    if (!watcherIsCurrent()) return;
    if (consumeCurrent) consumeCurrentQueueTrack();

    cleanup();
    saveQueueSessionCache();

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
    if (!watcherIsCurrent() || state._userPaused || state.busy || nearEnd) return;
    nearEnd = true;
    if (state._transitionDiagnostics) recordTransitionDiagnostic('natural-end', {
      trackIndex: state._deckTrack, deckIndex: state._deckIndex,
      token: state._deckPrepareTokens[state._deckIndex], crossfadeSeconds: state.crossfadeSeconds,
      ready: upcomingCrossfadeDeckReady(),
    });

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
      if (watcherIsCurrent()) await resetEndGuard();
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
    if (!watcherIsCurrent()) return;
    if (state._transitionDiagnostics) {
      const now = performance.now();
      const delayMs = now - lastDiagnosticTick;
      lastDiagnosticTick = now;
      if (delayMs > 250 && now - lastDiagnosticDelay >= 1000) {
        lastDiagnosticDelay = now;
        recordTransitionDiagnostic('watcher-delay', {
          delayMs, trackIndex: state._deckTrack, deckIndex: state._deckIndex,
          token: state._deckPrepareTokens[state._deckIndex], visible: document.visibilityState === 'visible',
          userPaused: Boolean(state._userPaused), busy: Boolean(state.busy), crossfading: Boolean(state._crossfading),
          readyState: state._decks[state._deckIndex]?.readyState,
          ready: upcomingCrossfadeDeckReady(),
          incomingReadyState: state._decks[state._deckIndex === 0 ? 1 : 0]?.readyState,
        });
      }
    }
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

    // Equal track titles can hide a transition; expire the guard before the next end.
    if (state.manualAction && Date.now() - state._manualActionAt > 3000) {
      state.manualAction = false;
    }

    if (++uiTicks >= 6) {
      uiTicks = 0;
      syncPlaybackVolumeFromSoundCloud();
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
    const configuredFadeSeconds = Number(state.crossfadeSeconds) || 0;
    const automaticFadeEligible = configuredFadeSeconds > 0
      && Number.isInteger(state._deckTrack)
      && !state._crossfading
      && !nearEnd
      && !state._userPaused
      && !paused()
      && !(state.stopAfterRound && state.pos >= state.queue.length - 1)
      && !(state.sleepTimer?.type === 'tracks' && state.sleepTimer.remaining <= 1)
      && timing.current > 0
      && remainingSeconds > 0.05
      && remainingSeconds <= configuredFadeSeconds;
    let standbyReady = false;
    let effectiveFadeSeconds = configuredFadeSeconds;
    if (automaticFadeEligible) {
      standbyReady = upcomingCrossfadeDeckReady();
      if (standbyReady) {
        const nextTi = upcomingTrackIndex();
        const standbyIndex = state._deckIndex === 0 ? 1 : 0;
        const mediaDuration = Number(state._decks[standbyIndex]?.duration);
        const incomingDuration = Number.isFinite(mediaDuration) && mediaDuration > 0
          ? mediaDuration : Number(state.meta[nextTi]?.durationMs) / 1000;
        if (Number.isFinite(incomingDuration) && incomingDuration > 0) {
          const fadeBudget = Math.min(configuredFadeSeconds, incomingDuration / 2);
          effectiveFadeSeconds = fadeBudget >= CROSSFADE_MIN_DURATION_SECONDS ? fadeBudget : 0;
        }
      }
    }
    if (state._transitionDiagnostics && automaticFadeEligible
        && (fadeWindowTrack !== state._deckTrack || fadeWindowToken !== state._deckPrepareTokens[state._deckIndex])) {
      fadeWindowTrack = state._deckTrack;
      fadeWindowToken = state._deckPrepareTokens[state._deckIndex];
      recordTransitionDiagnostic('fade-window', {
        trackIndex: state._deckTrack, deckIndex: state._deckIndex, token: fadeWindowToken,
        remainingMs: remainingSeconds * 1000, ready: standbyReady, crossfadeSeconds: configuredFadeSeconds,
        crossfadeDuration: effectiveFadeSeconds,
        incomingDuration: Number(state._decks[state._deckIndex === 0 ? 1 : 0]?.duration),
      });
    }
    const shouldCrossfade = automaticFadeEligible && standbyReady
      && remainingSeconds <= effectiveFadeSeconds;
    if (shouldCrossfade) {
      nearEnd = true;
      state._crossfadePending = remainingSeconds;
      try {
        await next(true);
      } finally {
        if (watcherIsCurrent()) {
          state._crossfadePending = false;
          await resetEndGuard();
        }
      }
      return;
    }

    // Observation timing is not recovery ownership: a reload can itself pause,
    // seek, or reset media time. Keep its single flight and retry budget intact.
    const deck = currentDeckAudio();
    const stallNow = Date.now();
    const index = deck ? state._decks.indexOf(deck) : -1;
    if (deckStall.deck !== deck || deckStall.track !== state._deckTrack
        || deckStall.meta !== state.meta[state._deckTrack]
        || deckStall.preparation !== state._deckPrepareTokens[index]
        || deckStall.foreground !== state._playbackRequest) {
      resetDeckStall(deck, timing.current, stallNow);
    }
    deckStall.observedAt = stallNow;
    if (deckStall.recovering) return;
    const progressed = timing.current > deckStall.current + 0.05
      || (!deckStall.retryPending && Math.abs(timing.current - deckStall.current) >= 0.05);
    if (progressed) resetDeckStall(deck, timing.current, stallNow);
    const stallEligible = Boolean(deck && timing.source === 'audio'
      && !state._userPaused && !state.loading && !state.suspended
      && !state.manualAction && !nearEnd && !deck.ended
      && (Number(deck.playbackRate) || 1) > 0
      && (deckStall.retryPending || (!deck.paused && !deck.seeking)));
    if (!stallEligible) {
      deckStall.current = timing.current;
      deckStall.stalledSince = null;
    } else {
      const bufferedDataAvailable = deckHasBufferedAhead(deck, timing.current);
      const stallKind = bufferedDataAvailable ? 'decoder' : 'network';
      const stallThreshold = stallKind === 'decoder' ? 15000 : 12000;
      if (deckStall.stalledSince === null) deckStall.stalledSince = stallNow;
      const stalledFor = stallNow - deckStall.stalledSince;
      if (deckStall.retryPending || stalledFor >= stallThreshold) {
        if (deckStall.recoveryAttempts >= 2) {
          recordPlaybackDiagnostic('recovery-exhausted', {
            trackIndex: state._deckTrack,
            deckIndex: index,
            reason: stallKind,
            attempts: deckStall.recoveryAttempts,
            position: Math.round(deckStall.position * 10) / 10,
            stalledFor,
            stallThresholdMs: stallThreshold,
            duration: Number(deck?.duration) || 0,
            readyState: Number(deck?.readyState) || 0,
            networkState: Number(deck?.networkState) || 0,
            mediaErrorCode: Number(deck?.error?.code) || 0,
            playbackRate: Number(deck?.playbackRate) || 1,
            bufferedDataAvailable,
            streamKind: diagnosticDeckStreamKind(deck, index),
            contextState: state._audioContext?.state || 'missing',
            crossfading: Boolean(state._crossfading),
            queuePosition: state.pos,
            queueLength: state.queue.length,
          });
          resetDeckStall();
          await advanceAtNaturalEnd();
          return;
        }
        const owner = deckStall;
        owner.recoveryAttempts++;
        owner.recovering = true;
        if (!owner.retryPending) owner.position = timing.current;
        const recovery = recoverCurrentDeckStream(deck, owner.position, stallKind, owner.recoveryAttempts);
        owner.preparation = state._deckPrepareTokens[index];
        const finishRecovery = recovered => {
          if (!watcherIsCurrent() || deckStall !== owner || currentDeckAudio() !== deck
              || state._deckPrepareTokens[index] !== owner.preparation
              || state._deckTrack !== owner.track || state.meta[owner.track] !== owner.meta
              || state._playbackRequest !== owner.foreground) return;
          owner.recovering = false;
          owner.retryPending = recovered !== true;
          owner.current = Number(deck.currentTime) || 0;
          owner.observedAt = Date.now();
          owner.stalledSince = owner.observedAt;
          if (recovered === true) owner.position = owner.current;
        };
        void recovery.then(finishRecovery, () => finishRecovery(false));
        return;
      }
    }

    // SoundCloud can park at the endpoint without firing ended. Two paused
    // endpoint polls distinguish this from a seek near the end.
    const parkedAtEnd = timing.duration > 0
      && !state._userPaused && !deck?.seeking
      && timing.current >= timing.duration - 0.05
      && paused();
    if (parkedAtEnd) {
      if (++endpointTicks >= 2) await advanceAtNaturalEnd();
      return;
    }
    endpointTicks = 0;
    const queuedDeckActive = Number.isInteger(state._deckTrack)
      && state.queue[state.pos] === state._deckTrack;
    const queuedNativeActive = nativePlaybackAllowed();
    const queuedPlaybackActive = queuedDeckActive || queuedNativeActive;
    if (state.suspended && queuedPlaybackActive) state.suspended = false;


    if (state.suspended) {
      if (title && title !== lastTitle) lastTitle = title;
      titleTicks = 0;
      lastRemaining = timing.duration ? Math.max(0, timing.duration - timing.current) : Infinity;
      state.lastProgress = p;
      return;
    }

    if (title && lastTitle && title !== lastTitle) {
      // Deck and intentional native-session changes are internal queue
      // transitions, not external SoundCloud playback.
      if (queuedPlaybackActive) {
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
        pauseSoundCloud();
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

  let worker = null;
  let fallbackInterval = null;
  let heartbeatTimer = null;
  let lastHeartbeat = Date.now();
  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearTimeout(heartbeatTimer);
    if (worker) {
      worker.onmessage = worker.onerror = worker.onmessageerror = null;
      try { worker.terminate(); } catch (_) {}
      if (state.worker === worker) state.worker = null;
    }
    if (fallbackInterval !== null) {
      clearInterval(fallbackInterval);
      if (state._workerInterval === fallbackInterval) state._workerInterval = null;
    }
    document.removeEventListener('ended', onMediaEnded, true);
    if (state._endedHandler === onMediaEnded) state._endedHandler = null;
    if (state._watcherToken === watcherToken) state._watcherToken++;
    if (state._watcherCleanup === cleanup) state._watcherCleanup = null;
  };
  state._watcherCleanup = cleanup;
  const startFallback = () => {
    if (closed || !watcherIsCurrent() || fallbackInterval !== null) return;
    clearTimeout(heartbeatTimer);
    if (worker) {
      worker.onmessage = worker.onerror = worker.onmessageerror = null;
      try { worker.terminate(); } catch (_) {}
      if (state.worker === worker) state.worker = null;
    }
    fallbackInterval = setInterval(tick, 50);
    state._workerInterval = fallbackInterval;
  };
  const superviseWorker = () => {
    if (!watcherIsCurrent()) { cleanup(); return; }
    if (Date.now() - lastHeartbeat >= 3000) { startFallback(); return; }
    heartbeatTimer = setTimeout(superviseWorker, 2000);
  };
  worker = mkWorker();
  state.worker = worker;
  if (worker) {
    worker.onmessage = event => {
      if (closed || !watcherIsCurrent() || state.worker !== worker) return;
      lastHeartbeat = Date.now();
      if (event?.data !== 'ready') return tick();
    };
    worker.onerror = worker.onmessageerror = event => {
      event?.preventDefault?.();
      startFallback();
    };
    try {
      worker.postMessage('start');
      heartbeatTimer = setTimeout(superviseWorker, 2000);
    } catch (_) {
      startFallback();
    }
  } else {
    startFallback();
  }
}


function badges() {
  const stale = new Set(document.querySelectorAll('.tss-badge'));

  state.queue.forEach((ti, qi) => {
    const el = state.els[ti];
    if (!el || !document.body.contains(el)) return;
    const existing = el.querySelector('.tss-badge');
    // Duplicate queue entries can refer to the same mounted SoundCloud row.
    if (existing && !stale.has(existing)) return;
    const title = el.querySelector('.trackItem__trackTitle, .soundTitle__title, .sc-link-primary');
    if (!title) return;

    const cur = qi === state.pos;
    const badge = existing || document.createElement('span');
    const className = `tss-badge${cur ? ' tss-badge-cur' : ''}`;
    const n = state.stats.played + (qi - state.pos);
    const text = cur ? `▶ ${n}` : `${n}`;
    if (badge.className !== className) badge.className = className;
    if (badge.textContent !== text) badge.textContent = text;
    stale.delete(badge);
    if (badge.parentNode !== title.parentNode || badge.nextSibling !== title) {
      title.parentNode.insertBefore(badge, title);
    }
  });
  stale.forEach(badge => badge.remove());
}


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
  const playedText = String(state.stats.played);
  const elapsedText = fmtTime(state.stats.elapsed || 0);
  if (tp && tp.textContent !== playedText) tp.textContent = playedText;
  if (tt && tt.textContent !== elapsedText) tt.textContent = elapsedText;

  const ltEl = overlay.querySelector('#tss-stats-lifetime');
  if (ltEl) {
    const lt = loadLifetimeStats();
    const base = state._lifetimeBase || { played: 0, elapsed: 0 };
    const totalPlayed  = (lt.played  || 0) + Math.max(0, (state.stats.played  || 0) - (base.played  || 0));
    const totalElapsed = (lt.elapsed || 0) + Math.max(0, (state.stats.elapsed || 0) - (base.elapsed || 0));
    const text = `${totalPlayed} tracks / ${fmtTime(totalElapsed)}`;
    if (ltEl.textContent !== text) ltEl.textContent = text;
  }

  // Counts only mutate in trackPlayed; reset/reshuffle replace the counts object.
  if (overlay._tssCounts !== state.stats.playCounts || overlay._tssPlayed !== state.stats.played) {
    overlay._tssTop = Object.entries(state.stats.playCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);
    overlay._tssCounts = state.stats.playCounts;
    overlay._tssPlayed = state.stats.played;
  }
  const top = overlay._tssTop;

  const list = overlay.querySelector('#tss-stats-toplist');
  if (!list) return;

  const markup = top.length ? top.map(([ti, count]) => {
    const meta  = state.meta[+ti] || {};
    const w     = state.priority[+ti] ?? 1.0;
    const label = w <= 0.25 ? 'low' : w >= 2.0 ? 'high' : 'normal';
    const col   = w <= 0.25 ? '#aeb5c4' : w >= 2.0 ? 'var(--tss-a,#aebaf3)' : 'rgba(255,255,255,.38)';
    return `
      <div class="tss-stat-track" style="grid-template-columns:minmax(0,1fr) auto auto;">
        <span style="color:#909090;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;">${esc(meta.title || '—')}</span>
        <span style="color:#aebaf3;font-size:11px;flex-shrink:0;">${count}×</span>
        <button class="tss-stat-priority" data-ti="${ti}" style="color:${col};">${label}</button>
      </div>`;
  }).join('') : '<div class="tss-stats-empty">No listening data yet</div>';
  if (list._tssStatsMarkup === markup && list.innerHTML === list._tssStatsRendered) return;
  list.innerHTML = markup;
  list._tssStatsMarkup = markup;
  list._tssStatsRendered = list.innerHTML;

  list.querySelectorAll('[data-ti]').forEach(btn => {
    btn.onclick = e => {
      e.stopPropagation();
      const ti  = +btn.getAttribute('data-ti');
      const cur = state.priority[ti] ?? 1.0;
      let next2, label, col;
      if      (cur >= 2.0) { next2 = 1.0;  label = 'normal'; col = 'rgba(255,255,255,.38)'; }
      else if (cur >= 1.0) { next2 = 0.25; label = 'low';    col = '#aeb5c4'; }
      else                 { next2 = 2.0;  label = 'high';   col = 'var(--tss-a,#aebaf3)'; }
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
    padding:0; z-index:999999;
    font-family:-apple-system,'Segoe UI',system-ui,sans-serif;
    width:340px; max-width:calc(100vw - 32px); box-sizing:border-box;
    cursor:default; -webkit-user-select:none; user-select:none;
    -webkit-backdrop-filter:var(--tss-glass-filter,none); backdrop-filter:var(--tss-glass-filter,none);
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

  const close = () => {
    overlay.remove();
    document.getElementById('tss-hub-stats')?.focus({ preventScroll: true });
  };
  document.getElementById('tss-stats-close').onclick = close;
  overlay.onkeydown = event => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-label', 'Listening stats');
  document.getElementById('tss-stats-close').focus({ preventScroll: true });
  document.getElementById('tss-stats-reset').onclick = () => {
    state.stats        = { played: 0, playCounts: {}, elapsed: 0 };
    state._playTimeLastAt = Date.now();
    state._playTimeWasAudible = false;
    state._playTimeRemainderMs = 0;
    state._savedStats  = null;
    state._lifetimeBase = { played: 0, elapsed: 0, playCounts: {} };
    try { safeStorage.removeItem(LIFETIME_KEY); } catch (_) {}
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
  if (overlay?._opener?.isConnected) overlay._opener.focus({ preventScroll: true });
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
  updateEqualizerPersistenceStatus();
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
              <stop offset="0%" stop-color="#aebaf3" stop-opacity=".20"/>
              <stop offset="100%" stop-color="#aebaf3" stop-opacity=".025"/>
            </linearGradient>
          </defs>
          <g class="tss-eq-grid" aria-hidden="true">
            <line x1="50" y1="25" x2="50" y2="190"/><line x1="155" y1="25" x2="155" y2="190"/>
            <line x1="260" y1="25" x2="260" y2="190"/><line x1="365" y1="25" x2="365" y2="190"/>
            <line x1="470" y1="25" x2="470" y2="190"/><line class="tss-eq-zero" x1="28" y1="107.5" x2="492" y2="107.5"/>
          </g>
          <path id="tss-eq-area" fill="url(#tss-eq-fill)" aria-hidden="true"/>
          <path id="tss-eq-curve" fill="none" stroke="var(--tss-a,#aebaf3)" stroke-width="3" stroke-linecap="round" aria-hidden="true"/>
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
  overlay._opener = document.activeElement;
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-label', 'Equalizer');
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
    safeStorage.setItem('tss_safety_clipper', String(state.safetyClipper));
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
    const saved = persistEqualizer({ customPresets: true, immediate: true });
    saveRow.dataset.open = saved ? 'false' : 'true';
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
  overlay._onKeydown = event => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    event.preventDefault();
    closeEqualizer();
  };
  document.addEventListener('keydown', overlay._onKeydown);
  updateEqualizerPopup();
  overlay.querySelector('#tss-eq-close').focus({ preventScroll: true });
}

function applyVisualEffects(documentLike = document) {
  const root = documentLike?.documentElement;
  if (!root) return;
  const attribute = 'data-tss-reduce-visual-effects';
  if (state.reduceVisualEffects) {
    if (root.getAttribute(attribute) !== 'true') root.setAttribute(attribute, 'true');
    // Settle owned finite motion through its real cleanup/render callback.
    for (const element of documentLike.querySelectorAll('[data-surface-open]')) {
      const animation = element._tssMotion;
      if (!animation) continue;
      try { animation.finish(); } catch (_) {}
      if (element._tssMotion === animation) animation.onfinish?.();
    }
  } else if (root.hasAttribute(attribute)) {
    root.removeAttribute(attribute);
  }
  const control = documentLike.getElementById('tss-reduce-visual-effects');
  if (control && control.checked !== state.reduceVisualEffects) control.checked = state.reduceVisualEffects;
  const scrollControl = documentLike.getElementById('tss-scroll-long-titles');
  if (scrollControl && scrollControl.checked !== state.scrollLongTitles) scrollControl.checked = state.scrollLongTitles;
  syncOwnPipMarquee(documentLike.getElementById('tss-pip-title'), documentLike.getElementById('tss-pip-title-text'));
}

function setReducedVisualEffects(enabled) {
  const next = Boolean(enabled);
  if (state.reduceVisualEffects !== next) {
    state.reduceVisualEffects = next;
    safeStorage.setItem('tss_reduce_visual_effects', String(next));
  }
  applyVisualEffects(document);
  if (state._ownPipWindow?.document) applyVisualEffects(state._ownPipWindow.document);
  return next;
}

function setScrollLongTitles(enabled) {
  const next = Boolean(enabled);
  if (state.scrollLongTitles !== next) {
    state.scrollLongTitles = next;
    safeStorage.setItem('tss_scroll_long_titles', String(next));
  }
  applyVisualEffects(document);
  if (state._ownPipWindow?.document) applyVisualEffects(state._ownPipWindow.document);
  return next;
}

function motionIsInstant(event) {
  // A zero-detail click can also come from pointer delivery or script. Only an
  // observed keyboard activation makes that click instant.
  const keyboardClick = event?.type === 'click' && event.detail === 0 && !event.pointerType && event.isTrusted !== false
    && motionIsInstant.keyboardTarget
    && (event.target === motionIsInstant.keyboardTarget || event.currentTarget === motionIsInstant.keyboardTarget);
  if (event?.type === 'click') motionIsInstant.keyboardTarget = null;
  return state.reduceVisualEffects || event?.instant === true || event?.type === 'keydown' || event?.type === 'keyup' || Boolean(keyboardClick)
    || (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

function animateSurface(element, visible, { instant = false, onFinish = null, duration = null, restart = false, kind = 'view' } = {}) {
  if (!element) return;
  const open = String(visible);
  // Routine playback/layout sync owns no transition: never settle or restart
  // an already-requested target, even when that sync requests instant rendering.
  if (element.dataset.surfaceOpen === open && !restart) return;
  const queue = kind === 'queue';
  const content = queue ? element.querySelector?.('#tss-sidebar-content') : null;
  const previous = element._tssMotion;
  const previousContent = element._tssContentMotion;
  const current = previous && typeof getComputedStyle === 'function' ? getComputedStyle(element) : null;
  const currentContent = previousContent && content && typeof getComputedStyle === 'function' ? getComputedStyle(content) : null;
  const from = current ? queue
    ? { transform: current.transform, clipPath: current.clipPath }
    : { opacity: current.opacity, transform: current.transform } : null;
  const fromContent = currentContent ? { opacity: currentContent.opacity } : null;
  if (previous) {
    previous.onfinish = null;
    previous.cancel();
    element._tssMotion = null;
  }
  if (previousContent) {
    previousContent.cancel();
    element._tssContentMotion = null;
  }
  const wasHidden = element.hidden;
  // Logical closure is immediate; keep the painted surface until its exit finishes.
  element.dataset.surfaceOpen = open;
  element.inert = !visible;
  element.setAttribute('aria-hidden', String(!visible));
  const finish = () => {
    if (element.dataset.surfaceOpen !== open) return;
    element.hidden = !visible;
    element.dataset.motion = visible ? 'open' : 'closed';
    onFinish?.();
  };
  if (instant || motionIsInstant() || typeof element.animate !== 'function'
    || (queue && (!content || typeof content.animate !== 'function')) || (!visible && wasHidden)) {
    finish();
    return;
  }
  element.hidden = false;
  element.dataset.motion = visible ? 'entering' : 'exiting';
  let closedTransform = kind === 'tab' ? 'translateY(6px)' : 'translateY(8px)';
  let closedClip = 'inset(0 0 0 0)';
  if (queue) {
    const narrow = element.dataset.layout === 'narrow';
    const left = element.dataset.side === 'left';
    // Keep the attachment edge fixed: translation would pull retracting glass
    // across the player. Edge-anchored scale and clipping supply the pop-out.
    closedTransform = narrow ? 'scale(.98,.9)' : 'scale(.975,.9)';
    closedClip = narrow ? 'inset(0 0 100% 0)'
      : left ? 'inset(0 0 0 100%)' : 'inset(0 100% 0 0)';
  }
  // Never fade the backdrop-bearing root. Exit clears every foreground pixel
  // before retracting the glass; entry unfolds the glass before revealing text.
  const closed = queue ? { transform: closedTransform, clipPath: closedClip }
    : { opacity: 0, transform: closedTransform };
  const opened = queue ? { transform: 'none', clipPath: 'inset(0 0 0 0)' }
    : { opacity: 1, transform: 'none' };
  const easing = 'cubic-bezier(0.23, 1, 0.32, 1)';
  const timing = {
    duration: duration ?? (kind === 'tab' ? 210 : queue ? (visible ? 260 : 220) : 240),
    easing: queue ? 'linear' : easing,
    fill: 'both',
  };
  const start = from || (visible ? closed : opened);
  const phase = visible ? 190 / 260 : 60 / 220;
  const frames = queue ? [
    { ...start, offset: 0, easing: visible ? easing : 'linear' },
    { ...(visible ? opened : start), offset: phase, easing: visible ? 'linear' : easing },
    { ...(visible ? opened : closed), offset: 1 },
  ] : [start, visible ? opened : closed];
  const animation = element.animate(frames, timing);
  const contentStart = fromContent || { opacity: visible ? 0 : 1 };
  const contentAnimation = content ? content.animate([
    { ...contentStart, offset: 0, easing: visible ? 'linear' : easing },
    { ...(visible ? contentStart : { opacity: 0 }), offset: phase, easing: visible ? easing : 'linear' },
    { opacity: visible ? 1 : 0, offset: 1 },
  ], timing) : null;
  // Pin both effects to one timeline instant, including interrupted reversals.
  // Otherwise separate animate() calls can disagree at the phase boundary.
  const startTime = animation.timeline?.currentTime;
  if (contentAnimation && typeof startTime === 'number') {
    animation.startTime = startTime;
    contentAnimation.startTime = startTime;
  }
  element._tssMotion = animation;
  element._tssContentMotion = contentAnimation;
  animation.onfinish = () => {
    if (element._tssMotion !== animation) return;
    element._tssMotion = null;
    element._tssContentMotion = null;
    contentAnimation?.cancel();
    finish();
    animation.cancel();
  };
}

function syncSettingsTabs(instant = true) {
  const hub = document.getElementById('tss-hub');
  if (!hub) return;
  const selected = hub.dataset.settingsTab || 'audio';
  for (const tab of ['audio', 'session', 'info']) {
    const button = document.getElementById(`tss-settings-tab-${tab}`);
    const active = tab === selected;
    if (button) {
      if (button.getAttribute('aria-selected') !== String(active)) button.setAttribute('aria-selected', String(active));
      if (button.tabIndex !== (active ? 0 : -1)) button.tabIndex = active ? 0 : -1;
    }
    animateSurface(document.getElementById(`tss-settings-panel-${tab}`), active, { instant, kind: 'tab' });
  }
}

function setSettingsTab(tab, focus = false, event = null) {
  if (!['audio', 'session', 'info'].includes(tab)) return;
  const hub = document.getElementById('tss-hub');
  if (!hub) return;
  const focusedPanel = document.activeElement?.closest?.('.tss-settings-panel');
  const moveFocus = focus || (focusedPanel && focusedPanel.id !== `tss-settings-panel-${tab}`);
  hub.dataset.settingsTab = tab;
  syncSettingsTabs(motionIsInstant(event));
  syncSidebarToHub();
  if (moveFocus) document.getElementById(`tss-settings-tab-${tab}`)?.focus({ preventScroll: true });
}

function syncHubView(instant = true) {
  const hub = document.getElementById('tss-hub');
  if (!hub) return;
  const start = document.getElementById('tss-hub-start');
  const actionFocused = document.activeElement === start;
  const settings = hub.dataset.view === 'settings';
  const main = document.getElementById('tss-hub-main-view');
  const panel = document.getElementById('tss-hub-settings-view');
  const button = document.getElementById('tss-hub-settings');
  animateSurface(main, !settings, { instant });
  animateSurface(panel, settings, { instant });
  syncSettingsTabs();
  if (button) {
    const expanded = String(settings);
    if (button.getAttribute('aria-expanded') !== expanded) button.setAttribute('aria-expanded', expanded);
    const label = settings ? 'Back to player' : 'Settings';
    if (button.getAttribute('aria-label') !== label) button.setAttribute('aria-label', label);
    if (button.title !== label) button.title = label;
  }
  const actions = document.getElementById('tss-hub-actions');
  const sessionAction = document.getElementById('tss-settings-session-action');
  const target = settings || (state.active && !state.loading) ? sessionAction : actions;
  const moved = start && target && start.parentElement !== target;
  if (moved) target.appendChild(start);
  if (actions && actions.hidden !== (start?.parentElement !== actions)) actions.hidden = start?.parentElement !== actions;
  if (sessionAction && sessionAction.hidden !== (start?.parentElement !== sessionAction)) sessionAction.hidden = start?.parentElement !== sessionAction;
  if (moved && actionFocused) {
    if (settings && (hub.dataset.settingsTab || 'audio') !== 'session') setSettingsTab('session', false, { instant: true });
    const actionVisible = hub.dataset.queueView !== 'true' && (settings || target === actions);
    const focusTarget = actionVisible ? start
      : state.active && hub.dataset.queueView !== 'true' ? document.getElementById('tss-hub-play') : button;
    focusTarget?.focus({ preventScroll: true });
  }
}

function setHubView(view, focus = true, event = null) {
  const hub = document.getElementById('tss-hub');
  if (!hub) return;
  const settings = view === 'settings';
  const instant = motionIsInstant(event);
  if (settings && state.sidebarOpen && document.getElementById('tss-sidebar')?.dataset.layout === 'narrow') toggleSidebar({ instant });
  hub.dataset.view = settings ? 'settings' : 'main';
  syncHubView(instant);
  syncSidebarToHub();
  if (focus) document.getElementById(settings ? 'tss-settings-title' : 'tss-hub-settings')?.focus({ preventScroll: true });
}

function setHubMini(mini, focus = true, event = null) {
  const hub = document.getElementById('tss-hub');
  if (!hub) return;
  const instant = motionIsInstant(event);
  if (state.sidebarOpen && document.getElementById('tss-sidebar')?.dataset.layout === 'narrow') toggleSidebar({ instant });
  hub.dataset.mini = String(Boolean(mini));
  const button = document.getElementById('tss-hub-col');
  if (button) {
    button.setAttribute('aria-expanded', String(!mini));
    const label = mini ? 'Expand player' : 'Minimize player';
    button.setAttribute('aria-label', label);
    button.title = label;
  }
  setHubView('main', false, { instant });
  if (focus) button?.focus({ preventScroll: true });
}

function mkHub() {
  if (document.getElementById('tss-hub')) return;

  if (!document.getElementById('tss-hub-style')) {
    const s = document.createElement('style');
    s.id = 'tss-hub-style';
    s.textContent = `
      #tss-hub,#tss-sidebar,#tss-eq-overlay,#tss-stats-overlay,#tss-ctx,.tss-debug-dialog,#tss-inline-pip,#tss-merge-toast {
        --tss-a:#aebaf3;--tss-ar:174;--tss-ag:186;--tss-ab:243;
        --tss-glass-base:rgba(9,10,12,.98);
        --tss-glass-surface:linear-gradient(180deg,rgba(255,255,255,.04),rgba(255,255,255,0) 40%),var(--tss-glass-base);
        --tss-glass-inset:rgba(0,0,0,.08);
        --tss-glass-filter:none;
        --tss-glass-rim:rgba(255,255,255,.12);
        --tss-glass-shadow:inset 0 1px 0 rgba(255,255,255,.07),inset 0 0 0 1px rgba(255,255,255,.025),inset 0 -1px 0 rgba(0,0,0,.12),0 20px 54px rgba(0,0,0,.38);
      }
      @supports ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))) {
        #tss-hub,#tss-sidebar,#tss-eq-overlay,#tss-stats-overlay,#tss-ctx,.tss-debug-dialog,#tss-inline-pip,#tss-merge-toast {
          --tss-glass-base:rgba(9,10,12,.54);
          --tss-glass-filter:blur(20px);
        }
      }
      :root[data-tss-reduce-visual-effects="true"] :is(#tss-hub,#tss-sidebar,#tss-eq-overlay,#tss-stats-overlay,#tss-ctx,.tss-debug-dialog,#tss-inline-pip,#tss-merge-toast) {
        --tss-glass-base:rgba(9,10,12,.98);--tss-glass-filter:none;
      }
      :root[data-tss-reduce-visual-effects="true"] :is(#tss-hub,#tss-sidebar,#tss-eq-overlay,#tss-stats-overlay,#tss-ctx,.tss-debug-dialog,#tss-inline-pip,#tss-merge-toast,#tss-modal-backdrop,#tss-debug-overlay,#tss-debug-help-overlay),
      :root[data-tss-reduce-visual-effects="true"] :is(#tss-hub,#tss-sidebar,#tss-eq-overlay,#tss-stats-overlay,#tss-ctx,.tss-debug-dialog,#tss-inline-pip,#tss-merge-toast,#tss-modal-backdrop,#tss-debug-overlay,#tss-debug-help-overlay) *,
      :root[data-tss-reduce-visual-effects="true"] :is(#tss-hub,#tss-sidebar,#tss-eq-overlay,#tss-stats-overlay,#tss-ctx,.tss-debug-dialog,#tss-inline-pip,#tss-merge-toast) *::before,
      :root[data-tss-reduce-visual-effects="true"] :is(#tss-hub,#tss-sidebar,#tss-eq-overlay,#tss-stats-overlay,#tss-ctx,.tss-debug-dialog,#tss-inline-pip,#tss-merge-toast) *::after {
        transition:none!important;animation:none!important;scroll-behavior:auto!important;-webkit-backdrop-filter:none!important;backdrop-filter:none!important;
      }
      :root[data-tss-reduce-visual-effects="true"] .tss-hub-btn:active { transform:none!important; }
      /* The header never scrolls; only the active view owns vertical overflow. */
      #tss-hub-inner { position:relative;display:flex;flex-direction:column;max-height:calc(100dvh - 26px);overflow:hidden; }

      .tss-hub-btn {
        border:none; cursor:pointer; flex-shrink:0;
        display:flex; align-items:center; justify-content:center;
        transition:background 0.15s, color 0.15s, transform 0.1s;
        -webkit-user-select:none; user-select:none;
      }
      .tss-hub-btn:active { transform:scale(0.97); }
      .tss-hub-btn-icon {
        background:none; color:rgba(255,255,255,0.68);
        padding:5px; border-radius:7px;
      }
      .tss-hub-btn-icon:hover { color:rgba(255,255,255,0.72); background:rgba(255,255,255,0.08); }
      .tss-hub-btn-sm {
        width:36px; height:36px; border-radius:50%;
        background:rgba(255,255,255,0.08); color:rgba(255,255,255,0.72);
      }
      .tss-hub-btn-sm:hover,.tss-deck-controls .tss-hub-btn-sm:hover { background:rgba(255,255,255,.10); }
      .tss-hub-btn-lg {
        width:46px; height:46px; border-radius:50%;
        background:color-mix(in srgb,var(--tss-a,#aebaf3) 80%,transparent); color:#101522;
        box-shadow:0 3px 10px rgba(0,0,0,0.24);
      }
      .tss-hub-btn-lg:hover {
        filter:brightness(1.12);
        box-shadow:0 4px 12px rgba(0,0,0,0.3);
      }

      #tss-hub-start {
        width:100%; border:none; border-radius:10px;
        padding:9px 14px; font-size:12px; font-weight:600;
        font-family:-apple-system,'Segoe UI',system-ui,sans-serif;
        cursor:pointer; letter-spacing:0.02em;
        transition:background 0.2s, color 0.2s;
      }
      #tss-hub-start:not([data-active="true"]):not([data-loading="true"]) {
        background:rgba(var(--tss-ar,174),var(--tss-ag,186),var(--tss-ab,243),0.14);
        color:var(--tss-a,#aebaf3);
        border:1px solid rgba(var(--tss-ar,174),var(--tss-ag,186),var(--tss-ab,243),0.28);
      }
      #tss-hub-start:not([data-active="true"]):not([data-loading="true"]):hover {
        background:rgba(var(--tss-ar,174),var(--tss-ag,186),var(--tss-ab,243),0.26);
      }
      #tss-hub-start[data-active="true"] {
        background:rgba(255,255,255,0.05); color:rgba(255,255,255,0.78);
        border:1px solid rgba(255,255,255,0.16);
      }
      #tss-hub-start[data-active="true"]:hover {
        background:rgba(255,255,255,0.1); color:rgba(255,255,255,0.55);
      }
      #tss-hub-start[data-loading="true"] {
        background:rgba(255,255,255,0.05); color:rgba(255,255,255,0.78);
        border:1px solid rgba(255,255,255,0.16);
        cursor:pointer;
      }


      #tss-hub-qico[data-open="true"] { color:var(--tss-a,#aebaf3) !important; }
      #tss-hub-pip[data-open="true"] { color:var(--tss-a,#aebaf3) !important;border-color:rgba(var(--tss-ar,174),var(--tss-ag,186),var(--tss-ab,243),.44) !important;background:rgba(var(--tss-ar,174),var(--tss-ag,186),var(--tss-ab,243),.12) !important; }

      #tss-hub-reshuffle { color:rgba(255,255,255,.8); }
      #tss-hub-reshuffle:hover {
        color:var(--tss-a,#aebaf3);
        background:rgba(var(--tss-ar,174),var(--tss-ag,186),var(--tss-ab,243),0.12);
      }
      #tss-hub-reshuffle:disabled { cursor:wait; opacity:0.55; }
      #tss-hub-reshuffle[data-loading="true"] svg { animation:tss-spin 0.8s linear infinite; }
      @keyframes tss-spin { to { transform:rotate(360deg); } }
      @media (prefers-reduced-motion:reduce) {
        #tss-hub-reshuffle[data-loading="true"] svg { animation:none; }
      }

      .tss-badge {
        display:inline-flex; align-items:center; justify-content:center;
        background:rgba(255,255,255,.08); color:#b9bec5;
        border-radius:4px; font-size:10px; padding:2px 6px;
        margin-right:6px; font-weight:700; vertical-align:middle;
        border:1px solid #2a2a2a; letter-spacing:0.03em;
      }
      .tss-badge-cur {
        background:rgba(var(--tss-ar,174),var(--tss-ag,186),var(--tss-ab,243),0.12);
        color:var(--tss-a,#aebaf3);
        border-color:rgba(var(--tss-ar,174),var(--tss-ag,186),var(--tss-ab,243),0.28);
      }

      #tss-sidebar-list::-webkit-scrollbar { width:3px; }
      #tss-sidebar-list::-webkit-scrollbar-thumb { background:#555b64; border-radius:2px; }
      #tss-sidebar-list::-webkit-scrollbar-track { background:transparent; }

      #tss-ctx {
        position:fixed; background:var(--tss-glass-surface,#080b12); border:1px solid var(--tss-glass-rim);
        border-radius:10px; z-index:999999; overflow:hidden; min-width:172px;
        font-family:-apple-system,'Segoe UI',system-ui,sans-serif;
        box-shadow:var(--tss-glass-shadow);
        -webkit-backdrop-filter:var(--tss-glass-filter,none);backdrop-filter:var(--tss-glass-filter,none);
      }
      .tss-ctx-item { padding:9px 15px; cursor:pointer; color:#c0c0c0; font-size:12px; transition:background 0.1s; }
      .tss-ctx-item:hover { background:rgba(255,255,255,.08); }
      .tss-ctx-disabled { color:#8d949e !important; cursor:not-allowed; }
      .tss-ctx-disabled:hover { background:transparent !important; }

      #tss-hub-sleep {
        background:var(--tss-glass-inset); border:1px solid rgba(204,218,255,.10);box-shadow:inset 0 1px 0 rgba(213,225,250,.025);
        color:rgba(255,255,255,0.72); font-size:10px; border-radius:7px;
        padding:4px 6px; cursor:pointer;
        font-family:-apple-system,'Segoe UI',system-ui,sans-serif;
        transition:border-color 0.15s;
      }
      #tss-hub-sleep:hover { border-color:rgba(255,255,255,0.18); }
      #tss-hub-sleep option { background:#101113; }

      .tss-crossfade-card { padding:0 0 12px; }
      .tss-crossfade-heading { display:flex;align-items:center;justify-content:space-between;color:rgba(255,255,255,.88);font-size:12px;font-weight:600; }
      #tss-hub-crossfade-status { color:rgba(255,255,255,.7);font-size:10px; }
      #tss-hub-crossfade-status[data-status="mixing"] { color:var(--tss-a,#aebaf3); }
      #tss-hub-crossfade-status[data-status="fallback"] { color:#d39a62; }
      .tss-crossfade-setting-head { display:flex;align-items:center;justify-content:space-between;margin:9px 0 7px;color:rgba(255,255,255,.7);font-size:10px;font-weight:600;letter-spacing:.02em; }
      #tss-crossfade-seconds { color:#fff;font-size:9px;letter-spacing:0;text-transform:none; }
      #tss-hub-crossfade {
        width:100%;height:16px;margin:0;appearance:none;background:transparent;cursor:pointer;accent-color:var(--tss-a,#aebaf3);
      }
      #tss-hub-crossfade::-webkit-slider-runnable-track { height:3px;border-radius:3px;background:linear-gradient(90deg,var(--tss-a,#aebaf3) var(--tss-crossfade-fill,0%),rgba(114,130,165,.18) var(--tss-crossfade-fill,0%));box-shadow:inset 0 1px 2px rgba(3,4,10,.3); }
      #tss-hub-crossfade::-webkit-slider-thumb { appearance:none;width:12px;height:12px;margin-top:-4.5px;border-radius:50%;background:#fff;border:2px solid rgba(0,0,0,.35);box-shadow:0 1px 5px rgba(0,0,0,.6); }
      #tss-hub-crossfade:focus-visible { outline:2px solid var(--tss-a,#aebaf3);outline-offset:3px;border-radius:4px; }
      .tss-crossfade-ticks { display:flex;justify-content:space-between;color:rgba(255,255,255,.65);font-size:9px;margin-top:1px; }
      .tss-crossfade-modes { display:grid;grid-template-columns:repeat(3,1fr);gap:3px;padding:3px;background:rgba(0,0,0,.04);border-radius:7px;box-shadow:inset 0 1px 3px rgba(0,0,0,.08); }
      .tss-crossfade-mode { border:0;border-radius:5px;padding:7px 3px;background:transparent;color:rgba(255,255,255,.7);font:600 10px/1 -apple-system,'Segoe UI',system-ui,sans-serif;cursor:pointer;transition:background .15s,color .15s; }
      .tss-crossfade-mode:hover { color:rgba(255,255,255,.72); }
      .tss-crossfade-mode[data-active="true"] { color:#fff;background:rgba(174,186,243,.12);box-shadow:inset 0 1px 0 rgba(255,255,255,.025),0 2px 5px rgba(0,0,0,.12); }
      .tss-crossfade-mode:focus-visible { outline:2px solid var(--tss-a,#aebaf3);outline-offset:1px; }
      .tss-crossfade-manual { display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:9px;color:rgba(255,255,255,.7);font-size:10px;cursor:pointer; }
      .tss-crossfade-manual input { width:13px;height:13px;margin:0;accent-color:var(--tss-a,#aebaf3);cursor:pointer; }
      #tss-playback-debug { color:var(--tss-t2,#aaa); }
      #tss-playback-debug:hover { color:var(--tss-t,#eee);background:rgba(255,255,255,.08); }
      #tss-playback-debug:focus-visible { outline:2px solid currentColor;outline-offset:2px; }
      #tss-playback-debug[data-status="current"] { color:#ff5353; }
      #tss-playback-debug[data-status="current"]:hover { color:#ff8585;background:rgba(255,70,70,.12); }
      #tss-playback-debug[hidden] { display:none!important; }
      #tss-debug-overlay,#tss-debug-help-overlay { position:fixed;inset:0;z-index:1000002;display:flex;align-items:center;justify-content:center;padding:22px;background:rgba(0,0,0,.04); }
      #tss-debug-help-overlay { z-index:1000003; }
      .tss-debug-dialog { box-sizing:border-box;width:min(620px,calc(100vw - 28px));max-height:min(680px,calc(100dvh - 44px));overflow:auto;display:flex;flex-direction:column;gap:10px;padding:16px;border:1px solid var(--tss-glass-rim);border-radius:14px;background:var(--tss-glass-surface,#080b12);-webkit-backdrop-filter:var(--tss-glass-filter,none);backdrop-filter:var(--tss-glass-filter,none);box-shadow:var(--tss-glass-shadow);color:#eee;font-family:-apple-system,'Segoe UI',system-ui,sans-serif; }
      .tss-debug-head { display:flex;align-items:center;justify-content:space-between;gap:15px; }
      .tss-debug-head strong { display:block;font-size:13px;letter-spacing:.02em; }
      .tss-debug-head span { display:block;margin-top:2px;color:rgba(255,255,255,.7);font-size:10px; }
      .tss-debug-head button { width:28px;height:28px;display:grid;place-items:center;border:0;border-radius:7px;background:rgba(255,255,255,.06);color:rgba(255,255,255,.65);cursor:pointer; }
      .tss-debug-dialog p { margin:0;color:rgba(255,255,255,.72);font-size:11px;line-height:1.5; }
      #tss-debug-report,#tss-debug-full-report { min-height:180px;max-height:460px;margin:0;padding:11px;overflow:auto;border:1px solid rgba(255,255,255,.07);border-radius:8px;background:var(--tss-glass-inset,#10131d);color:#b7c3cc;font:10px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;word-break:break-word;-webkit-user-select:text;user-select:text;scrollbar-color:#555b64 transparent; }
      #tss-debug-report:focus-visible,#tss-debug-full-report:focus-visible,#tss-debug-details summary:focus-visible { outline:2px solid var(--tss-a,#aebaf3);outline-offset:2px; }
      .tss-debug-dialog ::selection { background:rgba(174,186,243,.3);color:#fff; }
      #tss-debug-details summary { padding:5px 0;color:#b7c3cc;font-size:11px;cursor:pointer; }
      #tss-debug-details[open] summary { margin-bottom:8px; }
      #tss-debug-details .tss-debug-actions { margin-top:8px; }
      #tss-debug-copy-full[hidden] { display:none!important; }
      .tss-debug-actions { display:flex;flex-wrap:wrap;justify-content:flex-end;gap:7px; }
      .tss-debug-actions button { min-width:92px;padding:8px 11px;border:1px solid rgba(255,255,255,.1);border-radius:7px;background:rgba(255,255,255,.055);color:#ddd;font:700 9px/1 -apple-system,'Segoe UI',system-ui,sans-serif;cursor:pointer; }
      #tss-debug-copy { border-color:rgba(var(--tss-ar,174),var(--tss-ag,186),var(--tss-ab,243),.35);background:rgba(var(--tss-ar,174),var(--tss-ag,186),var(--tss-ab,243),.13);color:#fff; }
      .tss-debug-help-dialog { width:min(480px,calc(100vw - 28px));gap:16px; }
      .tss-debug-help-steps { margin:0;padding-left:22px;color:#bbb;font-size:14px;line-height:1.55; }
      .tss-debug-help-steps li + li { margin-top:12px; }
      .tss-debug-help-steps a { color:var(--tss-a,#aebaf3);text-decoration:underline;text-underline-offset:3px; }
      .tss-debug-help-steps strong { color:#eee; }
      .tss-debug-help-dialog p { color:#aaa;font-size:12px;line-height:1.5; }
      @media (prefers-reduced-motion:reduce) {
        #tss-hub *,#tss-sidebar { transition:none !important;animation:none !important; }
      }

      #tss-hub {
        --tss-panel:#10131d;
        --tss-line:rgba(204,218,255,.08);
        --tss-muted:rgba(255,255,255,0.7);
        box-sizing:border-box;
      }
      #tss-hub-hdr { flex-shrink:0;min-height:34px;cursor:move;padding:11px 13px 10px;display:flex;align-items:center;justify-content:space-between;gap:8px; }
      .tss-hub-navigation { display:flex;align-items:center;gap:4px;flex-shrink:0; }
      .tss-hub-navigation .tss-hub-btn-icon { width:32px;min-width:32px;min-height:32px;color:rgba(255,255,255,.88); }
      .tss-hub-navigation .tss-hub-btn-icon svg { width:16px !important;height:16px !important; }
      #tss-hub-settings[aria-expanded="false"] .tss-settings-back-icon,
      #tss-hub-settings[aria-expanded="true"] .tss-settings-gear-icon { display:none; }
      .tss-deck-brand { display:flex;align-items:center;gap:8px;min-width:0; }
      .tss-deck-brandmark { display:flex;align-items:center;color:rgba(255,255,255,.8); }
      .tss-deck-brandmark svg { width:17px;height:17px; }
      .tss-hub-text-button { gap:7px;min-height:32px;padding:0 9px;border-radius:7px;background:rgba(255,255,255,.055);color:rgba(255,255,255,.88);font:600 11px/1 -apple-system,'Segoe UI',system-ui,sans-serif; }
      .tss-hub-text-button:hover { background:rgba(255,255,255,.1); }
      #tss-hub-settings[aria-expanded="true"] { color:var(--tss-a,#aebaf3);background:rgba(174,186,243,.12); }
      #tss-hub-col { min-width:32px;min-height:32px; }
      #tss-hub-col[aria-expanded="false"] svg { transform:rotate(180deg); }
      .tss-deck-label {
        color:rgba(255,255,255,0.9);font-size:11px;font-weight:650;
        letter-spacing:0.015em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;
      }
      .tss-deck-track {
        display:grid;grid-template-columns:78px minmax(0,1fr);gap:13px;
        align-items:center;padding:5px 14px 12px;
      }
      #tss-hub-art { width:78px;height:78px;border-radius:13px;background:rgba(255,255,255,.045);overflow:hidden;display:flex;align-items:center;justify-content:center;box-shadow:0 5px 14px rgba(0,0,0,.24); }
      .tss-deck-track-copy { min-width:0; }
      #tss-hub-title { color:#fff;font-size:15.5px;font-weight:740;letter-spacing:-.02em;line-height:1.2; }
      #tss-hub-artist { font-size:11px;color:rgba(255,255,255,.72);margin-top:5px;line-height:1.3; }
      #tss-hub-title,#tss-hub-artist { overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
      #tss-hub-qpos { margin-left:auto;min-width:0;overflow:hidden;text-overflow:ellipsis;color:rgba(255,255,255,.72);font-size:10px;font-weight:500;font-variant-numeric:tabular-nums; }
      .tss-main-queue { display:grid;grid-template-columns:minmax(0,1fr) auto;gap:7px;padding:0 14px 14px; }
      #tss-hub-qico { min-width:0;width:100%;flex-shrink:1;justify-content:flex-start;min-height:36px; }
      #tss-hub-reshuffle { min-height:36px; }
      #tss-hub-actions { padding:0 14px 14px; }
      .tss-deck-timeline { padding:0 14px 1px; }
      #tss-hub-seekbar {
        position:relative;cursor:pointer;margin:0;height:16px;border-radius:2px;
        background:transparent;overflow:hidden;transform:none;
      }
      #tss-hub-seekbar:hover { transform:none !important; }
      #tss-hub-prog { position:absolute;left:0;bottom:0;height:1px;background:transparent !important;opacity:0;pointer-events:none; }
      .tss-wave-bars { position:absolute;inset:0;display:flex;align-items:center;gap:3px; }
      .tss-wave-bars i { display:block;flex:1;min-width:1px;height:var(--h);border-radius:2px;background:rgba(255,255,255,.2);transition:background .12s ease,filter .12s ease; }
      .tss-wave-bars i[data-played="true"] { background:var(--tss-a,#aebaf3); }
      .tss-deck-times { display:flex;justify-content:space-between;margin-top:5px;color:rgba(255,255,255,.7);font-size:10px;font-variant-numeric:tabular-nums; }
      .tss-deck-controls { display:flex;align-items:center;justify-content:center;gap:16px;padding:9px 14px 15px; }
      .tss-deck-controls .tss-hub-btn-sm { width:40px;height:40px;background:rgba(0,0,0,.12);box-shadow:inset 0 1px 0 rgba(255,255,255,.025),0 3px 9px rgba(0,0,0,.2);color:rgba(255,255,255,.82); }
      .tss-deck-controls .tss-hub-btn-lg { width:54px;height:54px;box-shadow:0 4px 12px rgba(0,0,0,.25); }
      .tss-master-volume { display:grid;grid-template-columns:14px minmax(0,1fr) 31px;align-items:center;gap:9px;margin:-3px 14px 16px;color:rgba(255,255,255,.7); }
      #tss-hub-volume { width:100%;height:18px;margin:0;appearance:none;background:transparent;cursor:pointer; }
      #tss-hub-volume::-webkit-slider-runnable-track { height:3px;border-radius:3px;background:linear-gradient(90deg,var(--tss-a,#aebaf3) var(--tss-volume-fill,10%),rgba(114,130,165,.18) var(--tss-volume-fill,10%));box-shadow:inset 0 1px 2px rgba(3,4,10,.3); }
      #tss-hub-volume::-webkit-slider-thumb { appearance:none;width:12px;height:12px;margin-top:-4.5px;border-radius:50%;background:#fff;border:2px solid rgba(0,0,0,.35);box-shadow:0 1px 5px rgba(0,0,0,.6); }
      #tss-hub-volume:focus-visible { outline:2px solid var(--tss-a,#aebaf3);outline-offset:3px;border-radius:4px; }
      #tss-hub-volume-value { color:rgba(255,255,255,.72);font-size:10px;font-weight:600;text-align:right;font-variant-numeric:tabular-nums; }
      #tss-auto-level { justify-content:space-between; }
      #tss-auto-level:hover { color:#fff;background:rgba(255,255,255,.1);border-color:#777; }
      #tss-auto-level[data-active="true"] { color:#fff;border-color:var(--tss-a,#aebaf3);background:rgba(174,186,243,.12); }
      #tss-auto-level:focus-visible { outline:2px solid var(--tss-a,#aebaf3);outline-offset:2px; }
      .tss-hub-btn:focus-visible,#tss-hub-start:focus-visible,#tss-hub-sleep:focus-visible {
        outline:2px solid var(--tss-a,#aebaf3);outline-offset:2px;
      }
      #tss-hub-stop-after {
        appearance:none;-webkit-appearance:none;width:31px;height:18px;margin:0;
        border-radius:999px;background:rgba(0,0,0,.12);
        border:1px solid rgba(204,218,255,.11);box-shadow:inset 0 1px 3px rgba(2,4,10,.3);position:relative;cursor:pointer;
        transition:background .18s,border-color .18s;vertical-align:middle;
      }
      #tss-hub-stop-after::after {
        content:'';position:absolute;width:12px;height:12px;left:2px;top:2px;border-radius:50%;
        background:rgba(255,255,255,0.72);transition:transform .18s,background .18s;
      }
      #tss-hub-stop-after:checked {
        background:rgba(var(--tss-ar,174),var(--tss-ag,186),var(--tss-ab,243),0.35);
        border-color:rgba(var(--tss-ar,174),var(--tss-ag,186),var(--tss-ab,243),0.58);
      }
      #tss-hub-stop-after:checked::after { transform:translateX(13px);background:#fff; }
      #tss-hub-stop-after:focus-visible { outline:2px solid var(--tss-a,#aebaf3);outline-offset:2px; }
      #tss-hub [hidden],#tss-sidebar[hidden] { display:none !important; }
      #tss-hub-body { position:relative;display:flex;flex-direction:column;min-height:0;overflow:hidden; }
      #tss-hub-main-view,#tss-hub-settings-view {
        min-height:0;flex:0 1 auto;overflow-x:hidden;overflow-y:auto;
        scrollbar-gutter:stable;scrollbar-width:thin;scrollbar-color:#555b64 transparent;
      }
      #tss-hub-main-view::-webkit-scrollbar,#tss-hub-settings-view::-webkit-scrollbar { width:6px; }
      #tss-hub-main-view::-webkit-scrollbar-thumb,#tss-hub-settings-view::-webkit-scrollbar-thumb { background:#555b64;border-radius:3px; }
      #tss-hub-main-view::-webkit-scrollbar-track,#tss-hub-settings-view::-webkit-scrollbar-track { background:transparent; }
      #tss-hub-main-view[data-motion="exiting"],#tss-hub-settings-view[data-motion="exiting"],
      .tss-settings-panel[data-motion="exiting"] { position:absolute;top:0;left:0;right:0;z-index:2;pointer-events:none; }
      /* Preserve the tab footprint as viewport space, not artificial scrollable content. */
      #tss-hub-settings-view { box-sizing:border-box;height:384px;padding:2px 14px 14px; }
      #tss-settings-title { margin:0 0 13px;color:#fff;font-size:18px;line-height:1.3;font-weight:650;letter-spacing:-.02em; }
      .tss-settings-tabs { display:flex;gap:20px;margin-bottom:16px;border-bottom:1px solid rgba(255,255,255,.09); }
      .tss-settings-tab { display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:32px;padding:0 0 10px;border:0;border-bottom:2px solid transparent;background:transparent;color:rgba(255,255,255,.72);font:600 11px/1.2 -apple-system,'Segoe UI',system-ui,sans-serif;cursor:pointer; }
      .tss-settings-tab:hover { color:#fff; }
      .tss-settings-tab[aria-selected="true"] { color:var(--tss-a,#aebaf3);border-bottom-color:var(--tss-a,#aebaf3); }
      .tss-settings-tab:focus-visible { outline:2px solid var(--tss-a,#aebaf3);outline-offset:3px;border-radius:2px; }
      .tss-settings-panels { position:relative;min-height:0;overflow:clip;padding:4px;margin:-4px; }
      .tss-settings-action { display:flex;align-items:center;justify-content:flex-start;gap:9px;width:100%;min-height:36px;padding:8px 9px;border:0;border-radius:7px;background:transparent;color:rgba(255,255,255,.8);text-align:left;font:500 11px/1.4 -apple-system,'Segoe UI',system-ui,sans-serif;cursor:pointer; }
      .tss-settings-action:hover { background:rgba(255,255,255,.075);color:#fff; }
      .tss-settings-action svg { width:16px;height:16px;flex-shrink:0; }
      .tss-settings-action:focus-visible,.tss-settings-row input:focus-visible { outline:2px solid var(--tss-a,#aebaf3);outline-offset:2px; }
      .tss-settings-row { display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:36px;color:rgba(255,255,255,.8);font-size:11px;cursor:pointer; }
      #tss-reduce-visual-effects,#tss-scroll-long-titles { width:13px;height:13px;margin:0;accent-color:var(--tss-a,#aebaf3);cursor:pointer; }
      #tss-visual-effects-help,#tss-scroll-long-titles-help { margin:0 0 10px;color:rgba(255,255,255,.7);font-size:10px;line-height:1.5; }
      #tss-hub-sleep { font-size:11px;padding:6px 8px;max-width:120px; }
      #tss-hub-sleep-display { display:block;color:var(--tss-a,#aebaf3);font-size:10px;text-align:right;font-variant-numeric:tabular-nums; }
      #tss-hub-sleep-display:empty { display:none; }
      #tss-settings-session-action { margin-top:18px;padding-top:16px;border-top:1px solid rgba(255,255,255,.09); }
      #tss-hub-start { min-height:42px;border-radius:9px;letter-spacing:0;font-size:11px; }
      #tss-hub-start[data-active="true"]:hover { color:rgba(255,255,255,.9);border-color:rgba(255,255,255,.25); }
      #tss-hub[data-mini="true"][data-view="main"] .tss-deck-track,
      #tss-hub[data-mini="true"][data-view="main"] .tss-deck-timeline,
      #tss-hub[data-mini="true"][data-view="main"] .tss-master-volume { display:none; }
      #tss-hub[data-mini="true"] .tss-deck-controls { padding:3px 14px 12px;gap:18px; }
      #tss-hub[data-mini="true"] .tss-deck-controls .tss-hub-btn-lg { width:42px;height:42px; }
      #tss-hub[data-mini="true"] .tss-deck-controls .tss-hub-btn-sm { width:34px;height:34px; }
      #tss-hub[data-mini="true"] .tss-main-queue { padding-bottom:10px; }
      #tss-hub[data-queue-view="true"] #tss-hub-main-view,
      #tss-hub[data-queue-view="true"] #tss-hub-settings-view { display:none !important; }
      #tss-hub-queue-space { height:min(420px,calc(100dvh - 180px)); }
      #tss-hub,#tss-sidebar { max-width:calc(100vw - 24px); }
      #tss-hub::selection,#tss-hub ::selection,#tss-sidebar ::selection { background:rgba(174,186,243,.3);color:#fff; }
      #tss-sidebar [tabindex]:focus-visible,#tss-sidebar button:focus-visible { outline:2px solid var(--tss-a,#aebaf3);outline-offset:-2px; }
      #tss-sidebar[data-layout="narrow"] { z-index:99997;border-radius:0 0 17px 17px !important;box-shadow:none;border-top:0; }
      #tss-sidebar[data-layout="narrow"] .tss-sidebar-resize,
      #tss-sidebar[data-layout="narrow"] .tss-sidebar-height-resize { display:none; }
      #tss-sidebar[data-layout="narrow"] #tss-sidebar-content { overflow-y:auto; }
      #tss-sidebar[data-layout="narrow"] #tss-sidebar-list { flex:1 0 100px; }

      .tss-side-head { padding:10px 12px 8px;border-bottom:1px solid var(--tss-line);flex-shrink:0; }
      .tss-side-titlebar { display:flex;align-items:center;gap:6px;margin-bottom:6px; }
      .tss-side-title { color:rgba(255,255,255,0.94);font-size:13px;font-weight:650;letter-spacing:-.01em; }
      .tss-side-action {
        display:flex;align-items:center;justify-content:center;gap:7px;min-height:34px;padding:0 11px;
        border:1px solid rgba(204,218,255,.10);border-radius:8px;background:var(--tss-glass-inset);
        color:rgba(255,255,255,.74);cursor:pointer;font-size:10px;font-weight:600;letter-spacing:.02em;
        transition:color .18s,border-color .18s,background .18s;
      }
      .tss-side-action:hover { color:#fff;border-color:rgba(255,255,255,.2);background:rgba(255,255,255,.07); }
      .tss-side-tabs { display:flex;align-items:center;gap:24px;border-bottom:1px solid rgba(255,255,255,.07); }
      .tss-side-tab {
        border:0;background:transparent;color:rgba(255,255,255,.32);padding:0 0 10px;cursor:pointer;
        font:700 10px/1 -apple-system,'Segoe UI',system-ui,sans-serif;letter-spacing:.1em;text-transform:uppercase;
        border-bottom:2px solid transparent;transition:color .18s,border-color .18s;
      }
      .tss-side-tab[data-active="true"] { color:var(--tss-a,#aebaf3);border-bottom-color:var(--tss-a,#aebaf3); }
      #tss-tab-queue,#tss-tab-history {
        background:transparent !important;border:0 !important;border-radius:0 !important;
        padding:5px 0 10px !important;color:rgba(255,255,255,.7) !important;
        font-size:11px !important;font-weight:600 !important;letter-spacing:.02em;
        border-bottom:2px solid transparent !important;
      }
      #tss-tab-queue[data-active="true"],#tss-tab-history[data-active="true"] {
        color:var(--tss-a,#aebaf3) !important;border-bottom-color:var(--tss-a,#aebaf3) !important;
      }
      #tss-merge-btn {
        color:rgba(255,255,255,.74) !important;display:flex !important;align-items:center;justify-content:center;
        min-height:30px;padding:0 9px !important;border:1px solid rgba(255,255,255,.09);border-radius:8px !important;
        background:rgba(255,255,255,.025) !important;cursor:pointer;transition:color .18s,border-color .18s,background .18s;
      }
      #tss-merge-btn:hover { color:#fff !important;border-color:rgba(255,255,255,.18);background:rgba(255,255,255,.065) !important; }
      .tss-side-searchwrap { position:relative;margin-top:13px; }
      .tss-side-searchicon { position:absolute;left:11px;top:50%;transform:translateY(-50%);color:rgba(255,255,255,.65);pointer-events:none;display:flex; }
      #tss-search { width:100% !important;box-sizing:border-box !important;background:var(--tss-glass-inset) !important;border:1px solid rgba(204,218,255,.10) !important;border-radius:9px !important;color:#dedede !important;font-size:11px !important;padding:9px 11px !important;outline:none !important;font-family:-apple-system,'Segoe UI',system-ui,sans-serif !important;transition:border-color .18s,background .18s !important; }
      #tss-search:focus { border-color:rgba(var(--tss-ar,174),var(--tss-ag,186),var(--tss-ab,243),.75) !important;background:rgba(255,255,255,.06) !important;outline:2px solid #d9dfe7 !important;outline-offset:2px; }
      .tss-queue-row { border-bottom:1px solid rgba(255,255,255,.055); }
      .tss-queue-handle { color:rgba(255,255,255,.18);font-size:14px;letter-spacing:-2px;width:10px;overflow:hidden;flex-shrink:0; }
      .tss-queue-status { border-radius:5px;padding:3px 7px;font-size:8px;font-weight:750;letter-spacing:.07em;text-transform:uppercase;flex-shrink:0; }
      #tss-sidebar[data-side="left"] { border-radius:16px 0 0 16px !important; }
      #tss-sidebar[data-side="right"] { border-radius:0 16px 16px 0 !important; }
      #tss-hub[data-sidebar-side="right"] { border-radius:18px 0 0 18px !important; }
      #tss-hub[data-sidebar-side="left"] { border-radius:0 18px 18px 0 !important; }
      #tss-sidebar[data-open="false"] { pointer-events:none; }
      /* Docked glass unfolds behind the player; the narrow replacement stays above it. */
      #tss-sidebar { box-sizing:border-box;z-index:99993; }
      #tss-sidebar-content { position:relative;display:flex;flex-direction:column;flex:1;min-height:0;min-width:0;overflow:hidden; }
      #tss-sidebar-list { flex:1;min-height:0; }
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
        height:54px;background:var(--tss-a,#aebaf3);
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
        width:54px;background:var(--tss-a,#aebaf3);
      }

      #tss-hub-eq[data-active="true"] { color:#fff !important;border-color:var(--tss-a,#aebaf3) !important;background:rgba(174,186,243,.12) !important; }
      #tss-modal-backdrop { position:fixed;inset:0;z-index:999998;background:rgba(0,0,0,.04);animation:tss-backdrop-in .18s ease-out; }
      @keyframes tss-backdrop-in { from { opacity:0; } to { opacity:1; } }
      #tss-eq-overlay {
        position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:999999;
        width:560px;max-width:calc(100vw - 28px);box-sizing:border-box;color:#eee;
        max-height:calc(100dvh - 28px);overflow-y:auto;
        background:var(--tss-glass-surface,#080b12);border:1px solid var(--tss-glass-rim);border-radius:16px;
        box-shadow:var(--tss-glass-shadow);
        font-family:-apple-system,'Segoe UI',system-ui,sans-serif;-webkit-user-select:none;user-select:none;
        -webkit-backdrop-filter:var(--tss-glass-filter,none);backdrop-filter:var(--tss-glass-filter,none);
      }
      .tss-eq-head { display:flex;align-items:center;justify-content:space-between;padding:17px 18px 14px;border-bottom:1px solid rgba(255,255,255,.075); }
      .tss-eq-kicker { color:var(--tss-a,#aebaf3);font-size:8px;font-weight:760;letter-spacing:.13em;text-transform:uppercase; }
      .tss-eq-title { margin-top:4px;color:#f3f3f3;font-size:17px;font-weight:680;letter-spacing:-.02em; }
      .tss-eq-head-actions { display:flex;align-items:center;gap:7px; }
      #tss-eq-power { height:32px;padding:0 10px;border:1px solid rgba(255,255,255,.18);border-radius:8px;background:rgba(255,255,255,.04);color:#c8cdd4;cursor:pointer;font:600 10px/1 -apple-system,'Segoe UI',system-ui,sans-serif;letter-spacing:.02em;transition:color .18s,border-color .18s,background .18s; }
      #tss-eq-power[data-active="true"] { color:#fff;border-color:var(--tss-a,#aebaf3);background:rgba(174,186,243,.12); }
      #tss-eq-power:focus-visible,.tss-eq-preset:focus-visible,.tss-eq-point-hit:focus-visible,#tss-eq-reset:focus-visible { outline:2px solid var(--tss-a,#aebaf3);outline-offset:2px; }
      .tss-eq-body { position:relative;padding:15px 18px 16px; }
      .tss-eq-presets { display:flex;gap:7px;overflow-x:auto;padding:1px 1px 12px;scrollbar-width:none; }
      .tss-eq-presets::-webkit-scrollbar { display:none; }
      .tss-eq-preset { flex:0 0 auto;height:30px;padding:0 11px;border:1px solid rgba(204,218,255,.12);border-radius:8px;background:var(--tss-glass-inset);color:rgba(255,255,255,.75);cursor:pointer;font:600 10px/1 -apple-system,'Segoe UI',system-ui,sans-serif;letter-spacing:.02em;transition:color .18s,border-color .18s,background .18s; }
      .tss-eq-preset:hover { color:#fff;border-color:rgba(255,255,255,.22);background:rgba(255,255,255,.07); }
      .tss-eq-preset[data-active="true"] { color:#fff;border-color:rgba(174,186,243,.7);background:rgba(174,186,243,.12); }
      .tss-eq-custom-preset { display:inline-flex;flex:0 0 auto; }
      .tss-eq-custom-preset .tss-eq-preset { border-radius:8px 0 0 8px;border-right:0; }
      .tss-eq-preset-remove { width:25px;height:30px;padding:0;display:flex;align-items:center;justify-content:center;border:1px solid rgba(255,255,255,.1);border-radius:0 8px 8px 0;background:rgba(255,255,255,.035);color:rgba(255,255,255,.3);cursor:pointer;transition:color .18s,border-color .18s,background .18s; }
      .tss-eq-preset-remove:hover { color:#ff9292;border-color:rgba(255,74,74,.4);background:rgba(255,74,74,.1); }
      #tss-eq-save-open { flex:0 0 auto;height:30px;padding:0 11px;border:1px dashed rgba(255,255,255,.2);border-radius:8px;background:transparent;color:rgba(255,255,255,.48);cursor:pointer;font:700 9px/1 -apple-system,'Segoe UI',system-ui,sans-serif;transition:color .18s,border-color .18s,background .18s; }
      #tss-eq-save-open:hover { color:#fff;border-color:var(--tss-a,#aebaf3);background:rgba(174,186,243,.08); }
      #tss-eq-save-row { display:none;grid-template-columns:minmax(0,1fr) auto 30px;align-items:end;gap:7px;margin:-2px 1px 12px;padding:10px;border:1px solid rgba(255,255,255,.09);border-radius:10px;background:var(--tss-glass-inset); }
      #tss-eq-save-row[data-open="true"] { display:grid; }
      .tss-eq-save-field { display:grid;gap:5px;min-width:0; }
      .tss-eq-save-field span { color:rgba(255,255,255,.72);font-size:10px;font-weight:600;letter-spacing:.02em; }
      #tss-eq-save-name { width:100%;height:31px;box-sizing:border-box;padding:0 9px;border:1px solid rgba(255,255,255,.14);border-radius:7px;background:rgba(0,0,0,.08);color:#eee;outline:none;font:500 10px/1 -apple-system,'Segoe UI',system-ui,sans-serif; }
      #tss-eq-save-name:focus { border-color:var(--tss-a,#aebaf3);box-shadow:0 0 0 2px rgba(174,186,243,.12); }
      #tss-eq-save-confirm,#tss-eq-save-cancel { height:31px;border:1px solid rgba(255,255,255,.13);border-radius:7px;cursor:pointer;font:700 9px/1 -apple-system,'Segoe UI',system-ui,sans-serif; }
      #tss-eq-save-confirm { padding:0 12px;background:var(--tss-a,#aebaf3);border-color:var(--tss-a,#aebaf3);color:#101522; }
      #tss-eq-save-cancel { width:30px;padding:0;display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,.045);color:rgba(255,255,255,.5); }
      #tss-eq-save-error { grid-column:1/-1;min-height:0;color:#ff805f;font-size:8px; }
      .tss-eq-graph-wrap { border-top:1px solid rgba(255,255,255,.055);border-bottom:1px solid rgba(255,255,255,.055);padding:4px 0 1px;background:var(--tss-glass-inset); }
      .tss-eq-safety { display:flex;align-items:center;justify-content:space-between;gap:18px;padding:11px 2px 0;color:#ddd;cursor:pointer; }
      .tss-eq-safety span { display:grid;gap:3px; }
      .tss-eq-safety strong { font-size:10px;font-weight:750; }
      .tss-eq-safety small { color:rgba(255,255,255,.72);font-size:10px;line-height:1.45; }
      .tss-eq-safety input { width:15px;height:15px;flex:0 0 auto;accent-color:var(--tss-a,#aebaf3); }
      .tss-eq-graph { display:block;width:100%;height:auto;overflow:visible;touch-action:none; }
      .tss-eq-grid line { stroke:rgba(255,255,255,.105);stroke-width:1;stroke-dasharray:3 4; }
      .tss-eq-grid .tss-eq-zero { stroke:rgba(255,255,255,.28);stroke-dasharray:none; }
      .tss-eq-point-visible { fill:var(--tss-a,#aebaf3);stroke:#fff;stroke-width:2.5;filter:drop-shadow(0 2px 4px rgba(0,0,0,.8));pointer-events:none; }
      .tss-eq-point-hit { fill:transparent;stroke:transparent;cursor:ns-resize;pointer-events:all;touch-action:none; }
      .tss-eq-point-visible:has(+ .tss-eq-point-hit:hover),.tss-eq-point-visible:has(+ .tss-eq-point-hit:focus-visible) { fill:#fff; }
      .tss-eq-point-value { fill:rgba(255,255,255,.72);font-size:9px;font-weight:750;font-variant-numeric:tabular-nums;pointer-events:none; }
      .tss-eq-frequency { fill:rgba(255,255,255,.74);font-size:10px;font-weight:600;pointer-events:none; }
      .tss-eq-axis-label { fill:rgba(255,255,255,.7);font-size:9px;font-weight:600;pointer-events:none; }
      .tss-eq-footer { display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:11px;color:rgba(255,255,255,.72);font-size:10px;font-weight:500;letter-spacing:.01em; }
      #tss-eq-reset { height:30px;padding:0 13px;border:1px solid rgba(255,255,255,.16);border-radius:8px;background:transparent;color:rgba(255,255,255,.68);cursor:pointer;font:700 9px/1 -apple-system,'Segoe UI',system-ui,sans-serif;transition:color .18s,border-color .18s,background .18s; }
      #tss-eq-reset:hover { color:#fff;border-color:rgba(255,255,255,.34);background:rgba(255,255,255,.055); }
      @media (max-width:520px) { #tss-eq-overlay { width:calc(100vw - 20px); } .tss-eq-body { padding-inline:10px; } .tss-eq-head { padding-inline:12px; } .tss-eq-preset { padding-inline:9px; } }

      #tss-stats-overlay {
        color:#eeeeee;background:var(--tss-glass-surface,#080b12) !important;
        border:1px solid var(--tss-glass-rim) !important;border-radius:16px !important;
        box-shadow:var(--tss-glass-shadow) !important;
      }
      .tss-stats-head {
        display:flex;align-items:center;justify-content:space-between;padding:14px 15px 12px;
        border-bottom:1px solid rgba(255,255,255,.07);cursor:move;
      }
      .tss-stats-kicker { color:var(--tss-a,#aebaf3);font-size:8px;font-weight:760;letter-spacing:.13em;text-transform:uppercase; }
      .tss-stats-title { margin-top:3px;color:#f1f1f1;font-size:14px;font-weight:680;letter-spacing:-.01em; }
      .tss-stats-close {
        width:32px;height:32px;border:1px solid rgba(255,255,255,.08);border-radius:8px;
        display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,.025);
        color:rgba(255,255,255,.38);cursor:pointer;transition:color .18s,border-color .18s,background .18s;
      }
      .tss-stats-close:hover { color:#fff;border-color:rgba(255,255,255,.16);background:rgba(255,255,255,.06); }
      .tss-stats-close:focus-visible { outline:2px solid var(--tss-a,#aebaf3);outline-offset:2px; }
      .tss-stats-body { padding:15px; }
      .tss-stats-metrics { display:grid;grid-template-columns:1fr 1px 1fr;align-items:end;gap:15px;padding:2px 2px 14px; }
      .tss-stats-divider { width:1px;height:42px;background:rgba(255,255,255,.08);align-self:center; }
      .tss-stats-value { color:#f3f3f3;font-size:25px;font-weight:680;letter-spacing:-.035em;line-height:1;font-variant-numeric:tabular-nums; }
      .tss-stats-label { margin-top:7px;color:rgba(255,255,255,.72);font-size:10px;font-weight:600;letter-spacing:.02em; }
      .tss-stats-lifetime { display:flex;align-items:center;justify-content:space-between;padding:11px 0;border-top:1px solid rgba(255,255,255,.065);border-bottom:1px solid rgba(255,255,255,.065); }
      .tss-stats-lifetime-label,.tss-stats-section-label { color:rgba(255,255,255,.72);font-size:10px;font-weight:600;letter-spacing:.02em; }
      #tss-stats-lifetime { color:rgba(255,255,255,.78);font-size:11px;font-variant-numeric:tabular-nums; }
      .tss-stats-section { display:flex;align-items:center;justify-content:space-between;padding:13px 0 6px; }
      .tss-stat-track { display:grid;grid-template-columns:30px minmax(0,1fr) auto auto;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid rgba(255,255,255,.05); }
      .tss-stat-priority { min-width:52px;border:1px solid rgba(255,255,255,.08);border-radius:6px;padding:4px 7px;background:rgba(255,255,255,.025);font:700 8px/1 -apple-system,'Segoe UI',system-ui,sans-serif;letter-spacing:.06em;text-transform:uppercase;cursor:pointer; }
      .tss-stat-priority:hover { background:rgba(255,255,255,.06);border-color:rgba(255,255,255,.15); }
      .tss-stat-track > span:first-child { color:rgba(255,255,255,.7) !important;font-size:10.5px !important;font-weight:560; }
      .tss-stat-track > span:nth-child(2) { color:var(--tss-a,#aebaf3) !important;font-size:10px !important;font-weight:700; }
      .tss-stats-empty { padding:18px 0;color:rgba(255,255,255,.7);font-size:11px;text-align:center; }
      .tss-stats-reset { width:100%;margin-top:15px;border:0;background:transparent;color:rgba(255,255,255,.7);padding:7px;cursor:pointer;font-size:10px;font-family:-apple-system,'Segoe UI',system-ui,sans-serif;transition:color .18s; }
      .tss-stats-reset:hover { color:rgba(255,255,255,.62); }
      .tss-stats-reset:focus-visible { outline:2px solid var(--tss-a,#aebaf3);outline-offset:2px;border-radius:6px; }
      #tss-sidebar button:focus-visible,#tss-eq-overlay button:focus-visible,#tss-stats-overlay button:focus-visible,.tss-debug-dialog button:focus-visible {
        outline:2px solid #d9dfe7;outline-offset:2px;
      }
      #tss-hub button:disabled,#tss-sidebar button:disabled,#tss-eq-overlay button:disabled { opacity:.5;cursor:not-allowed; }
      #tss-search::placeholder,#tss-eq-save-name::placeholder { color:#aeb5bf;opacity:1; }
      #tss-hub ::selection,#tss-sidebar ::selection,#tss-eq-overlay ::selection { background:rgba(174,186,243,.3);color:#fff; }
      #tss-sidebar-list { scrollbar-color:#555b64 transparent; }
      @media (max-width:360px) {
        #tss-hub-hdr { gap:6px;padding-left:10px;padding-right:10px; }
        .tss-deck-brandmark { display:none; }
        .tss-deck-label { font-size:10px; }
        .tss-eq-footer { flex-wrap:wrap; }
      }
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
    background:var(--tss-glass-surface,#080b12); border:1px solid var(--tss-glass-rim,rgba(183,199,232,.12));
    border-radius:18px; z-index:99994;
    overflow:hidden; -webkit-user-select:none; user-select:none;
    box-shadow:var(--tss-glass-shadow);
    -webkit-backdrop-filter:var(--tss-glass-filter,none);backdrop-filter:var(--tss-glass-filter,none);
    font-family:-apple-system,'Segoe UI',system-ui,sans-serif;
  `;

  const waveform = DEFAULT_WAVE_HEIGHTS.map(height => `<i style="--h:${height}%" data-played="false"></i>`).join('');

  hub.dataset.view = 'main';
  hub.dataset.mini = 'false';
  hub.dataset.settingsTab = 'audio';
  hub.innerHTML = `
    <div id="tss-hub-inner">
      <div id="tss-hub-hdr">
        <div class="tss-deck-brand"><span class="tss-deck-brandmark" aria-hidden="true">${SVG.shuffle}</span><span class="tss-deck-label">True Shuffle</span></div>
        <div class="tss-hub-navigation">
          <button id="tss-playback-debug" class="tss-hub-btn tss-hub-btn-icon" type="button" hidden aria-label="Playback issue: open report" title="Playback issue: open report"><svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M8 2.5v6.75"/><circle cx="8" cy="12.5" r="1" fill="currentColor" stroke="none"/></svg></button>
          <button id="tss-hub-pip" class="tss-hub-btn tss-hub-btn-icon" type="button" data-open="false" aria-label="Open True Shuffle picture in picture" aria-pressed="false" title="Open True Shuffle PiP">${SVG.pip}</button>
          <button id="tss-hub-col" class="tss-hub-btn tss-hub-btn-icon" type="button" aria-label="Minimize player" aria-expanded="true" title="Minimize player"><svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg></button>
          <button id="tss-hub-settings" class="tss-hub-btn tss-hub-btn-icon" type="button" aria-controls="tss-hub-settings-view" aria-expanded="false" aria-label="Settings" title="Settings"><span class="tss-settings-gear-icon">${SVG.gear}</span><span class="tss-settings-back-icon">${SVG.back}</span></button>
        </div>
      </div>
      <div id="tss-hub-body">
        <div id="tss-hub-main-view">
          <div id="tss-hub-active-view" style="display:none;">
            <div class="tss-deck-track">
              <div id="tss-hub-art">${SVG.note}</div>
              <div class="tss-deck-track-copy">
                <div id="tss-hub-title">—</div>
                <div id="tss-hub-artist">—</div>
              </div>
            </div>
            <div class="tss-deck-timeline">
              <div id="tss-hub-seekbar" role="slider" tabindex="0" aria-label="Seek track" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" title="Seek track">
                <div id="tss-wave-bars" class="tss-wave-bars" aria-hidden="true">${waveform}</div>
                <div id="tss-hub-prog" style="width:0%;"></div>
              </div>
              <div class="tss-deck-times"><span id="tss-hub-time-current">0:00</span><span id="tss-hub-time-remaining">-0:00</span></div>
            </div>
            <div class="tss-deck-controls">
              <button id="tss-hub-prev" class="tss-hub-btn tss-hub-btn-sm" type="button" aria-label="Previous track">${SVG.prev}</button>
              <button id="tss-hub-play" class="tss-hub-btn tss-hub-btn-lg" type="button" aria-label="Play or pause">${SVG.play}</button>
              <button id="tss-hub-next" class="tss-hub-btn tss-hub-btn-sm" type="button" aria-label="Next track">${SVG.next}</button>
            </div>
            <div class="tss-master-volume">
              <span aria-hidden="true">${SVG.volume}</span>
              <input id="tss-hub-volume" type="range" min="0" max="100" step="1" value="10" aria-label="True Shuffle volume">
              <span id="tss-hub-volume-value" aria-live="polite">10%</span>
            </div>
          </div>
          <div class="tss-main-queue">
            <button id="tss-hub-qico" class="tss-hub-btn tss-hub-text-button" type="button" data-open="false" aria-controls="tss-sidebar" aria-expanded="false">${SVG.list}<span>Queue</span><span id="tss-hub-qpos">—</span></button>
            <button id="tss-hub-reshuffle" class="tss-hub-btn tss-hub-text-button" type="button" data-loading="false" aria-label="Reshuffle upcoming tracks" title="Reshuffle upcoming tracks">${SVG.shuffle}<span>Reshuffle</span></button>
          </div>
          <div id="tss-hub-actions"><button id="tss-hub-start" type="button" data-active="false" data-loading="false">Start shuffle</button></div>
        </div>
        <section id="tss-hub-settings-view" aria-labelledby="tss-settings-title" hidden>
          <h2 id="tss-settings-title" tabindex="-1">Settings</h2>
          <div class="tss-settings-tabs" role="tablist" aria-label="Settings">
            <button id="tss-settings-tab-audio" class="tss-settings-tab" type="button" role="tab" aria-selected="true" aria-controls="tss-settings-panel-audio">${SVG.equalizer}<span>Audio</span></button>
            <button id="tss-settings-tab-session" class="tss-settings-tab" type="button" role="tab" aria-selected="false" aria-controls="tss-settings-panel-session" tabindex="-1">${SVG.timer}<span>Session</span></button>
            <button id="tss-settings-tab-info" class="tss-settings-tab" type="button" role="tab" aria-selected="false" aria-controls="tss-settings-panel-info" tabindex="-1">${SVG.info}<span>Info</span></button>
          </div>
          <div class="tss-settings-panels">
          <section id="tss-settings-panel-audio" class="tss-settings-panel" role="tabpanel" aria-labelledby="tss-settings-tab-audio">
            <div class="tss-crossfade-card" id="tss-crossfade-card" data-enabled="false">
              <div class="tss-crossfade-heading"><span>Crossfade</span><span id="tss-hub-crossfade-status" data-status="off" aria-live="polite">off</span></div>
              <div class="tss-crossfade-setting-head"><label for="tss-hub-crossfade">Duration</label><span id="tss-crossfade-seconds">off</span></div>
              <input id="tss-hub-crossfade" type="range" min="0" max="12" step="1" value="0" aria-label="Crossfade duration in seconds">
              <div class="tss-crossfade-ticks" aria-hidden="true"><span>off</span><span>3</span><span>6</span><span>9</span><span>12s</span></div>
              <div class="tss-crossfade-setting-head">Profile</div>
              <div class="tss-crossfade-modes" role="group" aria-label="Crossfade profile">
                <button type="button" class="tss-crossfade-mode" data-curve="smooth" title="Gentle, rounded handoff">Smooth</button>
                <button type="button" class="tss-crossfade-mode" data-curve="clean" title="Linear blend with minimal coloration">Clean</button>
                <button type="button" class="tss-crossfade-mode" data-curve="dj" title="Faster handoff around the midpoint">DJ</button>
              </div>
              <label class="tss-crossfade-manual"><span>Fade manual skips</span><input id="tss-crossfade-manual" type="checkbox"></label>
            </div>
            <button id="tss-auto-level" class="tss-settings-action" type="button" aria-label="Auto Level" aria-pressed="false" title="Automatically reduce louder tracks"><span>Auto Level</span><span class="tss-auto-label">Off</span></button>
            <button id="tss-hub-eq" class="tss-hub-btn tss-settings-action" type="button" data-active="false" aria-label="Open equalizer" aria-pressed="false" title="Open equalizer">${SVG.equalizer}<span>Open equalizer</span></button>
          </section>
          <section id="tss-settings-panel-session" class="tss-settings-panel" role="tabpanel" aria-labelledby="tss-settings-tab-session" hidden>
            <label class="tss-settings-row" for="tss-hub-sleep"><span>Sleep timer</span><select id="tss-hub-sleep"><option value="off">Off</option><option value="t15">15 min</option><option value="t30">30 min</option><option value="t60">1 hour</option><option value="n5">5 tracks</option><option value="n10">10 tracks</option><option value="n25">25 tracks</option></select></label>
            <span id="tss-hub-sleep-display" aria-live="polite"></span>
            <label class="tss-settings-row" for="tss-hub-stop-after"><span>Stop after this round</span><input id="tss-hub-stop-after" type="checkbox"></label>
            <div id="tss-settings-session-action"></div>
          </section>
          <section id="tss-settings-panel-info" class="tss-settings-panel" role="tabpanel" aria-labelledby="tss-settings-tab-info" hidden>
            <label class="tss-settings-row" for="tss-reduce-visual-effects"><span>Reduce visual effects</span><input id="tss-reduce-visual-effects" type="checkbox" aria-describedby="tss-visual-effects-help"></label>
            <p id="tss-visual-effects-help">Less blur and motion. Audio is unchanged.</p>
            <label class="tss-settings-row" for="tss-scroll-long-titles"><span>Scroll long titles</span><input id="tss-scroll-long-titles" type="checkbox" aria-describedby="tss-scroll-long-titles-help"></label>
            <p id="tss-scroll-long-titles-help">Scroll overflowing PiP titles independently of reduced visual effects. Respects your system’s reduced-motion preference.</p>
            <button id="tss-hub-stats" class="tss-hub-btn tss-settings-action" type="button" aria-label="Listening stats">${SVG.chart}<span>Listening stats</span></button>
          </section>
          </div>
        </section>
        <div id="tss-hub-queue-space" hidden></div>
      </div>
    </div>
  `;

  document.body.appendChild(hub);
  applyVisualEffects(document);
  document.getElementById('tss-reduce-visual-effects').onchange = event => setReducedVisualEffects(event.currentTarget.checked);
  document.getElementById('tss-scroll-long-titles').onchange = event => setScrollLongTitles(event.currentTarget.checked);

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
  document.getElementById('tss-hub-seekbar').onkeydown = e => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const timing = playbackTiming();
    if (!timing.duration) return;
    const target = e.key === 'Home' ? 0 : e.key === 'End' ? 1
      : (timing.current + (e.key === 'ArrowRight' ? 5 : -5)) / timing.duration;
    seekTo(Math.max(0, Math.min(1, target)));
  };

  document.getElementById('tss-hub-qico').onclick = e => { e.stopPropagation(); toggleSidebar(e); };

  const stopAfterRound = document.getElementById('tss-hub-stop-after');
  stopAfterRound.checked  = state.stopAfterRound;
  stopAfterRound.onchange = () => { state.stopAfterRound = stopAfterRound.checked; };

  document.getElementById('tss-hub-start').onclick = () => {
    if (state.active || state.loading) { stop(); return; }
    if (state.autoLevel || state.eqEnabled || state.safetyClipper || state.crossfadeSeconds > 0) ensureAutoLevelAudioGraph();
    void start();
  };

  document.getElementById('tss-hub-sleep').onchange = e => {
    setSleepTimer(e.target.value);
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
      safeStorage.setItem('tss_crossfade_curve', state.crossfadeCurve);
      syncCrossfadeControls();
    };
  });

  const crossfadeManual = document.getElementById('tss-crossfade-manual');
  crossfadeManual.onchange = () => {
    state.crossfadeManual = crossfadeManual.checked;
    safeStorage.setItem('tss_crossfade_manual', String(state.crossfadeManual));
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

  document.getElementById('tss-hub-col').onclick = event => setHubMini(hub.dataset.mini !== 'true', true, event);
  // Track activation modality, not click.detail: synthetic/forwarded pointer
  // clicks can legitimately have detail=0. Native Enter/Space stays instant.
  hub.addEventListener('pointerdown', () => { motionIsInstant.keyboardTarget = null; }, true);
  hub.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') motionIsInstant.keyboardTarget = event.target;
  }, true);
  document.getElementById('tss-hub-settings').onclick = event => setHubView(hub.dataset.view === 'settings' ? 'main' : 'settings', true, event);
  const settingsTabs = ['audio', 'session', 'info'];
  settingsTabs.forEach((tab, index) => {
    const button = document.getElementById(`tss-settings-tab-${tab}`);
    button.onclick = event => setSettingsTab(tab, false, event);
    button.onkeydown = event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? settingsTabs.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + settingsTabs.length) % settingsTabs.length;
      setSettingsTab(settingsTabs[next], true, event);
    };
  });
  document.addEventListener('keydown', e => {
    if (!hub.isConnected || e.key !== 'Escape' || e.defaultPrevented) return;
    if (document.getElementById('tss-ctx')) {
      e.preventDefault();
      e.stopPropagation();
      state._ctxMenuClose?.();
      return;
    }
    if (document.querySelector('#tss-eq-overlay,#tss-stats-overlay,#tss-debug-overlay,#tss-debug-help-overlay')) return;
    if (state.sidebarOpen && document.getElementById('tss-sidebar')?.dataset.layout === 'narrow') {
      e.preventDefault();
      e.stopPropagation();
      toggleSidebar(e);
    } else if (hub.dataset.view === 'settings') {
      e.preventDefault();
      e.stopPropagation();
      setHubView('main', true, e);
    }
  });

  const hubHdr = document.getElementById('tss-hub-hdr');
  hubHdr.onmousedown = e => {
    if (e.button !== 0 || e.target.closest('button,input,select,textarea,a,[role="button"],[contenteditable="true"]')) return;
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
    ? 'Load and reshuffle this playlist'
    : 'Reshuffle upcoming tracks';
  for (const reshuffleBtn of [
    document.getElementById('tss-hub-reshuffle'),
  ]) {
    if (!reshuffleBtn) continue;
    const loadingValue = loading ? 'true' : 'false';
    if (reshuffleBtn.dataset.loading !== loadingValue) reshuffleBtn.dataset.loading = loadingValue;
    if (reshuffleBtn.disabled !== loading) reshuffleBtn.disabled = loading;
    if (reshuffleBtn.title !== reshuffleTitle) reshuffleBtn.title = reshuffleTitle;
  }

  const av = document.getElementById('tss-hub-active-view');
  const activeDisplay = active ? '' : 'none';
  if (av && av.style.display !== activeDisplay) av.style.display = activeDisplay;

  const startBtn = document.getElementById('tss-hub-start');
  if (startBtn) {
    if (startBtn.style.display !== '') startBtn.style.display = '';
    if (startBtn.disabled) startBtn.disabled = false;
    const text = loading ? 'Cancel loading' : active ? 'End shuffle session' : 'Start shuffle';
    const activeValue = !loading && active ? 'true' : 'false';
    const loadingValue = loading ? 'true' : 'false';
    const label = text;
    if (startBtn.textContent !== text) startBtn.textContent = text;
    if (startBtn.dataset.active !== activeValue) startBtn.dataset.active = activeValue;
    if (startBtn.dataset.loading !== loadingValue) startBtn.dataset.loading = loadingValue;
    if (startBtn.getAttribute('aria-label') !== label) startBtn.setAttribute('aria-label', label);
  }

  syncHubView();

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
    const open = state.sidebarOpen ? 'true' : 'false';
    const title = state.sidebarOpen ? 'Close queue' : 'Open queue';
    if (qi.dataset.open !== open) qi.dataset.open = open;
    if (qi.title !== title) qi.title = title;
    if (qi.getAttribute('aria-expanded') !== open) qi.setAttribute('aria-expanded', open);
    if (qi.getAttribute('aria-label') !== title) qi.setAttribute('aria-label', title);
  }
  const qpos = document.getElementById('tss-hub-qpos');
  if (qpos) {
    const total = Math.max(1, state.roundTotal || state.queue.length);
    const inRound = Math.min(total, Math.max(1, state.roundPlayed + 1));
    const text = active ? `${inRound} / ${total}` : '0 / 0';
    if (qpos.textContent !== text) qpos.textContent = text;
  }
  syncSidebarToHub();

  if (!active) {
    const prog  = document.getElementById('tss-hub-prog');
    if (prog && prog.style.width !== '0%') prog.style.width = '0%';
    const seekbar = document.getElementById('tss-hub-seekbar');
    if (seekbar && seekbar.getAttribute('aria-valuenow') !== '0') seekbar.setAttribute('aria-valuenow', '0');
    const sleepDisplay = document.getElementById('tss-hub-sleep-display');
    if (sleepDisplay && !state.sleepTimer && sleepDisplay.textContent) sleepDisplay.textContent = '';
    if (state._lastWaveformKey) {
      state._lastWaveformKey = '';
      waveformRequest++;
      renderWaveform();
    }
    const currentTime = document.getElementById('tss-hub-time-current');
    const remainingTime = document.getElementById('tss-hub-time-remaining');
    if (currentTime && currentTime.textContent !== '0:00') currentTime.textContent = '0:00';
    if (remainingTime && remainingTime.textContent !== '-0:00') remainingTime.textContent = '-0:00';
    return;
  }

  refreshPlayBtn();

  if (state.suspended) {
    const tEl = document.getElementById('tss-hub-title');
    const aEl = document.getElementById('tss-hub-artist');
    const title = playerTitle() || '—';
    if (tEl && tEl.textContent !== title) tEl.textContent = title;
    if (aEl && aEl.textContent !== '↩ not in queue') aEl.textContent = '↩ not in queue';
    const art = document.getElementById('tss-hub-art');
    if (art && art.dataset.src) {
      delete art.dataset.src;
      art.innerHTML = SVG.note;
    }
    return;
  }

  const m   = state.meta[state.queue?.[state.pos]];
  const tEl = document.getElementById('tss-hub-title');
  const aEl = document.getElementById('tss-hub-artist');
  const title = playerTitle() || m?.title || '—';
  const artist = m?.artist || '—';
  if (tEl && tEl.textContent !== title) tEl.textContent = title;
  if (aEl && aEl.textContent !== artist) aEl.textContent = artist;

  const waveformKey = waveformTrackKey(m);
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
      img.alt = 'Current track artwork';
      img.src           = m.artwork;
      img.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;';
      img.onerror       = () => { art.innerHTML = SVG.note; delete art.dataset.src; };
      art.appendChild(img);
    } else if (!m?.artwork && art.dataset.src) {
      delete art.dataset.src;
      art.innerHTML = SVG.note;
    }
  }

  const timing = playbackTiming();
  updateProgressBar(timing);
  const currentTime = document.getElementById('tss-hub-time-current');
  const remainingTime = document.getElementById('tss-hub-time-remaining');
  const currentText = formatPlaybackClock(timing.current);
  const remainingText = `-${formatPlaybackClock(Math.max(0, timing.duration - timing.current))}`;
  if (currentTime && currentTime.textContent !== currentText) currentTime.textContent = currentText;
  if (remainingTime && remainingTime.textContent !== remainingText) remainingTime.textContent = remainingText;

}


function syncSidebarToHub() {
  const hub = document.getElementById('tss-hub');
  const sidebar = document.getElementById('tss-sidebar');
  if (!hub) return;
  const space = document.getElementById('tss-hub-queue-space');
  let rect = hub.getBoundingClientRect();
  const rightSpace = Math.max(0, window.innerWidth - rect.right - 12);
  const leftSpace = Math.max(0, rect.left - 12);
  const fitsRight = rightSpace >= 220 || rightSpace >= leftSpace;
  const available = fitsRight ? rightSpace : leftSpace;
  // Keep the narrow queue footprint stable until the outgoing panel is hidden.
  const closingNarrow = !state.sidebarOpen && sidebar?.dataset.motion === 'exiting'
    && sidebar.dataset.layout === 'narrow' && hub.dataset.view === 'main';
  const narrow = closingNarrow || Boolean(state.sidebarOpen && sidebar && available < 220);
  const queueView = narrow ? 'true' : 'false';
  const layoutChanged = hub.dataset.queueView !== queueView;
  if (layoutChanged) hub.dataset.queueView = queueView;
  if (space && space.hidden !== !narrow) space.hidden = !narrow;
  if (narrow && hub.dataset.view === 'settings') {
    hub.dataset.view = 'main';
    syncHubView();
  }
  if (layoutChanged) rect = hub.getBoundingClientRect();
  const leftBound = Math.max(12, Math.min(rect.left, window.innerWidth - rect.width - 12));
  const topBound = Math.max(12, Math.min(rect.top, window.innerHeight - rect.height - 12));
  if (rect.width && rect.left !== leftBound) hub.style.left = `${leftBound}px`;
  if (rect.height && rect.top !== topBound) {
    hub.style.top = `${topBound}px`;
    hub.style.bottom = 'auto';
  }
  if (rect.left !== leftBound || rect.top !== topBound) rect = hub.getBoundingClientRect();
  if (!sidebar || !state.sidebarOpen) {
    delete hub.dataset.sidebarSide;
    return;
  }

  const layout = narrow ? 'narrow' : 'docked';
  const enteringNarrow = sidebar.dataset.layout !== 'narrow' && narrow;
  if (sidebar.dataset.layout !== layout) sidebar.dataset.layout = layout;
  const requestedWidth = Math.max(260, Math.min(620, state.sidebarWidth || 320));
  const width = narrow ? rect.width : Math.min(requestedWidth, available);
  const left = narrow ? rect.left : fitsRight ? rect.right : rect.left - width;
  const requestedHeight = state.sidebarHeight > 0 ? state.sidebarHeight : Math.max(320, rect.height);
  const maxHeight = Math.max(120, rect.bottom - 12);
  const height = narrow
    ? Math.max(120, document.getElementById('tss-hub-queue-space')?.getBoundingClientRect().height || rect.height - 56)
    : Math.min(Math.max(Math.min(rect.height, maxHeight), requestedHeight), maxHeight);
  const top = rect.bottom - height;
  if (sidebar.style.width !== `${width}px`) sidebar.style.width = `${width}px`;
  if (sidebar.style.left !== `${left}px`) sidebar.style.left = `${left}px`;
  if (sidebar.style.top !== `${top}px`) sidebar.style.top = `${top}px`;
  if (sidebar.style.height !== `${height}px`) sidebar.style.height = `${height}px`;
  const side = fitsRight ? 'right' : 'left';
  if (sidebar.dataset.side !== side) sidebar.dataset.side = side;
  // A taller queue unfolds upward from its bottom edge; otherwise it unfolds
  // downward from its top. Horizontal attachment stays fixed beside the player.
  const opensUp = !narrow && top < rect.top - 0.5;
  const origin = `${narrow ? '50%' : side === 'right' ? '0px' : '100%'} ${opensUp ? '100%' : '0px'}`;
  if (sidebar.style.transformOrigin !== origin) sidebar.style.transformOrigin = origin;
  if (narrow) delete hub.dataset.sidebarSide;
  else if (hub.dataset.sidebarSide !== side) hub.dataset.sidebarSide = side;
  const close = document.getElementById('tss-sidebar-close');
  if (close) {
    const label = narrow ? 'Back to player' : 'Close queue';
    if (close.textContent !== label) close.textContent = label;
    if (close.getAttribute('aria-label') !== label) close.setAttribute('aria-label', label);
    if (enteringNarrow) close.focus({ preventScroll: true });
  }
}

function setupSidebarResize() {
  const sidebar = document.getElementById('tss-sidebar');
  const handle = document.getElementById('tss-sidebar-resize');
  const heightHandle = document.getElementById('tss-sidebar-height-resize');
  if (!sidebar || !handle || !heightHandle) return;

  try {
    const saved = Number(safeStorage.getItem('tss_sidebar_width'));
    if (Number.isFinite(saved) && saved >= 120 && saved <= 620) state.sidebarWidth = saved;
    const savedHeight = Number(safeStorage.getItem('tss_sidebar_height'));
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
      try { safeStorage.setItem('tss_sidebar_width', String(Math.round(state.sidebarWidth))); } catch (_) {}
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
    try { safeStorage.setItem('tss_sidebar_width', '320'); } catch (_) {}
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
      try { safeStorage.setItem('tss_sidebar_height', String(Math.round(state.sidebarHeight))); } catch (_) {}
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
    try { safeStorage.removeItem('tss_sidebar_height'); } catch (_) {}
    syncSidebarToHub();
  };
}

function mkSidebar() {
  if (document.getElementById('tss-sidebar')) return;

  const sidebar = document.createElement('div');
  sidebar.id = 'tss-sidebar';
  sidebar.dataset.open = 'false';
  sidebar.dataset.side = 'right';
  sidebar.hidden = true;
  sidebar.inert = true;
  sidebar.setAttribute('aria-hidden', 'true');
  sidebar.setAttribute('role', 'region');
  sidebar.setAttribute('aria-label', 'Queue and listening history');
  sidebar.style.cssText = `
    position:fixed; left:-9999px; top:12px;
    width:min(320px,calc(100vw - 24px)); height:380px;
    background:var(--tss-glass-surface,#080b12); border:1px solid var(--tss-glass-rim,rgba(183,199,232,.12));
    border-radius:0 16px 16px 0; overflow:hidden;
    display:flex; flex-direction:column;
    font-family:-apple-system,'Segoe UI',system-ui,sans-serif;
    box-shadow:var(--tss-glass-shadow);
    -webkit-backdrop-filter:var(--tss-glass-filter,none);backdrop-filter:var(--tss-glass-filter,none);
  `;

  sidebar.innerHTML = `
    <button id="tss-sidebar-resize" class="tss-sidebar-resize" aria-label="Resize queue panel" title="Drag to resize · double-click to reset"></button>
    <button id="tss-sidebar-height-resize" class="tss-sidebar-height-resize" aria-label="Resize queue height" title="Drag upward for more tracks · double-click to reset"></button>
    <div id="tss-sidebar-content">
    <div class="tss-side-head">
      <div class="tss-side-titlebar">
        <span class="tss-side-title">Queue</span>
        <span style="flex:1;"></span>
        <button id="tss-merge-btn" class="tss-side-action" type="button" title="Add current page to queue">${SVG.plus}<span>Merge playlist</span></button>
        <button id="tss-sidebar-close" class="tss-side-action" type="button" aria-label="Close queue">Close queue</button>
      </div>
      <div class="tss-side-tabs" role="tablist" aria-label="Queue and history">
        <button id="tss-tab-queue" class="tss-side-tab" type="button" role="tab" data-active="true" aria-selected="true" aria-controls="tss-sidebar-list">Queue</button>
        <button id="tss-tab-history" class="tss-side-tab" type="button" role="tab" data-active="false" aria-selected="false" aria-controls="tss-sidebar-list" tabindex="-1">History</button>
        <span style="flex:1;"></span>
        <span id="tss-sidebar-count" style="color:rgba(255,255,255,.32);font-size:10px;font-variant-numeric:tabular-nums;padding-bottom:9px;"></span>
      </div>
      <div class="tss-side-searchwrap">
        <span class="tss-side-searchicon">${SVG.search}</span>
        <input id="tss-search" type="search" aria-label="Search queue and history" placeholder="Search tracks" style="padding-left:33px !important;" />
      </div>
    </div>
    <div id="tss-sidebar-list" role="tabpanel" aria-labelledby="tss-tab-queue" style="overflow-y:auto;padding:6px 0;scrollbar-width:thin;"></div>
    </div>
  `;

  document.body.appendChild(sidebar);
  sidebar.addEventListener('pointerdown', () => { motionIsInstant.keyboardTarget = null; }, true);
  sidebar.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') motionIsInstant.keyboardTarget = event.target;
  }, true);
  setupSidebarResize();
  document.getElementById('tss-sidebar-close').onclick = event => {
    if (state.sidebarOpen) toggleSidebar(event);
  };
  sidebar.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || e.defaultPrevented || document.getElementById('tss-ctx')) return;
    e.preventDefault();
    e.stopPropagation();
    if (state.sidebarOpen) toggleSidebar(e);
  });

  document.getElementById('tss-merge-btn').onclick  = () => mergeCurrentPage();
  document.getElementById('tss-search').oninput     = e => renderList(e.target.value);
  document.getElementById('tss-search').onclick     = e => e.stopPropagation();

  ['queue', 'history'].forEach(tab => {
    const button = document.getElementById(`tss-tab-${tab}`);
    button.onclick = event => setSidebarTab(tab, event);
    button.onkeydown = event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 'queue' : event.key === 'End' ? 'history'
        : tab === 'queue' ? 'history' : 'queue';
      setSidebarTab(next, event);
      document.getElementById(`tss-tab-${next}`)?.focus({ preventScroll: true });
    };
  });
  window.addEventListener('resize', syncSidebarToHub);
}

function setSidebarTab(tab, event = null) {
  if (!['queue', 'history'].includes(tab) || state.sidebarTab === tab) return;
  state.sidebarTab = tab;
  updateTabStyles();
  const list = document.getElementById('tss-sidebar-list');
  if (!list) return;
  if (list.contains?.(document.activeElement)) document.getElementById(`tss-tab-${tab}`)?.focus({ preventScroll: true });
  const instant = motionIsInstant(event) || !state.sidebarOpen;
  // Fade the mounted rows out before rendering the latest requested tab.
  list._tssTabSwap = true;
  animateSurface(list, false, {
    instant, duration: 75, restart: true,
    onFinish: () => {
      list._tssTabSwap = false;
      renderList(document.getElementById('tss-search')?.value || '');
      animateSurface(list, true, { instant, duration: 95 });
    },
  });
}

function updateTabStyles() {
  for (const tab of ['queue', 'history']) {
    const button = document.getElementById(`tss-tab-${tab}`);
    if (!button) continue;
    const active = state.sidebarTab === tab;
    button.dataset.active = String(active);
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
  }
  document.getElementById('tss-sidebar-list')?.setAttribute('aria-labelledby', `tss-tab-${state.sidebarTab}`);
}

function toggleSidebar(event = null) {
  const instant = motionIsInstant(event);
  state.sidebarOpen = !state.sidebarOpen;
  const sidebar = document.getElementById('tss-sidebar');
  const hub = document.getElementById('tss-hub');
  const closedInNarrow = !state.sidebarOpen && sidebar?.dataset.layout === 'narrow';
  if (sidebar) {
    sidebar.dataset.open = String(state.sidebarOpen);
    if (state.sidebarOpen) {
      setHubView('main', false, { instant });
      if (state._sidebarDirty || !sidebar.dataset.rendered) {
        renderList();
        sidebar.dataset.rendered = 'true';
      }
    }
    // Layout must know the destination side/anchor before the first painted
    // entry frame. Closure keeps the existing footprint until finish.
    if (state.sidebarOpen) syncSidebarToHub();
    animateSurface(sidebar, state.sidebarOpen, {
      instant, kind: 'queue',
      onFinish: () => {
        syncSidebarToHub();
        if (!state.sidebarOpen && closedInNarrow && hub?.dataset.view === 'main'
          && document.activeElement === document.getElementById('tss-hub-settings')) {
          document.getElementById('tss-hub-qico')?.focus({ preventScroll: true });
        }
      },
    });
  }
  updateHub();
  syncSidebarToHub();
  if (state.sidebarOpen) {
    document.getElementById('tss-sidebar-close')?.focus({ preventScroll: true });
  } else {
    const settings = hub?.dataset.view === 'settings';
    const exitingNarrow = closedInNarrow && sidebar?.dataset.motion === 'exiting';
    document.getElementById(settings || exitingNarrow ? 'tss-hub-settings' : 'tss-hub-qico')?.focus({ preventScroll: true });
  }
}


function bindQueueRowActions(row, qi, ti, cur, past, filter) {
  row.draggable = true;
  row.ondragstart = e => {
    state.dragSrc = qi;
    e.dataTransfer.effectAllowed = 'move';
    row.style.opacity = '0.35';
  };
  row.ondragend = () => { row.style.opacity = past ? '0.3' : '1'; };
  row.ondragover = e => { e.preventDefault(); row.style.background = 'rgba(var(--tss-ar,174),var(--tss-ag,186),var(--tss-ab,243),0.07)'; };
  row.ondragleave = () => { row.style.background = cur ? 'rgba(var(--tss-ar,174),var(--tss-ag,186),var(--tss-ab,243),0.07)' : 'transparent'; };
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
    refreshUpcomingCrossfadePreparation();
    badges();
    renderList(filter);
  };
  row.onclick = () => jumpTo(qi, ti);
  row.oncontextmenu = e => showCtxMenu(e, qi, ti);
}

function bindPlayNextRowAction(row, index) {
  row.oncontextmenu = e => {
    e.preventDefault();
    state.playNext.splice(index, 1);
    refreshUpcomingCrossfadePreparation();
    renderList();
  };
}

function renderList(filter) {
  if (!state.sidebarOpen || document.getElementById('tss-sidebar-list')?._tssTabSwap) {
    state._sidebarDirty = true;
    return;
  }
  state._sidebarDirty = false;
  if (filter === undefined) filter = document.getElementById('tss-search')?.value || '';

  if (state.sidebarTab === 'history') {
    renderHistory(filter);
    return;
  }

  const list  = document.getElementById('tss-sidebar-list');
  const count = document.getElementById('tss-sidebar-count');
  if (!list) return;
  const q = filter.toLowerCase();
  const preserveScroll = list.dataset.view === 'queue' && list.dataset.filter === q;
  const scrollTop = list.scrollTop;
  list.dataset.view = 'queue';
  list.dataset.filter = q;

  const children = [];
  // Only currently mounted queue rows are candidates; no detached row cache.
  const previousRows = new Map();
  for (const row of list.children) {
    if (Number.isInteger(row._tssQueueTi) && !previousRows.has(row._tssQueueTi)) {
      previousRows.set(row._tssQueueTi, row);
    }
  }

  if (!state.active || !state.queue.length) {
    list.innerHTML = `<div style="color:#b1b8c2;font-size:12px;padding:28px 18px;text-align:center;line-height:1.7;">start shuffle<br>to see the queue</div>`;
    if (count) count.textContent = '';
    return;
  }

  if (count) {
    const total = Math.max(1, state.roundTotal || state.queue.length);
    const current = Math.min(total, Math.max(1, state.roundPlayed + 1));
    count.textContent = `${current} / ${total}`;
  }

  if (state.suspended && !q) {
    const banner = document.createElement('div');
    banner.style.cssText = 'padding:6px 14px;font-size:10px;color:var(--tss-a,#aebaf3);background:rgba(var(--tss-ar,174),var(--tss-ag,186),var(--tss-ab,243),0.06);border-bottom:1px solid rgba(255,255,255,.06);';
    banner.textContent = '↩ external track playing — queue will resume after';
    children.push(banner);
  }

  if (state.playNext.length && !q) {
    const header = document.createElement('div');
    header.style.cssText = 'padding:7px 14px 3px;font-size:10px;color:#b1b8c2;text-transform:uppercase;letter-spacing:0.07em;';
    header.textContent = `play next (${state.playNext.length})`;
    children.push(header);

    state.playNext.forEach((ti, i) => {
      const m   = state.meta[ti] || { title: '—', artist: '—', artwork: null };
      const row = mkRow(m, -1, ti, false, false);
      row.style.opacity    = '0.65';
      row.style.borderLeft = '2px solid #2e2e2e';
      bindPlayNextRowAction(row, i);
      children.push(row);
    });

    const divider = document.createElement('div');
    divider.style.cssText = 'height:1px;background:rgba(255,255,255,.06);margin:4px 0;';
    children.push(divider);
  }

  state.queue.forEach((ti, qi) => {
    const m = state.meta[ti] || { title: '—', artist: '—', artwork: null };
    if (q && !m.title.toLowerCase().includes(q) && !m.artist.toLowerCase().includes(q)) return;

    const cur  = qi === state.pos;
    const past = qi <  state.pos;
    // mkRow captures only current/past display state in its hover handlers.
    // Queue-index/filter-dependent handlers below are rebound on every pass.
    const previous = previousRows.get(ti);
    const flags = (cur ? 1 : 0) | (past ? 2 : 0);
    const text = previous?.children[2];
    const image = previous?.children[1]?.querySelector('img');
    const number = previous?.lastElementChild;
    const numberMatches = cur
      ? number?.childNodes.length === 1
        && number.firstElementChild?.querySelector('path')?.getAttribute('d') === 'M3 2.5v11l10-5.5z'
      : number?.textContent === String(state.stats.played + (qi - state.pos));
    const reusable = previous && previous._tssQueueFlags === flags
      && previous.children.length === 5
      && text?.children[0]?.textContent === String(m.title ?? '')
      && text?.children[1]?.textContent === String(m.artist ?? '')
      && (image?.getAttribute('src') || '') === (m.artwork || '')
      && previous.children[3]?.textContent === (cur ? 'playing' : '')
      && previous.style.opacity === (past ? '0.3' : '1')
      && numberMatches;
    const row = reusable ? previous : mkRow(m, qi, ti, cur, past);
    previousRows.delete(ti);
    row._tssQueueTi = ti;
    row._tssQueueFlags = flags;

    bindQueueRowActions(row, qi, ti, cur, past, filter);
    children.push(row);
  });
  // Remove retired rows, retain surviving rows in place, and batch contiguous
  // insertions/moves. Consuming the queue head need not detach every later row.
  const wanted = new Set(children);
  for (const row of Array.from(list.childNodes)) {
    if (!wanted.has(row)) row.remove();
  }
  let cursor = list.firstChild;
  const fragment = document.createDocumentFragment();
  for (const row of children) {
    if (row === cursor) {
      if (fragment.childNodes.length) list.insertBefore(fragment, cursor);
      cursor = cursor.nextSibling;
    } else {
      fragment.appendChild(row);
    }
  }
  if (fragment.childNodes.length) list.insertBefore(fragment, cursor);

  // Background refreshes must not pull the reader back to the playing track.
  list.scrollTop = preserveScroll ? scrollTop : 0;
  if (!preserveScroll && !q) {
    let offset = state.playNext.length ? state.playNext.length + 2 : 0;
    if (state.suspended) offset++;
    list.children[state.pos + offset]?.scrollIntoView({ block: 'nearest', behavior: motionIsInstant() ? 'instant' : 'smooth' });
  }

  refreshPlayBtn();
}

function renderHistory(filter = '') {
  const list  = document.getElementById('tss-sidebar-list');
  const count = document.getElementById('tss-sidebar-count');
  if (!list) return;
  list.dataset.view = 'history';

  const fragment = document.createDocumentFragment();
  if (count) count.textContent = state.history.length ? `${state.history.length}` : '';

  if (!state.history.length) {
    list.innerHTML = `<div style="color:#b1b8c2;font-size:12px;padding:28px 18px;text-align:center;line-height:1.7;">no history yet</div>`;
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
    artEl.style.cssText = 'width:42px;height:42px;border-radius:8px;flex-shrink:0;background:rgba(255,255,255,.045);overflow:hidden;display:flex;align-items:center;justify-content:center;color:rgba(255,255,255,.3);';
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
    num.style.cssText = 'font-size:10px;color:#aeb5bf;font-weight:600;min-width:20px;text-align:center;flex-shrink:0;';
    num.textContent   = String(state.history.length - i);

    const txt = document.createElement('div');
    txt.style.cssText = 'overflow:hidden;flex:1;';
    txt.innerHTML = `
      <div style="font-size:12px;color:#b8b8b8;font-weight:400;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.4;">${esc(m.title)}</div>
      <div style="font-size:11px;color:#b1b8c2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px;">${esc(m.artist)}</div>
    `;

    row.append(artEl, num, txt);
    fragment.appendChild(row);
  });

  if (!shown) {
    list.innerHTML = `<div style="color:#b1b8c2;font-size:12px;padding:28px 18px;text-align:center;">no results</div>`;
  } else {
    list.replaceChildren(fragment);
  }
}

function mkRow(m, qi, ti, cur, past) {
  const row = document.createElement('div');
  row.className = 'tss-queue-row';
  row.style.cssText = `
      display:flex; align-items:center; gap:9px; padding:7px 12px;
    cursor:pointer;
    background:${cur ? 'rgba(var(--tss-ar,174),var(--tss-ag,186),var(--tss-ab,243),0.09)' : 'transparent'};
    border-left:2px solid ${cur ? 'var(--tss-a,#aebaf3)' : 'transparent'};
    transition:background 0.12s;
    opacity:${past ? '0.3' : '1'};
    -webkit-user-select:none; user-select:none;
  `;
  row.onmouseenter = () => { if (!cur) row.style.background = 'rgba(255,255,255,0.025)'; };
  row.onmouseleave = () => { if (!cur) row.style.background = 'transparent'; };

  const art = document.createElement('div');
  art.style.cssText = 'width:42px;height:42px;border-radius:8px;flex-shrink:0;background:rgba(255,255,255,.045);overflow:hidden;display:flex;align-items:center;justify-content:center;color:rgba(255,255,255,.3);box-shadow:0 5px 14px rgba(0,0,0,.28);';
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
  num.style.cssText = `font-size:10px;color:${cur ? 'var(--tss-a,#aebaf3)' : '#aeb5bf'};font-weight:${cur ? '700' : '600'};min-width:20px;text-align:center;flex-shrink:0;display:flex;align-items:center;justify-content:center;`;
  const displayNum  = qi >= 0 ? state.stats.played + (qi - state.pos) : '↑';
  if (cur) num.innerHTML = SVG.play;
  else num.textContent = String(displayNum);

  const txt = document.createElement('div');
  txt.style.cssText = 'overflow:hidden;flex:1;';
  txt.innerHTML = `
    <div style="font-size:12px;color:${cur ? '#f4f4f4' : '#c8c8c8'};font-weight:${cur ? '680' : '520'};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.35;">${esc(m.title)}</div>
    <div style="font-size:11px;color:rgba(255,255,255,.72);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:3px;">${esc(m.artist)}</div>
  `;

  const handle = document.createElement('span');
  handle.className = 'tss-queue-handle';
  handle.textContent = '::';

  const status = document.createElement('span');
  status.className = 'tss-queue-status';
  status.textContent = cur ? 'playing' : qi < 0 ? 'next' : '';
  status.style.cssText = cur
    ? 'color:var(--tss-a,#aebaf3);background:rgba(var(--tss-ar,174),var(--tss-ag,186),var(--tss-ab,243),.12);'
    : qi < 0
      ? 'color:var(--tss-a,#aebaf3);background:rgba(var(--tss-ar,174),var(--tss-ag,186),var(--tss-ab,243),.1);'
      : 'display:none;';

  row.append(handle, art, txt, status, num);
  return row;
}


function showCtxMenu(e, qi, ti) {
  e.preventDefault();
  e.stopPropagation();
  state._ctxMenuClose?.();

  const m    = state.meta[ti] || {};
  const menu = document.createElement('div');
  menu.id = 'tss-ctx';
  menu.style.cssText = `
    left:${Math.min(e.clientX, window.innerWidth - 180)}px;
    top:${Math.min(e.clientY, window.innerHeight - 180)}px;
  `;

  const epoch = state._playbackEpoch;
  const targetIndex = () => state._playbackEpoch === epoch ? state.queue.indexOf(ti) : -1;
  let registration = null;
  const close = () => {
    clearTimeout(registration);
    document.removeEventListener('click', close);
    menu.remove();
    if (state._ctxMenuClose === close) state._ctxMenuClose = null;
  };
  state._ctxMenuClose = close;

  const items = [
    { label: '⏭ play next',  action: () => { if (state._playbackEpoch === epoch) queueNext(ti); } },
    {
      label:    '↑ move up',
      disabled: qi <= state.pos + 1,
      action:   () => {
        const index = targetIndex();
        if (index <= state.pos + 1) return;
        [state.queue[index], state.queue[index - 1]] = [state.queue[index - 1], state.queue[index]];
        refreshUpcomingCrossfadePreparation();
        badges(); renderList();
      },
    },
    {
      label:    '↓ move down',
      disabled: qi <= state.pos || qi >= state.queue.length - 1,
      action:   () => {
        const index = targetIndex();
        if (index <= state.pos || index >= state.queue.length - 1) return;
        [state.queue[index], state.queue[index + 1]] = [state.queue[index + 1], state.queue[index]];
        refreshUpcomingCrossfadePreparation();
        badges(); renderList();
      },
    },
    { label: '🔗 copy link', action: () => { if (m.link) navigator.clipboard.writeText(m.link).catch(() => {}); } },
    { label: '✕ remove', disabled: qi === state.pos, action: () => {
      const index = targetIndex();
      if (index !== -1 && index !== state.pos) removeFromQueue(index);
    } },
  ];

  items.forEach(({ label, action, disabled }) => {
    const item = document.createElement('div');
    item.className = `tss-ctx-item${disabled ? ' tss-ctx-disabled' : ''}`;
    item.textContent = label;
    if (!disabled) {
      item.onclick = () => { close(); action(); };
    }
    menu.appendChild(item);
  });

  document.body.appendChild(menu);
  registration = setTimeout(() => document.addEventListener('click', close), 0);
}


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

  if (parts.length >= 3 && parts[1] === 'sets' && Boolean(parts[2])) return true;
  return parts.length === 2 && ['likes', 'tracks', 'reposts'].includes(parts[1]);
}

function isPassiveBrowsePage(url) {
  return isSoundCloudPage(url) && !isCollectionPage(url);
}

let navLock = false;
async function onNav() {
  state._routeEpoch = (state._routeEpoch || 0) + 1;
  const routeEpoch = state._routeEpoch;
  const epoch = state._playbackEpoch;
  const pageUrl = playlistBase(location.href);
  cancelCollectionRequest();
  navLock = true;
  const current = () => state._routeEpoch === routeEpoch && state._playbackEpoch === epoch
    && playlistBase(location.href) === pageUrl;
  const wasActive = state.active;
  const registered = state._liveSyncSources.has(pageUrl) || pageUrl === playlistBase(state.playlistUrl || '');
  if (wasActive) {
    state.suspended = !validPage() || (!registered && !isPassiveBrowsePage(location.href));
    if (state.suspended && Number.isInteger(state._nativeTrack)) {
      state._nativeTrack = null;
      pauseSoundCloudTransport();
      pauseSoundCloud();
    }
    updateHub();
  }
  try {
    await wait(1500);
    if (!current()) return;
    if (!validPage()) return;
    inject();
    if (wasActive) {
      if (!state.active) return;
      if (registered) {
        if (state._collectionRequest) return;
        const request = beginCollectionRequest(pageUrl, false, false);
        try {
          const freshEls = await loadTracks(request);
          if (!current() || !state.active || !collectionRequestCurrent(request)) return;
          if (freshEls.length) bindCurrentPageElements(freshEls);
        } finally {
          finishCollectionRequest(request);
        }
      }
      if (current() && state.active && !state.suspended) void syncLiveQueue({ force: true });
      return;
    }
    try {
      const raw = sessionStorage.getItem('tss_queue_cache');
      const cache = raw ? JSON.parse(raw) : null;
      if (cache && Date.now() - (cache.ts || 0) < 30 * 60 * 1000
          && playlistBase(cache.playlistUrl || '') === pageUrl && !state.active && !state.loading) await start();
    } catch (_) {}
  } catch (_) {
    // A route or playback-session change cancels the obsolete DOM crawl.
  } finally {
    if (state._routeEpoch === routeEpoch) navLock = false;
  }
}

let lastUrl = location.href;
let injectRetryTimer = null;
function checkForNavigation() {
  if (location.href === lastUrl) return false;
  lastUrl = location.href;
  if (injectRetryTimer) {
    clearTimeout(injectRetryTimer);
    injectRetryTimer = null;
  }
  void onNav();
  return true;
}

function installNavigationTracking() {
  const history = pageWindow.history;
  for (const method of ['pushState', 'replaceState']) {
    try {
      const original = history[method];
      if (typeof original !== 'function') continue;
      history[method] = function (...args) {
        const result = Reflect.apply(original, this, args);
        checkForNavigation();
        return result;
      };
    } catch (_) {}
  }
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
  for (const record of records) {
    for (const node of record.addedNodes) {
      if (node?.nodeType === 1 && (node.matches?.(selector) || node.querySelector?.(selector))) return true;
    }
    for (const node of record.removedNodes) {
      if (node?.nodeType === 1 && (node.matches?.(selector) || node.querySelector?.(selector))) return true;
    }
  }
  return false;
}

function mutationsAreTrueShuffleOnly(records) {
  return records.length > 0 && records.every(record =>
    record.target?.closest?.('#tss-hub, #tss-sidebar, #tss-stats-overlay, #tss-eq-overlay'));
}

function scheduleLiveQueueSyncFromMutation(records) {
  if (!state._liveSyncSources.has(playlistBase(location.href))
      || !mutationChangesPlaylistTracks(records)) return false;
  scheduleLiveQueueSync();
  return true;
}

function initializePage() {
  document.documentElement.style.setProperty('--tss-a', '#aebaf3');
  document.documentElement.style.setProperty('--tss-ar', '174');
  document.documentElement.style.setProperty('--tss-ag', '186');
  document.documentElement.style.setProperty('--tss-ab', '243');

  new MutationObserver(records => {
    if (mutationsAreTrueShuffleOnly(records)) return;
    if (checkForNavigation()) return;
    if (!navLock && validPage() && !document.getElementById('tss-hub') && !injectRetryTimer) {
      injectRetryTimer = setTimeout(() => {
        injectRetryTimer = null;
        inject();
      }, 250);
    }
    scheduleLiveQueueSyncFromMutation(records);
  }).observe(document, { subtree: true, childList: true });

  // SoundCloud can change routes without a DOM mutation.
  installNavigationTracking();
  setInterval(checkForNavigation, 250);
  window.addEventListener('popstate', checkForNavigation);
  onNav();
}

window.addEventListener('pagehide', () => {
  tickPlayTime();
  saveLifetimeStats();
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
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializePage, { once: true });
} else {
  initializePage();
}

})();
