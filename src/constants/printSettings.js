export const PRINT_JPEG_QUALITY = 0.98;

export const MIN_PRINT_COPIES = 1;
export const MAX_PRINT_COPIES = 3;
export const DEFAULT_PRINT_COPIES = 1;

export function clampPrintCopies(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return DEFAULT_PRINT_COPIES;
  return Math.min(MAX_PRINT_COPIES, Math.max(MIN_PRINT_COPIES, Math.floor(numericValue)));
}

// Canon SELPHY CP1500 photo-layer compensation presets:
// Test A = safer/natural brightening
// Test B = recommended starting point
// Test C = brighter with softer contrast/saturation
export const PRINT_PHOTO_FILTER_TEST_A = 'brightness(1.14) contrast(1.04) saturate(1.04)';
export const PRINT_PHOTO_FILTER_TEST_B = 'brightness(1.16) contrast(1.04) saturate(1.03)';
export const PRINT_PHOTO_FILTER_TEST_C = 'brightness(1.18) contrast(1.02) saturate(1.02)';

export const PRINT_PHOTO_FILTER = PRINT_PHOTO_FILTER_TEST_B;

// Compensates for Canon SELPHY top dead-cut behavior when placing the
// composed strip inside the printer-safe area.
export const TOP_DEAD_CUT_PX = 18;

// Main place to tune Canon SELPHY print safe margins. These preserve the
// existing CP1500 behavior while keeping the common calibration knobs together.
export const DEFAULT_SAFE_MARGIN_OVERRIDE = {
  top: 33,
  right: 33,
  bottom: 75,
  left: 32,
};
