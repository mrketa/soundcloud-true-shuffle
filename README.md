<div align="center">

<img src="https://img.shields.io/badge/SoundCloud-True%20Shuffle-ff5500?style=for-the-badge&logo=soundcloud&logoColor=white" alt="SoundCloud True Shuffle">

<br/>
<br/>

> **SoundCloud's shuffle is broken. This fixes it.**

<br/>

![Version](https://img.shields.io/badge/version-6.1.3-ff5500?style=flat-square)
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
- **Two-deck audio engine** — direct playback, with exact-track SoundCloud fallback for preview/access-limited tracks
- **DJ-style crossfade** — adjustable duration and Smooth, Clean or DJ transition curves
- **5-band equalizer** — built-in presets, a visual editor and persistent custom presets
- **Auto Level** — evens out large volume differences between tracks and remembers learned levels
- Works on playlists, likes, tracks, reposts and the SoundCloud Feed

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/get-it/) where available for your browser. For Safari, use Tampermonkey.
2. Click **[Install from Greasy Fork](https://greasyfork.org/en/scripts/568821-soundcloud-true-shuffle)**
3. Done

> Designed for current mainstream browsers, not just Firefox. See browser support below for manager availability and capability differences.

## Usage

Navigate to a supported SoundCloud playlist, library page or Feed. The floating **True Shuffle** player appears in the lower-left corner.

- Click **True Shuffle** to load every available track and begin a shuffled round.
- The native SoundCloud player stays paused, including on playlist open/reload and after Stop. Only an explicitly selected True Shuffle native fallback may play through it; True Shuffle's own audio decks are unaffected.
- Click **Cancel loading** to abandon a stalled load, or **Stop Shuffle** to end playback. Both remain usable while work is pending.
- Click the shuffle icon in the header to re-shuffle the loaded playlist without reloading the page.
- Open the queue icon to search, reorder, merge playlists or view listening history.
- Merged playlists keep updating automatically: new tracks from each source enter the upcoming queue once, without interrupting the current track.
- Restoring a cached queue preserves merged sources, history and Play Next requests.
- Use the EQ button for presets or a custom five-band curve. Custom presets stay saved through userscript storage.
- Adjust the global output level from the player and enable Auto Level if tracks vary heavily in loudness.
- Open the Crossfade panel to choose a duration and transition style.
- Enable **Stop after this round** if playback should end after every track has played once.

## Playback recovery and reports

Network requests, response bodies and audio startup have deadlines. Playback operations release their controls after failure; stale callbacks cannot overwrite a newer session. Frozen playback has a bounded recovery budget, and failed or closed audio contexts are rebuilt with fresh audio elements.

If playback stalls, use **Stop Shuffle** or **Cancel loading**, then start True Shuffle again. A new playback failure reveals a **red exclamation mark next to PiP** in the player header, including after Stop. Click it to open the current report, then choose **Copy report**. Reports exist only in memory: reloading or closing the page discards them, and previously saved diagnostic data is removed on initialization. **Clear** dismisses the current report and error indicator.

Choose **How to report** in the report dialog for a separate short tutorial. Copy the report before reloading, then use its direct link to [Greasy Fork feedback](https://greasyfork.org/en/scripts/568821-soundcloud-true-shuffle/feedback). Sign in if needed and start a new discussion with the report, your browser/version, Tampermonkey or Violentmonkey version, the steps you took, and what happened instead of the expected result. Feedback is public: stream tokens and URL parameters are removed, but review track names and page addresses and remove personal information before posting. Nothing is sent automatically.

Unavailable browser storage does not prevent playback or volume changes. Custom EQ presets that could not be saved show an unsaved state rather than falsely acknowledging persistence.

## How it works

```
1. Scroll to bottom of page repeatedly until all tracks are loaded
2. Collect all track elements
3. Fisher-Yates shuffle → build a queue
4. Resolve the selected track and play it through True Shuffle's two-deck audio engine
5. Apply output level, Auto Level, equalizer and optional crossfade
6. Coordinate track changes with a supervised worker and the audio clock
7. Recover stalled custom playback; acknowledge native preview fallback only for the requested track
8. When the round is exhausted → generate a new balanced round
```

## Browser support

Compatibility targets are current Chrome, Edge, Brave, Opera, Firefox and Safari:

| Browser family | Userscript manager |
|----------------|--------------------|
| Chromium: Chrome, Edge, Brave, Opera | Tampermonkey or Violentmonkey, where supported by the browser/manager version |
| Firefox | Tampermonkey or Violentmonkey |
| Safari | Tampermonkey |

Optional features use capability checks rather than browser-name gating. PiP uses a separate document window where available, otherwise video PiP or an in-page mini-player; these modes do not provide identical window behavior. Worker failures fall back to a timer, but browser or operating-system suspension can still interrupt background work. Page-script integrations also depend on the manager's injection mode and site policy.

These are compatibility targets, not a claim that every browser/manager combination has been runtime-tested. Current automated coverage includes regression suites and Chromium browser fixtures; authenticated SoundCloud sessions and the full browser/manager matrix remain separate verification work.

## License

MIT
