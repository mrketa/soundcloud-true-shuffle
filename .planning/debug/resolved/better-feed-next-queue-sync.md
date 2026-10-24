---
status: resolved
trigger: "wenn ich im better soundcloud feed auf weiter drücke steht bei uns im hub not in queue obwohl der song der in der queue ist gespielt wird"
created: 2026-07-20
updated: 2026-07-20
---

## Symptoms

- Expected: Better SoundCloud Feed PiP Next advances through the True Shuffle queue and the hub shows the matching queue position.
- Actual: The queued song plays, but the hub shows `not in queue`.
- Errors: None reported.
- Timeline: Appeared after adding the Better SoundCloud Feed PiP compatibility bridge.
- Reproduction: Start True Shuffle, open Better SoundCloud Feed PiP, press Next.

## Current Focus

- hypothesis: Confirmed — PiP `scPlayer.playNext` bypasses the hub's manual-transition guard, so the watcher treats the resulting title change as external playback and suspends queue tracking.
- test: Require PiP Next to set `state.manualAction` and `_manualActionAt` before calling `next()`.
- expecting: The regression test is red before the fix and green after the bridge mirrors the hub's guard setup.
- next_action: Resolved and verified; no further action required.

## Evidence

- timestamp: 2026-07-20T00:00:00+02:00
  observed: The hub Next handler sets `state.manualAction = true` and `_manualActionAt = Date.now()` before `next()`, while PiP `playNext` calls `next()` directly.
  implication: PiP navigation is missing the state synchronization used to distinguish an intentional queue transition from external playback.
- timestamp: 2026-07-20T00:00:01+02:00
  observed: The watcher sets `state.suspended = true` after a stable title change when `state.manualAction` is false; `updateHub()` renders `↩ not in queue` whenever suspended.
  implication: The missing PiP guard directly explains the reported persistent label even though the queued custom-deck track is playing.
- timestamp: 2026-07-20T00:00:02+02:00
  observed: The new PiP bridge regression assertion fails with `false !== true` for `state.manualAction` immediately after `player.playNext()`.
  implication: TDD RED confirms the fix boundary before production code changes.
- timestamp: 2026-07-20T05:20:55+02:00
  observed: PiP `playNext` now sets `state.manualAction = true` and `_manualActionAt = Date.now()` before calling `next()`; all 32 regression tests and `node --check "SC Trueshuffle.js"` pass.
  implication: The bridge now follows the same intentional-transition path as the hub, preventing the watcher from suspending queue tracking.

## Eliminated

## Resolution

- root_cause: Better SoundCloud Feed PiP called `next()` without the hub's manual-transition guard, so the watcher misclassified the queued title change as external playback and set `state.suspended`, which rendered `not in queue`.
- fix: Set `state.manualAction` and `_manualActionAt` in the PiP `playNext` wrapper before advancing, matching the hub Next handler.
- verification: TDD RED reproduced the missing guard; after the fix all 32 tests in `tests/true-shuffle.test.js` passed and `node --check "SC Trueshuffle.js"` exited 0.
- files_changed: `SC Trueshuffle.js`, `tests/true-shuffle.test.js`, `.planning/debug/resolved/better-feed-next-queue-sync.md`; `dist` untouched.
