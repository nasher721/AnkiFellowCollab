import { useEffect, useRef } from 'react';
import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';

interface RealtimeOptions {
  supabase: SupabaseClient | null;
  deckId: string | undefined;
  onSuggestionChange: () => void;
  onCommentChange: () => void;
  onCardChange?: (payload: { eventType: 'INSERT' | 'UPDATE' | 'DELETE'; card: Record<string, unknown> }) => void;
  enabled?: boolean;
}

export function useRealtime({ supabase, deckId, onSuggestionChange, onCommentChange, onCardChange, enabled = true }: RealtimeOptions) {
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

    const cardChannel = supabase
      .channel(`deck-cards-${deckId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'cards', filter: `deck_id=eq.${deckId}` },
        (payload) => {
          if (onCardChange) {
            onCardChange({ eventType: payload.eventType as 'INSERT' | 'UPDATE' | 'DELETE', card: payload.new as Record<string, unknown> });
          }
        }
      )
      .subscribe((status) => {
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          let retries = 0;
          const maxRetries = 3;
          const retry = () => {
            retries++;
            if (retries > maxRetries) return;
            setTimeout(() => {
              cardChannel.subscribe();
            }, retries * 1000);
          };
          retry();
        }
      });

    channelRef.current = channel;

    return () => {
      channel.unsubscribe();
      cardChannel.unsubscribe();
      channelRef.current = null;
    };
  }, [supabase, deckId, enabled, onSuggestionChange, onCommentChange, onCardChange]);
}
