create table if not exists public.user_tokens (
  id text primary key,
  user_id text not null references public.profiles(id) on delete cascade,
  token_hash text not null unique,
  label text not null default 'Anki Add-on',
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

create index if not exists user_tokens_user_id_idx on public.user_tokens (user_id);

alter table public.user_tokens enable row level security;

create policy "tokens read own" on public.user_tokens for select using (auth.uid()::text = user_id);
create policy "tokens insert own" on public.user_tokens for insert with check (auth.uid()::text = user_id);
create policy "tokens delete own" on public.user_tokens for delete using (auth.uid()::text = user_id);
