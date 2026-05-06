import { useState, useEffect, useCallback } from 'react';
import { api, type DeckAnalytics } from './api';

interface Props {
  deckId: string;
  deckName: string;
  isOwner: boolean;
  onSetVisibility: (v: 'public' | 'private' | 'unlisted') => void;
  currentVisibility?: string;
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

  if (loading) return <div className="analytics-loading">Loading analytics…</div>;
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
    </div>
  );
}
