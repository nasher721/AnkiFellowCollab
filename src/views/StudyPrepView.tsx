export interface StudyPrepViewProps {
  totalCards: number;
  studyCards: number;
  approvedCards: number;
  pendingBlocked: number;
  approvedOnly: boolean;
  onApprovedOnlyChange: (value: boolean) => void;
  onStart: () => void;
}

export function StudyPrepView({
  totalCards,
  studyCards,
  approvedCards,
  pendingBlocked,
  approvedOnly,
  onApprovedOnlyChange,
  onStart
}: StudyPrepViewProps) {
  return (
    <div className="tab-panel study-prep">
      <div>
        <h2>Study session</h2>
        <p>Start a due-card session with local SM-2 progress and server sync when authentication is available.</p>
      </div>
      <div className="stat-grid compact">
        <div><small>Available now</small><strong>{studyCards.toLocaleString()}</strong></div>
        <div><small>Approved cards</small><strong>{approvedCards.toLocaleString()}</strong></div>
        <div><small>All cards</small><strong>{totalCards.toLocaleString()}</strong></div>
        <div><small>Pending review</small><strong>{pendingBlocked.toLocaleString()}</strong></div>
      </div>
      <label className="toggle-row">
        <input
          type="checkbox"
          checked={approvedOnly}
          onChange={(event) => onApprovedOnlyChange(event.target.checked)}
        />
        <span>
          <strong>Study approved cards only</strong>
          <small>Excludes suspended cards and cards with pending owner-review suggestions.</small>
        </span>
      </label>
      <div className="panel-actions">
        <button className="button primary" onClick={onStart} disabled={studyCards === 0}>Start study session</button>
      </div>
    </div>
  );
}
