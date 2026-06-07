create table if not exists public.softcopy_sessions (
  id uuid primary key default gen_random_uuid(),
  session_token text not null unique,
  photo_path text,
  gif_path text,
  expires_at timestamptz not null default (now() + interval '6 hours'),
  created_at timestamptz not null default now()
);

alter table public.softcopy_sessions enable row level security;

create policy "anon can create softcopy sessions"
on public.softcopy_sessions
for insert
to anon
with check (true);

insert into storage.buckets (id, name, public)
values ('softcopies', 'softcopies', false)
on conflict (id) do nothing;

create policy "anon can upload softcopy files"
on storage.objects
for insert
to anon
with check (
  bucket_id = 'softcopies'
  and name like 'sessions/%'
);
