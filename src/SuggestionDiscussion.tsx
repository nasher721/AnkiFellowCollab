import { useState, useEffect, useCallback } from 'react';
import { api, type Comment } from './api';

interface Props {
  suggestionId: string;
  currentUserId: string;
  currentUserName: string;
  commentsVersion?: number;
}

const EMOJIS = ['👍', '❓', '✅'] as const;

export function SuggestionDiscussion({ suggestionId, currentUserId, currentUserName, commentsVersion = 0 }: Props) {
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

function renderWithMentions(text: string) {
  const parts = text.split(/(@\w[\w.-]*)/g);
  return parts.map((part, i) =>
    part.startsWith('@') ? <strong key={i} className="mention-highlight">{part}</strong> : part
  );
}

function CommentItem({
  comment, currentUserId, onReply, onToggleResolved, resolving, relTime
}: {
  comment: Comment;
  currentUserId: string;
  onReply: () => void;
  onToggleResolved: () => void;
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
          <button
            className="comment-resolve-btn"
            onClick={onToggleResolved}
            disabled={resolving}
            aria-pressed={resolved}
            aria-label={resolved ? 'Mark comment unresolved' : 'Mark comment resolved'}
          >
            {resolving ? 'Saving…' : resolved ? 'Unresolve' : 'Resolve'}
          </button>
        </div>
      </div>
    </div>
  );
}
