export function versionTemplateAssetSrc(src, template = {}) {
  if (!src || typeof src !== 'string') return src || null;
  const version = template.updatedAt || template.createdAt || '';
  if (!version || src.startsWith('data:') || src.startsWith('blob:')) return src;
  const separator = src.includes('?') ? '&' : '?';
  return `${src}${separator}v=${encodeURIComponent(version)}`;
}
