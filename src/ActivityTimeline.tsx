import { useMemo, useState } from 'react';
import type { Activity } from './types';

const FILTERS = ['All', 'suggestion', 'comment', 'decision', 'sync', 'export'] as const;
type Filter = typeof FILTERS[number];

const DOT_CLASS: Record<string, string> = {
  suggestion: 'dot-suggestion',
  comment: 'dot-comment',
  decision: 'dot-decision',
  sync: 'dot-sync',
  export: 'dot-export',
};

function relTime(value: string) {
  const diff = Date.now() - new Date(value).getTime();
  const minutes = Math.max(1, Math.round(diff / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function labelFor(filter: Filter) {
  if (filter === 'All') return 'All';
  return filter.charAt(0).toUpperCase() + filter.slice(1) + 's';
}

interface Props {
  deckId: string;
  deckName: string;
  activities: Activity[];
  suggestionStats?: {
    total: number;
    accepted: number;
    rejected: number;
    pending: number;
    acceptanceRate: number;
  };
}

export function ActivityTimeline({ activities, suggestionStats }: Props) {
  const [filter, setFilter] = useState<Filter>('All');

  const filtered = useMemo(() => {
    if (filter === 'All') return activities;
    return activities.filter((a) => a.kind === filter);
  }, [activities, filter]);

  return (
    <div className="activity-timeline">
      {suggestionStats ? (
        <div className="activity-stats-row">
          <div className="analytics-card">
            <span className="analytics-value">{suggestionStats.total}</span>
            <span className="analytics-label">Total Suggestions</span>
          </div>
          <div className="analytics-card highlight">
            <span className="analytics-value">{suggestionStats.acceptanceRate}%</span>
            <span className="analytics-label">Acceptance Rate</span>
          </div>
          <div className="analytics-card">
            <span className="analytics-value">{suggestionStats.accepted}</span>
            <span className="analytics-label">Accepted</span>
          </div>
          <div className="analytics-card">
            <span className="analytics-value">{suggestionStats.pending}</span>
            <span className="analytics-label">Pending</span>
          </div>
          <div className="analytics-card">
            <span className="analytics-value">{suggestionStats.rejected}</span>
            <span className="analytics-label">Rejected</span>
          </div>
        </div>
      ) : null}

      <div className="activity-filter-bar">
        {FILTERS.map((f) => (
          <button
            key={f}
            className={`category-pill ${filter === f ? 'active' : ''}`}
            onClick={() => setFilter(f)}
          >
            {labelFor(f)}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="empty-state">No activity to display.</div>
      ) : (
        <div className="timeline-list">
          {filtered.map((item) => (
            <div className="timeline-item" key={item.id}>
              <span className={`timeline-dot ${DOT_CLASS[item.kind] || 'dot-suggestion'}`} />
              <div className="timeline-content">
                <span className="timeline-text">{item.text}</span>
                <span className="timeline-time">{relTime(item.at)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
