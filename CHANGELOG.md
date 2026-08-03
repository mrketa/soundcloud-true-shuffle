# Changelog

## v6.1.4 - 2026-08-03

### Playback reliability

- Fixed rare cases where SoundCloud's native player could start a different track alongside the active True Shuffle deck.
- Restricted native fallback authorization to a single playback start instead of allowing every native playback event during a timed window.
- Made an active True Shuffle deck take priority over SoundCloud's native player.
- Blocked SoundCloud transport starts while True Shuffle owns playback.
- Synchronized native audio suppression with SoundCloud's internal transport state to prevent delayed restarts.
- Preserved native fallback playback and True Shuffle play/pause controls when a progressive stream cannot be loaded.

### Verification

- Added regression coverage for overlapping native playback, one-shot fallback authorization and fallback transport controls.
- Passed the complete True Shuffle, crossfade and Firefox audio fallback test suites.

## v6.1.3 - 2026-07-28

### Performance and playback

- Deferred queue rendering while the sidebar is closed and refreshed it once when reopened.
- Updated only waveform bars that cross the current playhead instead of rewriting every bar on each UI tick.
- Skipped redundant Web Audio master, mix and Auto Level gain writes during steady playback.
- Ignored MutationObserver batches generated entirely by True Shuffle's own interface.
- Stopped SoundCloud through its own transport control when shuffle loading begins and blocked delayed native autoplay during startup.
- Applied the configured crossfade duration to manual Next and Previous transitions instead of capping them at 1.25 seconds.
- Prevented custom-deck title changes after long transitions from falsely showing `not in queue` and clearing the current artwork.
- Limited Auto Level's quiet-track boost to 1.25× to prevent excessive volume in Chromium.

## v6.1.2 - 2026-07-24

### Firefox playback

- Fixed crossfades getting stuck on `mixing` after several tracks.
- Replaced incompatible Web Audio curve events with Firefox-safe audio timeline ramps.
- Added background-safe recovery for paused or frozen crossfades.
- Prevented SoundCloud's native player from starting behind a True Shuffle crossfade.
- Improved recovery when a progressive stream stalls or expires.
- Added a copyable playback diagnostics report for unexpected audio failures.

### Audio and Auto Level

- Reworked Auto Level around the selected volume target.
- Kept Auto Level at unity gain when the volume is set to 100%.
- Allowed safe per-track boosting and attenuation at lower volumes to reduce loudness differences.
- Added peak and master-headroom limits to prevent clipping.
- Cached stable per-track RMS and peak measurements instead of continuously changing gain.
- Added a true unity path when Auto Level and the equalizer are disabled.
- Kept the optional safety clipper disabled by default.

### Queue and metadata

- Fixed the visible round position after skipping forward and returning to the previous track.
- Kept queue order, history and round counters synchronized.
- Improved exact waveform resolution in Firefox.
- Prevented native or advertisement audio from changing True Shuffle's volume.
- Limited native playback fallback permission to the requested track and a short expiry.

### Verification

- Added Firefox-specific regression coverage for Web Audio cleanup, stream fallback, waveform identity and volume ownership.
- Added regression coverage for Auto Level target gain, clipping protection, stable per-track caching and the neutral processing path.
- Added a queue regression for the Next then Previous sequence.
- Passed the complete Firefox, crossfade and True Shuffle test suites.

## v6.0.0 - 2026-07-20

### Highlights

- Replaced SoundCloud's player as the primary playback path with True Shuffle's own two-deck audio engine. SoundCloud playback remains available as a fallback when a stream cannot be resolved or loaded.
- Added customizable DJ-style crossfade with a 0–12 second duration, Smooth, Clean and DJ curves, plus optional fades for manual skips.
- Added a visual 5-band equalizer with built-in presets, fine-tuning and user-created presets that persist through Tampermonkey storage.
- Added Auto Level to reduce loudness differences between tracks, with faster initial calibration and a per-track learned-level cache.

### Audio and controls

- Added a continuous global output-volume slider shared by custom-deck and fallback playback.
- Kept hub, SoundCloud and deck volume synchronized in both directions.
- Added dual-deck pause and resume during active crossfades.
- Added background-safe crossfade automation based on the Web Audio clock instead of animation frames.
- Added equalizer and Auto Level processing to the primary playback path even when crossfade is disabled.
- Added a contrast-safe Auto Level state so its enabled status remains visible over dark artwork.

### Equalizer and persistence

- Added Flat, Bass Boost, Warm, Vocal, Bright and other tuning presets.
- Added an interactive frequency-response graph for 60 Hz, 150 Hz, 400 Hz, 1 kHz and 15 kHz.
- Added save, load and delete controls for custom presets.
- Migrated custom presets from page storage into Tampermonkey's persistent userscript storage.
- Throttled EQ persistence while dragging and hardened custom preset validation.

### Reliability

- Added safe fallback to SoundCloud's native player when public progressive audio is unavailable.
- Improved compatibility with Chrome, Firefox, Edge, Brave, Opera and Safari-compatible userscript managers.
- Preserved playback coordination in background tabs through the existing Web Worker and Web Audio scheduling.
- Cleaned up equalizer pointer capture and modal event listeners when dialogs close.
- Added regression coverage for deck playback, crossfade curves, volume synchronization, Auto Level, equalizer presets, persistent storage and background audio scheduling.

## v5.1.0 - 2026-07-19

### Highlights

- Completely redesigned the floating player and queue panel with a compact dark interface, dynamic artwork accents, a real SoundCloud waveform and resizable queue layout.
- Reworked shuffle into round-based playback: every available track plays exactly once before a fresh queue is generated, with balanced round starters for small playlists.
- Added one-click re-shuffle for the current playlist without reloading the page.

### New features

- Queue and listening-history tabs with persistent search state.
- Cross-playlist queue support with automatic source-page switching when required.
- Sleep timer by minutes or remaining tracks.
- Persistent listening statistics and per-track priority controls.
- Skip tracking that automatically deprioritizes repeatedly skipped tracks.
- Stop-after-this-round option while continuous rounds remain the default.
- Draggable hub and resizable queue panel with saved dimensions.

### Fixed

- Fixed tracks ending 20-30 seconds early, including long tracks and hour-formatted durations.
- Prevented SoundCloud's native next track from briefly playing before True Shuffle takes control.
- Fixed queue searches losing focus/filter state after using Play Next.
- Fixed searched queue jumps silently skipping earlier unplayed tracks in the same round.
- Fixed cross-playlist entries from the original playlist becoming detached and never playing.
- Fixed Feed tracks opening their profile instead of starting playback.
- Fixed tracks with identical displayed titles blocking the next automatic transition.
- Fixed lifetime statistics being counted twice after stopping or restarting shuffle.
- Fixed the hub failing to appear on slowly rendered Feed or playlist pages.
- Fixed rapid SoundCloud SPA navigation leaving the queue in a stale suspended state.
- Fixed queue panels overflowing the viewport at narrow widths or large saved sizes.
- Fixed waveforms being assigned to the wrong track when SoundCloud loaded multiple resources concurrently.
- Fixed shrinking or misleading round counters in the hub and sidebar.
- Removed dead-track recursion that could skip the replacement track as well.

### Verification

- Added an automated regression suite covering parsing, natural track endings, duplicate end signals, round generation, re-shuffle, search persistence, cross-playlist recovery, Feed-safe playback, navigation recovery, statistics and waveform matching.
- 28 automated tests pass against the v5.1.0 release script.

## v4.0.0

This release is a near-complete rewrite of the v3.0.0 codebase. Every part of the script has been replaced, fixed, or extended. Highlights:

---

### New features

**Floating mini player**
A draggable, resizable widget appears in the bottom-right corner while shuffle is running. Shows the current track title, artist, and artwork. Has prev/next/play-pause buttons, a clickable seek bar, a "next up" preview, and a queue position counter. Can be collapsed to a small tab and reopened. Moves out of the way automatically when the sidebar opens.

**Sidebar queue panel**
A slide-in panel accessible via the orange tab on the right edge of the screen. Shows the full shuffle queue with artwork thumbnails, numbered positions, and a highlighted row for the current track. Features:
- Click any row to jump to that track
- Drag rows to reorder the queue
- Search/filter by title or artist
- Prev/next/play-pause controls and a clickable seek bar
- "Play next" section shown above the queue when tracks are pending
- Banner when an external (non-queue) track is playing

**Right-click context menu**
Right-clicking any row in the sidebar queue shows a menu with: play next, move up, move down, copy link, and remove from queue.

**Priority system**
Tracks can be set to low (0.25×), normal (1×), or high (2×) priority from the session stats modal. Higher priority tracks are reinserted closer to the front of the remaining queue; lower priority tracks land further back. Priority is preserved across the session.

**Previous track (prevTrack)**
The sidebar and mini player now have a previous button. Behavior mirrors Spotify: if you're more than 3 seconds into a track, it restarts the current track; otherwise it goes back to the last played track from history. The queue length is kept stable (the previous track is moved, not duplicated).

**Play next**
Right-clicking a queue item and choosing "play next" inserts it immediately after the current track. Multiple "play next" items stack in order and are shown in their own section at the top of the sidebar list.

**Session stats modal**
Accessible via the 📊 button in the sidebar or mini player. Shows total tracks played, total session time, and the 5 most-played tracks with their play counts. Priority can be toggled directly from this modal. Has a reset button that properly clears stats to zero (the old button was broken). Draggable. Updates live every second.

**Suspended mode**
When the user clicks a track that isn't in the queue (or SC auto-advances past shuffle's controls), the script enters suspended mode: it stops fighting the native player, shows "↩ not in queue" in the mini player, and resumes the shuffled queue when the external song finishes.

**Queue cache and auto-resume**
When a non-queue track plays and the user navigates to a different page (or SC auto-follows an external track off the playlist), the full shuffled queue is saved to `sessionStorage`. When the user returns to the playlist within 30 minutes, the exact queue order, position, play history, and priorities are restored automatically — tracks are remapped by permalink URL so indices stay correct even if SC re-renders the list in a different order. Unmapped tracks (new, renamed, or lazy-rendered) are shuffled and appended so no songs are silently dropped. The interrupted track replays from the beginning on restore.

---

### Behaviour changes

**Track-end detection: text comparison → progress ratio**
v3 detected track end by comparing the "time passed" and "duration" text strings. This broke on tracks over 60 minutes and had edge cases with localized time formats. v4 uses a `0–1` progress ratio and fires when `progress >= 0.99`.

**Worker interval: 800 ms → 300 ms**
The background polling interval was halved more than once. At 800 ms, the end-of-track detection could fire up to 800 ms late, allowing SC's native auto-advance to race ahead of shuffle. At 300 ms the window is tight enough that pause() reliably beats SC to the transition.

**External-song detection: immediate → debounced**
v3 called `playNext()` immediately on any title change, which caused false triggers during the brief moment when a track starts loading (title flashes). v4 requires two consecutive ticks with a mismatched title before entering suspended mode.

**playNext insertion: pos+1 → pos**
In v3, "play next" tracks were spliced in at `pos+1`, which skipped the natural next track in the queue. They are now inserted at `pos` (the current position after the just-played track is removed), so the queued-next track plays and then the natural next track follows immediately after.

**Queue stability on prevTrack**
v3's prevTrack spliced the previous track into the queue without removing it from its future slot, so the queue grew by one entry every time you pressed back. v4 removes the track from its future position before reinserting it at the current position.

**autoRepeat default**
Repeat is on by default (`state.autoRepeat = true`). When the queue is exhausted it reshuffles and continues rather than stopping. The checkbox in the control strip lets the user toggle this.

---

### Bug fixes

1. **Priority weight formula** — the high-priority reinsertion window (`weight > 1`) used a formula that could produce a negative `minOffset`, causing `splice()` to insert from the tail of the array via a negative index. High-priority tracks were effectively being sent to the back of the queue instead of the front.

2. **Seek bars not wired** — both the sidebar seek bar and the mini-player seek bar were rendered with `cursor:pointer` and a seek tooltip but had no click handler. `seekTo()` was unreachable from the UI.

3. **prevTrack queue growth** — see "Queue stability on prevTrack" above.

4. **`_goingBack` flag** — a `_goingBack` flag was set by `prevTrack()` but never read anywhere. It has been removed.

5. **Stats reset button** — the reset button in the stats modal called a function that restored a saved snapshot instead of clearing stats. It now zeros everything out unconditionally.

6. **Mini-player not restored after sidebar close** — `shiftMiniPlayer()` was only called when the sidebar opened, so the mini-player was shifted left but never moved back when the sidebar closed. It is now called on both open and close, and uses a `data-autoShifted` attribute to distinguish auto-moved elements from user-dragged ones.

7. **Blob URL leak** — `URL.createObjectURL()` was called on every shuffle start but the resulting URL was never revoked, leaking memory. The URL is now revoked immediately after the Worker is constructed (the Worker holds its own internal reference).

8. **XSS via track metadata** — track titles and artist names were inserted into the sidebar list via `innerHTML` without escaping. A maliciously named track could inject arbitrary HTML. All user-visible metadata is now passed through `esc()` before innerHTML insertion.

9. **`loadTracks` empty-list race** — the old `loadAllTracks` started scrolling immediately. If the page hadn't rendered its track list yet, `last=0` and `n=0` were equal on tick one, `stable` quickly hit 3, and the function returned an empty array. v4 waits up to 10 seconds for at least one track element before starting to scroll.

10. **Cache cleared before threshold check** — `sessionStorage.removeItem('tss_queue_cache')` was called inside the restore block but before the remap-quality check. If fewer than the required fraction of tracks remapped, the cache was already gone and `_cached` stayed null, making retry impossible. The remove is now inside the success branch, after `_cached` is set.

11. **Nav handler re-entrancy** — SoundCloud's SPA can fire multiple DOM mutations during a single navigation, causing `onNav()` to run concurrently and double-inject the UI. A `navLock` flag now serialises calls.

---

### Internal / architecture

- Split from a single 350-line file into 13 focused modules (`src/`) built by `build.py`
- `playlistBase()` normalises URLs (strips query params, hash, trailing slash) for robust same-playlist detection
- `trackId()` prefers permalink URL over display text for stable track identity across re-renders
- `state.busy` re-entrancy guard prevents `next()` and `prevTrack()` from running concurrently
- `state.manualAction` flag prevents the watcher from misclassifying intentional control actions (jumpTo, prevTrack, cache-restore playback) as external songs
- Web Worker terminated and null-checked on stop to prevent stale ticks after the session ends
- `state.active` checked at the top of every async function to abort stale chains that outlive a `stop()` call
