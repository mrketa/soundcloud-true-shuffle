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

test('active True Shuffle playback never authorizes or clicks the native player', async () => {
  assert.doesNotMatch(source, /beginNativePlaybackFallback|nativePlaybackFallbackActive|_nativePlaybackFallback/);
  const playAtSource = extractFunction('playAt');
  assert.doesNotMatch(playAtSource, /document|\.click\(/);

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
  const playWithCrossfadeDeck = async ti => {
    attempted.push(ti);
    return ti === 1;
  };
  const playAt = Function(
    'state', 'currentDeckAudio', 'playWithCrossfadeDeck', 'stopCrossfadeDecks',
    'setCrossfadeStatus', 'recordPlaybackDiagnostic', 'trackAvailable',
    'showMergeToast', 'updateHub', 'clearTimeout', 'setTimeout',
    `return (${playAtSource.replace(/^function /, 'async function ')})`,
  )(
    state, () => null, playWithCrossfadeDeck, () => {}, () => {}, () => {},
    () => true, () => {}, () => {}, () => {}, () => 1,
  );

  await playAt(0);
  assert.deepEqual(attempted, [0, 1]);
  assert.deepEqual(state.queue, [1, 0]);
  assert.equal(state.suspended, false);
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
