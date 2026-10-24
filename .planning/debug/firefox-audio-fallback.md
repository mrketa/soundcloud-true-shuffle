---
status: resolved
trigger: "Firefox only: Auto Volume off still reduces volume; after a few songs playback stops and an ad/native audio may be heard; waveforms are sometimes incorrect and reuse an existing fallback."
created: 2026-07-22
updated: 2026-07-22T04:02:00+02:00
---

## Symptoms

- expected: With Auto Level disabled, True Shuffle must not alter per-song loudness beyond the explicit master-volume setting.
- actual: On Firefox, playback still becomes quieter with Auto Level disabled.
- expected: Custom playback and crossfade continue reliably through long queues without invoking SoundCloud native playback or ads.
- actual: After several songs, playback stops and SoundCloud/native advertisement audio may be heard.
- expected: Every track displays its own waveform, or a clearly neutral placeholder when unavailable.
- actual: Waveforms are sometimes wrong and appear to reuse a previously available waveform/fallback.
- errors: No console error supplied yet; playback diagnostics are available in the beta build.
- timeline: Regression in the current v6.1.2 beta playback architecture; reported as Firefox-specific and previously not present.
- reproduction: Run True Shuffle in Firefox for several songs, with Auto Level off and crossfade enabled; observe volume, playback continuity, native audio, and waveform identity.

## Current Focus

- hypothesis: Confirmed: three independent ownership leaks caused the Firefox symptoms: custom playback imported native media volume, native fallback permission never expired, and waveform hydration accepted non-unique title matches.
- test: Focused behavioral contracts plus syntax, crossfade/Chromium, full True Shuffle, build, artifact hash, and diff-scope verification all pass.
- expecting: Resolved.
- next_action: None; debug session complete.
- reasoning_checkpoint:
- tdd_checkpoint:
  test_file: tests/firefox-audio-fallback.test.js
  test_name: custom deck playback never imports a Firefox native-media volume fallback; native playback fallback permission expires and is limited to its requested track; waveform hydration requires exact track identity and never reuses a title match
  failure_output: "3 Firefox audio fallback regression test(s) failed: missing currentDeckAudio guard; native fallback has no expiresAt; hydration resolver retains titleMatch/candidateTitle/candidateArtist."

## Evidence

- timestamp: 2026-07-22T03:46:00+02:00
  observation: First GREEN run passed deck-volume isolation and exact-waveform behavior. The native fallback test stopped only on an overly specific source regex expecting `state._nativePlaybackFallback.expiresAt`; the implementation snapshots that object as `fallback`, and the behavioral expiry/track-scope assertions had not yet executed.
  implication: Relax the syntax-only assertion to accept the local snapshot, while retaining executable checks for valid scope, wrong-track revocation, and expiry revocation.
- timestamp: 2026-07-22T03:49:00+02:00
  observation: Focused Firefox suite and userscript syntax check passed. The crossfade baseline reached its saved-volume harness and failed because the isolated Function harness did not inject the newly required `currentDeckAudio` dependency.
  implication: Update that existing harness to model native mode with `currentDeckAudio() === null`; this preserves and continues to verify Chromium/native volume synchronization when no custom deck owns playback.
- timestamp: 2026-07-22T03:53:00+02:00
  observation: Focused, syntax, and full crossfade suites passed. The full True Shuffle suite then reached its native-guard harness, whose legacy fallback fixture omitted the newly required queue position and expiry.
  implication: Extend the fixture with current track 7 and a live expiry so the existing test continues to prove that legitimate native fallback is allowed, while the focused suite proves wrong-track and expired permissions are revoked.
- timestamp: 2026-07-22T03:14:12+02:00
  observation: Baseline suites pass: `node tests/crossfade-prototype.test.js` and `node tests/true-shuffle.test.js` both completed with all tests green before new regression coverage.
  implication: The new tests must preserve the established Chromium behavior and isolate missing Firefox contracts.
- timestamp: 2026-07-22T03:14:12+02:00
  observation: `startWatcher()` calls `syncPlaybackVolumeFromSoundCloud()` every sixth 50 ms tick even while `currentDeckAudio()` is active. `soundCloudVolume()` can fall back to the first non-deck native audio element and the sync overwrites `state.playbackVolume`.
  implication: Firefox native/ad element volume can reduce the explicit custom-deck master independently of Auto Level.
- timestamp: 2026-07-22T03:14:12+02:00
  observation: `beginNativePlaybackFallback()` stores only `{ trackIndex }`, while `nativePlaybackFallbackActive()` returns Boolean state with no expiry or requested-track validation. Both capture listeners bypass the native playback guard whenever it is truthy.
  implication: A failed custom attempt can leave native/ad playback globally permitted beyond the intended fallback attempt.
- timestamp: 2026-07-22T03:14:12+02:00
  observation: `hydrationWaveformUrl()` returns an exact permalink match when available but otherwise retains and returns a title/artist-only `titleMatch`; titles and display artists are not unique stable track identity.
  implication: A different hydrated track can supply a plausible but wrong cached waveform instead of the neutral placeholder.
- timestamp: 2026-07-22T03:14:12+02:00
  observation: `node tests/firefox-audio-fallback.test.js` exited 1. All three focused tests failed: `syncPlaybackVolumeFromSoundCloud()` lacks a custom-deck guard; `beginNativePlaybackFallback()` lacks `expiresAt`; and `hydrationWaveformUrl()` contains `titleMatch`, `candidateTitle`, and `candidateArtist`.
  implication: RED checkpoint reached against the current implementation. No production fixes or beta artifact rebuild were performed.

## Eliminated

- hypothesis: Auto Level processing itself reduces gain while disabled.
  evidence: `processAutoLevel()` returns immediately when disabled, and `syncCrossfadeVolume()` explicitly targets unity on each graph's `autoGain` when `state.autoLevel` is false.
- hypothesis: The current optional safety clipper causes the disabled-Auto-Level reduction.
  evidence: The current dirty source routes the master directly to `AudioContext.destination` unless the separately persisted `safetyClipper` setting is true; it is false by default.

## Resolution

- root_cause: Custom-deck playback continued polling Firefox native/ad media volume; native playback fallback was a global unbounded Boolean permission; hydration waveform lookup fell back to non-unique title/artist identity.
- fix: Stop native volume imports while a custom deck owns playback; bind native fallback to the current queue index with a 3-second expiry and revoke invalid permission; accept hydration waveforms only from an exact normalized permalink match, then resolve missing Firefox waveform metadata through SoundCloud's API using the exact track permalink.
- verification: `node --test tests/firefox-audio-fallback.test.js tests/crossfade-prototype.test.js tests/true-shuffle.test.js`, `node --check SC Trueshuffle.js`, both build commands, and `git diff --check` all pass. The focused suite includes four Firefox regressions, including exact API waveform recovery when hydration is missing.
- files_changed: `SC Trueshuffle.js`; `tests/firefox-audio-fallback.test.js`; focused harness updates in `tests/crossfade-prototype.test.js` and `tests/true-shuffle.test.js`; rebuilt `dist/SC Trueshuffle.user.js` and `dist/SC-Trueshuffle-v6.1.2-beta.1.user.js`; this debug record. Pre-existing unrelated dirty-worktree changes were preserved.
