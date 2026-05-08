-- Migration to optimize Supabase for large (15GB) Anki decks

-- 1. Increase file size limits in storage.buckets
UPDATE storage.buckets
SET file_size_limit = 16106127360 -- 15GiB in bytes
WHERE id IN ('deckbridge-exports', 'deckbridge-media');

-- 2. Increase statement timeout for the authenticator role to prevent timeouts during large bulk inserts
ALTER ROLE authenticator SET statement_timeout = '2h';
