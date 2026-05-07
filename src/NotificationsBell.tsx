import { useState, useEffect, useRef, useCallback } from 'react';
import { api, type Notification } from './api';

interface Props {
  pollIntervalMs?: number;
}

export function NotificationsBell({ pollIntervalMs = 30000 }: Props) {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const { notifications: data, unread: count, nextCursor: cursor } = await api.notifications.list({ limit: 20 });
      setNotifications(data);
      setUnread(count);
      setNextCursor(cursor);
    } catch {
      // not available in local dev — silently degrade
    }
  }, []);

  useEffect(() => {
    load();
    const id = window.setInterval(load, pollIntervalMs);
    return () => window.clearInterval(id);
  }, [load, pollIntervalMs]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  async function openPanel() {
    setOpen((prev) => !prev);
    if (!open && unread > 0) {
      setUnread(0);
      setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
      await api.notifications.readAll().catch(() => undefined);
    }
  }

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const { notifications: data, nextCursor: cursor } = await api.notifications.list({ limit: 20, cursor: nextCursor });
      setNotifications((prev) => [...prev, ...data]);
      setNextCursor(cursor);
    } catch {
      // keep existing notifications visible if pagination is temporarily unavailable
    } finally {
      setLoadingMore(false);
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

  const kindIcon: Record<string, string> = {
    suggestion: '✏️',
    decision: '✅',
    comment: '💬',
    reaction: '👍',
  };

  return (
    <div className="notif-bell-wrap" ref={panelRef}>
      <button
        className="notif-bell-btn"
        onClick={openPanel}
        aria-label={`Notifications${unread ? ` — ${unread} unread` : ''}`}
        aria-expanded={open}
      >
        🔔
        {unread > 0 && <span className="notif-badge">{unread > 99 ? '99+' : unread}</span>}
      </button>

      {open && (
        <div className="notif-panel" role="dialog" aria-label="Notifications">
          <div className="notif-panel-header">
            <strong>Notifications</strong>
            {notifications.length > 0 && (
              <button className="btn btn-ghost btn-sm" onClick={async () => {
                setNotifications([]);
                await api.notifications.readAll().catch(() => undefined);
              }}>Clear all</button>
            )}
          </div>
          <div className="notif-list">
            {notifications.length === 0 ? (
              <p className="notif-empty">No notifications yet.</p>
            ) : (
              <>
                {notifications.map((n) => (
                  <div key={n.id} className={`notif-item ${n.read ? '' : 'unread'}`}>
                    <span className="notif-icon">{kindIcon[n.kind] ?? '🔔'}</span>
                    <div className="notif-content">
                      <p>{n.body}</p>
                      <small>{relTime(n.createdAt)}</small>
                    </div>
                  </div>
                ))}
                {nextCursor && (
                  <button className="notif-load-more" onClick={loadMore} disabled={loadingMore}>
                    {loadingMore ? 'Loading...' : 'Load more'}
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
