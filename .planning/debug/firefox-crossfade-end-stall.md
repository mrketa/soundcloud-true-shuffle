---
status: resolved
trigger: "Firefox: a song reaches -0:00 and stops while the hub remains stuck on crossfade mixing."
created: 2026-07-22
updated: 2026-07-22
---

## Symptoms

- expected: A crossfade always completes into the incoming queue track, including in Firefox/background playback.
- actual: The outgoing song reaches its endpoint, playback stops, the play icon appears, and Crossfade remains on `mixing`.
- errors: No console error supplied.
- reproduction: Firefox, 12-second crossfade, allow several queue transitions; observed at track 7/119 with outgoing time at -0:00.

## Current Focus

- hypothesis: `waitForCrossfadeSchedule()` has no liveness timeout when Firefox's AudioContext clock stops, and `animateDeckCrossfade()` leaves `_crossfading`/schedule state dirty when completion fails.
- test: Require a bounded clock-stall timeout and deterministic hard handoff to the already-started incoming deck while preserving user-initiated pause.
- expecting: Current implementation can wait forever because only AudioContext currentTime can resolve the promise.
- next_action: add regression contracts, implement timeout and hard-settle recovery, run all suites

## Evidence

- timestamp: 2026-07-22
  observation: Screenshot shows outgoing media at -0:00, transport paused, and crossfade status still `mixing`.
  implication: The transition entered `animateDeckCrossfade()` but never reached its cleanup/status-ready block.
- timestamp: 2026-07-22
  observation: `waitForCrossfadeSchedule()` polls only `AudioContext.currentTime` and token identity, with no wall-clock or media-clock liveness condition.
  implication: A suspended/stuck Firefox AudioContext leaves `next()` busy forever.

## Eliminated

- hypothesis: Normal stream-stall watchdog advances this state.
  evidence: The watcher returns immediately while `state.busy` is true, so the deck-stall watchdog cannot recover a crossfade promise that never resolves.

## Resolution

- root_cause: Firefox could stop advancing `AudioContext.currentTime` during a scheduled fade. `waitForCrossfadeSchedule()` had no liveness deadline, while `next()` kept `state.busy` true, preventing the ordinary deck-stall watchdog from running. The promise and `mixing` state therefore remained stuck indefinitely.
- fix: Track AudioContext clock liveness during a fade. After 2.5 seconds without clock progress, record a diagnostic and hard-settle onto the already-started incoming deck at full gain. User-initiated pause is tracked separately and never triggers this timeout. All completion, cancellation, stop, and recovery paths clear the pause/mixing state.
- verification: Added executable coverage proving a frozen Firefox audio clock resolves false while an intentional paused fade waits and resumes normally. All Firefox, crossfade, and True Shuffle suites pass; source and both dist artifacts pass syntax/hash checks; `git diff --check` passes.
- files_changed: `SC Trueshuffle.js`, `tests/crossfade-prototype.test.js`, `dist/SC Trueshuffle.user.js`, `dist/SC-Trueshuffle-v6.1.2-beta.1.user.js`, this debug record.
