const IS_DEV = import.meta.env.DEV;

export function normalizeTemplateDisplayName(value = '') {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

export function getTemplateVisibilityKey(template = {}) {
  const layoutId = String(template.layoutId || '').trim();
  const normalizedName = normalizeTemplateDisplayName(template.name);
  return `${layoutId}::${normalizedName}`;
}

export function isTemplateVisibleToCustomer(template = {}, layout = null, settings = {}) {
  const layoutEnabled = layout?.enabled !== false;
  const mode = template.mode || 'daily';
  if (settings?.mode === 'event') {
    if (!settings.activeEventId) return false;
    if (mode !== 'event') return false;
    if (template.eventId !== settings.activeEventId) return false;
  } else if (mode === 'event') {
    return false;
  }

  return (
    template.enabled !== false
    && template.hidden !== true
    && template.deleted !== true
    && layoutEnabled
    && Boolean(template.layoutId)
  );
}

function getSourcePriority(template = {}) {
  if (template?.source === 'bundled' || template?.storageSource === 'bundled') return 1;
  if (template?.storageSource === 'legacy' || template?.storageMode === 'legacy') return 2;
  return 3;
}

function getTimestampValue(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function compareVisibilityPriority(existing = {}, incoming = {}) {
  const sourceDelta = getSourcePriority(incoming) - getSourcePriority(existing);
  if (sourceDelta !== 0) return sourceDelta;

  const enabledDelta = Number(incoming.enabled !== false) - Number(existing.enabled !== false);
  if (enabledDelta !== 0) return enabledDelta;

  const updatedDelta = getTimestampValue(incoming.updatedAt) - getTimestampValue(existing.updatedAt);
  if (updatedDelta !== 0) return updatedDelta;

  const createdDelta = getTimestampValue(incoming.createdAt) - getTimestampValue(existing.createdAt);
  if (createdDelta !== 0) return createdDelta;

  return 0;
}

export function dedupeVisibleCustomerTemplates(templates = []) {
  const groups = new Map();
  const orderedKeys = [];

  for (const template of templates) {
    if (!template?.id) continue;
    const key = getTemplateVisibilityKey(template);
    if (!groups.has(key)) {
      groups.set(key, {
        winner: template,
        templates: [template],
      });
      orderedKeys.push(key);
      continue;
    }

    const group = groups.get(key);
    group.templates.push(template);
    if (compareVisibilityPriority(group.winner, template) < 0) {
      group.winner = template;
    }
  }

  const duplicateGroups = [...groups.values()].filter((group) => group.templates.length > 1).length;
  const deduped = orderedKeys
    .map((key) => groups.get(key)?.winner)
    .filter(Boolean);

  if (IS_DEV) {
    console.log('[templates] deduped display templates', {
      before: templates.length,
      after: deduped.length,
      duplicateGroups,
    });
  }

  return deduped;
}

export function applyBundledTemplateOverrides(template = {}, overrides = {}) {
  const override = overrides?.[template.id];
  if (!override || typeof override !== 'object') {
    return {
      ...template,
      hidden: template.hidden ?? false,
      deleted: template.deleted ?? false,
    };
  }

  const deleted = override.deleted === true;
  const enabled = deleted ? false : (override.enabled ?? template.enabled ?? true);
  const hidden = deleted || override.hidden === true || template.hidden === true;

  return {
    ...template,
    enabled,
    hidden,
    deleted,
    name: override.name || template.name,
    type: override.type || template.type,
    desc: override.desc ?? template.desc,
  };
}
