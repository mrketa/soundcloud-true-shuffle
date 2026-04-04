// ── Shared state ─────────────────────────────────────────────────────────────
// Single source of truth for all runtime data. Every module reads/writes this
// object directly — no copies, no getters.

const state = {
  active:       false,   // is shuffle running?
  autoRepeat:   true,    // reshuffle and loop when queue exhausted
  queue:        [],      // shuffled array of track indices (into state.els / state.meta)
  playNext:     [],      // priority queue: play these ti values before continuing
  pos:          0,       // current position in state.queue
  els:          [],      // DOM elements for each track (index = ti)
  meta:         [],      // { title, artist, artwork, link } per track (index = ti)
  worker:       null,    // Web Worker used for background polling
  busy:         false,   // guard: prevents re-entrant playback calls
  loading:      false,   // true while loadTracks() is running
  lastTitle:    '',      // title of the last confirmed playing track
  lastProgress: 0,       // last known playback progress ratio (0–1)
  sidebarOpen:  false,   // is the sidebar panel visible?
  manualAction: false,   // true when user manually triggered next/prev
  dragSrc:      null,    // queue index being dragged (for reorder)
  history:      [],      // stack of previously played ti values (max 50)
  priority:     {},      // ti → weight: 0.25 = low, 1.0 = normal, 2.0 = high
  suspended:    false,   // true while an external (non-queue) track is playing
  playlistUrl:  '',      // href when shuffle was started (detect navigation away)
  _savedStats:  null,    // snapshot saved on stop() for restore-on-restart
  stats: {
    played:     0,       // total tracks played this session
    playCounts: {},      // ti → number of times played
    elapsed:    0,       // seconds of actual playback time
  },
};
