create table if not exists public.deck_files (
  id text primary key,
  deck_id text not null references public.decks(id) on delete cascade,
  file_kind text not null,
  filename text not null,
  storage_bucket text not null,
  storage_path text not null,
  sha256 text,
  size_bytes bigint not null default 0,
  mime_type text not null default 'application/octet-stream',
  status text not null default 'pending_upload',
  created_by text references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  uploaded_at timestamptz,
  last_accessed_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  constraint deck_files_kind_check check (file_kind in ('media', 'export')),
  constraint deck_files_status_check check (status in ('pending_upload', 'available', 'failed', 'deleted')),
  constraint deck_files_filename_check check (char_length(filename) > 0 and char_length(filename) <= 240),
  constraint deck_files_storage_bucket_check check (char_length(storage_bucket) > 0 and char_length(storage_bucket) <= 120),
  constraint deck_files_storage_path_check check (char_length(storage_path) > 0 and char_length(storage_path) <= 700),
  constraint deck_files_sha256_check check (sha256 is null or sha256 ~ '^[a-f0-9]{64}$'),
  constraint deck_files_size_bytes_check check (size_bytes >= 0),
  constraint deck_files_bucket_path_unique unique (storage_bucket, storage_path)
);

create index if not exists deck_files_deck_kind_status_created_idx
  on public.deck_files (deck_id, file_kind, status, created_at desc);

create index if not exists deck_files_deck_kind_filename_idx
  on public.deck_files (deck_id, file_kind, filename);

create index if not exists deck_files_pending_upload_idx
  on public.deck_files (created_at)
  where status = 'pending_upload';

create index if not exists deck_files_available_sha_idx
  on public.deck_files (deck_id, sha256)
  where status = 'available' and sha256 is not null;

create index if not exists deck_files_created_by_idx
  on public.deck_files (created_by)
  where created_by is not null;

alter table public.deck_files enable row level security;

-- The API server writes this inventory with the service role after it has
-- enforced deck membership. Keep direct client access closed by default.
revoke all on public.deck_files from anon, authenticated;
