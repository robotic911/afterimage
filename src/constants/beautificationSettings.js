export const MIN_BEAUTIFICATION_INTENSITY = 0;
export const MAX_BEAUTIFICATION_INTENSITY = 100;
export const DEFAULT_BEAUTIFICATION_INTENSITY = 35;

export const DEFAULT_BEAUTIFICATION_SETTINGS = {
  enabled: true,
  intensity: DEFAULT_BEAUTIFICATION_INTENSITY,
};

export function normalizeBeautificationIntensity(
  value,
  fallback = DEFAULT_BEAUTIFICATION_INTENSITY,
) {
  const parsed = Number(value);
  const safeValue = Number.isFinite(parsed) ? parsed : Number(fallback);
  return Math.min(
    MAX_BEAUTIFICATION_INTENSITY,
    Math.max(MIN_BEAUTIFICATION_INTENSITY, Math.round(safeValue)),
  );
}

export function normalizeBeautificationSettings(settings = {}) {
  const source = settings && typeof settings === 'object' && !Array.isArray(settings)
    ? settings
    : {};
  return {
    enabled: source.enabled !== false,
    intensity: normalizeBeautificationIntensity(source.intensity),
  };
}

export function getBeautificationFilterCss(settings, { pixelScale = 1 } = {}) {
  const normalized = normalizeBeautificationSettings(settings);
  if (!normalized.enabled || normalized.intensity <= 0) return '';

  const amount = normalized.intensity / MAX_BEAUTIFICATION_INTENSITY;
  const brightness = 1 + (0.06 * amount);
  const contrast = 1 - (0.07 * amount);
  const saturation = 1 + (0.03 * amount);
  const sepia = 0.04 * amount;
  const blurPx = 0.8 * amount * Math.max(0.1, Number(pixelScale) || 1);

  return [
    `brightness(${brightness.toFixed(3)})`,
    `contrast(${contrast.toFixed(3)})`,
    `saturate(${saturation.toFixed(3)})`,
    `sepia(${sepia.toFixed(3)})`,
    `blur(${blurPx.toFixed(2)}px)`,
  ].join(' ');
}
