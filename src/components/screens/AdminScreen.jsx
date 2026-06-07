import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './AdminScreen.css';
import AdminDashboard from './AdminDashboard';
import { LAYOUTS } from '../../constants/layouts';
import {
  DEFAULT_PRINTER_PROFILE_ID,
  DEFAULT_SAFE_MARGIN_OVERRIDE,
  PRINTER_PROFILES,
  getPrintArea,
  getPrinterProfile,
  getActiveSafeMargin,
} from '../../constants/printers';
import {
  DEFAULT_SOFTCOPY_SETTINGS,
  hasSoftcopySettings,
  normalizeSoftcopySettings,
  saveStoredSoftcopySettings,
} from '../../constants/softcopySettings';
import {
  DEFAULT_LAYOUT_SETTINGS,
  hasLayoutSettings,
  normalizeLayoutSettings,
  saveStoredLayoutSettings,
} from '../../constants/layoutSettings';
import {
  DEFAULT_COUNTDOWN_SECONDS,
  MAX_COUNTDOWN_SECONDS,
  MIN_COUNTDOWN_SECONDS,
  normalizeCountdownSeconds,
} from '../../constants/countdownSettings';
import {
  DEFAULT_UI_COLOR_THEME_ID,
  UI_COLOR_THEME_LIST,
} from '../../constants/colorThemes';
import { invalidateImageCache } from '../../lib/imageCache';
import { versionTemplateAssetSrc } from '../../lib/templateAssetUrl';
import { getTemplateVisibilityKey } from '../../lib/templateVisibility';

const LAYOUT_ORDER = ['classic-strip-4', 'classic-strip-3', 'portrait-grid', 'studio-quad'];
const TEMPLATE_TYPE_ORDER = ['Original', 'Themed'];
const TEMPLATE_STATUS_CATEGORIES = [
  { key: 'active', title: 'Active', enabled: true },
  { key: 'inactive', title: 'Inactive', enabled: false },
];

function resolveTemplateType(templateLike = {}) {
  if (TEMPLATE_TYPE_ORDER.includes(templateLike.type)) {
    return templateLike.type;
  }

  const raw = `${templateLike.type || ''} ${templateLike.id || ''} ${templateLike.name || ''}`.toLowerCase();
  const themedKeywords = [
    'stripe',
    'rainbow',
    'kiddo',
    'kodak',
    'love',
    'omni',
    'invincible',
    'pop',
    'birthday',
    'wedding',
    'christmas',
    'graduation',
    'theme',
    'pattern',
  ];

  return themedKeywords.some((keyword) => raw.includes(keyword)) ? 'Themed' : 'Original';
}

function getAdminTemplatePriority(template = {}) {
  const sourceScore = template.source === 'bundled' || template.storageSource === 'bundled'
    ? 1
    : template.storageSource === 'legacy' || template.storageMode === 'legacy'
      ? 2
      : 3;
  const enabledScore = template.enabled !== false ? 1 : 0;
  const visibleScore = template.hidden === true || template.deleted === true ? 0 : 1;
  const updatedScore = Date.parse(template.updatedAt || '') || 0;
  const createdScore = Date.parse(template.createdAt || '') || 0;
  return [sourceScore, enabledScore, visibleScore, updatedScore, createdScore];
}

function compareAdminTemplatePriority(existing = {}, incoming = {}) {
  const a = getAdminTemplatePriority(existing);
  const b = getAdminTemplatePriority(incoming);
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return b[index] - a[index];
  }
  return 0;
}

function dedupeAdminTemplates(templates = []) {
  const winners = new Map();
  const order = [];
  for (const template of templates) {
    if (!template?.id) continue;
    const key = getTemplateVisibilityKey(template);
    if (!winners.has(key)) {
      winners.set(key, template);
      order.push(key);
      continue;
    }
    if (compareAdminTemplatePriority(winners.get(key), template) < 0) {
      winners.set(key, template);
    }
  }
  return order.map((key) => winners.get(key)).filter(Boolean);
}

// Blank form state for the "New Template" workflow.
const BLANK_DRAFT = {
  layoutId: LAYOUTS[0]?.id || '',
  name: '',
  type: 'Original',
  desc: '',
  enabled: true,
  overlayDataUrl: null,
  previewDataUrl: null,
};

export default function AdminScreen({
  active,
  templates = [],
  settings = {
    mode: 'daily',
    activeEventId: null,
    printEnabled: true,
    printerProfileId: DEFAULT_PRINTER_PROFILE_ID,
    safeMarginOverride: DEFAULT_SAFE_MARGIN_OVERRIDE,
    softcopySettings: DEFAULT_SOFTCOPY_SETTINGS,
    layoutSettings: DEFAULT_LAYOUT_SETTINGS,
    bundledTemplateOverrides: {},
    countdownSeconds: DEFAULT_COUNTDOWN_SECONDS,
    testModeEnabled: false,
  },
  events = [],
  onRefresh,
  onRefreshConfig,
  onExit,
  cursorHidden = false,
  onToggleCursorHidden,
}) {
  // Templates + refresh are owned by App.jsx so the customer flow and the
  // admin flow share a single source of truth. `loading` is synthesized
  // from whether we have any templates yet on first paint.
  const refresh = async () => { await onRefresh?.(); };
  const refreshConfig = async () => { await onRefreshConfig?.(); };
  const loading = false;

  // 'templates' | 'dashboard' | 'settings' — default landing tab is dashboard.
  const [tab, setTab] = useState('dashboard');

  const [selectedId, setSelectedId] = useState(null);   // null === creating new
  const [draft, setDraft] = useState(BLANK_DRAFT);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [assetSaving, setAssetSaving] = useState(null);
  const [statusMsg, setStatusMsg] = useState(null);     // transient toast text
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pinModal, setPinModal] = useState(false);
  const [eventManagerOpen, setEventManagerOpen] = useState(false);
  const [auditingDuplicateTemplates, setAuditingDuplicateTemplates] = useState(false);
  const [cleaningDuplicateTemplates, setCleaningDuplicateTemplates] = useState(false);
  const [duplicateCleanupPreview, setDuplicateCleanupPreview] = useState(null);
  const [duplicateCleanupConfirmOpen, setDuplicateCleanupConfirmOpen] = useState(false);
  const [activeLayoutId, setActiveLayoutId] = useState(LAYOUT_ORDER[0]);
  const [templateOverrides, setTemplateOverrides] = useState({});
  const [softcopyDraft, setSoftcopyDraft] = useState(() => normalizeSoftcopySettings(settings.softcopySettings));
  const [layoutDraft, setLayoutDraft] = useState(() => normalizeLayoutSettings(settings.layoutSettings));
  const [countdownDraft, setCountdownDraft] = useState(() => normalizeCountdownSeconds(settings.countdownSeconds));
  const overlayInputRef = useRef(null);
  const previewInputRef = useRef(null);
  const displayTemplates = useMemo(() => {
    const merged = templates.map((template) => (
      templateOverrides[template.id]
        ? { ...template, ...templateOverrides[template.id] }
        : template
    ));
    for (const override of Object.values(templateOverrides)) {
      if (override?.id && !merged.some((template) => template.id === override.id)) {
        merged.push(override);
      }
    }
    return dedupeAdminTemplates(merged);
  }, [templates, templateOverrides]);

  // Re-sync the editor draft whenever the selected template changes.
  useEffect(() => {
    queueMicrotask(() => {
      if (selectedId == null) {
        setDraft({ ...BLANK_DRAFT, layoutId: activeLayoutId });
        setDirty(false);
        return;
      }
      const t = displayTemplates.find(x => x.id === selectedId);
      if (t) {
        setDraft({
          layoutId: t.layoutId || LAYOUTS[0]?.id || '',
          name: t.name,
          type: resolveTemplateType(t),
          desc: t.desc || '',
          enabled: t.enabled !== false,
          overlayDataUrl: null,
          previewDataUrl: null,
        });
        setDirty(false);
      }
      });
  }, [selectedId, displayTemplates, activeLayoutId]);

  // Auto-dismiss the status toast
  useEffect(() => {
    if (!statusMsg) return;
    const id = setTimeout(() => setStatusMsg(null), 2600);
    return () => clearTimeout(id);
  }, [statusMsg]);

  useEffect(() => {
    const nextSoftcopySettings = normalizeSoftcopySettings(settings.softcopySettings);
    queueMicrotask(() => {
      setSoftcopyDraft((current) => {
        const currentSerialized = JSON.stringify(normalizeSoftcopySettings(current));
        const nextSerialized = JSON.stringify(nextSoftcopySettings);
        return currentSerialized === nextSerialized ? current : nextSoftcopySettings;
      });
    });
  }, [settings.softcopySettings]);

  useEffect(() => {
    const nextLayoutSettings = normalizeLayoutSettings(settings.layoutSettings);
    queueMicrotask(() => {
      setLayoutDraft((current) => {
        const currentSerialized = JSON.stringify(normalizeLayoutSettings(current));
        const nextSerialized = JSON.stringify(nextLayoutSettings);
        return currentSerialized === nextSerialized ? current : nextLayoutSettings;
      });
    });
  }, [settings.layoutSettings]);

  useEffect(() => {
    const nextCountdown = normalizeCountdownSeconds(settings.countdownSeconds);
    queueMicrotask(() => setCountdownDraft(nextCountdown));
  }, [settings.countdownSeconds]);

  useEffect(() => {
    if (active) {
      queueMicrotask(() => {
        setTab('dashboard');
        console.log('[admin] default tab', 'dashboard');
      });
    }
  }, [active]);

  const selectedTemplate = useMemo(
    () => displayTemplates.find(t => t.id === selectedId) || null,
    [displayTemplates, selectedId],
  );
  useEffect(() => {
    if (!import.meta.env.DEV || !selectedTemplate) return;
    console.log('[template:selected]', {
      id: selectedTemplate.id,
      name: selectedTemplate.name,
      layoutId: selectedTemplate.layoutId,
      previewSrc: selectedTemplate.previewSrc || null,
      overlaySrc: selectedTemplate.overlaySrc || null,
      previewEqualsOverlay: selectedTemplate.previewSrc === selectedTemplate.overlaySrc,
    });
  }, [selectedTemplate]);
  useEffect(() => {
    if (selectedId != null && !displayTemplates.some((template) => template.id === selectedId)) {
      queueMicrotask(() => setSelectedId(null));
    }
  }, [selectedId, displayTemplates]);
  const selectedLayout = useMemo(
    () => LAYOUTS.find((item) => item.id === draft.layoutId) || null,
    [draft.layoutId],
  );
  const activeLayout = useMemo(
    () => LAYOUTS.find((item) => item.id === activeLayoutId) || null,
    [activeLayoutId],
  );
  const layoutSettings = layoutDraft;
  const activeEvent = useMemo(
    () => events.find((event) => event.id === settings.activeEventId) || null,
    [events, settings.activeEventId],
  );
  const activePrinterProfile = useMemo(
    () => getPrinterProfile(settings.printerProfileId),
    [settings.printerProfileId],
  );
  const activeSafeMargin = useMemo(
    () => getActiveSafeMargin(activePrinterProfile, settings.safeMarginOverride),
    [activePrinterProfile, settings.safeMarginOverride],
  );
  const activePrintArea = useMemo(
    () => getPrintArea(activePrinterProfile, settings.safeMarginOverride),
    [activePrinterProfile, settings.safeMarginOverride],
  );
  const testModeEnabled = settings.testModeEnabled === true;
  const softcopySettings = softcopyDraft;
  const modeHeaderText = settings.mode === 'event'
    ? `Event - ${activeEvent?.name || 'Untitled Event'}`
    : 'Daily Mode';
  const isBundledTemplate = selectedTemplate?.source === 'bundled';
  const isRuntimeTemplate = selectedTemplate?.source === 'runtime';
  const templateMatchesScope = useCallback((template) => {
    const mode = template.mode || 'daily';
    if (settings.mode === 'daily') {
      return mode === 'daily';
    }
    if (!settings.activeEventId) {
      return false;
    }
    return mode === 'event' && template.eventId === settings.activeEventId;
  }, [settings.mode, settings.activeEventId]);
  const layoutNavItems = useMemo(() => {
    const templatesFor = (layoutId) => displayTemplates.filter((template) =>
      template.layoutId === layoutId && templateMatchesScope(template)
    );
    return LAYOUT_ORDER.map((layoutId) => {
      const layout = LAYOUTS.find((entry) => entry.id === layoutId);
      const layoutTemplates = templatesFor(layoutId);
      const activeCount = layoutTemplates.filter((template) => template.enabled !== false).length;
      const inactiveCount = layoutTemplates.length - activeCount;
      const layoutEnabled = layoutSettings[layoutId]?.enabled !== false;
      return {
        key: layoutId,
        title: layout?.name || layoutId,
        subtitle: layoutId,
        previewSrc: layout?.previewSrc || layout?.frameSrc || null,
        count: layoutTemplates.length,
        activeCount,
        inactiveCount,
        enabled: layoutEnabled,
      };
    });
  }, [displayTemplates, templateMatchesScope, layoutSettings]);
  const activeTemplates = useMemo(() => (
    displayTemplates.filter((template) =>
      template.layoutId === activeLayoutId && templateMatchesScope(template)
    )
  ), [displayTemplates, activeLayoutId, templateMatchesScope]);
  const invalidLayoutTemplates = useMemo(() => (
    displayTemplates.filter((template) =>
      (!template.layoutId || !LAYOUTS.some((layout) => layout.id === template.layoutId))
        && templateMatchesScope(template)
    )
  ), [displayTemplates, templateMatchesScope]);
  const sortedActiveTemplates = useMemo(
    () => [...activeTemplates].sort((a, b) => a.name.localeCompare(b.name)),
    [activeTemplates],
  );
  const templateStatusSections = useMemo(() => {
    return TEMPLATE_STATUS_CATEGORIES.map((category) => {
      const items = sortedActiveTemplates.filter((template) =>
        category.enabled ? template.enabled !== false : template.enabled === false
      );
      return {
        ...category,
        items,
      };
    });
  }, [sortedActiveTemplates]);

  useEffect(() => {
    if (!selectedTemplate) return;
    const selectedKey = selectedTemplate.layoutId || null;
    if (selectedKey !== activeLayoutId || !templateMatchesScope(selectedTemplate)) {
      queueMicrotask(() => setSelectedId(null));
    }
  }, [activeLayoutId, selectedTemplate, templateMatchesScope]);

  // ── Draft handlers ──
  const patchDraft = (patch) => { setDraft(d => ({ ...d, ...patch })); setDirty(true); };
  const explainTemplateSaveError = (error) => {
    const message = error || 'unknown';
    if (message === 'overlay PNG is required') return 'no overlay PNG was accepted. Replace Overlay with a valid layout-size PNG and save again.';
    if (message === 'preview PNG is required') return 'no preview PNG was accepted. Replace Preview with a valid PNG and save again.';
    if (message === 'invalid uploaded overlay PNG') return 'the uploaded overlay could not be decoded as a PNG. Choose another PNG and save again.';
    if (message === 'invalid uploaded preview PNG') return 'the uploaded preview could not be decoded as a PNG. Choose another PNG and save again.';
    if (message === 'invalid overlay PNG') return 'the uploaded overlay could not be decoded as a PNG. Choose another PNG and save again.';
    if (message === 'invalid preview PNG') return 'the uploaded preview could not be decoded as a PNG. Choose another PNG and save again.';
    if (message === 'existing bundled overlay PNG could not be reused') return 'the existing bundled overlay could not be reused. Replace Overlay with a valid layout-size PNG and save again.';
    if (message === 'existing bundled preview PNG could not be reused') return 'the existing bundled preview could not be reused. Replace Preview with a valid PNG and save again.';
    return message;
  };

  const updateAppMode = async (mode) => {
    if (!window.adminApi?.updateSettings) {
      setStatusMsg('Mode changes require Electron runtime.');
      return;
    }
    const res = await window.adminApi.updateSettings({
      mode,
      activeEventId: mode === 'event' ? settings.activeEventId : null,
    });
    if (!res?.ok) {
      setStatusMsg('Mode update failed: ' + (res?.error || 'unknown'));
      return;
    }
    await refreshConfig();
    setStatusMsg(mode === 'event' ? 'Event Mode enabled.' : 'Daily Mode enabled.');
  };

  const updateActiveEvent = async (eventId) => {
    if (!window.adminApi?.updateSettings) {
      setStatusMsg('Event changes require Electron runtime.');
      return;
    }
    const res = await window.adminApi.updateSettings({
      mode: 'event',
      activeEventId: eventId || null,
    });
    if (!res?.ok) {
      setStatusMsg('Active event update failed: ' + (res?.error || 'unknown'));
      return;
    }
    await refreshConfig();
    setStatusMsg(eventId ? 'Active event updated.' : 'Active event cleared.');
  };

  const updatePrintEnabled = async (printEnabled) => {
    if (!window.adminApi?.updateSettings) {
      setStatusMsg('Print setting changes require Electron runtime.');
      return;
    }
    const res = await window.adminApi.updateSettings({ printEnabled });
    if (!res?.ok) {
      setStatusMsg('Print setting update failed: ' + (res?.error || 'unknown'));
      return;
    }
    await refreshConfig();
    setStatusMsg(printEnabled ? 'Printing enabled.' : 'Printing disabled.');
  };

  const toggleTestMode = async () => {
    if (!window.adminApi?.updateSettings) {
      setStatusMsg('Test Mode changes require Electron runtime.');
      return;
    }
    const nextEnabled = !testModeEnabled;
    const res = await window.adminApi.updateSettings({ testModeEnabled: nextEnabled });
    if (!res?.ok) {
      setStatusMsg('Test Mode update failed: ' + (res?.error || 'unknown'));
      return;
    }
    console.log('[test-mode] changed', { enabled: nextEnabled });
    await refreshConfig();
    setStatusMsg(nextEnabled ? 'Test Mode enabled.' : 'Test Mode disabled.');
  };

  const updateSoftcopySetting = async (key, nextValue) => {
    const nextSoftcopySettings = normalizeSoftcopySettings({
      ...softcopySettings,
      [key]: nextValue,
    });
    if (key === 'qrEnabled') {
      console.log('[softcopy] QR toggled', { qrEnabled: nextValue });
    }
    setSoftcopyDraft(nextSoftcopySettings);
    saveStoredSoftcopySettings(nextSoftcopySettings);
    console.log('[settings] saved', { group: 'softcopySettings', settings: nextSoftcopySettings });
    if (!window.adminApi?.updateSettings) {
      setStatusMsg('Softcopy settings updated locally.');
      return;
    }
    try {
      const res = await window.adminApi.updateSettings({
        softcopySettings: nextSoftcopySettings,
      });
      if (!res?.ok) {
        throw new Error(res?.error || 'unknown');
      }
      const savedSettings = hasSoftcopySettings(res.settings)
        ? normalizeSoftcopySettings(res.settings.softcopySettings)
        : nextSoftcopySettings;
      setSoftcopyDraft(savedSettings);
      saveStoredSoftcopySettings(savedSettings);
      console.log('[settings] saved', { group: 'softcopySettings', settings: savedSettings });
      await refreshConfig();
    } catch (error) {
      console.error('[admin] failed to save softcopy settings', error);
      setStatusMsg('Softcopy settings update failed: ' + (error?.message || 'unknown'));
      await refreshConfig();
      return;
    }
    setStatusMsg('Softcopy QR settings updated.');
  };

  const updateCountdownSetting = async (value) => {
    const nextCountdownSeconds = normalizeCountdownSeconds(value);
    setCountdownDraft(nextCountdownSeconds);
    console.log('[settings] countdown seconds updated', nextCountdownSeconds);
    if (!window.adminApi?.updateSettings) {
      setStatusMsg('Countdown setting changes require Electron runtime.');
      return;
    }
    const res = await window.adminApi.updateSettings({
      countdownSeconds: nextCountdownSeconds,
    });
    if (!res?.ok) {
      setStatusMsg('Countdown update failed: ' + (res?.error || 'unknown'));
      await refreshConfig();
      return;
    }
    const savedCountdown = normalizeCountdownSeconds(res.settings?.countdownSeconds ?? nextCountdownSeconds);
    setCountdownDraft(savedCountdown);
    await refreshConfig();
    setStatusMsg(`Countdown set to ${savedCountdown} seconds.`);
  };

  const updateLayoutEnabled = async (layoutId, enabled) => {
    const nextLayoutSettings = normalizeLayoutSettings({
      ...layoutSettings,
      [layoutId]: {
        ...(layoutSettings[layoutId] || {}),
        enabled,
      },
    });
    setLayoutDraft(nextLayoutSettings);
    saveStoredLayoutSettings(nextLayoutSettings);
    console.log('[settings] saved', { group: 'layoutSettings', settings: nextLayoutSettings });
    if (!window.adminApi?.updateSettings) {
      setStatusMsg('Layout settings updated locally.');
      return;
    }
    const res = await window.adminApi.updateSettings({
      layoutSettings: nextLayoutSettings,
    });
    if (!res?.ok) {
      await refreshConfig();
      setStatusMsg('Layout setting update failed: ' + (res?.error || 'unknown'));
      return;
    }
    const savedLayoutSettings = hasLayoutSettings(res.settings)
      ? normalizeLayoutSettings(res.settings.layoutSettings)
      : nextLayoutSettings;
    setLayoutDraft(savedLayoutSettings);
    saveStoredLayoutSettings(savedLayoutSettings);
    console.log('[settings] saved', { group: 'layoutSettings', settings: savedLayoutSettings });
    await refreshConfig();
    const layoutName = LAYOUTS.find((layout) => layout.id === layoutId)?.name || layoutId;
    setStatusMsg(enabled ? `${layoutName} enabled.` : `${layoutName} disabled.`);
  };

  const updateTemplateActive = async (template, enabled) => {
    if (!template?.id) {
      setStatusMsg('Template updates require Electron runtime.');
      return;
    }
    if (template.source === 'bundled') {
      if (!window.adminApi?.updateSettings) {
        setStatusMsg('Template updates require Electron runtime.');
        return;
      }
      const res = await window.adminApi.updateSettings({
        bundledTemplateOverrides: {
          ...(settings.bundledTemplateOverrides || {}),
          [template.id]: {
            ...(settings.bundledTemplateOverrides?.[template.id] || {}),
            enabled,
            deleted: !enabled,
            type: resolveTemplateType(template),
          },
        },
      });
      if (!res?.ok) {
        setStatusMsg('Template status update failed: ' + (res?.error || 'unknown'));
        return;
      }
      await Promise.all([refresh(), refreshConfig()]);
      setStatusMsg(enabled ? `"${template.name}" is now Active.` : `"${template.name}" is now Inactive.`);
      return;
    }
    if (!window.adminApi?.updateTemplate) {
      setStatusMsg('Template updates require Electron runtime.');
      return;
    }
    const res = await window.adminApi.updateTemplate(template.id, { enabled });
    if (!res?.ok) {
      setStatusMsg('Template status update failed: ' + (res?.error || 'unknown'));
      return;
    }
    await refresh();
    setStatusMsg(enabled ? `"${template.name}" is now Active.` : `"${template.name}" is now Inactive.`);
  };

  const auditDuplicateTemplates = async () => {
    if (!window.adminApi?.auditDuplicateTemplates) {
      setStatusMsg('Duplicate cleanup requires Electron runtime.');
      return;
    }
    if (auditingDuplicateTemplates || cleaningDuplicateTemplates) return;
    setAuditingDuplicateTemplates(true);
    try {
      console.log('[templates:dedupe] manual audit started');
      const res = await window.adminApi.auditDuplicateTemplates();
      if (!res?.ok) {
        setStatusMsg('Duplicate audit failed: ' + (res?.error || 'unknown'));
        return;
      }
      const nextPreview = {
        ok: true,
        duplicateGroups: Array.isArray(res.duplicateGroups) ? res.duplicateGroups : [],
        duplicateCount: Number(res.duplicateCount) || 0,
      };
      console.log('[templates:dedupe] manual audit completed', {
        duplicateGroups: nextPreview.duplicateGroups.length,
        duplicateCount: nextPreview.duplicateCount,
      });
      setDuplicateCleanupPreview(nextPreview);
      if (nextPreview.duplicateCount > 0) {
        setDuplicateCleanupConfirmOpen(true);
      } else {
        setStatusMsg('No duplicate templates found for the current runtime store.');
      }
    } catch (error) {
      console.error('[templates:dedupe] manual audit failed', error);
      setStatusMsg('Duplicate audit failed: ' + (error?.message || 'unknown'));
    } finally {
      setAuditingDuplicateTemplates(false);
    }
  };

  const cleanDuplicateTemplates = async () => {
    if (!window.adminApi?.cleanDuplicateTemplates) {
      setStatusMsg('Duplicate cleanup requires Electron runtime.');
      return;
    }
    if (cleaningDuplicateTemplates) return;
    setCleaningDuplicateTemplates(true);
    try {
      console.log('[templates:dedupe] manual cleanup started');
      const res = await window.adminApi.cleanDuplicateTemplates();
      if (!res?.ok) {
        setStatusMsg('Duplicate cleanup failed: ' + (res?.error || 'unknown'));
        return;
      }
      console.log('[templates:dedupe] manual cleanup completed', {
        duplicateGroupsCleaned: res.duplicateGroupsCleaned,
        removedCount: res.removedCount,
        keptCount: res.keptCount,
        currentCountAfter: res.currentCountAfter,
      });
      setDuplicateCleanupConfirmOpen(false);
      setDuplicateCleanupPreview(null);
      setSelectedId(null);
      await refresh();
      setStatusMsg(`Removed ${res.removedCount || 0} duplicate template${res.removedCount === 1 ? '' : 's'}.`);
    } catch (error) {
      console.error('[templates:dedupe] manual cleanup failed', error);
      setStatusMsg('Duplicate cleanup failed: ' + (error?.message || 'unknown'));
    } finally {
      setCleaningDuplicateTemplates(false);
    }
  };

  const handleTemplateCardStatusToggle = (event, template) => {
    event.preventDefault();
    event.stopPropagation();
    const nextEnabled = template.enabled === false;
    updateTemplateActive(template, nextEnabled);
  };

  const updatePrinterSettings = async (patch, successMsg = 'Printer settings updated.') => {
    if (!window.adminApi?.updateSettings) {
      setStatusMsg('Printer setting changes require Electron runtime.');
      return;
    }
    const res = await window.adminApi.updateSettings(patch);
    if (!res?.ok) {
      setStatusMsg('Printer setting update failed: ' + (res?.error || 'unknown'));
      return;
    }
    await refreshConfig();
    setStatusMsg(successMsg);
  };

  const handlePrinterProfileChange = async (printerProfileId) => {
    const nextSafeMargin = printerProfileId === 'selphy_cp1500'
      ? getActiveSafeMargin(getPrinterProfile('selphy_cp1500'), DEFAULT_SAFE_MARGIN_OVERRIDE)
      : { top: 0, right: 0, bottom: 0, left: 0 };

    await updatePrinterSettings(
      {
        printerProfileId,
        safeMarginOverride: nextSafeMargin,
      },
      'Printer profile updated.',
    );
  };

  const handleSafeMarginChange = async (side, value) => {
    await updatePrinterSettings(
      {
        safeMarginOverride: {
          ...activeSafeMargin,
          [side]: Number(value) || 0,
        },
      },
      'Safe area updated.',
    );
  };

  const pickOverlay = () => overlayInputRef.current?.click();
  const pickPreview = () => previewInputRef.current?.click();

  const loadImageSize = (dataUrl) => new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error('Failed to inspect image.'));
    img.src = dataUrl;
  });

  const readFileAsDataUrl = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Failed to read image.'));
    reader.readAsDataURL(file);
  });

  const ensureOverlayMatchesLayout = async (dataUrl, layoutId) => {
    const layout = LAYOUTS.find((item) => item.id === layoutId);
    if (!layout) {
      setStatusMsg('Choose a layout before uploading the overlay.');
      return false;
    }
    const size = await loadImageSize(dataUrl);
    if (size.width !== layout.canvas.w || size.height !== layout.canvas.h) {
      setStatusMsg(`Overlay must be ${layout.canvas.w}×${layout.canvas.h}px for ${layout.name}.`);
      return false;
    }
    return true;
  };

  const isMissingReplaceAssetHandler = (error) => (
    /No handler registered for ['"]templates:replace-asset['"]/i.test(error?.message || String(error || ''))
  );

  const buildReplaceAssetPayload = (assetType, dataUrl) => ({
    templateId: selectedTemplate.id,
    layoutId: selectedTemplate.layoutId || draft.layoutId,
    assetType,
    dataUrl,
      sourceTemplate: {
      id: selectedTemplate.id,
      layoutId: selectedTemplate.layoutId || draft.layoutId,
      mode: selectedTemplate.mode || 'daily',
      eventId: (selectedTemplate.mode || 'daily') === 'event' ? (selectedTemplate.eventId || null) : null,
      name: draft.name.trim() || selectedTemplate.name,
      type: draft.type || selectedTemplate.type,
      desc: selectedTemplate.desc || '',
      enabled: draft.enabled,
      hidden: selectedTemplate.hidden === true,
      deleted: selectedTemplate.deleted === true,
      src: selectedTemplate.src,
      previewSrc: selectedTemplate.previewSrc || null,
      overlaySrc: selectedTemplate.overlaySrc || null,
      backgroundSrc: selectedTemplate.backgroundSrc || selectedTemplate.overlaySrc || selectedTemplate.src,
      source: selectedTemplate.source,
    },
  });

  const replaceTemplateAssetWithFallback = async (assetType, dataUrl) => {
    try {
      return await window.adminApi.replaceTemplateAsset(buildReplaceAssetPayload(assetType, dataUrl));
    } catch (error) {
      if (!isMissingReplaceAssetHandler(error)) throw error;
      console.warn('[templates] replace asset handler missing; using legacy template save path', {
        templateId: selectedTemplate?.id,
        assetType,
      });
      if (selectedTemplate?.source === 'bundled') {
        if (!window.adminApi?.createTemplateFromBundled) throw error;
        return window.adminApi.createTemplateFromBundled({
          sourceTemplate: {
            id: selectedTemplate.id,
            layoutId: selectedTemplate.layoutId,
            mode: selectedTemplate.mode || 'daily',
            eventId: (selectedTemplate.mode || 'daily') === 'event' ? (selectedTemplate.eventId || null) : null,
            name: draft.name.trim() || selectedTemplate.name,
            desc: selectedTemplate.desc || '',
            src: selectedTemplate.src,
            previewSrc: selectedTemplate.previewSrc || null,
            overlaySrc: selectedTemplate.overlaySrc || null,
          },
          type: draft.type,
          enabled: draft.enabled,
          overlayDataUrl: assetType === 'overlay' ? dataUrl : null,
          previewDataUrl: assetType === 'preview' ? dataUrl : null,
        });
      }
      if (!window.adminApi?.updateTemplate) throw error;
      const patch = {
        layoutId: draft.layoutId,
        mode: selectedTemplate?.mode || 'daily',
        eventId: (selectedTemplate?.mode || 'daily') === 'event' ? (selectedTemplate?.eventId || null) : null,
        name: draft.name.trim(),
        type: draft.type,
        enabled: draft.enabled,
      };
      if (assetType === 'preview') patch.previewDataUrl = dataUrl;
      if (assetType === 'overlay') patch.overlayDataUrl = dataUrl;
      return window.adminApi.updateTemplate(selectedTemplate.id, patch);
    }
  };

  const invalidateTemplateAssetCaches = (beforeTemplate, afterTemplate, assetUrl) => {
    [
      beforeTemplate?.src,
      beforeTemplate?.previewSrc,
      beforeTemplate?.overlaySrc,
      beforeTemplate?.backgroundSrc,
      afterTemplate?.src,
      afterTemplate?.previewSrc,
      afterTemplate?.overlaySrc,
      afterTemplate?.backgroundSrc,
      assetUrl,
    ].forEach((src) => {
      if (!src) return;
      invalidateImageCache(src);
      console.warn('[templates] cache invalidated for asset', src);
    });
  };

  const onFileChosen = async (kind, e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file later
    if (!file) return;
    const isPng = file.type === 'image/png' || /\.png$/i.test(file.name);
    if (!isPng) {
      setStatusMsg('Please choose a PNG image.');
      return;
    }
    try {
      const dataUrl = await readFileAsDataUrl(file);
      if (kind === 'overlay') {
        const valid = await ensureOverlayMatchesLayout(dataUrl, draft.layoutId);
        if (!valid) return;
        if (selectedTemplate && window.adminApi?.replaceTemplateAsset && !dirty) {
          await replaceExistingAsset('overlay', dataUrl, file.name);
        } else {
          patchDraft({ overlayDataUrl: dataUrl });
          setStatusMsg(`New overlay selected: ${file.name}`);
        }
      } else {
        if (selectedTemplate && window.adminApi?.replaceTemplateAsset && !dirty) {
          await replaceExistingAsset('preview', dataUrl, file.name);
        } else {
          patchDraft({ previewDataUrl: dataUrl });
          setStatusMsg(`New preview selected: ${file.name}`);
        }
      }
    } catch {
      setStatusMsg('Failed to read image.');
    }
  };

  const replaceExistingAsset = async (assetType, dataUrl, fileName) => {
    if (!selectedTemplate?.id) {
      patchDraft({ [`${assetType}DataUrl`]: dataUrl });
      return;
    }
    if (assetSaving) return;
    setAssetSaving(assetType);
    console.log('[templates:replace] requested', {
      templateId: selectedTemplate.id,
      layoutId: selectedTemplate.layoutId || draft.layoutId,
      assetType,
    });
    try {
      const res = await replaceTemplateAssetWithFallback(assetType, dataUrl);
      if (!res?.ok) {
        setStatusMsg('Asset replacement failed: ' + explainTemplateSaveError(res?.error));
        return;
      }
      if (import.meta.env.DEV) console.log('[templates:replace] result', res);
      console.log('[templates:replace] renderer updated', {
        templateId: res.template?.id || selectedTemplate.id,
        assetType,
      });
      invalidateTemplateAssetCaches(selectedTemplate, res.template, res.assetUrl);
      if (res.template?.id) {
        setTemplateOverrides((current) => ({
          ...current,
          [res.template.id]: {
            ...res.template,
            updatedAt: res.cacheVersion || res.updatedAt || res.template.updatedAt || new Date().toISOString(),
          },
        }));
      }
      await refresh();
      setSelectedId(res.template?.id || selectedTemplate.id);
      setActiveLayoutId(res.template?.layoutId || selectedTemplate.layoutId || draft.layoutId);
      setDirty(false);
      setStatusMsg(`${assetType === 'preview' ? 'Preview' : 'Overlay'} replaced: ${fileName}`);
    } catch (error) {
      console.error('[templates] asset replace failed', error);
      setStatusMsg('Asset replacement failed: ' + (error?.message || 'unknown'));
    } finally {
      setAssetSaving(null);
    }
  };

  // ── Save ──
  const save = async () => {
    if (saving) return;
    if (!draft.name.trim()) { setStatusMsg('Name is required.'); return; }
    if (!draft.layoutId) { setStatusMsg('Layout is required.'); return; }
    if (settings.mode === 'event' && !settings.activeEventId) {
      setStatusMsg('Select an active event before creating event templates.');
      return;
    }
    setSaving(true);
    try {
      if (selectedId == null) {
        if (!draft.overlayDataUrl) { setStatusMsg('Upload a valid layout-size overlay PNG first.'); return; }
        if (!draft.previewDataUrl) { setStatusMsg('Upload a valid preview PNG first.'); return; }
        const res = await window.adminApi.createTemplate({
          layoutId: draft.layoutId,
          mode: settings.mode,
          eventId: settings.mode === 'event' ? settings.activeEventId : null,
          name: draft.name.trim(),
          type: draft.type,
          enabled: draft.enabled,
          overlayDataUrl: draft.overlayDataUrl,
          previewDataUrl: draft.previewDataUrl,
        });
        if (!res?.ok) { setStatusMsg('Save failed: ' + explainTemplateSaveError(res?.error)); return; }
        await refresh();
        setActiveLayoutId(res.template.layoutId);
        setSelectedId(res.template.id);
        setStatusMsg('Template created successfully.');
      } else if (isBundledTemplate) {
        if (draft.overlayDataUrl || draft.previewDataUrl) {
          if (!window.adminApi?.replaceTemplateAsset) {
            setStatusMsg('Template artwork replacement requires Electron runtime.');
            return;
          }
          let lastTemplate = null;
          for (const [assetType, dataUrl] of [
            ['preview', draft.previewDataUrl],
            ['overlay', draft.overlayDataUrl],
          ]) {
            if (!dataUrl) continue;
            const res = await replaceTemplateAssetWithFallback(assetType, dataUrl);
            if (!res?.ok) { setStatusMsg('Save failed: ' + explainTemplateSaveError(res?.error)); return; }
            if (import.meta.env.DEV) console.log('[templates:replace] result', res);
            invalidateTemplateAssetCaches(selectedTemplate, res.template, res.assetUrl);
            if (res.template?.id) {
              setTemplateOverrides((current) => ({
                ...current,
                [res.template.id]: {
                  ...res.template,
                  updatedAt: res.cacheVersion || res.updatedAt || res.template.updatedAt || new Date().toISOString(),
                },
              }));
            }
            lastTemplate = res.template;
          }
          await Promise.all([refresh(), refreshConfig()]);
          setSelectedId(lastTemplate?.id || selectedTemplate.id);
          setDirty(false);
          setStatusMsg('Template artwork replaced successfully.');
          return;
        }
        const res = await window.adminApi.updateSettings({
          bundledTemplateOverrides: {
            ...(settings.bundledTemplateOverrides || {}),
            [selectedId]: {
              ...(settings.bundledTemplateOverrides?.[selectedId] || {}),
              enabled: draft.enabled,
              deleted: !draft.enabled,
              type: draft.type,
              name: draft.name.trim(),
            },
          },
        });
        if (!res?.ok) { setStatusMsg('Save failed: ' + explainTemplateSaveError(res?.error)); return; }
        await Promise.all([refresh(), refreshConfig()]);
        setStatusMsg('Template saved successfully.');
      } else {
        const patch = {
          layoutId: draft.layoutId,
          mode: selectedTemplate?.mode || 'daily',
          eventId: (selectedTemplate?.mode || 'daily') === 'event' ? (selectedTemplate?.eventId || null) : null,
          name: draft.name.trim(),
          type: draft.type,
          enabled: draft.enabled,
        };
        if (draft.overlayDataUrl) patch.overlayDataUrl = draft.overlayDataUrl;
        if (draft.previewDataUrl) patch.previewDataUrl = draft.previewDataUrl;
        const res = await window.adminApi.updateTemplate(selectedId, patch);
        if (!res?.ok) { setStatusMsg('Save failed: ' + explainTemplateSaveError(res?.error)); return; }
        await refresh();
        setActiveLayoutId(res.template?.layoutId || draft.layoutId);
        setStatusMsg('Template saved successfully.');
      }
      setDirty(false);
    } catch (err) {
      setStatusMsg('Save failed: ' + (err?.message || 'unknown'));
    } finally {
      setSaving(false);
    }
  };

  // ── Delete ──
  const doDelete = async () => {
    if (!selectedId) return;
    if (isBundledTemplate) {
      const res = await window.adminApi.updateSettings({
        bundledTemplateOverrides: {
          ...(settings.bundledTemplateOverrides || {}),
          [selectedId]: {
            ...(settings.bundledTemplateOverrides?.[selectedId] || {}),
            deleted: true,
          },
        },
      });
      setConfirmDelete(false);
      if (res?.ok) {
        setSelectedId(null);
        await Promise.all([refresh(), refreshConfig()]);
        setStatusMsg('Bundled template hidden.');
      } else {
        setStatusMsg('Delete failed: ' + (res?.error || 'unknown'));
      }
      return;
    }
    const res = await window.adminApi.deleteTemplate(selectedId);
    setConfirmDelete(false);
    if (res?.ok) {
      setSelectedId(null);
      await refresh();
      setStatusMsg('Template deleted.');
    } else {
      setStatusMsg('Delete failed: ' + (res?.error || 'unknown'));
    }
  };

  // ── Image preview source (local upload wins over on-disk) ──
  // Cache-buster on updatedAt so re-uploads don't show stale <img>.
  const overlaySrc = draft.overlayDataUrl
    || (selectedTemplate
      ? versionTemplateAssetSrc(selectedTemplate.overlaySrc, selectedTemplate)
      : null);
  const previewSrc = draft.previewDataUrl
    || (selectedTemplate
      ? versionTemplateAssetSrc(selectedTemplate.previewSrc, selectedTemplate)
      : null);
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    console.log('[template:image-src]', {
      cardImageSrc: previewSrc || null,
      previewPanelSrc: previewSrc || null,
      overlayPanelSrc: overlaySrc || null,
    });
  }, [previewSrc, overlaySrc]);

  return (
    <div className={`screen admin-screen ${active ? 'active' : ''}`} id="s-admin" data-screen-label="Admin">
      <div className="admin-topbar">
        <div className="admin-topbar-left">
          <div className="admin-title">Admin</div>
          <nav className="admin-tabs">
            <button
              className={`admin-tab ${tab === 'dashboard' ? 'active' : ''}`}
              onClick={() => setTab('dashboard')}
            >
              Dashboard
            </button>
            <button
              className={`admin-tab ${tab === 'templates' ? 'active' : ''}`}
              onClick={() => setTab('templates')}
            >
              Templates
            </button>
            <button
              className={`admin-tab ${tab === 'settings' ? 'active' : ''}`}
              onClick={() => setTab('settings')}
            >
              Settings
            </button>
          </nav>
        </div>
        <div className="admin-topbar-actions">
          <div className="admin-system-controls" aria-label="System Controls">
            <span className="admin-system-controls-label">System Controls</span>
            <div className={`admin-status-toggle ${cursorHidden ? 'off' : 'on'}`}>
              <span className="admin-status-copy">
                <span className="admin-status-label">Cursor</span>
                <span className="admin-status-value">{cursorHidden ? 'Hidden' : 'Visible'}</span>
              </span>
              <button
                type="button"
                className={`admin-status-btn ${cursorHidden ? 'warning active' : 'success active'}`}
                onClick={() => onToggleCursorHidden?.(!cursorHidden)}
              >
                {cursorHidden ? 'Show' : 'Hide'}
              </button>
            </div>
            <div className={`admin-status-toggle ${settings.printEnabled !== false ? 'on' : 'off'}`}>
              <span className="admin-status-copy">
                <span className="admin-status-label">Print</span>
                <span className="admin-status-value">{settings.printEnabled !== false ? 'Enabled' : 'Disabled'}</span>
              </span>
              <button
                type="button"
                className={`admin-status-btn ${settings.printEnabled !== false ? 'success active' : 'warning active'}`}
                onClick={() => updatePrintEnabled(settings.printEnabled === false)}
              >
                {settings.printEnabled !== false ? 'Disable' : 'Enable'}
              </button>
            </div>
          </div>
          <button className="admin-btn" onClick={onExit}>Exit Admin</button>
        </div>
      </div>

      {tab === 'dashboard' ? (
        <AdminDashboard
          active={active}
          events={events}
          settings={settings}
          templates={displayTemplates}
        />
      ) : tab === 'settings' ? (
        <div className="admin-settings-panel">
          <div className="admin-settings-header">
            <div className="admin-settings-title">Settings</div>
            <div className="admin-settings-sub">Configure booth mode, printer profile, and security.</div>
          </div>
          <div className="admin-settings-grid">
            <section className="admin-settings-card">
              <div className="admin-settings-card-header">
                <div className="admin-settings-card-title">Test Mode</div>
                <div className="admin-settings-card-desc">
                  Use Test Mode for trial runs. Test sessions are marked and excluded from real analytics by default.
                </div>
              </div>
              <div className="admin-operation-summary">
                <span className={`admin-chip ${testModeEnabled ? 'warn' : ''}`}>
                  {testModeEnabled ? 'TEST MODE ACTIVE' : 'Test Mode Off'}
                </span>
              </div>
              <div className="admin-operation-actions">
                <button
                  type="button"
                  className={`admin-btn ${testModeEnabled ? 'warning' : 'success'}`}
                  onClick={toggleTestMode}
                >
                  {testModeEnabled ? 'Disable Test Mode' : 'Enable Test Mode'}
                </button>
              </div>
            </section>

            <section className="admin-settings-card">
              <div className="admin-settings-card-header">
                <div className="admin-settings-card-title">Photobooth Mode</div>
                <div className="admin-settings-card-desc">Switch between daily operation and event-specific sessions.</div>
              </div>
              <div className="admin-mode-switch">
                <button
                  type="button"
                  className={`admin-mode-btn ${settings.mode === 'daily' ? 'active' : ''}`}
                  onClick={() => updateAppMode('daily')}
                >
                  Daily Mode
                </button>
                <button
                  type="button"
                  className={`admin-mode-btn ${settings.mode === 'event' ? 'active' : ''}`}
                  onClick={() => updateAppMode('event')}
                >
                  Event Mode
                </button>
              </div>
              {settings.mode === 'event' && (
                <label className="admin-field">
                  <span>Active Event</span>
                  <select
                    value={settings.activeEventId || ''}
                    onChange={(e) => updateActiveEvent(e.target.value)}
                  >
                    <option value="">Select an event</option>
                    {events
                      .filter((event) => event.enabled !== false)
                      .map((event) => (
                        <option key={event.id} value={event.id}>
                          {event.name}
                        </option>
                    ))}
                  </select>
                </label>
              )}
              <button
                type="button"
                className="admin-btn ghost"
                onClick={() => setEventManagerOpen(true)}
              >
                Manage Events
              </button>
            </section>

            <section className="admin-settings-card">
              <div className="admin-settings-card-header">
                <div className="admin-settings-card-title">Printer Settings</div>
                <div className="admin-settings-card-desc">Select your printer model and adjust the safe area margins.</div>
              </div>
              <label className="admin-field">
                <span>Printer Profile</span>
                <select
                  value={activePrinterProfile.id}
                  onChange={(e) => handlePrinterProfileChange(e.target.value)}
                >
                  {PRINTER_PROFILES.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="admin-settings-card-sub">Safe Area (px)</div>
              <div className="admin-printer-grid">
                {['top', 'right', 'bottom', 'left'].map((side) => (
                  <label key={side} className="admin-field">
                    <span>{side}</span>
                    <input
                      type="number"
                      min="0"
                      max="300"
                      value={activeSafeMargin[side]}
                      disabled={activePrinterProfile.id !== 'selphy_cp1500'}
                      onChange={(e) => handleSafeMarginChange(side, e.target.value)}
                    />
                  </label>
                ))}
              </div>
              <div className="admin-inline-note">
                Print area: x {activePrintArea.x}, y {activePrintArea.y}, w {activePrintArea.w}, h {activePrintArea.h}
              </div>
            </section>

            <section className="admin-settings-card">
              <div className="admin-settings-card-header">
                <div className="admin-settings-card-title">Camera Countdown</div>
                <div className="admin-settings-card-desc">Set how many seconds the camera waits before each capture.</div>
              </div>
              <label className="admin-field">
                <span>Countdown Time</span>
                <input
                  type="number"
                  min={MIN_COUNTDOWN_SECONDS}
                  max={MAX_COUNTDOWN_SECONDS}
                  step="1"
                  value={countdownDraft}
                  onChange={(e) => updateCountdownSetting(e.target.value)}
                />
                <small>Used before each photo capture.</small>
              </label>
            </section>

            <section className="admin-settings-card">
              <div className="admin-settings-card-header">
                <div className="admin-settings-card-title">Softcopy / QR Settings</div>
                <div className="admin-settings-card-desc">Control QR generation and which softcopy files are uploaded.</div>
              </div>

              <div className="admin-softcopy-options">
                <button
                  type="button"
                  className={`admin-softcopy-toggle ${softcopySettings.qrEnabled ? 'is-on' : 'is-off'}`}
                  role="switch"
                  aria-checked={softcopySettings.qrEnabled}
                  onClick={() => updateSoftcopySetting('qrEnabled', !softcopySettings.qrEnabled)}
                >
                  <span className="admin-softcopy-toggle-ui" aria-hidden="true" />
                  <span>
                    <strong>Enable QR Generation</strong>
                    <small>Create the customer QR after printing.</small>
                  </span>
                </button>

                <div className={`admin-softcopy-media ${softcopySettings.qrEnabled ? '' : 'is-disabled'}`}>
                  {[
                    ['photoEnabled', 'Include Photo', 'Upload the final print image.'],
                    ['gifEnabled', 'Include GIF', 'Upload the animated GIF.'],
                    ['videoEnabled', 'Include Video', 'Upload the template video.'],
                  ].map(([key, label, description]) => (
                    <button
                      type="button"
                      key={key}
                      className={[
                        'admin-softcopy-toggle',
                        softcopySettings.qrEnabled && softcopySettings[key] ? 'is-on' : 'is-off',
                        softcopySettings.qrEnabled ? '' : 'is-blocked',
                      ].filter(Boolean).join(' ')}
                      role="switch"
                      aria-checked={softcopySettings.qrEnabled && softcopySettings[key]}
                      aria-disabled={!softcopySettings.qrEnabled}
                      disabled={!softcopySettings.qrEnabled}
                      onClick={() => updateSoftcopySetting(key, !softcopySettings[key])}
                    >
                      <span className="admin-softcopy-toggle-ui" aria-hidden="true" />
                      <span>
                        <strong>{label}</strong>
                        <small>
                          {softcopySettings.qrEnabled
                            ? description
                            : 'Disabled while QR generation is off.'}
                        </small>
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              {!softcopySettings.qrEnabled && (
                <div className="admin-inline-note">
                  QR generation is disabled. Printing will still work, but no softcopy QR will be generated.
                </div>
              )}
              {softcopySettings.qrEnabled
                && !softcopySettings.photoEnabled
                && !softcopySettings.gifEnabled
                && !softcopySettings.videoEnabled && (
                <div className="admin-inline-note warn">
                  Enable at least one softcopy type to generate a QR code.
                </div>
              )}
            </section>

            <section className="admin-settings-card">
              <div className="admin-settings-card-header">
                <div className="admin-settings-card-title">Security</div>
                <div className="admin-settings-card-desc">Update the 4-digit PIN used to access the admin panel.</div>
              </div>
              <button className="admin-btn ghost" onClick={() => setPinModal(true)}>
                Change PIN
              </button>
            </section>

          </div>
        </div>
      ) : (
      <div className="admin-body">
        <div className="admin-list">
          <div className="admin-list-header">
            <div className="admin-side-title">Layouts</div>
          </div>

          {loading && <div className="admin-list-empty">Loading…</div>}
          <div className="admin-layout-nav">
            {layoutNavItems.map((item) => (
              <div
                key={item.key}
                className={`admin-layout-nav-item ${activeLayoutId === item.key ? 'active' : ''} ${item.enabled ? '' : 'is-disabled'}`}
              >
                <button
                  type="button"
                  className="admin-layout-nav-main"
                  onClick={() => setActiveLayoutId(item.key)}
                >
                  <div className="admin-layout-nav-preview" aria-hidden="true">
                    {item.previewSrc ? (
                      <img src={item.previewSrc} alt="" loading="lazy" decoding="async" />
                    ) : (
                      <span>{item.title.slice(0, 1)}</span>
                    )}
                  </div>
                  <div className="admin-layout-nav-content">
                  <div className="admin-layout-nav-row">
                    <div className="admin-layout-nav-title">{item.title}</div>
                    <span className={`admin-layout-count ${item.count === 0 ? 'empty' : ''}`}>{item.count}</span>
                  </div>
                  <div className="admin-layout-nav-subtitle">{item.subtitle}</div>
                  <div className="admin-layout-status-counts">
                    <span>{item.activeCount} Active</span>
                    <span>{item.inactiveCount} Inactive</span>
                    <span>{item.enabled ? 'Enabled' : 'Disabled'}</span>
                  </div>
                  </div>
                </button>
                <button
                  type="button"
                  className={`admin-layout-enable-toggle ${item.enabled ? 'is-on' : 'is-off'}`}
                  aria-pressed={item.enabled}
                  onClick={() => updateLayoutEnabled(item.key, !item.enabled)}
                >
                  {item.enabled ? 'Disable Layout' : 'Enable Layout'}
                </button>
              </div>
            ))}
          </div>
        </div>

        <div className="admin-editor">
          <div className="admin-main-header">
            <div>
              <div className="admin-editor-header">
                {activeLayout?.name || 'Layout'} Templates
              </div>
              <div className="admin-mode-context">
                {modeHeaderText}
              </div>
              <div className="admin-main-subtitle">
                {activeTemplates.length} template{activeTemplates.length === 1 ? '' : 's'}
                {activeLayout?.id ? ` · ${activeLayout.id}` : ''}
                {' · '}{layoutSettings[activeLayoutId]?.enabled === false ? 'Layout Disabled' : 'Layout Enabled'}
              </div>
            </div>
            <div className="admin-template-header-actions">
              <button
                type="button"
                className="admin-btn warning"
                disabled={auditingDuplicateTemplates || cleaningDuplicateTemplates}
                onClick={auditDuplicateTemplates}
              >
                {auditingDuplicateTemplates
                  ? 'Scanning...'
                  : cleaningDuplicateTemplates
                    ? 'Cleaning...'
                    : 'Clean Duplicate Templates'}
              </button>
              <button
                className="admin-btn success"
                disabled={settings.mode === 'event' && !settings.activeEventId}
                onClick={() => {
                  setSelectedId(null);
                  setDraft({ ...BLANK_DRAFT, layoutId: activeLayoutId });
                  setDirty(false);
                }}
              >
                Create Template for {activeLayout?.name || 'Layout'}
              </button>
            </div>
          </div>

          <div className="admin-main-content">
            <div className="admin-template-sections">
              {invalidLayoutTemplates.length > 0 && (
                <div className="admin-inline-note warn">
                  {invalidLayoutTemplates.length} template{invalidLayoutTemplates.length === 1 ? '' : 's'} need a valid layout assignment and are hidden from customers.
                </div>
              )}

              {activeTemplates.length === 0 && (
                <div className="admin-empty-state">
                  <div className="admin-empty-state-title">
                    {settings.mode === 'event' && !settings.activeEventId
                      ? 'No active event selected'
                      : `No templates for ${activeLayout?.name || 'this layout'} yet`}
                  </div>
                  <div className="admin-empty-state-sub">
                    {settings.mode === 'event' && !settings.activeEventId
                      ? 'Go to Settings and choose an active event to manage event templates.'
                      : `Create a template to get started with ${activeLayout?.name || 'this layout'}.`}
                  </div>
                </div>
              )}

              {activeTemplates.length > 0 && templateStatusSections.map(({ key, title, items }) => (
                <section key={key} className={`admin-type-section status-${key}`}>
                  <div className="admin-type-section-header">
                    <h3 className="admin-type-title">{title}</h3>
                    <span className="admin-type-count">{items.length} template{items.length === 1 ? '' : 's'}</span>
                  </div>

                  {items.length === 0 ? (
                    <div className="admin-category-empty">
                      No {title.toLowerCase()} templates for this layout.
                    </div>
                  ) : (
                    <div className="admin-type-grid">
                      {items.map((t) => (
                      <div
                        key={t.id}
                        className={`admin-template-card ${selectedId === t.id ? 'selected' : ''} ${t.enabled !== false ? '' : 'disabled'}`}
                      >
                        <button
                          type="button"
                          className="admin-template-card-main"
                          onClick={() => setSelectedId(t.id)}
                        >
                  <div className="admin-template-card-thumb">
                            {t.previewSrc ? (
                              <img src={versionTemplateAssetSrc(t.previewSrc, t)} alt={t.name} loading="lazy" decoding="async" />
                            ) : (
                              <span>{t.name.slice(0, 1)}</span>
                            )}
                          </div>
                          <div className="admin-template-card-name">{t.name}</div>
                          {t.desc && <div className="admin-template-card-desc">{t.desc}</div>}
                          <div className="admin-list-tags admin-template-badges">
                            <span className="admin-chip">{resolveTemplateType(t)}</span>
                            <span className={`admin-chip ${t.enabled !== false ? 'on' : 'off'}`}>
                              {t.enabled !== false ? 'Active' : 'Inactive'}
                            </span>
                            {(t.hidden === true || t.deleted === true) && (
                              <span className="admin-chip warn">Hidden</span>
                            )}
                            <span className="admin-chip">{t.source === 'bundled' ? 'Bundled' : 'Custom'}</span>
                          </div>
                        </button>

                        <div className="admin-template-card-actions">
                          <button
                            type="button"
                            className={`template-active-toggle ${t.enabled !== false ? 'is-active' : 'is-inactive'}`}
                            aria-pressed={t.enabled !== false}
                            onMouseDown={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                            }}
                            onClick={(e) => handleTemplateCardStatusToggle(e, t)}
                          >
                            <span className="toggle-ui" />
                            <span>{t.enabled !== false ? 'Active' : 'Inactive'}</span>
                          </button>
                          <button
                            type="button"
                            className="admin-template-edit"
                            onClick={() => setSelectedId(t.id)}
                          >
                            Edit
                          </button>
                        </div>
                      </div>
                      ))}
                    </div>
                  )}
                </section>
              ))}
            </div>

            <div className="admin-editor-body">
              <div className="admin-editor-body-title-row">
                <div className="admin-editor-body-heading">
                  {selectedId == null ? 'New Template' : (selectedTemplate?.name || 'Edit Template')}
                </div>
                <div className="admin-editor-body-badges">
                  {selectedId == null && (
                    <span className="admin-chip">for {activeLayout?.name}</span>
                  )}
                  {selectedId != null && (
                    <>
                      <span className={`admin-chip ${selectedTemplate?.enabled !== false ? 'on' : 'off'}`}>
                        {selectedTemplate?.enabled !== false ? 'Active' : 'Inactive'}
                      </span>
                      {(selectedTemplate?.hidden === true || selectedTemplate?.deleted === true) && (
                        <span className="admin-chip warn">Hidden</span>
                      )}
                      {isBundledTemplate && <span className="admin-chip">Bundled</span>}
                      {isRuntimeTemplate && <span className="admin-chip">Custom</span>}
                    </>
                  )}
                </div>
              </div>

            <div className="admin-editor-fields">
              {isBundledTemplate && (
                <div className="admin-inline-note admin-full-span">
                  Replacing artwork on a bundled template saves it as a custom template for this layout.
                </div>
              )}

              {(selectedTemplate?.mode === 'event' || (selectedId == null && settings.mode === 'event')) && (
                <div className="admin-field admin-full-span">
                  <span>Event</span>
                  <div className="admin-readonly-field">
                    {selectedTemplate
                      ? (events.find((event) => event.id === selectedTemplate.eventId)?.name || 'No event assigned')
                      : (activeEvent?.name || 'No active event selected')}
                  </div>
                </div>
              )}

              <div className="admin-field">
                <span>Layout</span>
                {isBundledTemplate ? (
                  <div className="admin-readonly-field">
                    {LAYOUTS.find((layout) => layout.id === selectedTemplate.layoutId)?.name || selectedTemplate.layoutId || 'Unknown layout'}
                  </div>
                ) : (
                  <select
                    value={draft.layoutId}
                    onChange={(e) => patchDraft({ layoutId: e.target.value })}
                  >
                    {LAYOUTS.map((layout) => (
                      <option key={layout.id} value={layout.id}>{layout.name}</option>
                    ))}
                  </select>
                )}
              </div>

              <label className="admin-field">
                <span>Template Name</span>
                <input
                  type="text"
                  value={draft.name}
                  maxLength={64}
                  placeholder="e.g. Dark Teal"
                  onChange={e => patchDraft({ name: e.target.value })}
                />
              </label>

              <label className="admin-field">
                <span>Type</span>
                <select
                  value={draft.type}
                  onChange={e => patchDraft({ type: e.target.value })}
                >
                  {TEMPLATE_TYPE_ORDER.map((type) => (
                    <option key={type} value={type}>{type}</option>
                  ))}
                </select>
              </label>

              <div className="admin-field">
                <span>Status</span>
                <div className="admin-active-field">
                  <button
                    type="button"
                    className={`template-active-toggle ${draft.enabled ? 'is-active' : 'is-inactive'}`}
                    aria-pressed={draft.enabled}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => patchDraft({ enabled: !draft.enabled })}
                  >
                    <span className="toggle-ui" />
                    <span>{draft.enabled ? 'Active' : 'Inactive'}</span>
                  </button>
                  <div className="admin-active-copy">
                    {draft.enabled
                      ? 'Active — visible to customers on Select Background.'
                      : 'Inactive — hidden from customers.'}
                  </div>
                </div>
              </div>

              {selectedLayout ? (
                <div className="admin-inline-note admin-full-span">
                  Required overlay size: {selectedLayout.canvas.w} × {selectedLayout.canvas.h}px
                </div>
              ) : (
                <div className="admin-inline-note warn admin-full-span">
                  This template has no layout assigned and will not appear in Select Background.
                </div>
              )}

              {settings.mode === 'event' && !settings.activeEventId && selectedId == null && (
                <div className="admin-inline-note warn admin-full-span">
                  Go to Settings and select an active event before creating event templates.
                </div>
              )}

              {!isBundledTemplate && selectedTemplate && draft.layoutId !== selectedTemplate.layoutId && (
                <div className="admin-inline-note warn admin-full-span">
                  Changing layout requires replacing both Overlay PNG and Preview PNG before saving.
                </div>
              )}
            </div>

            <div className="admin-editor-assets">
              <div className="admin-file-block">
                <div className="admin-file-block-header">
                  <div className="admin-field-label">Preview PNG</div>
                  <div className="admin-preview-copy">Used only for the background option card.</div>
                </div>
                <div className="admin-editor-preview single">
                  {previewSrc
                    ? <img src={previewSrc} alt="Card preview" loading="lazy" decoding="async" />
                    : <div className="admin-editor-preview-empty">Upload preview.png</div>
                  }
                  <button
                    type="button"
                    className="admin-btn"
                    disabled={saving || assetSaving === 'preview'}
                    onClick={() => {
                      console.log('[admin] replace preview clicked', selectedTemplate?.id || null);
                      pickPreview();
                    }}
                  >
                    {assetSaving === 'preview' ? 'Replacing…' : 'Replace Preview'}
                  </button>
                  {draft.previewDataUrl && (
                    <button
                      type="button"
                      className="admin-btn ghost"
                      onClick={() => patchDraft({ previewDataUrl: null })}
                    >
                      Remove Preview
                    </button>
                  )}
                  {draft.previewDataUrl && (
                    <div className="admin-upload-ready">New preview ready to save</div>
                  )}
                </div>
              </div>

              <div className="admin-file-block">
                <div className="admin-file-block-header">
                  <div className="admin-field-label">Overlay PNG</div>
                  <div className="admin-preview-copy">Used for live preview and final print. Must match the selected layout canvas.</div>
                </div>
                <div className="admin-editor-preview single">
                  {overlaySrc
                    ? <img src={overlaySrc} alt="Overlay preview" loading="lazy" decoding="async" />
                    : <div className="admin-editor-preview-empty">Upload overlay.png</div>
                  }
                  <button
                    type="button"
                    className="admin-btn"
                    disabled={saving || assetSaving === 'overlay'}
                    onClick={() => {
                      console.log('[admin] replace overlay clicked', selectedTemplate?.id || null);
                      pickOverlay();
                    }}
                  >
                    {assetSaving === 'overlay' ? 'Replacing…' : 'Replace Overlay'}
                  </button>
                  {draft.overlayDataUrl && (
                    <button
                      type="button"
                      className="admin-btn ghost"
                      onClick={() => patchDraft({ overlayDataUrl: null })}
                    >
                      Remove Overlay
                    </button>
                  )}
                  {draft.overlayDataUrl && (
                    <div className="admin-upload-ready">New overlay ready to save</div>
                  )}
                </div>
              </div>
            </div>

              <input
                ref={overlayInputRef}
                type="file"
                accept="image/png"
                style={{ display: 'none' }}
                onChange={(e) => onFileChosen('overlay', e)}
              />
              <input
                ref={previewInputRef}
                type="file"
                accept="image/png"
                style={{ display: 'none' }}
                onChange={(e) => onFileChosen('preview', e)}
              />

              <div className="admin-editor-actions">
                <button
                  className="admin-btn success"
                  disabled={!dirty || saving}
                  onClick={save}
                >
                  {saving ? 'Saving…' : (selectedId == null ? 'Create Template' : 'Save Changes')}
                </button>
                {selectedId != null && (
                  <button
                    className="admin-btn danger"
                    onClick={() => setConfirmDelete(true)}
                  >
                    {isBundledTemplate ? 'Hide Template' : 'Delete Template'}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
      )}

      {statusMsg && <div className="admin-toast">{statusMsg}</div>}

      {duplicateCleanupConfirmOpen && duplicateCleanupPreview && (
        <ConfirmModal
          title="Clean duplicate templates?"
          body={(
            <div className="admin-dedupe-modal-body">
              <div>
                This will remove duplicate custom templates with the same name inside the same layout. The newest template in each group will be kept. Built-in templates will not be deleted.
              </div>
              <div className="admin-inline-note warn">
                <div>Duplicate groups: {duplicateCleanupPreview.duplicateGroups.length}</div>
                <div>Templates removed: {duplicateCleanupPreview.duplicateCount}</div>
              </div>
              <div className="admin-dedupe-group-list">
                {duplicateCleanupPreview.duplicateGroups.map((group) => (
                  <div key={`${group.layoutId}::${group.normalizedName}`} className="admin-dedupe-group">
                    <div className="admin-dedupe-group-head">
                      <strong>{group.displayName || group.normalizedName}</strong>
                      <span className="admin-chip">{group.layoutId || 'No layout'}</span>
                    </div>
                    <div className="admin-dedupe-group-body">
                      <div>Keep: {group.keepTemplateId}</div>
                      <div>Remove: {group.removeTemplateIds.join(', ') || 'None'}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          confirmLabel={cleaningDuplicateTemplates ? 'Cleaning…' : 'Clean Duplicates'}
          danger
          onConfirm={cleanDuplicateTemplates}
          onCancel={() => {
            setDuplicateCleanupConfirmOpen(false);
            setDuplicateCleanupPreview(null);
          }}
        />
      )}

      {confirmDelete && (
        <ConfirmModal
          title="Delete template?"
          body={isBundledTemplate
            ? `"${selectedTemplate?.name}" is bundled with the app and will be hidden from Admin and customers.`
            : `"${selectedTemplate?.name}" will be permanently removed. This can't be undone.`}
          confirmLabel={isBundledTemplate ? 'Hide Template' : 'Delete'}
          danger
          onConfirm={doDelete}
          onCancel={() => setConfirmDelete(false)}
        />
      )}

      {pinModal && (
        <ChangePinModal
          onClose={() => setPinModal(false)}
          onStatus={setStatusMsg}
        />
      )}

      {eventManagerOpen && (
        <EventManagerModal
          events={events}
          activeEventId={settings.activeEventId}
          onClose={() => setEventManagerOpen(false)}
          onRefresh={refreshConfig}
          onStatus={setStatusMsg}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Small reusable confirm modal
// ─────────────────────────────────────────────────────────────────────────
function ConfirmModal({ title, body, confirmLabel = 'OK', onConfirm, onCancel, danger }) {
  return (
    <div className="admin-modal-backdrop" onClick={onCancel}>
      <div className="admin-modal" onClick={e => e.stopPropagation()}>
        <div className="admin-modal-title">{title}</div>
        <div className="admin-modal-body">{body}</div>
        <div className="admin-modal-actions">
          <button className="admin-btn ghost" onClick={onCancel}>Cancel</button>
          <button className={`admin-btn ${danger ? 'danger' : 'success'}`} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Change PIN modal
// ─────────────────────────────────────────────────────────────────────────
function ChangePinModal({ onClose, onStatus }) {
  const [cur, setCur] = useState('');
  const [next1, setNext1] = useState('');
  const [next2, setNext2] = useState('');
  const [busy, setBusy] = useState(false);
  const valid = /^\d{4}$/.test(cur) && /^\d{4}$/.test(next1) && next1 === next2;

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    try {
      const res = await window.adminApi.setPin(cur, next1);
      if (res?.ok) {
        onStatus?.('PIN updated.');
        onClose();
      } else {
        onStatus?.('PIN change failed: ' + (res?.error || 'unknown'));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="admin-modal-backdrop" onClick={onClose}>
      <div className="admin-modal" onClick={e => e.stopPropagation()}>
        <div className="admin-modal-title">Change PIN</div>
        <div className="admin-modal-body">
          <label className="admin-field">
            <span>Current PIN</span>
            <input type="password" inputMode="numeric" maxLength={4}
              value={cur} onChange={e => setCur(e.target.value.replace(/\D/g, ''))} />
          </label>
          <label className="admin-field">
            <span>New PIN (4 digits)</span>
            <input type="password" inputMode="numeric" maxLength={4}
              value={next1} onChange={e => setNext1(e.target.value.replace(/\D/g, ''))} />
          </label>
          <label className="admin-field">
            <span>Confirm New PIN</span>
            <input type="password" inputMode="numeric" maxLength={4}
              value={next2} onChange={e => setNext2(e.target.value.replace(/\D/g, ''))} />
          </label>
        </div>
        <div className="admin-modal-actions">
          <button className="admin-btn ghost" onClick={onClose}>Cancel</button>
          <button className="admin-btn success" disabled={!valid || busy} onClick={submit}>
            {busy ? 'Saving…' : 'Update PIN'}
          </button>
        </div>
      </div>
    </div>
  );
}

function normalizeEventDateInput(value = '') {
  const raw = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  if (!raw) return '';
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return '';
  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, '0');
  const day = String(parsed.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatEventDate(value = '') {
  const normalized = normalizeEventDateInput(value);
  if (!normalized) return 'No date';
  return new Date(`${normalized}T00:00:00`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

const readEventFileAsDataUrl = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(new Error('Failed to read file.'));
  reader.readAsDataURL(file);
});

function EventManagerModal({ events, activeEventId, onClose, onRefresh, onStatus }) {
  const [selectedId, setSelectedId] = useState(events[0]?.id || null);
  const [draft, setDraft] = useState({
    name: '',
    clientName: '',
    eventDate: '',
    enabled: true,
    colorThemeId: DEFAULT_UI_COLOR_THEME_ID,
    landingBackground: { type: 'none', src: null },
    landingBackgroundDataUrl: null,
    landingBackgroundPreviewUrl: null,
    removeLandingBackground: false,
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const eventBackgroundInputRef = useRef(null);

  const selectedEvent = events.find((event) => event.id === selectedId) || null;
  const modalTitle = selectedEvent ? 'Edit Event' : 'Create Event';

  useEffect(() => {
    queueMicrotask(() => {
      setError('');
      if (!selectedEvent) {
        setDraft({
          name: '',
          clientName: '',
          eventDate: '',
          enabled: true,
          colorThemeId: DEFAULT_UI_COLOR_THEME_ID,
          landingBackground: { type: 'none', src: null },
          landingBackgroundDataUrl: null,
          landingBackgroundPreviewUrl: null,
          removeLandingBackground: false,
        });
        return;
      }
      setDraft({
        name: selectedEvent.name || '',
        clientName: selectedEvent.clientName || '',
        eventDate: normalizeEventDateInput(selectedEvent.eventDate),
        enabled: selectedEvent.enabled !== false,
        colorThemeId: selectedEvent.colorThemeId || DEFAULT_UI_COLOR_THEME_ID,
        landingBackground: selectedEvent.landingBackground || { type: 'none', src: null },
        landingBackgroundDataUrl: null,
        landingBackgroundPreviewUrl: null,
        removeLandingBackground: false,
      });
    });
  }, [selectedEvent]);

  const pickEventBackground = () => eventBackgroundInputRef.current?.click();

  const onEventBackgroundChosen = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const isImage = file.type.startsWith('image/');
    const isVideo = file.type.startsWith('video/');
    if (!isImage && !isVideo) {
      setError('Choose an image or video file for the landing background.');
      return;
    }
    try {
      const dataUrl = await readEventFileAsDataUrl(file);
      setDraft((prev) => ({
        ...prev,
        landingBackground: {
          type: isVideo ? 'video' : 'image',
          src: null,
        },
        landingBackgroundDataUrl: dataUrl,
        landingBackgroundPreviewUrl: dataUrl,
        removeLandingBackground: false,
      }));
    } catch (err) {
      setError(err?.message || 'Failed to read landing background.');
    }
  };

  const clearEventBackground = () => {
    setDraft((prev) => ({
      ...prev,
      landingBackground: { type: 'none', src: null },
      landingBackgroundDataUrl: null,
      landingBackgroundPreviewUrl: null,
      removeLandingBackground: true,
    }));
  };

  const save = async () => {
    if (!window.adminApi?.createEvent || !window.adminApi?.updateEvent) {
      onStatus?.('Event changes require Electron runtime.');
      return;
    }
    if (busy) return;
    if (!draft.name.trim()) {
      setError('Event name is required.');
      onStatus?.('Event name is required.');
      return;
    }
    if (!draft.eventDate) {
      setError('Event date is required.');
      onStatus?.('Event date is required.');
      return;
    }
    setBusy(true);
    try {
      const payload = {
        name: draft.name.trim(),
        clientName: draft.clientName.trim(),
        eventDate: draft.eventDate,
        enabled: draft.enabled,
        colorThemeId: draft.colorThemeId || DEFAULT_UI_COLOR_THEME_ID,
        landingBackground: draft.landingBackground,
        landingBackgroundDataUrl: draft.landingBackgroundDataUrl,
        removeLandingBackground: draft.removeLandingBackground,
      };
      const res = selectedEvent
        ? await window.adminApi.updateEvent(selectedEvent.id, payload)
        : await window.adminApi.createEvent(payload);
      if (!res?.ok) {
        setError(res?.error || 'Event save failed.');
        onStatus?.('Event save failed: ' + (res?.error || 'unknown'));
        return;
      }
      await onRefresh?.();
      setSelectedId(res.event?.id || selectedId);
      setError('');
      onStatus?.(selectedEvent ? 'Event updated.' : 'Event created.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!window.adminApi?.deleteEvent) {
      onStatus?.('Event changes require Electron runtime.');
      return;
    }
    if (!selectedEvent || busy) return;
    setBusy(true);
    try {
      const res = await window.adminApi.deleteEvent(selectedEvent.id);
      if (!res?.ok) {
        onStatus?.('Delete failed: ' + (res?.error || 'unknown'));
        return;
      }
      await onRefresh?.();
      setSelectedId(null);
      onStatus?.('Event deleted.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="admin-modal-backdrop" onClick={onClose}>
      <div className="admin-modal admin-modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="admin-modal-heading">
          <div>
            <div className="admin-modal-title">Manage Events</div>
            <div className="admin-modal-subtitle">Create event sessions, choose dates, and control which events can be selected.</div>
          </div>
          <button type="button" className="admin-btn ghost" onClick={onClose}>Close</button>
        </div>
        <div className="admin-events-modal-body">
          <div className="admin-events-list">
            {events.length === 0 && (
              <div className="admin-events-empty">No events yet. Create the first event on the right.</div>
            )}
            {events.map((event) => (
              <button
                key={event.id}
                type="button"
                className={`admin-event-item ${selectedId === event.id ? 'selected' : ''}`}
                onClick={() => setSelectedId(event.id)}
              >
                <div className="admin-event-item-title">
                  {event.name}
                  {event.id === activeEventId && <span className="admin-chip on">Active</span>}
                </div>
                <div className="admin-event-item-meta">
                  {event.clientName || 'No client'} • {formatEventDate(event.eventDate)}
                </div>
              </button>
            ))}
            <button
              type="button"
              className="admin-list-new"
              onClick={() => setSelectedId(null)}
            >
              + Create Event
            </button>
          </div>

          <div className="admin-events-editor">
            <div className="admin-events-editor-head">
              <div className="admin-events-editor-title">{modalTitle}</div>
              <div className="admin-events-editor-sub">
                {selectedEvent ? 'Update the selected event details.' : 'Add a new event for Event Mode.'}
              </div>
            </div>
            {error && <div className="admin-form-error">{error}</div>}
            <label className="admin-field">
              <span>Event Name</span>
              <input
                type="text"
                value={draft.name}
                placeholder="e.g. Wedding Expo 2026"
                onChange={(e) => setDraft((prev) => ({ ...prev, name: e.target.value }))}
              />
            </label>
            <label className="admin-field">
              <span>Client Name</span>
              <input
                type="text"
                value={draft.clientName}
                placeholder="Optional client or host"
                onChange={(e) => setDraft((prev) => ({ ...prev, clientName: e.target.value }))}
              />
            </label>
            <label className="admin-field">
              <span>Event Date</span>
              <input
                type="date"
                value={draft.eventDate}
                onChange={(e) => setDraft((prev) => ({ ...prev, eventDate: e.target.value }))}
              />
              <small>Stored as YYYY-MM-DD for consistent event sorting.</small>
            </label>
            <label className="admin-field admin-field-row">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(e) => setDraft((prev) => ({ ...prev, enabled: e.target.checked }))}
              />
              <span>Enabled</span>
            </label>

            <div className="admin-event-branding-panel">
              <div className="admin-events-editor-head compact">
                <div className="admin-events-editor-title">Landing Branding</div>
                <div className="admin-events-editor-sub">Applied only when this event is active in Event Mode.</div>
              </div>

              <div className="admin-event-background-control">
                <div className="admin-field-label">Landing Background</div>
                <div className="admin-event-background-preview">
                  {(draft.landingBackgroundPreviewUrl || draft.landingBackground?.src) ? (
                    draft.landingBackground?.type === 'video' ? (
                      <video
                        src={draft.landingBackgroundPreviewUrl || draft.landingBackground.src}
                        muted
                        playsInline
                        controls
                      />
                    ) : (
                      <img
                        src={draft.landingBackgroundPreviewUrl || draft.landingBackground.src}
                        alt="Landing background preview"
                        loading="lazy"
                        decoding="async"
                      />
                    )
                  ) : (
                    <div className="admin-event-background-empty">Default landing background</div>
                  )}
                </div>
                <div className="admin-event-background-actions">
                  <button type="button" className="admin-btn ghost" onClick={pickEventBackground}>
                    Upload Image / Video
                  </button>
                  <button type="button" className="admin-btn warning" onClick={clearEventBackground}>
                    Remove Background
                  </button>
                </div>
                <input
                  ref={eventBackgroundInputRef}
                  type="file"
                  accept="image/*,video/*"
                  style={{ display: 'none' }}
                  onChange={onEventBackgroundChosen}
                />
              </div>

              <div className="admin-field">
                <span>Color Branding</span>
                <div className="admin-theme-grid">
                  {UI_COLOR_THEME_LIST.map((theme) => (
                    <button
                      key={theme.id}
                      type="button"
                      className={`admin-theme-card ${draft.colorThemeId === theme.id ? 'selected' : ''}`}
                      onClick={() => setDraft((prev) => ({ ...prev, colorThemeId: theme.id }))}
                    >
                      <span className="admin-theme-swatches">
                        <span style={{ background: theme.colors.bg }} />
                        <span style={{ background: theme.colors.surfaceSoft }} />
                        <span style={{ background: theme.colors.accent }} />
                      </span>
                      <strong>{theme.name}</strong>
                      <small>{theme.description}</small>
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="admin-modal-actions">
              <button className="admin-btn ghost" onClick={() => {
                setSelectedId(null);
                setDraft({
                  name: '',
                  clientName: '',
                  eventDate: '',
                  enabled: true,
                  colorThemeId: DEFAULT_UI_COLOR_THEME_ID,
                  landingBackground: { type: 'none', src: null },
                  landingBackgroundDataUrl: null,
                  landingBackgroundPreviewUrl: null,
                  removeLandingBackground: false,
                });
                setError('');
              }}>
                New Event
              </button>
              {selectedEvent && (
                <button className="admin-btn danger" onClick={remove} disabled={busy}>
                  Delete Event
                </button>
              )}
              <button className="admin-btn success" onClick={save} disabled={busy}>
                {busy ? 'Saving…' : (selectedEvent ? 'Save Event' : 'Create Event')}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
