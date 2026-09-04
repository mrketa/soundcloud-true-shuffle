const fs = require('fs');
const path = require('path');
const assert = require('assert');

const source = fs.readFileSync(path.join(__dirname, '..', 'SC Trueshuffle.js'), 'utf8');

function extractFunction(name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing function ${name}`);
  const bodyStart = source.indexOf(') {', start) + 2;
  let depth = 0;
  for (let index = bodyStart; index < source.length; index++) {
    if (source[index] === '{') depth++;
    if (source[index] === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('custom deck playback never imports a Firefox native-media volume fallback', () => {
  const sync = extractFunction('syncPlaybackVolumeFromSoundCloud');

  const state = { _playbackVolumeInitialized: true, _lastSoundCloudVolume: 0.2, playbackVolume: 0.8 };
  let nativeReads = 0;
  const run = Function(
    'state', 'currentDeckAudio', 'initializePlaybackVolume', 'soundCloudVolume',
    'safeStorage', 'syncCrossfadeVolume', 'syncPlaybackVolumeControls',
    `${sync}; syncPlaybackVolumeFromSoundCloud();`,
  );
  run(
    state, () => ({ paused: false }), () => true, () => { nativeReads++; return 0.2; },
    { setItem() {} }, () => {}, () => {},
  );
  assert.equal(nativeReads, 0);
  assert.equal(state.playbackVolume, 0.8);
});

test('generic failures rotate custom decks while preview tracks may use SoundCloud session playback', async () => {
  const playAtSource = extractFunction('playAt');

  const state = {
    active: true,
    meta: [{ title: 'Failed track' }, { title: 'Working track' }],
    queue: [0, 1],
    pos: 0,
    crossfadeSeconds: 0,
    crossfadeManual: false,
    _crossfadePending: false,
    _customPlaybackRetryTimer: null,
    suspended: false,
    busy: true,
  };
  const attempted = [];
  const nativeAttempts = [];
  const playWithCrossfadeDeck = async ti => {
    attempted.push(ti);
    return ti === 1;
  };
  const playAt = Function(
    'state', 'currentDeckAudio', 'playWithCrossfadeDeck', 'stopCrossfadeDecks',
    'setCrossfadeStatus', 'playWithSoundCloudSession', 'recordPlaybackDiagnostic',
    'trackAvailable', 'showMergeToast', 'updateHub', 'clearTimeout', 'setTimeout',
    `return (${playAtSource.replace(/^function /, 'async function ')})`,
  )(
    state, () => null, playWithCrossfadeDeck, () => {}, () => {},
    async ti => { nativeAttempts.push(ti); return false; }, () => {},
    () => true, () => {}, () => {}, () => {}, () => 1,
  );

  await playAt(0);
  assert.deepEqual(attempted, [0, 1]);
  assert.deepEqual(nativeAttempts, []);
  assert.deepEqual(state.queue, [1, 0]);
  assert.equal(state.suspended, false);
});

test('SoundCloud access metadata distinguishes previews from entitled streams', () => {
  const syncTrackPlaybackAccess = Function(
    `return (${extractFunction('syncTrackPlaybackAccess')})`,
  )();
  const preview = {};
  const playable = { requiresNativePlayback: true };

  assert.equal(syncTrackPlaybackAccess(preview, {
    access: 'preview',
    duration: 240000,
    media: { transcodings: [] },
  }), true);
  assert.equal(preview.requiresNativePlayback, true);
  assert.equal(preview.durationMs, 240000);

  assert.equal(syncTrackPlaybackAccess(playable, {
    access: 'playable',
    duration: 240000,
    media: { transcodings: [] },
  }), false);
  assert.equal(playable.requiresNativePlayback, false);
});

function createNativeFallbackHarness() {
  const nativeAudio = {
    tagName: 'AUDIO', dataset: {}, paused: false, currentSrc: 'entitled-stream',
    pause() { this.paused = true; },
  };
  const wanted = 'https://soundcloud.com/artist/premium';
  const state = {
    active: true, loading: false, _userPaused: false, queue: [0], pos: 0,
    _playbackEpoch: 1, _playbackRequest: 1, _playbackAbort: new AbortController(),
    meta: [{ link: wanted, title: 'Premium track', requiresNativePlayback: true }],
    stats: { played: 0, playCounts: {} }, _nativeTrack: null, _decks: [],
    _nativeSessionNoticeShown: false, suspended: true,
  };
  const nativePlaybackAllowed = Function(
    'state', `return (${extractFunction('nativePlaybackAllowed')})`,
  )(state);
  let transportPaused = false;
  const button = {
    clickCalls: 0,
    click() {
      this.clickCalls++;
      if (nativePlaybackAllowed()) {
        nativeAudio.paused = false;
        transportPaused = false;
      }
    },
  };
  const row = { scrollIntoView() {}, dispatchEvent() {}, querySelector: () => button };
  state.els = [row];
  const transport = {
    get title() { return transportPaused ? 'Play current track' : 'Pause current track'; },
    getAttribute() { return this.title; },
    click() { transportPaused = !transportPaused; nativeAudio.paused = transportPaused; },
  };
  const harness = {
    state, nativeAudio, button, wanted,
    currentLink: 'https://soundcloud.com/artist/previous',
    onWait: async () => {},
  };
  const document = {
    body: { contains: value => value === row },
    querySelector: selector => selector === '.playControls__play'
      ? transport : { href: harness.currentLink },
    querySelectorAll: selector => selector === 'audio' ? [nativeAudio] : [],
  };
  const dependencies = {
    state, document, nativePlaybackAllowed,
    MouseEvent: function MouseEvent() {},
    wait: () => harness.onWait(),
    stopCrossfadeDecks: () => { state._nativeTrack = null; },
    playerTitle: () => 'Premium track',
    trackPlayed: ti => {
      state.stats.played++;
      state.stats.playCounts[ti] = (state.stats.playCounts[ti] || 0) + 1;
    },
    showMergeToast: () => {}, setTimeout: () => 1, refreshPlayBtn: () => {},
    updateProgressBar: () => {}, updateHub: () => {},
    withDeadline: operation => operation(),
    normalizeTrackUrl: value => String(value || ''),
    recordPlaybackDiagnostic: () => {},
  };
  for (const name of ['isTrueShuffleAudio', 'soundCloudPaused', 'pauseSoundCloud', 'pauseSoundCloudTransport']) {
    dependencies[name] = Function(
      ...Object.keys(dependencies), `return (${extractFunction(name)})`,
    )(...Object.values(dependencies));
  }
  harness.play = Function(
    ...Object.keys(dependencies),
    `return (${extractFunction('playWithSoundCloudSession').replace(/^function /, 'async function ')})`,
  )(...Object.values(dependencies));
  harness.nativePlaybackAllowed = nativePlaybackAllowed;
  harness.soundCloudPaused = dependencies.soundCloudPaused;
  return harness;
}

test('preview fallback acknowledges only the exact track and stops unacknowledged native playback', async () => {
  const harness = createNativeFallbackHarness();
  const { state, nativeAudio } = harness;
  assert.equal(await harness.play(0), false, 'old playing audio does not acknowledge the new track');
  assert.equal(state.stats.played, 0);
  assert.equal(harness.nativePlaybackAllowed(), false);
  assert.equal(nativeAudio.paused, true, 'wrong-track native output is stopped on failure');
  assert.equal(harness.soundCloudPaused(), true);

  harness.onWait = async () => { harness.currentLink = harness.wanted; };
  assert.equal(await harness.play(0), true);
  assert.equal(harness.nativePlaybackAllowed(), true);
  assert.equal(nativeAudio.paused, false);
  assert.equal(state.stats.played, 1);
  assert.equal(state.suspended, false);
});

test('native fallback failure and user pause revoke permission and stop the native output', async () => {
  for (const failure of ['error', 'user pause']) {
    const harness = createNativeFallbackHarness();
    harness.onWait = async () => {
      if (harness.nativeAudio.paused) return;
      if (failure === 'error') throw new Error('SoundCloud acknowledgement failed');
      harness.state._userPaused = true;
    };
    assert.equal(await harness.play(0), failure === 'error' ? false : null);
    assert.equal(harness.nativePlaybackAllowed(), false, `${failure}: fallback permission is revoked`);
    assert.equal(harness.nativeAudio.paused, true, `${failure}: native output is paused`);
    assert.equal(harness.soundCloudPaused(), true, `${failure}: native transport is paused`);
    assert.equal(harness.state.stats.played, 0);
  }
});

test('late fallback completion cannot pause a newer successful native request', async () => {
  const harness = createNativeFallbackHarness();
  let releaseOld;
  let oldWaiting;
  const waiting = new Promise(resolve => { oldWaiting = resolve; });
  harness.onWait = async () => {
    if (harness.nativeAudio.paused) return;
    oldWaiting();
    await new Promise(resolve => { releaseOld = resolve; });
  };
  const oldRequest = harness.play(0);
  await waiting;

  harness.state._playbackRequest++;
  harness.onWait = async () => { harness.currentLink = harness.wanted; };
  assert.equal(await harness.play(0), true);
  releaseOld();
  assert.equal(await oldRequest, null);
  assert.equal(harness.nativeAudio.paused, false);
  assert.equal(harness.soundCloudPaused(), false);
  assert.equal(harness.nativePlaybackAllowed(), true);
  assert.equal(harness.state.stats.played, 1, 'only the newer request records a play');
});

test('Firefox stream candidates prefer MPEG and continue after a failed endpoint', async () => {
  const resolverSource = extractFunction('resolveProgressiveStreams');
  const calls = [];
  const fetch = async endpoint => {
    calls.push(String(endpoint));
    if (calls.length === 1) return { ok: false, status: 500 };
    return { ok: true, status: 200, data: { url: 'https://media.example/working' } };
  };
  const resolveProgressiveStreams = Function(
    'fetchSoundCloudResource',
    `return (${resolverSource.replace(/^function /, 'async function ')})`,
  )(fetch);
  const track = {
    track_authorization: 'track-token',
    media: {
      transcodings: [
        { url: 'https://api.example/ogg', format: { protocol: 'progressive', mime_type: 'audio/ogg' } },
        { url: 'https://api.example/mp3', format: { protocol: 'progressive', mime_type: 'audio/mpeg' } },
        { url: 'https://api.example/hls', format: { protocol: 'hls', mime_type: 'audio/mpeg' } },
      ],
    },
  };

  const result = await resolveProgressiveStreams(track, 'client-token');
  assert.match(calls[0], /^https:\/\/api\.example\/mp3/);
  assert.match(calls[1], /^https:\/\/api\.example\/ogg/);
  assert.equal(calls.some(url => url.includes('/hls')), false);
  assert.match(calls[0], /client_id=client-token/);
  assert.match(calls[0], /track_authorization=track-token/);
  assert.deepEqual(result, { urls: ['https://media.example/working'], authFailed: false });
});

test('authorization recovery excludes the rejected SoundCloud client ID', () => {
  const state = { _clientId: 'rejected-client' };
  const performance = {
    getEntriesByType: () => [
      { name: 'https://api-v2.soundcloud.com/tracks?client_id=fresh-client' },
      { name: 'https://api-v2.soundcloud.com/resolve?client_id=rejected-client' },
    ],
  };
  const discover = Function(
    'state', 'performance',
    `return (${extractFunction('discoverSoundCloudClientId')})`,
  )(state, performance);

  assert.equal(discover(new Set(['rejected-client'])), 'fresh-client');
  assert.equal(state._clientId, 'fresh-client');
});

test('waveform hydration requires exact track identity and never reuses a title match', () => {
  const resolver = extractFunction('hydrationWaveformUrl');

  const hydrationWaveformUrl = Function(
    'pageWindow', 'normalizeTrackUrl', `return (${resolver})`,
  )(
    { __sc_hydration: [{ title: 'Same title', user: { username: 'Same artist' }, permalink_url: 'https://soundcloud.com/other/track', waveform_url: 'wrong' }] },
    value => String(value || '').split(/[?#]/)[0].replace(/\/$/, '').toLowerCase(),
  );
  assert.equal(hydrationWaveformUrl({ title: 'Same title', artist: 'Same artist', link: 'https://soundcloud.com/wanted/track' }), null);
});

test('missing Firefox hydration resolves and stores only an exact waveform identity', async () => {
  let track = { permalink_url: 'https://soundcloud.com/other/track', waveform_url: 'wrong' };
  const meta = { link: 'https://soundcloud.com/wanted/track' };
  const resolve = Function(
    'hydrationWaveformUrl', 'normalizeTrackUrl', 'discoverSoundCloudClientIdFromBundle',
    'fetchSoundCloudResource', 'recordPlaybackDiagnostic',
    `return (${extractFunction('resolveWaveformUrl').replace(/^function /, 'async function ')})`,
  )(
    () => null, value => String(value || ''), async () => 'client',
    async () => ({ ok: true, data: track }), () => {},
  );
  assert.equal(await resolve(meta), null);
  assert.equal(meta.waveform, undefined);
  track = { permalink_url: meta.link, waveform_url: 'correct' };
  assert.equal(await resolve(meta), 'correct');
  assert.equal(meta.waveform, 'correct');
});

(async () => {
  let failures = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`ok - ${name}`);
    } catch (error) {
      failures++;
      console.error(`not ok - ${name}`);
      console.error(error.stack || error);
    }
  }

  if (failures) {
    console.error(`\n${failures} Firefox audio fallback regression test(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log('\nAll Firefox audio fallback regression tests passed.');
  }
})();
