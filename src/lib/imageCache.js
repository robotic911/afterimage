const imagePromises = new Map();
const MAX_CACHEABLE_IMAGES = 96;

function isCacheableImageSrc(src) {
  return typeof src === 'string'
    && src.length > 0
    && !src.startsWith('data:')
    && !src.startsWith('blob:');
}

export function loadImageCached(src, { crossOrigin = 'auto', nullable = false } = {}) {
  if (!src) return nullable ? Promise.resolve(null) : Promise.reject(new Error('Missing image source'));
  const cacheable = isCacheableImageSrc(src);
  if (cacheable && imagePromises.has(src)) return imagePromises.get(src);

  const promise = new Promise((resolve, reject) => {
    const img = new Image();
    if (crossOrigin === 'anonymous' || (crossOrigin === 'auto' && /^https?:\/\//i.test(src))) {
      img.crossOrigin = 'anonymous';
    }
    img.onload = () => resolve(img);
    img.onerror = () => {
      if (cacheable) imagePromises.delete(src);
      const error = new Error('Failed to load image');
      if (nullable) resolve(null);
      else reject(error);
    };
    img.src = src;
  });

  if (cacheable) {
    imagePromises.set(src, promise);
    if (imagePromises.size > MAX_CACHEABLE_IMAGES) {
      const oldestKey = imagePromises.keys().next().value;
      if (oldestKey) imagePromises.delete(oldestKey);
    }
  }
  return promise;
}

export function preloadImageCached(src, options = {}) {
  return loadImageCached(src, { ...options, nullable: true });
}

export function clearImageCache() {
  imagePromises.clear();
}

export function invalidateImageCache(src) {
  if (!src) return;
  const baseSrc = String(src).split('?')[0];
  for (const key of imagePromises.keys()) {
    if (key === src || key === baseSrc || key.startsWith(`${baseSrc}?`)) {
      imagePromises.delete(key);
    }
  }
}

export function getImageCacheSize() {
  return imagePromises.size;
}
