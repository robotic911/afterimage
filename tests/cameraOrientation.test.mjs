import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CAMERA_ORIENTATIONS,
  DEFAULT_CAMERA_ORIENTATION,
  LEGACY_CAMERA_ORIENTATION,
  isCameraOrientationMirrored,
  normalizeCameraOrientation,
} from '../src/constants/cameraSettings.js';

test('new customer sessions default to mirrored orientation', () => {
  assert.equal(DEFAULT_CAMERA_ORIENTATION, CAMERA_ORIENTATIONS.MIRRORED);
  assert.equal(isCameraOrientationMirrored(DEFAULT_CAMERA_ORIENTATION), true);
});

test('alternate orientation is preserved and does not mirror camera content', () => {
  assert.equal(normalizeCameraOrientation(CAMERA_ORIENTATIONS.ALTERNATE), CAMERA_ORIENTATIONS.ALTERNATE);
  assert.equal(isCameraOrientationMirrored(CAMERA_ORIENTATIONS.ALTERNATE), false);
});

test('legacy or missing session orientation falls back to the historical mirrored output', () => {
  assert.equal(LEGACY_CAMERA_ORIENTATION, CAMERA_ORIENTATIONS.MIRRORED);
  assert.equal(normalizeCameraOrientation(null), CAMERA_ORIENTATIONS.MIRRORED);
  assert.equal(normalizeCameraOrientation(undefined), CAMERA_ORIENTATIONS.MIRRORED);
  assert.equal(normalizeCameraOrientation(''), CAMERA_ORIENTATIONS.MIRRORED);
  assert.equal(normalizeCameraOrientation('unexpected'), CAMERA_ORIENTATIONS.MIRRORED);
});
