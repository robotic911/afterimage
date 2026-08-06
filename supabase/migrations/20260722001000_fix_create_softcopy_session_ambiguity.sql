-- Fix PL/pgSQL ambiguity in public.create_softcopy_session.
--
-- The function returns a table with an output column named session_token.
-- In PL/pgSQL those output columns are variables, so unqualified references
-- to session_token can collide with public.softcopy_sessions.session_token.

create or replace function public.create_softcopy_session(
  p_session_token text,
  p_photo_path text default null,
  p_gif_path text default null,
  p_video_path text default null
)
returns table (
  session_token text,
  photo_path text,
  gif_path text,
  video_path text,
  uploaded_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz,
  cleanup_status text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_token text := nullif(trim(p_session_token), '');
  v_photo_path text := nullif(trim(p_photo_path), '');
  v_gif_path text := nullif(trim(p_gif_path), '');
  v_video_path text := nullif(trim(p_video_path), '');
begin
  if v_session_token is null then
    raise exception 'missing session token' using errcode = '22023';
  end if;

  return query
  update public.softcopy_sessions as target
  set photo_path = v_photo_path,
      gif_path = v_gif_path,
      video_path = v_video_path,
      uploaded_at = now(),
      expires_at = now() + interval '6 hours',
      cleanup_status = 'pending',
      deleted_at = null,
      cleanup_attempted_at = null,
      cleanup_completed_at = null,
      cleanup_error = null
  where target.session_token = v_session_token
  returning
    target.session_token,
    target.photo_path,
    target.gif_path,
    target.video_path,
    target.uploaded_at,
    target.expires_at,
    target.created_at,
    target.cleanup_status;

  if found then
    return;
  end if;

  begin
    return query
    insert into public.softcopy_sessions as inserted (
      session_token,
      photo_path,
      gif_path,
      video_path,
      uploaded_at,
      expires_at,
      cleanup_status,
      deleted_at,
      cleanup_attempted_at,
      cleanup_completed_at,
      cleanup_error
    )
    values (
      v_session_token,
      v_photo_path,
      v_gif_path,
      v_video_path,
      now(),
      now() + interval '6 hours',
      'pending',
      null,
      null,
      null,
      null
    )
    returning
      inserted.session_token,
      inserted.photo_path,
      inserted.gif_path,
      inserted.video_path,
      inserted.uploaded_at,
      inserted.expires_at,
      inserted.created_at,
      inserted.cleanup_status;

    return;
  exception
    when unique_violation then
      return query
      update public.softcopy_sessions as target
      set photo_path = v_photo_path,
          gif_path = v_gif_path,
          video_path = v_video_path,
          uploaded_at = now(),
          expires_at = now() + interval '6 hours',
          cleanup_status = 'pending',
          deleted_at = null,
          cleanup_attempted_at = null,
          cleanup_completed_at = null,
          cleanup_error = null
      where target.session_token = v_session_token
      returning
        target.session_token,
        target.photo_path,
        target.gif_path,
        target.video_path,
        target.uploaded_at,
        target.expires_at,
        target.created_at,
        target.cleanup_status;

      if found then
        return;
      end if;

      raise;
  end;
end;
$$;

revoke all on function public.create_softcopy_session(text, text, text, text) from public;
grant execute on function public.create_softcopy_session(text, text, text, text) to anon, authenticated, service_role;
