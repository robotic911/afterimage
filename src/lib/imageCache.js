const imagePromises = new Map();
const MAX_CACHEABLE_IMAGES = 96;
const sessionImagePromises = new Map();
const MAX_SESSION_IMAGES = 16;

function isCacheableImageSrc(src) {
  return typeof src === 'string'
    && src.length > 0
    && !src.startsWith('data:')
    && !src.startsWith('blob:');
}

function isSessionImageSrc(src) {
  return typeof src === 'string'
    && src.startsWith('data:image/')
    && src.includes('base64,');
}

function shouldUseAnonymousCors(src) {
  return /^https?:\/\//i.test(src)
    || /^kuku-template:\/\//i.test(src)
    || /^kuku-event:\/\//i.test(src);
}

export function loadImageCached(src, { crossOrigin = 'auto', nullable = false } = {}) {
  if (!src) return nullable ? Promise.resolve(null) : Promise.reject(new Error('Missing image source'));
  const cacheable = isCacheableImageSrc(src);
  const sessionCacheable = isSessionImageSrc(src);
  if (cacheable && imagePromises.has(src)) return imagePromises.get(src);
  if (sessionCacheable && sessionImagePromises.has(src)) return sessionImagePromises.get(src);

  const promise = new Promise((resolve, reject) => {
    const img = new Image();
    if (crossOrigin === 'anonymous' || (crossOrigin === 'auto' && shouldUseAnonymousCors(src))) {
      img.crossOrigin = 'anonymous';
    }
    img.onload = () => resolve(img);
    img.onerror = () => {
      if (cacheable) imagePromises.delete(src);
      if (sessionCacheable) sessionImagePromises.delete(src);
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
  if (sessionCacheable) {
    sessionImagePromises.set(src, promise);
    if (sessionImagePromises.size > MAX_SESSION_IMAGES) {
      const oldestKey = sessionImagePromises.keys().next().value;
      if (oldestKey) sessionImagePromises.delete(oldestKey);
    }
  }
  return promise;
}

export function preloadImageCached(src, options = {}) {
  return loadImageCached(src, { ...options, nullable: true });
}

export function clearImageCache() {
  imagePromises.clear();
  sessionImagePromises.clear();
}

export function clearSessionImageCache() {
  sessionImagePromises.clear();
}

export function invalidateImageCache(src) {
  if (!src) return;
  const baseSrc = String(src).split('?')[0];
  for (const key of imagePromises.keys()) {
    if (key === src || key === baseSrc || key.startsWith(`${baseSrc}?`)) {
      imagePromises.delete(key);
    }
  }
  sessionImagePromises.delete(src);
}

export function getImageCacheSize() {
  return imagePromises.size + sessionImagePromises.size;
}
