import {
  GIF_FRAME_INTERVAL,
  GIF_OUTPUT_SCALE,
  GIF_QUALITY,
  MAX_RECOMMENDED_GIF_BYTES,
  MAX_RECOMMENDED_GIF_MB,
} from '../constants/softcopySettings';
import { loadImageCached } from './imageCache';

const IS_DEV = import.meta.env.DEV;

function dataUrlToBlob(dataUrl) {
  const [header, base64] = String(dataUrl || '').split(',');
  const mime = header?.match(/data:(.*?);base64/)?.[1] || 'image/gif';
  const binary = atob(base64 || '');
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return new Blob([bytes], { type: mime });
}

function loadImageSize(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({
      width: img.naturalWidth,
      height: img.naturalHeight,
    });
    img.onerror = () => reject(new Error('Failed to inspect GIF frame size'));
    img.src = dataUrl;
  });
}

function toPositiveInteger(value) {
  const number = Math.round(Number(value));
  return Number.isFinite(number) && number > 0 ? number : null;
}

async function resolveGifDimensions(safeShots, options = {}) {
  const optionWidth = toPositiveInteger(options.width ?? options.gifWidth);
  const optionHeight = toPositiveInteger(options.height ?? options.gifHeight);
  if (optionWidth && optionHeight) {
    return { width: optionWidth, height: optionHeight, source: 'layout.camera' };
  }

  try {
    const firstShotSize = await loadImageSize(safeShots[0]);
    const imageWidth = toPositiveInteger(firstShotSize.width);
    const imageHeight = toPositiveInteger(firstShotSize.height);
    if (imageWidth && imageHeight) {
      return { width: imageWidth, height: imageHeight, source: 'first-shot' };
    }
  } catch (err) {
    console.warn('[GIF] failed to inspect first shot size:', err?.message || err);
  }

  return { width: 560, height: 367, source: 'fallback' };
}

async function applyFilterToFrames(shots, photoFilter) {
  if (!photoFilter) return shots;

  return Promise.all(shots.map(async (shot) => {
    const image = await loadImageCached(shot);
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.filter = photoFilter;
    ctx.drawImage(image, 0, 0, width, height);
    const filteredFrame = canvas.toDataURL('image/png');
    canvas.width = 0;
    canvas.height = 0;
    return filteredFrame;
  }));
}

export async function generateSessionGif(shots, options = {}) {
  const safeShots = (shots || []).filter(Boolean);

  if (!safeShots.length) {
    throw new Error('No shots available for GIF generation');
  }

  const dimensions = await resolveGifDimensions(safeShots, options);
  const outputScale = Math.min(1, Math.max(0.1, Number(options.outputScale ?? options.scale ?? GIF_OUTPUT_SCALE) || GIF_OUTPUT_SCALE));
  const gifWidth = Math.max(1, Math.round(dimensions.width * outputScale));
  const gifHeight = Math.max(1, Math.round(dimensions.height * outputScale));
  const interval = Number(options.interval ?? GIF_FRAME_INTERVAL) || GIF_FRAME_INTERVAL;
  const quality = Number(options.quality ?? GIF_QUALITY) || GIF_QUALITY;
  const frames = safeShots.length;
  const gifFrames = await applyFilterToFrames(safeShots, options.photoFilter || '');

  if (IS_DEV) {
    console.log('[filter] final render filter', {
      selectedFilter: options.selectedFilter || 'none',
      outputType: 'gif',
    });
    console.log('[gif] generation settings', {
      layoutId: options.layoutId || null,
      gifWidth,
      gifHeight,
      outputScale,
      interval,
      quality,
      frames,
      source: dimensions.source,
    });
  }

  const { default: gifshot } = await import('gifshot');

  return new Promise((resolve, reject) => {
    gifshot.createGIF(
      {
        images: gifFrames,
        interval,
        gifWidth,
        gifHeight,
        quality,
        numFrames: frames,
        repeat: 0,
      },
      (result) => {
        if (!result || result.error || !result.image) {
          reject(new Error(result?.errorMsg || 'GIF generation failed'));
          return;
        }

        const blob = dataUrlToBlob(result.image);
        if (blob.size > MAX_RECOMMENDED_GIF_BYTES) {
          console.warn('[GIF] output is large for Supabase Free plan', {
            sizeMb: Number((blob.size / 1024 / 1024).toFixed(2)),
            recommendedMaxMb: MAX_RECOMMENDED_GIF_MB,
          });
        }
        if (IS_DEV) {
          console.log('[gif] generated', {
            size: blob.size,
            sizeMb: Number((blob.size / 1024 / 1024).toFixed(2)),
            width: gifWidth,
            height: gifHeight,
          });
        }

        resolve({
          dataUrl: result.image,
          blob,
        });
      },
    );
  });
}
