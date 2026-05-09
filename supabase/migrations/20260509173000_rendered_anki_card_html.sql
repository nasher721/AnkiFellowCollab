alter table public.cards
  add column if not exists rendered_front text,
  add column if not exists rendered_back text;
