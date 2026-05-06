create table if not exists public.profiles (
  id text primary key,
  email text not null,
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.decks (
  id text primary key,
  owner_id text not null references public.profiles(id) on delete cascade,
  owner_name text not null,
  name text not null,
  description text not null default '',
  imported_at timestamptz not null default now(),
  last_synced_at timestamptz,
  media jsonb not null default '{}'::jsonb,
  models jsonb not null default '[]'::jsonb,
  source jsonb not null default '{}'::jsonb
);

create table if not exists public.deck_members (
  deck_id text not null references public.decks(id) on delete cascade,
  user_id text not null references public.profiles(id) on delete cascade,
  role text not null check (role in ('owner', 'editor', 'viewer')),
  created_at timestamptz not null default now(),
  primary key (deck_id, user_id)
);

create table if not exists public.cards (
  id text primary key,
  deck_id text not null references public.decks(id) on delete cascade,
  anki_note_id bigint,
  note_type text not null default 'Basic',
  model_name text not null default 'Basic',
  field_order jsonb not null default '[]'::jsonb,
  fields jsonb not null default '{}'::jsonb,
  tags jsonb not null default '[]'::jsonb,
  due bigint,
  state text not null default 'New',
  modified_at timestamptz not null default now(),
  modified_by text not null default 'Import',
  suspended boolean not null default false,
  media_refs jsonb not null default '[]'::jsonb,
  source_deck_name text,
  source_deck_path text,
  created_at timestamptz not null default now()
);

create table if not exists public.suggestions (
  id text primary key,
  deck_id text not null references public.decks(id) on delete cascade,
  card_id text not null references public.cards(id) on delete cascade,
  author_id text not null references public.profiles(id) on delete cascade,
  author_name text not null,
  status text not null check (status in ('pending', 'accepted', 'rejected', 'revision')),
  reason text not null,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by text,
  proposed_fields jsonb not null default '{}'::jsonb,
  proposed_tags jsonb not null default '[]'::jsonb
);

create table if not exists public.activity (
  id text primary key,
  deck_id text not null references public.decks(id) on delete cascade,
  user_id text references public.profiles(id) on delete set null,
  kind text not null,
  text text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.anki_sync_sessions (
  id text primary key,
  deck_id text not null references public.decks(id) on delete cascade,
  user_id text not null references public.profiles(id) on delete cascade,
  bridge_fingerprint text,
  status text not null default 'disconnected',
  last_seen_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.sync_conflicts (
  id text primary key,
  deck_id text not null references public.decks(id) on delete cascade,
  card_id text not null,
  source text not null,
  detected_at timestamptz not null default now(),
  incoming_fields jsonb not null default '{}'::jsonb,
  local_fields jsonb not null default '{}'::jsonb
);

create index if not exists deck_members_user_id_idx on public.deck_members (user_id, deck_id);
create index if not exists cards_deck_id_created_at_idx on public.cards (deck_id, created_at);
create index if not exists suggestions_deck_id_created_at_idx on public.suggestions (deck_id, created_at desc);
create index if not exists activity_deck_id_created_at_idx on public.activity (deck_id, created_at desc);
create index if not exists sync_conflicts_deck_id_detected_at_idx on public.sync_conflicts (deck_id, detected_at desc);

alter table public.profiles enable row level security;
alter table public.decks enable row level security;
alter table public.deck_members enable row level security;
alter table public.cards enable row level security;
alter table public.suggestions enable row level security;
alter table public.activity enable row level security;
alter table public.anki_sync_sessions enable row level security;
alter table public.sync_conflicts enable row level security;

create policy "profiles read self" on public.profiles for select using (auth.uid()::text = id);
create policy "members read own" on public.deck_members for select using (auth.uid()::text = user_id);
create policy "decks read member" on public.decks for select using (
  exists (select 1 from public.deck_members m where m.deck_id = id and m.user_id = auth.uid()::text)
);
create policy "cards read member" on public.cards for select using (
  exists (select 1 from public.deck_members m where m.deck_id = cards.deck_id and m.user_id = auth.uid()::text)
);
create policy "suggestions read member" on public.suggestions for select using (
  exists (select 1 from public.deck_members m where m.deck_id = suggestions.deck_id and m.user_id = auth.uid()::text)
);
create policy "activity read member" on public.activity for select using (
  exists (select 1 from public.deck_members m where m.deck_id = activity.deck_id and m.user_id = auth.uid()::text)
);
create policy "sessions read member" on public.anki_sync_sessions for select using (
  exists (select 1 from public.deck_members m where m.deck_id = anki_sync_sessions.deck_id and m.user_id = auth.uid()::text)
);
create policy "conflicts read member" on public.sync_conflicts for select using (
  exists (select 1 from public.deck_members m where m.deck_id = sync_conflicts.deck_id and m.user_id = auth.uid()::text)
);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('deckbridge-exports', 'deckbridge-exports', false, 52428800, array['application/octet-stream'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
