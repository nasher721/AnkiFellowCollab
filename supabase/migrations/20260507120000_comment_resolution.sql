-- Track resolved comment threads on suggestions.
alter table public.comments
  add column if not exists resolved_at timestamptz,
  add column if not exists resolved_by text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'comments_resolved_by_fkey'
      and conrelid = 'public.comments'::regclass
  ) then
    alter table public.comments
      add constraint comments_resolved_by_fkey
      foreign key (resolved_by) references public.profiles(id) on delete set null;
  end if;
end $$;

create index if not exists comments_resolved_idx
  on public.comments (suggestion_id, resolved_at)
  where resolved_at is not null;

create index if not exists comments_resolved_by_idx
  on public.comments (resolved_by)
  where resolved_by is not null;

create or replace function public.enforce_comment_resolution_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.id is distinct from old.id
    or new.suggestion_id is distinct from old.suggestion_id
    or new.deck_id is distinct from old.deck_id
    or new.author_id is distinct from old.author_id
    or new.author_name is distinct from old.author_name
    or new.body is distinct from old.body
    or new.parent_id is distinct from old.parent_id
    or new.created_at is distinct from old.created_at then
    raise exception 'Only comment resolution fields may be updated'
      using errcode = '42501';
  end if;

  if new.resolved_at is null then
    new.resolved_by := null;
  else
    if auth.uid() is not null then
      new.resolved_by := auth.uid()::text;
    elsif current_setting('request.jwt.claim.role', true) = 'service_role' and new.resolved_by is not null then
      new.resolved_by := new.resolved_by;
    else
      raise exception 'Authenticated user required to resolve comments'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists enforce_comment_resolution_update on public.comments;
create trigger enforce_comment_resolution_update
before update on public.comments
for each row execute function public.enforce_comment_resolution_update();

revoke update on public.comments from anon, authenticated;
grant update (resolved_at, resolved_by, updated_at) on public.comments to authenticated;

drop policy if exists "comments update member" on public.comments;

create policy "comments update member" on public.comments for update using (
  exists (select 1 from public.deck_members m where m.deck_id = comments.deck_id and m.user_id = auth.uid()::text)
) with check (
  exists (select 1 from public.deck_members m where m.deck_id = comments.deck_id and m.user_id = auth.uid()::text)
);
