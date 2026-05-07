create table if not exists public.study_sessions (
  id text primary key,
  user_id text not null references public.profiles(id) on delete cascade,
  deck_id text not null references public.decks(id) on delete cascade,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  duration_seconds int not null default 0 check (duration_seconds >= 0),
  cards_studied int not null default 0 check (cards_studied >= 0),
  cards_correct int not null default 0 check (cards_correct >= 0),
  new_cards int not null default 0 check (new_cards >= 0),
  review_cards int not null default 0 check (review_cards >= 0),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists study_sessions_user_deck_started_idx
  on public.study_sessions (user_id, deck_id, started_at desc);

create table if not exists public.deck_share_links (
  id text primary key,
  deck_id text not null references public.decks(id) on delete cascade,
  created_by text not null references public.profiles(id) on delete cascade,
  token text not null unique,
  label text not null default 'Share link',
  password_hash text,
  expires_at timestamptz,
  disabled_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists deck_share_links_deck_created_idx
  on public.deck_share_links (deck_id, created_at desc);

alter table public.study_sessions enable row level security;
alter table public.deck_share_links enable row level security;

create policy "study sessions read own" on public.study_sessions
  for select using (auth.uid()::text = user_id);

create policy "study sessions insert own" on public.study_sessions
  for insert with check (
    auth.uid()::text = user_id
    and exists (
      select 1 from public.deck_members m
      where m.deck_id = study_sessions.deck_id
        and m.user_id = auth.uid()::text
    )
  );

create policy "share links read deck owner" on public.deck_share_links
  for select using (
    exists (
      select 1 from public.deck_members m
      where m.deck_id = deck_share_links.deck_id
        and m.user_id = auth.uid()::text
        and m.role = 'owner'
    )
  );

create policy "share links insert deck owner" on public.deck_share_links
  for insert with check (
    auth.uid()::text = created_by
    and exists (
      select 1 from public.deck_members m
      where m.deck_id = deck_share_links.deck_id
        and m.user_id = auth.uid()::text
        and m.role = 'owner'
    )
  );
