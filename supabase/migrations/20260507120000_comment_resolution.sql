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

drop policy if exists "comments update member" on public.comments;

create policy "comments update member" on public.comments for update using (
  exists (select 1 from public.deck_members m where m.deck_id = comments.deck_id and m.user_id = auth.uid()::text)
) with check (
  exists (select 1 from public.deck_members m where m.deck_id = comments.deck_id and m.user_id = auth.uid()::text)
);
