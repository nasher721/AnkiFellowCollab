-- Comments (threaded on suggestions)
create table if not exists public.comments (
  id text primary key,
  suggestion_id text not null references public.suggestions(id) on delete cascade,
  deck_id text not null references public.decks(id) on delete cascade,
  author_id text not null references public.profiles(id) on delete cascade,
  author_name text not null,
  body text not null,
  parent_id text references public.comments(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);

create index if not exists comments_suggestion_id_idx on public.comments (suggestion_id, created_at);

-- Reactions on suggestions
create table if not exists public.reactions (
  id text primary key,
  suggestion_id text not null references public.suggestions(id) on delete cascade,
  user_id text not null references public.profiles(id) on delete cascade,
  emoji text not null check (emoji in ('👍', '❓', '✅')),
  created_at timestamptz not null default now(),
  unique (suggestion_id, user_id, emoji)
);

create index if not exists reactions_suggestion_id_idx on public.reactions (suggestion_id);

-- In-app notifications
create table if not exists public.notifications (
  id text primary key,
  user_id text not null references public.profiles(id) on delete cascade,
  deck_id text references public.decks(id) on delete cascade,
  kind text not null,   -- 'suggestion', 'decision', 'comment', 'reaction'
  body text not null,
  ref_id text,          -- suggestion_id or comment_id
  read boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists notifications_user_id_read_idx on public.notifications (user_id, read, created_at desc);

-- Expanded roles (viewer/reviewer/contributor in addition to owner/editor)
alter table public.deck_members
  drop constraint if exists deck_members_role_check;

alter table public.deck_members
  add constraint deck_members_role_check
  check (role in ('owner', 'editor', 'reviewer', 'contributor', 'viewer'));

-- Enable RLS
alter table public.comments enable row level security;
alter table public.reactions enable row level security;
alter table public.notifications enable row level security;

-- RLS policies
create policy "comments read member" on public.comments for select using (
  exists (select 1 from public.deck_members m where m.deck_id = comments.deck_id and m.user_id = auth.uid()::text)
);
create policy "comments insert member" on public.comments for insert with check (
  auth.uid()::text = author_id
  and exists (select 1 from public.deck_members m where m.deck_id = comments.deck_id and m.user_id = auth.uid()::text)
);

create policy "reactions read member" on public.reactions for select using (
  exists (
    select 1 from public.suggestions s
    join public.deck_members m on m.deck_id = s.deck_id
    where s.id = reactions.suggestion_id and m.user_id = auth.uid()::text
  )
);
create policy "reactions insert own" on public.reactions for insert with check (auth.uid()::text = user_id);
create policy "reactions delete own" on public.reactions for delete using (auth.uid()::text = user_id);

create policy "notifications read own" on public.notifications for select using (auth.uid()::text = user_id);
create policy "notifications update own" on public.notifications for update using (auth.uid()::text = user_id);
