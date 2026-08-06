export const CAMERA_ORIENTATIONS = Object.freeze({
  MIRRORED: 'mirrored',
  ALTERNATE: 'alternate',
});

export const DEFAULT_CAMERA_ORIENTATION = CAMERA_ORIENTATIONS.MIRRORED;

// Historical customer output was mirrored. Use that as the fallback for old
// sessions and old local metadata that did not store an orientation value.
export const LEGACY_CAMERA_ORIENTATION = DEFAULT_CAMERA_ORIENTATION;

export function normalizeCameraOrientation(value) {
  return value === CAMERA_ORIENTATIONS.ALTERNATE
    ? CAMERA_ORIENTATIONS.ALTERNATE
    : CAMERA_ORIENTATIONS.MIRRORED;
}

export function isCameraOrientationMirrored(value) {
  return normalizeCameraOrientation(value) === CAMERA_ORIENTATIONS.MIRRORED;
}
