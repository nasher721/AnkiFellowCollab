import type { Deck, DeckSummary } from '../types';

const statusColors: Record<string, string> = {
  New: 'blue',
  Learning: 'amber',
  Review: 'green',
  Suspended: 'red',
  Anki: 'neutral'
};

export interface DeckStatsViewProps {
  deck: Deck;
  summary?: DeckSummary;
  suggestions: {
    total: number;
    accepted: number;
    rejected: number;
    pending: number;
    revision: number;
    acceptanceRate: number;
  };
  filteredCount: number;
}

export function DeckStatsView({
  deck,
  summary,
  suggestions,
  filteredCount
}: DeckStatsViewProps) {
  const stateCounts = deck.cards.reduce<Record<string, number>>((acc, card) => {
    acc[card.state] = (acc[card.state] || 0) + 1;
    return acc;
  }, {});
  const suspended = deck.cards.filter((card) => card.suspended).length;
  const noteTypes = summary?.noteTypes?.length ? summary.noteTypes : Array.from(new Set(deck.cards.map((card) => card.type)));

  return (
    <div className="tab-panel stats-view">
      <div>
        <h2>Deck stats</h2>
        <p>First-pass operational totals from the loaded deck state.</p>
      </div>
      <div className="stat-grid">
        <div><small>Cards</small><strong>{deck.cards.length.toLocaleString()}</strong></div>
        <div><small>Filtered cards</small><strong>{filteredCount.toLocaleString()}</strong></div>
        <div><small>Tags</small><strong>{summary?.tagCount.toLocaleString() ?? '0'}</strong></div>
        <div><small>Note types</small><strong>{noteTypes.length.toLocaleString()}</strong></div>
        <div><small>Suspended</small><strong>{suspended.toLocaleString()}</strong></div>
        <div><small>Acceptance rate</small><strong>{suggestions.acceptanceRate}%</strong></div>
      </div>
      <div className="stats-columns">
        <section>
          <h3>Card states</h3>
          <div className="state-bar-wrap">
            {Object.entries(stateCounts).map(([st, count]) => {
              const pct = deck.cards.length ? Math.round((count / deck.cards.length) * 100) : 0;
              const color = (statusColors[st] || 'neutral');
              return (
                <div className="state-bar-row" key={st}>
                  <span title={st}>{st}</span>
                  <div className="state-bar-track">
                    <div className={`state-bar-fill ${color}`} style={{ width: `${pct}%` }} />
                  </div>
                  <strong>{count}</strong>
                </div>
              );
            })}
          </div>
        </section>
        <section>
          <h3>Suggestion flow</h3>
          <div className="metric-row"><span>Pending</span><strong>{suggestions.pending}</strong></div>
          <div className="metric-row"><span>Accepted</span><strong>{suggestions.accepted}</strong></div>
          <div className="metric-row"><span>Rejected</span><strong>{suggestions.rejected}</strong></div>
          <div className="metric-row"><span>Needs revision</span><strong>{suggestions.revision}</strong></div>
        </section>
        <section>
          <h3>Note types</h3>
          <div className="tag-list wide">
            {noteTypes.map((type) => <em key={type}>{type}</em>)}
          </div>
        </section>
      </div>
    </div>
  );
}
