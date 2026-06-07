alter table public.softcopy_sessions
add column if not exists video_path text;
