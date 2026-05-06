import { createLocalRepository } from './localRepository.mjs';
import { createSupabaseRepository } from './supabaseRepository.mjs';

export function createRepository(options = {}) {
  const mode = options.repositoryMode || process.env.DECKBRIDGE_REPOSITORY || 'auto';
  const hasSupabase = Boolean((options.supabaseUrl || process.env.SUPABASE_URL)
    && (options.supabaseServiceRoleKey || process.env.SUPABASE_SERVICE_ROLE_KEY));

  if (mode === 'supabase' || (mode === 'auto' && hasSupabase)) {
    return createSupabaseRepository(options);
  }

  return createLocalRepository(options);
}
