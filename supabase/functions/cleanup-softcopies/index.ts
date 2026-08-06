import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const SOFTCOPY_BUCKET = Deno.env.get('SOFTCOPY_BUCKET') || 'softcopies';
const CLEANUP_SECRET = Deno.env.get('CLEANUP_SOFTCOPIES_SECRET')?.trim() || '';
const CLEANUP_BATCH_SIZE = Number(Deno.env.get('CLEANUP_BATCH_SIZE') || 100);
const SOFTCOPY_EXPIRATION_MS = 6 * 60 * 60 * 1000;
const CLEANUP_RETRY_STATUSES = ['pending', 'failed', 'running'];

const jsonHeaders = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-cleanup-secret, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

type SoftcopySession = {
  id: string;
  session_token: string;
  photo_path: string | null;
  gif_path: string | null;
  video_path: string | null;
  uploaded_at: string | null;
  created_at: string | null;
  expires_at: string;
  cleanup_status: string | null;
};

type StorageListItem = {
  id?: string | null;
  name?: string | null;
  metadata?: Record<string, unknown> | null;
};

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: jsonHeaders,
  });
}

function isAuthorized(req: Request) {
  const authHeader = req.headers.get('Authorization')?.trim() ?? '';
  const cleanupHeader = req.headers.get('x-cleanup-secret')?.trim() ?? '';
  const expectedAuth = `Bearer ${CLEANUP_SECRET}`;
  return authHeader === expectedAuth || cleanupHeader === CLEANUP_SECRET;
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function parseTimeMs(value: string | null | undefined) {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

function formatAge(ms: number) {
  const safeMs = Math.max(0, ms);
  const totalMinutes = Math.floor(safeMs / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
}

function getUploadTimeMs(session: SoftcopySession) {
  return parseTimeMs(session.uploaded_at)
    ?? parseTimeMs(session.created_at)
    ?? ((parseTimeMs(session.expires_at) ?? Date.now()) - SOFTCOPY_EXPIRATION_MS);
}

function normalizeStoragePath(rawPath: string | null | undefined, sessionToken: string, fallbackName: string) {
  const raw = String(rawPath || '').trim();
  if (!raw) return null;

  if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      const marker = `/object/`;
      const markerIndex = url.pathname.indexOf(marker);
      if (markerIndex >= 0) {
        const storagePath = url.pathname.slice(markerIndex + marker.length);
        const bucketPrefix = new RegExp(`^(public|sign|authenticated)/${SOFTCOPY_BUCKET}/`);
        const normalized = decodeURIComponent(storagePath).replace(bucketPrefix, '');
        return normalized.startsWith('sessions/') && !normalized.includes('..') ? normalized : null;
      }
    } catch {
      return null;
    }
    return null;
  }

  let path = raw.replace(/^\/+/, '');
  if (path.startsWith(`${SOFTCOPY_BUCKET}/`)) {
    path = path.slice(SOFTCOPY_BUCKET.length + 1);
  }
  if (!path.startsWith('sessions/')) {
    path = path.includes('/') ? path : `sessions/${sessionToken}/${fallbackName}`;
  }
  if (path.includes('..')) return null;
  return path;
}

function getSessionFolderPrefix(sessionToken: string) {
  const token = String(sessionToken || '').trim();
  if (!/^[A-Za-z0-9_-]+$/.test(token)) return null;
  return `sessions/${token}`;
}

function joinStoragePath(folder: string, name: string) {
  return `${folder.replace(/\/+$/, '')}/${name.replace(/^\/+/, '')}`;
}

function isFolder(item: StorageListItem) {
  return !item.id && !item.metadata;
}

async function listStoragePathsRecursively(folder: string, depth = 0): Promise<string[]> {
  if (depth > 8) {
    throw new Error(`storage folder traversal exceeded depth limit: ${folder}`);
  }

  const { data, error } = await supabase.storage
    .from(SOFTCOPY_BUCKET)
    .list(folder, { limit: 1000, sortBy: { column: 'name', order: 'asc' } });

  if (error) throw error;

  const paths: string[] = [];
  for (const item of (data || []) as StorageListItem[]) {
    const name = String(item.name || '').trim();
    if (!name || name === '.' || name === '..') continue;
    const itemPath = joinStoragePath(folder, name);
    if (isFolder(item)) {
      paths.push(...await listStoragePathsRecursively(itemPath, depth + 1));
    } else {
      paths.push(itemPath);
    }
  }
  return paths;
}

function uniquePaths(paths: Array<string | null | undefined>) {
  return Array.from(new Set(paths.filter((path): path is string => Boolean(path))));
}

async function updateCleanupStatus(
  session: SoftcopySession,
  cleanupStatus: 'running' | 'completed' | 'failed',
  patch: Record<string, string | null>,
) {
  const { error } = await supabase
    .from('softcopy_sessions')
    .update({
      cleanup_status: cleanupStatus,
      ...patch,
    })
    .eq('id', session.id);

  if (error) throw error;
}

async function cleanupSession(session: SoftcopySession) {
  const startedAt = new Date();
  const expiresAtMs = parseTimeMs(session.expires_at);
  const uploadTimeMs = getUploadTimeMs(session);
  const ageMs = Date.now() - uploadTimeMs;
  const expired = expiresAtMs !== null && Date.now() >= expiresAtMs;
  const folderPrefix = getSessionFolderPrefix(session.session_token);

  console.log('[Cleanup]', {
    Session: session.session_token,
    Age: formatAge(ageMs),
    Expired: expired ? 'YES' : 'NO',
    uploaded_at: session.uploaded_at,
    created_at: session.created_at,
    expires_at: session.expires_at,
    cleanup_status: session.cleanup_status || null,
  });

  if (!expired) {
    return { skipped: true, filesDeleted: 0 };
  }

  await updateCleanupStatus(session, 'running', {
    cleanup_attempted_at: startedAt.toISOString(),
    cleanup_completed_at: null,
    cleanup_error: null,
  });
  console.log('[Cleanup] cleanup_status -> running', {
    session: session.session_token,
  });

  const recordedPaths = {
    photo: normalizeStoragePath(session.photo_path, session.session_token, 'photo.jpg'),
    gif: normalizeStoragePath(session.gif_path, session.session_token, 'animation.gif'),
    video: normalizeStoragePath(session.video_path, session.session_token, 'video.mp4'),
  };
  const discoveredPaths = folderPrefix
    ? await listStoragePathsRecursively(folderPrefix)
    : [];
  const pathsToDelete = uniquePaths([
    recordedPaths.photo,
    recordedPaths.gif,
    recordedPaths.video,
    ...discoveredPaths,
  ]);

  console.log('[Cleanup] Deleting', {
    session: session.session_token,
    photo: recordedPaths.photo || 'not-recorded',
    gif: recordedPaths.gif || 'not-recorded',
    video: recordedPaths.video || 'not-recorded',
    discoveredPaths,
    pathsToDelete,
  });

  if (pathsToDelete.length > 0) {
    const { data: removedFiles, error: removeError } = await supabase.storage
      .from(SOFTCOPY_BUCKET)
      .remove(pathsToDelete);

    if (removeError) {
      throw new Error(`storage.remove failed: ${removeError.message}`);
    }

    console.log('[Cleanup] Storage removal: SUCCESS', {
      session: session.session_token,
      requested: pathsToDelete.length,
      removed: removedFiles?.length ?? pathsToDelete.length,
      paths: pathsToDelete,
    });
  } else {
    console.log('[Cleanup] Storage removal: SUCCESS', {
      session: session.session_token,
      requested: 0,
      removed: 0,
      paths: [],
    });
  }

  const remainingPaths = folderPrefix
    ? await listStoragePathsRecursively(folderPrefix)
    : [];
  if (remainingPaths.length > 0) {
    throw new Error(`storage objects remain after cleanup: ${remainingPaths.join(', ')}`);
  }

  const completedAt = new Date().toISOString();
  await updateCleanupStatus(session, 'completed', {
    deleted_at: completedAt,
    cleanup_completed_at: completedAt,
    cleanup_error: null,
  });
  console.log('[Cleanup] cleanup_status -> completed', {
    session: session.session_token,
    deleted_at: completedAt,
  });

  return {
    skipped: false,
    filesDeleted: pathsToDelete.length,
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: jsonHeaders,
    });
  }

  if (!['GET', 'POST'].includes(req.method)) {
    return jsonResponse({ ok: false, error: 'method_not_allowed' }, 405);
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return jsonResponse({ ok: false, error: 'supabase_not_configured' }, 500);
  }

  if (!CLEANUP_SECRET) {
    return jsonResponse({ ok: false, error: 'cleanup_secret_not_configured' }, 500);
  }

  if (!isAuthorized(req)) {
    return jsonResponse({ ok: false, error: 'unauthorized' }, 401);
  }

  const errors: Array<Record<string, unknown>> = [];
  let sessionsCompleted = 0;
  let sessionsSkipped = 0;
  let filesDeleted = 0;

  try {
    const nowIso = new Date().toISOString();
    const { data: sessions, error: queryError } = await supabase
      .from('softcopy_sessions')
      .select('id, session_token, photo_path, gif_path, video_path, uploaded_at, created_at, expires_at, cleanup_status')
      .lte('expires_at', nowIso)
      .is('deleted_at', null)
      .in('cleanup_status', CLEANUP_RETRY_STATUSES)
      .order('expires_at', { ascending: true })
      .limit(Number.isFinite(CLEANUP_BATCH_SIZE) && CLEANUP_BATCH_SIZE > 0 ? CLEANUP_BATCH_SIZE : 100);

    if (queryError) throw queryError;

    for (const session of (sessions || []) as SoftcopySession[]) {
      try {
        const result = await cleanupSession(session);
        if (result.skipped) {
          sessionsSkipped += 1;
        } else {
          sessionsCompleted += 1;
          filesDeleted += result.filesDeleted;
        }
      } catch (error) {
        const message = getErrorMessage(error);
        console.error('[Cleanup] FAILED', {
          session: session.session_token,
          error: message,
        });
        try {
          await updateCleanupStatus(session, 'failed', {
            cleanup_attempted_at: new Date().toISOString(),
            cleanup_error: message,
          });
        } catch (statusError) {
          errors.push({
            sessionToken: session.session_token,
            action: 'cleanup_status.failed',
            error: getErrorMessage(statusError),
          });
        }
        errors.push({
          sessionToken: session.session_token,
          action: 'cleanup',
          error: message,
        });
      }
    }

    console.log('[cleanup-softcopies]', {
      sessionsChecked: sessions?.length || 0,
      sessionsCompleted,
      sessionsSkipped,
      filesDeleted,
      errors: errors.length,
    });

    return jsonResponse({
      ok: errors.length === 0,
      sessionsChecked: sessions?.length || 0,
      sessionsCompleted,
      sessionsSkipped,
      filesDeleted,
      errors,
    }, errors.length === 0 ? 200 : 207);
  } catch (err) {
    console.error('[cleanup-softcopies] failed:', err);
    return jsonResponse({
      ok: false,
      sessionsChecked: 0,
      sessionsCompleted,
      sessionsSkipped,
      filesDeleted,
      errors: [
        ...errors,
        {
          action: 'cleanup',
          error: getErrorMessage(err),
        },
      ],
    }, 500);
  }
});
