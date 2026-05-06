import { useState, useEffect, useCallback } from 'react';
import { api, type PublicDeck } from './api';

interface Props {
  onFork: (deckId: string, name: string) => void;
}

const SORT_OPTIONS = [
  { value: 'stars', label: 'Most starred' },
  { value: 'newest', label: 'Newest' },
];

export function DiscoverView({ onFork }: Props) {
  const [decks, setDecks] = useState<PublicDeck[]>([]);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('stars');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [starring, setStarring] = useState<Set<string>>(new Set());
  const [forking, setForking] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const { decks: data } = await api.discover({ q: query || undefined, sort, page });
      setDecks(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load decks');
    } finally {
      setLoading(false);
    }
  }, [query, sort, page]);

  useEffect(() => { load(); }, [load]);

  // Debounce search
  useEffect(() => {
    setPage(1);
  }, [query, sort]);

  async function handleStar(deck: PublicDeck) {
    if (starring.has(deck.id)) return;
    setStarring((s) => new Set([...s, deck.id]));
    try {
      await api.starDeck(deck.id);
      setDecks((prev) => prev.map((d) => d.id === deck.id
        ? { ...d, starCount: d.starCount + 1 }
        : d
      ));
    } catch {
      // silently degrade
    } finally {
      setStarring((s) => { const n = new Set(s); n.delete(deck.id); return n; });
    }
  }

  async function handleFork(deck: PublicDeck) {
    setForking(deck.id);
    try {
      const { deckId, name } = await api.forkDeck(deck.id);
      onFork(deckId, name);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Fork failed');
    } finally {
      setForking(null);
    }
  }

  return (
    <div className="discover-view">
      <div className="discover-header">
        <div>
          <h2>Discover Decks</h2>
          <p>Browse public decks, star favourites, and fork to your workspace.</p>
        </div>
        <div className="discover-controls">
          <input
            className="discover-search"
            type="search"
            placeholder="Search decks…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search public decks"
          />
          <select
            className="discover-sort"
            value={sort}
            onChange={(e) => setSort(e.target.value)}
            aria-label="Sort by"
          >
            {SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
      </div>

      {error && <div className="discover-error">{error}</div>}

      {loading ? (
        <div className="discover-loading">Loading decks…</div>
      ) : decks.length === 0 ? (
        <div className="discover-empty">
          <p>No public decks found{query ? ` for "${query}"` : ''}.</p>
          <p className="discover-empty-hint">
            Make your own deck public via deck settings to appear here.
          </p>
        </div>
      ) : (
        <div className="discover-grid">
          {decks.map((deck) => (
            <div key={deck.id} className="discover-card">
              <div className="discover-card-body">
                <h3 className="discover-card-title">{deck.name}</h3>
                <p className="discover-card-desc">{deck.description || 'No description.'}</p>
                {deck.forkedFrom && (
                  <span className="discover-fork-badge">🍴 Forked</span>
                )}
              </div>
              <div className="discover-card-meta">
                <span className="discover-card-author">by {deck.ownerName}</span>
                <span className="discover-card-stats">
                  ⭐ {deck.starCount}
                  {deck.downloadCount > 0 && <> · ↓ {deck.downloadCount}</>}
                </span>
              </div>
              <div className="discover-card-actions">
                <button
                  className="btn btn-outline btn-sm"
                  onClick={() => handleStar(deck)}
                  disabled={starring.has(deck.id)}
                  aria-label={`Star ${deck.name}`}
                >
                  ⭐ Star
                </button>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={() => handleFork(deck)}
                  disabled={forking === deck.id}
                  aria-label={`Fork ${deck.name}`}
                >
                  {forking === deck.id ? 'Forking…' : '🍴 Fork to workspace'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {decks.length === 24 && (
        <div className="discover-pagination">
          <button className="btn btn-secondary" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1 || loading}>← Prev</button>
          <span>Page {page}</span>
          <button className="btn btn-secondary" onClick={() => setPage((p) => p + 1)} disabled={loading}>Next →</button>
        </div>
      )}
    </div>
  );
}
