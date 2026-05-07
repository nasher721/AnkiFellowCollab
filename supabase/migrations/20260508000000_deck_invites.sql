-- Deck collaboration invites
create table if not exists public.deck_invites (
  id           text primary key,
  deck_id      text not null references public.decks(id) on delete cascade,
  invited_by   text not null references public.profiles(id) on delete cascade,
  email        text not null,
  role         text not null default 'contributor'
               check (role in ('viewer', 'contributor', 'reviewer', 'editor')),
  token        text not null unique,
  status       text not null default 'pending'
               check (status in ('pending', 'accepted', 'declined', 'expired')),
  expires_at   timestamptz,
  created_at   timestamptz not null default now(),
  responded_at timestamptz
);

create index if not exists deck_invites_deck_id_idx on public.deck_invites (deck_id);
create index if not exists deck_invites_token_idx   on public.deck_invites (token);
create index if not exists deck_invites_email_idx   on public.deck_invites (lower(email));

alter table public.deck_invites enable row level security;

-- Deck owners/editors can read invites for their decks
create policy "invites_read_editor" on public.deck_invites for select using (
  exists (
    select 1 from public.deck_members m
    where m.deck_id = deck_invites.deck_id
      and m.user_id = auth.uid()::text
      and m.role in ('owner', 'editor')
  )
);

-- Owners/editors can create invites for their own decks
create policy "invites_insert_editor" on public.deck_invites for insert with check (
  auth.uid()::text = invited_by
  and exists (
    select 1 from public.deck_members m
    where m.deck_id = deck_invites.deck_id
      and m.user_id = auth.uid()::text
      and m.role in ('owner', 'editor')
  )
);

-- Owners can delete (revoke) invites; invitees can update status (accept/decline)
create policy "invites_update_owner_or_invitee" on public.deck_invites for update using (
  auth.uid()::text = invited_by
  or exists (
    select 1 from public.deck_members m
    where m.deck_id = deck_invites.deck_id
      and m.user_id = auth.uid()::text
      and m.role = 'owner'
  )
);

create policy "invites_delete_owner" on public.deck_invites for delete using (
  exists (
    select 1 from public.deck_members m
    where m.deck_id = deck_invites.deck_id
      and m.user_id = auth.uid()::text
      and m.role = 'owner'
  )
);
