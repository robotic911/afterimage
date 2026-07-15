import { useCallback, useEffect, useMemo, useState } from 'react';
import { WEB_FALLBACK_TEMPLATES } from '../constants/templates';
import {
  applyBundledTemplateOverrides,
  getTemplateVisibilityKey,
} from '../lib/templateVisibility';

// Runtime template loader. Pulls the list from the main process via
// window.adminApi.listTemplates() and exposes a refresh() so admin
// screens can force a reload after create / update / delete.
//
// In browser dev mode (no Electron), adminApi is undefined. We return
// the bundled default templates so SelectionScreen / PrintScreen /
// AdminScreen all render populated state for CSS iteration. In Electron,
// the runtime template store is authoritative for uploaded templates,
// but the bundled templates remain available as system defaults. We
// merge them so uploaded templates are preserved and built-ins stay
// visible without overwriting user data.

function normalizeTemplate(template = {}, source = 'runtime') {
  const normalizedSrc = template.src || null;
  const normalizedPreviewSrc = template.previewSrc || null;
  const normalizedBackgroundSrc = template.backgroundSrc || null;
  const normalizedOverlaySrc = template.overlaySrc || (source === 'bundled' ? normalizedSrc : null);
  return {
    ...template,
    enabled: template.enabled ?? true,
    hidden: template.hidden ?? false,
    deleted: template.deleted ?? false,
    type: template.type ?? 'Uncategorized',
    mode: template.mode === 'event' ? 'event' : 'daily',
    eventId: template.eventId ?? null,
    source: template.source || source,
    storageSource: template.storageSource || null,
    storageMode: template.storageMode || null,
    templateSourcePath: template.templateSourcePath || null,
    filePath: template.filePath || null,
    storagePath: template.storagePath || null,
    thumbnailSrc: template.thumbnailSrc || null,
    src: normalizedSrc,
    previewSrc: normalizedPreviewSrc,
    backgroundSrc: normalizedBackgroundSrc,
    overlaySrc: normalizedOverlaySrc,
    isBundled: source === 'bundled',
    isRuntime: source === 'runtime',
  };
}

function mergeTemplates(runtimeTemplates = [], bundledTemplateOverrides = {}) {
  const merged = new Map();
  const runtimeDisplayKeys = new Set();

  for (const template of runtimeTemplates) {
    if (!template?.id) continue;
    const normalized = normalizeTemplate(template, 'runtime');
    merged.set(template.id, normalized);
    runtimeDisplayKeys.add(getTemplateVisibilityKey(normalized));
  }

  for (const template of WEB_FALLBACK_TEMPLATES) {
    if (!template?.id || merged.has(template.id)) continue;
    const mergedBundled = applyBundledTemplateOverrides(normalizeTemplate(template, 'bundled'), bundledTemplateOverrides);
    if (runtimeDisplayKeys.has(getTemplateVisibilityKey(mergedBundled))) continue;
    merged.set(template.id, mergedBundled);
  }

  return [...merged.values()];
}

function logTemplateSummary({ sourceSummary = {}, builtInCount = 0, runtimeCount = 0, finalCount = 0 }) {
  console.log('[templates] final template source summary', {
    builtInCount,
    legacyCount: sourceSummary.legacyCount ?? 0,
    currentRuntimeCount: sourceSummary.currentRuntimeCount ?? runtimeCount,
    mergedRuntimeCount: sourceSummary.mergedRuntimeCount ?? runtimeCount,
    finalCount,
  });
}

function logAdminVisibilitySummary(templates = []) {
  if (!import.meta.env.DEV) return;
  const total = templates.length;
  const active = templates.filter((template) => template.enabled !== false && template.hidden !== true && template.deleted !== true).length;
  const inactive = templates.filter((template) => template.enabled === false).length;
  const hidden = templates.filter((template) => template.hidden === true || template.deleted === true).length;
  console.log('[templates] admin templates', {
    total,
    active,
    inactive,
    hidden,
  });
}

export function useTemplates(settings = null) {
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const bundledTemplateOverrides = useMemo(
    () => settings?.bundledTemplateOverrides || {},
    [settings?.bundledTemplateOverrides],
  );

  const refresh = useCallback(async () => {
    if (!window.adminApi?.listTemplates) {
      const fallbackTemplates = mergeTemplates([], bundledTemplateOverrides);
      console.log('[templates] built-in templates loaded', { count: WEB_FALLBACK_TEMPLATES.length });
      if (import.meta.env.DEV) {
        console.log('[RUNTIME TEMPLATE AUDIT]', fallbackTemplates.map((t) => ({
          id: t.id,
          name: t.name,
          layoutId: t.layoutId,
          type: t.type,
          hasSrc: Boolean(t.src),
          src: t.src || null,
          hasPreviewSrc: Boolean(t.previewSrc),
          previewSrc: t.previewSrc || null,
          hasBackgroundSrc: Boolean(t.backgroundSrc),
          backgroundSrc: t.backgroundSrc || null,
          hasOverlaySrc: Boolean(t.overlaySrc),
          overlaySrc: t.overlaySrc || null,
          thumbnailSrc: t.thumbnailSrc || null,
          filePath: t.filePath || null,
          storagePath: t.storagePath || null,
          keys: Object.keys(t),
        })));
      }
      logTemplateSummary({
        sourceSummary: { currentRuntimeCount: 0, legacyCount: 0, mergedRuntimeCount: 0 },
        builtInCount: WEB_FALLBACK_TEMPLATES.length,
        runtimeCount: 0,
        finalCount: fallbackTemplates.length,
      });
      setTemplates(fallbackTemplates);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    try {
      const res = await window.adminApi.listTemplates();
      if (res?.ok) {
        const runtimeTemplates = Array.isArray(res.templates) ? res.templates : [];
        const mergedTemplates = mergeTemplates(runtimeTemplates, bundledTemplateOverrides);
        console.log('[templates] built-in templates loaded', { count: WEB_FALLBACK_TEMPLATES.length });
        console.log('[templates] runtime templates loaded', { count: runtimeTemplates.length });
        if (import.meta.env.DEV) {
          console.log('[RUNTIME TEMPLATE AUDIT]', mergedTemplates.map((t) => ({
            id: t.id,
            name: t.name,
            layoutId: t.layoutId,
            type: t.type,
            hasSrc: Boolean(t.src),
            src: t.src || null,
            hasPreviewSrc: Boolean(t.previewSrc),
            previewSrc: t.previewSrc || null,
            hasBackgroundSrc: Boolean(t.backgroundSrc),
            backgroundSrc: t.backgroundSrc || null,
            hasOverlaySrc: Boolean(t.overlaySrc),
            overlaySrc: t.overlaySrc || null,
            thumbnailSrc: t.thumbnailSrc || null,
            filePath: t.filePath || null,
            storagePath: t.storagePath || null,
            keys: Object.keys(t),
          })));
        }
        logTemplateSummary({
          sourceSummary: res.sourceSummary || {},
          builtInCount: WEB_FALLBACK_TEMPLATES.length,
          runtimeCount: runtimeTemplates.length,
          finalCount: mergedTemplates.length,
        });
        logAdminVisibilitySummary(mergedTemplates);
        setTemplates(mergedTemplates);
        setError(null);
      } else {
        const fallbackTemplates = mergeTemplates([], bundledTemplateOverrides);
        console.log('[templates] built-in templates loaded', { count: WEB_FALLBACK_TEMPLATES.length });
        if (import.meta.env.DEV) {
          console.log('[RUNTIME TEMPLATE AUDIT]', fallbackTemplates.map((t) => ({
            id: t.id,
            name: t.name,
            layoutId: t.layoutId,
            type: t.type,
            hasSrc: Boolean(t.src),
            src: t.src || null,
            hasPreviewSrc: Boolean(t.previewSrc),
            previewSrc: t.previewSrc || null,
            hasBackgroundSrc: Boolean(t.backgroundSrc),
            backgroundSrc: t.backgroundSrc || null,
            hasOverlaySrc: Boolean(t.overlaySrc),
            overlaySrc: t.overlaySrc || null,
            thumbnailSrc: t.thumbnailSrc || null,
            filePath: t.filePath || null,
            storagePath: t.storagePath || null,
            keys: Object.keys(t),
          })));
        }
        logTemplateSummary({
          sourceSummary: { currentRuntimeCount: 0, legacyCount: 0, mergedRuntimeCount: 0 },
          builtInCount: WEB_FALLBACK_TEMPLATES.length,
          runtimeCount: 0,
          finalCount: fallbackTemplates.length,
        });
        logAdminVisibilitySummary(fallbackTemplates);
        setTemplates(fallbackTemplates);
        setError(res?.error || 'unknown error');
      }
    } catch (err) {
      const fallbackTemplates = mergeTemplates([], bundledTemplateOverrides);
      console.log('[templates] built-in templates loaded', { count: WEB_FALLBACK_TEMPLATES.length });
      if (import.meta.env.DEV) {
        console.log('[RUNTIME TEMPLATE AUDIT]', fallbackTemplates.map((t) => ({
          id: t.id,
          name: t.name,
          layoutId: t.layoutId,
          type: t.type,
          hasSrc: Boolean(t.src),
          src: t.src || null,
          hasPreviewSrc: Boolean(t.previewSrc),
          previewSrc: t.previewSrc || null,
          hasBackgroundSrc: Boolean(t.backgroundSrc),
          backgroundSrc: t.backgroundSrc || null,
          hasOverlaySrc: Boolean(t.overlaySrc),
          overlaySrc: t.overlaySrc || null,
          thumbnailSrc: t.thumbnailSrc || null,
          filePath: t.filePath || null,
          storagePath: t.storagePath || null,
          keys: Object.keys(t),
        })));
      }
      logTemplateSummary({
        sourceSummary: { currentRuntimeCount: 0, legacyCount: 0, mergedRuntimeCount: 0 },
        builtInCount: WEB_FALLBACK_TEMPLATES.length,
        runtimeCount: 0,
        finalCount: fallbackTemplates.length,
      });
      logAdminVisibilitySummary(fallbackTemplates);
      setTemplates(fallbackTemplates);
      setError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  }, [bundledTemplateOverrides]);

  useEffect(() => {
    queueMicrotask(() => {
      refresh();
    });
  }, [refresh]);

  return { templates, loading, error, refresh };
}
