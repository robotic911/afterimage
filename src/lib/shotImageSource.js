export function getShotImageSource(shot) {
  if (!shot) return null;
  if (typeof shot === 'string') return shot;
  if (typeof shot === 'object') {
    return (
      shot.fullSrc
      || shot.dataUrl
      || shot.capturedDataUrl
      || shot.imageDataUrl
      || shot.originalSrc
      || shot.src
      || shot.previewUrl
      || shot.url
      || shot.imageUrl
      || null
    );
  }
  return null;
}

export function inspectDataUrl(src) {
  if (!src || typeof src !== 'string') {
    return {
      validType: false,
      reason: 'not a string',
    };
  }

  const commaIndex = src.indexOf(',');
  const header = commaIndex >= 0 ? src.slice(0, commaIndex) : src.slice(0, 120);
  const base64 = commaIndex >= 0 ? src.slice(commaIndex + 1) : '';

  return {
    validType: true,
    length: src.length,
    startsWithDataImage: src.startsWith('data:image/'),
    header,
    commaIndex,
    base64Length: base64.length,
    base64Mod4: base64.length % 4,
    hasWhitespace: /\s/.test(base64),
    hasInvalidBase64Chars: /[^A-Za-z0-9+/=]/.test(base64),
    endsWithPadding: base64.endsWith('='),
    sampleStart: src.slice(0, 120),
    sampleEnd: src.slice(-120),
  };
}

export function isLikelyDataImage(src) {
  return typeof src === 'string' && src.startsWith('data:image/') && src.includes('base64,');
}

export function testImageLoad(src, label) {
  return new Promise((resolve) => {
    const img = new Image();

    img.onload = () => {
      console.log(`[${label}] image decode OK`, {
        width: img.naturalWidth || img.width,
        height: img.naturalHeight || img.height,
        srcLength: src?.length,
      });
      resolve(true);
    };

    img.onerror = () => {
      console.error(`[${label}] image decode FAILED`, inspectDataUrl(src));
      resolve(false);
    };

    img.src = src;
  });
}

export function canvasToPngDataUrl(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('canvas.toBlob returned null'));
        return;
      }

      const reader = new FileReader();

      reader.onloadend = () => {
        const result = reader.result;
        if (typeof result !== 'string') {
          reject(new Error('FileReader result was not a string'));
          return;
        }
        resolve(result);
      };

      reader.onerror = () => {
        reject(new Error('FileReader failed while converting PNG blob to data URL'));
      };

      reader.readAsDataURL(blob);
    }, 'image/png', 1);
  });
}

export function describeShotForAudit(shot, index) {
  const source = getShotImageSource(shot);
  return {
    index,
    type: typeof shot,
    isString: typeof shot === 'string',
    prefix: typeof shot === 'string' ? shot.slice(0, 100) : null,
    keys: shot && typeof shot === 'object' ? Object.keys(shot) : null,
    src: shot?.src ? String(shot.src).slice(0, 100) : null,
    fullSrc: shot?.fullSrc ? String(shot.fullSrc).slice(0, 100) : null,
    dataUrl: shot?.dataUrl ? String(shot.dataUrl).slice(0, 100) : null,
    resolvedSourcePrefix: source ? String(source).slice(0, 100) : null,
    hasResolvedSource: Boolean(source),
    dataUrlAudit: inspectDataUrl(source),
  };
}
