CREATE EXTENSION IF NOT EXISTS vector;
ALTER TABLE cards ADD COLUMN IF NOT EXISTS embedding vector(1536);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cards_embedding ON cards USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
