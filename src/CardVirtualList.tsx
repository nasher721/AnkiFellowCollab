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

function primaryField(card: DeckCard) {
  const ordered = card.fieldOrder?.map((field) => card.fields[field]).find(Boolean);
  return ordered || card.fields?.Front || Object.values(card.fields || {})[0] || card.id;
}

function secondaryField(card: DeckCard) {
  const ordered = card.fieldOrder?.map((field) => card.fields[field]).filter(Boolean);
  return ordered?.[1] || card.fields?.Back || Object.values(card.fields || {})[1] || card.modelName || card.type;
}

function compactDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date);
}

function statusClass(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'neutral';
}

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
    <div className="card-virtual-shell">
      <div className="virtual-table-header" role="row">
        <span>Card</span>
        <span>Tags</span>
        <span>Status</span>
        <span>Updated</span>
      </div>
      <div ref={scrollRef} className="card-virtual-list">
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
                cursor: 'pointer'
              }}
              onClick={() => onCardSelect(card.id)}
              role="row"
              tabIndex={0}
            >
              <span className="virtual-card-copy">
                <strong>{primaryField(card)}</strong>
                <small>{secondaryField(card)}</small>
              </span>
              <span className="virtual-card-tags">
                {card.tags.slice(0, 2).map((tag) => <em key={tag}>{tag}</em>)}
                {card.tags.length > 2 ? <em>+{card.tags.length - 2}</em> : null}
              </span>
              <span>
                <b className={`state-chip state-chip--${statusClass(card.state)}`}>{card.state}</b>
              </span>
              <span className="virtual-card-updated">
                <strong>{compactDate(card.modifiedAt)}</strong>
                <small>{card.modifiedBy}</small>
              </span>
            </div>
          );
        })}
        </div>
        {loading && <div className="loading-more">Loading more cards...</div>}
      </div>
    </div>
  );
}
