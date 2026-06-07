# KUKU Photobooth — Audit Handoff for CODEX

This document is a self-contained brief for a fresh AI/dev agent picking up an audit-fix pass. It packages: (1) what the system is, (2) what was just changed, (3) the audit findings, and (4) which findings are safe to fix vs which need a human decision first.

---

## 1. System snapshot

**App:** KUKU Photobooth — Electron 41 + React 19 + Vite 8 kiosk app for self-serve photo strips. 4"×6" prints at 300dpi.

**Customer flow (7 screens):**
```
Landing → Layout → Policy → Camera → Arrange → Background → Print → End
```
- Layout pick happens BEFORE camera (decides shot count, slot positions, camera ratio).
- Arrange happens AFTER camera (customer picks which captured shot fills which slot, in order).
- Background pick happens AFTER arrange (decorative overlay PNG with transparent holes).

**Three-axis layout model (don't mix these):**
- `layout.camera` → camera preview ratio + capture canvas size.
- `layout.canvas` → final print canvas size.
- `layout.slots` → photo placement, shared by Arrange / Background / Print.

**Asset folders:**
- `src/assets/preview/preview_1..N.png` — Layout-picker thumbnails ONLY.
- `src/assets/layouts/layout_1..N.png` — Functional layout frame (used in Arrange & Background until the customer picks a background).
- `src/assets/backgrounds/<layoutId>/<templateId>/{preview,overlay}.png` — Bundled backgrounds. `preview.png` for cards, `overlay.png` for live preview + final print.
- Runtime templates live in Electron's `userData/templates/<layoutId>/<templateId>/` (NOT in `src/assets`).

**Active layouts (4):**
| id | name | shots | canvas (w×h) | camera (w×h) |
|---|---|---|---|---|
| `classic-strip-4` | Original Strip | 4 | 1200×1800 | 540×330 |
| `classic-strip-3` | Tri Strip | 3 | 1200×1800 | 480×400 |
| `big-duo-2` | Big Duo | 2 | 1200×1800 | 1080×780 |
| `quad-grid-landscape` | Landscape Quad | 4 | 1800×1200 | 650×560 |

**Important detail:** every layout's `canvas` carries BOTH `{w,h}` AND `{width,height}` keys (intentional, see audit H2 below). Most readers use `canvas.w/h`.

---

## 2. Files of interest

```
electron.cjs                  Main process. IPC, paths, JSONL log, print pipeline.
                              Has its own LAYOUT_DIMENSIONS constant — duplicates layouts.js.
preload.cjs                   contextBridge: window.printApi + window.adminApi.

src/App.jsx                   Root: navigation, state, handler glue (314 lines).
src/constants/
  layouts.js                  4 layouts, single source of truth for slots.
  templates.js                BUNDLED_BACKGROUNDS array + WEB_FALLBACK_TEMPLATES.
                              Also exports a numeric-id TEMPLATES — DEAD CODE.
  printers.js                 Selphy CP1500 + DNP profiles, safe-margin helpers.
  filters.js                  Filter list, TWEAK_DEFAULTS.
  photo.js                    (small constants)

src/components/
  LayoutPreview.jsx           Reusable. Renders slots as % rects + optional frameSrc + optional templateSrc.
  LayoutPreview.css           z-index 1 = grid (cells beneath), 2 = frame, 3 = overlay/template.
  PageHeader.jsx              Step pill row.
  Flash.jsx, TweaksPanel.*

src/components/screens/
  LandingScreen, LayoutScreen   Entry + layout pick.
  PolicyScreen                  Rules. Step 2 of 6.
  CameraScreen                  Capture loop. Reads layout.camera. Step 3 of 6.
  ArrangeScreen                 Customer picks shot order. Step 4 of 6.
  SelectionScreen               Background picker. Step 5 of 6. Filters by t.layoutId === layout.id.
  PrintScreen                   Preview + copies + print. Step 6 of 6.
  EndScreen                     Thanks / restart.
  AdminPinScreen, AdminScreen, AdminDashboard
                                Admin behind Ctrl+Shift+A. PIN default '0997'.

src/hooks/
  useCamera.js                  getUserMedia 1280×720, returns { videoRef, hasSignal }.
  useTemplates.js               Merges runtime + WEB_FALLBACK_TEMPLATES.
  useAdminConfig.js             Pulls settings + events.
  useStageScale.js              Letterbox app to fixed virtual viewport.
  useStats.js                   Reduce sessions list to KPIs.

src/lib/
  printImage.js                 composePrintCanvas, normalizePrintOutputCanvas,
                                buildFinalPrintCanvas, composePrintImage.
  shotStorage.js                localStorage save/load/clear.
```

---

## 3. Recent changes (this conversation)

- electron-builder set up for Windows distribution (NSIS, `release/`, `vite.config.js base: './'`, `build/icon.png` 512×512).
- Layered compositing flipped — photos render BENEATH the template; template's transparent holes reveal the photos. Enables non-box / organic overlay designs.
- Customer flow restructured: Layout pick moved to step 1 (was post-camera). Arrange screen added between Camera and Background. Selection screen rebadged as background picker.
- Layouts trimmed from 6 → 4 (removed `quad-grid-portrait` and `collage-4`; preview_4.png and preview_6.png orphaned on disk).
- `composePrintCanvas(layout, templateSrc, shots, photoFilter)` — layout is the first arg; reads W/H from `layout.canvas`, slots from `layout.slots`.
- `electron.cjs::sanitizeSession` now accepts `layoutId/layoutName/mode/eventId/eventName`.
- Layouts file currently uses both `{w,h}` and `{width,height}` keys on `canvas` (intentional, dual-key for compat across consumers).

---

## 4. Audit findings (the actual work for CODEX)

Severity scale: Critical / High / Medium / Low. Each item lists file + approx location, problem, fix, and risk.

### Critical

**C1. Aspect distortion when fitting design into printer safe area**
- File: `src/lib/printImage.js`, `buildFinalPrintCanvas` (lines ~138–185).
- Problem: 1200×1800 source is `drawImage`'d into a 1138×1676 destination region — different aspects (0.667 vs 0.679). Print is ~1.8% horizontally stretched relative to preview.
- Fix: Letterbox instead of stretch. Either compute a uniform scale that preserves aspect and pad with white, or draw at 1:1 inside the safe area at native dims and let the printer's hardware crop.
- Risk: **Medium — needs real test prints on Selphy AND DNP before merging.**

**C2. `TOP_DEAD_CUT_PX` applied unconditionally, including DNP**
- File: `src/lib/printImage.js` line 165 and module-level constant line 3.
- Problem: 20px top compensation runs for every print regardless of `printerProfileId`. DNP has all-zero safe margins by design — 20px shift is parasitic for DNP customers.
- Fix: Move `topDeadCutPx` into each printer profile in `src/constants/printers.js`. Selphy = 20, DNP = 0. Read from `profile` in `buildFinalPrintCanvas`.
- Risk: Low — additive, scoped to print pipeline.

**C3. `electron.cjs::LAYOUT_DIMENSIONS` duplicates `src/constants/layouts.js`**
- File: `electron.cjs` lines 188–193.
- Problem: Layout pixel dims hardcoded a second time in main process. `validateOverlayDimensions` rejects template uploads if dims don't match. Silent breakage when adding/removing/resizing a layout.
- Fix: Single source of truth — either ship a small JSON file readable by both processes, or have renderer pass `{layoutId, expectedW, expectedH}` in the create payload and validate against that.
- Risk: Low — contained refactor.

### High

**H1. `quad-grid-landscape` rotation hardcoded by id**
- File: `src/lib/printImage.js`, `normalizePrintOutputCanvas` line 102.
- Problem: `if (layout?.id !== 'quad-grid-landscape') return sourceCanvas;` — keyed on id, not orientation. Future landscape layouts won't rotate.
- Fix: `if (layout?.canvas?.w <= layout?.canvas?.h) return sourceCanvas;` — or add explicit `layout.printOrientation`.
- Risk: Low.

**H2. Dual `{w,h}` and `{width,height}` canvas keys, inconsistent readers**
- Files: `src/constants/layouts.js`, `src/lib/printImage.js`, `src/components/LayoutPreview.jsx`, `src/components/screens/AdminScreen.jsx`.
- Problem:
  - `printImage.js`: `canvas.w || canvas.width || 1200`.
  - `LayoutPreview.jsx`: `canvas.w ?? 1200` (no `width` fallback).
  - `AdminScreen.jsx::ensureOverlayMatchesLayout`: `layout.canvas.w` only.
- Fix: Canonicalize on `{w,h}`, drop `{width,height}` from layouts. Update all readers. Remove literal 1200/1800 fallbacks — fail loud.
- Risk: Low if done in one pass.

**H3. Unassigned (legacy, no `layoutId`) templates invisible to admin**
- File: `src/components/screens/AdminScreen.jsx` lines 14, 161–178.
- Problem: `LAYOUT_ORDER` lists only the four real layouts; `activeTemplates` filters by `template.layoutId === activeLayoutId`. Templates without `layoutId` (e.g., from `migrateLegacyTemplateDirs`) are unreachable from any tab.
- Fix: Add an "Unassigned" pseudo-layout side-nav entry showing `templates.filter(t => !t.layoutId)`. Allow assigning a layout from there or deleting.
- Risk: Low.

**H4. `big-duo-2` camera/slot aspect mismatch (visible cropping)**
- File: `src/constants/layouts.js`.
- Problem: Camera capture 1080×780 (aspect 1.385). Slot 1082×733 (aspect 1.476). Customer's arrange thumbnail uses camera aspect; print-time `drawCover` further crops to slot aspect. Composition guidance during capture doesn't reflect actual print crop.
- Fix: Make `camera` aspect-equal to slot aspect. For big-duo, set `camera: { width: 1082, height: 733 }` or another canonical pair with aspect 1.476.
- Risk: Low — pure data tweak.
- Note: other three layouts have aspect drift under 0.5%; only big-duo needs this.

### Medium

**M1. Print preview hides safe-area + dead-cut compensation**
- Files: `src/components/screens/PrintScreen.jsx`, `src/lib/printImage.js`.
- Problem: `LayoutPreview` in PrintScreen renders the full-bleed 1200×1800 canvas. Actual print is shrunk into 1138×1676 with 20px top shift. Customer's preview ≠ printed strip (~5% smaller, offset).
- Fix: Either wrap preview in margins matching `safeMargin + dead-cut` so preview lives inside the same effective rect, OR fix C1 and remove shrinking (option (b) of C1).
- Risk: Low for margin-wrap; medium for behavior change.

**M2. `composePrintImage` signature drops `photoFilter`**
- File: `src/lib/printImage.js` line 190.
- Problem: `composePrintImage(layout, templateSrc, shots, printSettings = {})` calls `buildFinalPrintCanvas(..., '', printSettings)` — passes empty filter. Currently no caller, but exported.
- Fix: Either delete (no consumer) or accept and forward `photoFilter`.
- Risk: Low.

**M3. Inconsistent state-reset rules in `App.jsx`**
- File: `src/App.jsx` lines 128–139, 152–160, 162–173, 180–184.
- Problem: `handleSelectLayout`/`handleRetry`/`handleEndReturn` clear different combos of `shots`, `arrangedShotIndexes`, `selectedFilter`, `selectedTmpl`, etc. Foot-gun for future flow edits.
- Fix: Centralize a `resetCustomerSession({ keepLayout? })` helper.
- Risk: Low pure refactor.

**M4. `ArrangeScreen` ignores its `onBack` prop**
- File: `src/components/screens/ArrangeScreen.jsx` lines 12, 101–109.
- Problem: `App.jsx` passes `onBack={() => goTo('s-camera')}` but the screen has no Back button. Customer can only go forward or use Retry from PrintScreen.
- Fix: Add a `← Retake` button next to Continue.
- Risk: Low.

**M5. `templates.js` exports unused numeric-id `TEMPLATES`**
- File: `src/constants/templates.js` lines 571–581.
- Problem: `TEMPLATES` (numeric ids 1..N) exported, never imported. `WEB_FALLBACK_TEMPLATES` (string ids `default-...`) is the real one used by `useTemplates`.
- Fix: Delete `TEMPLATES`.
- Risk: Trivial.

**M6. `ArrangeScreen` placeholder duplicates "Slot N" for mirrored layouts**
- File: `src/components/screens/ArrangeScreen.jsx` line 51.
- Problem: Placeholder text is `Slot {slot.shotIndex + 1}`. classic-strip-4 has 8 slots / 4 shotIndex — customer sees "Slot 1", "Slot 1", "Slot 2", "Slot 2"...
- Fix: Render placeholder only on first occurrence of each `shotIndex`; leave duplicates blank. Or pre-compute a map outside the render.
- Risk: Low.

**M7. `LayoutPreview` accepts both `frameSrc` and `templateSrc`; compositor draws only template**
- Files: `src/components/LayoutPreview.jsx`, `src/lib/printImage.js`.
- Problem: Preview can show `frameSrc` (z-index 2) AND `templateSrc` (z-index 3). `composePrintCanvas` only draws `templateSrc`. SelectionScreen relies on a `null` flip to hide frame when template is chosen — works today, but a future caller passing both will see preview ≠ print.
- Fix: Either drop `frameSrc` from `LayoutPreview` (make frame a separate purpose-specific component prop in Arrange/Selection only) OR have the compositor accept and draw `frameSrc` underneath the template. Document the rule explicitly either way.
- Risk: Low — touches LayoutPreview and 2 callers.

### Low

**L1. Hardcoded `480 / 360` fallback in `CameraScreen`**
- File: `src/components/screens/CameraScreen.jsx` lines 57–58.
- Problem: `const cameraWidth = layout?.camera?.width || 480;`. Silently captures at 480×360 if `layout.camera` missing — wrong aspect for slot.
- Fix: `console.warn` and either use slot-derived aspect from `layout.canvas` + `layout.slots`, or refuse to capture.
- Risk: Low.

**L2. `console.log` calls in production print path**
- File: `src/lib/printImage.js` lines 171–173.
- Problem: `Top dead cut compensation:`, `Final output canvas:`, `Drawn image area:` fire on every print.
- Fix: Remove or wrap in a debug flag.
- Risk: Trivial.

**L3. `useCamera` requests fixed 1280×720 regardless of layout**
- File: `src/hooks/useCamera.js` line 25.
- Problem: 16:9 source for every layout. Narrow-aspect layouts (big-duo 1.385) crop more from sides during preview. Functional, but visible left/right loss on big-duo preview.
- Fix: Optionally request a higher minimum or layout-aware dims. Touch only if customers complain about preview framing.
- Risk: Low.

**L4. PIN default `0997` visible in source**
- File: `electron.cjs` line 327.
- Problem: Default PIN is in source. Mitigated by `setPin` flow.
- Fix: Document admin must change on first run, or generate random + display once.
- Risk: Low.

**L5. `templates:restoreDefaults` is a no-op**
- File: `electron.cjs` lines 760–767.
- Problem: Just calls `ensureTemplatesIndex()`. Renderer toast claims "Defaults restored" but nothing was restored — bundled defaults already live in `WEB_FALLBACK_TEMPLATES`.
- Fix: Either remove the button (currently in a `confirmRestore` modal in AdminScreen), or actually re-populate `bundledTemplateOverrides` to `enabled: true`.
- Risk: Low.

---

## 5. What's confirmed working — DO NOT TOUCH

- `composePrintCanvas` core layer order: white backdrop → photos → template overlay. Correct.
- Slot percentage math in `LayoutPreview` (`(slot.x / canvasW) * 100`, etc.) shared between live preview and print. Aligned by construction.
- Mirror-by-`shotIndex` semantics — multiple slots referencing same shot — works in both compositor and preview.
- Camera capture's `object-fit: cover` replication via computed `sx, sy, sw, sh` is correct and matches CSS preview.
- IPC contract: `printApi.printStrip` returns `{ success, failureReason }`. Admin handlers return `{ ok, error }`.
- `useTemplates` merge logic (runtime + bundled fallback dedupe by id and `(layoutId, name)`).
- `SelectionScreen` template filter chain (`enabled`, `layoutId === layout.id`, mode/event).
- `App.jsx` defensive clear of `selectedTmpl` when its `layoutId/mode/eventId` no longer matches.
- `kuku-template://` protocol handler (id whitelist + restricted asset names).
- `Ctrl+Shift+A` admin entry + PIN flow.
- Session log shape (`sanitizeSession`) — forward-compatible.

---

## 6. Suggested execution order for CODEX

**Phase 1 — Quick wins (no behavior change, do these first):**
- L2 — strip `console.log` in `printImage.js`
- L1 — replace `|| 480 / || 360` fallback in CameraScreen with `console.warn`
- M5 — delete unused `TEMPLATES` export
- L5 — remove the misleading "Restore Defaults" button OR wire it up; pick one
- H1 — change rotation predicate to orientation-based
- M4 — add Back button in ArrangeScreen
- M6 — dedupe placeholder labels for mirrored layouts

**Phase 2 — Structural cleanup (low-risk, higher value):**
- H2 — canonicalize on `{w,h}` keys; remove literal 1200/1800 fallbacks
- C3 — single-source layout dims between renderer + main process
- M3 — central `resetCustomerSession()` helper in App.jsx
- M7 — pick a `frameSrc`/`templateSrc` rule and document
- M2 — delete or fix `composePrintImage`
- H3 — Unassigned tab in admin

**Phase 3 — Print behavior (NEEDS TEST PRINTS BEFORE MERGING):**
- C1 — letterbox-vs-stretch decision
- C2 — per-profile dead-cut
- M1 — preview/print compensation parity
- H4 — big-duo camera/slot aspect alignment

**Items needing human decision before code change:**
- C1 (letterbox vs hardware-crop — ask the user which print behavior they want)
- C2 (confirm DNP doesn't have its own top dead-cut)
- H4 (which aspect is the "correct" one for big-duo — change camera, change slot, or accept the crop)
- L4 (PIN strategy)

---

## 7. How to run / verify

```bash
npm run start         # Vite dev + Electron with hot-reload
npm run pack          # Unpacked app folder for testing
npm run dist:win      # NSIS installer in release/
```

Manual verification path after any fix:
1. Walk Landing → Layout → Policy → Camera → Arrange → Background → Print → End for each of the 4 layouts.
2. Hit `Ctrl+Shift+A`, enter PIN `0997`, verify admin still loads templates and dashboard.
3. Test print on real Selphy + DNP if any change touched print pipeline.
4. Re-test layout-specific paths after H4 / camera changes (big-duo has the most aspect drift).

---

Good luck, CODEX. The bones are solid; the real work is in Phase 3 and it's mostly waiting on human print-tests, not code.
