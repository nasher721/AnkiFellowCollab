import { useState, useEffect, useCallback } from 'react';
import { api, type DeckAnalytics } from './api';

interface Props {
  deckId: string;
  deckName: string;
  isOwner: boolean;
  onSetVisibility: (v: 'public' | 'private' | 'unlisted') => void;
  currentVisibility?: string;
}

function AnalyticsSkeleton() {
  return (
    <div className="analytics-view" aria-busy="true" aria-label="Loading analytics">
      <div className="analytics-header">
        <div className="analytics-skeleton analytics-skeleton-title" />
        <div className="analytics-skeleton analytics-skeleton-control" />
      </div>
      <div className="analytics-grid" aria-hidden="true">
        {Array.from({ length: 6 }, (_, index) => (
          <div className="analytics-card analytics-skeleton-card" key={index}>
            <span className="analytics-skeleton analytics-skeleton-value" />
            <span className="analytics-skeleton analytics-skeleton-label" />
          </div>
        ))}
      </div>
      <div className="analytics-section analytics-skeleton-section" aria-hidden="true">
        <div className="analytics-skeleton analytics-skeleton-heading" />
        <div className="analytics-skeleton analytics-skeleton-bar" />
      </div>
    </div>
  );
}

export function AnalyticsDashboard({ deckId, deckName, isOwner, onSetVisibility, currentVisibility = 'private' }: Props) {
  const [analytics, setAnalytics] = useState<DeckAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [settingVisibility, setSettingVisibility] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const { analytics: data } = await api.analytics(deckId);
      setAnalytics(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load analytics');
    } finally {
      setLoading(false);
    }
  }, [deckId]);

  useEffect(() => { load(); }, [load]);

  async function handleVisibility(v: 'public' | 'private' | 'unlisted') {
    setSettingVisibility(true);
    try {
      await api.setVisibility(deckId, v);
      onSetVisibility(v);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update visibility');
    } finally {
      setSettingVisibility(false);
    }
  }

  if (loading) return <AnalyticsSkeleton />;
  if (error) return <div className="analytics-error">{error}</div>;
  if (!analytics) return null;

  const { suggestions: s, stars, leaderboard } = analytics;

  return (
    <div className="analytics-view">
      <div className="analytics-header">
        <h2>{deckName} — Analytics</h2>
        {isOwner && (
          <div className="visibility-control">
            <label>Visibility</label>
            <select
              value={currentVisibility}
              onChange={(e) => handleVisibility(e.target.value as 'public' | 'private' | 'unlisted')}
              disabled={settingVisibility}
              className="wizard-select"
            >
              <option value="private">🔒 Private</option>
              <option value="unlisted">🔗 Unlisted (link only)</option>
              <option value="public">🌐 Public (discoverable)</option>
            </select>
          </div>
        )}
      </div>

      <div className="analytics-grid">
        <div className="analytics-card">
          <span className="analytics-value">{s.total}</span>
          <span className="analytics-label">Total suggestions</span>
        </div>
        <div className="analytics-card highlight">
          <span className="analytics-value">{s.acceptanceRate}%</span>
          <span className="analytics-label">Acceptance rate</span>
        </div>
        <div className="analytics-card">
          <span className="analytics-value">{s.accepted}</span>
          <span className="analytics-label">Accepted</span>
        </div>
        <div className="analytics-card">
          <span className="analytics-value">{s.rejected}</span>
          <span className="analytics-label">Rejected</span>
        </div>
        <div className="analytics-card">
          <span className="analytics-value">{s.pending}</span>
          <span className="analytics-label">Pending review</span>
        </div>
        <div className="analytics-card">
          <span className="analytics-value">⭐ {stars}</span>
          <span className="analytics-label">Stars</span>
        </div>
      </div>

      {/* Acceptance rate bar */}
      <div className="analytics-section">
        <h3>Suggestion breakdown</h3>
        {s.total > 0 ? (
          <div className="suggestion-bar-wrap">
            <div className="suggestion-bar">
              <div className="bar-accepted" style={{ width: `${(s.accepted / s.total) * 100}%` }} title={`Accepted: ${s.accepted}`} />
              <div className="bar-rejected" style={{ width: `${(s.rejected / s.total) * 100}%` }} title={`Rejected: ${s.rejected}`} />
              <div className="bar-pending" style={{ width: `${(s.pending / s.total) * 100}%` }} title={`Pending: ${s.pending}`} />
            </div>
            <div className="bar-legend">
              <span className="legend-accepted">■ Accepted ({s.accepted})</span>
              <span className="legend-rejected">■ Rejected ({s.rejected})</span>
              <span className="legend-pending">■ Pending ({s.pending})</span>
            </div>
          </div>
        ) : (
          <p className="analytics-empty">No suggestions yet.</p>
        )}
      </div>

      {/* Contributor leaderboard */}
      {leaderboard.length > 0 && (
        <div className="analytics-section">
          <h3>Top contributors</h3>
          <div className="leaderboard">
            {leaderboard.map((c, i) => (
              <div key={c.name} className="leaderboard-row">
                <span className="leaderboard-rank">#{i + 1}</span>
                <span className="leaderboard-name">{c.name}</span>
                <span className="leaderboard-stats">
                  {c.accepted} accepted / {c.total} total
                </span>
                <div className="leaderboard-bar-wrap">
                  <div
                    className="leaderboard-bar"
                    style={{ width: `${c.total ? (c.accepted / c.total) * 100 : 0}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Study activity */}
      {analytics.study && (
        <div className="analytics-section">
          <h3>Study activity</h3>
          <div className="analytics-grid">
            <div className="analytics-card">
              <span className="analytics-value">{analytics.study.sessions.total}</span>
              <span className="analytics-label">Study sessions</span>
            </div>
            <div className="analytics-card highlight">
              <span className="analytics-value">{analytics.study.sessions.accuracyRate}%</span>
              <span className="analytics-label">Accuracy rate</span>
            </div>
            <div className="analytics-card">
              <span className="analytics-value">{analytics.study.sessions.cardsStudied.toLocaleString()}</span>
              <span className="analytics-label">Cards studied</span>
            </div>
            <div className="analytics-card">
              <span className="analytics-value">
                {Math.round(analytics.study.sessions.durationSeconds / 60)} min
              </span>
              <span className="analytics-label">Total study time</span>
            </div>
          </div>

          {analytics.study.weeklyTrend.length > 0 && (
            <div className="study-trend">
              <h4>Recent activity</h4>
              <div className="study-trend-bars">
                {(() => {
                  const maxCount = Math.max(...analytics.study.weeklyTrend.map((d) => d.count), 1);
                  return analytics.study.weeklyTrend.map((d) => (
                    <div key={d.date} className="trend-bar-col" title={`${d.date}: ${d.count} cards`}>
                      <div
                        className="trend-bar"
                        style={{ height: `${Math.max((d.count / maxCount) * 100, 4)}%` }}
                      />
                      <span className="trend-bar-label">{d.date.slice(5)}</span>
                    </div>
                  ));
                })()}
              </div>
            </div>
          )}

          {analytics.study.strugglingCards.length > 0 && (
            <div className="struggling-cards">
              <h4>Cards needing attention</h4>
              {analytics.study.strugglingCards.map((card) => (
                <div key={card.cardId} className="struggling-card-row">
                  <div className="struggling-card-content">
                    {card.front
                      ? <span className="struggling-front">{card.front}</span>
                      : <span className="struggling-id">{card.cardId.slice(0, 8)}…</span>
                    }
                    {card.back && <span className="struggling-back">{card.back}</span>}
                  </div>
                  <div className="struggling-card-meta">
                    <span className="struggling-ease">Ease {card.easeFactor.toFixed(2)}</span>
                    <span className="struggling-reps">{card.repetitions} reps</span>
                    <span className="struggling-due">Due {card.nextDue.slice(0, 10)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}

          {analytics.study.sessions.total === 0 && (
            <p className="analytics-empty">No study sessions recorded yet. Start studying to see your progress here.</p>
          )}
        </div>
      )}
    </div>
  );
}
