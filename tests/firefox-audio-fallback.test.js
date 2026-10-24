const fs = require('fs');
const path = require('path');
const assert = require('assert');

const source = fs.readFileSync(process.env.TSS_SCRIPT || path.join(__dirname, '..', 'SC Trueshuffle.js'), 'utf8');

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
function extractedHelpers(names, dependencies) {
  const functions = names.map(name => {
    const body = extractFunction(name);
    return source.includes(`async function ${name}(`) ? `async ${body}` : body;
  }).join('\n');
  return Function(...Object.keys(dependencies), `${functions}\nreturn { ${names.join(', ')} };`)(...Object.values(dependencies));
}
const hardenedNative = source.includes('function boundSoundCloudRow(');

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

test('HLS MSE unsupported uses exact SoundCloud fallback instead of queue rotation', async () => {
  const harness = createNativeFallbackHarness();
  const { state, nativeAudio } = harness;
  state.meta[0].nativePlaybackReason = 'hls-mse-unavailable';
  state.queue = [0];
  const playWithCrossfadeDeck = Function(
    'state', 'currentDeckAudio',
    `return (${extractFunction('playWithCrossfadeDeck').replace(/^function /, 'async function ')})`,
  )(state, () => null);
  const playAt = Function(
    'state', 'currentDeckAudio', 'playWithCrossfadeDeck', 'stopCrossfadeDecks',
    'setCrossfadeStatus', 'playWithSoundCloudSession', 'recordPlaybackDiagnostic',
    'trackAvailable', 'showMergeToast', 'updateHub', 'clearTimeout', 'setTimeout',
    `return (${extractFunction('playAt').replace(/^function /, 'async function ')})`,
  )(
    state, () => null, playWithCrossfadeDeck,
    () => { state._nativeTrack = null; }, () => {},
    harness.play, () => {}, () => true, () => {}, () => {}, () => {}, () => 1,
  );
  harness.onWait = async () => { harness.currentLink = harness.wanted; };

  assert.equal(await playAt(0), true);
  assert.equal(state.queue[0], 0, 'the MSE-unsupported track is not deferred as unavailable');
  assert.equal(state._nativeTrack, 0);
  assert.equal(harness.button.clickCalls, 1);
  assert.equal(nativeAudio.paused, false);
  assert.equal(state.stats.played, 1);
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
    ended: false, playCalls: 0, pauseCalls: 0,
    play() { this.playCalls++; throw new Error('native media.play is forbidden'); },
    pause() { this.pauseCalls++; this.paused = true; },
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
  const row = {
    scrollIntoView() {}, dispatchEvent() {},
    querySelector: selector => selector === '.trackItem__trackTitle, .soundTitle__title, a.sc-link-primary'
      ? { href: harness.rowLink, getAttribute: () => harness.rowLink } : button,
  };
  state.els = [row];
  const transport = {
    pauseCalls: 0,
    get title() { return transportPaused ? 'Play current track' : 'Pause current track'; },
    getAttribute() { return this.title; },
    click() {
      transportPaused = !transportPaused;
      if (transportPaused) this.pauseCalls++;
      nativeAudio.paused = transportPaused;
    },
  };
  const harness = {
    state, nativeAudio, transport, button, wanted, row, rowLink: wanted,
    attachedRows: new Set([row]), replacementRows: [],
    transportPresent: true, audioPresent: true,
    currentLink: 'https://soundcloud.com/artist/previous',
    onWait: async () => {},
  };
  const document = {
    body: { contains: value => harness.attachedRows.has(value) },
    querySelector: selector => selector === '.playControls__play'
      ? (harness.transportPresent ? transport : null) : { href: harness.currentLink },
    querySelectorAll: selector => selector === 'audio'
      ? (harness.audioPresent ? [nativeAudio] : [])
      : selector === 'a[href]' ? harness.replacementRows.map(row => row.link) : [],
  };
  const dependencies = {
    state, document, nativePlaybackAllowed, URL, AbortController, window: {},
    location: { href: 'https://soundcloud.com/user/sets/list' }, syncOwnPipWindow() {},
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
    normalizeTrackUrl: value => String(value || '').split(/[?#]/)[0].replace(/\/$/, '').toLowerCase(),
    currentDeckAudio: () => null,
    playbackErrorName: error => {
      const name = typeof error?.name === 'string' ? error.name : '';
      return /^(?:AbortError|TimeoutError|NotAllowedError|NotSupportedError|NotReadableError|InvalidStateError|SecurityError|NetworkError|EncodingError|OperationError|QuotaExceededError|UnknownError|Error|TypeError|RangeError|SyntaxError|ReferenceError|EvalError|DataError|IndexSizeError|NotFoundError|InvalidAccessError|InvalidModificationError|ConstraintError|NoModificationAllowedError|InvalidCharacterError|OverconstrainedError)$/.test(name)
        ? name : 'UnknownError';
    },
    recordPlaybackDiagnostic: () => {},
  };
  const names = ['isTrueShuffleAudio', 'soundCloudPaused', 'pauseSoundCloud', 'pauseSoundCloudTransport',
    'paused', 'pause', 'toggle', 'playWithSoundCloudSession'];
  if (hardenedNative) names.push('soundCloudHref', 'getLink', 'boundSoundCloudRow', 'findSoundCloudLikeButton', 'motionIsInstant');
  names.push(...['soundCloudInteger', 'soundCloudPermalinkConflicts', 'soundCloudLinkMatches', 'soundCloudPlayerMatches',
    'toggleCurrentTrackLike', 'currentTrackLikeState', 'soundCloudLikeButtonState']
    .filter(name => source.includes(`function ${name}(`)));
  const helpers = extractedHelpers(names, dependencies);
  harness.play = helpers.playWithSoundCloudSession;
  harness.nativePlaybackAllowed = nativePlaybackAllowed;
  harness.soundCloudPaused = helpers.soundCloudPaused;
  harness.paused = helpers.paused;
  harness.pause = helpers.pause;
  harness.toggle = helpers.toggle;
  if (hardenedNative) harness.findLikeButton = helpers.findSoundCloudLikeButton;
  harness.toggleLike = helpers.toggleCurrentTrackLike;
  if (hardenedNative) harness.boundRow = helpers.boundSoundCloudRow;
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
  const calls = [];
  const fetch = async endpoint => {
    calls.push(String(endpoint));
    if (calls.length === 1) return { ok: false, status: 500 };
    return { ok: true, status: 200, data: { url: 'https://media.example/working' } };
  };
  const { resolveProgressiveStreams } = extractedHelpers(
    ['resolveProgressiveStreams', 'playbackErrorName'],
    { fetchSoundCloudResource: fetch, URL, recordPlaybackDiagnostic() {} },
  );
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
    'state', 'performance', 'URL',
    `return (${extractFunction('discoverSoundCloudClientId')})`,
  )(state, performance, URL);

  assert.equal(discover(new Set(['rejected-client'])), 'fresh-client');
  assert.equal(state._clientId, 'fresh-client');
});

if (hardenedNative) {
  test('shared-permalink identities cannot authorize native start or Like through URL-only rows', async () => {
    const h = createNativeFallbackHarness();
    h.state.meta[0].soundcloudId = 11;
    h.state.meta.push({ ...h.state.meta[0], soundcloudId: 22 });
    h.currentLink = h.wanted;
    assert.strictEqual(h.boundRow(0), null);
    assert.strictEqual(h.findLikeButton(0), null);
    assert.equal(await h.toggleLike(), false);
    assert.equal(await h.play(0), false);
    assert.equal(h.button.clickCalls, 0, 'neither Like nor native start clicks an ambiguous row');
    assert.equal(h.state.stats.played, 0);
    assert.equal(h.nativePlaybackAllowed(), false);
  });

  test('a conflict discovered across native waits prevents clicks and wrong-identity acknowledgement', async () => {
    for (const phase of ['before click', 'acknowledgement']) {
      const h = createNativeFallbackHarness();
      h.state.meta[0].soundcloudId = 11;
      let waits = 0;
      h.onWait = async () => {
        waits++;
        if (waits === (phase === 'before click' ? 1 : 2)) {
          h.state.meta.push({ ...h.state.meta[0], soundcloudId: 22 });
          h.currentLink = h.wanted;
        }
      };
      assert.equal(await h.play(0), false);
      assert.equal(h.button.clickCalls, phase === 'before click' ? 0 : 1);
      assert.equal(h.state.stats.played, 0, 'shared URL is never acknowledged as the requested ID');
      assert.strictEqual(h.state._nativeTrack, null);
      assert.equal(h.nativeAudio.paused, true, 'current failed owner stops native output');
    }
  });

  test('native resume rejects an ambiguous badge while a unique known identity retains native playback', async () => {
    const h = createNativeFallbackHarness();
    h.state.meta[0].soundcloudId = 11;
    h.onWait = async () => { h.currentLink = h.wanted; };
    assert.equal(await h.play(0), true, 'a unique ID still supports established URL-only native binding');
    assert.strictEqual(h.boundRow(0), h.row);
    h.pause();
    h.state.meta.push({ ...h.state.meta[0], soundcloudId: 22 });
    let resumeClicks = 0;
    const click = h.transport.click;
    h.transport.click = function () { resumeClicks++; return click.call(this); };
    assert.equal(await h.toggle(), false);
    assert.equal(resumeClicks, 0);
    assert.equal(h.nativeAudio.paused, true);
    assert.equal(h.state._userPaused, true);
    assert.equal(h.state.stats.played, 1, 'rejected resume adds no new play acknowledgement');
  });

  test('native start retains cleanup ownership when a real Like lookup rebinds its row during an await', async () => {
    for (const phase of ['before click', 'unacknowledged poll']) {
      for (const invalidation of ['detached', 'recycled']) {
        const h = createNativeFallbackHarness();
        const owner = {
          epoch: h.state._playbackEpoch,
          request: h.state._playbackRequest,
          meta: h.state.meta[0],
        };
        let release;
        let reached;
        const pending = new Promise(resolve => { release = resolve; });
        const waiting = new Promise(resolve => { reached = resolve; });
        let waits = 0;
        h.onWait = async () => {
          waits++;
          if (waits === (phase === 'before click' ? 1 : 2)) {
            reached();
            await pending;
          }
        };
        const operation = h.play(0);
        await waiting;
        assert.equal(h.state._nativeTrack, 0);
        assert.equal(h.button.clickCalls, phase === 'before click' ? 0 : 1);

        if (invalidation === 'detached') h.attachedRows.delete(h.row);
        else h.rowLink = 'https://soundcloud.com/other/recycled-track';
        const replacementButton = {
          clickCalls: 0,
          click() { this.clickCalls++; },
        };
        const likeButton = { click() { throw new Error('Like lookup must not click'); } };
        const replacement = {
          querySelector(selector) {
            if (selector === '.trackItem__trackTitle, .soundTitle__title, a.sc-link-primary') return this.link;
            return selector === '.sc-button-like' ? likeButton : replacementButton;
          },
        };
        replacement.link = {
          href: h.wanted,
          getAttribute: () => h.wanted,
          closest: () => replacement,
        };
        h.attachedRows.add(replacement);
        h.replacementRows.push(replacement);
        assert.strictEqual(h.findLikeButton(0), likeButton, 'real lookup finds the replacement track row');
        assert.strictEqual(h.state.els[0], replacement, 'boundSoundCloudRow actually updates the shared binding');
        assert.equal(h.state._playbackEpoch, owner.epoch);
        assert.equal(h.state._playbackRequest, owner.request);
        assert.strictEqual(h.state.meta[0], owner.meta);

        // Model native output becoming active while the operation is suspended,
        // without directly invoking native media.play().
        h.nativeAudio.paused = false;
        const stopsBeforeRelease = h.nativeAudio.pauseCalls + h.transport.pauseCalls;
        release();
        assert.equal(await operation, false, `${phase}/${invalidation}: current owner rejects unavailable playback`);
        assert.strictEqual(h.state._nativeTrack, null, 'row replacement cannot strand native authorization');
        assert.equal(h.nativePlaybackAllowed(), false);
        assert.equal(h.nativeAudio.paused, true);
        assert.ok(h.nativeAudio.pauseCalls + h.transport.pauseCalls > stopsBeforeRelease,
          'current owner actively stops native output through transport or media');
        assert.equal(h.button.clickCalls, phase === 'before click' ? 0 : 1, 'captured invalid row is never clicked after replacement');
        assert.equal(replacementButton.clickCalls, 0, 'concurrent rebind cannot redirect the pending click');
        assert.equal(h.nativeAudio.playCalls, 0);
        assert.equal(h.state.stats.played, 0);
      }
    }
  });

  test('a recycled attached native row is never clicked, including recycling across the pre-click await', async () => {
    for (const afterWait of [false, true]) {
      const h = createNativeFallbackHarness();
      if (afterWait) h.onWait = async () => { h.rowLink = 'https://soundcloud.com/other/track'; };
      else h.rowLink = 'https://soundcloud.com/other/track';
      assert.equal(await h.play(0), false);
      assert.equal(h.button.clickCalls, 0);
      assert.equal(h.state.stats.played, 0);
      assert.equal(h.nativePlaybackAllowed(), false);
    }
  });

  test('an exact native badge without transport or active audio is not a playback acknowledgement', async () => {
    for (const audioPresent of [false, true]) {
      const h = createNativeFallbackHarness();
      h.transportPresent = false;
      h.audioPresent = audioPresent;
      h.onWait = async () => {
        h.currentLink = h.wanted;
        h.nativeAudio.paused = true;
      };
      assert.equal(await h.play(0), false);
      assert.equal(h.state.stats.played, 0);
      assert.equal(h.nativePlaybackAllowed(), false);
      assert.equal(h.paused(), true);
    }
  });

  test('authorized active native audio remains pausable after transport removal and cannot resume by direct play', async () => {
    const h = createNativeFallbackHarness();
    h.onWait = async () => { h.currentLink = h.wanted; };
    assert.equal(await h.play(0), true);
    h.transportPresent = false;
    assert.equal(h.paused(), false);
    await h.toggle();
    assert.equal(h.nativeAudio.paused, true);
    assert.equal(h.state._userPaused, true);
    assert.equal(await h.toggle(), false);
    assert.equal(h.state._userPaused, true);
    assert.equal(h.nativePlaybackAllowed(), false);
    assert.equal(h.nativeAudio.playCalls, 0);
  });

  test('client discovery ignores unrelated resources and preserves API and rejected-ID bundle paths', async () => {
    const state = { _clientId: '' };
    const resources = [
      { name: 'https://api.soundcloud.com/tracks?client_id=api-client' },
      { name: 'https://api-v2.soundcloud.com/resolve?client_id=rejected-client' },
      { name: 'https://api-v2.soundcloud.com.evil.example/x?client_id=wrong-client' },
      { name: 'https://other.example/?client_id=unrelated-client' },
      { name: 'https://other.example/?url=https://api.soundcloud.com/?client_id=nested-client' },
    ];
    const bundleId = 'valid_bundle_client_123456';
    const helpers = extractedHelpers(
      ['discoverSoundCloudClientId', 'discoverSoundCloudClientIdFromBundle', 'playbackErrorName'],
      {
        state, URL, DOMException, performance: { getEntriesByType: () => resources },
        document: { scripts: [{ src: 'https://a-v2.sndcdn.com/assets/app.js' }] },
        fetchSoundCloudResource: async () => ({
          ok: true, data: `client_id:"rejected_bundle_123456789";client_id:"${bundleId}"`,
        }),
        recordPlaybackDiagnostic() {},
      },
    );
    const rejected = new Set(['rejected-client', 'rejected_bundle_123456789']);
    assert.equal(helpers.discoverSoundCloudClientId(rejected), 'api-client');
    state._clientId = '';
    resources.splice(0, 2);
    assert.equal(helpers.discoverSoundCloudClientId(rejected), '');
    assert.equal(state._clientId, '');
    assert.equal(await helpers.discoverSoundCloudClientIdFromBundle(rejected), bundleId);
    assert.equal(state._clientId, bundleId);
  });
}

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
