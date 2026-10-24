<div align="center">

<img src="https://img.shields.io/badge/SoundCloud-True%20Shuffle-ff5500?style=for-the-badge&logo=soundcloud&logoColor=white" alt="SoundCloud True Shuffle">

<br/>
<br/>

> **SoundCloud's shuffle is broken. This fixes it.**

<br/>

![Version](https://img.shields.io/badge/version-6.3.0-ff5500?style=flat-square)
![License](https://img.shields.io/badge/license-MIT-orange?style=flat-square)
![Greasy Fork](https://img.shields.io/badge/Greasy%20Fork-install-brightgreen?style=flat-square&logo=tampermonkey)
![Works in background](https://img.shields.io/badge/background%20tab-✓-ff5500?style=flat-square)

</div>

---

## The problem

SoundCloud's built-in shuffle only randomizes the **first ~20 tracks** that happen to be loaded on the page. If your playlist has 100+ songs, you'll hear the same ones over and over. On top of that, the player breaks when the tab is in the background — so if you're gaming or doing anything else, it just stops.

## What this does

- **Loads your entire playlist** before doing anything — no tracks get skipped
- **Fisher-Yates shuffle** — genuinely random, not fake random
- **Background playback supervision** — worker heartbeat, timer fallback and audio-clock stall recovery
- **Round-based shuffle** — every track plays once before a fresh round is generated
- **Modern floating player** — artwork, real waveform, queue, history, stats and sleep timer
- **Two-deck audio engine** — progressive and AAC HLS playback in True Shuffle's own decks; previews and HLS/MSE startup failures use exact-track SoundCloud fallback
- **DJ-style crossfade** — adjustable duration and Smooth, Clean or DJ transition curves
- **5-band equalizer** — built-in presets, a visual editor and persistent custom presets
- **Auto Level** — evens out large volume differences between tracks and remembers learned levels
- Works on playlists, likes, tracks, reposts and the SoundCloud Feed

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/get-it/) where available for your browser. For Safari, use Tampermonkey.
2. Click **[Install the canonical GitHub build](https://raw.githubusercontent.com/mrketa/soundcloud-true-shuffle/main/dist/SC%20Trueshuffle.user.js)**. This link follows the current public build on `main`.
3. Confirm installation, disable any other True Shuffle copies, then reload SoundCloud.

[Greasy Fork](https://greasyfork.org/en/scripts/568821-soundcloud-true-shuffle) also serves **6.3.0**, as reported by the maintainer. It remains a separately managed installation/feedback channel; this report was not independently checked against its live source.

**[Release v6.3.0](https://github.com/mrketa/soundcloud-true-shuffle/releases/tag/v6.3.0)** was published on **2026-10-24 at 02:49:21 UTC** from commit [`c7474d9`](https://github.com/mrketa/soundcloud-true-shuffle/commit/c7474d9ce308d529204bde6f6b018365b18f1050). It is public, neither draft nor prerelease. It was originally created without attachments; the current GitHub API shows one subsequently added asset, **[SC.Trueshuffle.user.js](https://github.com/mrketa/soundcloud-true-shuffle/releases/download/v6.3.0/SC.Trueshuffle.user.js)** (564892 bytes). GitHub's automatic source archives are separate. The fixed **[v6.3.0 userscript](https://raw.githubusercontent.com/mrketa/soundcloud-true-shuffle/v6.3.0/dist/SC%20Trueshuffle.user.js)** also remains available.

> Designed for current mainstream browsers, not just Firefox. See browser support below for manager availability and capability differences.

## Usage

Navigate to a supported SoundCloud playlist, library page or Feed. The floating **True Shuffle** player appears in the lower-left corner.

- Click **Start shuffle** to load every available track and begin a shuffled round.
- The native SoundCloud player stays paused, including on playlist open/reload and after ending a session. Only an explicitly selected True Shuffle native fallback may play through it; True Shuffle's own audio decks are unaffected.
- Use **Cancel loading** to abandon a stalled load. During playback, open **Settings → Session → End shuffle session** to stop; session controls remain usable while work is pending.
- Click **Reshuffle**, directly beside **Queue**, to reshuffle upcoming tracks without reloading the page.
- Open **Queue** to search, reorder, merge playlists or view listening history. **Merge playlist** and **Close queue / Back to player** share its compact title row.
- Merged playlists keep updating automatically: new tracks from each source enter the upcoming queue once, without interrupting the current track.
- Restoring a cached queue preserves merged sources, history and Play Next requests.
- Adjust the master output level in the player. Open the header's **Settings** gear for **Audio / Session / Info** tabs; the back arrow returns to playback.
- **Audio:** choose crossfade duration, Smooth/Clean/DJ profile and **Fade manual skips**; toggle **Auto Level** or **Open equalizer** for presets and a custom five-band curve. Custom EQ presets use userscript storage.
- **Session:** set a sleep timer, enable **Stop after this round**, or end the shuffle session.
- **Info:** view listening statistics and set **Reduce visual effects** or **Scroll long titles**.

**Reduce visual effects** is a manual, locally saved preference, off by default. It replaces the main glass with dense charcoal and removes owned blur and nonessential motion; it does not change audio quality, crossfade automation, deck count or HLS buffers, and it does not automatically detect weak hardware. **Scroll long titles** is saved separately and on by default: overflowing PiP player titles can scroll with reduced effects on, or remain still with effects off. Queue/short titles stay still. The system's reduced-motion preference always prevents the title animation. Blocked storage can prevent either preference from surviving reload.

## Playback recovery and reports

Network requests, response bodies and audio startup have deadlines. Playback operations release their controls after failure; stale callbacks cannot overwrite a newer session. Frozen playback has a bounded recovery budget, and failed or closed audio contexts are rebuilt with fresh audio elements.

If playback stalls, use **Cancel loading** or **Settings → Session → End shuffle session**, then start True Shuffle again. A classified playback fault reveals a **red exclamation mark next to PiP** in the player header, including after ending the session. Ordinary transition observations do not reveal it; audible clicks or silence without a classified fault do not automatically reveal it either. Click it, then choose **Copy report** for readable, privacy-filtered text capped at **1,800 characters**. **Full technical details (optional)** offers sanitized JSON through the separate **Copy full report** action; opening it does not change the short copy. If clipboard access is blocked, the dialog explains manual Ctrl+C/Cmd+C copying and selects the text where supported. Reports exist only in memory: reloading or closing the page discards them, and previously saved diagnostic data is removed on initialization. **Clear** removes the current report and hides the fault indicator until another fault.

Choose **How to report** in the report dialog for a separate short tutorial. Copy the report before reloading, then use its direct link to [Greasy Fork feedback](https://greasyfork.org/en/scripts/568821-soundcloud-true-shuffle/feedback). Sign in if needed and start a new discussion with the report, the steps you took, and what happened instead of the expected result. Feedback is public. Reports contain the browser family/major version, OS family, userscript manager/version, page category, playback state, numeric indices, and sanitized request/media/audio diagnostics. They exclude track titles, account names, page paths, media or stream URLs, query strings, credentials, and exception text. Nothing is sent automatically; review the report yourself before posting.

The production script keeps lightweight transition observations active by default (`_transitionDiagnostics=true`) while verbose diagnostic tracing is off (`DIAGNOSTIC_BUILD=false`). It uses the bounded 80-event in-memory ring and retains the latest fault's context and nearby events across Stop/ring rollover; no persistent logs or telemetry are added. For a standalone support install, run `python build.py --diagnostic`: it writes `dist/SC Trueshuffle Diagnostic.user.js`, named **SoundCloud True Shuffle (Temporary Diagnostic)**, with the **same canonical version, 6.3.0**, and verbose tracing explicitly enabled (`DIAGNOSTIC_BUILD=true`). Disable every other True Shuffle copy before enabling it; the distinct name does not isolate shared preferences.

Reports capture candidate outcomes, request status/timing, stream protocol/quality, HLS/MSE milestones, media readiness/play results, audio-context/graph state, prefetch, crossfade, recovery, and native fallback. URLs, titles, account/page paths, credentials, and full exception messages are not recorded. The report stays local until you choose **Copy report**.

SoundCloud deprecated progressive HTTP streams in favor of AAC HLS after 2025. True Shuffle resolves the signed HLS manifest and plays it through the existing two-deck player with its crossfade and audio processing; pinned hls.js 1.7.3 supplies MSE playback. Native SoundCloud fallback is limited to previews or HLS/MSE startup failures, where crossfade and audio processing are unavailable. See [SoundCloud's streaming migration](https://developers.soundcloud.com/blog/api-streaming-urls/).
Unavailable browser storage does not prevent playback or volume changes. Custom EQ presets that could not be saved show an unsaved state rather than falsely acknowledging persistence.

## How it works

```
1. Scroll to bottom of page repeatedly until all tracks are loaded
2. Collect all track elements
3. Fisher-Yates shuffle → build a queue
4. Resolve the selected track and play it through True Shuffle's two-deck audio engine
5. Apply output level, Auto Level, equalizer and optional crossfade
6. Coordinate track changes with a supervised worker and the audio clock
7. Recover stalled custom playback; acknowledge the exact requested track in SoundCloud-session fallback
8. When the round is exhausted → generate a new balanced round
```

## Browser support

Compatibility targets are current Chrome, Edge, Brave, Opera, Firefox and Safari:

| Browser family | Userscript manager |
|----------------|--------------------|
| Chromium: Chrome, Edge, Brave, Opera | Tampermonkey or Violentmonkey, where supported by the browser/manager version |
| Firefox | Tampermonkey or Violentmonkey |
| Safari | Tampermonkey |

Optional features use capability checks rather than browser-name gating. PiP uses a separate document window where available, otherwise video PiP or an in-page mini-player; these modes do not provide identical controls or window behavior. Owned document/inline PiP surfaces stay opaque near-black regardless of the effects preference. CSS cannot change native OS window chrome, and native video PiP cannot blur the surrounding desktop. Worker failures fall back to a timer, but browser or operating-system suspension can still interrupt background work. Page-script integrations also depend on the manager's injection mode and site policy.

These are compatibility targets, not a claim that every browser/manager combination has been runtime-tested. Public 6.3.0 passed syntax checks and **164 tests, zero skips and zero failures** for each of canonical source, public distribution and diagnostic distribution. The standard build was byte-identical to canonical source, and its code body matched the verified UI .19 revision.

Actual built-public Chrome fixtures exercised real local WAV playback through the audio graph, pause/resume, independent title scrolling with reduced effects on, dark native Document PiP and exact native-clipboard copying of a 718-character fault report without replacing the playing deck/context. Firefox 158 fixtures exercised the built-public UI, PiP marquee and exact native-clipboard copying of a 484-character fault report. Both completed without browser errors; fixtures were cleaned. These controlled checks are not authenticated SoundCloud playback, userscript-manager integration, Abox-VM or Safari certification.

## Build and regression commands

`python build.py` copies the canonical `SC Trueshuffle.js` verbatim to `dist/SC Trueshuffle.user.js`. Never target an archived private or UI-backup file with `--output`; those are preserved comparison artifacts, not build destinations. The diagnostic command above changes the standalone identity and verbose flag, not the version.

`node --test tests/*.test.js` targets the current canonical source without private expectation flags. `TSS_SCRIPT` remains an explicit source/artifact override. Fade-policy and immediate-prefetch expectations use the selected script's metadata-version release contracts: half-duration budgeting from 6.2.6 and immediate prefetch from 6.2.7.

## Release notes

GitHub release descriptions contain only a concise, user-facing changelog in English. Keep installation instructions, test/build reports, attachment notes and internal workflow details in project documentation, not in the release description.

## License

MIT
