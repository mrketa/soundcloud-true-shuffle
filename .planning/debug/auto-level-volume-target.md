---
status: resolved
trigger: "Auto Level soll bei z.B. 40% natürlich lautere Songs auf dieselbe wahrgenommene Lautstärke wie den vorherigen Song bringen; bei 100% soll Auto keinen zusätzlichen Pegelverlust erzeugen."
created: 2026-07-24
updated: 2026-07-24
---

## Symptoms

- Expected: Der Volume-Regler definiert das gewünschte Hörniveau. Unter 100% darf Auto Level pro Song sicher anheben oder absenken, damit Songs ähnlich laut wirken. Bei 100% bleibt der Pfad neutral. Auto Off bleibt ein reiner Master-Regler.
- Actual: Die bisherige feste RMS-Normalisierung dämpft laute Songs unabhängig von der gewählten Master-Lautstärke, daher ist 100% mit Auto On leiser als Auto Off.
- Errors: Keine.
- Timeline: Beim Test des moderateren Firefox-Auto-Level-Fixes präzisiert.
- Reproduction: Gleichen Track bei 100% Auto Off/On vergleichen; anschließend unterschiedlich laute Tracks bei 40% Auto On vergleichen.

## Current Focus

- hypothesis: Auto Level benötigt einen volumenabhängigen Ziel-Gain statt eines festen zusätzlichen Dämpfungsfaktors. Sichere Anhebung muss durch aktuellen Master und gemessenen Peak begrenzt werden.
- test: Reine Gain-Berechnung für 100% Neutralität, 40% Angleichen von leisem und lautem Material, Peak-/Headroom-Schutz sowie stabile Cache-Werte ausführbar testen.
- expecting: Bei 100% ist Gain exakt 1; bei 40% konvergieren unterschiedliche RMS-Werte auf dasselbe Ziel, ohne dass `master * peak * gain` Full Scale überschreitet.
- next_action: complete

## Evidence

- timestamp: 2026-07-24T05:29:00+02:00
  finding: The original calculateAutoLevelGain clamps gain to 0.5..1 and only moves downward toward a fixed RMS target.
  implication: Auto cannot boost quiet tracks, and 100% Auto remains quieter than unity for loud material.
- timestamp: 2026-07-24T05:30:00+02:00
  finding: New executable tests failed RED with gain 0.5 instead of required unity gain 1 at 100% master.
  implication: The regression was reproduced before implementation.
- timestamp: 2026-07-24T05:32:00+02:00
  finding: Focused Auto Level and crossfade suite passed after measurement-cache v4 and stable settled gain implementation.
  implication: Target behavior and Firefox crossfade invariants pass together.
- timestamp: 2026-07-24T05:33:54+02:00
  finding: All three suites passed; source and both rebuilt artifacts pass syntax checks and share the same SHA-256.
  implication: Canonical and beta artifacts contain the verified source byte-for-byte.

## Eliminated

## Resolution

- root_cause: Auto Level used a fixed attenuation-only RMS gain that continuously decreased during playback, so it could neither preserve unity at 100% nor safely boost quiet tracks.
- fix: Added strict 100% unity bypass, volume-targeted RMS gain with master and peak headroom caps, and a v4 per-track RMS and peak cache that settles once after 12 valid samples.
- verification: RED test reproduced the bug; focused and complete regression suites passed; all three userscripts passed node syntax checks; canonical and beta outputs are byte-identical to source.
- files_changed: SC Trueshuffle.js; tests/crossfade-prototype.test.js; dist/SC Trueshuffle.user.js; dist/SC-Trueshuffle-v6.1.2-beta.1.user.js
