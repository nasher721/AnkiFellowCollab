import type { Toast } from '../hooks/common';
import { TOAST_ICONS } from '../hooks/common';

export function ToastStack({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: string) => void }) {
  if (!toasts.length) return null;
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast--${t.type}`}>
          <span className="toast__icon" aria-hidden="true">{TOAST_ICONS[t.type]}</span>
          <span className="toast__message">{t.message}</span>
          <button className="toast__dismiss" onClick={() => onDismiss(t.id)} aria-label="Dismiss notification">✕</button>
        </div>
      ))}
    </div>
  );
}
