import type { QualityReviewItem } from '../reviewModel';
import { Icon } from './Icon';

export function ReviewDecisionBar({
  item,
  canReview,
  busy,
  hasSuggestion,
  hasConflicts,
  renderFallback,
  canSuggest,
  sourceCheckState,
  onDecideSuggestion,
  onResolveConflict,
  onMarkNeedsSourceCheck,
  onMarkSourceChecked,
  onCreateSuggestion,
  onPushToAnki
}: {
  item?: QualityReviewItem;
  canReview: boolean;
  busy: boolean;
  hasSuggestion: boolean;
  hasConflicts: boolean;
  renderFallback: boolean;
  canSuggest: boolean;
  sourceCheckState: 'needs' | 'checked' | undefined;
  onDecideSuggestion: (decision: 'accepted' | 'rejected' | 'revision') => void;
  onResolveConflict: (resolution: 'local' | 'incoming' | 'skip') => void;
  onMarkNeedsSourceCheck: () => void;
  onMarkSourceChecked: () => void;
  onCreateSuggestion: () => void;
  onPushToAnki: () => void;
}) {
  if (item?.kind === 'conflict') {
    return (
      <div className="review-decision-bar review-decision-bar--conflict">
        <span>
          <strong>Source-of-truth decision</strong>
          <small>Push to Anki stays blocked until this conflict is resolved.</small>
        </span>
        <button className="button secondary" onClick={() => onResolveConflict('skip')} disabled={busy}>Skip for now</button>
        <button className="button secondary" onClick={() => onResolveConflict('local')} disabled={busy}>Keep local Anki</button>
        <button className="button primary" onClick={() => onResolveConflict('incoming')} disabled={busy}>Use DeckBridge</button>
        <button
          className="button secondary"
          disabled
          title="Push blocked: resolve sync conflicts before writing accepted changes back to Anki."
        >
          <Icon name="sync" /> Push to Anki blocked
        </button>
      </div>
    );
  }

  if (canReview && hasSuggestion) {
    const cautious = item?.needsSourceCheck || item?.risk === 'high' || renderFallback;
    return (
      <div className={`review-decision-bar ${cautious ? 'review-decision-bar--cautious' : ''}`}>
        <span>
          <strong>{cautious ? 'Check source before accepting' : 'Suggestion decision'}</strong>
          <small>{renderFallback ? 'Rendered HTML is missing; compare the field-rendered preview with raw diffs before accepting.' : cautious ? 'Request revision is the safer action until the evidence is checked.' : 'Approved changes become canonical for the deck.'}</small>
        </span>
        <button className="button secondary" onClick={() => onDecideSuggestion('rejected')} disabled={busy}><Icon name="x" /> Reject</button>
        <button className={cautious ? 'button primary' : 'button secondary'} onClick={() => onDecideSuggestion('revision')} disabled={busy}>Request revision</button>
        {sourceCheckState === 'checked' ? (
          <button className="button secondary" onClick={onMarkNeedsSourceCheck} disabled={busy}>Mark needs source check</button>
        ) : (
          <button className={cautious ? 'button primary' : 'button secondary'} onClick={onMarkSourceChecked} disabled={busy}>Mark checked</button>
        )}
        <button className={cautious ? 'button secondary' : 'button primary'} onClick={() => onDecideSuggestion('accepted')} disabled={busy}><Icon name="check" /> Accept</button>
      </div>
    );
  }

  return (
    <div className="review-decision-bar">
      <span>
        <strong>Card actions</strong>
        <small>{hasConflicts ? 'Push blocked by unresolved sync conflicts.' : 'Accepted changes can be pushed back to Anki.'}</small>
      </span>
      <button className="button secondary" onClick={onCreateSuggestion} disabled={busy || !canSuggest}><Icon name="spark" /> Suggest edit</button>
      {item ? <button className="button secondary" onClick={onMarkNeedsSourceCheck} disabled={busy}>Mark needs source check</button> : null}
      <button
        className="button primary"
        disabled={busy || hasConflicts}
        title={hasConflicts ? 'Push blocked: resolve sync conflicts before writing accepted changes back to Anki.' : undefined}
        onClick={onPushToAnki}
      >
        <Icon name="sync" /> Push to Anki
      </button>
    </div>
  );
}
