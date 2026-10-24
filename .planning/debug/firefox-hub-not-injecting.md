---
status: fixing
trigger: "jetzt injected das hub nichtmal mehr auf firefox"
created: 2026-07-20
updated: 2026-07-20
---

## Symptoms

- Expected: True Shuffle hub injects on SoundCloud in Firefox as before.
- Actual: Hub no longer appears after the Firefox Document PiP API detection change.
- Error messages: Not yet captured.
- Timeline: Began immediately after adding multi-window and wrappedJSObject Document PiP detection.
- Reproduction: Load SoundCloud in Firefox with the updated userscript enabled.

## Current Focus

- hypothesis: Firefox returns the Document PiP window as a protected cross-origin wrapper to Tampermonkey's extension realm.
- test: Unwrap the returned PiP WindowProxy before mountOwnPipWindow reads its document.
- expecting: The native always-on-top window remains open and accepts the True Shuffle UI.
- next_action: Add a narrowly-scoped Firefox window unwrapping helper and regression coverage.

## Evidence

- timestamp: 2026-07-20
  observation: Firefox opens the native window briefly, then mountOwnPipWindow throws Permission denied to access property document on cross-origin object at the first document access.
  implication: API detection and requestWindow both work; only the returned WindowProxy crosses the Tampermonkey compartment boundary incorrectly.

## Eliminated

## Resolution

- root_cause:
- fix:
- verification:
- files_changed:
