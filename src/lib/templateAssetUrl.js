export function versionTemplateAssetSrc(src, template = {}) {
  if (!src || typeof src !== 'string') return src || null;
  const version = template.updatedAt || template.createdAt || '';
  if (!version || src.startsWith('data:') || src.startsWith('blob:')) return src;
  const separator = src.includes('?') ? '&' : '?';
  return `${src}${separator}v=${encodeURIComponent(version)}`;
}

export function getTemplatePreviewBackgroundSrc(template = {}) {
  return template?.backgroundSrc || template?.previewSrc || template?.src || null;
}

export function getTemplateOverlaySrc(template = {}) {
  if (template?.overlaySrc) return template.overlaySrc;
  if (template?.source === 'bundled' || template?.storageSource === 'bundled' || template?.isBundled === true) {
    return template?.src || null;
  }
  return null;
}
