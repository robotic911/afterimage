-- Harden softcopy expiration and cleanup scheduling.
--
-- Required Supabase Vault secrets for the cron invoker:
--   project_url = https://<project-ref>.supabase.co
--   cleanup_softcopies_secret = same value as CLEANUP_SOFTCOPIES_SECRET
--
-- Optional override:
--   cleanup_softcopies_url = full cleanup Edge Function URL

create extension if not exists pg_cron;
create extension if not exists pg_net;
create extension if not exists supabase_vault with schema vault;

alter table public.softcopy_sessions
add column if not exists uploaded_at timestamptz,
add column if not exists cleanup_attempted_at timestamptz,
add column if not exists cleanup_completed_at timestamptz,
add column if not exists cleanup_error text;

update public.softcopy_sessions
set uploaded_at = coalesce(uploaded_at, created_at, now())
where uploaded_at is null;

update public.softcopy_sessions
set cleanup_status = 'pending'
where cleanup_status not in ('pending', 'running', 'completed', 'failed');

update public.softcopy_sessions
set expires_at = uploaded_at + interval '6 hours'
where deleted_at is null
  and cleanup_status <> 'completed';

alter table public.softcopy_sessions
alter column uploaded_at set default now(),
alter column uploaded_at set not null,
alter column cleanup_status set default 'pending';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'softcopy_sessions_cleanup_status_check'
      and conrelid = 'public.softcopy_sessions'::regclass
  ) then
    alter table public.softcopy_sessions
    add constraint softcopy_sessions_cleanup_status_check
    check (cleanup_status in ('pending', 'running', 'completed', 'failed'));
  end if;
end $$;

create index if not exists softcopy_sessions_cleanup_status_idx
on public.softcopy_sessions (cleanup_status, expires_at)
where deleted_at is null;

create or replace function public.set_softcopy_session_expiration()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.cleanup_status is null then
    new.cleanup_status = 'pending';
  end if;

  if tg_op = 'INSERT' then
    new.uploaded_at = coalesce(new.uploaded_at, new.created_at, now());
    new.expires_at = new.uploaded_at + interval '6 hours';
  elsif new.uploaded_at is distinct from old.uploaded_at then
    new.uploaded_at = coalesce(new.uploaded_at, now());
    new.expires_at = new.uploaded_at + interval '6 hours';
  elsif new.expires_at is null then
    new.expires_at = coalesce(new.uploaded_at, new.created_at, now()) + interval '6 hours';
  end if;

  return new;
end;
$$;

drop trigger if exists set_softcopy_session_expiration on public.softcopy_sessions;
create trigger set_softcopy_session_expiration
before insert or update of uploaded_at, expires_at, cleanup_status
on public.softcopy_sessions
for each row
execute function public.set_softcopy_session_expiration();

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
begin
  if nullif(trim(p_session_token), '') is null then
    raise exception 'missing session token' using errcode = '22023';
  end if;

  return query
  insert into public.softcopy_sessions as ss (
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
    trim(p_session_token),
    nullif(trim(p_photo_path), ''),
    nullif(trim(p_gif_path), ''),
    nullif(trim(p_video_path), ''),
    now(),
    now() + interval '6 hours',
    'pending',
    null,
    null,
    null,
    null
  )
  on conflict (session_token) do update
  set photo_path = excluded.photo_path,
      gif_path = excluded.gif_path,
      video_path = excluded.video_path,
      uploaded_at = now(),
      expires_at = now() + interval '6 hours',
      cleanup_status = 'pending',
      deleted_at = null,
      cleanup_attempted_at = null,
      cleanup_completed_at = null,
      cleanup_error = null
  returning
    ss.session_token,
    ss.photo_path,
    ss.gif_path,
    ss.video_path,
    ss.uploaded_at,
    ss.expires_at,
    ss.created_at,
    ss.cleanup_status;
end;
$$;

revoke all on function public.create_softcopy_session(text, text, text, text) from public;
grant execute on function public.create_softcopy_session(text, text, text, text) to anon, authenticated, service_role;

create or replace function public.invoke_softcopy_cleanup()
returns bigint
language plpgsql
security definer
set search_path = public, vault, net
as $$
declare
  cleanup_url text;
  cleanup_secret text;
  request_id bigint;
begin
  select decrypted_secret
  into cleanup_url
  from vault.decrypted_secrets
  where name = 'cleanup_softcopies_url'
  order by updated_at desc
  limit 1;

  if nullif(cleanup_url, '') is null then
    select rtrim(decrypted_secret, '/') || '/functions/v1/cleanup-softcopies'
    into cleanup_url
    from vault.decrypted_secrets
    where name = 'project_url'
    order by updated_at desc
    limit 1;
  end if;

  select decrypted_secret
  into cleanup_secret
  from vault.decrypted_secrets
  where name = 'cleanup_softcopies_secret'
  order by updated_at desc
  limit 1;

  if nullif(cleanup_url, '') is null or nullif(cleanup_secret, '') is null then
    raise warning 'softcopy cleanup cron skipped: missing Vault secret cleanup_softcopies_url/project_url or cleanup_softcopies_secret';
    return null;
  end if;

  select net.http_post(
    url := cleanup_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || cleanup_secret
    ),
    body := jsonb_build_object(
      'source', 'pg_cron',
      'scheduled_at', now()
    ),
    timeout_milliseconds := 30000
  )
  into request_id;

  return request_id;
end;
$$;

revoke all on function public.invoke_softcopy_cleanup() from public;
grant execute on function public.invoke_softcopy_cleanup() to postgres, service_role;

do $$
begin
  if exists (
    select 1
    from cron.job
    where jobname = 'cleanup-softcopies-every-minute'
  ) then
    perform cron.unschedule('cleanup-softcopies-every-minute');
  end if;

  perform cron.schedule(
    'cleanup-softcopies-every-minute',
    '* * * * *',
    'select public.invoke_softcopy_cleanup();'
  );
end $$;
