# Changelog

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
