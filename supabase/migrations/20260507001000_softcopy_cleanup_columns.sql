alter table public.softcopy_sessions
add column if not exists deleted_at timestamptz,
add column if not exists cleanup_status text not null default 'pending';

create index if not exists softcopy_sessions_cleanup_idx
on public.softcopy_sessions (expires_at)
where deleted_at is null;
