export function resolveTemplateRenderAssets(template = {}) {
  const sourceType = template?.source || template?.storageSource || (template?.isBundled ? 'bundled' : 'runtime');
  const isBundled = sourceType === 'bundled' || template?.isBundled === true;
  const previewSrc = template?.previewSrc || null;
  const backgroundSrcRaw = template?.backgroundSrc || null;
  const overlaySrcRaw = template?.overlaySrc || null;
  const src = template?.src || null;

  const backgroundSrc = backgroundSrcRaw || previewSrc || (!isBundled ? src : null) || null;
  const overlaySrc = overlaySrcRaw || (isBundled ? src || null : null);
  const displaySrc = overlaySrc || backgroundSrc || previewSrc || src || null;

  return {
    backgroundSrc,
    overlaySrc,
    previewSrc,
    displaySrc,
    sourceType,
  };
}
