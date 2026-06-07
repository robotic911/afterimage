import { LAYOUTS } from './layouts';

const IS_DEV = import.meta.env.DEV;

export const DEFAULT_LAYOUT_SETTINGS = LAYOUTS.reduce((settings, layout) => ({
  ...settings,
  [layout.id]: {
    enabled: layout.enabled ?? true,
  },
}), {});

const LAYOUT_SETTINGS_STORAGE_KEY = 'afterimage.layoutSettings';

export function normalizeLayoutSettings(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};

  return LAYOUTS.reduce((settings, layout) => {
    const saved = source[layout.id];
    const savedObject = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};

    return {
      ...settings,
      [layout.id]: {
        enabled: savedObject.enabled ?? DEFAULT_LAYOUT_SETTINGS[layout.id].enabled,
      },
    };
  }, {});
}

export function hasLayoutSettings(settings) {
  return Boolean(
    settings
      && typeof settings === 'object'
      && !Array.isArray(settings)
      && Object.prototype.hasOwnProperty.call(settings, 'layoutSettings')
      && settings.layoutSettings
      && typeof settings.layoutSettings === 'object'
      && !Array.isArray(settings.layoutSettings),
  );
}

export function loadStoredLayoutSettings() {
  try {
    const raw = localStorage.getItem(LAYOUT_SETTINGS_STORAGE_KEY);
    if (!raw) return null;
    return normalizeLayoutSettings(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function saveStoredLayoutSettings(settings) {
  try {
    const normalized = normalizeLayoutSettings(settings);
    localStorage.setItem(LAYOUT_SETTINGS_STORAGE_KEY, JSON.stringify(normalized));
    return normalized;
  } catch {
    return normalizeLayoutSettings(settings);
  }
}

export function resolveLayoutSettings(settings) {
  if (settings && typeof settings === 'object' && !Array.isArray(settings)) {
    return normalizeLayoutSettings(settings);
  }
  return loadStoredLayoutSettings() ?? DEFAULT_LAYOUT_SETTINGS;
}

export function isLayoutEnabled(layoutId, layoutSettings = {}) {
  const normalized = normalizeLayoutSettings(layoutSettings);
  const enabled = normalized[layoutId]?.enabled ?? DEFAULT_LAYOUT_SETTINGS[layoutId]?.enabled ?? true;
  return enabled !== false;
}

export function getEnabledLayouts(layoutSettings = {}) {
  const normalized = normalizeLayoutSettings(layoutSettings);
  return LAYOUTS.filter((layout) => {
    const enabled = normalized[layout.id]?.enabled ?? DEFAULT_LAYOUT_SETTINGS[layout.id]?.enabled ?? true;
    if (IS_DEV) console.log('[layout] resolved layout enabled state', { layoutId: layout.id, enabled });
    return enabled !== false;
  });
}
