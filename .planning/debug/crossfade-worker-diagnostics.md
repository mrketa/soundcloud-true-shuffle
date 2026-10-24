---
status: resolved
trigger: "Add background-safe crossfade recovery and a visible persistent diagnostic report after repeated Firefox mixing stalls."
created: 2026-07-22
updated: 2026-07-22
---

## Symptoms

- expected: Firefox crossfades complete or recover even when page timers and the AudioContext are throttled.
- actual: Playback has repeatedly stopped around queue tracks 7-8 with the hub stuck on `mixing`, outgoing time at `-0:00`, and the transport showing paused.
- errors: Firefox reports `DOMException: AudioParam.setValueAtTime: Can't add events during a curve event` from `syncCrossfadeVolume()` while `animateDeckCrossfade()` is active.
- timeline: Reproduced twice with the v6.1.2 beta after page-timer and native transport fixes.
- reproduction: Firefox, 12-second crossfade, long queue; allow 7-8 tracks to transition.

## Current Focus

- hypothesis: Firefox rejects direct AudioParam writes while `setValueCurveAtTime()` is active, rejecting the crossfade promise before cleanup can clear `mixing`.
- test: Replace curve events with audio-clock linear ramp segments and verify every immediate gain reset clears automation from time zero first.
- expecting: No `setValueCurveAtTime()` remains and Firefox-safe cleanup cannot insert an event into an active curve.
- next_action: rebuild the beta and run syntax, crossfade, Firefox fallback, and shuffle regression suites

## Evidence

- timestamp: 2026-07-22
  observation: Two screenshots show the same terminal state on consecutive queue positions: `mixing`, paused transport, and outgoing time at `-0:00`.
  implication: The failure is deterministic enough to require a transition-state-machine recovery rather than another endpoint heuristic.

- timestamp: 2026-07-22
  observation: Firefox DevTools captured the exact uncaught promise rejection: `AudioParam.setValueAtTime: Can't add events during a curve event`, originating in `syncCrossfadeVolume()` during `animateDeckCrossfade()`.
  implication: The active `setValueCurveAtTime()` automation event is the confirmed stall trigger; the earlier liveness recovery treated the consequence, not the throwing operation.

## Eliminated

- hypothesis: The native SoundCloud transport is the only cause.
  evidence: Native transport clicking was removed, but the crossfade still stalls in the same UI state.

## Resolution

- root_cause: Crossfades used `setValueCurveAtTime()`. During or immediately after that scheduled curve, `syncCrossfadeVolume()` and recovery paths called `cancelScheduledValues(now)` followed by `setValueAtTime()`. Firefox does not allow inserting that event during an active curve, so it rejected the async transition and left the state machine stuck on `mixing`.
- fix: Removed curve events entirely and schedule the same sampled crossfade shape as audio-clock `linearRampToValueAtTime()` segments. Added `setAudioParamImmediately()` to clear the complete automation timeline before all direct gain resets. Existing Worker liveness recovery and diagnostics remain as secondary safeguards.
- verification: `node --check` passes for source and both artifacts. Firefox fallback, crossfade, and full True Shuffle regression suites all pass, including the exact active-curve cleanup failure. Both build outputs are byte-identical to the canonical source (SHA-256 `3E841CF60FBBED0DA5C5D30B20CE61ADF85B8452656561F43F12538A83F446F4`), `git diff --check` passes, and no executable `setValueCurveAtTime()` call remains.
- files_changed: `SC Trueshuffle.js`, `tests/crossfade-prototype.test.js`, `dist/SC Trueshuffle.user.js`, `dist/SC-Trueshuffle-v6.1.2-beta.1.user.js`, this debug record.
