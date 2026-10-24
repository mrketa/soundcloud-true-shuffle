---
status: resolved
trigger: "Web Audio master DynamicsCompressor causes audible pumping; custom deck audio can stall before queue end without ending or advancing."
created: 2026-07-21
updated: 2026-07-21
---

## Symptoms

- expected: Transparent clipping protection preserves EQ and crossfade safety without audible pumping; stalled custom-deck playback safely recovers or advances.
- actual: Master DynamicsCompressor pumps audibly; a custom deck can remain unpaused and unended while currentTime stops, preventing natural-end queue advancement.
- errors: No explicit error reported.
- timeline: Current implementation.
- reproduction: Use auto-level audio graph and custom deck playback; observe compressor pumping and a stalled media element whose currentTime no longer progresses before queue end.

## Current Focus

- hypothesis: The beta watchdog only recognizes frozen decoder clocks with buffered audio; a depleted or failed SoundCloud progressive stream is excluded and can hang indefinitely, including during a crossfade.
- test: Reproduce buffered and unbuffered freezes in isolated watcher tests, then verify same-track stream refresh resumes near the saved timestamp before any queue advance.
- expecting: Decoder and network stalls recover independently, crossfade state is safely cancelled or rebuilt, and advancing occurs only after bounded recovery attempts fail.
- next_action: Investigate and implement refresh-at-position recovery; make clipping optional and off by default.

## Evidence

- timestamp: 2026-07-21T00:00:00+02:00
  observation: ensureAutoLevelAudioGraph used a -2 dB, 20:1 DynamicsCompressor with 3 ms attack and 250 ms release.
  implication: Normal program peaks drove envelope-based gain reduction and audible release pumping.
- timestamp: 2026-07-21T00:01:00+02:00
  observation: startWatcher only handled ended, parked endpoints, crossfade timing, and title changes.
  implication: An unpaused custom deck with frozen currentTime could remain stuck indefinitely.
- timestamp: 2026-07-21T00:02:00+02:00
  observation: Baseline suites passed before changes; focused regressions and all source/dist checks passed after implementation.
  implication: Fixes are covered without regressing existing behavior.
- timestamp: 2026-07-21T14:00:00+02:00
  observation: External long-queue beta test stalled consistently after 5-6 tracks, around minute 3 of a track; the tester also observed a stall during crossfade in a separate modified build.
  implication: The existing buffered-only watchdog does not cover the real production failure and the prior resolution is disproven.
- timestamp: 2026-07-21T15:00:00+02:00
  observation: Focused RED tests proved the implementation had no forced stream refresh, excluded depleted buffers, and exposed no optional clipping control.
  implication: Recovery needed to reacquire authorization and media URL rather than nudge the existing element source.
- timestamp: 2026-07-21T15:20:00+02:00
  observation: Same-track recovery now invalidates the stream cache, resolves a fresh progressive URL, cancels crossfade automation, reloads the active deck, seeks near the saved position, and retries playback without blocking watcher ticks.
  implication: Buffered decoder freezes and unbuffered/network stalls share a bounded recovery path while preserving queue position.
- timestamp: 2026-07-21T15:30:00+02:00
  observation: Source and rebuilt dist passed syntax plus both complete suites; source and dist SHA-256 were E585B8B1FA7DEA0724BEAC311FB402A18E634DCE7E5438215C0C2F7934B03313; git diff --check passed.
  implication: The canonical and distributable userscripts are identical and all focused/full regressions are green.

## Eliminated


## Resolution

- root_cause: The stall watchdog only admitted buffered decoder freezes and replayed the same expiring media source, so depleted or failed progressive streams could hang indefinitely; the always-on master processor also applied clipping even when the user did not request it.
- fix: Added bounded same-track recovery that force-resolves a fresh authorized progressive URL and resumes near the saved timestamp for buffered and network stalls, safely cancels crossfade automation around recovery, and made the safety clipper persisted, accessible, optional, and off by default.
- verification: Focused tests were written RED first; source and rebuilt dist passed syntax and both complete suites; source and dist SHA-256 matched at E585B8B1FA7DEA0724BEAC311FB402A18E634DCE7E5438215C0C2F7934B03313; git diff --check passed.
- files_changed: SC Trueshuffle.js, dist/SC Trueshuffle.user.js, tests/crossfade-prototype.test.js, tests/true-shuffle.test.js
