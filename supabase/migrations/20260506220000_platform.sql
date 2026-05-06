-- Deck visibility (public/private/unlisted)
alter table public.decks
  add column if not exists visibility text not null default 'private'
    check (visibility in ('private', 'unlisted', 'public'));

alter table public.decks
  add column if not exists fork_of text references public.decks(id) on delete set null;

alter table public.decks
  add column if not exists download_count bigint not null default 0;

-- Stars / favourites
create table if not exists public.deck_stars (
  deck_id text not null references public.decks(id) on delete cascade,
  user_id text not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (deck_id, user_id)
);

create index if not exists deck_stars_deck_id_idx on public.deck_stars (deck_id);

-- Deck templates
create table if not exists public.templates (
  id text primary key,
  name text not null,
  description text not null default '',
  category text not null default 'general',
  author_id text references public.profiles(id) on delete cascade,
  author_name text not null default 'DeckBridge',
  fields jsonb not null default '[]'::jsonb,   -- [{name, description}]
  sample_cards jsonb not null default '[]'::jsonb,
  tags jsonb not null default '[]'::jsonb,
  star_count int not null default 0,
  is_featured boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists templates_category_idx on public.templates (category, created_at desc);

-- Analytics: study progress stored server-side (mirrors localStorage)
create table if not exists public.study_progress (
  id text primary key,
  user_id text not null references public.profiles(id) on delete cascade,
  deck_id text not null references public.decks(id) on delete cascade,
  card_id text not null,
  interval_days int not null default 1,
  ease_factor numeric(4,2) not null default 2.50,
  repetitions int not null default 0,
  next_due timestamptz not null default now(),
  last_rating int,
  updated_at timestamptz not null default now(),
  unique (user_id, deck_id, card_id)
);

create index if not exists study_progress_user_deck_idx on public.study_progress (user_id, deck_id);

-- RLS
alter table public.deck_stars enable row level security;
alter table public.templates enable row level security;
alter table public.study_progress enable row level security;

-- Public decks readable by all authenticated users
create policy "decks read public" on public.decks for select using (visibility = 'public');

-- Stars
create policy "stars read all" on public.deck_stars for select using (true);
create policy "stars insert own" on public.deck_stars for insert with check (auth.uid()::text = user_id);
create policy "stars delete own" on public.deck_stars for delete using (auth.uid()::text = user_id);

-- Templates readable by all
create policy "templates read all" on public.templates for select using (true);
create policy "templates insert own" on public.templates for insert with check (auth.uid()::text = author_id);

-- Study progress
create policy "progress read own" on public.study_progress for select using (auth.uid()::text = user_id);
create policy "progress upsert own" on public.study_progress for insert with check (auth.uid()::text = user_id);
create policy "progress update own" on public.study_progress for update using (auth.uid()::text = user_id);

-- Seed built-in templates
insert into public.templates (id, name, description, category, author_id, author_name, fields, sample_cards, tags, is_featured)
values
  (
    'tpl-language',
    'Language Learning',
    'Vocabulary cards with word, translation, example sentence, and pronunciation.',
    'language',
    null,
    'DeckBridge',
    '[{"name":"Word","description":"The target language word or phrase"},{"name":"Translation","description":"Native language meaning"},{"name":"Example","description":"Example sentence using the word"},{"name":"Notes","description":"Pronunciation tips or memory aids"}]'::jsonb,
    '[{"Word":"Bonjour","Translation":"Hello","Example":"Bonjour, comment allez-vous?","Notes":"Used for formal greetings"},{"Word":"Merci","Translation":"Thank you","Example":"Merci beaucoup!","Notes":"Very common, always appreciated"}]'::jsonb,
    '["language","vocabulary","translation"]'::jsonb,
    true
  ),
  (
    'tpl-medical',
    'Medical Flashcards',
    'Clinical cards with condition, symptoms, diagnosis criteria, and treatment.',
    'medical',
    null,
    'DeckBridge',
    '[{"name":"Condition","description":"Medical condition or term"},{"name":"Symptoms","description":"Key presenting symptoms"},{"name":"Diagnosis","description":"Diagnostic criteria or tests"},{"name":"Treatment","description":"First-line treatment approach"}]'::jsonb,
    '[{"Condition":"Appendicitis","Symptoms":"RLQ pain, nausea, fever, rebound tenderness","Diagnosis":"CT abdomen, elevated WBC","Treatment":"Appendectomy, antibiotics"},{"Condition":"MI","Symptoms":"Chest pain, diaphoresis, SOB, jaw pain","Diagnosis":"ECG, troponin levels","Treatment":"MONA, PCI, anticoagulation"}]'::jsonb,
    '["medical","clinical","usmle"]'::jsonb,
    true
  ),
  (
    'tpl-coding',
    'Coding Interview Prep',
    'Algorithm and data structure cards with problem, approach, complexity, and code.',
    'programming',
    null,
    'DeckBridge',
    '[{"name":"Problem","description":"The algorithm problem or concept"},{"name":"Approach","description":"High-level solution strategy"},{"name":"Complexity","description":"Time and space complexity"},{"name":"Code","description":"Key code snippet or pseudocode"}]'::jsonb,
    '[{"Problem":"Two Sum","Approach":"Hash map for O(n) lookup","Complexity":"O(n) time, O(n) space","Code":"map[target-num] = i"},{"Problem":"Binary Search","Approach":"Divide and conquer on sorted array","Complexity":"O(log n) time, O(1) space","Code":"mid = lo + (hi-lo)//2"}]'::jsonb,
    '["programming","algorithms","leetcode"]'::jsonb,
    true
  ),
  (
    'tpl-history',
    'History & Events',
    'Historical event cards with date, event, context, significance, and key figures.',
    'humanities',
    null,
    'DeckBridge',
    '[{"name":"Event","description":"The historical event"},{"name":"Date","description":"When it occurred"},{"name":"Context","description":"Background and causes"},{"name":"Significance","description":"Why it matters historically"}]'::jsonb,
    '[{"Event":"French Revolution begins","Date":"1789","Context":"Financial crisis, food shortages, Enlightenment ideas","Significance":"Ended absolute monarchy, spread democratic ideals"}]'::jsonb,
    '["history","humanities","social-studies"]'::jsonb,
    true
  )
on conflict (id) do nothing;
