alter table public.user_tokens
  add column if not exists expires_at timestamptz,
  add column if not exists revoked_at timestamptz,
  add column if not exists deck_id text references public.decks(id) on delete cascade,
  add column if not exists token_tail text;

create index if not exists user_tokens_active_idx
  on public.user_tokens (user_id, deck_id, expires_at)
  where revoked_at is null;

create index if not exists user_tokens_token_tail_idx
  on public.user_tokens (token_tail);

revoke insert, update on public.user_tokens from anon, authenticated;
grant select, delete on public.user_tokens to authenticated;

drop policy if exists "tokens read own" on public.user_tokens;
drop policy if exists "tokens insert own" on public.user_tokens;
drop policy if exists "tokens delete own" on public.user_tokens;
drop policy if exists "tokens read own active" on public.user_tokens;
drop policy if exists "tokens delete own active" on public.user_tokens;

create policy "tokens read own active" on public.user_tokens
  for select
  using (
    auth.uid()::text = user_id
    and revoked_at is null
    and (expires_at is null or expires_at > now())
  );

create policy "tokens delete own active" on public.user_tokens
  for delete
  using (
    auth.uid()::text = user_id
    and revoked_at is null
  );
