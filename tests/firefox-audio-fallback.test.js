const fs = require('fs');
const path = require('path');
const assert = require('assert');

const source = fs.readFileSync(path.join(__dirname, '..', 'SC Trueshuffle.js'), 'utf8');

function extractFunction(name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing function ${name}`);
  const bodyStart = source.indexOf('{', start);
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
  assert.match(sync, /if \(currentDeckAudio\(\)\) return;/);

  const state = { _playbackVolumeInitialized: true, _lastSoundCloudVolume: 0.2, playbackVolume: 0.8 };
  let nativeReads = 0;
  const run = Function(
    'state', 'currentDeckAudio', 'initializePlaybackVolume', 'soundCloudVolume',
    'localStorage', 'syncCrossfadeVolume', 'syncPlaybackVolumeControls',
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
  assert.match(playAtSource, /playWithSoundCloudSession/);

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

test('preview fallback delegates the exact queued row to the signed-in SoundCloud player', async () => {
  const button = { clickCalls: 0, click() { this.clickCalls++; } };
  const row = {
    scrollIntoView() {},
    dispatchEvent() {},
    querySelector() { return button; },
  };
  const nativeAudio = { tagName: 'AUDIO', paused: false, currentSrc: 'entitled-stream' };
  const state = {
    meta: [{ title: 'Premium track', requiresNativePlayback: true }],
    els: [row],
    stats: { played: 0, playCounts: {} },
    _nativeTrack: null,
    _nativeSessionNoticeShown: false,
    suspended: true,
  };
  const document = {
    body: { contains: value => value === row },
    querySelectorAll: selector => selector === 'audio' ? [nativeAudio] : [],
  };
  const notices = [];
  const playWithSoundCloudSession = Function(
    'state', 'document', 'MouseEvent', 'wait', 'stopCrossfadeDecks',
    'isTrueShuffleAudio', 'soundCloudPaused', 'playerTitle', 'trackPlayed',
    'showMergeToast', 'setTimeout', 'refreshPlayBtn', 'updateProgressBar', 'updateHub',
    `return (${extractFunction('playWithSoundCloudSession').replace(/^function /, 'async function ')})`,
  )(
    state, document, function MouseEvent() {}, async () => {},
    () => { state._nativeTrack = null; }, () => false, () => false, () => 'Premium track',
    ti => {
      state.stats.played++;
      state.stats.playCounts[ti] = (state.stats.playCounts[ti] || 0) + 1;
    },
    message => notices.push(message), fn => fn(), () => {}, () => {}, () => {},
  );

  assert.equal(await playWithSoundCloudSession(0), true);
  assert.equal(button.clickCalls, 1);
  assert.equal(state._nativeTrack, 0);
  assert.equal(state.stats.played, 1);
  assert.equal(state.suspended, false);
  assert.match(notices[0], /using your SoundCloud session/);
});

test('Firefox stream candidates prefer MPEG and continue after a failed endpoint', async () => {
  const resolverSource = extractFunction('resolveProgressiveStreams');
  const calls = [];
  const fetch = async endpoint => {
    calls.push(String(endpoint));
    if (calls.length === 1) return { ok: false, status: 500 };
    return { ok: true, status: 200, json: async () => ({ url: 'https://media.example/working' }) };
  };
  const resolveProgressiveStreams = Function(
    'fetch',
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

  assert.equal(discover('rejected-client'), 'fresh-client');
  assert.equal(state._clientId, 'fresh-client');
  const resolver = extractFunction('resolveCrossfadeStreams');
  assert.match(resolver, /credentialAttempt < 2/);
  assert.match(resolver, /discoverSoundCloudClientIdFromBundle\(rejectedClientId\)/);
  assert.match(resolver, /rejectedClientId = clientId/);
});

test('waveform hydration requires exact track identity and never reuses a title match', () => {
  const resolver = extractFunction('hydrationWaveformUrl');
  assert.doesNotMatch(resolver, /titleMatch|candidateTitle|candidateArtist/);
  assert.match(resolver, /candidateUrl === wantedUrl/);

  const hydrationWaveformUrl = Function(
    'pageWindow', 'normalizeTrackUrl', `return (${resolver})`,
  )(
    { __sc_hydration: [{ title: 'Same title', user: { username: 'Same artist' }, permalink_url: 'https://soundcloud.com/other/track', waveform_url: 'wrong' }] },
    value => String(value || '').split(/[?#]/)[0].replace(/\/$/, '').toLowerCase(),
  );
  assert.equal(hydrationWaveformUrl({ title: 'Same title', artist: 'Same artist', link: 'https://soundcloud.com/wanted/track' }), null);
});

test('missing Firefox hydration resolves the exact waveform through the track API', () => {
  const resolver = extractFunction('resolveWaveformUrl');
  assert.match(resolver, /api-v2\.soundcloud\.com\/resolve\?url=/);
  assert.match(resolver, /candidateUrl === wantedUrl/);
  assert.match(resolver, /meta\.waveform = resolved/);
  assert.doesNotMatch(resolver, /performance\.getEntriesByType|titleMatch/);
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
