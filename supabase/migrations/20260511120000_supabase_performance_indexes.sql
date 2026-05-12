-- Speed up DeckBridge's hosted read/write paths without changing table shape.
-- These follow the Supabase/Postgres guidance for hot filter, join, FK, and
-- partial-index patterns used by the API server.

create index if not exists decks_public_download_idx
  on public.decks (visibility, download_count desc, id)
  where visibility = 'public';

create index if not exists decks_public_imported_idx
  on public.decks (visibility, imported_at desc, id)
  where visibility = 'public';

create index if not exists decks_owner_public_imported_idx
  on public.decks (owner_id, imported_at desc)
  where visibility = 'public';

create index if not exists decks_fork_of_idx
  on public.decks (fork_of)
  where fork_of is not null;

create index if not exists cards_deck_anki_note_id_idx
  on public.cards (deck_id, anki_note_id)
  where anki_note_id is not null;

create index if not exists cards_deck_modified_at_idx
  on public.cards (deck_id, modified_at desc);

create index if not exists suggestions_deck_status_created_idx
  on public.suggestions (deck_id, status, created_at desc);

create index if not exists suggestions_card_id_idx
  on public.suggestions (card_id);

create index if not exists suggestions_author_id_idx
  on public.suggestions (author_id, deck_id);

create index if not exists activity_deck_kind_created_idx
  on public.activity (deck_id, kind, created_at desc);

create index if not exists activity_user_id_idx
  on public.activity (user_id)
  where user_id is not null;

create index if not exists anki_sync_sessions_user_deck_idx
  on public.anki_sync_sessions (user_id, deck_id);

create index if not exists comments_deck_suggestion_created_idx
  on public.comments (deck_id, suggestion_id, created_at);

create index if not exists comments_author_id_idx
  on public.comments (author_id);

create index if not exists comments_parent_id_idx
  on public.comments (parent_id)
  where parent_id is not null;

create index if not exists reactions_user_id_idx
  on public.reactions (user_id);

create index if not exists notifications_user_created_idx
  on public.notifications (user_id, created_at desc, id desc);

create index if not exists notifications_deck_id_idx
  on public.notifications (deck_id)
  where deck_id is not null;

create index if not exists deck_stars_user_id_idx
  on public.deck_stars (user_id);

create index if not exists templates_featured_star_idx
  on public.templates (is_featured desc, star_count desc, created_at desc);

create index if not exists templates_author_id_idx
  on public.templates (author_id)
  where author_id is not null;

create index if not exists study_progress_user_deck_updated_idx
  on public.study_progress (user_id, deck_id, updated_at desc);

create index if not exists study_progress_deck_updated_idx
  on public.study_progress (deck_id, updated_at desc);

create index if not exists study_progress_deck_card_idx
  on public.study_progress (deck_id, card_id);

create index if not exists study_sessions_deck_started_idx
  on public.study_sessions (deck_id, started_at desc);

create index if not exists deck_share_links_created_by_idx
  on public.deck_share_links (created_by);

create index if not exists ai_duplicate_links_source_target_idx
  on public.ai_duplicate_links (deck_id, source_card_id, target_card_id);

create index if not exists ai_duplicate_links_target_idx
  on public.ai_duplicate_links (deck_id, target_card_id, status);
