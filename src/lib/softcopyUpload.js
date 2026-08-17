import {
  supabase,
  SOFTCOPY_BUCKET,
  SOFTCOPY_PAGE_BASE_URL,
  SUPABASE_CLIENT_DIAGNOSTICS,
} from './supabaseClient';
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

function getRendererRuntimeDiagnostics(extra = {}) {
  return {
    platform: globalThis.window?.printApi?.platform || globalThis.navigator?.platform || 'unknown',
    isPackaged: globalThis.window?.printApi?.isPackaged ?? null,
    userAgent: globalThis.navigator?.userAgent || null,
    ...extra,
  };
}

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

function emitQrDiagnostic(label, diagnostic, level = 'log') {
  const payload = getRendererRuntimeDiagnostics(diagnostic);
  const logger = console[level] || console.log;
  logger.call(console, label, payload);
  try {
    const logPromise = globalThis.window?.diagApi?.logEvent?.({
      type: label,
      details: payload,
    });
    if (logPromise?.catch) logPromise.catch(() => {});
  } catch {
    // Diagnostics must never interrupt the customer flow.
  }
}

function isExpectedNoSideEffectRpcError(error) {
  const message = String(error?.message || '');
  return error?.code === '22023' && /missing session token/i.test(message);
}

function describeBlob(blob, fallbackMimeType = '') {
  return {
    available: Boolean(blob),
    size: blob?.size || 0,
    mimeType: blob?.type || fallbackMimeType || '',
  };
}

function createProbeResult(stages, fallbackStage = 'qr_diagnostic_probe', fallbackError = null) {
  const failedStageResult = stages.find((stage) => stage?.ok === false) || null;
  const error = failedStageResult?.error || (fallbackError ? describeSupabaseError(fallbackError) : null);
  const message = failedStageResult?.message || error?.message || (fallbackError?.message || null);
  const failedStage = failedStageResult?.step || failedStageResult?.stage || fallbackStage;
  return {
    ok: !failedStageResult,
    failedStage: failedStageResult ? failedStage : null,
    code: failedStageResult ? (error?.code || failedStageResult?.code || null) : null,
    message: failedStageResult ? message : null,
    details: failedStageResult ? (error?.details ?? failedStageResult?.details ?? null) : null,
    hint: failedStageResult ? (error?.hint ?? failedStageResult?.hint ?? null) : null,
    httpStatus: failedStageResult ? (error?.httpStatus ?? failedStageResult?.httpStatus ?? null) : null,
    error: failedStageResult ? message : null,
    failedStageResult,
    stages,
  };
}

function appendProbeStage(stages, step, payload = {}) {
  const stage = {
    step,
    ok: payload.ok === true,
    ...payload,
  };
  stages.push(stage);
  return stage;
}

function getUploadMediaType(fileLabel, contentType = '') {
  if (fileLabel === 'photo') return contentType === 'image/jpeg' ? 'jpg' : 'png';
  if (fileLabel === 'gif') return 'gif';
  if (fileLabel === 'video') return 'video';
  return contentType || 'media';
}

function getSupabaseConfigDiagnostics() {
  return {
    stage1SupabaseClientInitialized: SUPABASE_CLIENT_DIAGNOSTICS.clientInitialized,
    stage2SupabaseUrlExists: SUPABASE_CLIENT_DIAGNOSTICS.hasSupabaseUrl,
    stage3SupabaseAnonKeyExists: SUPABASE_CLIENT_DIAGNOSTICS.hasSupabaseAnonKey,
    anonKeyPresent: SUPABASE_CLIENT_DIAGNOSTICS.anonKeyPresent,
    anonKeyPrefix: SUPABASE_CLIENT_DIAGNOSTICS.anonKeyPrefix,
    stage4BucketName: SUPABASE_CLIENT_DIAGNOSTICS.bucket,
    bucket: SOFTCOPY_BUCKET,
    hasSoftcopyPageBaseUrl: SUPABASE_CLIENT_DIAGNOSTICS.hasSoftcopyPageBaseUrl,
    softcopyPageBaseUrl: SUPABASE_CLIENT_DIAGNOSTICS.softcopyPageBaseUrl,
  };
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

function assertSupabaseReady(step = 'supabase_client') {
  if (!supabase) {
    const diagnostic = {
      step,
      stage: 'stage_1_supabase_client_initialized',
      ...getSupabaseConfigDiagnostics(),
      message: 'Supabase client is not configured',
    };
    emitQrDiagnostic('[QR CONFIG FAILED]', diagnostic, 'error');
    throw createDiagnosticError('Supabase is not configured', diagnostic);
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
  assertSupabaseReady('storage_upload');

  const bucket = SOFTCOPY_BUCKET;
  const uploadContext = {
    mediaType: getUploadMediaType(fileLabel, contentType),
    bucket,
    path: filePath,
    fileLabel,
    sessionToken,
    contentType,
    size: blob?.size || 0,
    mimeType: blob?.type || contentType || '',
  };
  console.log('[softcopy] upload attempt', {
    mediaType: contentType,
    bucket,
    path: maskStoragePath(filePath),
    fileLabel,
    sessionToken: maskToken(sessionToken),
    contentType,
    size: blob?.size || 0,
  });

  emitQrDiagnostic('[QR UPLOAD START]', {
    step: 'storage_upload',
    stage: fileLabel === 'photo'
      ? 'stage_5_png_upload_attempted'
      : fileLabel === 'gif'
        ? 'stage_6_gif_upload_attempted'
        : fileLabel === 'video'
          ? 'stage_7_video_upload_attempted'
          : 'stage_storage_upload_attempted',
    ...uploadContext,
  });

  let uploadRes;
  try {
    uploadRes = await supabase.storage
      .from(SOFTCOPY_BUCKET)
      .upload(filePath, blob, {
        contentType,
        // Session-scoped paths are safe to overwrite on retry so a failed
        // upload can reuse the same blobs without creating duplicates.
        upsert: true,
      });
  } catch (error) {
    const diagnostic = {
      step: 'storage_upload',
      stage: 'storage_upload_exception',
      ...uploadContext,
      error: describeSupabaseError(error),
      code: error?.code || error?.error || null,
      message: error?.message || String(error),
      httpStatus: error?.status || error?.statusCode || null,
      stack: error?.stack || null,
    };
    emitQrDiagnostic('[QR UPLOAD FAILED]', diagnostic, 'error');
    throw createDiagnosticError(`Supabase Storage upload failed for ${fileLabel || filePath}: ${diagnostic.message}`, diagnostic, error);
  }

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
      stage: 'storage_upload_response_error',
      bucket,
      uploadPath: filePath,
      path: filePath,
      fileLabel,
      sessionToken,
      contentType,
      mimeType: blob?.type || contentType || '',
      sizeBytes: blob?.size || 0,
      error: describeSupabaseError(error),
      code: error.code || error.error || null,
      message: error.message || String(error),
      httpStatus: error.status || error.statusCode || null,
      response: compactValue(uploadRes),
      stack: error.stack || null,
    };
    logSoftcopyDiagnostic('[softcopy-diagnostic] storage upload failed', diagnostic);
    emitQrDiagnostic('[QR UPLOAD FAILED]', diagnostic, 'error');
    throw createDiagnosticError(`Supabase Storage upload failed for ${fileLabel || filePath}: ${diagnostic.message}`, diagnostic, error);
  }

  emitQrDiagnostic('[QR UPLOAD OK]', {
    step: 'storage_upload',
    stage: 'storage_upload_success',
    ...uploadContext,
    response: compactValue(uploadRes),
  });

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
  assertSupabaseReady('create_softcopy_session');

  const rpcPayload = {
    p_session_token: sessionToken,
    p_photo_path: photoPath,
    p_gif_path: gifPath,
    p_video_path: videoPath,
  };
  emitQrDiagnostic('[QR SESSION CREATE START]', {
    step: 'create_softcopy_session',
    stage: 'stage_8_database_rpc_session_create_attempted',
    rpcFunctionName: 'create_softcopy_session',
    payloadKeys: Object.keys(rpcPayload),
    sessionToken,
    uploadedFilePaths: {
      photoPath,
      gifPath,
      videoPath,
    },
  });

  let rpcResult;
  try {
    rpcResult = await supabase
      .rpc('create_softcopy_session', rpcPayload)
      .single();
  } catch (error) {
    const diagnostic = {
      step: 'create_softcopy_session',
      stage: 'create_softcopy_session_exception',
      bucket: SOFTCOPY_BUCKET,
      rpcFunctionName: 'create_softcopy_session',
      payloadKeys: Object.keys(rpcPayload),
      sessionToken,
      photoPath,
      gifPath,
      videoPath,
      uploadedFilePaths: {
        photoPath,
        gifPath,
        videoPath,
      },
      error: describeSupabaseError(error),
      code: error?.code || error?.error || null,
      message: error?.message || String(error),
      httpStatus: error?.status || error?.statusCode || null,
      details: compactValue(error?.details || null),
      hint: compactValue(error?.hint || null),
      stack: error?.stack || null,
    };
    emitQrDiagnostic('[QR SESSION CREATE FAILED]', diagnostic, 'error');
    throw createDiagnosticError(`Supabase session record creation failed: ${diagnostic.message}`, diagnostic, error);
  }

  const { data, error } = rpcResult;

  if (error) {
    const diagnostic = {
      step: 'create_softcopy_session',
      stage: 'create_softcopy_session_response_error',
      bucket: SOFTCOPY_BUCKET,
      rpcFunctionName: 'create_softcopy_session',
      payloadKeys: Object.keys(rpcPayload),
      sessionToken,
      photoPath,
      gifPath,
      videoPath,
      uploadedFilePaths: {
        photoPath,
        gifPath,
        videoPath,
      },
      error: describeSupabaseError(error),
      code: error.code || error.error || null,
      message: error.message || String(error),
      httpStatus: error.status || error.statusCode || null,
      details: compactValue(error.details || null),
      hint: compactValue(error.hint || null),
      response: compactValue(rpcResult),
      stack: error.stack || null,
    };
    logSoftcopyDiagnostic('[softcopy-diagnostic] session RPC failed', diagnostic);
    emitQrDiagnostic('[QR SESSION CREATE FAILED]', diagnostic, 'error');
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
  emitQrDiagnostic('[QR SESSION CREATE OK]', {
    step: 'create_softcopy_session',
    stage: 'stage_8_database_rpc_session_created',
    rpcFunctionName: 'create_softcopy_session',
    sessionToken,
    uploadedFilePaths: {
      photoPath,
      gifPath,
      videoPath,
    },
    resultKeys: data && typeof data === 'object' ? Object.keys(data) : [],
    expiresAt,
    uploadedAt,
    createdAt,
  });

  return {
    sessionToken,
    expiresAt,
    uploadedAt,
    createdAt,
  };
}

export function buildSoftcopyPageUrl(sessionToken) {
  assertSupabaseReady('build_softcopy_page_url');
  if (!SOFTCOPY_PAGE_BASE_URL) {
    const diagnostic = {
      step: 'build_softcopy_page_url',
      stage: 'stage_9_softcopy_page_url_failed',
      sessionToken,
      generatedUrl: null,
      urlEmpty: true,
      urlValid: false,
      message: 'VITE_SOFTCOPY_PAGE_BASE_URL is not configured',
      ...getSupabaseConfigDiagnostics(),
    };
    emitQrDiagnostic('[QR URL FAILED]', diagnostic, 'error');
    throw createDiagnosticError('VITE_SOFTCOPY_PAGE_BASE_URL is not configured', diagnostic);
  }
  const qrUrl = `${SOFTCOPY_PAGE_BASE_URL.replace(/\/+$/, '')}?token=${encodeURIComponent(sessionToken)}`;
  try {
    const parsed = new URL(qrUrl);
    emitQrDiagnostic('[QR URL GENERATED]', {
      step: 'build_softcopy_page_url',
      stage: 'stage_9_softcopy_page_url_generated',
      sessionToken,
      generatedUrl: qrUrl,
      urlEmpty: qrUrl.length === 0,
      urlValid: true,
      host: parsed.host,
      qrLibraryReceivesValue: true,
    });
  } catch (error) {
    const diagnostic = {
      step: 'build_softcopy_page_url',
      stage: 'stage_9_softcopy_page_url_failed',
      sessionToken,
      generatedUrl: qrUrl,
      urlEmpty: qrUrl.length === 0,
      urlValid: false,
      qrLibraryReceivesValue: false,
      error: describeSupabaseError(error),
      message: error?.message || String(error),
    };
    emitQrDiagnostic('[QR URL FAILED]', diagnostic, 'error');
    throw createDiagnosticError(`Softcopy QR URL is invalid: ${diagnostic.message}`, diagnostic, error);
  }
  return qrUrl;
}

export async function uploadSoftcopyAssets({
  sessionId = null,
  photoDataUrl = null,
  photoBlob: providedPhotoBlob = null,
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
  assertSupabaseReady('upload_softcopy_assets');
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
  let photoBlob = null;
  if (photoEnabled) {
    if (providedPhotoBlob) {
      photoBlob = providedPhotoBlob;
    } else if (photoDataUrl) {
      try {
        photoBlob = dataUrlToBlob(photoDataUrl);
      } catch (error) {
        const diagnostic = {
          step: 'prepare_photo_upload_blob',
          stage: 'stage_5_png_upload_failed_before_storage',
          sessionId,
          sessionToken: resolvedSessionToken,
          hasPhotoDataUrl: Boolean(photoDataUrl),
          photoDataUrlLength: photoDataUrl?.length || 0,
          error: describeSupabaseError(error),
          message: error?.message || String(error),
        };
        emitQrDiagnostic('[QR UPLOAD FAILED]', diagnostic, 'error');
        throw createDiagnosticError(`PNG upload preparation failed: ${diagnostic.message}`, diagnostic, error);
      }
    }
  }

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

  emitQrDiagnostic('[QR DEBUG] start', {
    step: 'upload_softcopy_assets',
    stage: 'qr_pipeline_start',
    sessionId,
    sessionToken: resolvedSessionToken,
    ...getSupabaseConfigDiagnostics(),
    media: {
      png: describeBlob(photoBlob, photoContentType),
      gif: describeBlob(gifBlob, 'image/gif'),
      video: describeBlob(videoBlob, resolvedVideoMimeType || 'video/webm'),
    },
    uploadPaths: {
      photoPath,
      gifPath,
      videoPath,
    },
    enabled: {
      photo: photoEnabled,
      gif: gifEnabled,
      video: videoEnabled,
    },
  });

  if (!photoPath && !gifPath && !videoPath) {
    emitQrDiagnostic('[QR UPLOAD FAILED]', {
      step: 'upload_softcopy_assets',
      stage: 'no_enabled_media_available_for_upload',
      sessionId,
      sessionToken: resolvedSessionToken,
      media: {
        png: describeBlob(photoBlob, photoContentType),
        gif: describeBlob(gifBlob, 'image/gif'),
        video: describeBlob(videoBlob, resolvedVideoMimeType || 'video/webm'),
      },
      enabled: {
        photo: photoEnabled,
        gif: gifEnabled,
        video: videoEnabled,
      },
      message: 'No softcopy media enabled',
    }, 'error');
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
    const qrUrl = buildSoftcopyPageUrl(resolvedSessionToken);
    emitQrDiagnostic('[QR DEBUG] complete', {
      step: 'upload_softcopy_assets',
      stage: 'stage_10_qr_value_generated',
      sessionId,
      sessionToken: resolvedSessionToken,
      bucket: SOFTCOPY_BUCKET,
      uploadedFilePaths: {
        photoPath: successfulOutputs.photoPath,
        gifPath: successfulOutputs.gifPath,
        videoPath: successfulOutputs.videoPath,
      },
      finalQrUrl: qrUrl,
      qrValueGenerated: Boolean(qrUrl),
      qrLibraryReceivesValue: Boolean(qrUrl),
      warnings,
      partial: uploadErrors.length > 0,
    });
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
      qrUrl,
      warnings,
      partial: uploadErrors.length > 0,
    };
  } finally {
    endUploadTotal();
  }
}

export async function runSoftcopyQrDiagnosticProbe({
  sessionToken = `diagnostic-${Date.now()}`,
  includeRpc = true,
} = {}) {
  const bucket = SOFTCOPY_BUCKET;
  const path = `sessions/${sessionToken}/ping.txt`;
  const stages = [];
  let uploaded = false;
  let result = null;

  emitQrDiagnostic('[QR DIAGNOSTIC START]', {
    step: 'qr_diagnostic_probe',
    sessionToken,
    ...getSupabaseConfigDiagnostics(),
    uploadPath: path,
  });

  try {
    const configStage = appendProbeStage(stages, 'supabase_config', {
      ok: Boolean(supabase)
        && SUPABASE_CLIENT_DIAGNOSTICS.hasSupabaseUrl
        && SUPABASE_CLIENT_DIAGNOSTICS.hasSupabaseAnonKey,
      ...getSupabaseConfigDiagnostics(),
      message: supabase ? null : 'Supabase client is not configured',
    });
    emitQrDiagnostic(
      configStage.ok ? '[QR CONFIG OK]' : '[QR CONFIG FAILED]',
      configStage,
      configStage.ok ? 'log' : 'error',
    );
    if (!configStage.ok) {
      result = createProbeResult(stages);
      return result;
    }

    const bucketStage = appendProbeStage(stages, 'storage_bucket', {
      ok: bucket === 'softcopies',
      bucket,
      expectedBucket: 'softcopies',
      message: bucket === 'softcopies' ? null : `Configured bucket is "${bucket}", expected "softcopies".`,
    });
    emitQrDiagnostic(
      bucketStage.ok ? '[QR BUCKET OK]' : '[QR BUCKET FAILED]',
      bucketStage,
      bucketStage.ok ? 'log' : 'error',
    );
    if (!bucketStage.ok) {
      result = createProbeResult(stages);
      return result;
    }

    const blob = new Blob([`afterimage qr diagnostic ${new Date().toISOString()}\n`], {
      type: 'text/plain',
    });
    const upload = await supabase.storage.from(bucket).upload(path, blob, {
      contentType: 'text/plain',
      upsert: false,
    });
    uploaded = !upload.error;
    const uploadStage = appendProbeStage(stages, 'storage_upload', {
      bucket,
      path,
      size: blob.size,
      mimeType: blob.type,
      ok: !upload.error,
      error: describeSupabaseError(upload.error),
      response: compactValue(upload),
    });
    emitQrDiagnostic(upload.error ? '[QR UPLOAD FAILED]' : '[QR UPLOAD OK]', uploadStage, upload.error ? 'error' : 'log');
    if (upload.error) {
      result = createProbeResult(stages);
      return result;
    }

    const responsePath = upload.data?.path || upload.data?.Key || null;
    const verifyStage = appendProbeStage(stages, 'storage_verify', {
      ok: responsePath === path || String(responsePath || '').endsWith(path),
      bucket,
      path,
      responsePath,
      message: responsePath === path || String(responsePath || '').endsWith(path)
        ? null
        : 'Supabase upload response did not confirm the expected path.',
      response: compactValue(upload.data || null),
    });
    emitQrDiagnostic(
      verifyStage.ok ? '[QR STORAGE VERIFY OK]' : '[QR STORAGE VERIFY FAILED]',
      verifyStage,
      verifyStage.ok ? 'log' : 'error',
    );
    if (!verifyStage.ok) {
      result = createProbeResult(stages);
      return result;
    }

    if (includeRpc) {
      const rpc = await supabase.rpc('create_softcopy_session', {
        p_session_token: '',
        p_photo_path: null,
        p_gif_path: null,
        p_video_path: null,
      });
      const rpcReachable = !rpc.error || isExpectedNoSideEffectRpcError(rpc.error);
      const rpcStage = appendProbeStage(stages, 'rpc_create_session', {
        rpcFunctionName: 'create_softcopy_session',
        payloadKeys: ['p_session_token', 'p_photo_path', 'p_gif_path', 'p_video_path'],
        ok: rpcReachable,
        noSideEffectInputError: isExpectedNoSideEffectRpcError(rpc.error),
        error: describeSupabaseError(rpc.error),
        responseDataPresent: Boolean(rpc.data),
      });
      emitQrDiagnostic(rpcReachable ? '[QR SESSION CREATE OK]' : '[QR SESSION CREATE FAILED]', rpcStage, rpcReachable ? 'log' : 'error');
      if (!rpcReachable) {
        result = createProbeResult(stages);
        return result;
      }
    }

    let generatedUrl = null;
    let urlValid = false;
    let urlError = null;
    try {
      generatedUrl = buildSoftcopyPageUrl(sessionToken);
      new URL(generatedUrl);
      urlValid = true;
    } catch (error) {
      urlError = error;
    }
    const softcopyPageStage = appendProbeStage(stages, 'softcopy_page', {
      ok: urlValid,
      generatedUrl,
      urlEmpty: !generatedUrl,
      urlValid,
      error: describeSupabaseError(urlError),
      message: urlValid ? null : (urlError?.message || 'Softcopy page URL is not valid.'),
    });
    emitQrDiagnostic(
      softcopyPageStage.ok ? '[QR SOFTCOPY PAGE OK]' : '[QR URL FAILED]',
      softcopyPageStage,
      softcopyPageStage.ok ? 'log' : 'error',
    );
    if (!softcopyPageStage.ok) {
      result = createProbeResult(stages);
      return result;
    }

    const qrValueStage = appendProbeStage(stages, 'qr_value', {
      ok: Boolean(generatedUrl),
      generatedUrl,
      qrLibraryReceivesValue: Boolean(generatedUrl),
      message: generatedUrl ? null : 'QR value is empty.',
    });
    emitQrDiagnostic(
      qrValueStage.ok ? '[QR VALUE OK]' : '[QR URL FAILED]',
      qrValueStage,
      qrValueStage.ok ? 'log' : 'error',
    );

    result = createProbeResult(stages);
    return result;
  } catch (error) {
    const nestedDiagnostic = getErrorDiagnostics(error).find((diagnostic) => diagnostic?.step || diagnostic?.stage) || null;
    const failureStage = appendProbeStage(stages, nestedDiagnostic?.step || nestedDiagnostic?.stage || 'qr_diagnostic_probe', {
      ...(nestedDiagnostic || {}),
      bucket,
      path,
      ok: false,
      error: nestedDiagnostic?.error || describeSupabaseError(error),
      message: nestedDiagnostic?.message || error?.message || String(error),
    });
    emitQrDiagnostic('[QR DIAGNOSTIC FAILED]', failureStage, 'error');
    result = createProbeResult(stages, 'qr_diagnostic_probe', error);
    return result;
  } finally {
    if (uploaded) {
      try {
        const removed = await supabase.storage.from(bucket).remove([path]);
        const cleanupStage = appendProbeStage(stages, 'storage_remove', {
          bucket,
          path,
          ok: !removed.error,
          error: describeSupabaseError(removed.error),
          response: compactValue(removed),
        });
        emitQrDiagnostic(removed.error ? '[QR DIAGNOSTIC CLEANUP FAILED]' : '[QR DIAGNOSTIC CLEANUP OK]', cleanupStage, removed.error ? 'error' : 'log');
        if (removed.error && result.ok) {
          result.ok = false;
          result.failedStage = 'storage_remove';
          result.failedStageResult = cleanupStage;
          result.error = cleanupStage.error?.message || 'Diagnostic storage cleanup failed.';
          result.message = result.error;
          result.code = cleanupStage.error?.code || null;
          result.details = cleanupStage.error?.details || null;
          result.hint = cleanupStage.error?.hint || null;
        }
      } catch (error) {
        const cleanupStage = appendProbeStage(stages, 'storage_remove', {
          bucket,
          path,
          ok: false,
          error: describeSupabaseError(error),
          message: error?.message || String(error),
        });
        emitQrDiagnostic('[QR DIAGNOSTIC CLEANUP FAILED]', cleanupStage, 'error');
        if (result.ok) {
          result.ok = false;
          result.failedStage = 'storage_remove';
          result.failedStageResult = cleanupStage;
          result.error = cleanupStage.message;
          result.message = cleanupStage.message;
          result.code = cleanupStage.error?.code || null;
          result.details = cleanupStage.error?.details || null;
          result.hint = cleanupStage.error?.hint || null;
        }
      }
    }
  }
}
