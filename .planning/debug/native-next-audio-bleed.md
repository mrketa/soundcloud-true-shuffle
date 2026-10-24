---
status: resolved
trigger: "SoundCloud's own next track is briefly audible before True Shuffle switches to its queued track"
created: 2026-07-19
updated: 2026-07-19
---

# Symptoms

- Expected: At natural track end, only the next True Shuffle queue item becomes audible.
- Actual: SoundCloud auto-starts its native next track briefly, then True Shuffle replaces it with the shuffled track.
- Errors: No browser error was reported.
- Timeline: End detection now works after fixing SoundCloud's accessibility-rich timeline parser.
- Reproduction: Let a shuffled track finish naturally on the user's SoundCloud playlist.

# Current Focus

- hypothesis: The 300 ms watcher plus two-tick title debounce lets SoundCloud's native successor play audibly before the script reacts.
- test: Simulate a near-end title change and assert that native playback is paused on the first changed-title tick before queue advancement.
- expecting: Current code waits two ticks and never calls pause in the title-change branch.
- next_action: complete
- reasoning_checkpoint: Minimal first-title-change interception fixed the bleed without changing full-duration end detection; adaptive polling was intentionally omitted as unnecessary risk.
- tdd_checkpoint: RED confirmed pauseCalls was 0 on the first near-end changed-title tick; GREEN confirmed pause occurs before next and unrelated title changes remain unpaused.

# Evidence

- timestamp: 2026-07-19T16:10:00+02:00
  checked: Current worker and title-change watcher
  found: Worker polls every 300 ms. A changed title is debounced for two ticks, and the natural-end title branch calls `next(true)` without first pausing SoundCloud's native successor.
  implication: Native audio may be audible for roughly 300-600 ms before replacement.

- timestamp: 2026-07-19T18:11:41+02:00
  checked: TDD regression and minimal interception fix
  found: The RED test observed zero pauses on the first near-end title-change tick. After the fix, the watcher pauses on that first tick, waits for the existing second-tick confirmation before advancing, and does not pause unrelated away-from-end title changes.
  implication: SoundCloud's native successor is muted before True Shuffle changes to its queued track, without percentage-based early skipping.

# Eliminated

- Reintroducing a 99% early-next threshold: it would recreate the original long-track truncation bug.

# Resolution

- root_cause: The 300 ms watcher and two-tick title debounce allowed SoundCloud's native successor to play for up to roughly 600 ms before queue advancement.
- fix: Poll playback state every 50 ms, keep visual updates throttled to every sixth tick, and pause a near-end native successor on the first title-change tick immediately before `next(true)`.
- verification: Regression tests assert `pause` occurs before `next` on the first title-change tick, unrelated external title changes are not paused, and no percentage-based early transition exists.
- files_changed: SC Trueshuffle.js; tests/true-shuffle.test.js; .planning/debug/native-next-audio-bleed.md
