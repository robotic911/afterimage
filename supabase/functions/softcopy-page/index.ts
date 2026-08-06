import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const SOFTCOPY_BUCKET = Deno.env.get('SOFTCOPY_BUCKET') || 'softcopies';
const SIGNED_URL_EXPIRES_IN = 6 * 60 * 60;

const jsonHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'no-store',
};

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: jsonHeaders,
  });
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function maskToken(value: string | null | undefined) {
  const text = String(value || '');
  if (!text) return null;
  if (text.length <= 12) return `${text.slice(0, 3)}...`;
  return `${text.slice(0, 8)}...${text.slice(-4)}`;
}

function maskStoragePath(value: string | null | undefined) {
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

function getVideoMimeType(path = '') {
  const lowerPath = path.toLowerCase();
  if (lowerPath.endsWith('.mp4')) return 'video/mp4';
  if (lowerPath.endsWith('.webm')) return 'video/webm';
  return 'application/octet-stream';
}

function getVideoDownloadName(path = '') {
  const lowerPath = path.toLowerCase();
  if (lowerPath.endsWith('.mp4')) return 'afterimage-video.mp4';
  if (lowerPath.endsWith('.webm')) return 'afterimage-video.webm';
  return 'afterimage-video';
}

function normalizeStoredPath(sessionToken: string, rawPath: string | null | undefined, fallbackName: string) {
  const path = String(rawPath || '').trim();
  if (!path) return null;
  if (/^https?:\/\//i.test(path)) return path;
  if (path.startsWith('/')) return path.slice(1);
  if (path.startsWith(`${SOFTCOPY_BUCKET}/`)) return path.slice(SOFTCOPY_BUCKET.length + 1);
  if (path.startsWith('sessions/')) return path;
  if (path.includes('/')) return path;
  return `sessions/${sessionToken}/${fallbackName || path}`;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        ...jsonHeaders,
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
      },
    });
  }

  try {
    const url = new URL(req.url);
    const token = url.searchParams.get('token') || '';

    if (!token) {
      return jsonResponse({ ok: false, error: 'missing_token' }, 400);
    }

    const { data: session, error } = await supabase
      .from('softcopy_sessions')
      .select('session_token, photo_path, gif_path, video_path, expires_at, deleted_at, cleanup_status')
      .eq('session_token', token)
      .maybeSingle();

    if (error) throw error;
    if (!session || (!session.photo_path && !session.gif_path && !session.video_path)) {
      return jsonResponse({ ok: false, error: 'not_found' }, 404);
    }

    const expiresAt = new Date(session.expires_at);
    if (
      session.deleted_at
      || session.cleanup_status === 'completed'
      || Number.isNaN(expiresAt.getTime())
      || Date.now() > expiresAt.getTime()
    ) {
      return jsonResponse({ ok: false, error: 'expired' }, 410);
    }

    const signedUrlTtl = Math.max(
      60,
      Math.min(SIGNED_URL_EXPIRES_IN, Math.floor((expiresAt.getTime() - Date.now()) / 1000)),
    );
    const photoPath = normalizeStoredPath(session.session_token, session.photo_path, 'photo.jpg');
    const gifPath = normalizeStoredPath(session.session_token, session.gif_path, 'animation.gif');
    const videoPath = normalizeStoredPath(session.session_token, session.video_path, 'video.mp4');
    console.log('[softcopy-page] resolved paths', {
      sessionToken: maskToken(session.session_token),
      photoPath: maskStoragePath(photoPath),
      gifPath: maskStoragePath(gifPath),
      videoPath: maskStoragePath(videoPath),
      signedUrlTtl,
    });

    let photoUrl = null;
    if (photoPath) {
      if (/^https?:\/\//i.test(photoPath)) {
        photoUrl = photoPath;
      } else {
        const { data: photoSigned, error: photoError } = await supabase.storage
          .from(SOFTCOPY_BUCKET)
          .createSignedUrl(photoPath, signedUrlTtl, { download: 'afterimage-photo.jpg' });
        if (photoError) {
          console.error('[softcopy-page] signed URL failed', {
            kind: 'photo',
            bucket: SOFTCOPY_BUCKET,
            error: getErrorMessage(photoError),
          });
          throw photoError;
        }
        photoUrl = photoSigned?.signedUrl || null;
      }
    }

    let gifUrl = null;
    if (gifPath) {
      if (/^https?:\/\//i.test(gifPath)) {
        gifUrl = gifPath;
      } else {
        const { data: gifSigned, error: gifError } = await supabase.storage
          .from(SOFTCOPY_BUCKET)
          .createSignedUrl(gifPath, signedUrlTtl, { download: 'afterimage-animation.gif' });
        if (gifError) {
          console.error('[softcopy-page] signed URL failed', {
            kind: 'gif',
            bucket: SOFTCOPY_BUCKET,
            error: getErrorMessage(gifError),
          });
          throw gifError;
        }
        gifUrl = gifSigned?.signedUrl || null;
      }
    }

    let videoUrl = null;
    let videoMimeType = null;
    if (videoPath) {
      videoMimeType = getVideoMimeType(videoPath);
      if (/^https?:\/\//i.test(videoPath)) {
        videoUrl = videoPath;
      } else {
        const { data: videoSigned, error: videoError } = await supabase.storage
          .from(SOFTCOPY_BUCKET)
          .createSignedUrl(videoPath, signedUrlTtl, {
            download: getVideoDownloadName(videoPath),
          });
        if (videoError) {
          console.error('[softcopy-page] signed URL failed', {
            kind: 'video',
            bucket: SOFTCOPY_BUCKET,
            error: getErrorMessage(videoError),
          });
          throw videoError;
        }
        videoUrl = videoSigned?.signedUrl || null;
      }
    }

    return jsonResponse({
      ok: true,
      photoUrl,
      gifUrl,
      videoUrl,
      videoMimeType,
      expiresAt: session.expires_at,
    });
  } catch (err) {
    console.error('[softcopy-page] failed', {
      error: getErrorMessage(err),
    });
    return jsonResponse({ ok: false, error: 'server_error' }, 500);
  }
});
