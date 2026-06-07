import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const SOFTCOPY_BUCKET = Deno.env.get('SOFTCOPY_BUCKET') || 'softcopies';
const CLEANUP_SECRET = Deno.env.get('CLEANUP_SOFTCOPIES_SECRET')?.trim() || '';
const CLEANUP_BATCH_SIZE = Number(Deno.env.get('CLEANUP_BATCH_SIZE') || 100);

const jsonHeaders = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
};

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: jsonHeaders,
  });
}

function isAuthorized(req: Request) {
  const authHeader = req.headers.get('Authorization')?.trim() ?? '';
  const expectedAuth = `Bearer ${CLEANUP_SECRET}`;
  return authHeader === expectedAuth;
}

function unauthorizedResponse(req: Request) {
  return jsonResponse({ ok: false, error: 'unauthorized' }, 401);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: jsonHeaders,
    });
  }

  if (!isAuthorized(req)) {
    return unauthorizedResponse(req);
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return jsonResponse({ ok: false, error: 'supabase_not_configured' }, 500);
  }

  const errors: Array<Record<string, unknown>> = [];
  let sessionsDeleted = 0;
  let filesDeleted = 0;

  try {
    const nowIso = new Date().toISOString();
    const { data: sessions, error: queryError } = await supabase
      .from('softcopy_sessions')
      .select('id, session_token, photo_path, gif_path, video_path, expires_at')
      .lt('expires_at', nowIso)
      .order('expires_at', { ascending: true })
      .limit(Number.isFinite(CLEANUP_BATCH_SIZE) && CLEANUP_BATCH_SIZE > 0 ? CLEANUP_BATCH_SIZE : 100);

    if (queryError) throw queryError;

    for (const session of sessions || []) {
      const paths = [session.photo_path, session.gif_path, session.video_path]
        .filter((path): path is string => Boolean(path));

      if (paths.length) {
        const { data: removedFiles, error: removeError } = await supabase.storage
          .from(SOFTCOPY_BUCKET)
          .remove(paths);

        if (removeError) {
          errors.push({
            sessionToken: session.session_token,
            action: 'storage.remove',
            error: removeError.message,
          });
          continue;
        } else {
          filesDeleted += removedFiles?.length || paths.length;
        }
      }

      const { error: deleteError } = await supabase
        .from('softcopy_sessions')
        .delete()
        .eq('id', session.id);

      if (deleteError) {
        errors.push({
          sessionToken: session.session_token,
          action: 'softcopy_sessions.delete',
          error: deleteError.message,
        });
        continue;
      }

      sessionsDeleted += 1;
    }

    console.log('[cleanup-softcopies]', {
      sessionsChecked: sessions?.length || 0,
      sessionsDeleted,
      filesDeleted,
      errors: errors.length,
    });

    return jsonResponse({
      ok: true,
      sessionsChecked: sessions?.length || 0,
      sessionsDeleted,
      filesDeleted,
      errors,
    });
  } catch (err) {
    console.error('[cleanup-softcopies] failed:', err);
    return jsonResponse({
      ok: false,
      sessionsChecked: 0,
      sessionsDeleted,
      filesDeleted,
      errors: [
        ...errors,
        {
          action: 'cleanup',
          error: err instanceof Error ? err.message : String(err),
        },
      ],
    }, 500);
  }
});
