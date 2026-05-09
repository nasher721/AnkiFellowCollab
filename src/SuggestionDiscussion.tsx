import { useState, useEffect, useCallback } from 'react';
import { api, type Comment } from './api';
import type { AiArtifact, AiSuggestionBriefPayload } from './types';

interface Props {
  suggestionId: string;
  deckId?: string;
  currentUserId: string;
  currentUserName: string;
  commentsVersion?: number;
  brief?: AiArtifact | null;
  aiEnabled?: boolean;
  canManageAi?: boolean;
  briefBusy?: boolean;
  onGenerateBrief?: () => void;
  onMarkBriefUseful?: (artifactId: string) => void;
  onDismissBrief?: (artifactId: string) => void;
}

const EMOJIS = ['👍', '❓', '✅'] as const;

export function SuggestionDiscussion({
  suggestionId,
  currentUserId,
  currentUserName,
  commentsVersion = 0,
  brief,
  aiEnabled = false,
  canManageAi = false,
  briefBusy = false,
  onGenerateBrief,
  onMarkBriefUseful,
  onDismissBrief
}: Props) {
  const [comments, setComments] = useState<Comment[]>([]);
  const [reactions, setReactions] = useState<Record<string, number>>({});
  const [myReactions, setMyReactions] = useState<Set<string>>(new Set());
  const [body, setBody] = useState('');
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [resolvingIds, setResolvingIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!suggestionId) return;
    setLoading(true);
    try {
      const { comments: data } = await api.comments.list(suggestionId);
      setComments(data);
    } catch {
      // silently degrade — comments may not be available locally
    } finally {
      setLoading(false);
    }
  }, [suggestionId]);

  useEffect(() => { load(); }, [load, commentsVersion]);

  async function submitComment() {
    const trimmed = body.trim();
    if (!trimmed) return;
    setSubmitting(true);
    setError('');
    try {
      const comment = await api.comments.create(suggestionId, trimmed, replyTo ?? undefined);
      setComments((prev) => [...prev, comment]);
      setBody('');
      setReplyTo(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to post comment');
    } finally {
      setSubmitting(false);
    }
  }

  async function toggleReaction(emoji: string) {
    const next = new Set(myReactions);
    try {
      if (next.has(emoji)) {
        next.delete(emoji);
        setMyReactions(next);
        await api.reactions.remove(suggestionId, emoji);
        setReactions((prev) => ({ ...prev, [emoji]: Math.max(0, (prev[emoji] || 1) - 1) }));
      } else {
        next.add(emoji);
        setMyReactions(next);
        const { reactions: updated } = await api.reactions.add(suggestionId, emoji);
        setReactions(updated);
      }
    } catch {
      // revert on failure
      setMyReactions(myReactions);
    }
  }

  async function toggleResolved(comment: Comment) {
    setResolvingIds((prev) => new Set(prev).add(comment.id));
    setError('');
    try {
      const updated = await api.comments.setResolved(suggestionId, comment.id, !comment.resolvedAt);
      setComments((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update comment');
    } finally {
      setResolvingIds((prev) => {
        const next = new Set(prev);
        next.delete(comment.id);
        return next;
      });
    }
  }

  function relTime(iso: string) {
    const diff = Date.now() - new Date(iso).getTime();
    const m = Math.max(1, Math.round(diff / 60000));
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.round(h / 24)}d ago`;
  }

  const topLevel = comments.filter((c) => !c.parentId);
  const replies = (parentId: string) => comments.filter((c) => c.parentId === parentId);

  return (
    <div className="discussion">
      <SuggestionBriefPanel
        brief={brief}
        aiEnabled={aiEnabled}
        canManageAi={canManageAi}
        busy={briefBusy}
        onGenerate={onGenerateBrief}
        onMarkUseful={onMarkBriefUseful}
        onDismiss={onDismissBrief}
      />

      <div className="discussion-reactions">
        {EMOJIS.map((emoji) => (
          <button
            key={emoji}
            className={`reaction-btn ${myReactions.has(emoji) ? 'active' : ''}`}
            onClick={() => toggleReaction(emoji)}
            title={`React with ${emoji}`}
          >
            {emoji} {reactions[emoji] ? <span>{reactions[emoji]}</span> : null}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="discussion-loading">Loading comments…</p>
      ) : (
        <div className="discussion-thread">
          {topLevel.length === 0 && <p className="discussion-empty">No comments yet. Start the conversation.</p>}
          {topLevel.map((comment) => (
            <div key={comment.id} className={`comment-thread ${comment.resolvedAt ? 'resolved' : ''}`}>
              <CommentItem
                comment={comment}
                currentUserId={currentUserId}
                onReply={() => setReplyTo(comment.id)}
                onToggleResolved={() => toggleResolved(comment)}
                canResolve
                resolving={resolvingIds.has(comment.id)}
                relTime={relTime}
              />
              {replies(comment.id).map((reply) => (
                <div key={reply.id} className="comment-reply">
                  <CommentItem
                    comment={reply}
                    currentUserId={currentUserId}
                    onReply={() => setReplyTo(comment.id)}
                    onToggleResolved={() => toggleResolved(reply)}
                    canResolve={false}
                    resolving={resolvingIds.has(reply.id)}
                    relTime={relTime}
                  />
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      <div className="discussion-compose">
        {replyTo && (
          <div className="reply-banner">
            Replying to thread
            <button className="btn btn-ghost btn-sm" onClick={() => setReplyTo(null)}>✕ Cancel</button>
          </div>
        )}
        <div className="compose-row">
          <span className="compose-avatar">{currentUserName[0]?.toUpperCase()}</span>
          <textarea
            className="compose-input"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Add a comment… (Ctrl+Enter to submit)"
            rows={2}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submitComment(); }}
          />
          <button className="btn btn-primary btn-sm" onClick={submitComment} disabled={submitting || !body.trim()}>
            {submitting ? '…' : 'Post'}
          </button>
        </div>
        {error && <div className="discussion-error">{error}</div>}
      </div>
    </div>
  );
}

function SuggestionBriefPanel({
  brief,
  aiEnabled,
  canManageAi,
  busy,
  onGenerate,
  onMarkUseful,
  onDismiss
}: {
  brief?: AiArtifact | null;
  aiEnabled: boolean;
  canManageAi: boolean;
  busy: boolean;
  onGenerate?: () => void;
  onMarkUseful?: (artifactId: string) => void;
  onDismiss?: (artifactId: string) => void;
}) {
  const payload = brief ? suggestionBriefPayload(brief.payload) : null;
  return (
    <section className={`ai-brief-panel ${brief?.status || 'empty'}`} aria-label="AI suggestion review brief">
      <div className="ai-brief-header">
        <span>
          <strong>AI review brief</strong>
          <small>{brief ? `${brief.status} · ${Math.round((brief.confidence || payload?.confidence || 0) * 100)}% confidence` : aiEnabled ? 'Optional owner assist' : 'Disabled for this deck'}</small>
        </span>
        {canManageAi ? (
          <button className="button secondary" onClick={onGenerate} disabled={busy || !onGenerate}>
            {busy ? 'Generating…' : brief ? 'Regenerate' : 'Generate brief'}
          </button>
        ) : null}
      </div>

      {payload ? (
        <>
          <div className="ai-brief-metadata">
            <span>Category <b>{label(payload.category)}</b></span>
            <span>Risk <b>{payload.risk}</b></span>
            <span>Impact <b>{payload.impact}</b></span>
            <span>Action <b>{label(payload.recommendedAction)}</b></span>
          </div>
          <p>{payload.rationale}</p>
          {payload.evidence.length ? (
            <ul className="ai-brief-evidence">
              {payload.evidence.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}
            </ul>
          ) : null}
          <small className="ai-brief-trace">
            {brief?.model} · {brief?.promptVersion} · {brief?.createdAt ? new Date(brief.createdAt).toLocaleString() : ''}
          </small>
          {canManageAi && brief && brief.status === 'active' ? (
            <div className="ai-brief-actions">
              <button className="button secondary" onClick={() => onDismiss?.(brief.id)} disabled={busy}>Dismiss</button>
              <button className="button primary" onClick={() => onMarkUseful?.(brief.id)} disabled={busy}>Mark useful</button>
            </div>
          ) : null}
        </>
      ) : (
        <p>{aiEnabled ? 'Generate an advisory brief when you want AI help reviewing this suggestion.' : 'Enable review briefs in deck AI settings to use this advisory workflow.'}</p>
      )}
    </section>
  );
}

function suggestionBriefPayload(payload: Record<string, unknown>): AiSuggestionBriefPayload | null {
  const value = payload as Partial<AiSuggestionBriefPayload>;
  if (!value || typeof value.rationale !== 'string') return null;
  return {
    category: value.category || 'other',
    impact: value.impact || 'low',
    risk: value.risk || 'low',
    recommendedAction: value.recommendedAction || 'review',
    rationale: value.rationale,
    evidence: Array.isArray(value.evidence) ? value.evidence.filter((item): item is string => typeof item === 'string') : [],
    confidence: typeof value.confidence === 'number' ? value.confidence : 0
  };
}

function label(value: string) {
  return value.replaceAll('-', ' ');
}

function renderWithMentions(text: string) {
  const parts = text.split(/(@\w[\w.-]*)/g);
  return parts.map((part, i) =>
    part.startsWith('@') ? <strong key={i} className="mention-highlight">{part}</strong> : part
  );
}

function CommentItem({
  comment, currentUserId, onReply, onToggleResolved, canResolve, resolving, relTime
}: {
  comment: Comment;
  currentUserId: string;
  onReply: () => void;
  onToggleResolved: () => void;
  canResolve: boolean;
  resolving: boolean;
  relTime: (iso: string) => string;
}) {
  const resolved = Boolean(comment.resolvedAt);
  return (
    <div className={`comment ${comment.authorId === currentUserId ? 'own' : ''} ${resolved ? 'resolved' : ''}`}>
      <span className="comment-avatar">{comment.authorName[0]?.toUpperCase()}</span>
      <div className="comment-body">
        <div className="comment-meta">
          <strong>{comment.authorName}</strong>
          <small>{relTime(comment.createdAt)}</small>
          {resolved && <span className="comment-resolved-badge">Resolved</span>}
        </div>
        <p className="comment-text">{renderWithMentions(comment.body)}</p>
        <div className="comment-actions">
          <button className="comment-reply-btn" onClick={onReply}>Reply</button>
          {canResolve && (
            <button
              className="comment-resolve-btn"
              onClick={onToggleResolved}
              disabled={resolving}
              aria-pressed={resolved}
              aria-label={resolved ? 'Mark comment unresolved' : 'Mark comment resolved'}
            >
              {resolving ? 'Saving…' : resolved ? 'Unresolve' : 'Resolve'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
