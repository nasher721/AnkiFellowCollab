import { useState, useEffect, useRef, useCallback } from 'react';
import { api, type Notification } from './api';

interface Props {
  pollIntervalMs?: number;
}

interface NotificationPageState {
  notifications: Notification[];
  nextCursor: string | null;
}

function mergeNotificationRefresh(
  prev: NotificationPageState,
  refreshedNotifications: Notification[],
  refreshedNextCursor: string | null,
  preserveLoadedRows: boolean
): NotificationPageState {
  if (!preserveLoadedRows) {
    return { notifications: refreshedNotifications, nextCursor: refreshedNextCursor };
  }
  const refreshedIds = new Set(refreshedNotifications.map((notification) => notification.id));
  return {
    notifications: [
      ...refreshedNotifications,
      ...prev.notifications.filter((notification) => !refreshedIds.has(notification.id))
    ],
    nextCursor: prev.nextCursor ?? refreshedNextCursor
  };
}

export function NotificationsBell({ pollIntervalMs = 30000 }: Props) {
  const [notificationPage, setNotificationPage] = useState<NotificationPageState>({
    notifications: [],
    nextCursor: null
  });
  const [unread, setUnread] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const openRef = useRef(false);
  const loadingMoreRef = useRef(false);
  const { notifications, nextCursor } = notificationPage;

  const load = useCallback(async () => {
    try {
      const { notifications: data, unread: count, nextCursor: cursor } = await api.notifications.list({ limit: 20 });
      setNotificationPage((prev) => {
        const preserveLoadedRows = openRef.current || loadingMoreRef.current;
        return mergeNotificationRefresh(prev, data, cursor, preserveLoadedRows);
      });
      setUnread(count);
    } catch {
      // not available in local dev — silently degrade
    }
  }, []);

  useEffect(() => {
    openRef.current = open;
  }, [open]);

  useEffect(() => {
    loadingMoreRef.current = loadingMore;
  }, [loadingMore]);

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
    const opening = !open;
    openRef.current = opening;
    setOpen(opening);
    if (!open && unread > 0) {
      setUnread(0);
      setNotificationPage((prev) => ({
        ...prev,
        notifications: prev.notifications.map((n) => ({ ...n, read: true }))
      }));
      await api.notifications.readAll().catch(() => undefined);
    }
  }

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const { notifications: data, nextCursor: cursor } = await api.notifications.list({ limit: 20, cursor: nextCursor });
      setNotificationPage((prev) => ({
        notifications: [...prev.notifications, ...data],
        nextCursor: cursor
      }));
    } catch {
      setLoadMoreError('Unable to load more notifications.');
    } finally {
      loadingMoreRef.current = false;
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
                setNotificationPage({ notifications: [], nextCursor: null });
                setLoadMoreError(null);
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
                {loadMoreError && <p className="notif-error">{loadMoreError}</p>}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
