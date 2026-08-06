import {
  MAX_RECOMMENDED_VIDEO_BYTES,
  MAX_RECOMMENDED_VIDEO_MB,
  SESSION_VIDEO_FPS,
  SESSION_VIDEO_SCALE,
  VIDEO_SOFTCOPY_DURATION_MS,
} from '../constants/softcopySettings';
import {
  DEFAULT_CAMERA_ORIENTATION,
  isCameraOrientationMirrored,
  normalizeCameraOrientation,
} from '../constants/cameraSettings';
import { getCameraDrawRect } from './cameraFraming';
import { loadImageCached } from './imageCache';

const SHOT_CLIP_SCALE = 1;
const IS_DEV = import.meta.env.DEV;
const SESSION_VIDEO_MIME_TYPES = [
  'video/mp4;codecs=h264',
  'video/mp4',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
];

function pickSupportedVideoMimeType() {
  if (typeof MediaRecorder === 'undefined') return '';
  return SESSION_VIDEO_MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type)) || '';
}

function extensionFromMimeType(mimeType = '') {
  return mimeType.includes('mp4') ? 'mp4' : 'webm';
}

function loadVideoFromBlob(blob) {
  return new Promise((resolve) => {
    if (!blob) {
      resolve(null);
      return;
    }

    const url = URL.createObjectURL(blob);
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.src = url;
    video.onloadedmetadata = () => resolve({ video, url });
    video.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    video.load();
  });
}

function drawCover(ctx, source, dx, dy, dw, dh, { mirror = false } = {}) {
  const sW = source.videoWidth || source.naturalWidth || source.width;
  const sH = source.videoHeight || source.naturalHeight || source.height;
  if (!sW || !sH || !dw || !dh) return;

  const srcAspect = sW / sH;
  const destAspect = dw / dh;
  let sx = 0;
  let sy = 0;
  let sw = sW;
  let sh = sH;

  if (srcAspect > destAspect) {
    sh = sH;
    sw = sH * destAspect;
    sx = (sW - sw) / 2;
  } else {
    sw = sW;
    sh = sW / destAspect;
    sy = (sH - sh) / 2;
  }

  ctx.save();
  if (mirror) {
    ctx.translate(dx + dw, dy);
    ctx.scale(-1, 1);
    ctx.drawImage(source, sx, sy, sw, sh, 0, 0, dw, dh);
  } else {
    ctx.drawImage(source, sx, sy, sw, sh, dx, dy, dw, dh);
  }
  ctx.restore();
}

function drawHeightLockedCamera(ctx, video, canvasW, canvasH, layout, { mirror = false } = {}) {
  const vw = video.videoWidth || layout?.camera?.width || canvasW;
  const vh = video.videoHeight || layout?.camera?.height || canvasH;
  const {
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    drawX,
    drawY,
    drawWidth,
    drawHeight,
  } = getCameraDrawRect({
    sourceWidth: vw,
    sourceHeight: vh,
    targetWidth: canvasW,
    targetHeight: canvasH,
    framing: layout?.cameraFraming,
  });

  ctx.save();
  if (mirror) {
    ctx.translate(canvasW, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(
    video,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    drawX,
    drawY,
    drawWidth,
    drawHeight,
  );
  ctx.restore();
}

export async function startShotClipRecording({
  layout,
  video,
  shotIndex,
  durationTargetMs = null,
  photoFilter = '',
  cameraOrientation = DEFAULT_CAMERA_ORIENTATION,
  fps = SESSION_VIDEO_FPS,
}) {
  if (typeof MediaRecorder === 'undefined') {
    console.warn('[video] MediaRecorder is not available');
    return null;
  }
  if (!layout?.camera || !video) {
    console.warn('[video] missing layout camera or video element');
    return null;
  }

  const mimeType = pickSupportedVideoMimeType();
  if (!mimeType) {
    console.warn('[video] no supported MediaRecorder video mime type');
    return null;
  }

  const canvasW = Math.round(layout.camera.width * SHOT_CLIP_SCALE);
  const canvasH = Math.round(layout.camera.height * SHOT_CLIP_SCALE);
  const normalizedCameraOrientation = normalizeCameraOrientation(cameraOrientation);
  const mirrorCameraContent = isCameraOrientationMirrored(normalizedCameraOrientation);
  const canvas = document.createElement('canvas');
  canvas.width = canvasW;
  canvas.height = canvasH;

  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  const stream = canvas.captureStream(fps);
  const recorder = new MediaRecorder(stream, { mimeType });
  const chunks = [];
  let stopped = false;
  let frameRequest = null;
  let startedAt = Date.now();

  recorder.ondataavailable = (event) => {
    if (event.data?.size) chunks.push(event.data);
  };

  const render = () => {
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, canvasW, canvasH);
    if (video.readyState >= 2) {
      ctx.save();
      if (photoFilter) ctx.filter = photoFilter;
      drawHeightLockedCamera(ctx, video, canvasW, canvasH, layout, {
        mirror: mirrorCameraContent,
      });
      ctx.restore();
    }
    if (!stopped) frameRequest = requestAnimationFrame(render);
  };

  const stop = () => new Promise((resolve, reject) => {
    if (stopped) {
      reject(new Error('Shot clip recording already stopped'));
      return;
    }
    stopped = true;
    if (frameRequest) cancelAnimationFrame(frameRequest);

    recorder.onstop = () => {
      stream.getTracks().forEach((track) => track.stop());
      const durationMs = Date.now() - startedAt;
      const blob = new Blob(chunks, { type: mimeType });
      const extension = extensionFromMimeType(mimeType);
      chunks.length = 0;
      canvas.width = 0;
      canvas.height = 0;
      if (IS_DEV) {
        console.log('[video] shot clip ready', {
          shotIndex,
          size: blob.size,
          mimeType,
          extension,
          durationMs,
        });
      }
      resolve({
        blob,
        mimeType,
        extension,
        durationMs,
        shotIndex,
        cameraOrientation: normalizedCameraOrientation,
      });
    };
    recorder.onerror = (event) => {
      stream.getTracks().forEach((track) => track.stop());
      reject(event.error || new Error('Shot clip recording failed'));
    };
    recorder.stop();
  });

  render();
  recorder.start(1000);
  startedAt = Date.now();
  if (IS_DEV) {
    const framing = getCameraDrawRect({
      sourceWidth: video.videoWidth || layout.camera.width,
      sourceHeight: video.videoHeight || layout.camera.height,
      targetWidth: canvasW,
      targetHeight: canvasH,
      framing: layout.cameraFraming,
    });
    console.log('[video] session framing mode', framing.fitMode);
    console.log('[camera-framing] height-locked', {
      layoutId: layout.id,
      sourceWidth: framing.sourceWidth,
      sourceHeight: framing.sourceHeight,
      sourceAspect: framing.sourceAspect,
      targetWidth: canvasW,
      targetHeight: canvasH,
      targetAspect: framing.targetAspect,
      drawWidth: framing.drawWidth,
      drawHeight: framing.drawHeight,
      drawX: framing.drawX,
      drawY: framing.drawY,
      fullSourceHeightVisible: true,
    });
    console.log('[video] shot clip recording started', {
      shotIndex,
      durationTargetMs,
      cameraOrientation: normalizedCameraOrientation,
      mirrorApplied: mirrorCameraContent,
      mimeType,
      width: canvasW,
      height: canvasH,
      fps,
    });
    console.log('[mirror] gif/video/keychain', {
      gifMirrorApplied: false,
      videoMirrorApplied: mirrorCameraContent,
      keychainMirrorApplied: false,
      cameraOrientation: normalizedCameraOrientation,
    });
  }

  return { stop };
}

export async function composeSimultaneousSlotVideo({
  layout,
  shotVideoClips = [],
  backgroundSrc = null,
  templateSrc = null,
  photoFilter = '',
  selectedFilter = 'none',
  cameraOrientation = DEFAULT_CAMERA_ORIENTATION,
  fps = SESSION_VIDEO_FPS,
  scale = SESSION_VIDEO_SCALE,
}) {
  const usableClips = shotVideoClips.filter((clip) => clip?.blob);
  if (!usableClips.length) return null;
  const normalizedCameraOrientation = normalizeCameraOrientation(cameraOrientation);

  const mimeType = pickSupportedVideoMimeType();
  if (!mimeType) {
    console.warn('[video] no supported final composition mime type');
    return null;
  }

  const width = Math.round((layout?.canvas?.w || layout?.canvas?.width || 1200) * scale);
  const height = Math.round((layout?.canvas?.h || layout?.canvas?.height || 1800) * scale);
  const finalDurationMs = VIDEO_SOFTCOPY_DURATION_MS;

  if (IS_DEV) {
    console.log('[filter] final render filter', {
      selectedFilter: selectedFilter || 'none',
      outputType: 'video',
    });
    console.log('[video] target duration ms', VIDEO_SOFTCOPY_DURATION_MS);
    console.log('[video] simultaneous composition started', {
      clipCount: usableClips.length,
      finalDurationMs,
      width,
      height,
      backgroundSelected: Boolean(backgroundSrc),
      cameraOrientation: normalizedCameraOrientation,
      sourceClipsAlreadyOriented: true,
    });
  }

  const [background, template, loadedVideos] = await Promise.all([
    loadImageCached(backgroundSrc, { nullable: true }),
    loadImageCached(templateSrc, { nullable: true }),
    Promise.all(usableClips.map(async (clip) => ({
      clip,
      loaded: await loadVideoFromBlob(clip.blob),
    }))),
  ]);

  const videoItems = loadedVideos.filter((item) => item.loaded?.video);
  if (!videoItems.length) {
    loadedVideos.forEach(({ loaded }) => {
      if (loaded?.url) URL.revokeObjectURL(loaded.url);
    });
    return null;
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  const stream = canvas.captureStream(fps);
  const recorder = new MediaRecorder(stream, { mimeType });
  const chunks = [];
  let stopped = false;
  let frameRequest = null;

  recorder.ondataavailable = (event) => {
    if (event.data?.size) chunks.push(event.data);
  };

  const render = () => {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    if (background) ctx.drawImage(background, 0, 0, width, height);

    for (const { clip, loaded } of videoItems) {
      const video = loaded.video;
      const matchingSlots = (layout?.slots || []).filter((slot) => slot.shotIndex === clip.shotIndex);

      for (const slot of matchingSlots) {
        const layoutW = layout?.canvas?.w || layout?.canvas?.width || 1200;
        const layoutH = layout?.canvas?.h || layout?.canvas?.height || 1800;
        ctx.save();
        if (photoFilter) ctx.filter = photoFilter;
        drawCover(
          ctx,
          video,
          (slot.x / layoutW) * width,
          (slot.y / layoutH) * height,
          (slot.w / layoutW) * width,
          (slot.h / layoutH) * height,
        );
        ctx.restore();
      }
    }

    if (template) ctx.drawImage(template, 0, 0, width, height);
    if (!stopped) frameRequest = requestAnimationFrame(render);
  };

  const resultPromise = new Promise((resolve, reject) => {
    recorder.onstop = () => {
      stopped = true;
      if (frameRequest) cancelAnimationFrame(frameRequest);
      stream.getTracks().forEach((track) => track.stop());
      videoItems.forEach(({ loaded }) => URL.revokeObjectURL(loaded.url));

      const blob = new Blob(chunks, { type: mimeType });
      const extension = extensionFromMimeType(mimeType);
      chunks.length = 0;
      canvas.width = 0;
      canvas.height = 0;
      if (blob.size > MAX_RECOMMENDED_VIDEO_BYTES) {
        console.warn('[video] video is large for Supabase Free plan', {
          sizeMb: Number((blob.size / 1024 / 1024).toFixed(2)),
          recommendedMaxMb: MAX_RECOMMENDED_VIDEO_MB,
        });
      }
      console.log('[video] simultaneous composition finished', {
        size: blob.size,
        mimeType,
        extension,
        durationMs: finalDurationMs,
      });
      resolve({ blob, mimeType, extension, durationMs: finalDurationMs });
    };
    recorder.onerror = (event) => {
      stopped = true;
      if (frameRequest) cancelAnimationFrame(frameRequest);
      stream.getTracks().forEach((track) => track.stop());
      videoItems.forEach(({ loaded }) => URL.revokeObjectURL(loaded.url));
      chunks.length = 0;
      canvas.width = 0;
      canvas.height = 0;
      reject(event.error || new Error('Final video composition failed'));
    };
  });

  for (const { loaded } of videoItems) {
    loaded.video.currentTime = 0;
    loaded.video.loop = true;
    loaded.video.muted = true;
    await loaded.video.play().catch((error) => {
      console.warn('[video] source clip play failed:', error);
    });
  }

  render();
  recorder.start(1000);
  window.setTimeout(() => {
    stopped = true;
    if (recorder.state !== 'inactive') recorder.stop();
    videoItems.forEach(({ loaded }) => loaded.video.pause());
  }, finalDurationMs);

  return resultPromise;
}
