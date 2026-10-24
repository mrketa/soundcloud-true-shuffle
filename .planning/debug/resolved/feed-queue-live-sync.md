---
status: resolved
trigger: "Im selben Tab auf Feed navigieren zeigt den laufenden Queue-Track im Hub als not in queue und ohne Artwork, obwohl PiP external playing mit Bild zeigt. Ein extern zur geshuffleten Playlist hinzugefügter Song wird erst beim Zurücknavigieren in die Playlist übernommen; Like und Unlike funktionieren."
created: 2026-07-21
updated: 2026-07-21
---

## Symptoms

- Expected: Der laufende Track bleibt auf Feed-Seiten im Hub seiner bestehenden Queue-Position zugeordnet und behält Artwork/Metadaten.
- Actual: Der Hub zeigt "not in queue" und kein Artwork; PiP erkennt denselben Track als external playing und zeigt das Artwork korrekt.
- Expected: Songs, die während einer aktiven Shuffle-Session zur Quellplaylist hinzugefügt werden, erscheinen automatisch in der Queue, auch während der Nutzer auf Feed oder anderen SoundCloud-Seiten ist.
- Actual: Die Ergänzung wird erst erkannt, nachdem im selben Tab zurück zur Playlist navigiert wurde.
- Errors: Keine gemeldet.
- Timeline: Nach dem jüngsten Navigation-, Cross-Tab-Sync- und PiP-Like-Fix beobachtet.
- Reproduction: Shuffle auf einer Playlist starten, im selben Tab zum Feed navigieren; parallel einen Song zur geshuffleten Playlist hinzufügen und beobachten.

## Current Focus

- hypothesis: confirmed — `onNav()` classifies `/feed` as a different playlist, suspending an otherwise active custom-deck queue.
- test: Add a navigation regression proving feed browsing preserves queue ownership and leaves API-backed live sync eligible.
- expecting: Feed navigation keeps `state.suspended === false`; the hub continues using queue/deck metadata and `syncLiveQueue()` continues polling `playlistUrl`.
- next_action: resolved and archived

## Evidence

- timestamp: 2026-07-21
  observation: `onNav()` sets `state.suspended = true` for every active navigation whose URL differs from `state.playlistUrl`, including `/feed` and `/stream` even though these are passive browsing pages rather than replacement playlist contexts.
  implication: The queue is incorrectly marked external as soon as the user opens Feed in the same tab.
- timestamp: 2026-07-21
  observation: `updateHub()` renders `↩ not in queue`, clears artwork/background, and returns early whenever `state.suspended` is true, while Better Feed PiP reads `state._deckTrack` and `state.meta` directly.
  implication: The navigation flag fully explains why Hub loses queue identity/artwork while PiP still shows the correct deck track and image.
- timestamp: 2026-07-21
  observation: `syncLiveQueue()`, `scheduleLiveQueueSync()`, and `applyLiveQueueTracks()` all reject work while `state.suspended` is true; the snapshot fetch itself already uses the persisted `state.playlistUrl` and does not require the playlist DOM to be visible.
  implication: The same erroneous suspension fully explains why externally added tracks are only detected after navigating back to the source playlist.

## Eliminated

- hypothesis: Hub track identity was independently lost after leaving the playlist.
  reason: The active deck and queue metadata remained intact and PiP displayed them correctly; only the shared navigation suspension flag changed Hub presentation.
- hypothesis: Live playlist polling requires the source playlist DOM to be visible.
  reason: `fetchLivePlaylistSnapshot()` and track metadata resolution use the persisted source URL and SoundCloud APIs; the DOM is optional and represented by an empty `pageEls` list off-page.

## Resolution

- root_cause: `onNav()` treated Feed/Stream as a different playlist and set `state.suspended`, which made Hub render the external/not-in-queue state and caused every live-sync entry point to return early even though custom-deck playback and API-backed source metadata remained valid.
- fix: Added explicit passive-page classification for SoundCloud Feed/Stream. Those routes now preserve queue ownership, keep Hub deck metadata/artwork active, and force an immediate live sync against the persisted source playlist; navigation to another collection keeps the prior suspend/merge behavior.
- verification: `node --check "SC Trueshuffle.js"`; source `tests/true-shuffle.test.js`; source `tests/crossfade-prototype.test.js`; `python build.py`; built-artifact syntax plus both regression/audio suites with `TSS_SCRIPT=dist/SC Trueshuffle.user.js`; canonical and built SHA-256 hashes match (`30A0D5EC0526AADD3CB807350DCE8462B1159507EA6C0935D...`).
- files_changed: `SC Trueshuffle.js`; `tests/true-shuffle.test.js`; `dist/SC Trueshuffle.user.js`; `.planning/debug/resolved/feed-queue-live-sync.md`
