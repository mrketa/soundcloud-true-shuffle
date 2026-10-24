---
status: resolved
trigger: "jetzt funktioniert der shuffle nicht mehr. aber bei einem knapp 10 min track hat es nicht frühzeitig beendet oder so aber halt auch nicht geshuffled"
created: 2026-07-19
updated: 2026-07-19
---

# Symptoms

- Expected: After a track reaches its real end, True Shuffle starts the next queued track.
- Actual: A roughly ten-minute track reaches its end without being cut short, but no shuffled successor starts.
- Errors: No browser error was reported.
- Timeline: Regression began after replacing the former 99% watcher trigger with native media-ended handling.
- Reproduction: Start True Shuffle on the user's SoundCloud playlist and let a track finish naturally.

# Current Focus

- hypothesis: Live evidence supersedes the prior hypothesis: SoundCloud exposes no audio element and its timeline text includes accessibility prose before the trailing timestamp, so `parseTimeText` returns zero for both current time and duration.
- test: Parse the exact live values `Current time: 45 seconds0:45` and `Duration: 3 minutes 22 seconds3:22`, then exercise the watcher fallback with DOM timing.
- expecting: Extracting the trailing timestamp restores non-zero progress, near-end title-change handling, and exact parked-end detection.
- next_action: reload the userscript in SoundCloud and confirm the next natural track end advances live
- reasoning_checkpoint:
- tdd_checkpoint: RED — `a finished track parked at its endpoint advances without an ended signal` fails with 0 next calls instead of 1.

# Evidence

- timestamp: 2026-07-19T00:00:01+02:00
  checked: `startWatcher` natural-end branches
  found: Advancement requires a captured `ended` event, `timing.ended === true`, or a debounced title change after the prior timing was near the end.
  implication: A finished track whose title remains unchanged and whose exposed `ended` flag remains false has no transition path.

- timestamp: 2026-07-19T00:00:02+02:00
  checked: Regression harness with `current: 2000`, `duration: 2000`, `ended: false`, paused playback, and unchanged title
  found: New test fails with `0 !== 1` after two watcher ticks.
  implication: The reported parked-at-end state is reproduced deterministically and the TDD gate is red.

- timestamp: 2026-07-19T00:00:03+02:00
  checked: Debounced parked-end fallback and full Node regression suite
  found: Exact paused endpoint advances after two ticks; a paused track 100 ms before the endpoint does not; all 13 regression tests pass and `node --check` succeeds.
  implication: The missing transition path is restored without returning to percentage-based early advancement.

- timestamp: 2026-07-19T16:00:00+02:00
  checked: Live SoundCloud player state in the user's Chrome tab after the first fix failed
  found: There are zero `audio` elements. Timeline text is `Current time: 45 seconds0:45` and `Duration: 3 minutes 22 seconds3:22`; the current parser returns zero for both. The hub is active but suspended as `not in queue`.
  implication: Every watcher end path receives duration zero, so neither native timing nor parked-end detection can run. The first fix addressed a simulated state that SoundCloud never supplied.

- timestamp: 2026-07-19T16:30:00+02:00
  checked: Exact live timeline parser regressions, hour-form accessibility text, full Node regression suite, and userscript syntax
  found: The new regression failed red with `0 !== 45`; after extracting only the trailing timestamp, all 14 regression cases pass and `node --check SC Trueshuffle.js` succeeds.
  implication: DOM timing now receives the non-zero current time and duration required by the existing natural-end fallbacks, while plain timestamps and malformed-value behavior remain covered.

# Eliminated

- A return to the old 99% trigger: it would again end long tracks early (about six seconds early on a ten-minute track).
- Queue exhaustion as the immediate cause: the watcher does not invoke `next` at all in the reproduced state.

# Resolution

- root_cause: SoundCloud exposes no audio element and prefixes its DOM timeline timestamps with accessibility prose, causing `parseTimeText` to return zero and disabling every watcher end path.
- fix: Extract the trailing `m:ss` or `h:mm:ss` timestamp before converting it to seconds, with exact live-string regression coverage.
- verification: TDD red confirmed at `0 !== 45`; all 14 True Shuffle regressions pass and `node --check SC Trueshuffle.js` succeeds.
- files_changed: `SC Trueshuffle.js`, `tests/true-shuffle.test.js`, `.planning/debug/shuffle-not-advancing.md`
