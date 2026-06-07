# KUKU Photobooth — System Handoff

A compacted technical brief so a fresh AI assistant (or developer) can pick up where this conversation left off without re-deriving the architecture.

---

## 1. What this app is

A **kiosk photobooth** that runs as an Electron desktop app. A customer walks up, picks a photo layout, takes their shots, picks a decorative design, and prints. Everything is local — no cloud, no accounts. There's an admin screen behind a PIN for managing templates and viewing session analytics.

- **Owner:** Kenneth G. Patiño (`lowlow2k12@gmail.com`)
- **App ID:** `com.kennethpatino.kukuphotobooth`
- **Product name:** "God Is Good" in `package.json`, "KUKU Photobooth" in the installer block
- **Print format:** 4"×6" at 300dpi (1200×1800 portrait, or 1800×1200 landscape)

## 2. Tech stack

- **Electron 41** (main: `electron.cjs`, preload: `preload.cjs`, asar packaged)
- **React 19** with hooks
- **Vite 8** (`base: './'` for relative asset paths in packaged builds)
- **electron-builder 25** — Windows NSIS installer, output to `release/`
- **No Node integration in renderer** — all native ops go through `contextBridge` IPC

Build commands:
- `npm run start` — concurrent Vite dev server + Electron
- `npm run dist:win` — produce installable `.exe`
- `npm run pack` — unpacked app folder for testing

## 3. Customer flow (5 steps)

```
Landing → Layout → Policy → Camera → Design → Print → End
   0        1        2        3        4        5     —
```

- **Layout pick happens BEFORE photos** — it determines shot count & arrangement.
- **Design pick happens AFTER photos** — customer matches a frame/overlay to the shots they actually got.
- **PageHeader pills** are 5-step on every screen (Layout/Policy/Design/Print). CameraScreen has its own custom topbar.

## 4. Two orthogonal concepts: Layouts vs Templates

This is the most important mental model to keep straight.

### Layouts (`src/constants/layouts.js`)
Define **where photos go** on the printed strip and **how many shots** the camera takes. Bundled at build time. Currently 4 active layouts:

| id                    | shots | canvas      | preview      |
| --------------------- | ----- | ----------- | ------------ |
| `classic-strip-4`     | 4     | 1200×1800   | preview_1.png |
| `classic-strip-3`     | 3     | 1200×1800   | preview_2.png |
| `big-duo-2`           | 2     | 1200×1800   | preview_3.png |
| `quad-grid-landscape` | 4     | 1800×1200   | preview_5.png |

> Layouts 4 (`quad-grid-portrait` / preview_4) and 6 (`collage-4` / preview_6) were removed — user noticed they rendered portrait when they shouldn't have. Their PNG files still exist on disk but are no longer imported.

Each layout has a `slots` array. Each slot has `{x, y, w, h, shotIndex}`:
- `x/y/w/h` are pixel coords on the layout's canvas.
- `shotIndex` says which captured photo fills that slot. Two slots can share an index (mirrored twin-strip layouts use this).
- `shots` is the count of UNIQUE captures the camera needs (typically `max(shotIndex) + 1`).

`layout.slots` is the **single source of truth** for both:
1. The print-time canvas in `src/lib/printImage.js`
2. The on-screen preview in `PrintScreen.jsx` (which converts pixel coords to %)

This guarantees preview and print stay pixel-aligned.

### Templates (managed at runtime)
Decorative PNG overlays with **transparent holes** punched where photos should show through. Stored in Electron's `userData/templates/` directory and loaded via the custom `kuku-template://<id>` protocol. The admin can add/remove/enable/disable them at runtime.

Default templates ship in `default-templates/` and are restored on first run or via the admin "Restore Defaults" button.

### Compositing layer order (bottom → top)
1. White backdrop
2. Photos drawn at each slot's pixel rect
3. Template PNG stretched over the whole canvas — its alpha holes reveal photos beneath

This means template designers don't need to touch slot math. They just punch holes in the right places (or design organic / non-box overlays).

## 5. State management (App.jsx)

Single root component, no Redux/Zustand. Key state:

```js
curScreen          // 's-landing' | 's-layout' | 's-policy' | 's-camera'
                   //   | 's-design' | 's-print' | 's-end'
                   //   | 's-admin-pin' | 's-admin'
selectedLayout     // layout id, e.g. 'classic-strip-4'
selectedTmpl       // template id (decorative overlay)
shots              // array of dataURL strings, length === layout.shots
copies             // 1..5
retries            // starts at 1; --1 each time customer retries
flashOn            // bool, drives the flash overlay
sessionStartRef    // timestamp at layout pick — used for durationMs
```

Helpers:
- `findLayout(id)` resolves the layout object, falling back to `DEFAULT_LAYOUT_ID = 'classic-strip-4'`.
- `loadShots() / saveShots() / clearShots()` in `src/lib/shotStorage.js` — localStorage persistence so a refresh mid-session doesn't drop shots.
- `useTemplates()` — subscribes to template list; auto-clears `selectedTmpl` if the chosen template gets deleted/disabled.

**Important behaviors:**
- `handleSelectLayout` clears shots (different layouts may need different shot counts).
- `handleSelectTemplate` does NOT clear shots (design pick is post-camera).
- `handleEndReturn` resets everything for the next customer.

## 6. Admin / IPC surface

Exposed via `preload.cjs` `contextBridge`:

```js
window.printApi.printStrip(dataUrl, { copies })

window.adminApi.listTemplates()
window.adminApi.createTemplate({ name, desc, srcDataUrl })
window.adminApi.updateTemplate(id, patch)
window.adminApi.deleteTemplate(id)
window.adminApi.restoreDefaults()

window.adminApi.checkPin(pin)
window.adminApi.setPin(currentPin, newPin)

window.adminApi.logSession(session)
window.adminApi.listSessions({ limit, offset })
window.adminApi.getStats()
window.adminApi.clearSessions()
window.adminApi.seedSessions(count)

window.adminApi.onSessionLogged(cb)     // returns unsubscribe()
window.adminApi.onSessionsCleared(cb)
```

### Storage locations (Electron `userData`)
- `templates/` — uploaded template PNGs + `index.json`
- `admin.json` — hashed PIN
- `sessions.jsonl` — append-only session log (one JSON object per line)

### Session record shape (sanitized in `electron.cjs::sanitizeSession`)
```jsonc
{
  "id": "...",
  "timestamp": "ISO 8601",
  "dateLocal": "YYYY-MM-DD",   // operator's wall-clock date for bucketing
  "layoutId": "classic-strip-4",
  "layoutName": "Classic Strip",
  "templateId": "warm-blush",
  "templateName": "Warm Blush",
  "copies": 1,
  "unitPrice": 150,
  "totalAmount": 150,
  "retriesUsed": 0,
  "durationMs": 92451,
  "status": "completed" | "failed",
  "failureReason": null
}
```

`layoutId/layoutName` were added in this session — old records lack them and are tolerated by readers.

### Admin entry
`Ctrl+Shift+A` (or `Cmd+Shift+A`) anywhere → `s-admin-pin`. Default PIN should be set on first run.

## 7. Camera capture (`CameraScreen.jsx`)

- `useCamera()` hook acquires the webcam via `getUserMedia()`.
- Preview uses `transform: scaleX(-1)` (selfie-mirror) and `object-fit: cover` on a 4:3 viewport.
- Capture replicates `object-fit: cover` on a 480×360 canvas (centrally crops non-4:3 sources, never stretches), then applies `ctx.scale(-1, 1)` so the saved JPEG matches the mirrored preview.
- `shotsRef.current` is mirrored to `shots` so sequential captures (scheduled via `setTimeout`) don't overwrite each other from stale closures.
- `totalShots` comes from the chosen layout (variable: 2, 3, or 4).
- Auto-runs the shooting sequence after "Start Session" — countdown × N, then `onDone(shots)` advances to the design picker.

## 8. Print pipeline (`src/lib/printImage.js` + `PrintScreen.jsx`)

```js
composePrintCanvas(layout, templateSrc, shots) → HTMLCanvasElement
composePrintImage(layout, templateSrc, shots) → JPEG data URL
```

Both signatures take `layout` as the **first argument**. Reading W/H from `layout.canvas` and slots from `layout.slots`. Loading template + shots in parallel via `Promise.all`. `drawCover()` replicates CSS `object-fit: cover` so photos never distort.

`PrintScreen` does two things with the composed canvas:
1. PNG download (lossless local backup, via temporary anchor click).
2. JPEG (q=0.95) sent over IPC to Electron's print pipeline, which drives the printer at the layout's exact pixel dimensions with no scaling.

Falls back gracefully when running outside Electron (no `window.printApi`) — download still works, print is skipped with a warning.

After print (success or failure), session is logged unconditionally, then `onPrint()` advances to `s-end`.

## 9. Live preview alignment

`PrintScreen.jsx` renders:

```jsx
<div className="print-frame-wrap" style={{ aspectRatio: `${canvasW} / ${canvasH}` }}>
  <div className="print-frame-grid">
    {slots.map((slot, i) => (
      <div className="print-frame-cell" style={{
        left:   `${(slot.x / canvasW) * 100}%`,
        top:    `${(slot.y / canvasH) * 100}%`,
        width:  `${(slot.w / canvasW) * 100}%`,
        height: `${(slot.h / canvasH) * 100}%`,
      }}>
        {shot && <img src={shot} />}
      </div>
    ))}
  </div>
  {template && <img className="tmpl-bg" src={template.src} />}
</div>
```

- `aspect-ratio` is inline-styled so portrait + landscape canvases both render correctly.
- `.tmpl-bg` is `z-index: 2` and `pointer-events: none` (sits ON TOP of cells).
- `.print-frame-grid` is `z-index: 1` (cells beneath).

## 10. File map (the parts you'll actually touch)

```
electron.cjs                  Main process: window mgmt, IPC, paths, sanitize, JSONL log
preload.cjs                   contextBridge: printApi + adminApi
vite.config.js                base: './' for packaged builds
package.json                  electron-builder block, NSIS config, scripts
build/icon.png                512×512 source — electron-builder generates .ico/.icns

src/App.jsx                   Root: navigation, state, handler glue
src/main.jsx                  Vite entry
src/App.css, src/index.css    Globals

src/components/
  PageHeader.jsx              Step pill row + title/subtitle
  Flash.jsx                   White flash overlay
  TweaksPanel.jsx             Dev tweaks (primary color, countdown)

src/components/screens/
  LandingScreen.jsx           Idle screen / "Start"
  LayoutScreen.jsx            Layout picker (Step 1 of 5)
  PolicyScreen.jsx            Rules / shot count (Step 2 of 5)
  CameraScreen.jsx            Capture sequence (custom topbar — no PageHeader)
  SelectionScreen.jsx         Design picker (Step 4 of 5)
  PrintScreen.jsx             Preview + copies + print (Step 5 of 5)
  EndScreen.jsx               Thanks / restart
  AdminPinScreen.jsx          PIN gate
  AdminScreen.jsx             Template mgmt + analytics dashboard host
  AdminDashboard.jsx          Stats / charts / session list

src/constants/
  layouts.js                  4 layouts, single source of truth for slots
  templates.js                (any constants, fallback metadata)
  filters.js                  Camera filter list + TWEAK_DEFAULTS

src/hooks/
  useCamera.js                getUserMedia, hasSignal flag
  useStageScale.js            Letterbox the kiosk to a fixed virtual viewport
  useTemplates.js             Subscribes to adminApi, exposes refresh()
  useStats.js                 Reduces sessions list into KPIs

src/lib/
  printImage.js               composePrintCanvas / composePrintImage
  shotStorage.js              localStorage {save,load,clear}Shots

src/assets/preview/           preview_1..6.png (4 active, 2 retired)
default-templates/            Bundled fallback overlays
```

## 11. Key conventions / gotchas

- **CSS variables** drive theming: `--primary`, `--secondary`, `--dark`, `--mid`, `--border`, `--light-bg`, `--white`, `--r`, `--r-lg`. App writes `--primary` from a tweak slider.
- **Stage scaling:** `useStageScale` letterboxes the entire app inside a fixed virtual viewport so the kiosk renders identically regardless of monitor resolution.
- **Asset paths:** Vite is configured with `base: './'` — built `index.html` uses relative asset URLs so `file://` loading works in packaged builds. Don't change this without a plan.
- **Icon:** electron-builder auto-discovers `build/icon.png` (512×512). Don't add per-platform icon paths unless they actually exist.
- **`package.json` `productName`:** user has set this to "God Is Good" in the top-level field, but the `build.productName` is "KUKU Photobooth". Both are intentional — keep them as-is.
- **Filters constant `TOTAL_SHOTS`:** still exported from `src/constants/filters.js` but no longer referenced. Safe to delete in a cleanup pass.
- **Session log tolerance:** old records lack `layoutId/layoutName`. `useStats` and `AdminDashboard` should ignore unknown / missing fields, never crash.

## 12. Recent changes (this session)

1. **electron-builder setup:** added scripts, NSIS config, `build/icon.png`, `release/` ignored, `vite.config.js` `base: './'`, `electron.cjs::resolveAppEntry()` to switch between dev URL and packaged file.
2. **Layered compositing flip:** photos now render BENEATH the template (was the other way). Templates use transparent holes; non-box / organic designs are now possible.
3. **Flow restructure:** Layout pick moved to step 1 (was post-camera). Design pick moved to step 4 (post-camera). Five-step pill convention everywhere.
4. **Layout system:** `src/constants/layouts.js` is the new single source of truth. `composePrintCanvas` signature changed to `(layout, templateSrc, shots)`.
5. **PolicyScreen:** accepts `totalShots`, renders dynamic shot count.
6. **SelectionScreen:** rebadged from "Choose Your Frame" to "Choose Your Design"; tags swapped to overlay/transparency language.
7. **electron.cjs `sanitizeSession`:** accepts `layoutId/layoutName`.
8. **Layouts trimmed:** removed `quad-grid-portrait` (preview_4) and `collage-4` (preview_6). Four layouts active.

## 13. Known issues / TODOs

- `src/constants/filters.js::TOTAL_SHOTS` is dead code — remove in a cleanup pass.
- AdminDashboard does NOT yet show a layout breakdown. Data is being logged (`layoutId/layoutName`) but no chart consumes it. Easy follow-up.
- No automated tests. Manual verification path: `npm run start`, walk through the flow, hit `Ctrl+Shift+A` to verify admin still works.
- Preview PNGs `preview_4.png` and `preview_6.png` are still in `src/assets/preview/` but not imported. Delete on disk if you want to fully clean up.
- Sandbox build validation under WSL/Linux can fail on `@rolldown` linux-arm64 binding — irrelevant noise for the actual Windows target.

## 14. Quick mental model for a new agent

> "Layouts decide pixel positions and shot count. Templates are decorative PNGs with holes. Photos are drawn at slot rects, then the template is stamped on top. Preview and print read the same `layout.slots` array — preview just converts pixels to percentages. Sessions are logged to a JSONL file with both the layout and the template that produced them."

If you remember that, the rest is mostly plumbing.
