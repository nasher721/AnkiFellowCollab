import { useState, useEffect, useCallback } from 'react';
import { api, type Comment } from './api';

interface Props {
  suggestionId: string;
  currentUserId: string;
  currentUserName: string;
}

const EMOJIS = ['👍', '❓', '✅'] as const;

export function SuggestionDiscussion({ suggestionId, currentUserId, currentUserName }: Props) {
  const [comments, setComments] = useState<Comment[]>([]);
  const [reactions, setReactions] = useState<Record<string, number>>({});
  const [myReactions, setMyReactions] = useState<Set<string>>(new Set());
  const [body, setBody] = useState('');
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
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

  useEffect(() => { load(); }, [load]);

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
            <div key={comment.id} className="comment-thread">
              <CommentItem
                comment={comment}
                currentUserId={currentUserId}
                onReply={() => setReplyTo(comment.id)}
                relTime={relTime}
              />
              {replies(comment.id).map((reply) => (
                <div key={reply.id} className="comment-reply">
                  <CommentItem
                    comment={reply}
                    currentUserId={currentUserId}
                    onReply={() => setReplyTo(comment.id)}
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
  comment, currentUserId, onReply, relTime
}: {
  comment: Comment;
  currentUserId: string;
  onReply: () => void;
  relTime: (iso: string) => string;
}) {
  return (
    <div className={`comment ${comment.authorId === currentUserId ? 'own' : ''}`}>
      <span className="comment-avatar">{comment.authorName[0]?.toUpperCase()}</span>
      <div className="comment-body">
        <div className="comment-meta">
          <strong>{comment.authorName}</strong>
          <small>{relTime(comment.createdAt)}</small>
        </div>
        <p className="comment-text">{renderWithMentions(comment.body)}</p>
        <button className="comment-reply-btn" onClick={onReply}>Reply</button>
      </div>
    </div>
  );
}
