---
status: resolved
trigger: "During a True Shuffle crossfade, the first song from the SoundCloud playlist starts playing in the background."
created: 2026-07-22
updated: 2026-07-22T04:15:00+02:00
---

## Symptoms

- expected: Only the two True Shuffle decks are audible during a crossfade; SoundCloud native playback remains paused.
- actual: The first playlist track begins playing natively behind the crossfade.
- errors: No console error reported.
- timeline: Observed in Firefox after the Firefox audio/fallback beta fixes.
- reproduction: Start shuffle, wait for a crossfade, hear the first playlist song begin behind the custom decks.

## Current Focus

- hypothesis: `pauseSoundCloud()` clicks the native transport before pausing audio; stale Firefox button state turns that safety click into native playback.
- test: Inspect the complete native pause/fallback/PiP call path and run a focused regression proving an already-paused native element never causes a transport click.
- expecting: The current implementation calls `alignSoundCloudPlayButtonPaused()` before direct media pausing, while fallback/PiP relies on direct native audio control rather than unconditional transport toggling.
- next_action: read the complete pause/play ownership functions, build script, and relevant test harnesses; then execute the focused pre-fix regression

## Evidence

- timestamp: 2026-07-22T04:15:00+02:00
  checked: persisted debug state and repository worktree
  found: The source, canonical artifact, beta artifact, and related tests already contain uncommitted user changes.
  implication: The fix must be a minimal in-place delta and must not reset or replace existing work.

## Eliminated

## Resolution

- root_cause: `pauseSoundCloud()` unconditionally called `alignSoundCloudPlayButtonPaused()`. That helper toggled SoundCloud's transport from its stale Firefox UI label before directly pausing native audio. During crossfade startup the toggle could therefore start the native first playlist track asynchronously behind the custom decks.
- fix: Native suppression now only pauses non-True-Shuffle audio elements directly and never clicks SoundCloud's transport. Removed the obsolete pause-sync state/helper and changed the regression contract to require zero transport clicks.
- verification: Canonical and beta artifacts rebuilt. `node --test tests/firefox-audio-fallback.test.js tests/crossfade-prototype.test.js tests/true-shuffle.test.js`, `node --check SC Trueshuffle.js`, and `git diff --check` pass.
- files_changed: `SC Trueshuffle.js`, `tests/true-shuffle.test.js`, `dist/SC Trueshuffle.user.js`, `dist/SC-Trueshuffle-v6.1.2-beta.1.user.js`, this debug record.
