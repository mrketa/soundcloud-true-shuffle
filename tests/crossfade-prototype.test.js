'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const scriptPath = process.env.TSS_SCRIPT
  ? path.resolve(process.env.TSS_SCRIPT)
  : process.argv[2]
    ? path.resolve(process.argv[2])
  : path.resolve(__dirname, '..', 'SC Trueshuffle.js');
const source = fs.readFileSync(scriptPath, 'utf8');

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `function ${name} must exist`);
  const brace = source.indexOf(') {', start) + 2;
  let depth = 0;
  for (let i = brace; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`could not extract function ${name}`);
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('custom EQ presets use Tampermonkey storage with local migration fallback', () => {
  const sanitizeSource = extractFunction('sanitizeCustomEqPresets');
  const localSource = extractFunction('localCustomEqPresets');
  const loadSource = extractFunction('loadCustomEqPresets');

  const evaluateLoad = ({ localValue, gmValue }) => {
    const writes = [];
    const localStorage = { getItem: () => localValue };
    const GM_getValue = () => gmValue;
    const GM_setValue = (key, value) => writes.push([key, value]);
    const presets = Function(
      'safeStorage', 'GM_getValue', 'GM_setValue', 'CUSTOM_EQ_PRESETS_KEY', 'BLOCKED_EQ_PRESET_NAMES',
      `${sanitizeSource}; ${localSource}; ${loadSource}; return loadCustomEqPresets();`,
    )(localStorage, GM_getValue, GM_setValue, 'vault', new Set(['__proto__', 'prototype', 'constructor']));
    return { presets, writes };
  };

  const migrated = evaluateLoad({ localValue: JSON.stringify({ Legacy: [1, 2, 3, 4, 5] }), gmValue: null });
  assert.deepEqual(migrated.presets, { Legacy: [1, 2, 3, 4, 5] });
  assert.deepEqual(migrated.writes, [['vault', { Legacy: [1, 2, 3, 4, 5] }]]);

  const authoritative = evaluateLoad({
    localValue: JSON.stringify({ DeletedPreset: [1, 1, 1, 1, 1] }),
    gmValue: { Saved: [20, -20, 2, 3, 4] },
  });
  assert.deepEqual(authoritative.presets, { Saved: [12, -12, 2, 3, 4] });
  assert.deepEqual(authoritative.writes, []);

  const deletedAll = evaluateLoad({
    localValue: JSON.stringify({ Stale: [1, 1, 1, 1, 1] }),
    gmValue: {},
  });
  assert.deepEqual(deletedAll.presets, {});

  const unsafe = evaluateLoad({
    localValue: '{}',
    gmValue: Object.fromEntries([['__proto__', [1, 2, 3, 4, 5]], ['Safe', [0, 0, 0, 0, 0]]]),
  });
  assert.deepEqual(unsafe.presets, { Safe: [0, 0, 0, 0, 0] });
});

test('Auto Level targets stable per-track loudness with a unity bypass at 100%', () => {
  const gainSource = extractFunction('calculateAutoLevelGain');
  const calculate = Function(`return (${gainSource})`)();
  assert.equal(calculate(0.08, 0.5, 1), 1);
  assert.equal(calculate(0.5, 0.95, 1), 1);

  const quietGain = calculate(0.1, 0.45, 0.4);
  const loudGain = calculate(0.45, 0.95, 0.4);
  assert.ok(quietGain > 1, `expected a modest quiet-track boost, got ${quietGain}`);
  assert.ok(quietGain <= 1.25, `quiet-track boost must stay bounded, got ${quietGain}`);
  assert.ok(loudGain < 1, `expected loud-track attenuation, got ${loudGain}`);

});

test('Auto Level caps boost using master headroom and measured peak', () => {
  const gainSource = extractFunction('calculateAutoLevelGain');
  const calculate = Function(`return (${gainSource})`)();
  const master = 0.4;
  const gain = calculate(0.02, 0.9, master);
  assert.ok(gain <= 1 / master);
  assert.ok(master * 0.9 * gain <= 1 + 1e-12);
  assert.equal(calculate(0, 0, master), 1);
  assert.ok(calculate(0.02, 0.2, 0.1) <= 1.25, 'low Chrome RMS must not create an extreme boost');
});

test('Auto Off and flat EQ route each deck through a browser-neutral unity path', () => {
  const routing = extractFunction('syncDeckProcessingRouting');

  const node = () => ({
    connections: [],
    connect(target) { this.connections.push(target); },
    disconnect() { this.connections = []; },
  });
  const sourceNode = node();
  const analyserNode = node();
  const autoGainNode = { ...node(), gain: {} };
  const mixGainNode = node();
  const state = {
    eqEnabled: false,
    autoLevel: false,
    _audioContext: { currentTime: 4 },
    _deckAudioGraphs: [{
      source: sourceNode,
      eqFilters: [node(), node(), node(), node(), node()],
      analyser: analyserNode,
      autoGain: autoGainNode,
      mixGain: mixGainNode,
      currentGain: 0.7,
    }],
  };
  const immediateWrites = [];
  const runRouting = Function(
    'state', 'setAudioParamImmediately',
    `${routing}; return syncDeckProcessingRouting;`,
  )(state, (param, value, now) => immediateWrites.push({ param, value, now }));

  runRouting();
  assert.deepEqual(sourceNode.connections, [mixGainNode]);
  assert.equal(immediateWrites.at(-1).value, 1);

  state.autoLevel = true;
  runRouting();
  assert.deepEqual(sourceNode.connections, [analyserNode]);
  assert.deepEqual(analyserNode.connections, [autoGainNode]);
  assert.deepEqual(autoGainNode.connections, [mixGainNode]);
  assert.equal(immediateWrites.at(-1).value, 0.7);
});

test('waveform progress updates only bars that crossed the playhead', () => {
  const update = extractFunction('updateProgressBar');
  assert.match(update, /state\._lastWaveformPlayed/);
  assert.match(update, /for \(let index = previous; index < played; index\+\+\)/);
  assert.match(update, /for \(let index = played; index < previous; index\+\+\)/);
  assert.doesNotMatch(update, /bars\.forEach/);
});

test('crossfade control state updates its slider, labels and selected profile together', () => {
  const syncSource = extractFunction('syncCrossfadeControls');
  const values = {};
  const elements = {
    'tss-crossfade-card': { dataset: {} },
    'tss-hub-crossfade': { value: '0', style: { setProperty: (key, value) => { values[key] = value; } } },
    'tss-crossfade-summary-seconds': { textContent: '' },
    'tss-crossfade-seconds': { textContent: '' },
    'tss-crossfade-manual': { checked: false },
  };
  const buttons = ['smooth', 'clean', 'dj'].map(curve => ({
    dataset: { curve },
    attributes: {},
    setAttribute(key, value) { this.attributes[key] = value; },
  }));
  const state = { crossfadeSeconds: 7, crossfadeCurve: 'clean', crossfadeManual: true };
  const document = {
    getElementById: id => elements[id] || null,
    querySelectorAll: selector => selector === '.tss-crossfade-mode' ? buttons : [],
  };
  Function('state', 'document', `${syncSource}; syncCrossfadeControls();`)(state, document);
  assert.equal(elements['tss-crossfade-card'].dataset.enabled, 'true');
  assert.equal(elements['tss-hub-crossfade'].value, '7');
  assert.equal(elements['tss-crossfade-summary-seconds'].textContent, '7 sec');
  assert.equal(elements['tss-crossfade-seconds'].textContent, '7 sec');
  assert.equal(values['--tss-crossfade-fill'], `${(7 / 12) * 100}%`);
  assert.equal(buttons.find(button => button.dataset.curve === 'clean').dataset.active, 'true');
  assert.equal(elements['tss-crossfade-manual'].checked, true);
});

test('master volume is continuous, persistent and synchronized outside crossfade settings', () => {
  const syncSource = extractFunction('syncPlaybackVolumeControls');
  const fills = {};
  const elements = {
    'tss-hub-volume': { value: '0', style: { setProperty: (key, value) => { fills[key] = value; } } },
    'tss-hub-volume-value': { textContent: '' },
  };
  const state = { playbackVolume: 0.137 };
  const document = { getElementById: id => elements[id] || null };
  Function('state', 'document', `${syncSource}; syncPlaybackVolumeControls();`)(state, document);
  assert.equal(elements['tss-hub-volume'].value, '14');
  assert.equal(elements['tss-hub-volume-value'].textContent, '14%');
  assert.equal(fills['--tss-volume-fill'], '14%');
});

test('delayed deck preparation cannot overwrite a newer request for the same deck', async () => {
  const standby = {
    src: '', currentSrc: '', readyState: 0, volume: 0,
    pauseCalls: 0, loadCalls: 0,
    pause() { this.pauseCalls++; },
    removeAttribute(name) { if (name === 'src') { this.src = ''; this.currentSrc = ''; } },
    load() { this.loadCalls++; this.currentSrc = this.src; this.readyState = 1; },
  };
  const state = {
    active: true,
    _playbackEpoch: 0,
    _playbackAbort: new AbortController(),
    autoLevel: false,
    eqEnabled: false,
    crossfadeSeconds: 6,
    meta: [{ id: 'old' }, { id: 'new' }],
    _decks: [{}, standby],
    _deckTracks: [null, null],
    _deckPrepareTokens: [0, 0],
    _deckGains: [0, 0],
    _deckAudioGraphs: [null, null],
  };
  const deferred = new Map();
  const prepareCrossfadeDeck = Function(
    'state', 'ensureCrossfadeDecks', 'ensureAutoLevelAudioGraph',
    'resolveCrossfadeStreams', 'resetDeck', 'applyCachedAutoLevel', 'syncCrossfadeVolume',
    'waitForDeck', 'normalizeTrackUrl', 'deckIsPreviewLimited',
    `return (${extractFunction('prepareCrossfadeDeck').replace(/^function /, 'async function ')})`,
  )(
    state,
    () => state._decks,
    () => true,
    meta => new Promise(resolve => deferred.set(meta.id, urls => resolve(urls))),
    (audio, index) => {
      audio.pause();
      audio.removeAttribute('src');
      state._deckTracks[index] = null;
      state._deckGains[index] = 0;
    },
    () => {},
    () => {},
    async () => true,
    value => String(value || ''),
    () => false,
  );

  const oldRequest = prepareCrossfadeDeck(1, 0);
  const newRequest = prepareCrossfadeDeck(1, 1);
  deferred.get('new')(['stream-new']);
  assert.equal(await newRequest, standby);
  assert.equal(state._deckTracks[1], 1);
  assert.equal(standby.src, 'stream-new');
  assert.equal(standby.pauseCalls, 1);
  assert.equal(standby.loadCalls, 1);

  deferred.get('old')(['stream-old']);
  assert.equal(await oldRequest, null);
  assert.equal(state._deckTracks[1], 1);
  assert.equal(standby.src, 'stream-new');
  assert.equal(standby.pauseCalls, 1);
  assert.equal(standby.loadCalls, 1);
});

test('play-next and reorder invalidation prepare the authoritative standby track', async () => {
  const makeAudio = src => ({
    src, currentSrc: src, readyState: 2, volume: 0,
    pauseCalls: 0, loadCalls: 0,
    pause() { this.pauseCalls++; },
    removeAttribute(name) { if (name === 'src') { this.src = ''; this.currentSrc = ''; } },
    load() { this.loadCalls++; this.currentSrc = this.src; this.readyState = 2; },
  });
  const active = makeAudio('stream-0');
  const standby = makeAudio('stream-1');
  const state = {
    active: true,
    _playbackEpoch: 0,
    _playbackAbort: new AbortController(),
    autoLevel: false,
    eqEnabled: false,
    crossfadeSeconds: 6,
    _crossfading: false,
    _deckIndex: 0,
    _decks: [active, standby],
    _deckTracks: [0, 1],
    _deckPrepareTokens: [0, 0],
    _crossfadePrefetchToken: 0,
    _deckGains: [1, 0],
    _deckAudioGraphs: [null, null],
    queue: [0, 1, 2],
    playNext: [],
    pos: 0,
    meta: [{ id: 0 }, { id: 1 }, { id: 2 }],
  };
  const resolved = [];
  const resetDeck = (audio, index) => {
    audio.pause();
    audio.removeAttribute('src');
    state._deckTracks[index] = null;
    state._deckGains[index] = 0;
  };
  const functions = Function(
    'state', 'ensureCrossfadeDecks', 'ensureAutoLevelAudioGraph',
    'resolveCrossfadeStreams', 'resetDeck', 'applyCachedAutoLevel', 'syncCrossfadeVolume',
    'waitForDeck', 'normalizeTrackUrl', 'deckIsPreviewLimited', 'currentDeckAudio', 'setCrossfadeStatus',
    `${extractFunction('upcomingTrackIndex')};
     ${extractFunction('prepareCrossfadeDeck').replace(/^function /, 'async function ')};
     ${extractFunction('prefetchUpcomingCrossfadeTrack').replace(/^function /, 'async function ')};
     ${extractFunction('refreshUpcomingCrossfadePreparation')};
     return { upcomingTrackIndex, refreshUpcomingCrossfadePreparation };`,
  )(
    state,
    () => state._decks,
    () => true,
    async meta => { resolved.push(meta.id); return [`stream-${meta.id}`]; },
    resetDeck,
    () => {},
    () => {},
    async () => true,
    value => String(value || ''),
    () => false,
    () => active,
    () => {},
  );
  const settlePrefetch = async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  };

  state.playNext.push(2);
  assert.equal(functions.upcomingTrackIndex(), 2);
  functions.refreshUpcomingCrossfadePreparation();
  await settlePrefetch();
  assert.equal(state._deckTracks[1], 2);
  assert.equal(standby.src, 'stream-2');

  state.playNext.length = 0;
  state.queue = [0, 1, 2];
  assert.equal(functions.upcomingTrackIndex(), 1);
  functions.refreshUpcomingCrossfadePreparation();
  await settlePrefetch();
  assert.equal(state._deckTracks[1], 1);
  assert.equal(standby.src, 'stream-1');
  assert.deepEqual(resolved, [2, 1]);

  state._crossfading = true;
  state.playNext.push(2);
  const pausesBeforeMixInvalidation = standby.pauseCalls;
  functions.refreshUpcomingCrossfadePreparation();
  await settlePrefetch();
  assert.equal(state._deckTracks[1], 1);
  assert.equal(standby.pauseCalls, pausesBeforeMixInvalidation);
  assert.deepEqual(resolved, [2, 1]);
});

test('custom mix curves preserve endpoints and never add overlap gain', () => {
  const gainsSource = extractFunction('crossfadeGains');
  const gains = Function(`return (${gainsSource})`)();
  for (const curve of ['smooth', 'clean', 'dj']) {
    assert.deepEqual(gains(0, curve), [1, 0]);
    const end = gains(1, curve);
    assert.ok(Math.abs(end[0]) < 1e-12);
    assert.ok(Math.abs(end[1] - 1) < 1e-12);
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const [out, incoming] = gains(t, curve);
      assert.ok(out >= 0 && incoming >= 0);
      assert.ok(out + incoming <= 1 + 1e-12);
    }
  }
});

test('crossfade schedule fails a stalled clock but excludes intentional paused time', async () => {
  const waitForSchedule = extractFunction('waitForCrossfadeSchedule');

  let now = 0;
  const diagnostics = [];
  const stalledState = {
    active: true,
    _playbackEpoch: 1,
    _playbackAbort: new AbortController(),
    _userPaused: false,
    _audioContext: { currentTime: 1, state: 'suspended' },
    _crossfadeToken: 9,
    _crossfadePausedByUser: false,
  };
  const stalledSchedule = { startTime: 1, endTime: 13, duration: 12 };
  stalledState._crossfadeSchedule = stalledSchedule;
  const waitForStall = Function(
    'state', 'Date', 'setTimeout', 'recordPlaybackDiagnostic', 'clearTimeout',
    `return (${waitForSchedule})`,
  )(
    stalledState,
    { now: () => { now += 1000; return now; } },
    fn => fn(),
    (event, details) => diagnostics.push({ event, details }),
    () => {},
  );
  assert.equal(await waitForStall(stalledSchedule, 9), false);
  assert.equal(diagnostics[0]?.event, 'crossfade-clock-stall');

  now = 0;
  let polls = 0;
  const pausedState = {
    active: true,
    _playbackEpoch: 1,
    _playbackAbort: new AbortController(),
    _userPaused: false,
    _audioContext: { currentTime: 1, state: 'suspended' },
    _crossfadeToken: 4,
    _crossfadePausedByUser: true,
  };
  const pausedSchedule = { startTime: 1, endTime: 13, duration: 12 };
  pausedState._crossfadeSchedule = pausedSchedule;
  const waitWhilePaused = Function(
    'state', 'Date', 'setTimeout', 'recordPlaybackDiagnostic', 'clearTimeout',
    `return (${waitForSchedule})`,
  )(
    pausedState,
    { now: () => { now += 1000; return now; } },
    fn => {
      if (++polls === 5) {
        pausedState._crossfadePausedByUser = false;
        pausedState._audioContext.currentTime = 13;
      }
      fn();
    },
    () => { throw new Error('an intentional pause must not time out'); },
    () => {},
  );
  assert.equal(await waitWhilePaused(pausedSchedule, 4), true);
});

test('background worker resolves paused or frozen Firefox crossfades', () => {
  const settleSource = extractFunction('settleScheduledCrossfade');
  const events = [];
  let resolution = null;
  const incoming = { paused: true, ended: false, currentTime: 0 };
  const state = {
    active: true,
    _userPaused: false,
    _audioContext: { currentTime: 1 },
    _decks: [null, incoming],
    _crossfadePausedByUser: false,
    _crossfadeSchedule: {
      incomingIndex: 1,
      endTime: 13,
      createdAt: 100,
      lastClockValue: 1,
      lastClockAdvanceAt: 100,
      lastIncomingTime: 0,
      lastIncomingAdvanceAt: 100,
      resolve(value) { resolution = value; },
    },
  };
  const settle = Function(
    'state', 'Date', 'recordPlaybackDiagnostic', 'playbackDiagnosticSnapshot',
    `return (${settleSource})`,
  )(
    state,
    { now: () => 500 },
    event => events.push(event),
    reason => ({ reason }),
  );
  settle();
  assert.equal(resolution, false);
  assert.deepEqual(events, ['crossfade-deck-paused']);

  resolution = null;
  events.length = 0;
  incoming.paused = false;
  state._crossfadeSchedule.faultRecorded = false;
  state._crossfadeSchedule.createdAt = 100;
  state._crossfadeSchedule.lastClockAdvanceAt = 100;
  state._crossfadeSchedule.lastIncomingAdvanceAt = 100;
  const settleFrozen = Function(
    'state', 'Date', 'recordPlaybackDiagnostic', 'playbackDiagnosticSnapshot',
    `return (${settleSource})`,
  )(
    state,
    { now: () => 3000 },
    event => events.push(event),
    reason => ({ reason }),
  );
  settleFrozen();
  assert.equal(resolution, false);
  assert.deepEqual(events, ['crossfade-clock-stall']);
});

test('crossfade gain automation follows the audio clock instead of the render loop', () => {
  const curveSource = extractFunction('crossfadeGains');
  const scheduledSource = extractFunction('scheduledCrossfadeGain');
  const scheduleSource = extractFunction('scheduleAudioParamCurve');
  const state = {
    _audioContext: { currentTime: 5 },
    _crossfadeSchedule: {
      outgoingIndex: 0,
      incomingIndex: 1,
      startTime: 0,
      duration: 10,
      curve: 'smooth',
    },
  };
  const gainAt = Function('state', `${curveSource}; ${scheduledSource}; return [scheduledCrossfadeGain(0), scheduledCrossfadeGain(1)];`)(state);
  assert.ok(gainAt[0] > 0 && gainAt[1] > 0);
  assert.ok(gainAt[0] + gainAt[1] <= 1 + 1e-12);

  const calls = [];
  const param = {
    cancelScheduledValues: value => calls.push(['cancel', value]),
    setValueAtTime: (value, time) => calls.push(['set', value, time]),
    linearRampToValueAtTime: (value, time) => calls.push(['ramp', value, time]),
  };
  Function('param', 'values', `${scheduleSource}; scheduleAudioParamCurve(param, values, 2, 8);`)(param, new Float32Array([1, 0.5, 0]));
  assert.deepEqual(calls.map(call => call[0]), ['cancel', 'set', 'ramp', 'ramp']);
  assert.equal(calls[0][1], 0);
  assert.deepEqual(calls[2], ['ramp', 0.5, 6]);
  assert.deepEqual(calls[3], ['ramp', 0, 10]);
});

test('Firefox crossfade cleanup clears active automation before setting gain', () => {
  const immediateSource = extractFunction('setAudioParamImmediately');
  const calls = [];
  let clearedFromStart = false;
  const param = {
    value: -1,
    cancelScheduledValues: time => {
      calls.push(['cancel', time]);
      clearedFromStart = time === 0;
    },
    setValueAtTime: (value, time) => {
      if (!clearedFromStart) {
        throw new DOMException("AudioParam.setValueAtTime: Can't add events during a curve event");
      }
      calls.push(['set', value, time]);
    },
  };

  const result = Function('param', `${immediateSource}; return setAudioParamImmediately(param, 0.75, 12);`)(param);
  assert.equal(result, true);
  assert.deepEqual(calls, [['cancel', 0], ['set', 0.75, 12]]);
});

test('crossfade decks continuously follow the shared True Shuffle master volume', () => {
  const sync = extractFunction('syncCrossfadeVolume');

  const decks = [{ volume: 0 }, { volume: 0 }];
  const state = { _decks: decks, _deckGains: [1, 0.5], _deckAudioGraphs: [], _audioMaster: null, playbackVolume: 0.137 };
  Function('state', 'scheduledCrossfadeGain', `${sync}; syncCrossfadeVolume();`)(state, () => null);
  assert.ok(Math.abs(decks[0].volume - 0.137) < 1e-12);
  assert.ok(Math.abs(decks[1].volume - 0.0685) < 1e-12);
});

test('saved volume initializes SoundCloud and external SoundCloud changes flow back', () => {
  const initializeSource = extractFunction('initializePlaybackVolume');
  const followSource = extractFunction('syncPlaybackVolumeFromSoundCloud');
  const writes = [];
  const localStorage = { setItem: (key, value) => writes.push([key, value]) };
  let nativeVolume = 0.62;
  const state = {
    _playbackVolumeInitialized: false,
    _playbackVolumeStored: true,
    _lastSoundCloudVolume: null,
    playbackVolume: 0.18,
  };
  const setCalls = [];
  const runInitialize = Function(
    'state', 'soundCloudVolume', 'setSoundCloudVolume', 'syncPlaybackVolumeControls', 'syncCrossfadeVolume', 'safeStorage',
    `${initializeSource}; return initializePlaybackVolume();`,
  );
  assert.equal(runInitialize(state, () => nativeVolume, value => { setCalls.push(value); state._lastSoundCloudVolume = value; return true; }, () => {}, () => {}, localStorage), true);
  assert.deepEqual(setCalls, [0.18]);
  assert.equal(state._playbackVolumeInitialized, true);

  nativeVolume = 0.47;
  Function(
    'state', 'currentDeckAudio', 'soundCloudVolume', 'initializePlaybackVolume', 'syncPlaybackVolumeControls', 'syncCrossfadeVolume', 'safeStorage',
    `${followSource}; syncPlaybackVolumeFromSoundCloud();`,
  )(state, () => null, () => nativeVolume, () => true, () => {}, () => {}, localStorage);
  assert.equal(state.playbackVolume, 0.47);
  assert.deepEqual(writes.at(-1), ['tss_playback_volume', '0.47']);
});

test('SoundCloud percentage volume is normalized before reaching custom decks', () => {
  const normalizeSource = extractFunction('normalizeSoundCloudVolume');
  const modelSource = extractFunction('soundCloudVolumeModel');
  const sliderSource = extractFunction('soundCloudVolumeSlider');
  const volumeSource = extractFunction('soundCloudVolume');
  const readVolume = (value, maxValue = null) => {
    const slider = {
      getAttribute(name) {
        if (name === 'aria-valuenow') return value;
        if (name === 'aria-valuemax') return maxValue;
        return null;
      },
    };
    const document = {
      querySelector: () => slider,
      querySelectorAll: () => [],
    };
    const state = { _soundCloudVolumeModel: null };
    const pageWindow = { webpackJsonp: null };
    return Function('document', 'state', 'pageWindow', `${normalizeSource}; ${modelSource}; ${sliderSource}; ${volumeSource}; return soundCloudVolume();`)(document, state, pageWindow);
  };

  assert.equal(readVolume('35', '100'), 0.35);
  assert.equal(readVolume('70'), 0.7);
  assert.equal(readVolume('0.42', '1'), 0.42);
  assert.equal(readVolume('0', '100'), 0);
  assert.equal(readVolume('100', '100'), 1);
});

test('master volume writes the same continuous value into SoundCloud controls', () => {
  const modelSource = extractFunction('soundCloudVolumeModel');
  const sliderSource = extractFunction('soundCloudVolumeSlider');
  const setterSource = extractFunction('setSoundCloudVolume');
  const events = [];
  const track = { getBoundingClientRect: () => ({ left: 10, width: 20, top: 20, bottom: 120, height: 100 }) };
  const slider = {
    querySelector: () => track,
    dispatchEvent: event => events.push({ target: 'slider', event }),
  };
  const document = {
    querySelector: () => slider,
    dispatchEvent: event => events.push({ target: 'document', event }),
  };
  class MouseEvent {
    constructor(type, options) { this.type = type; Object.assign(this, options); }
  }
  const state = { _lastSoundCloudVolume: null, _soundCloudVolumeModel: null };
  const pageWindow = { webpackJsonp: null };
  const changed = Function(
    'document', 'state', 'pageWindow', 'MouseEvent',
    `${modelSource}; ${sliderSource}; ${setterSource}; return setSoundCloudVolume(0.37);`,
  )(document, state, pageWindow, MouseEvent);

  assert.equal(changed, true);
  assert.equal(state._lastSoundCloudVolume, 0.37);
  assert.deepEqual(events.map(item => item.event.type), ['mousedown', 'mousemove', 'mouseup']);
  assert.equal(events[0].event.clientX, 20);
  assert.equal(events[0].event.clientY, 87);
});

test('SoundCloud volume model is discovered and used before DOM fallbacks', () => {
  const modelSource = extractFunction('soundCloudVolumeModel');
  const sliderSource = extractFunction('soundCloudVolumeSlider');
  const setterSource = extractFunction('setSoundCloudVolume');
  const calls = [];
  const volumeModel = {
    getVolume: () => 0.8,
    getMuted: () => false,
    setVolumeAndMuted: payload => calls.push(payload),
  };
  const requireFn = { c: { 111: { exports: volumeModel } } };
  const pageWindow = {
    webpackJsonp: {
      push(payload) {
        const modules = payload[1];
        const moduleId = payload[2][0][0];
        modules[moduleId]({}, {}, requireFn);
      },
    },
  };
  const state = { _soundCloudVolumeModel: null, _lastSoundCloudVolume: null };
  const document = { querySelector: () => { throw new Error('DOM fallback should not run'); } };
  class MouseEvent {}
  const changed = Function(
    'document', 'state', 'pageWindow', 'MouseEvent',
    `${modelSource}; ${sliderSource}; ${setterSource}; return setSoundCloudVolume(0.423);`,
  )(document, state, pageWindow, MouseEvent);

  assert.equal(changed, true);
  assert.deepEqual(calls, [{ volume: 0.423, muted: false }]);
  assert.equal(state._lastSoundCloudVolume, 0.423);
});

(async () => {
  for (const { name, fn } of tests) {
    let timeout;
    try {
      await Promise.race([
        Promise.resolve().then(fn),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error(`Timed out: ${name}`)), 10000);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
    console.log(`ok - ${name}`);
  }
  console.log('\nAll crossfade prototype tests passed.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
