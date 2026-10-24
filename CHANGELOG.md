# Changelog

## v6.3.0 - public player, playback and reporting cutover

- Public 6.3.0 brings the verified UI 6.2.9.19 revision into canonical `SC Trueshuffle.js`, with the public **SoundCloud True Shuffle** identity and description. The canonical install follows the GitHub `main` distribution; Greasy Fork remains a separately managed installation/feedback channel.
- **Published:** [GitHub release v6.3.0](https://github.com/mrketa/soundcloud-true-shuffle/releases/tag/v6.3.0), **2026-10-24T02:49:21Z**, source/release commit `c7474d9ce308d529204bde6f6b018365b18f1050`, pushed to `main`. The tag targets that exact commit; the public release is neither draft nor prerelease. Originally created without attachments, it now has one subsequently added API-observed asset: [SC.Trueshuffle.user.js](https://github.com/mrketa/soundcloud-true-shuffle/releases/download/v6.3.0/SC.Trueshuffle.user.js), 564892 bytes, created **2026-10-24T02:57:57Z**, API digest `sha256:1fe179307575d7fa30b469ddb6f3129470641097d4d9f84894e1a2a450e8879e` (matches the previously tested local CRLF public build). The uploader was not independently verified. Automatic source archives are separate. [Install the fixed v6.3.0 userscript](https://raw.githubusercontent.com/mrketa/soundcloud-true-shuffle/v6.3.0/dist/SC%20Trueshuffle.user.js). The maintainer also reports **6.3.0 published on [Greasy Fork](https://greasyfork.org/en/scripts/568821-soundcloud-true-shuffle)**; no independent live-source comparison or publication time is claimed.
- **Playback since 6.2.5:** retain both fade directions for short bumpers by sharing the incoming track's duration budget; resolve/preload the following HLS track during the current fade and begin standby preparation immediately when the outgoing deck is released. Reuse matching preparation and audio routing rather than restarting unchanged work. Keep two audio decks, pinned hls.js 1.7.3 and existing buffer/quality limits.
- **Firefox/low-spec crossfades:** bounded paired linear automation replaces hundreds of native scheduling calls, with monotonic time compensation, pause/resume ownership and up to 128 ms of lead reserved inside the existing overlap window. This shortens the active ramp rather than extending overlap. The user relayed that the separate original private 6.2.9 fixed Abox's reported VM audio artifacts; that feedback is not direct assistant observation or new VM certification of public 6.3.0.
- **Player and queue:** playback-focused main/mini controls, English **Settings → Audio / Session / Info** tabs, accessible gear/back/PiP icons, and labeled **Reshuffle** beside **Queue**. Queue docking, search, history, merge and resize remain available; narrow views provide Back to player and focus restoration. Interruptible, reduced-motion-aware navigation uses fixed charcoal glass and the `#aebaf3` accent. The .17 compact queue header puts Merge and Close on its title row.
- **Performance and identity guards (.15):** avoid unchanged Settings/view writes and hidden PiP queue rendering; animate only genuinely overflowing visible titles; bound waveform retention to 300. ID-first metadata, playlist authority, stream/waveform caches, queue restoration and native-action checks keep conflicting SoundCloud track IDs distinct rather than accepting an ambiguous permalink. Partial or mismatched responses cannot delete valid queue membership or authorize the wrong native track.
- **Manual effects and PiP (.15/.18/.19):** locally saved **Reduce visual effects** removes owned blur and nonessential motion without changing audio. Document/inline PiP stays opaque near-black in either state. Independently saved **Scroll long titles**, on by default, controls overflowing PiP player titles regardless of the effects setting; system reduced motion still wins. Native video PiP and OS chrome retain their capability limits.
- **Fault reports (.16):** a classified playback fault reveals the single header report button, including after ending a session; ordinary transition observations do not. **Copy report** produces sanitized readable text capped at **1,800 characters**. Lazy optional full JSON has its own **Copy full report** action, and blocked clipboard access explains manual copying. Latest-fault context survives Stop/live-ring rollover; Clear/reload removes it. No uploads, persistent logs or telemetry.
- Production keeps lightweight transition logging enabled with verbose `DIAGNOSTIC_BUILD=false`. `python build.py` copies canonical source verbatim; `--diagnostic` creates the separate **Temporary Diagnostic** identity at the same canonical version with `DIAGNOSTIC_BUILD=true`, not an artificial future version. Default Node tests target canonical source without private expectation flags; `TSS_SCRIPT` remains an explicit override. Expectations use metadata-version release contracts: half-duration budgeting from 6.2.6 and immediate prefetch from 6.2.7.
- **Release verification:** syntax passed for canonical/public/diagnostic sources. Each passed **164 tests, zero skips, zero failures**; the unchanged private UI .19 comparison also passed 164/0/0, and original Abox private .9 passed 133 with 9 feature skips and zero failures. The standard build is byte-identical to canonical source, its code body matches verified UI .19, and public/diagnostic metadata are 6.3.0 with the correct false/true verbose flags.
- **Built-public browser checks:** Chrome exercised real local WAV audio-graph pause/resume, independent scrolling with reduced effects on, dark native Document PiP and exact native-clipboard copying of a 718-character 6.3.0 fault report while the same deck/context kept playing. Firefox 158 exercised the public UI/PiP marquee and an exactly copied 484-character fault report. No browser errors; all fixtures cleaned.
- **Evidence boundary:** these controlled fixtures and earlier historical tests are not authenticated SoundCloud playback, userscript-manager integration, full-browser certification or a new Safari/Abox-VM run. Original private-6.2.9 VM feedback remains separate.

## Private development history (pre-public cutover)

The entries below describe their own revisions and the authorization state at the time. References to stable 6.2.5, no migration/publication, older builder behavior and private test flags are historical, superseded for the active public 6.3.0 cutover above. The UI backup and Abox's original private audio artifact remain separate and unchanged.

## v6.2.9.19 - independent scrolling-title preference

- Added **Settings → Info → Scroll long titles**, enabled by default and saved independently as `tss_scroll_long_titles`. It immediately updates open PiP and applies to newly opened PiP and reloads without changing the Reduce visual effects preference.
- Long overflowing PiP titles can now scroll with reduced effects enabled, or stay still with reduced effects disabled. The narrowly scoped animation exception affects only the active player title; other reduced-mode animations, transitions and blur remain off. Queue/short titles stay still, and the system's reduced-motion preference remains respected.
- Kept the opaque dark PiP material from .18, queue/report controls, audio and playback timers unchanged.
- Syntax and final Node matrix passed: UI **164 passed, 0 skipped**; original private 6.2.9 **133 passed, 9 feature skips**; default **131 passed, 9 feature skips**; zero failures. Behavioral tests cover independent combinations, real preference persistence/reload and current/new PiP propagation without asserting unrelated storage-write implementation details.
- Actual Chromium and Firefox 158 verified all four combinations in inline and native Document PiP. Reduced mode plus scrolling enabled animated only the title; PiP stayed opaque near-black. Chromium also confirmed reload persistence, 320px Settings layout and actual system-reduced-motion emulation blocking/restoring the animation without changing either saved preference. Firefox measured advancing animation time/transform and fresh opens in every combination. No browser errors; fixtures cleaned. No new authenticated SoundCloud/audio/Abox-VM/Safari certification.
- Same UI-backup file/name, metadata **6.2.9.19**. Stable source and Abox's original private audio build untouched; no builder or publication. Existing style-scan warning categories unchanged.

## v6.2.9.18 - keep PiP dark when visual effects resume

- Addressed Abox's user-relayed feedback: the new UI feels quicker, but disabling Reduce visual effects brought back the marquee together with an unwanted light translucent PiP exterior. The reported PiP mode and exact tested UI version were not supplied.
- Decoupled owned PiP material from the effects preference. Inline host, PiP document/body and player now keep opaque near-black `#090a0c` in either state. Removed the old translucent PiP override and redundant reduced-mode background switch; no backdrop blur is rendered behind the opaque PiP surface.
- Marquee and other motion still stop in reduced mode and resume when disabled. Main-player/queue/dialog glass remains unchanged; native video-PiP rendering and OS window chrome are not modified.
- Syntax passed. Actual Chromium and Firefox 158 verified inline and native Document PiP over a white page: dark opaque surfaces through repeated toggles and fresh opens in both preference states, stopped/resumed marquee and unchanged normal main-player glass. Chromium inspected both PiP surfaces visually; Firefox additionally observed advancing marquee time/transform and no marquee for Queue/short titles. No captured page errors; owned windows, browsers, profiles, servers and temporary runners/screenshots released.
- Same UI-backup file/name, metadata **6.2.9.18**. No Node-suite rerun for this material-only patch, no new authenticated SoundCloud/audio/Abox-VM/Safari certification. Stable source and Abox's original private audio build remain unchanged; no build or publication.

## v6.2.9.17 - compact queue header

- Put the existing Merge playlist and Close/Back to player controls on the Queue title row, removing the standalone Merge row and its empty left side. Tightened header padding and the title-to-tabs gap; Queue/History, count and search remain in place.
- Kept all control IDs, callbacks, control heights, docking and queue motion unchanged. Removed the obsolete merge-row wrapper and CSS. At the minimum 220px docked width the labels wrap within their existing button heights rather than overflowing; the 320px narrow view fits both actions on the title row.
- Syntax passed. Actual Chromium fixture inspected desktop/full/mini, 320px narrow and 220px docked layouts; controls stayed inside, no horizontal overflow, settled History/Queue switching, exact search results and Close/focus restoration worked, no browser errors. No new Firefox/Safari run or audio-runtime claim for this spacing-only revision. Existing style-scan warnings unchanged.
- Same UI-backup file/name, metadata **6.2.9.17**; compact playback reports from .16 and audio behavior unchanged. Stable and original Abox artifacts remain untouched; no build or publication.

## v6.2.9.16 - fault-only header button and short playback reports

- Moved the single playback-report control out of Settings → Info and into the player header. It appears only after a classified playback fault, including with transition logging enabled; normal observation logs do not reveal it. Full/mini/Settings access and access after Stop remain. Clear hides the button and restores focus to a visible header control; a later fault reveals it again.
- **Copy report** now copies readable, privacy-filtered plain text capped at **1,800 characters**, for pasting directly into a message. It includes build/browser/OS/manager, the latest fault and error codes, fault-time playback/audio/deck readiness/buffer state, visibility/connectivity and a short deduplicated timeline. No compressed token, decoder, paste service or upload is required.
- Full sanitized JSON is still available through **Full technical details (optional)** and an explicit **Copy full report** action. It is generated lazily; expanding it does not change what the normal Copy report button copies. Clipboard denial keeps the report open, selects its text when supported and explains manual Ctrl+C/Cmd+C copying.
- Improved useful context rather than increasing log volume: retain one sanitized latest-fault incident, two deck summaries and up to 12 preceding events across Stop and live-ring rollover. The live ring remains capped at 80. Clear/reload removes both. No new playback timers, workers, streams, persistent logs or telemetry.
- Retain signed millisecond timeline offsets and keep pre-fault causes separate from later repetitions. Record order separates observations sharing the fault's timestamp so one earlier observation cannot be repeated as a later event. The three existing main-thread fade scheduling measurements are included only for one complete, unambiguous pre-fault record matching the captured schedule token; they are not render-thread delivery proof. Canonical `errorName` takes precedence over the legacy `error` alias regardless of property order.
- Syntax and the final Node matrix passed: UI **162 passed, 0 skipped**, original private 6.2.9 **133 passed, 9 new-feature skips**, default invocation **131 passed, 9 new-feature skips**; zero failures. Added behavioral coverage for length/privacy/malformed input, alias precedence, fault-time context after Stop/ring rollover, latest-incident replacement, causal timing, clipboard/full-report separation and header/Clear lifecycle.
- Chromium exercised actual source helpers with two real WAV media decks/audio processing: opening the report did not stop playback, fault-time readiness/buffer data remained after Stop and 100 subsequent observations, and both clipboard formats matched after Windows newline normalization. A blocked clipboard selected the correct report for manual copying. Desktop and 320px mini/header/dialog checks passed; all four header controls remained inside the player and Clear restored Settings-button focus. Short-copy and timing-correlation confirmations passed; no browser errors. The final same-millisecond ordering correction was separately confirmed in actual Firefox.
- Actual isolated Firefox 158 exercised the report UI with trusted pointer input and native clipboard writes, optional full details, focus handling, fault-only visibility and a 320px viewport. Final-source confirmation copied a 597-character report exactly and preserved same-millisecond pre/post observations once each, with canonical `NetworkError`. Browser/profile/server/runner cleanup completed. These controlled injected-fault/local-media fixtures are not authenticated SoundCloud, a real userscript-manager integration test, full-browser certification or a Safari run. Timings cannot detect audible clicks or silence; an audible artifact without a classified technical fault does not automatically reveal the button.
- Same UI-backup identity/file, metadata **6.2.9.16**, private 6.2.9 audio basis. Stable source and Abox's original private file remain unchanged; no rebuild, commit, push or upload. Existing resize-grip/initially-hidden-artwork scan warnings remain, with no new warning category.

## v6.2.9.15 - bounded UI work, reduced effects and SoundCloud identity guards

- Completed the interrupted cleanup in `dist/SC Trueshuffle UI Backup 6.2.9.user.js`; same installation identity, private 6.2.9 audio basis. Stable 6.2.5 and Abox's original private file are unchanged. No rebuild or publication.
- Removed only proven dead/redundant presentation code: unused moon SVG, overridden seek-hover scaling, four overridden Stats inline material declarations and duplicate sidebar scrollbar color. No playback, recovery, diagnostic or compatibility branch was removed merely because it is uncommon. Added guards mean the complete script is not smaller overall.
- Avoided unchanged Settings/view DOM writes and periodic rendering of the hidden own-PiP queue. Opening Queue still renders current data. The title marquee runs only for an overflowing visible player title; removed its unconditional compositor hint.
- Bounded waveform retention to 300 entries with refetch after eviction. Waveforms use known SoundCloud IDs before permalink fallback, so different tracks sharing a permalink do not reuse each other's waveform.
- Added **Settings → Info → Reduce visual effects**, off by default and saved locally. It replaces glass with dense charcoal, removes owned backdrop blur and nonessential motion/marquee, and settles in-flight transitions through their actual cleanup callbacks. Current and newly mounted floating/document PiP receive the preference. Audio quality, the two-deck limit, HLS buffers, crossfade automation and playback supervision cadence are unchanged.
- Hardened playlist authority: exact valid counts and raw track IDs are required before a snapshot can remove queued membership; partial/malformed responses remain nonauthoritative, legitimate explicit empty playlists still work, and hydration must match the requested playlist rather than an ambiguous or unrelated entry.
- Validate API/hydration identity before accepting metadata, access flags or stream URLs. Same-permalink conflicting known IDs remain distinct in live reconciliation, waveform and stream caches; stream provenance records validated response identity even when the requesting metadata had no ID. Handle nested HLS containers independently, reject malformed stream URLs/null mappings and restrict resource-history credential discovery to SoundCloud API hosts.
- Extended the same identity contract through queue-cache serialization, collection matching and restoration, including older URL-key caches whose metadata already contains IDs. Current position, played prefix, Play Next, history, priority and source membership remain separate for conflicting IDs. Batch joins use operation-local ID/link indexes and read DOM row links once, rather than rescanning the full collection per track.
- Recheck attached row identity for Like/native playback and again immediately before awaited native clicks. If different known IDs share a permalink, URL-only DOM evidence cannot authorize either identity: clear ambiguous row bindings and decline Like/native start, resume or acknowledgement rather than click/credit the wrong track. Ordinary unambiguous bindings remain supported. Preserve current-request cleanup despite row rebinding, require positive exact-track native playback acknowledgement, and treat missing transport state as unknown. Recover from disposed cached volume models, replaced methods on the same PiP bridge object and individually locked History methods. Reports now accept bounded four-component UI versions.

### Verification and remaining limits

- JavaScript syntax passed. Final Node runner results: UI backup **153/153**, original private 6.2.9 **133/133**, default invocation **131/131**, zero failures. Updated extracted-helper dependencies and retained meaningful native-output ownership assertions; added same-permalink waveform isolation, ID-less stream-response provenance, queue-cache/ID-promotion restoration and ambiguous native-action regressions.
- Actual isolated Chromium rendered the current userscript's UI/CSS: 20px blur changed to none and restored, the preference survived reload, inline PiP inherited/toggled it, interrupted paired animations settled, narrow queue exit released its footprint/restored focus, and 24 rapid navigation/effects changes left no owned animation pending. Desktop and 320px Settings inspected; no browser errors.
- Real local WAV playback through the script's media deck/audio graph continued across effects toggles with the same deck/context. Hidden PiP queue had zero DOM mutations across 20 syncs and showed fresh data on opening; marquee stopped in Queue. Actual waveform rendering separated IDs11/22 at one permalink, restored the correct cached picture, bounded retention to 300 and refetched an evicted entry. Malformed/mismatched/ambiguous hydration could not become authoritative; unsafe DOM links were rejected.
- Reproduced and corrected two final adversarial findings in actual Chromium: URL-key cache restoration previously collapsed IDs11/22 to track22, and ambiguous URL-only rows authorized Like. Final-source smoke preserves both IDs and current/history/Play Next/source state from an older cache. Ambiguous Like/resume issue no clicks and preserve paused intent; removing the conflict permits ordinary resume. Final-source local WAV/effects smoke also passed; a 4,000-track restore exercised the indexed batch path. External API/transport fixtures are synthetic, not authenticated SoundCloud.
- Follow-up independent review found no blocking defects in the corrected identity cutover. Owned smoke playback, audio context, browser tab and in-memory fixture server were released.
- This is not a low-spec GPU benchmark, physical audio-output measurement, authenticated SoundCloud test or new Firefox/Safari/Ubuntu-VM certification. Default glass still costs compositor work; use the explicit reduced-effects option on weak hardware. It does not guess hardware capability or guarantee against host suspension. Blocked storage permits the session change but cannot preserve it across reload. Native playback/Like remain intentionally unavailable for conflicting IDs at one permalink when the DOM cannot independently identify the track; validated custom streams remain separate. Future undocumented SoundCloud API/DOM changes can still require updates; no speculative universal compatibility guarantee.
- The style scan still reports the existing resize-grip width/height transitions and initially hidden, dynamically populated PiP artwork. Reduced-effects mode disables those transitions. The historical Firefox-headless pixel-blur limitation remains; native video PiP cannot blur the surrounding desktop.

## v6.2.9.14 - directional vertical queue scale

- Added a visible 90%→100% vertical queue scale alongside the existing edge-clipped pop-out. A queue extending above the player anchors at its bottom and unfolds upward; otherwise it anchors at its top and unfolds downward. Narrow queue views unfold downward below the fixed header.
- Preserved the stationary horizontal player boundary, behind-player docking depth, fixed charcoal material and foreground-first closing stages. No text is shown during normal glass expansion/retraction.
- Same backup identity/file, UI metadata **6.2.9.14**, private 6.2.9 audio basis; original Abox release remained byte-identical. Syntax/private regression suite passed.
- Chromium inspected actual scale/anchor positions in full/mini and left/right layouts: vertical growth reversed correctly on closing, the chosen top/bottom edge stayed fixed, and player-edge intrusion remained zero. Narrow growth stayed below the header; Settings remained usable during closing. No browser errors or live SoundCloud/new Firefox pixel claim; known scan warnings remain.

## v6.2.9.13 - fixed queue attachment edge

- Corrected the remaining glass-strip overlap: the queue no longer translates toward/over the player while collapsing. Edge-anchored scale and directional clipping retain the pop-out effect while the shared attachment edge stays stationary; narrow motion likewise no longer translates over the header.
- Removed the one-pixel docking overlap. Docked queue glass now stacks behind the player; the narrow replacement remains above its content so it stays visible and usable.
- Fixed charcoal material, foreground-first staging, durations, icons, controls and audio algorithms are unchanged. Same backup identity/file, UI metadata **6.2.9.13**, private 6.2.9 basis; original Abox release remained byte-identical.
- Syntax/private regression suite passed. Chromium sampled 52 entry positions and all 220 millisecond exit positions for left/right docking in full/mini modes: maximum player-edge intrusion was zero in every case. Narrow entry/exit stayed below the header, retained correct stacking and allowed Settings navigation during closing. No browser errors; no live SoundCloud or new Firefox pixel-rendering claim. Known style-scan warnings remain.

## v6.2.9.12 - fixed charcoal material and foreground-first queue collapse

- Removed song-artwork-driven glass brightness entirely: deleted the material synchronization helper/callers, inherited image/cache attributes, cover pseudo-layers and obsolete hub background wrappers. Actual artwork thumbnails and PiP picture displays remain. UI material now stays fixed neutral charcoal with the existing reflection/rim and `#aebaf3`; genuine page-backdrop transparency is retained.
- Staged Queue motion to prevent clipped header/row letters in the retracting strip. Entry unfolds glass for 190ms, then reveals foreground for 70ms. Exit fades foreground during the first 60ms while glass geometry holds, then retracts only empty glass for 160ms. Paired effects share a timeline with per-segment easing; interruption, stale completions and instant fallbacks remain guarded.
- Same backup identity/file, UI metadata **6.2.9.12**, private 6.2.9 audio basis; original Abox release remained byte-identical. Removed obsolete artwork-material fixture dependencies while retaining real metadata/PiP and paired-animation behavior tests.
- Syntax/private/default stable suites passed; read-only review found no defects. Chromium white/black/orange cover changes produced identical material pixel crops outside the thumbnail; computed Main/Settings/Queue material remained fixed. Sampled exit frames showed full glass during foreground fade and zero foreground opacity throughout retraction, with rapid reopen and short-view Settings navigation verified.
- Actual Firefox 158 BiDi confirmed synchronized stage clocks, zero foreground opacity across 161 exit samples from 60–220ms, empty narrow retraction, safe reopening from both exit phases, and cover-independent material. Firefox headless pixel-level blur remains unverified as previously documented. Owned browsers/runners/profiles cleaned; no live SoundCloud/user-profile/Ubuntu/GPU claim. Known scan warnings remain.

## v6.2.9.11 - stable glass exit and scrollbar layout

- Fixed queue exit compositing by keeping the backdrop-bearing root at constant opacity and retracting it with the existing anchored transform plus directional clipping; only the permanent `tss-sidebar-content` foreground wrapper fades. Glass tint/blur therefore no longer fade away with queue text. Root-owned paired animations cancel/complete together and preserve rapid-reopen safety.
- Replaced nested hub/Settings scrolling with a clipped flex shell, fixed header and one active-view scroller. Stable thin gutters preserve content width; clipped view/tab transitions cannot introduce transient outer scrollbars. Removed artificial tab-content minimum height while retaining a shrinkable preferred Settings footprint.
- Fixed a review/runtime-discovered short-window queue collapse: moved default list flex sizing from inline style to CSS so the narrow minimum wins. The short queue retains a 112px row viewport and can reveal its final row.
- Same backup identity/file, UI metadata **6.2.9.11**, private 6.2.9 audio basis. Existing icons, glass material, `#aebaf3`, motion durations, controls and audio algorithms retained; original Abox release remained byte-identical.
- Syntax, private regression suite and default stable suite passed. Added paired foreground/root cancellation, stale-completion, mounted-row/action/scroll retention and fallback/reduced-motion regressions. Chromium dense-text/waveform mid-exit capture showed stable remaining glass; measured Settings widths/left coordinates stayed constant across opening/tab transitions, with short-window End/report and queue-row reachability verified.
- Firefox 158 BiDi confirmed constant root opacity/filter, paired-animation cleanup/reopening, stable Settings widths across rAF samples, fixed header, single real scroll owner and final 112px queue viewport. **Visual blur certification is limited in Firefox headless:** an independent native CSS blur reference also rendered sharp despite reported support, so no claim of visually clean Firefox blur is made. Owned browsers/runners/profiles were cleaned; no live SoundCloud/user-profile/Ubuntu/GPU claim. Known style-scan warnings remain.

## v6.2.9.10 - corrected motion dispatch and player-anchored queue

- Addressed the user's report that Settings opening/tab changes still appeared instant. Removed blanket `click.detail === 0` classification as keyboard input: only an observed trusted Enter/Space activation gets the instant keyboard path, consumed once; pointer/script activation animates. This was a real suppression path, not proof of the user's precise environment cause. Existing same-target synchronization guards already preserved active animations.
- Made Settings entrance/exit more perceptible with 240ms opacity/8px translation and tab content changes with 210ms opacity/6px translation. Routine state/layout synchronization cannot settle a same-target running transition.
- Queue docking geometry now resolves before entry. The queue emerges from the nearest full/mini-player edge with mirrored 14px translation and 0.975 scale, anchored near the Queue action; 250ms entry/180ms exit. Narrow layouts unfold from the top with a mild vertical pop-out. Real exits remain painted/inert until completion; reversal and stale-completion guards retained.
- Same backup identity/file, UI metadata **6.2.9.10**, private 6.2.9 audio basis. Icons, glass/artwork, `#aebaf3`, final queue geometry and playback algorithms remain; original Abox release stayed byte-identical.
- Added behavioral modality regressions for zero-detail activation, trusted keyboard consumption, pointer reset, routine-sync preservation, reduced motion, fallback and stale completions. Syntax/private/default stable suites passed; read-only review found no defects.
- Chromium and actual Firefox 158.0 WebDriver BiDi fixtures observed trusted pointer and synthetic zero-detail Settings/tab motion, both queue docking directions, mini/narrow pop-out, instant trusted keyboard activation, rapid reversals/latest-tab behavior and reduced-motion instant fallback. Firefox screenshots inspected; isolated browser profiles/runners and managed browser released. No live SoundCloud/user-profile/Ubuntu/audio-output/GPU-performance claim; known style-scan warnings remain.

## v6.2.9.9 - accessible player icons

- Replaced header Settings/PiP text with consistent SVG gear/PiP icons. The Settings control shows a back arrow while open, with corresponding English accessible name and tooltip; mounted icons switch visibility without replacement on hub ticks.
- Added equalizer/timer/info icons beside the Audio/Session/Info tab names. Decorative SVGs remain hidden from assistive technology; tab semantics, keyboard navigation and nested SVG click handling are preserved. Queue and Reshuffle retain icons plus explicit text.
- Kept 32px header targets, approved material/animations, exact accent and all playback behavior. Same backup file/name, UI metadata **6.2.9.9**, private 6.2.9 audio basis; original Abox release remained byte-identical.
- Syntax/private regression suite passed. Chromium verified SVG hit targets, English accessible names, gear/back state, nested tab-icon clicks, keyboard Home/End, rapid Settings navigation and 320px layout. PiP SVG click acquired native video PiP with correct pressed state and cleanup; no browser errors. No live SoundCloud streaming/Ubuntu/GPU claim; known scan warnings remain.

## v6.2.9.8 - clearer Settings, direct actions and real transitions

- Split Settings into accessible **Audio / Session / Info** tabs with retained selection and arrow/Home/End navigation. Audio contains sound controls; Session contains timer/round-end/session actions; Info contains statistics and playback reports.
- Restored the existing PiP control to the header and moved the same Reshuffle control beside Queue with an explicit label. Existing callback, disabled/loading behavior and single-control identities remain; glass material, artwork depth and exact `#aebaf3` are unchanged.
- Added interruptible opacity/4px-translate transitions for Settings and queue entry/exit and Settings/Queue-History tab changes. Exiting surfaces become inert/ARIA-hidden immediately but remain rendered until completion; superseded animations cannot hide reopened content. Keyboard actions, reduced-motion preference and unsupported WAAPI use instant navigation. No new playback timers or dependencies.
- Same backup file/name, UI metadata **6.2.9.8**, private 6.2.9 audio basis; original Abox release remained byte-identical. Updated real-helper extraction fixtures and behavioral tab-persistence/inertness/stale-completion regressions, retaining stable compatibility.
- Syntax, private and default stable suites passed; read-only motion/navigation review found no defects. Chromium observed actual 170ms entry/145ms exit animations, rendered-but-inert closing surfaces, Queue/History fades and rapid close/reopen/tab/mixed-navigation safety. Reduced-motion and keyboard paths were verified instant; 320px header/Settings and narrow exit geometry remained usable.
- Real local WAV playback continued through view/tab changes; header PiP acquired native video PiP and cleaned up. Session timer/End cleanup and Info report access after End were exercised without final browser errors. No authenticated SoundCloud streaming, Ubuntu-VM or GPU-performance claim; known resize-handle/hidden-artwork scan warnings remain.

## v6.2.9.7 - playback-focused English player and Settings

- Implemented the approved UI restructure in the backup only. Main view now focuses on artwork/title, seek/timing, Previous/Play-Pause/Next, one master-volume control and a labeled Queue action with position. Static branding replaces the hidden reshuffle action; the header offers minimize and **Settings**.
- Added one English Settings view grouped into Audio (crossfade/profile/manual skips, Auto Level, equalizer), Session (sleep, round-end, reshuffle), Other actions (PiP, stats, report), and a distinct **End shuffle session** action. The same session button remains reachable as Start/Cancel when inactive/loading and moves into Settings while active. Reports remain available after ending the session.
- Mini view retains the original transport controls without duplicate IDs. Desktop queue docks and retains resize/reorder/search/history/merge actions, with explicit Close queue. Narrow queue uses the player's available width with Back to player, mutually exclusive Settings navigation, Escape dismissal and opener-focus restoration.
- Added navigation/seek accessibility and fixed a review-detected loading-to-active focus loss when the focused Cancel action moves into hidden Settings; focus now remains on a visible player/header control.
- Preserved exact accent `#aebaf3`, transparent charcoal/reflection/monochrome artwork depth, private 6.2.9 audio algorithms and original Abox artifact (byte-identical). Same backup identity/file, UI metadata **6.2.9.7**. No stable rebuild or publication.
- Updated extracted-function fixtures and meaningful session/focus transitions; removed obsolete header-adjacency, readout-copy, CSS-fill and synchronization-count assertions. Final syntax, private regression suite and default stable suite passed.
- Chromium smoke used real looping local WAV playback to verify full/mini Play/Pause, plus Settings crossfade/profile/round-end/timer controls, nested EQ/Escape, End cleanup and report-after-End. Verified desktop queue search/tabs/resize, player dragging with queue follow, 390px/320px narrow navigation and focus, short-window Settings reachability, and native video PiP acquisition/cleanup from its relocated action. No browser errors in the final fixture; no authenticated SoundCloud streaming, Ubuntu-VM or GPU-performance claim. Style scan retains the documented resize-handle/hidden-artwork warnings.

## v6.2.9.6 - requested accent color

- Changed the UI backup's fixed interaction accent to the user's exact `#aebaf3` / RGB `174,186,243`, including fallbacks, states, EQ graphics and PiP consumers. Semantic warnings/errors, dark primary-control foregrounds, approved glass/artwork material and layout remain unchanged.
- Same backup file/name, UI metadata **6.2.9.6**, private 6.2.9 audio basis; original Abox script remained byte-identical. Syntax and private regression suite passed; real player and resolved EQ color verified in a local Chromium fixture without browser errors. No live SoundCloud/PiP claim; known style-scan warnings remain.
- Structural cleanup is planning only: user selected playback-focused main controls and an on-demand docked queue. No controls moved or removed in this revision.

## v6.2.9.5 - neutral artwork depth for consistent glass

- Added a faint abstract current-cover layer so glass retains structured depth over uniform backgrounds: full grayscale, brightness 0.72, 32px blur and 18% opacity. The real 20px backdrop blur, transparent charcoal shell, reflection and blue controls remain; varying scenery cannot be reproduced identically.
- Reuses the hub's existing background element; shared CSS artwork supplies sidebar, EQ, stats, report/help and document/inline PiP surfaces. Context menus/toasts retain neutral glass without artwork texture; native canvas PiP remains unchanged.
- Artwork changes update the inherited image only when needed; missing artwork, suspended playback and Stop clear it. Existing thumbnail artwork is preserved, no artwork-driven control recoloring or new playback timers/dependencies.
- Same backup file/name, UI metadata **6.2.9.5**, private 6.2.9 audio basis; original Abox release remained byte-identical. Updated extraction-based interface/PiP fixtures to execute the real artwork helper while retaining stable-source compatibility.
- Syntax, private regression suite and default stable suite passed. Chromium fixtures confirmed flat/patterned and 390px rendering, cover replacement, missing/suspended/stopped clearing, stable blue controls, search/tabs/crossfade and neutral depth in EQ/stats/report. No browser errors observed during lifecycle checks. No live SoundCloud/PiP or GPU-performance verification; known style-scan warnings remain.

## v6.2.9.4 - subtle fixed glass reflection

- Added the user-approved neutral top reflection, fading from 4% white to transparent by 40% of each outer panel, plus a fine inner light edge. Shared material and document/floating PiP styling now retain modest depth on a uniform charcoal backdrop without restoring colored or opaque surfaces.
- Preserved the supported-browser 54% charcoal base, 20px backdrop blur, blue accent and low-alpha inset surfaces. Same backup file/name, UI metadata **6.2.9.4**, private 6.2.9 audio basis; original Abox release remained byte-identical.
- Syntax and private regression suite passed. Actual player/sidebar/EQ functions rendered in a Chromium fixture on flat charcoal and patterned backdrops, with a 390px expanded-player inspection; search, history/queue switching and crossfade expansion exercised without browser errors. No live SoundCloud/PiP or GPU-performance claim; known style-scan resize-handle/hidden-artwork warnings remain.

## v6.2.9.3 - visibly transparent charcoal UI backup

- Corrected stacked opacity after the user reported that the scenery still could not be seen through the glass. Replaced the 91%-opaque blue-black shell and colored lighting gradients with neutral `rgba(9,10,12,.54)` and `blur(20px)`; inset materials now use low-alpha neutral fills instead of dense colored layers.
- Removed the hub artwork wash and opaque/tinted masking assignments; thumbnail artwork remains. Typical shell-plus-inset transmits approximately 42% of the backdrop by calculated alpha composition. Modal scrims no longer darken away the scenery; unsupported backdrop-filter retains a readable opaque fallback.
- Unified fixed control accents to blue `#6b9eef`, without purple/blue surface tint. Same backup file/name, UI metadata **6.2.9.3**, private 6.2.9 audio basis. Original Abox script remained byte-identical; replace the UI backup and reload SoundCloud.
- Syntax and private regression suite passed. Actual player/sidebar/EQ/stats/report functions rendered in Chromium fixtures; patterned dark and bright 390px scenes visibly showed through the panels. Search, tabs, crossfade collapse/profile selection and warm-artwork accent stability exercised without browser errors. No live SoundCloud/PiP or low-spec GPU verification; known style-scan resize-handle/hidden-artwork warnings remain.

## v6.2.9.2 - darker, cool-accent UI backup

- Unified the UI backup's interaction accent to subdued periwinkle `#a6b6ea`, including player, queue, sliders/switches, EQ, reports/help and PiP presentation. Pale filled controls use dark foregrounds. Semantic warnings, faults and destructive actions retain their distinct colors.
- Darkened smoke-glass shell, inset surfaces, gradient lighting, rims and artwork ambience while retaining backdrop blur and translucency. Removed artwork-driven interface recoloring and its obsolete helpers; artwork itself remains visible without changing the cool control palette.
- Same UI-backup file/name, metadata version **6.2.9.2**, private 6.2.9 audio basis. Original Abox release remained byte-identical. Replace the installed UI backup and reload SoundCloud; keep other True Shuffle copies disabled.
- Syntax, private regression suite and default stable suite passed. Updated the shared PiP waveform fixture for the UI palette lookup and replaced literal-color assertions with played/upcoming waveform partition invariants, retaining stable compatibility.
- Chromium fixture: dark desktop and bright 390px surfaces inspected; warm orange artwork could not recolor controls; queue search, tabs, crossfade expansion/profile selection, EQ, stats and report exercised without browser errors. No authenticated SoundCloud playback, live PiP or low-spec GPU verification; style scan retains the known resize-handle/hidden-artwork warnings.

## v6.2.9.1 - smoke-glass UI backup

- Refined `dist/SC Trueshuffle UI Backup 6.2.9.user.js` against the user's Neverlose material reference after the initial transparent graphite treatment was reported as visually indistinguishable. Cool near-black layered shell, visibly plum-tinted inset controls, soft light edges and diffuse shadows replace the flat material; existing layout and orange/artwork accent remain.
- Increased outer-panel backdrop blur to 32px; inner cards use translucent material layers without redundant nested backdrop filters. The treatment covers player, queue, EQ, stats, reports, context menus, toast and floating/document PiP presentation. Native video PiP still cannot blur the external desktop.
- Same userscript name and file, metadata version **6.2.9.1** to distinguish the UI revision. Audio code remains based on private 6.2.9; the original Abox release remains byte-identical. Replace the installed UI backup, disable other True Shuffle scripts, then reload SoundCloud.
- Syntax and private regression suite passed. Actual UI functions rendered in a local Chromium fixture on dark desktop and bright 390px backgrounds; search, history/queue tabs, crossfade expansion/profile selection, EQ, stats and report exercised, no browser errors. No authenticated SoundCloud playback, live PiP or low-spec GPU verification. Style scan retains the previously documented resize-handle/hidden-artwork warnings.

## v6.2.9 - separate UI backup

- Added `dist/SC Trueshuffle UI Backup 6.2.9.user.js`, copied directly from the private 6.2.9 release, with a distinct userscript name. The original Abox artifact, stable 6.2.5 and build inputs remain unchanged; no publication.
- Refined existing player, queue, EQ, stats and report surfaces: graphite backgrounds, more readable secondary text, restrained shadows, quieter active controls and consistent keyboard focus. Playback, HLS, scheduling and PiP logic are unchanged.
- UI backup glass refinement: shared translucent dark tint and 22px backdrop blur on player, queue, EQ, stats, context menus and report/help dialogs; translucent inner controls without stacked per-row blur. Hub artwork layers no longer obscure the page backdrop. Floating/document PiP receives matching glass styling; native video PiP cannot blur the surrounding desktop. Unsupported backdrop-filter uses a denser readable tint.
- Glass verification: syntax and private regression suite passed; Chromium fixture confirmed real computed translucency/blur for player, queue, EQ, stats and report, exercised search/history/crossfade and inspected bright desktop/dark 390px surfaces without browser errors. Original private 6.2.9 remained byte-identical. No authenticated SoundCloud, live PiP or low-spec GPU-performance claim.
- Enable only one True Shuffle userscript at a time. The UI backup shares existing settings/storage; its separate installation identity does not isolate preferences.
- Verification: JavaScript syntax passed; private Node suite passed 131/131 runner results. Actual player/sidebar/EQ/stats functions rendered in a Chromium fixture; queue search, history/queue switching and crossfade expansion exercised, with desktop and 390px layout inspection. No authenticated SoundCloud playback or Abox VM verification.
- Style scan reports inherited resize-handle width/height transitions and initially hidden PiP artwork elements; artwork sources are supplied dynamically, not shipped as broken visible images.

## v6.2.9 - private pre-release

- Feedback recorded 2026-10-23 (documentation date, not a supplied test date): the user relayed that Abox said private 6.2.9 fixed the reported audio artifacts on his VM. This completes the feedback wait for this report; no further audio fix is open for it. No new raw playback report or PCM capture was attached, and this was not directly observed by the assistant. Duration and scenarios were not supplied. This is not a new release, universal guarantee, UI6.2.9.15 certification or new Firefox/Safari validation; existing UI limits remain independent. Stable6.2.5 and private artifacts stay separate; no migration/publication without explicit instruction.

### Bounded, Firefox-safe crossfade scheduling

- New private artifact: `dist/SC Trueshuffle HLS Pre-release 6.2.9.user.js`. Keep canonical/stable 6.2.5 and the previous private 6.2.8 comparison unchanged; no rebuild or publication.
- Replace 256 per-fade ramp submissions with paired, shared-knot linear automation: Clean uses 6 total native automation calls, Smooth 100, DJ 104, versus 260 previously. Clean remains exact; nonlinear interpolation differs from the analytic profiles by at most 0.00051 absolute gain, retaining complementary gains/endpoints and DJ clamp breakpoints.
- Compute the plan before selecting the start time. Use monotonic elapsed time alongside the AudioContext clock so Firefox's task-frozen `currentTime` cannot hide time spent preparing/submitting automation.
- Reserve up to 128 ms inside the existing overlap window, capped to half the remaining window. Keep the end bounded by outgoing media remaining and the incoming half-duration budget. The active ramp is intentionally shorter: a fresh 250 ms window has 125 ms lead and 125 ms ramp, rather than gaining extra overlap or dropping one bumper fade.
- Reanchor across suspended-context startup and pause/resume generations. If the window is exhausted, reuse the existing handoff recovery to retain the incoming track instead of treating it as a failed track.
- Retain cancelable linear ramps: actual Firefox still rejects new automation during active `setValueCurveAtTime` events even after cancellation. Add no playback timer, worker, stream, HLS buffer increase or graph node.
- Replace the misleading report field `schedulingLeadMs` with `sampledSchedulingLeadMs`, measured `schedulingSubmissionMs` and wall-compensated `estimatedSchedulingLeadMs`. A positive estimate is not proof of delivery to the render thread.

### Verification and limits

- Syntax passed; private suite 131/131 and default invocation 129/129 Node runner results, zero failures.
- Online Firefox 158/Windows AudioWorklet PCM comparison: three profiles × 5/0.6/0.25-second windows × normal/1 ms per-native-call cost, 18 cases per build. Baseline 6.2.8 had 8 detected discontinuities; 6.2.9 had none, with every capture valid, reference continuous and fade completed. Each build was compared with its own expected interpolated trajectory; profile approximation accuracy is checked separately.
- Additional 180 ms pre-clock blocked-task comparison: both baseline cases had discontinuities; both candidate cases had none.
- Real local AAC-160 HLS through pinned Hls.js 1.7.3 and two Firefox media decks: long → six-second bumper → long completed both fades for Smooth/Clean/DJ. A 3.4-second midfade pause preserved media/audio clocks and resumed successfully; stop/abort could not mutate reused decks after the old completion boundary.
- These bounded scheduling and synthetic local-media proofs alone are not authenticated SoundCloud playback, physical output loopback or confirmation that Abox's Ubuntu VM is free of artifacts; the later user-relayed positive VM feedback above is separate evidence. Arbitrary interruptions can exceed any finite lead.

## v6.2.8 - private pre-release

### Resource-neutral low-spec playback

- Keep the stable userscript and GreasyFork release unchanged; the test artifact is `dist/SC Trueshuffle HLS Pre-release 6.2.8.user.js`.
- Reconcile unchanged player controls, clocks, progress, sleep displays and PiP state instead of repeatedly replacing the same DOM content. Reuse mounted queue rows while rebinding index-dependent actions after queue consumption/reordering; batch new queue/history rows and reconcile playlist badges.
- Reuse unchanged EQ/Auto Level routing without disconnecting and reconnecting the audio graph. Keep gain targets, processing options and media-volume reconciliation intact.
- Retain valid same-target HLS warmup/standby work across unrelated queue refreshes. Share exact matching pending deck preparations with foreground playback, transferring ownership while preserving abort, metadata and playback-session checks.
- Preserve two audio decks, stream-quality ordering, HLS buffer configuration, existing preflight concurrency and live-sync cadence; add no playback timer or worker.

### Lightweight transition report

- Keep version 6.2.8 and the same private artifact. Enable event-only transition observations while leaving verbose `DIAGNOSTIC_BUILD` disabled.
- Reuse the existing 80-entry in-memory ring and sanitizer. Record preparation/reuse/promotion/cancellation, stream-resolution completion, HLS manifest/first-fragment download/first-fragment buffering, media waiting/stalled/playing, actual fade scheduling/completion or no-mix fallback, and conspicuous watcher-tick gaps. Milestones are once per HLS player; repeated media/error/delay observations are rate-limited.
- The Hub's neutral **Playback report** button is available without a fault, including after Stop. Copy soon after an audible issue and before reloading; **Clear** empties the report but leaves manual access available. Timings are observations, not automatic silence detection or proof of a CPU bottleneck.
- Store no titles, artists, account/page paths, stream URLs, query strings, credentials or exception text. Add no persistence, automatic transmission, timer, worker, media stream or buffer change.
- Browser smoke with real local AAC HLS, 4× CPU throttling, a 2,000-row queue, delayed media responses and an injected 450 ms main-thread block captured the manifest/download/buffer/fade timeline and a 457.6 ms watcher gap without raising a fault. Both fades completed; resource counts matched the no-logging control: two decks, three HLS loads, peak three HLS instances, 23 media requests and no live HLS instance after Stop. The manual report retained 70 events; Copy/Clear and private-marker exclusion were exercised through the mounted browser UI.

### Targeted crossfade-clock measurements

- Abox confirms that 6.2.8 removes the loading gaps on his Firefox/Linux VM, but reports brief pops/crackles during crossfades generally. The report does not prove CPU overload or an audio-buffer underrun; no speculative playback fix is applied.
- Extend `fade-scheduled` with signed `schedulingLeadMs`, sampled immediately after both gain-automation submissions. Later Firefox testing showed this clock can remain frozen within a task: a positive reading does not establish timely submission. The field is replaced in 6.2.9.
- Capture incoming media time before `play()` and after scheduling. Emit at most one `incoming-clock-progress` observation per fade through the existing 80 ms schedule poll, distinguishing progress already present at scheduling from progress observed later. Export baseline/scheduled/current media seconds, media advancement, monotonic observation elapsed time and signed audio-clock offset from fade start.
- Discard pending observations on pause, seek/rewind, deck reset, cancellation or lost ownership. Keep the existing ring/privacy limits; add no timer, worker, stream, buffer or fade/readiness behavior change. Sampling delays are not exact startup latency or proof of audible output.
- Verification: private suite 115/115 and default invocation 113/113 Node runner results, zero failures; private syntax check passed. Live Chromium smoke with two WAV-backed HTMLAudioElements and a running AudioContext completed the actual fade scheduling/polling path and emitted one progress event. A deliberate 120 ms post-submission block produced a signed lead of −105 ms and still completed the fade. This was not a SoundCloud HLS, Firefox VM or audio-loopback reproduction.

### Measured scope

- Synthetic Chromium fixture at 4× CPU throttling: 100 unchanged player refreshes produced zero hub DOM mutation records versus 3,500 in 6.2.7; an unchanged 2,000-row queue refresh retained all rows and scroll position instead of rebuilding them.
- Real AAC HLS fixture: 14-second track → 6-second bumper with 300 ms encoded leading silence → 14-second track, configured 5-second crossfade, open 2,000-row queue, recurring 150 ms main-thread blocks and an unrelated queue refresh during the first fade. Both candidate transitions entered mixing; the 6.2.7 control omitted the second fade. HLS constructions/loads decreased from four to three and media requests from 25 to 23; peak HLS instances stayed at three, with two audio decks and zero live HLS instances after Stop.
- These are controlled local-stream measurements, not authenticated SoundCloud playback or proof that Abox's Ubuntu VM is fully fixed. No release was published.
- Smooth, Clean and DJ each completed both HLS transitions in separate loaded-browser runs and released every HLS instance on Stop.
- Matched 2,000-row browser fixtures after garbage collection retained the same DOM/listener counts, with candidate JavaScript heap slightly lower (3,693,008 versus 3,765,572 bytes). After 40 queue-head advances, the candidate released the expected 680 retired DOM nodes and 360 listeners; no detached-row cache is kept.

### Regression verification

- Passed all eleven test files with the private-build flags (`TSS_SCRIPT="dist/SC Trueshuffle HLS Pre-release 6.2.8.user.js" TSS_EXPECT_SPLIT_FADE=1 TSS_EXPECT_IMMEDIATE_PREFETCH=1 node --test tests/*.test.js`): 95 Node test-runner results, zero failures. The default test invocation also passes (93 runner results; stable reserve policy remains unchanged).
- Added 18 behavior regressions for preparation ownership/reuse, stale metadata/session cancellation, graph settings and queue actions after row reuse. Seven fail against 6.2.7 and pass against 6.2.8. Updated extracted-function/browser DOM fixtures; removed obsolete source/copy assertions that incorrectly equated a private test artifact with the canonical build.
- Added nine transition-report cases covering privacy/ring limits, no-fault manual access and Copy/Clear, lookup/readiness separation, preflight adoption and bounded media/HLS observations, and contextual watcher delays/natural-end/no-mix reporting.
- The private userscript passes `node --check`; no canonical rebuild or publication was performed.

## v6.2.5 - 2026-10-20

### Adaptive short-track fades

- Reserve six seconds of a short incoming track for preparing the following track; shorten or omit its fade-in while preserving the configured fade for longer tracks.
- Keep the existing readiness gate and natural-end fallback; no third audio/HLS deck is created.

### Verification

- All 66 `node --test` tests pass. Production and diagnostic builds pass syntax checks and watcher smoke tests.

## v6.2.4 - 2026-10-20

### Short-track prefetch

- Start resolving the following track's stream candidates during the current crossfade and reuse them for standby preparation. Cancel stale work on playback or queue changes; failed speculative resolution falls back to normal preparation.

### Verification

- All 62 `node --test` tests pass. Production and diagnostic artifacts pass syntax checks and crossfade smoke tests.

## v6.2.3 - 2026-10-19

### Privacy-first playback diagnostics

- Enable technical playback diagnostics in the production userscript; keep the separately named diagnostic build available for isolated support installs.
- Correlate playback operations and stream attempts. Capture candidate/request outcomes, HTTP status and latency, stream protocol/quality, HLS/MSE attach/manifest/buffer milestones, media readiness and play results, audio graph/context state, recovery, prefetch, crossfade and native fallback acknowledgement.
- Include coarse browser family/major version, OS family, userscript manager/version, page category, capability flags, numeric queue/deck indices and allowlisted technical state only.
- Sanitize all report and console entries with a strict field allowlist. Exclude titles, account names, page paths, media/stream URLs, query strings, client IDs, authorization values and exception text. Reports are session-memory only; no telemetry or automatic transmission.
- Add regression coverage that verifies sensitive/arbitrary text and URLs are dropped while technical status, timing, error classes and playback state remain available.

### AAC HLS custom-deck playback

- Prefer progressive streams when available; otherwise resolve AAC HLS manifests and load them into True Shuffle's two-deck player with pinned hls.js 1.7.3.
- Keep Web Audio processing, Auto Level, EQ, safety clipper and crossfade active for HLS playback. Use SoundCloud native session playback only for previews or when custom HLS/MSE startup cannot run.
- Invalidate standby decks after post-readiness fatal HLS errors; suppress crossfade readiness, show the fallback state, and refresh the deck before a later foreground handoff.
- The supplied reports showed successful API lookups but zero progressive candidates; the reports alone do not establish whether HLS metadata was absent, unavailable, or failed later. The expanded trace now records the candidate and startup stages needed to distinguish those cases.

### Verification

- Rebuilt both release artifacts; `node --check` passed for the source and generated userscripts, and the canonical artifact byte-matches the source.
- Passed all 62 `node --test` tests, including HLS request tracing, privacy redaction, recovery, crossfade, native fallback and post-readiness standby failure refresh.
- Synthetic Chromium smoke loaded the production artifact, mounted the styled hub, triggered the fault report, and exercised Copy/Clear; injected title, page-path, stream-URL and credential sentinels were absent from the displayed and copied report.
- Authenticated SoundCloud playback was not live-tested; the supplied reports still do not establish a single confirmed root cause.



## v6.2.2 - 2026-09-11

### Long queue scrolling

- Preserve the queue's scroll position during background playlist refreshes, queue edits and playback advances instead of repeatedly scrolling back to the playing track.
- Keep current-track navigation when returning from History or clearing search; changed searches start at the top of their results.
- Added scrolling regressions that fail with the old renderer. Passed all nine regression files and JavaScript syntax validation.
- Verified the production sidebar renderer in a Chromium fixture with 2,000 tracks: repeated refreshes preserve distant scroll positions, and slow scrolling across a 10-second refresh reaches the last track without jumping backward. This was not an authenticated SoundCloud session.

## v6.2.1 - 2026-09-04

### Collaborator names and merged playlist updates

- Match SoundCloud's artist byline by preferring publisher artist metadata over the uploader name, preserving collaborator names.
- Recover missing artist names from playlist metadata even when every track is already rendered on the page, without overwriting useful DOM metadata.
- Keep automatic updates active for every merged playlist instead of only the most recently merged source.
- Track shared playlist membership so tracks are queued once and remain available until removed from their last source.
- Preserve the current track during updates and reject stale responses after stopping or replacing the queue.

### Playback and lifecycle bughunt

- Bound network requests, response-body decoding, media playback and audio-context operations so a never-settling promise cannot permanently lock the controls.
- Give foreground operations, deck preparation and recovery explicit ownership; stopping or replacing a session prevents old callbacks from resetting, pausing or publishing its replacement.
- Keep Stop Shuffle and Cancel loading visible and usable during pending work, release state before teardown, and retain access to playback reports after Stop.
- Rebuild failed or closed Web Audio contexts together with their bound media elements; a failed resume remains retryable from Play or Next.
- Recover frozen playback at startup and near track boundaries, cap recovery attempts, and preserve intentional pause and newer seek requests through delayed recovery.
- Detect failed or silent background workers, install one timer fallback, and release worker, timer and listener resources on stop.
- Rotate rejected client IDs without globally blacklisting a valid ID for a track-specific authorization failure; expire and bound the signed-stream cache.
- Require exact native track identity before accepting a preview fallback as successful playback.
- Cancel stale collection work across navigation, preserve merged sources and Play Next through cache restoration, and reconcile removals, re-additions, history and round totals without duplicate replay.
- Clear warmed decks when replacing the metadata universe, but preserve current-track identity during merges so playback recovery continues.
- Isolate storage failures, sanitize diagnostic snapshots and stored statistics and loudness measurements, preserve unsaved statistics deltas, and expose failed EQ preset persistence for retry.
- Relearn Auto Level after EQ changes and initialize audio processing when only the safety clipper is enabled.
- Dispose late PiP acquisitions and stale menu listeners, resolve queue actions by identity, and make native player bridge installation and MediaSession restoration ownership-safe.

### Native autoplay and comment cleanup

- Install the native playback guard at document-start, before SoundCloud can restore playback; defer DOM-dependent UI and navigation setup until the document is ready.
- Block native autoplay and transport starts even when True Shuffle is idle or stopped. Permit only the current explicitly selected native fallback, preserving its pause/resume controls.
- Recheck fallback permission before deferred cleanup and stop failed or revoked native fallbacks without letting stale requests pause a newer session.
- Revoke native fallback ownership when navigating to an unrelated collection instead of allowing the watcher to restore a suspended native session.
- Remove redundant banners, obsolete version notes and comments that restate the code across project-owned sources. Retain userscript metadata and useful browser, concurrency and algorithm rationale; leave vendored skills and historical generated releases untouched.

### Current-session diagnostics and browser compatibility

- Keep diagnostic events only in memory for the current page session; remove previously saved diagnostic data without loading it, and never persist new reports.
- Replace the full-width report/history control with a red exclamation icon beside PiP. It appears only after a new failure, remains accessible after Stop, and disappears on Clear or reload.
- Add a separate How to report tutorial covering copying before reload, browser/userscript-manager details and reproduction steps, with a direct new-tab link to this script's Greasy Fork feedback page and a public-posting privacy reminder. Include keyboard focus containment, Escape and return-to-report behavior.
- Replace the Firefox-only report subtitle with browser-neutral diagnostics.
- Capture the Copy report button before awaiting clipboard access so both success and rejection can update the control after DOM event dispatch ends.
- Document Tampermonkey and Violentmonkey compatibility targets, Safari manager availability, and capability-based PiP/background fallbacks without claiming every combination has been tested.

### Verification

- Passed all nine regression files with `node --test`, including playback lifecycle, deadlines, clock recovery, queue lifecycle, interface lifecycle and audio persistence.
- Passed JavaScript syntax validation.
- Verified artist-name recovery and music-to-bumpers merge updates in a metadata-only Chromium fixture.
- Exercised real Chromium audio playback with a generated WAV: canceled a never-settling playlist response body, restarted playback, closed the active AudioContext, and verified Next rebuilt a new running context with advancing media time and a nonzero measured audio signal.
- Verified Stop-to-Start recovery and current-session report access after Stop.
- Verified legacy-data removal, a hidden initial indicator, red header icon placement, a separate reporting tutorial, keyboard focus/Tab/Escape, Clear and a new failure, and a clean real page reload in Chromium. Visually checked the player and tutorial at desktop and 360-pixel viewport widths.
- Exercised asynchronous Copy report with real DOM dispatch and a controlled clipboard promise; regression coverage also checks successful and rejected clipboard access.
- Verified full userscript initialization before a document root existed in Chromium, then actual playlist opening/navigation/reload with generated WAV media: native audio stayed paused while marked private audio could play. The real native fallback path played, respected pause/resume, stopped on navigation or failed acknowledgement, and remained blocked after Stop and reload.
- Compared comment-cleanup changes against pre-cleanup executable output; no executable changes resulted from comment removal. Updated test fixtures to use code boundaries rather than a removed comment marker and to include the shared native-permission predicate.
- Browser verification used fixture metadata, not an authenticated SoundCloud account. Native Firefox runtime and its protected window compartments were not exercised; the original reported incident cannot be uniquely identified without its diagnostics.

## v6.1.9 - 2026-08-09

### Unmarked bumper distribution

- Evenly spread repeated unmarked bumper titles, such as `24.7 Jam Radio`, across the complete shuffled round.
- Fixed queues that alternated bumpers near the beginning but left a long music-only tail.
- Kept `[TSS-BUMPER]` support for grouping differently named station IDs without hardcoded names or track IDs.

### Verification

- Added a 107-track regression scenario with 28 identical unmarked bumpers and 79 unique music tracks.
- Limited every bumper-free run in that scenario to at most three music tracks.
- Passed the complete True Shuffle regression suite against both the canonical and built userscripts.

## v6.1.8 - 2026-08-09

### Bumper distribution

- Spread `[TSS-BUMPER]` tracks evenly across the complete shuffled round instead of alternating them only until the bumper playlist runs out.
- Preserved the no-back-to-back guarantee whenever enough non-bumper tracks exist, including at automatic round boundaries and after playlist merges.

### Verification

- Added a regression scenario matching 107 bumpers merged into 193 music tracks and limited every bumper-free run to at most two music tracks.

## v6.1.7 - 2026-08-08

### Shuffle sources and sequencing

- Added True Shuffle support for current SoundCloud liked-song cards, including lazy-loaded likes collected while scrolling.
- Prevented any tracks with matching normalized titles from playing back-to-back across initial shuffles, merges, re-shuffles, restored queues and automatic round boundaries whenever a valid arrangement exists.
- Added the hidden `[TSS-BUMPER]` title marker so differently named station IDs can share one spacing group without a hardcoded UID list or official UI.

### Verification

- Added regression coverage for general matching-title spacing, multiple duplicate-title groups, hidden-marker grouping across renamed bumpers, impossible layouts and round-boundary separation.
- Passed the complete True Shuffle, crossfade and Firefox audio fallback test suites.

## v6.1.6 - 2026-08-03

### Picture in Picture

- Added a PiP artwork-layout toggle so both the original compact player and a full-picture design remain available.
- Added a larger BSF-style layout with track details above full-width artwork while keeping the waveform and playback controls visible.
- Automatically resized Document PiP and the floating fallback for the selected layout.
- Remembered the selected artwork layout between PiP sessions.
- Loaded higher-resolution artwork for the full-picture layout.
- Kept the queue accessible from both layouts and hid only the compact Up Next row while full artwork is displayed.

### Firefox playback reliability

- Removed active True Shuffle's native SoundCloud playback fallback; SoundCloud audio is now always blocked while True Shuffle owns playback.
- Retained exact SoundCloud track authorization and progressive transcoding metadata for the private audio decks.
- Added ordered progressive-stream candidates, MPEG preference, stale signed-URL eviction and one client-ID refresh after authorization failures.
- Retried failed deck preparation and playback with a freshly resolved stream before deferring the track.
- Deferred an exhausted track to the end of the current round, tried the next custom-playable track, and scheduled a bounded five-second retry if every track was temporarily unavailable.
- Removed hidden SoundCloud route navigation previously used only by the native-player fallback.

### Verification

- Added regression coverage for layout switching, persistence, accessible toggle state, PiP sizing and artwork resolution.
- Added Firefox regressions for native-player exclusion, ordered progressive candidates, candidate failover, authorization forwarding, rejected client-ID replacement and custom-only queue failover.
- Visually verified both layouts at their default dimensions with no overflow in full-picture mode.
- Passed the complete True Shuffle, crossfade and Firefox audio fallback test suites.

## v6.1.5 - 2026-08-03

### Firefox navigation

- Fixed SoundCloud URLs changing while the previous playlist remained visible during active True Shuffle playback.
- Waited for Firefox to replace the old route DOM before reading or rebinding tracks from an internally requested source page.
- Cancelled stale route work immediately when the user navigates somewhere else.
- Prevented delayed True Shuffle injection from mutating SoundCloud's page while a route transition is still in progress.
- Preserved background deck playback and normal SoundCloud link handling during navigation.

### Verification

- Added regression coverage for Firefox history updates that happen before the new route DOM is rendered.
- Added coverage proving ordinary SoundCloud navigation clicks are not intercepted by the native playback guard.
- Passed the complete True Shuffle, crossfade and Firefox audio fallback test suites.

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
