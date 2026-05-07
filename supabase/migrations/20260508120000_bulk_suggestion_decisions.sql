create or replace function public.bulk_decide_suggestions(
  p_deck_id text,
  p_suggestion_ids text[],
  p_decision text,
  p_reviewer_id text,
  p_reviewer_name text,
  p_activity_id text,
  p_reviewed_at timestamptz
)
returns table(id text)
language plpgsql
security definer
set search_path = public
as $$
declare
  selected_count integer;
  pending_count integer;
  updated_count integer;
  selected record;
begin
  if p_decision not in ('accepted', 'rejected', 'revision') then
    raise exception 'invalid_decision';
  end if;

  if coalesce(cardinality(p_suggestion_ids), 0) = 0 then
    raise exception 'missing_suggestion_ids';
  end if;

  if exists (
    select 1
    from unnest(p_suggestion_ids) as ids(suggestion_id)
    where suggestion_id is null
       or btrim(suggestion_id) = ''
  ) then
    raise exception 'invalid_suggestion_id';
  end if;

  if cardinality(p_suggestion_ids) <> (
    select count(distinct suggestion_id)
    from unnest(p_suggestion_ids) as ids(suggestion_id)
  ) then
    raise exception 'duplicate_suggestion_ids';
  end if;

  if not exists (
    select 1
    from public.deck_members
    where deck_id = p_deck_id
      and user_id = p_reviewer_id
      and role in ('owner', 'editor', 'reviewer')
  ) then
    raise exception 'forbidden';
  end if;

  with requested as (
    select suggestion_id, ordinal
    from unnest(p_suggestion_ids) with ordinality as ids(suggestion_id, ordinal)
  ),
  locked as (
    select s.id, s.status
    from requested r
    join public.suggestions s
      on s.id = r.suggestion_id
     and s.deck_id = p_deck_id
    order by r.ordinal
    for update of s
  )
  select count(*), count(*) filter (where status = 'pending')
    into selected_count, pending_count
    from locked;

  if selected_count <> cardinality(p_suggestion_ids) then
    raise exception 'suggestion_not_found';
  end if;

  if pending_count <> selected_count then
    raise exception 'suggestion_reviewed';
  end if;

  if p_decision = 'accepted' then
    for selected in
      with requested as (
        select suggestion_id, ordinal
        from unnest(p_suggestion_ids) with ordinality as ids(suggestion_id, ordinal)
      )
      select s.*
      from requested r
      join public.suggestions s
        on s.id = r.suggestion_id
       and s.deck_id = p_deck_id
      order by r.ordinal
    loop
      update public.cards
      set fields = fields || selected.proposed_fields,
          tags = case
            when jsonb_typeof(selected.proposed_tags) = 'array' then selected.proposed_tags
            else tags
          end,
          modified_at = p_reviewed_at,
          modified_by = p_reviewer_name
      where id = selected.card_id
        and deck_id = p_deck_id;

      if not found then
        raise exception 'card_not_found';
      end if;
    end loop;
  end if;

  update public.suggestions
  set status = p_decision,
      reviewed_at = p_reviewed_at,
      reviewed_by = p_reviewer_name
  where deck_id = p_deck_id
    and status = 'pending'
    and id = any(p_suggestion_ids);

  get diagnostics updated_count = row_count;
  if updated_count <> cardinality(p_suggestion_ids) then
    raise exception 'suggestion_reviewed';
  end if;

  insert into public.activity (id, deck_id, user_id, kind, text, created_at)
  values (
    p_activity_id,
    p_deck_id,
    p_reviewer_id,
    p_decision,
    format('%s %s %s suggestion(s)', p_reviewer_name, p_decision, cardinality(p_suggestion_ids)),
    p_reviewed_at
  );

  return query
    select ordered.suggestion_id
    from unnest(p_suggestion_ids) with ordinality as ordered(suggestion_id, ordinal)
    order by ordered.ordinal;
end;
$$;

-- Server-only RPC: the function trusts reviewer identity supplied by the service-role API server.
revoke all on function public.bulk_decide_suggestions(text, text[], text, text, text, text, timestamptz) from public;
revoke all on function public.bulk_decide_suggestions(text, text[], text, text, text, text, timestamptz) from anon;
revoke all on function public.bulk_decide_suggestions(text, text[], text, text, text, text, timestamptz) from authenticated;
grant execute on function public.bulk_decide_suggestions(text, text[], text, text, text, text, timestamptz) to service_role;
