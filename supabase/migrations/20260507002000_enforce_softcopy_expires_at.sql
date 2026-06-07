update public.softcopy_sessions
set expires_at = coalesce(created_at, now()) + interval '6 hours'
where expires_at is null;

alter table public.softcopy_sessions
alter column expires_at set default (now() + interval '6 hours');

alter table public.softcopy_sessions
alter column expires_at set not null;
