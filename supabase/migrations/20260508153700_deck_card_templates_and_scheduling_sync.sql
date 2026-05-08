alter table public.cards
  add column if not exists template_front text,
  add column if not exists template_back text,
  add column if not exists model_css text,
  add column if not exists cloze_ord integer;

create index if not exists cards_deck_model_name_idx
  on public.cards (deck_id, model_name);
