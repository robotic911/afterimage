export const MIN_COUNTDOWN_SECONDS = 1;
export const MAX_COUNTDOWN_SECONDS = 10;
export const DEFAULT_COUNTDOWN_SECONDS = 3;

export function normalizeCountdownSeconds(value, fallback = DEFAULT_COUNTDOWN_SECONDS) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return Math.min(MAX_COUNTDOWN_SECONDS, Math.max(MIN_COUNTDOWN_SECONDS, Number(fallback) || DEFAULT_COUNTDOWN_SECONDS));
  }
  return Math.min(MAX_COUNTDOWN_SECONDS, Math.max(MIN_COUNTDOWN_SECONDS, Math.round(parsed)));
}

