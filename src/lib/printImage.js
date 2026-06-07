import { getPrintArea, getPrinterProfile } from '../constants/printers';
import { PRINT_JPEG_QUALITY, PRINT_PHOTO_FILTER, TOP_DEAD_CUT_PX } from '../constants/printSettings';
import { loadImageCached } from './imageCache';

export { PRINT_JPEG_QUALITY, PRINT_PHOTO_FILTER };

// Compose the final print-ready strip on a canvas using the chosen
// layout as the single source of truth. The same `layout.canvas` and
// `layout.slots` data is used by PrintScreen.jsx for the on-screen
// preview (as %), so preview and print stay pixel-aligned.

// Replicates CSS `object-fit: cover` for canvas: centrally crop the
// source image to match the destination aspect, never distort.
function drawCover(ctx, img, dx, dy, dw, dh) {
  const sW = img.naturalWidth || img.width;
  const sH = img.naturalHeight || img.height;
  const srcAspect = sW / sH;
  const destAspect = dw / dh;

  let sx, sy, sw, sh;

  if (srcAspect > destAspect) {
    sh = sH;
    sw = sH * destAspect;
    sx = (sW - sw) / 2;
    sy = 0;
  } else {
    sw = sW;
    sh = sW / destAspect;
    sx = 0;
    sy = (sH - sh) / 2;
  }

  ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
}

/**
 * Render the final print canvas for a given layout.
 *
 * Layer order (bottom → top):
 *   1. white backdrop
 *   2. captured photos placed at each layout slot
 *   3. template PNG stretched over the whole canvas
 *
 * The template is drawn LAST so its transparent regions (the "holes"
 * cut into the design) reveal the photos beneath. This means template
 * designers can place decorative framing, overlays, or organic shapes
 * around the cut-outs without touching the photo slot math — the
 * layout's `slots` array is the single source of truth for photo
 * position, and is shared with the live preview.
 */
export async function composePrintCanvas(layout, templateSrc, shots, photoFilter = '') {
  const W = layout?.canvas?.w || layout?.canvas?.width || 1200;
  const H = layout?.canvas?.h || layout?.canvas?.height || 1800;
  const slots = layout?.slots || [];

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  // Kick off both downloads in parallel — template and shots are
  // independent, so awaiting them sequentially would needlessly double
  // the compose latency on slow disks.
  const [tmpl, loadedShots] = await Promise.all([
    templateSrc ? loadImageCached(templateSrc) : Promise.resolve(null),
    Promise.all(
      shots.map((s) => (s ? loadImageCached(s).catch(() => null) : Promise.resolve(null)))
    ),
  ]);

  // Each slot points to a shotIndex — the same shot may appear in
  // multiple slots (e.g. mirrored 2-column strip layouts duplicate
  // each photo into the left + right column).
  const printPhotoFilter = [photoFilter, PRINT_PHOTO_FILTER].filter(Boolean).join(' ');
  for (const slot of slots) {
    const img = loadedShots[slot.shotIndex];
    if (!img) continue;
    ctx.save();
    if (printPhotoFilter) ctx.filter = printPhotoFilter;
    drawCover(ctx, img, slot.x, slot.y, slot.w, slot.h);
    ctx.restore();
  }

  // Template goes on top — its alpha channel punches the windows
  // through which the shots beneath are visible.
  if (tmpl) ctx.drawImage(tmpl, 0, 0, W, H);

  return canvas;
}

export function normalizePrintOutputCanvas(layout, sourceCanvas) {
  if ((layout?.canvas?.w || 0) <= (layout?.canvas?.h || 0)) {
    return sourceCanvas;
  }

  const rotated = document.createElement('canvas');
  rotated.width = sourceCanvas.height;
  rotated.height = sourceCanvas.width;
  const ctx = rotated.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  ctx.translate(rotated.width, 0);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(sourceCanvas, 0, 0);

  return rotated;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function getCanvasSafeArea(canvasW, canvasH, margin = {}) {
  const left = clamp(Number(margin.left) || 0, 0, Math.max(0, canvasW - 1));
  const right = clamp(Number(margin.right) || 0, 0, Math.max(0, canvasW - 1 - left));
  const top = clamp(Number(margin.top) || 0, 0, Math.max(0, canvasH - 1));
  const bottom = clamp(Number(margin.bottom) || 0, 0, Math.max(0, canvasH - 1 - top));

  const safeArea = {
    x: left,
    y: top,
    w: canvasW - left - right,
    h: canvasH - top - bottom,
  };

  if (safeArea.w <= 0 || safeArea.h <= 0) {
    throw new Error('Print safe area is invalid for the current canvas size.');
  }

  return safeArea;
}

export async function buildFinalPrintCanvas(layout, templateSrc, shots, photoFilter = '', printSettings = {}) {
  const composedLayoutCanvas = normalizePrintOutputCanvas(
    layout,
    await composePrintCanvas(layout, templateSrc, shots, photoFilter),
  );
  const profile = getPrinterProfile(printSettings?.printerProfileId);
  const profilePrintArea = getPrintArea(profile, printSettings?.safeMarginOverride);
  const safeMargin = {
    top: profilePrintArea.y,
    right: profile.canvas.w - profilePrintArea.x - profilePrintArea.w,
    bottom: profile.canvas.h - profilePrintArea.y - profilePrintArea.h,
    left: profilePrintArea.x,
  };

  const finalCanvas = document.createElement('canvas');
  finalCanvas.width = composedLayoutCanvas.width;
  finalCanvas.height = composedLayoutCanvas.height;

  const ctx = finalCanvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, finalCanvas.width, finalCanvas.height);
  const printArea = getCanvasSafeArea(finalCanvas.width, finalCanvas.height, safeMargin);
  const compensatedBounds = {
    x: printArea.x,
    y: printArea.y + TOP_DEAD_CUT_PX,
    w: printArea.w,
    h: printArea.h - TOP_DEAD_CUT_PX,
  };

  if (compensatedBounds.h <= 0) {
    throw new Error('Top dead cut compensation exceeds the available print height.');
  }

  ctx.drawImage(
    composedLayoutCanvas,
    compensatedBounds.x,
    compensatedBounds.y,
    compensatedBounds.w,
    compensatedBounds.h,
  );

  return finalCanvas;
}

export async function composePrintImage(layout, templateSrc, shots, printSettings = {}) {
  const canvas = await buildFinalPrintCanvas(layout, templateSrc, shots, '', printSettings);
  return canvas.toDataURL('image/jpeg', PRINT_JPEG_QUALITY);
}

export function generateCalibrationGuide(layout, printSettings = {}) {
  const W = layout?.canvas?.w || layout?.canvas?.width || 1200;
  const H = layout?.canvas?.h || layout?.canvas?.height || 1800;

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = 'rgba(180, 180, 180, 0.4)';
  ctx.lineWidth = 0.5;
  for (let x = 10; x < W; x += 10) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
  }
  for (let y = 10; y < H; y += 10) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }

  const profile = getPrinterProfile(printSettings?.printerProfileId);
  const profilePrintArea = getPrintArea(profile, printSettings?.safeMarginOverride);
  const safeMargin = {
    top: profilePrintArea.y,
    right: profile.canvas.w - profilePrintArea.x - profilePrintArea.w,
    bottom: profile.canvas.h - profilePrintArea.y - profilePrintArea.h,
    left: profilePrintArea.x,
  };
  const sx = safeMargin.left;
  const sy = safeMargin.top;
  const sw = W - safeMargin.left - safeMargin.right;
  const sh = H - safeMargin.top - safeMargin.bottom;

  ctx.strokeStyle = 'rgba(0, 80, 220, 0.9)';
  ctx.lineWidth = 2;
  ctx.strokeRect(sx + 1, sy + 1, sw - 2, sh - 2);

  ctx.strokeStyle = 'rgba(220, 120, 0, 0.9)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([8, 4]);
  ctx.beginPath();
  ctx.moveTo(sx, sy + TOP_DEAD_CUT_PX);
  ctx.lineTo(sx + sw, sy + TOP_DEAD_CUT_PX);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.strokeStyle = 'rgba(220, 0, 0, 0.9)';
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, W - 2, H - 2);

  const ch = 20;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
  ctx.lineWidth = 1;
  for (const [cx, cy] of [[0, 0], [W, 0], [0, H], [W, H]]) {
    const ox = cx === 0 ? 1 : -1;
    const oy = cy === 0 ? 1 : -1;
    ctx.beginPath(); ctx.moveTo(cx + ox * 2, cy); ctx.lineTo(cx + ox * ch, cy); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx, cy + oy * 2); ctx.lineTo(cx, cy + oy * ch); ctx.stroke();
  }

  ctx.font = 'bold 22px monospace';
  ctx.fillStyle = '#111111';
  ctx.textAlign = 'left';
  const lx = sx + 12;
  let ly = sy + TOP_DEAD_CUT_PX + 32;
  const lineH = 30;
  ctx.fillText(`Canvas: ${W} × ${H}px`, lx, ly); ly += lineH;
  ctx.fillText(`Safe margin — top:${safeMargin.top} right:${safeMargin.right} bottom:${safeMargin.bottom} left:${safeMargin.left}`, lx, ly); ly += lineH;
  ctx.fillText(`Dead-cut offset: ${TOP_DEAD_CUT_PX}px (orange line)`, lx, ly); ly += lineH;
  ctx.fillText(`Print JPEG quality: ${PRINT_JPEG_QUALITY}`, lx, ly); ly += lineH;
  ctx.fillText(`Photo filter: ${PRINT_PHOTO_FILTER}`, lx, ly);

  ctx.font = '18px monospace';
  const legendY = H - safeMargin.bottom - 12;
  ctx.fillStyle = 'rgba(220, 0, 0, 0.9)';
  ctx.fillText('Red = canvas edge', lx, legendY - 48);
  ctx.fillStyle = 'rgba(0, 80, 220, 0.9)';
  ctx.fillText('Blue = safe print area', lx, legendY - 24);
  ctx.fillStyle = 'rgba(220, 120, 0, 0.9)';
  ctx.fillText('Orange dashed = dead-cut offset (content starts here)', lx, legendY);

  return canvas;
}
