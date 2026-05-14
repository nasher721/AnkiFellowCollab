CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cards_deck_created_id
ON cards(deck_id, created_at, id);
