---
status: awaiting_human_verify
trigger: "Die Queue-Anzeige ist durcheinander, wenn ein Track übersprungen und anschließend wieder zurückgegangen wird."
created: 2026-07-24
updated: 2026-07-24
---

## Symptoms

- Expected: Nach Weiter und anschließend Zurück zeigt die Queue wieder den tatsächlich laufenden Track an der richtigen Position; Historie und kommende Tracks bleiben in derselben nachvollziehbaren Reihenfolge.
- Actual: Playback wechselt, aber die sichtbare Queue-Reihenfolge bzw. Positionsanzeige ist danach durcheinander.
- Errors: Keine gemeldet.
- Timeline: Nach dem Firefox-Crossfade-Fix beobachtet; Playback und Crossfade funktionieren ansonsten.
- Reproduction: Shuffle starten, einen Track mit Weiter überspringen und danach mit Zurück zum vorherigen Track wechseln; Queue-Panel beobachten.

## Current Focus

- hypothesis: `prevTrack()` stellt den vorherigen Track aus `history` wieder her, ohne `state.pos`, `state.queue` und/oder `state.playNext` in dieselbe kanonische Reihenfolge zurückzuführen, während das Queue-Rendering aus einem anderen dieser Zustände liest.
- test: Zustandsübergänge von `next()`, `prevTrack()`, `playAt()`, History-Schreiben und Queue-Rendering vergleichen und den Ablauf in einem Regressionstest simulieren.
- expecting: Der Test reproduziert eine Abweichung zwischen aktivem Track, Queue-Position und sichtbarer Upcoming-Reihenfolge.
- next_action: Install either rebuilt Tampermonkey artifact and confirm that Next followed by Back restores the visible queue position and order during live SoundCloud playback.
- reasoning_checkpoint:
    hypothesis: "`prevTrack()` leaves the visible round position one ahead because it reverses the queue/history mutation performed by forward consumption without reversing that transition's `state.roundPlayed` increment."
    confirming_evidence:
      - "After `consumeCurrentQueueTrack()`, the regression observes queue `[1, 2]`, history `[0]`, and `roundPlayed === 1`."
      - "After `prevTrack()`, the current implementation restores queue `[0, 1, 2]`, current track `0`, and empty history, but the RED test observes `roundPlayed === 1` instead of `0`."
    falsification_test: "The hypothesis is false if decrementing `roundPlayed` when a history track is restored does not make the exact A -> B -> Back regression green, or if it changes queue/history/playback assertions."
    fix_rationale: "A bounded decrement is the exact inverse of the counter increment already performed when the same history entry was consumed, restoring all parts of the transition atomically without changing playback or crossfade behavior."
    blind_spots: "Automated tests cannot reproduce SoundCloud's live DOM, but all queue renderers consume the same counter and the regression directly exercises the production transition functions."
- tdd_checkpoint:
  test_file: tests/true-shuffle.test.js
  test_name: previous restores the queue position after advancing once
  status: green
  failure_output: "AssertionError: 1 !== 0 at tests/true-shuffle.test.js:875"

## Evidence

- timestamp: 2026-07-24
  checked: Project skills, debug knowledge base, git status, and symbol search.
  found: No knowledge base exists. The working tree already contains modified playback/crossfade source, dist, and tests. Queue navigation and rendering are implemented in `SC Trueshuffle.js`; renderers read `state.queue`, `state.pos`, `state.playNext`, `state.history`, and round counters.
  implication: Preserve all existing playback/crossfade work. Investigate a state-management transition mismatch in the monolithic userscript and add only a targeted regression test/fix.

- timestamp: 2026-07-24
  checked: Complete state transitions in `consumeCurrentQueueTrack()`, `next()`, and `prevTrack()`, plus hub/sidebar/PiP position rendering.
  found: Forward navigation removes A, pushes A to history, and increments `roundPlayed`. Back navigation pops A and reinserts it at `state.pos`, restoring `[A, B, C]`, but never decrements `roundPlayed`. Hub, sidebar, and PiP all derive visible positions from `roundPlayed`.
  implication: A deterministic A -> B -> Back transition restores playback order but leaves the displayed position one step ahead. The invalid transition is isolated to the missing reverse counter update.

- timestamp: 2026-07-24
  checked: New regression test `previous restores the queue position after advancing once`.
  found: Before any source fix, all restored-state assertions pass except `roundPlayed`: expected 0, actual 1.
  implication: The bug is reproduced at function level and the root-cause hypothesis is confirmed independently of DOM rendering or crossfade playback.

- timestamp: 2026-07-24
  checked: Minimal TDD GREEN fix and focused regression.
  found: A bounded `state.roundPlayed` decrement in `prevTrack()` makes `previous restores the queue position after advancing once` pass while its queue, current-track, history, and playback assertions remain unchanged; source syntax also passes.
  implication: The fix reverses exactly the missing portion of the forward state transition without modifying playback or crossfade code.

- timestamp: 2026-07-24
  checked: Full source and built-artifact verification.
  found: Firefox fallback, crossfade prototype, and True Shuffle suites pass against source and the rebuilt canonical artifact. Source and both Tampermonkey artifacts pass syntax checks and are byte-identical at SHA-256 `F22E5FDB38B878E85B302CC8C1DB77D123591921B4FDC48BCB2075E62A898234`; `git diff --check` passes with only pre-existing line-ending warnings.
  implication: Queue navigation is green across relevant regressions, the working playback/crossfade implementation remains intact, and both distributable artifacts contain the verified fix.

## Eliminated

## Resolution

- root_cause: `prevTrack()` reverses the queue/history portion of a forward transition but not its `state.roundPlayed` increment, leaving visible round positions one ahead after Back.
- fix: `prevTrack()` now decrements `state.roundPlayed` with a zero lower bound when it restores a track from history.
- verification: The saved RED regression is GREEN; source and built canonical artifact pass Firefox fallback, crossfade prototype, and True Shuffle suites; source plus both artifacts pass syntax checks; all three files share SHA-256 `F22E5FDB38B878E85B302CC8C1DB77D123591921B4FDC48BCB2075E62A898234`; `git diff --check` passes.
- files_changed: `SC Trueshuffle.js`; `tests/true-shuffle.test.js`; `dist/SC Trueshuffle.user.js`; `dist/SC-Trueshuffle-v6.1.2-beta.1.user.js`; this debug record.
