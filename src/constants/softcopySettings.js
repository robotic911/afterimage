// QR softcopy media tuning. These values protect Supabase Storage/Egress
// without changing print output, captured photo quality, or layout geometry.
export const SESSION_VIDEO_SCALE = 0.6;
export const SESSION_VIDEO_FPS = 24;
export const SESSION_VIDEO_PRELOAD = 'metadata';
export const SESSION_VIDEO_AUTOPLAY = false;
export const VIDEO_SOFTCOPY_DURATION_MS = 10_000;

// GIFs are intentionally larger than the old defaults because the
// smaller versions were visibly soft/pixelated in the QR download flow.
export const GIF_OUTPUT_SCALE = 0.85;
export const GIF_FRAME_INTERVAL = 0.8;
export const GIF_QUALITY = 5;

export const MAX_RECOMMENDED_VIDEO_MB = 15;
export const MAX_RECOMMENDED_VIDEO_BYTES = MAX_RECOMMENDED_VIDEO_MB * 1024 * 1024;
export const MAX_RECOMMENDED_GIF_MB = 10;
export const MAX_RECOMMENDED_GIF_BYTES = MAX_RECOMMENDED_GIF_MB * 1024 * 1024;
export const MAX_RECOMMENDED_SESSION_UPLOAD_MB = 25;
export const MAX_RECOMMENDED_SESSION_UPLOAD_BYTES = MAX_RECOMMENDED_SESSION_UPLOAD_MB * 1024 * 1024;

export const DEFAULT_SOFTCOPY_SETTINGS = {
  qrEnabled: true,
  photoEnabled: true,
  gifEnabled: true,
  videoEnabled: true,
};

const SOFTCOPY_SETTINGS_STORAGE_KEY = 'afterimage.softcopySettings';

export function normalizeSoftcopySettings(settings = {}) {
  const source = settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {};
  return {
    ...DEFAULT_SOFTCOPY_SETTINGS,
    qrEnabled: source.qrEnabled ?? DEFAULT_SOFTCOPY_SETTINGS.qrEnabled,
    photoEnabled: source.photoEnabled ?? DEFAULT_SOFTCOPY_SETTINGS.photoEnabled,
    gifEnabled: source.gifEnabled ?? DEFAULT_SOFTCOPY_SETTINGS.gifEnabled,
    videoEnabled: source.videoEnabled ?? DEFAULT_SOFTCOPY_SETTINGS.videoEnabled,
  };
}

export function hasSoftcopySettings(settings) {
  return Boolean(
    settings
      && typeof settings === 'object'
      && !Array.isArray(settings)
      && Object.prototype.hasOwnProperty.call(settings, 'softcopySettings')
      && settings.softcopySettings
      && typeof settings.softcopySettings === 'object'
      && !Array.isArray(settings.softcopySettings),
  );
}

export function resolveSoftcopySettings(settings) {
  if (settings && typeof settings === 'object' && !Array.isArray(settings)) {
    return normalizeSoftcopySettings(settings);
  }
  return loadStoredSoftcopySettings() ?? DEFAULT_SOFTCOPY_SETTINGS;
}

export function loadStoredSoftcopySettings() {
  try {
    const raw = localStorage.getItem(SOFTCOPY_SETTINGS_STORAGE_KEY);
    if (!raw) return null;
    return normalizeSoftcopySettings(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function saveStoredSoftcopySettings(settings) {
  try {
    const normalized = normalizeSoftcopySettings(settings);
    localStorage.setItem(SOFTCOPY_SETTINGS_STORAGE_KEY, JSON.stringify(normalized));
    return normalized;
  } catch {
    return normalizeSoftcopySettings(settings);
  }
}
