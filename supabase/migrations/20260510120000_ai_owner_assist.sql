alter table public.decks
  add column if not exists ai_settings jsonb not null default '{}'::jsonb;

create table if not exists public.ai_artifacts (
  id text primary key,
  deck_id text not null references public.decks(id) on delete cascade,
  subject_type text not null,
  subject_id text not null,
  kind text not null,
  severity text not null default 'info',
  status text not null default 'active',
  confidence double precision not null default 0,
  model text not null,
  prompt_version text not null,
  input_hash text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by text,
  constraint ai_artifacts_subject_type_check check (subject_type in ('suggestion', 'card', 'conflict', 'setup-error', 'study-hint', 'digest')),
  constraint ai_artifacts_kind_check check (kind in ('review-brief', 'duplicate-link', 'conflict-summary', 'quality-issue', 'diagnostic', 'hint', 'digest')),
  constraint ai_artifacts_severity_check check (severity in ('info', 'low', 'medium', 'high')),
  constraint ai_artifacts_status_check check (status in ('active', 'dismissed', 'accepted', 'rejected', 'stale')),
  constraint ai_artifacts_confidence_check check (confidence >= 0 and confidence <= 1)
);

create index if not exists ai_artifacts_deck_status_idx
  on public.ai_artifacts (deck_id, status, created_at desc);

create index if not exists ai_artifacts_subject_idx
  on public.ai_artifacts (deck_id, subject_type, subject_id, kind);

create table if not exists public.card_embeddings (
  card_id text primary key references public.cards(id) on delete cascade,
  deck_id text not null references public.decks(id) on delete cascade,
  model text not null,
  dimensions integer not null,
  input_hash text not null,
  embedding jsonb not null,
  status text not null default 'active',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint card_embeddings_status_check check (status in ('active', 'stale'))
);

create index if not exists card_embeddings_deck_status_idx
  on public.card_embeddings (deck_id, status, updated_at desc);

create table if not exists public.ai_duplicate_links (
  id text primary key,
  deck_id text not null references public.decks(id) on delete cascade,
  source_card_id text not null references public.cards(id) on delete cascade,
  target_card_id text not null references public.cards(id) on delete cascade,
  artifact_id text references public.ai_artifacts(id) on delete set null,
  score double precision not null,
  relationship text not null,
  rationale text not null default '',
  compared_fields jsonb not null default '[]'::jsonb,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_duplicate_links_relationship_check check (relationship in ('duplicate', 'near-duplicate', 'related')),
  constraint ai_duplicate_links_status_check check (status in ('active', 'dismissed', 'stale')),
  constraint ai_duplicate_links_score_check check (score >= 0 and score <= 1),
  constraint ai_duplicate_links_distinct_cards_check check (source_card_id <> target_card_id)
);

create index if not exists ai_duplicate_links_deck_status_idx
  on public.ai_duplicate_links (deck_id, status, score desc);

create index if not exists ai_duplicate_links_source_idx
  on public.ai_duplicate_links (deck_id, source_card_id, status);

alter table public.ai_artifacts enable row level security;
alter table public.card_embeddings enable row level security;
alter table public.ai_duplicate_links enable row level security;

-- These tables are written by the service-role API server. RLS keeps direct
-- client access closed unless explicit policies are added later.
revoke all on public.ai_artifacts from anon, authenticated;
revoke all on public.card_embeddings from anon, authenticated;
revoke all on public.ai_duplicate_links from anon, authenticated;
