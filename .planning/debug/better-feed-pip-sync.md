---
status: resolved
trigger: "Fix Better SoundCloud Feed Picture-in-Picture so it displays the track currently played by True Shuffle v6, then smoke-test it in Chrome."
created: 2026-07-20
updated: 2026-07-20
---

## Symptoms

- expected: Better SoundCloud Feed PiP displays the current True Shuffle track, artwork, playback position and play state.
- actual: PiP displays stale or incorrect SoundCloud native-player information while True Shuffle's custom deck is audible.
- errors: No reported console error.
- timeline: Began with v6.0.0 when the custom two-deck engine became the primary playback path.
- reproduction: Enable Better SoundCloud Feed, start True Shuffle v6, open its PiP and change tracks through True Shuffle.

## Current Focus

- hypothesis: confirmed — Better SoundCloud Feed polls SoundCloud's internal scPlayer, which True Shuffle's custom deck playback did not update.
- test: Added regression harnesses for PiP metadata/timing, controls, native delegation and asynchronous scPlayer discovery.
- expecting: complete — Better SoundCloud Feed receives the active True Shuffle deck while native SoundCloud behavior remains unchanged outside custom-deck playback.
- next_action: Main agent performs the deferred Chrome PiP smoke test after loading the patched userscript.
- reasoning_checkpoint: A scoped scPlayer adapter avoids duplicate native audio and preserves True Shuffle queue ownership.
- tdd_checkpoint: RED confirmed before implementation; all regression suites are GREEN after the fix.

## Evidence

- timestamp: 2026-07-20T01:15:00+02:00
  observation: Better SoundCloud Feed's src/injected/pip/poll.ts reads all PiP track and playback state from window.scPlayer.
  implication: Updating Media Session metadata alone will not fix this extension.
- timestamp: 2026-07-20T01:16:00+02:00
  observation: True Shuffle v6 uses hidden custom audio decks as the primary playback source and pauses SoundCloud playback.
  implication: Native SoundCloud state is intentionally stale during normal v6 playback.
- timestamp: 2026-07-20T03:00:00+02:00
  observation: Better SoundCloud Feed also routes PiP play/pause, previous/next and seek actions through window.scPlayer.
  implication: Compatibility requires a scoped control adapter in addition to metadata and timing projection.
- timestamp: 2026-07-20T03:08:00+02:00
  observation: The new TDD regression failed because betterFeedPipActive did not exist.
  implication: The test reproduced the missing compatibility seam before implementation.
- timestamp: 2026-07-20T03:18:00+02:00
  observation: The final adapter tests, full True Shuffle regression suite, crossfade prototype suite and node syntax check all pass.
  implication: PiP synchronization is implemented without regressions in playback, shuffle, crossfade, EQ, Auto Level, volume or fallback contracts.

## Eliminated

- hypothesis: The PiP reads navigator.mediaSession metadata only.
  reason: Source inspection shows direct scPlayer polling for track, position, duration and playing state.

## Resolution

- root_cause: Better SoundCloud Feed exclusively polled and controlled SoundCloud's page-level scPlayer, while True Shuffle v6's audible state lived in private two-deck HTMLAudioElements, leaving PiP metadata, timing and play state stale.
- fix: Added a scoped scPlayer compatibility adapter that projects the active deck's metadata and millisecond timing, routes PiP controls to True Shuffle, retries asynchronous scPlayer discovery, and delegates every method back to SoundCloud whenever custom-deck playback is inactive.
- verification: RED-before-fix TDD checkpoint; node --check passed; tests/true-shuffle.test.js passed; tests/crossfade-prototype.test.js passed. Chrome PiP smoke testing intentionally deferred to the main agent per user request.
- files_changed: SC Trueshuffle.js; tests/true-shuffle.test.js; .planning/debug/better-feed-pip-sync.md
