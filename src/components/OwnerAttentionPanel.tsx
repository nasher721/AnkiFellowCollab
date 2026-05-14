import type { OwnerAttentionItem, SyncHealth } from '../hooks/common';
import { Icon } from './Icon';

export function OwnerAttentionPanel({
  items,
  onDismissArtifact,
  onAction,
  syncHealth
}: {
  items: OwnerAttentionItem[];
  onDismissArtifact?: (artifactId: string) => void;
  onAction: (item: OwnerAttentionItem) => void;
  syncHealth: SyncHealth;
}) {
  return (
    <section className="owner-attention" aria-label="Owner attention">
      <div className="owner-attention-heading">
        <strong>Owner Attention</strong>
        <span className={`sync-badge sync-badge--${syncHealth.tone}`}>{syncHealth.badge}</span>
      </div>
      <div className="owner-sync-proof">
        <span>{syncHealth.packageLabel}</span>
        <span>{syncHealth.lastCheckedLabel === 'Not yet' ? 'No bridge check yet' : `Checked ${syncHealth.lastCheckedLabel}`}</span>
      </div>
      {items.length ? (
        <div className="attention-list">
          {items.map((item) => (
            <div
              key={item.id}
              style={{ display: 'grid', gridTemplateColumns: item.artifactId ? '1fr 34px' : '1fr', gap: 6, alignItems: 'stretch' }}
              role="group"
              aria-label={`Attention item: ${item.label}`}
            >
              <button
                type="button"
                className={`attention-item attention-item--${item.tone}`}
                aria-label={`Open attention item: ${item.label}`}
                onClick={() => onAction(item)}
              >
                <span>
                  <strong>{item.label}</strong>
                  <small>{item.detail}</small>
                </span>
                <b>{item.actionLabel}</b>
              </button>
              {item.artifactId ? (
                <button
                  type="button"
                  className="icon-button"
                  title="Dismiss AI artifact"
                  aria-label={`Dismiss AI artifact: ${item.label}`}
                  onClick={() => onDismissArtifact?.(item.artifactId!)}
                >
                  <Icon name="x" />
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <div className="attention-clear">
          <Icon name="check" />
          <span>
            <strong>Owner queue clear</strong>
            <small>Sync, review, and study readiness have no urgent blockers.</small>
          </span>
        </div>
      )}
    </section>
  );
}
