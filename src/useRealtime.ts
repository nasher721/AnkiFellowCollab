import { useEffect, useRef } from 'react';
import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';

interface RealtimeOptions {
  supabase: SupabaseClient | null;
  deckId: string | undefined;
  onSuggestionChange: () => void;
  onCommentChange: () => void;
  enabled?: boolean;
}

export function useRealtime({ supabase, deckId, onSuggestionChange, onCommentChange, enabled = true }: RealtimeOptions) {
  const channelRef = useRef<RealtimeChannel | null>(null);

  useEffect(() => {
    if (!supabase || !deckId || !enabled) return;

    const channel = supabase
      .channel(`deck:${deckId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'suggestions', filter: `deck_id=eq.${deckId}` },
        (payload) => {
          if (payload.eventType === 'INSERT' || payload.eventType === 'UPDATE' || payload.eventType === 'DELETE') {
            onSuggestionChange();
          }
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'comments', filter: `deck_id=eq.${deckId}` },
        () => {
          onCommentChange();
        }
      )
      .subscribe();

    channelRef.current = channel;

    return () => {
      channel.unsubscribe();
      channelRef.current = null;
    };
  }, [supabase, deckId, enabled, onSuggestionChange, onCommentChange]);
}
