import { DEFAULT_PRINTER_PROFILE_ID, DEFAULT_SAFE_MARGIN_OVERRIDE } from '../constants/printers';
import {
  DEFAULT_SOFTCOPY_SETTINGS,
  hasSoftcopySettings,
  loadStoredSoftcopySettings,
  normalizeSoftcopySettings,
  saveStoredSoftcopySettings,
} from '../constants/softcopySettings';
import {
  DEFAULT_COUNTDOWN_SECONDS,
  normalizeCountdownSeconds,
} from '../constants/countdownSettings';
import {
  DEFAULT_LAYOUT_SETTINGS,
  hasLayoutSettings,
  loadStoredLayoutSettings,
  normalizeLayoutSettings,
  saveStoredLayoutSettings,
} from '../constants/layoutSettings';
import {
  DEFAULT_BEAUTIFICATION_SETTINGS,
  normalizeBeautificationSettings,
} from '../constants/beautificationSettings';
import { useCallback, useEffect, useState } from 'react';

const IS_DEV = import.meta.env.DEV;

const DEFAULT_SETTINGS = {
  mode: 'daily',
  activeEventId: null,
  printEnabled: true,
  printCopiesEnabled: false,
  selectedPrinterName: null,
  printerProfileId: DEFAULT_PRINTER_PROFILE_ID,
  safeMarginOverride: DEFAULT_SAFE_MARGIN_OVERRIDE,
  softcopySettings: DEFAULT_SOFTCOPY_SETTINGS,
  layoutSettings: DEFAULT_LAYOUT_SETTINGS,
  bundledTemplateOverrides: {},
  countdownSeconds: DEFAULT_COUNTDOWN_SECONDS,
  beautificationSettings: DEFAULT_BEAUTIFICATION_SETTINGS,
  testModeEnabled: false,
};

function resolveFallbackSettings() {
  const softcopySettings = loadStoredSoftcopySettings() ?? DEFAULT_SOFTCOPY_SETTINGS;
  const layoutSettings = loadStoredLayoutSettings() ?? DEFAULT_LAYOUT_SETTINGS;
  if (IS_DEV) {
    console.log('[settings] localStorage fallback used', { group: 'softcopySettings' });
    console.log('[settings] localStorage fallback used', { group: 'layoutSettings' });
    console.log('[settings] source resolved', { group: 'softcopySettings', source: 'localStorage' });
    console.log('[settings] source resolved', { group: 'layoutSettings', source: 'localStorage' });
  }
  return {
    ...DEFAULT_SETTINGS,
    softcopySettings,
    layoutSettings,
    countdownSeconds: DEFAULT_COUNTDOWN_SECONDS,
    testModeEnabled: false,
  };
}

export function useAdminConfig() {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    if (!window.adminApi?.getSettings || !window.adminApi?.listEvents) {
      setSettings(resolveFallbackSettings());
      setEvents([]);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    try {
      const [settingsRes, eventsRes] = await Promise.all([
        window.adminApi.getSettings(),
        window.adminApi.listEvents(),
      ]);

      if (!settingsRes?.ok) {
        throw new Error(settingsRes?.error || 'failed to load settings');
      }
      if (!eventsRes?.ok) {
        throw new Error(eventsRes?.error || 'failed to load events');
      }

      if (IS_DEV) console.log('[settings] loaded electron settings', settingsRes.settings);
      const loadedSoftcopySettings = hasSoftcopySettings(settingsRes.settings)
        ? normalizeSoftcopySettings(settingsRes.settings.softcopySettings)
        : (loadStoredSoftcopySettings() ?? DEFAULT_SOFTCOPY_SETTINGS);
      const softcopySource = hasSoftcopySettings(settingsRes.settings) ? 'electron' : 'localStorage';
      const hasElectronLayoutSettings = hasLayoutSettings(settingsRes.settings);
      const loadedLayoutSettings = hasElectronLayoutSettings
        ? normalizeLayoutSettings(settingsRes.settings.layoutSettings)
        : (loadStoredLayoutSettings() ?? DEFAULT_LAYOUT_SETTINGS);
      if (IS_DEV) {
        console.log('[settings] source resolved', { group: 'softcopySettings', source: softcopySource });
        console.log('[settings] source resolved', { group: 'layoutSettings', source: hasElectronLayoutSettings ? 'electron' : 'localStorage' });
      }
      if (IS_DEV && softcopySource === 'localStorage') {
        console.log('[settings] localStorage fallback used', { group: 'softcopySettings' });
      }
      if (IS_DEV && !hasElectronLayoutSettings) {
        console.log('[settings] localStorage fallback used', { group: 'layoutSettings' });
      }
      if (hasSoftcopySettings(settingsRes.settings)) {
        saveStoredSoftcopySettings(loadedSoftcopySettings);
        if (IS_DEV) console.log('[settings] saved', { group: 'softcopySettings', settings: loadedSoftcopySettings });
      }
      if (hasElectronLayoutSettings) {
        saveStoredLayoutSettings(loadedLayoutSettings);
        if (IS_DEV) console.log('[settings] saved', { group: 'layoutSettings', settings: loadedLayoutSettings });
      }
      setSettings({
        mode: settingsRes.settings?.mode === 'event' ? 'event' : 'daily',
        activeEventId: settingsRes.settings?.activeEventId ?? null,
        printEnabled: settingsRes.settings?.printEnabled !== false,
        printCopiesEnabled: settingsRes.settings?.printCopiesEnabled === true,
        selectedPrinterName: settingsRes.settings?.selectedPrinterName || null,
        printerProfileId: settingsRes.settings?.printerProfileId === 'dnp_4x6' ? 'dnp_4x6' : DEFAULT_PRINTER_PROFILE_ID,
        safeMarginOverride: settingsRes.settings?.safeMarginOverride ?? DEFAULT_SAFE_MARGIN_OVERRIDE,
        softcopySettings: loadedSoftcopySettings,
        layoutSettings: loadedLayoutSettings,
        bundledTemplateOverrides: settingsRes.settings?.bundledTemplateOverrides ?? {},
        countdownSeconds: normalizeCountdownSeconds(settingsRes.settings?.countdownSeconds),
        beautificationSettings: normalizeBeautificationSettings(
          settingsRes.settings?.beautificationSettings,
        ),
        testModeEnabled: settingsRes.settings?.testModeEnabled === true,
      });
      setEvents(eventsRes.events || []);
      setError(null);
    } catch (err) {
      setSettings(resolveFallbackSettings());
      setEvents([]);
      setError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Initial hydration is intentional: the hook owns the shared admin
    // snapshot and immediately syncs from the Electron-backed store.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!window.adminApi?.onSettingsChanged && !window.adminApi?.onEventsChanged) return undefined;
    const handleSettingsChange = (nextSettings) => {
      if (!nextSettings || typeof nextSettings !== 'object' || Array.isArray(nextSettings)) {
        refresh();
        return;
      }

      if (IS_DEV) console.log('[settings] changed broadcast received', { group: 'appSettings', settings: nextSettings });
      const loadedSoftcopySettings = hasSoftcopySettings({ softcopySettings: nextSettings.softcopySettings })
        ? normalizeSoftcopySettings(nextSettings.softcopySettings)
        : (loadStoredSoftcopySettings() ?? DEFAULT_SOFTCOPY_SETTINGS);
      const softcopySource = hasSoftcopySettings({ softcopySettings: nextSettings.softcopySettings }) ? 'electron' : 'localStorage';
      const hasElectronLayoutSettings = nextSettings.layoutSettings
        && typeof nextSettings.layoutSettings === 'object'
        && !Array.isArray(nextSettings.layoutSettings);
      const loadedLayoutSettings = hasElectronLayoutSettings
        ? normalizeLayoutSettings(nextSettings.layoutSettings)
        : (loadStoredLayoutSettings() ?? DEFAULT_LAYOUT_SETTINGS);
      if (IS_DEV) {
        console.log('[settings] source resolved', { group: 'softcopySettings', source: softcopySource });
        console.log('[settings] source resolved', { group: 'layoutSettings', source: hasElectronLayoutSettings ? 'electron' : 'localStorage' });
      }
      if (IS_DEV && softcopySource === 'localStorage') {
        console.log('[settings] localStorage fallback used', { group: 'softcopySettings' });
      }
      if (IS_DEV && !hasElectronLayoutSettings) {
        console.log('[settings] localStorage fallback used', { group: 'layoutSettings' });
      }

      if (hasSoftcopySettings({ softcopySettings: nextSettings.softcopySettings })) {
        saveStoredSoftcopySettings(loadedSoftcopySettings);
        if (IS_DEV) console.log('[settings] saved', { group: 'softcopySettings', settings: loadedSoftcopySettings });
      }
      if (hasElectronLayoutSettings) {
        saveStoredLayoutSettings(loadedLayoutSettings);
        if (IS_DEV) console.log('[settings] saved', { group: 'layoutSettings', settings: loadedLayoutSettings });
      }

      setSettings({
        mode: nextSettings.mode === 'event' ? 'event' : 'daily',
        activeEventId: nextSettings.activeEventId ?? null,
        printEnabled: nextSettings.printEnabled !== false,
        printCopiesEnabled: nextSettings.printCopiesEnabled === true,
        selectedPrinterName: nextSettings.selectedPrinterName || null,
        printerProfileId: nextSettings.printerProfileId === 'dnp_4x6' ? 'dnp_4x6' : DEFAULT_PRINTER_PROFILE_ID,
        safeMarginOverride: nextSettings.safeMarginOverride ?? DEFAULT_SAFE_MARGIN_OVERRIDE,
        softcopySettings: loadedSoftcopySettings,
        layoutSettings: loadedLayoutSettings,
        bundledTemplateOverrides: nextSettings.bundledTemplateOverrides ?? {},
        countdownSeconds: normalizeCountdownSeconds(nextSettings.countdownSeconds),
        beautificationSettings: normalizeBeautificationSettings(
          nextSettings.beautificationSettings,
        ),
        testModeEnabled: nextSettings.testModeEnabled === true,
      });
      setError(null);
      setLoading(false);
    };
    const refreshFromChange = () => {
      refresh();
    };
    const unsubSettings = window.adminApi.onSettingsChanged?.(handleSettingsChange);
    const unsubEvents = window.adminApi.onEventsChanged?.(refreshFromChange);
    return () => {
      unsubSettings?.();
      unsubEvents?.();
    };
  }, [refresh]);

  return {
    settings,
    events,
    loading,
    error,
    refresh,
  };
}
