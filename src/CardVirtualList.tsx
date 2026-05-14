import { useState, useEffect, useRef, useCallback } from 'react';
import type { DeckCard, CursorPage } from './types';
import { api } from './api';

interface CardVirtualListProps {
  deckId: string;
  initialCards?: DeckCard[];
  onCardSelect: (cardId: string) => void;
  selectedCardId?: string;
  initialCursor?: string | null;
}

const ROW_HEIGHT = 60;
const BUFFER_ROWS = 2;
const PRE_FETCH_THRESHOLD = 200;
const SCROLL_DEBOUNCE = 150;
const PAGE_LIMIT = 200;

export function CardVirtualList({ deckId, initialCards = [], onCardSelect, selectedCardId, initialCursor = null }: CardVirtualListProps) {
  const [cards, setCards] = useState<DeckCard[]>(initialCards);
  const [cursor, setCursor] = useState<string | null>(initialCursor);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(initialCursor !== null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fetchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelRef = useRef<(() => void) | null>(null);

  const fetchNextPage = useCallback(async () => {
    if (loading || !hasMore || !deckId) return;
    setLoading(true);

    if (cancelRef.current) cancelRef.current();

    const { promise, cancel } = api.cards.list(deckId, { cursor, limit: PAGE_LIMIT });
    cancelRef.current = cancel;

    try {
      const result = await promise;
      setCards((prev) => {
        const existingIds = new Set(prev.map((c) => c.id));
        const newCards = result.cards.filter((c) => !existingIds.has(c.id));
        return [...prev, ...newCards];
      });
      setCursor(result.nextCursor);
      setHasMore(result.nextCursor !== null);
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'AbortError') return;
    } finally {
      setLoading(false);
      cancelRef.current = null;
    }
  }, [deckId, cursor, loading, hasMore]);

  // Initial load
  useEffect(() => {
    if (cards.length === 0 && hasMore) {
      fetchNextPage();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // IntersectionObserver for infinite scroll
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const handleScroll = () => {
      if (fetchTimeoutRef.current) clearTimeout(fetchTimeoutRef.current);
      fetchTimeoutRef.current = setTimeout(() => {
        if (el.scrollTop + el.clientHeight >= el.scrollHeight - PRE_FETCH_THRESHOLD) {
          fetchNextPage();
        }
      }, SCROLL_DEBOUNCE);
    };

    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', handleScroll);
      if (fetchTimeoutRef.current) clearTimeout(fetchTimeoutRef.current);
    };
  }, [fetchNextPage]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (cancelRef.current) cancelRef.current();
    };
  }, []);

  const containerStyle = { height: cards.length * ROW_HEIGHT, position: 'relative' as const };

  return (
    <div ref={scrollRef} className="card-virtual-list" style={{ overflow: 'auto', height: '100%', maxHeight: 'calc(100vh - 300px)' }}>
      <div style={containerStyle}>
        {cards.map((card, index) => {
          const top = index * ROW_HEIGHT;
          return (
            <div
              key={card.id}
              className={`table-row virtual-row ${card.id === selectedCardId ? 'selected' : ''}`}
              style={{
                position: 'absolute',
                top,
                height: ROW_HEIGHT,
                left: 0,
                right: 0,
                display: 'flex',
                alignItems: 'center',
                padding: '0 12px',
                cursor: 'pointer'
              }}
              onClick={() => onCardSelect(card.id)}
              role="row"
              tabIndex={0}
            >
              <span style={{ flex: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {card.fields?.Front || Object.values(card.fields || {})[0] || card.id}
              </span>
              <span style={{ flex: 1, textAlign: 'center' }}>{card.state}</span>
              <span style={{ flex: 1, textAlign: 'right' }}>{card.due ?? '-'}</span>
            </div>
          );
        })}
      </div>
      {loading && <div className="loading-more">Loading more cards...</div>}
    </div>
  );
}
