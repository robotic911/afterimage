import { DEFAULT_SAFE_MARGIN_OVERRIDE } from './printSettings';

export const DEFAULT_PRINTER_PROFILES = {
  selphy_cp1500: {
    id: 'selphy_cp1500',
    name: 'Canon Selphy CP1500',
    canvas: { w: 1200, h: 1800 },
    safeMargin: {
      top: 33,
      right: 33,
      bottom: 75,
      left: 33,
    },
  },
  dnp_4x6: {
    id: 'dnp_4x6',
    name: 'DNP 4x6',
    canvas: { w: 1200, h: 1800 },
    safeMargin: {
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
    },
  },
};

export const PRINTER_PROFILES = Object.values(DEFAULT_PRINTER_PROFILES);
export const DEFAULT_PRINTER_PROFILE_ID = 'selphy_cp1500';
export { DEFAULT_SAFE_MARGIN_OVERRIDE };

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function getPrinterProfile(profileId) {
  return DEFAULT_PRINTER_PROFILES[profileId] || DEFAULT_PRINTER_PROFILES[DEFAULT_PRINTER_PROFILE_ID];
}

export function normalizeSafeMargin(margin = {}, profileId = DEFAULT_PRINTER_PROFILE_ID) {
  if (profileId !== 'selphy_cp1500') {
    return { top: 0, right: 0, bottom: 0, left: 0 };
  }

  const left = clamp(Number(margin.left) || 0, 0, 300);
  const right = clamp(Number(margin.right) || 0, 0, 300);
  const top = clamp(Number(margin.top) || 0, 0, 300);
  const bottom = clamp(Number(margin.bottom) || 0, 0, 300);

  return {
    left,
    right: clamp(right, 0, 1199 - left),
    top,
    bottom: clamp(bottom, 0, 1799 - top),
  };
}

export function getActiveSafeMargin(profile, overrideMargin) {
  const activeProfile = profile || getPrinterProfile();
  if (activeProfile.id !== 'selphy_cp1500') {
    return { top: 0, right: 0, bottom: 0, left: 0 };
  }
  return normalizeSafeMargin(overrideMargin || activeProfile.safeMargin, activeProfile.id);
}

export function getPrintArea(profile, overrideMargin) {
  const activeProfile = profile || getPrinterProfile();
  const canvasW = activeProfile.canvas.w;
  const canvasH = activeProfile.canvas.h;
  const margin = getActiveSafeMargin(activeProfile, overrideMargin);

  const x = margin.left;
  const y = margin.top;
  const w = canvasW - margin.left - margin.right;
  const h = canvasH - margin.top - margin.bottom;

  return { x, y, w, h };
}
