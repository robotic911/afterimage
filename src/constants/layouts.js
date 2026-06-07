// ─────────────────────────────────────────────────────────────────────────
// Photo layouts
// ─────────────────────────────────────────────────────────────────────────
//
// A "layout" defines WHERE captured photos appear on the printed strip
// and HOW MANY unique shots the camera needs to capture. The decorative
// "design" / "background" / "frame" PNG (chosen later, after the camera
// session) is a separate concern — it just sits on top of the photos
// with transparent holes in the slot positions.
//
// Each layout is the SINGLE SOURCE OF TRUTH for both:
//   • the print-time canvas (composePrintCanvas in lib/printImage.js)
//   • the live preview grid (PrintScreen.jsx)
// CSS percentages and canvas pixel coords are both derived from the same
// `slots` array — no risk of preview & print drifting out of sync.
//
// Slot fields:
//   x, y, w, h   pixel coords on the layout's canvas (origin: top-left)
//   shotIndex    which captured photo fills this slot. Multiple slots can
//                share the same index (used to mirror a strip into two
//                columns without doubling the number of shots).
//
// `shots` is the count of UNIQUE captures the camera needs — usually
// max(shotIndex) + 1.

import preview1 from '../assets/preview/preview_1.png';
import preview2 from '../assets/preview/preview_2.png';
import preview3 from '../assets/preview/preview_3.png';
import preview5 from '../assets/preview/preview_5.png';
import frame1 from '../assets/layouts/layout_1.png';
import frame2 from '../assets/layouts/layout_2.png';
import frame3 from '../assets/layouts/layout_3.png';
import frame5 from '../assets/layouts/layout_5.png';
import portraitGridFrame from '../assets/backgrounds/portrait-grid/original/overlay.png';
import studioQuadFrame from '../assets/backgrounds/studio-quad/original/overlay.png';

export const LEGACY_LAYOUT_ID_ALIASES = {
  'big-duo-2': 'portrait-grid',
  'quad-grid-landscape': 'studio-quad',
};

export const normalizeLayoutId = (id) => LEGACY_LAYOUT_ID_ALIASES[id] || id;

export const LAYOUTS = [
  // ── 1. Classic strip — 4 shots, mirrored into two columns ────────────
  // Original KUKU layout. 1200×1800 portrait (4"×6" at 300dpi).
  {
    id:      'classic-strip-4',
    name:    'Original Strip',
    desc:    '4 photos, twin-strip',
    previewSrc: preview1,
    frameSrc: frame1,
    arrangeFrameSrc: frame1,
    canvas:  { w: 1200, h: 1800, width: 1200, height: 1800 },
    // Intended design size: 560 × 366.7 from Figma.
    // Canvas capture dimensions are integer pixels, so use the nearest height.
    camera:  { width: 560, height: 367 },
    cameraFraming: { zoom: 1, offsetX: 0, offsetY: 0 },
    shots:   4,
    slots: [
      { x: 19,  y: 29,   w: 562, h: 371, shotIndex: 0 }, { x: 619, y: 29,   w: 562, h: 371, shotIndex: 0 },
      { x: 19,  y: 416,  w: 562, h: 371, shotIndex: 1 }, { x: 619, y: 416,  w: 562, h: 371, shotIndex: 1 },
      { x: 19,  y: 803,  w: 562, h: 371, shotIndex: 2 }, { x: 619, y: 803,  w: 562, h: 371, shotIndex: 2 },
      { x: 19,  y: 1190, w: 562, h: 371, shotIndex: 3 }, { x: 619, y: 1190, w: 562, h: 373, shotIndex: 3 },
    ],
    tags: ['4 shots', '2 copies'],
  },

  // ── 2. Mini strip — 3 shots, mirrored into two columns ───────────────
  {
    id:      'classic-strip-3',
    name:    'Tri Strip',
    desc:    '3 photos, twin-strip',
    previewSrc: preview2,
    frameSrc: frame2,
    arrangeFrameSrc: frame2,
    canvas:  { w: 1200, h: 1800, width: 1200, height: 1800 },
    camera:  { width: 560, height: 405 },
    cameraFraming: { zoom: 1, offsetX: 0, offsetY: 0 },
    shots:   3,
    slots: [
      { x: 17,  y: 269,  w: 563, h: 410, shotIndex: 0 }, { x: 617, y: 269,  w: 563, h: 410, shotIndex: 0 },
      { x: 17,  y: 695,  w: 563, h: 410, shotIndex: 1 }, { x: 617, y: 695,  w: 563, h: 410, shotIndex: 1 },
      { x: 17,  y: 1119, w: 563, h: 410, shotIndex: 2 }, { x: 617, y: 1119, w: 563, h: 410, shotIndex: 2 },
    ],
    tags: ['3 shots', '2 copies'],
  },

  // ── 3. Portrait grid — 4 portrait shots in a 2×2 grid ───────────────
  {
    id:      'portrait-grid',
    name:    'Portrait Grid',
    desc:    '4 photos, 2×2 portrait grid, twin strip',
    previewSrc: preview3,
    frameSrc: portraitGridFrame,
    arrangeFrameSrc: frame3,
    canvas:  { w: 1200, h: 1800, width: 1200, height: 1800 },
    camera:  { width: 560, height: 670 },
    cameraFraming: { zoom: 1, offsetX: 0, offsetY: -0.04 },
    shots:   4,
    slots: [
      { x: 19,  y: 38,  w: 563, h: 674, shotIndex: 0 }, { x: 618, y: 38,  w: 563, h: 674, shotIndex: 1 },
      { x: 19,  y: 729, w: 563, h: 674, shotIndex: 2 }, { x: 618, y: 729, w: 563, h: 674, shotIndex: 3 },

    ],
    tags: ['4 shots', '2 copies'],
  },

  // ── 4. Studio quad — uses the same portrait 4×6 working canvas as the
  // bundled overlays so Arrange, Background, and Print share one space.
  {
    id:      'studio-quad',
    name:    'Studio Quad',
    desc:    '4 photos, studio-style quad',
    previewSrc: preview5,
    frameSrc: studioQuadFrame,
    arrangeFrameSrc: frame5,
    canvas:  { w: 1200, h: 1800, width: 1200, height: 1800 },
    camera:  { width: 570, height: 670 },
    cameraFraming: { zoom: 1, offsetX: 0, offsetY: -0.04 },
     shots:   4,
    slots: [
      { x: 19,  y: 218, w: 572, h: 674, shotIndex: 0 },{ x: 609, y: 218, w: 572, h: 674, shotIndex: 1 },
      { x: 19,  y: 909, w: 572, h: 674, shotIndex: 2 },{ x: 609, y: 909, w: 572, h: 674, shotIndex: 3 },

    ],
    tags: ['4 shots', '1 copy'],
  },
];

// The default layout used when nothing has been selected yet.
// Falling back to the classic strip keeps every existing default
// template (Dark Teal / Warm Blush / Dark Maroon) compatible.
export const DEFAULT_LAYOUT_ID = 'classic-strip-4';

export const findLayout = (id) =>
  LAYOUTS.find((l) => l.id === normalizeLayoutId(id)) || LAYOUTS.find((l) => l.id === DEFAULT_LAYOUT_ID);
