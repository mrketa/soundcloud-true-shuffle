---
status: resolved
trigger: "Better SoundCloud Feed PiP shows a stale current position while the True Shuffle hub shows the correct current time."
created: 2026-07-20
updated: 2026-07-20
---

## Symptoms

- expected: PiP current time and waveform progress remain synchronized with the True Shuffle hub throughout playback.
- actual: PiP showed 1:31 while the True Shuffle hub showed 1:49 for the same 3:01 track.
- errors: No visible error was reported.
- timeline: Reproduced immediately after adding the Better SoundCloud Feed scPlayer compatibility bridge.
- reproduction: Start True Shuffle, open Better SoundCloud Feed PiP, let the track continue, then compare its current time against the hub.

## Current Focus

- hypothesis: confirmed — Better Feed's timestamp polling remains live, but its canvas waveform does not reliably repaint and can become blank after reopening PiP.
- test: Live Brave PiP playback sample plus a fake PiP document/canvas regression driven by the True Shuffle deck clock.
- expecting: PiP labels and waveform are redrawn from the same background-safe timing and cached waveform data as the hub.
- next_action: User installs the patched userscript and verifies the orange waveform follows the hub.
- reasoning_checkpoint: The live PiP timestamp advanced from 2:03 to 2:15 during a ten-second playback sample while the canvas stayed blank, disproving stale bridge timing.
- tdd_checkpoint: green

## Evidence

- timestamp: 2026-07-20T03:40:00+02:00
  observation: User screenshots show the same track and total duration in both UIs, but PiP is 18 seconds behind.
  implication: The bridge is selected correctly but current position is stale.
- timestamp: 2026-07-20T04:15:00+02:00
  observation: Better SoundCloud Feed's createPipPoller calls window.scPlayer.getCurrentSound() and the returned sound.player.getPosition() on every 250 ms poll.
  implication: A cached synthetic sound object is not the cause; the producer must be returning or exposing a stale player method/value later in the lifecycle.
- timestamp: 2026-07-20T04:17:00+02:00
  observation: installBetterFeedPipBridge returns immediately whenever state._pipBridgePlayer is the same object, without verifying that its getCurrentSound wrapper is still installed.
  implication: In-place method replacement on the stable SoundCloud player object permanently bypasses the bridge despite the watcher's retry calls.
- timestamp: 2026-07-20T04:22:00+02:00
  observation: The new same-object replacement regression failed with actual 10000 ms versus expected 41000 ms after the bridge retry.
  implication: The bug is reproducible without changing production code, and the identity-only fast path is causally responsible.
- timestamp: 2026-07-20T04:28:00+02:00
  observation: In the actual Brave PiP, play/pause controlled True Shuffle and the timestamp advanced from 2:03 to 2:15, while the waveform canvas remained blank.
  implication: The live timing bridge works; the visible defect is Better Feed's unreliable canvas repaint.

## Eliminated

- Better Feed caches the first synthetic sound and never polls it again: eliminated by its createPipPoller implementation, which reacquires the sound and position every 250 ms.
- The scPlayer wrapper is being replaced in place: eliminated by live evidence because the PiP retained synthetic metadata and its position continued to advance.

## Resolution

- root_cause: Better SoundCloud Feed's PiP waveform canvas can stop repainting while its independently polled timestamp continues to advance, leaving a stale or blank visual position.
- fix: Added a safe Better Feed PiP visual synchronizer that redraws the canvas and both time labels every 300 ms from True Shuffle's background-safe deck clock and existing waveform cache. It no-ops when Better Feed or PiP is absent.
- verification: Live Brave PiP diagnosis; new canvas/time regression; full True Shuffle and audio regression suites; syntax checks; main and dist hashes match.
- files_changed: SC Trueshuffle.js; dist/SC Trueshuffle.user.js; tests/true-shuffle.test.js
