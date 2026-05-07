alter table public.decks
  add column if not exists last_sync_result jsonb;
