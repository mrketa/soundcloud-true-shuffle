---
status: awaiting_human_verify
trigger: "Beim Wechsel auf SoundCloud Library zeigt der Hub not in queue und kein Bild, obwohl Feed und andere Seiten nach dem letzten Fix korrekt funktionieren."
created: 2026-07-21
updated: 2026-07-21
---

## Symptoms

- Expected: Library ist wie Feed eine passive Browse-Seite; aktive Queue-Zuordnung, Artwork und Hintergrund-Sync bleiben erhalten.
- Actual: Auf Library zeigt der Hub "not in queue" und entfernt das Artwork.
- Errors: Keine gemeldet.
- Timeline: Direkt nach dem Feed/Stream-Passive-Page-Fix entdeckt.
- Reproduction: Shuffle auf einer Playlist starten und im selben Tab Library öffnen.

## Current Focus

- hypothesis: confirmed - the passive-route whitelist was the systemic cause; navigation must suspend only for another supported collection.
- test: User verifies Home, Feed, Library, Search, Discover, profile, and track navigation while a queue is active, plus one different-playlist merge control.
- expecting: Every non-collection SoundCloud route preserves queue identity/artwork and background sync; only another playlist/likes/tracks/reposts collection suspends.
- next_action: Await live SoundCloud confirmation; do not archive, commit, or push.

## Evidence

- timestamp: 2026-07-21
  checked: .planning/debug/knowledge-base.md
  found: No project debug knowledge base exists.
  implication: There is no known-pattern candidate to prioritize; investigate current source and regression tests directly.

- timestamp: 2026-07-21
  checked: Worktree status, file inventory, build.py, and targeted route/navigation search
  found: SC Trueshuffle.js, dist/SC Trueshuffle.user.js, and tests/true-shuffle.test.js already have uncommitted changes. build.py copies the canonical source bytes to the dist artifact. The source defines isPassiveBrowsePage immediately before onNav, which otherwise suspends on a different valid playlist.
  implication: Preserve the existing changes, patch the canonical source and tests only, rebuild dist through build.py, and explicitly regress both Library passivity and different-playlist suspension.

- timestamp: 2026-07-21
  checked: Existing source/test diffs and complete navigation helper/onNav implementation
  found: The pending Feed fix classifies only /feed and /stream as passive. validPage also excludes /you/library, and onNav checks !validPage before isPassiveBrowsePage, setting state.suspended=true and returning. The existing Feed regression asserts another /user/sets/other playlist is non-passive.
  implication: Library requires inclusion in the shared valid/passive route boundary; adding it only to isPassiveBrowsePage would not reach the passive branch, and other playlist routes must remain outside that classifier.

- timestamp: 2026-07-21
  checked: Resolved Feed debug session and direct execution of current route classifiers
  found: The prior session verified state.suspended causes both not-in-queue artwork loss and live-sync rejection. Current classifiers return passive=false/valid=false for /you/library, while /user/sets/other is passive=false/valid=true.
  implication: Root cause is confirmed, and the minimal safe boundary is exact Library passivity plus unchanged different-playlist suspension.

- timestamp: 2026-07-21
  checked: New source regression test before behavior change
  found: node tests/true-shuffle.test.js fails at the /you/library passive assertion with false !== true, after all earlier tests pass.
  implication: The regression reproduces the reported route-classification bug and will distinguish the intended fix from a no-op.

- timestamp: 2026-07-21
  checked: Minimal route fix against the source regression suite
  found: Exact pathname classification now accepts /feed, /stream, and /you/library, rejects /you/library/sets and /user/sets/other as passive, and the full true-shuffle source suite passes.
  implication: Library reaches the existing queue-preserving branch while a different playlist still reaches suspend-for-merge behavior.

- timestamp: 2026-07-21
  checked: Full source/build/dist verification
  found: Source syntax, true-shuffle regressions, and crossfade prototype tests pass. python build.py completed. Dist syntax and both dist suites pass. Source and dist SHA-256 are identical at E1AE8B720D6E2BDEB3572F1919F3B9388A298CD985180876B1DDE47DD146E316.
  implication: The canonical and shipped userscripts contain the same verified fix, with adjacent playback/crossfade behavior still green.

- timestamp: 2026-07-21
  checked: Final worktree diff/status and git diff --check
  found: git diff --check exits successfully with only existing Windows line-ending warnings. The same pre-existing modified/untracked files remain present; no commit or push was performed.
  implication: The fix is ready for live verification without overwriting or publishing the user's existing work.

- timestamp: 2026-07-21
  checked: Independent continuation rerun of source syntax, 71 shuffle regressions, 30 crossfade regressions, build.py, the same dist checks, SHA-256 equality, and git diff --check
  found: Every check exits successfully. Source and dist are byte-identical at SHA-256 89DDB4F7C476DCDFF2D8AF9AC8678E36D1E1A11B7C525A84BE1F947FC1DF755C; diff hygiene reports only existing line-ending warnings.
  implication: The ownership-based route fix and matrix are verified in both canonical and built userscripts; only live same-tab SoundCloud verification remains.

## Eliminated

- hypothesis: Every top-level SoundCloud tab needs its own passive-route entry.
  reason: A collection-ownership classifier covers current and future browse routes without another fragile whitelist.

## Resolution

- root_cause: Navigation treated passive browsing as a small URL whitelist. Any unlisted route such as Home was considered invalid and set state.suspended, making Hub discard queue identity/artwork and pausing live playlist sync.
- fix: Replaced route whitelisting with collection ownership. All SoundCloud non-collection routes are passive; only concrete playlists and user likes/tracks/reposts collections retain suspend/merge behavior. The Hub re-shuffle context now also changes only on a real different collection.
- verification: Source and dist syntax passed; both passed 71 shuffle regression checks and 30 audio/crossfade checks; python build.py succeeded; source/dist hashes match; git diff --check passed. Route regression covers Home, Feed, Stream, Library, Library subpages, Search, Discover, Charts, profiles, track pages, playlists, likes, tracks, reposts, and non-SoundCloud URLs.
- files_changed: `SC Trueshuffle.js`; `tests/true-shuffle.test.js`; `dist/SC Trueshuffle.user.js`; `.planning/debug/library-queue-state.md`
