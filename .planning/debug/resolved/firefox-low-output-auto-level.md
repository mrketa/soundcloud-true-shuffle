---
status: resolved
trigger: "Auto macht den Song selbst bei 100% sehr leise; die allgemeine True-Shuffle-Lautstärke ist in Firefox niedriger als in Chrome."
created: 2026-07-24
updated: 2026-07-24
---

## Symptoms

- Expected: Bei 100% und Auto Level aus ist der eigene Player neutral und browserübergreifend vergleichbar laut. Auto Level gleicht laute Songs moderat an, ohne drastischen Pegelverlust.
- Actual: Auto Level macht Songs sehr leise. In Firefox ist True Shuffle außerdem allgemein leiser als in Chrome.
- Errors: Keine gemeldet.
- Timeline: Nach dem aktuellen v6.1.2-Beta-Test; Crossfade-Stall und Queue-Zurück funktionieren.
- Reproduction: Firefox, True Shuffle starten, Master auf 100%, Lautstärke mit Auto Off und Auto On vergleichen; denselben Track mit Chrome vergleichen.

## Current Focus

- hypothesis: confirmed
- test: Executable gain calculation and mock Web Audio routing regression, followed by full test suites and artifact identity checks.
- expecting: Auto Level never attenuates below 0.5; Auto Off with flat EQ connects source directly to mixGain.
- next_action: resolved

## Evidence

- timestamp: 2026-07-24T05:25:00+02:00
  observation: The original TDD regression failed because RMS 0.5 produced gain 0.4672 on the first calibration pass.
  implication: The 0.13 RMS target and 0.2 floor caused excessive attenuation.
- timestamp: 2026-07-24T05:27:00+02:00
  observation: With Auto Level and EQ off, the original graph still traversed five BiquadFilter nodes, an analyser, and autoGain.
  implication: Auto Off was not a browser-neutral unity bypass even though all nominal gains were 1.
- timestamp: 2026-07-24T05:34:00+02:00
  observation: Crossfade, True Shuffle, and Firefox regression suites pass after the fix; syntax and git diff checks pass.
  implication: The fix preserves the Firefox crossfade ramps, queue behavior, and existing playback regressions.
- timestamp: 2026-07-24T05:35:00+02:00
  observation: Source, canonical artifact, and beta artifact share SHA-256 662509DCD3E94E86C006ACC11FC2BA402ABFF8ED182FB8A656E4745C0BA777ED.
  implication: Both requested artifacts were rebuilt byte-for-byte from the fixed canonical source.

## Eliminated

- hypothesis: The Firefox crossfade ramp reset or queue fix caused the low output.
  reason: Those paths were left unchanged and their executable regression coverage remains green.

## Resolution

- root_cause: Auto Level used an overly quiet 0.13 RMS target with a 0.2 floor and persisted those deep cuts, while Auto Off still routed audio through optional processing nodes instead of a true unity bypass.
- fix: Raised the target to 0.225, capped attenuation at 0.5, moved cache storage to v3, and added dynamic routing that connects source directly to mixGain when Auto Level and EQ are off.
- verification: TDD RED reproduced gain 0.4672; GREEN passed crossfade, full True Shuffle, Firefox fallback, syntax, diff, and artifact SHA-256 identity checks.
- files_changed: SC Trueshuffle.js; tests/crossfade-prototype.test.js; dist/SC Trueshuffle.user.js; dist/SC-Trueshuffle-v6.1.2-beta.1.user.js
