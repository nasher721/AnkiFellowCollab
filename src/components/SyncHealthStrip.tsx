import type { SyncHealth } from '../hooks/common';
import { Icon } from './Icon';

export function SyncHealthStrip({ health, onAction }: { health: SyncHealth; onAction: (action: SyncHealth['primaryAction']) => void }) {
  return (
    <div className={`sync-strip sync-strip--${health.tone}`} aria-label="Sync health">
      <span className={`sync-light ${health.tone === 'success' ? 'on' : ''}`} />
      <div className="sync-strip-main">
        <strong>{health.title}</strong>
        <small>{health.packageLabel} · {health.deckLabel} · {health.localDeckLabel}</small>
      </div>
      <span className={`sync-badge sync-badge--${health.tone}`}>{health.badge}</span>
      <small className="sync-strip-detail">
        {health.state === 'dry-run-passed'
          ? health.detail
          : `Checked ${health.lastCheckedLabel} · Last success ${health.lastSyncedLabel} · ${health.conflictLabel}`}
      </small>
      <button className="icon-button" title={health.primaryLabel} onClick={() => onAction(health.primaryAction)}>
        <Icon name={health.primaryAction === 'conflicts' ? 'x' : 'sync'} />
      </button>
    </div>
  );
}
