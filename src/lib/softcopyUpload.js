import { supabase, SOFTCOPY_BUCKET, SOFTCOPY_PAGE_BASE_URL } from './supabaseClient';
import {
  MAX_RECOMMENDED_GIF_BYTES,
  MAX_RECOMMENDED_GIF_MB,
  MAX_RECOMMENDED_SESSION_UPLOAD_BYTES,
  MAX_RECOMMENDED_SESSION_UPLOAD_MB,
  MAX_RECOMMENDED_VIDEO_BYTES,
  MAX_RECOMMENDED_VIDEO_MB,
} from '../constants/softcopySettings';

export const SOFTCOPY_LINK_EXPIRES_IN = 6 * 60 * 60;
const SOFTCOPY_LINK_EXPIRES_IN_MS = SOFTCOPY_LINK_EXPIRES_IN * 1000;
const IS_DEV = import.meta.env.DEV;

function compactValue(value) {
  if (value === undefined) return null;
  if (value === null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  return JSON.parse(JSON.stringify(value, (_key, nestedValue) => (
    typeof nestedValue === 'bigint' ? nestedValue.toString() : nestedValue
  )));
}

function describeSupabaseError(error) {
  if (!error) {
    return {
      code: null,
      message: 'unknown error',
      httpStatus: null,
      details: null,
      hint: null,
      stack: null,
    };
  }

  return {
    code: error.code || error.error || error.name || null,
    message: error.message || String(error),
    httpStatus: error.status || error.statusCode || null,
    details: compactValue(error.details || null),
    hint: compactValue(error.hint || null),
    stack: error.stack || null,
  };
}

function createDiagnosticError(message, diagnostics, cause = null) {
  const error = new Error(message);
  error.code = cause?.code || cause?.error || cause?.name || null;
  error.status = cause?.status || cause?.statusCode || null;
  error.cause = cause || undefined;
  error.softcopyDiagnostics = Array.isArray(diagnostics) ? diagnostics : [diagnostics];
  if (cause?.stack) {
    error.stack = `${error.stack}\nCaused by: ${cause.stack}`;
  }
  return error;
}

function getErrorDiagnostics(error, fallback = null) {
  if (Array.isArray(error?.softcopyDiagnostics)) return error.softcopyDiagnostics;
  if (error?.softcopyDiagnostics) return [error.softcopyDiagnostics];
  return fallback ? [fallback] : [];
}

function maskToken(value) {
  const text = String(value || '');
  if (!text) return null;
  if (text.length <= 12) return `${text.slice(0, 3)}...`;
  return `${text.slice(0, 8)}...${text.slice(-4)}`;
}

function maskStoragePath(value) {
  const text = String(value || '');
  if (!text) return null;
  const parts = text.split('/').filter(Boolean);
  const sessionsIndex = parts.indexOf('sessions');
  if (sessionsIndex >= 0 && parts[sessionsIndex + 1]) {
    const fileName = parts[parts.length - 1] || '';
    return `sessions/${maskToken(parts[sessionsIndex + 1])}/${fileName}`;
  }
  return parts.length > 0 ? `.../${parts[parts.length - 1]}` : null;
}

function sanitizeDiagnosticForConsole(value, key = '') {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeDiagnosticForConsole(item));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        sanitizeDiagnosticForConsole(entryValue, entryKey),
      ]),
    );
  }

  const normalizedKey = key.toLowerCase();
  if (normalizedKey.includes('token')) return maskToken(value);
  if (normalizedKey.includes('path')) return maskStoragePath(value);
  if (normalizedKey === 'requesturl') return '<redacted-url>';
  return value;
}

function logSoftcopyDiagnostic(label, diagnostic) {
  console.error(label, sanitizeDiagnosticForConsole(diagnostic));
}

function timeStart(label) {
  if (IS_DEV) console.time(label);
}

function timeEnd(label) {
  if (IS_DEV) console.timeEnd(label);
}

export function dataUrlToBlob(dataUrl) {
  const [header, base64] = String(dataUrl || '').split(',');
  const mime = header?.match(/data:(.*?);base64/)?.[1] || 'image/jpeg';
  const binary = atob(base64 || '');
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return new Blob([bytes], { type: mime });
}

export function createSoftcopySessionToken() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const random = Math.random().toString(36).slice(2, 10);
  return `session-${Date.now()}-${random}`;
}

function assertSupabaseReady() {
  if (!supabase) {
    throw new Error('Supabase is not configured');
  }
}

export async function uploadBlobToStorage(
  blob,
  filePath,
  contentType,
  {
    resolvePublicUrl = false,
    sessionToken = null,
    fileLabel = null,
  } = {},
) {
  assertSupabaseReady();

  const bucket = SOFTCOPY_BUCKET;
  console.log('[softcopy] upload attempt', {
    mediaType: contentType,
    bucket,
    path: maskStoragePath(filePath),
    fileLabel,
    sessionToken: maskToken(sessionToken),
    contentType,
    size: blob?.size || 0,
  });

  const uploadRes = await supabase.storage
    .from(SOFTCOPY_BUCKET)
    .upload(filePath, blob, {
      contentType,
      // Session-scoped paths are safe to overwrite on retry so a failed
      // upload can reuse the same blobs without creating duplicates.
      upsert: true,
    });

  const { error } = uploadRes;
  const { data: publicData } = resolvePublicUrl
    ? supabase.storage.from(bucket).getPublicUrl(filePath)
    : { data: null };
  console.log('[softcopy] upload result', {
    mediaType: contentType,
    bucket,
    path: maskStoragePath(filePath),
    fileLabel,
    sessionToken: maskToken(sessionToken),
    size: blob?.size || 0,
    contentType,
    uploadOk: !error,
    publicUrl: publicData?.publicUrl || null,
    signedUrlExists: false,
    error: error ? describeSupabaseError(error) : null,
  });

  if (error) {
    const diagnostic = {
      step: 'storage_upload',
      bucket,
      uploadPath: filePath,
      fileLabel,
      sessionToken,
      contentType,
      sizeBytes: blob?.size || 0,
      error: describeSupabaseError(error),
      code: error.code || error.error || null,
      message: error.message || String(error),
      httpStatus: error.status || error.statusCode || null,
      stack: error.stack || null,
    };
    logSoftcopyDiagnostic('[softcopy-diagnostic] storage upload failed', diagnostic);
    throw createDiagnosticError(`Supabase Storage upload failed for ${fileLabel || filePath}: ${diagnostic.message}`, diagnostic, error);
  }

  return {
    uploadOk: true,
    publicUrl: publicData?.publicUrl || null,
    signedUrlExists: false,
  };
}

function getVideoExtension(mimeType = '') {
  if (mimeType.includes('mp4')) return 'mp4';
  if (mimeType.includes('webm')) return 'webm';
  return 'webm';
}

function logSoftcopyUploadFailure(step, error, extra = {}) {
  const message = error?.message || String(error);
  console.warn('[softcopy] upload failed', {
    step,
    message,
    code: error?.code || null,
    status: error?.status || error?.statusCode || null,
    details: error?.details || error?.hint || null,
    ...sanitizeDiagnosticForConsole(extra),
  });
}

export async function createSoftcopySession({
  sessionToken,
  photoPath,
  gifPath,
  videoPath = null,
}) {
  assertSupabaseReady();

  const { data, error } = await supabase
    .rpc('create_softcopy_session', {
      p_session_token: sessionToken,
      p_photo_path: photoPath,
      p_gif_path: gifPath,
      p_video_path: videoPath,
    })
    .single();

  if (error) {
    const diagnostic = {
      step: 'create_softcopy_session',
      bucket: SOFTCOPY_BUCKET,
      sessionToken,
      photoPath,
      gifPath,
      videoPath,
      error: describeSupabaseError(error),
      code: error.code || error.error || null,
      message: error.message || String(error),
      httpStatus: error.status || error.statusCode || null,
      stack: error.stack || null,
    };
    logSoftcopyDiagnostic('[softcopy-diagnostic] session RPC failed', diagnostic);
    throw createDiagnosticError(`Supabase session record creation failed: ${diagnostic.message}`, diagnostic, error);
  }

  const expiresAt = data?.expires_at;
  const uploadedAt = data?.uploaded_at || data?.created_at || null;
  const createdAt = data?.created_at || null;
  const expiresAtDate = new Date(expiresAt);

  if (!expiresAt || Number.isNaN(expiresAtDate.getTime())) {
    throw new Error('Supabase did not return a valid softcopy expiry');
  }

  console.log('[softcopy] session record saved', {
    token: maskToken(sessionToken),
    photoPath: maskStoragePath(photoPath),
    gifPath: maskStoragePath(gifPath),
    videoPath: maskStoragePath(videoPath),
    expiresAt,
    uploadedAt,
    createdAt,
    expirationSource: 'supabase server uploaded_at + 6 hours',
  });

  return {
    sessionToken,
    expiresAt,
    uploadedAt,
    createdAt,
  };
}

export function buildSoftcopyPageUrl(sessionToken) {
  assertSupabaseReady();
  if (!SOFTCOPY_PAGE_BASE_URL) {
    throw new Error('VITE_SOFTCOPY_PAGE_BASE_URL is not configured');
  }
  const qrUrl = `${SOFTCOPY_PAGE_BASE_URL.replace(/\/+$/, '')}?token=${encodeURIComponent(sessionToken)}`;
  return qrUrl;
}

export async function uploadSoftcopyAssets({
  photoDataUrl = null,
  gifBlob = null,
  videoBlob = null,
  videoMimeType = '',
  videoExtension = '',
  photoContentType = 'image/jpeg',
  sessionToken = null,
  existingPaths = {},
  enabled = {
    photo: true,
    gif: true,
    video: true,
  },
}) {
  assertSupabaseReady();
  timeStart('[softcopy] upload total');
  timeStart('[softcopy] total upload');
  let uploadTotalEnded = false;
  const endUploadTotal = () => {
    if (uploadTotalEnded) return;
    uploadTotalEnded = true;
    timeEnd('[softcopy] upload total');
    timeEnd('[softcopy] total upload');
  };

  const resolvedSessionToken = sessionToken || createSoftcopySessionToken();
  const photoEnabled = enabled?.photo !== false;
  const gifEnabled = enabled?.gif !== false;
  const videoEnabled = enabled?.video !== false;
  const photoExtension = photoContentType === 'image/png' ? 'png' : 'jpg';
  const photoBlob = photoEnabled && photoDataUrl ? dataUrlToBlob(photoDataUrl) : null;

  const photoPath = photoBlob ? `sessions/${resolvedSessionToken}/photo.${photoExtension}` : null;
  const gifPath = gifEnabled && gifBlob ? `sessions/${resolvedSessionToken}/animation.gif` : null;
  const resolvedVideoMimeType = videoMimeType || videoBlob?.type || '';
  const resolvedVideoExtension = videoExtension || getVideoExtension(resolvedVideoMimeType);
  const videoPath = videoEnabled && videoBlob
    ? `sessions/${resolvedSessionToken}/video.${resolvedVideoExtension}`
    : null;
  const totalSize = (photoBlob?.size || 0)
    + (gifPath ? (gifBlob?.size || 0) : 0)
    + (videoPath ? (videoBlob?.size || 0) : 0);
  const uploadErrors = [];
  const warnings = [];

  if (!photoPath && !gifPath && !videoPath) {
    endUploadTotal();
    throw new Error('No softcopy media enabled');
  }

  if (IS_DEV) {
    console.log('[softcopy] skipped disabled media', {
      photoEnabled,
      gifEnabled,
      videoEnabled,
    });
    console.log('[softcopy] uploading enabled media', {
      photo: photoEnabled && Boolean(photoBlob),
      gif: gifEnabled && Boolean(gifBlob),
      video: videoEnabled && Boolean(videoBlob),
    });
  }
  console.log('[softcopy] file sizes', {
    photoSize: photoBlob?.size || 0,
    gifSize: gifPath ? (gifBlob?.size || 0) : 0,
    videoSize: videoPath ? (videoBlob?.size || 0) : 0,
    totalSize,
    totalSizeMb: Number((totalSize / 1024 / 1024).toFixed(2)),
  });
  if (totalSize > MAX_RECOMMENDED_SESSION_UPLOAD_BYTES) {
    console.warn('[softcopy] session upload is large for Supabase Free plan', {
      totalSizeMb: Number((totalSize / 1024 / 1024).toFixed(2)),
      recommendedMaxMb: MAX_RECOMMENDED_SESSION_UPLOAD_MB,
    });
  }
  if (gifPath && gifBlob?.size > MAX_RECOMMENDED_GIF_BYTES) {
    console.warn('[softcopy] GIF upload is large for Supabase Free plan', {
      gifSizeMb: Number((gifBlob.size / 1024 / 1024).toFixed(2)),
      recommendedMaxMb: MAX_RECOMMENDED_GIF_MB,
    });
  }
  if (videoPath && videoBlob?.size > MAX_RECOMMENDED_VIDEO_BYTES) {
    console.warn('[softcopy] video upload is large for Supabase Free plan', {
      videoSizeMb: Number((videoBlob.size / 1024 / 1024).toFixed(2)),
      recommendedMaxMb: MAX_RECOMMENDED_VIDEO_MB,
    });
  }

  const successfulOutputs = {
    photoPath: null,
    gifPath: null,
    videoPath: null,
  };

  const uploadTask = async (step, blob, filePath, contentType, timerLabel) => {
    if (!blob || !filePath) return null;
    if (existingPaths?.[`${step}Path`] === filePath) {
      if (IS_DEV) console.log('[softcopy] upload skipped; existing path reused', { step, path: filePath });
      return { step, filePath };
    }
    timeStart(timerLabel);
    try {
      await uploadBlobToStorage(blob, filePath, contentType, {
        sessionToken: resolvedSessionToken,
        fileLabel: step,
      });
      return { step, filePath };
    } catch (error) {
      logSoftcopyUploadFailure(step, error, {
        enabledOutputs: { photo: photoEnabled, gif: gifEnabled, video: videoEnabled },
        hasPhoto: Boolean(photoBlob),
        hasGif: Boolean(gifBlob),
        hasVideo: Boolean(videoBlob),
        token: resolvedSessionToken,
        diagnostics: getErrorDiagnostics(error),
      });
      uploadErrors.push({ step, error });
      return null;
    } finally {
      timeEnd(timerLabel);
    }
  };

  const uploadResults = [];
  uploadResults.push(await uploadTask('photo', photoBlob, photoPath, photoContentType, '[softcopy] photo upload'));
  uploadResults.push(await uploadTask('gif', gifBlob, gifPath, 'image/gif', '[softcopy] gif upload'));
  if (videoBlob && videoPath && IS_DEV) {
    console.log('[softcopy] uploading final composited video', {
      size: videoBlob.size,
      mimeType: resolvedVideoMimeType,
      extension: resolvedVideoExtension,
    });
  }
  uploadResults.push(await uploadTask('video', videoBlob, videoPath, resolvedVideoMimeType || 'video/webm', '[softcopy] video upload'));

  for (const result of uploadResults) {
    if (!result) continue;
    if (result.step === 'photo') successfulOutputs.photoPath = result.filePath;
    if (result.step === 'gif') successfulOutputs.gifPath = result.filePath;
    if (result.step === 'video') successfulOutputs.videoPath = result.filePath;
  }

  if (!successfulOutputs.photoPath && !successfulOutputs.gifPath && !successfulOutputs.videoPath) {
    const firstError = uploadErrors[0]?.error;
    if (firstError) {
      logSoftcopyUploadFailure('all-enabled-uploads', firstError, {
        enabledOutputs: { photo: photoEnabled, gif: gifEnabled, video: videoEnabled },
        hasPhoto: Boolean(photoBlob),
        hasGif: Boolean(gifBlob),
        hasVideo: Boolean(videoBlob),
        token: resolvedSessionToken,
      });
    }
    endUploadTotal();
    throw firstError || new Error('Softcopy upload failed');
  }

  let session;
  try {
    session = await createSoftcopySession({
      sessionToken: resolvedSessionToken,
      photoPath: successfulOutputs.photoPath,
      gifPath: successfulOutputs.gifPath,
      videoPath: successfulOutputs.videoPath,
    });
  } catch (error) {
    error.successfulOutputs = { ...successfulOutputs };
    logSoftcopyUploadFailure('session', error, {
      enabledOutputs: { photo: photoEnabled, gif: gifEnabled, video: videoEnabled },
      hasPhoto: Boolean(photoBlob),
      hasGif: Boolean(gifBlob),
      hasVideo: Boolean(videoBlob),
      token: resolvedSessionToken,
    });
    endUploadTotal();
    throw error;
  }

  if (uploadErrors.length > 0) {
    warnings.push(...uploadErrors.map(({ step, error }) => `${step} upload failed: ${error?.message || String(error)}`));
  }

  try {
    return {
      sessionToken: resolvedSessionToken,
      photoPath: successfulOutputs.photoPath,
      gifPath: successfulOutputs.gifPath,
      videoPath: successfulOutputs.videoPath,
      videoMimeType: successfulOutputs.videoPath ? resolvedVideoMimeType : null,
      expiresAt: session.expiresAt,
      uploadedAt: session.uploadedAt,
      createdAt: session.createdAt,
      bucket: SOFTCOPY_BUCKET,
      qrUrl: buildSoftcopyPageUrl(resolvedSessionToken),
      warnings,
      partial: uploadErrors.length > 0,
    };
  } finally {
    endUploadTotal();
  }
}
