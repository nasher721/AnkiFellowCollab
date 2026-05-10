import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api, type DeckInvite, type ShareLink } from '../api';
import type { Deck, DeckAiSettings } from '../types';

export interface DeckSettingsViewProps {
  deck: Deck;
  visibility: string;
  canReview: boolean;
  embedCode: string;
  copiedShare: string;
  onCopied: (value: string) => void;
  onSetVisibility: (value: 'public' | 'private' | 'unlisted') => void;
  onRemoveDeck: () => Promise<void>;
}

function shareLinkUrl(token: string) {
  return `${window.location.origin}/share/${encodeURIComponent(token)}`;
}

const SHARE_LINK_LOAD_TIMEOUT_MS = 8000;
const DEFAULT_AI_SETTINGS: DeckAiSettings = {
  reviewBriefs: false,
  embeddings: false,
  conflictSummaries: false,
  diagnostics: false,
  qualityPulse: false,
  updatedAt: null,
  updatedBy: null
};

const AI_SETTING_OPTIONS: Array<{ key: keyof Pick<DeckAiSettings, 'reviewBriefs' | 'embeddings' | 'conflictSummaries' | 'diagnostics' | 'qualityPulse'>; label: string; detail: string }> = [
  { key: 'reviewBriefs', label: 'Review briefs', detail: 'Store advisory summaries for incoming suggestions.' },
  { key: 'embeddings', label: 'Embeddings', detail: 'Allow server-side semantic fingerprints for duplicate detection.' },
  { key: 'conflictSummaries', label: 'Conflict summaries', detail: 'Store advisory summaries for sync conflict review.' },
  { key: 'diagnostics', label: 'Diagnostics', detail: 'Allow grounded setup and sync recovery guidance.' },
  { key: 'qualityPulse', label: 'Quality pulse', detail: 'Allow owner attention items from active AI findings.' }
];

async function copyText(value: string) {
  await navigator.clipboard.writeText(value);
}

export function DeckSettingsView({
  deck,
  visibility,
  canReview,
  embedCode,
  copiedShare,
  onCopied,
  onSetVisibility,
  onRemoveDeck
}: DeckSettingsViewProps) {
  const [shareLinks, setShareLinks] = useState<ShareLink[]>([]);
  const [shareLoading, setShareLoading] = useState(false);
  const [shareError, setShareError] = useState('');
  const [invites, setInvites] = useState<DeckInvite[]>([]);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<DeckInvite['role']>('contributor');
  const [inviteLoading, setInviteLoading] = useState(false);
  const [inviteError, setInviteError] = useState('');
  const [aiSettings, setAiSettings] = useState<DeckAiSettings>({ ...DEFAULT_AI_SETTINGS, ...deck.aiSettings });
  const [aiLoading, setAiLoading] = useState(false);
  const [aiSaving, setAiSaving] = useState(false);
  const [aiError, setAiError] = useState('');
  const [removeOpen, setRemoveOpen] = useState(false);
  const [removeName, setRemoveName] = useState('');
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState('');
  const activeShareRequestRef = useRef(0);
  const primaryShareLink = shareLinks.find((link) => !link.disabledAt) || shareLinks[0] || null;
  const primaryShareUrl = primaryShareLink ? shareLinkUrl(primaryShareLink.token) : '';
  const removeConfirmed = removeName.trim() === deck.name;

  const loadShareLinks = useCallback(async (signal?: AbortSignal) => {
    const requestId = activeShareRequestRef.current + 1;
    activeShareRequestRef.current = requestId;
    setShareLoading(true);
    setShareError('');
    try {
      const { shareLinks: links } = await api.shareLinks.list(deck.id, { signal });
      if (activeShareRequestRef.current !== requestId) return;
      setShareLinks(links);
    } catch (err) {
      if (activeShareRequestRef.current !== requestId) return;
      if (err instanceof Error && err.name === 'AbortError') {
        setShareError('Share links are taking longer than expected. Retry to check again.');
      } else {
        setShareError(err instanceof Error ? err.message : 'Unable to load share links');
      }
    } finally {
      if (activeShareRequestRef.current === requestId) setShareLoading(false);
    }
  }, [deck.id]);

  useEffect(() => {
    if (!canReview) {
      setShareLinks([]);
      setShareError('');
      setShareLoading(false);
      return;
    }
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), SHARE_LINK_LOAD_TIMEOUT_MS);
    loadShareLinks(controller.signal);
    return () => {
      window.clearTimeout(timeout);
      activeShareRequestRef.current += 1;
      controller.abort();
    };
  }, [canReview, deck.id, loadShareLinks]);

  useEffect(() => {
    if (!canReview) { setInvites([]); return; }
    let mounted = true;
    api.invites.list(deck.id)
      .then(({ invites: list }) => { if (mounted) setInvites(list); })
      .catch(() => { /* invites not available in this mode */ });
    return () => { mounted = false; };
  }, [canReview, deck.id]);

  useEffect(() => {
    setAiSettings({ ...DEFAULT_AI_SETTINGS, ...deck.aiSettings });
    setAiError('');
    setRemoveOpen(false);
    setRemoveName('');
    setRemoveError('');
    if (!canReview) return;
    let mounted = true;
    setAiLoading(true);
    api.deckAiSettings.get(deck.id)
      .then(({ settings }) => {
        if (mounted) setAiSettings(settings);
      })
      .catch((err) => {
        if (mounted) setAiError(err instanceof Error ? err.message : 'Unable to load AI settings');
      })
      .finally(() => {
        if (mounted) setAiLoading(false);
      });
    return () => { mounted = false; };
  }, [canReview, deck.id, deck.aiSettings]);

  async function sendInvite(e: FormEvent) {
    e.preventDefault();
    if (!inviteEmail.trim()) return;
    setInviteLoading(true);
    setInviteError('');
    try {
      const { invite } = await api.invites.create(deck.id, inviteEmail.trim(), inviteRole);
      setInvites((prev) => [invite, ...prev]);
      setInviteEmail('');
    } catch (err) {
      setInviteError(err instanceof Error ? err.message : 'Unable to send invite');
    } finally {
      setInviteLoading(false);
    }
  }

  async function revokeInvite(inviteId: string) {
    try {
      await api.invites.revoke(deck.id, inviteId);
      setInvites((prev) => prev.filter((inv) => inv.id !== inviteId));
    } catch (err) {
      setInviteError(err instanceof Error ? err.message : 'Unable to revoke invite');
    }
  }

  async function updateAiSetting(key: keyof Pick<DeckAiSettings, 'reviewBriefs' | 'embeddings' | 'conflictSummaries' | 'diagnostics' | 'qualityPulse'>, enabled: boolean) {
    if (!canReview) return;
    const next = { ...aiSettings, [key]: enabled };
    setAiSettings(next);
    setAiSaving(true);
    setAiError('');
    try {
      const { settings } = await api.deckAiSettings.update(deck.id, {
        reviewBriefs: next.reviewBriefs,
        embeddings: next.embeddings,
        conflictSummaries: next.conflictSummaries,
        diagnostics: next.diagnostics,
        qualityPulse: next.qualityPulse
      });
      setAiSettings(settings);
    } catch (err) {
      setAiSettings(aiSettings);
      setAiError(err instanceof Error ? err.message : 'Unable to update AI settings');
    } finally {
      setAiSaving(false);
    }
  }

  async function createShareLink() {
    setShareLoading(true);
    setShareError('');
    try {
      const { shareLink } = await api.shareLinks.create(deck.id, { label: `${deck.name} share link` });
      setShareLinks((links) => [shareLink, ...links]);
      const url = shareLinkUrl(shareLink.token);
      await copy(url, 'Share link created and copied');
    } catch (err) {
      setShareError(err instanceof Error ? err.message : 'Unable to create share link');
    } finally {
      setShareLoading(false);
    }
  }

  async function confirmRemoveDeck() {
    if (!canReview || !removeConfirmed || removeBusy) return;
    setRemoveBusy(true);
    setRemoveError('');
    try {
      await onRemoveDeck();
    } catch (err) {
      setRemoveError(err instanceof Error ? err.message : 'Unable to remove deck');
      setRemoveBusy(false);
    }
  }

  async function copy(value: string, label: string) {
    if (!value) return;
    try {
      await copyText(value);
      onCopied(label);
      window.setTimeout(() => onCopied(''), 1800);
    } catch {
      onCopied('Copy unavailable');
    }
  }

  return (
    <div className="tab-panel settings-view">
      <div>
        <h2>Deck settings</h2>
        <p>Manage collaboration visibility and prepare share surfaces for this deck.</p>
      </div>
      <div className="settings-grid">
        <section>
          <h3>Access</h3>
          <label className="settings-field">
            <span>Visibility</span>
            <select
              value={visibility}
              onChange={(event) => onSetVisibility(event.target.value as 'public' | 'private' | 'unlisted')}
              disabled={!canReview}
              aria-label="Deck visibility"
            >
              <option value="private">Private</option>
              <option value="unlisted">Unlisted</option>
              <option value="public">Public</option>
            </select>
          </label>
          {!canReview ? <p className="settings-note">Owner access is required to change visibility.</p> : null}
        </section>
        <section>
          <h3>Share link</h3>
          <div className="copy-row">
            <input readOnly value={primaryShareUrl} placeholder="Create a tokenized share link" aria-label="Deck share link" aria-busy={shareLoading} />
            <button className="button secondary" onClick={() => copy(primaryShareUrl, 'Share link copied')} disabled={!primaryShareUrl}>Copy</button>
          </div>
          <button className="button secondary" onClick={createShareLink} disabled={!canReview || shareLoading}>
            {primaryShareLink ? 'Create another share link' : 'Create share link'}
          </button>
          {shareLoading ? <p className="settings-note" role="status">Checking share links...</p> : null}
          {shareError ? (
            <p className="settings-note error">
              {shareError}
              {canReview ? (
                <button className="inline-link-button" type="button" onClick={() => loadShareLinks()}>
                  Retry
                </button>
              ) : null}
            </p>
          ) : null}
          {!canReview ? <p className="settings-note">Owner access is required to create share links.</p> : null}
          <small>Share URLs use backend-generated tokens. Public access depends on the share route and backend availability.</small>
        </section>
        <section>
          <h3>Embed</h3>
          <textarea readOnly value={embedCode} aria-label="Deck embed code" rows={3} />
          <button className="button secondary" onClick={() => copy(embedCode, 'Embed code copied')}>Copy embed code</button>
          <small>Placeholder code for a future embeddable public preview route.</small>
        </section>
        <section>
          <h3>AI owner assist</h3>
          {AI_SETTING_OPTIONS.map((option) => (
            <label className="toggle-row" key={option.key}>
              <input
                type="checkbox"
                checked={Boolean(aiSettings[option.key])}
                disabled={!canReview || aiLoading || aiSaving}
                onChange={(event) => updateAiSetting(option.key, event.target.checked)}
              />
              <span>
                <strong>{option.label}</strong>
                <small>{option.detail}</small>
              </span>
            </label>
          ))}
          {aiLoading ? <p className="settings-note" role="status">Loading AI settings...</p> : null}
          {aiSaving ? <p className="settings-note" role="status">Saving AI settings...</p> : null}
          {aiError ? <p className="settings-note error">{aiError}</p> : null}
          {!canReview ? <p className="settings-note">Owner access is required to change AI settings.</p> : null}
          <small>AI features are off by default. Provider keys and generation stay on the server.</small>
        </section>
        {canReview && (
          <section>
            <h3>Invite collaborators</h3>
            <form className="invite-form" onSubmit={sendInvite}>
              <input
                type="email"
                className="invite-email-input"
                placeholder="colleague@example.com"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                disabled={inviteLoading}
                aria-label="Invite email address"
                required
              />
              <select
                className="invite-role-select"
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value as DeckInvite['role'])}
                disabled={inviteLoading}
                aria-label="Invite role"
              >
                <option value="viewer">Viewer</option>
                <option value="contributor">Contributor</option>
                <option value="reviewer">Reviewer</option>
                <option value="editor">Editor</option>
              </select>
              <button className="button primary" type="submit" disabled={inviteLoading || !inviteEmail.trim()}>
                {inviteLoading ? 'Sending…' : 'Send invite'}
              </button>
            </form>
            {inviteError && <p className="settings-note error">{inviteError}</p>}
            <small>
              Roles: Viewer (read-only) · Contributor (suggest edits) · Reviewer (decide suggestions) · Editor (manage deck)
            </small>
            {invites.length > 0 && (
              <div className="invite-list">
                <h4>Pending invites</h4>
                {invites.map((inv) => (
                  <div key={inv.id} className="invite-row">
                    <span className="invite-email">{inv.email}</span>
                    <span className={`role-badge role-${inv.role}`}>{inv.role}</span>
                    <span className={`invite-status status-${inv.status}`}>{inv.status}</span>
                    {inv.expiresAt && <span className="invite-expiry">exp. {inv.expiresAt.slice(0, 10)}</span>}
                    {inv.status === 'pending' && (
                      <button
                        className="button danger-outline invite-revoke"
                        onClick={() => revokeInvite(inv.id)}
                        aria-label={`Revoke invite for ${inv.email}`}
                      >
                        Revoke
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        )}
        <section className="danger-zone">
          <h3>Remove DeckBridge copy</h3>
          <p>Remove this deck from DeckBridge collaboration only. The original deck in Anki is not changed.</p>
          {!removeOpen ? (
            <button className="button danger-outline" type="button" onClick={() => setRemoveOpen(true)} disabled={!canReview}>
              Remove from DeckBridge
            </button>
          ) : (
            <div className="remove-deck-confirm">
              <label className="settings-field">
                <span>Type deck name to confirm</span>
                <input
                  value={removeName}
                  onChange={(event) => setRemoveName(event.target.value)}
                  placeholder={deck.name}
                  disabled={removeBusy}
                  aria-label="Confirm deck name before removing from DeckBridge"
                />
              </label>
              <div className="confirm-actions">
                <button className="button danger" type="button" onClick={confirmRemoveDeck} disabled={!removeConfirmed || removeBusy}>
                  {removeBusy ? 'Removing...' : 'Remove DeckBridge copy'}
                </button>
                <button className="button secondary" type="button" onClick={() => { setRemoveOpen(false); setRemoveName(''); setRemoveError(''); }} disabled={removeBusy}>
                  Cancel
                </button>
              </div>
              {removeError ? <p className="settings-note error">{removeError}</p> : null}
            </div>
          )}
          {!canReview ? <p className="settings-note">Owner access is required to remove a DeckBridge deck.</p> : null}
        </section>
      </div>
      {copiedShare ? <div className="inline-notice">{copiedShare}</div> : null}
    </div>
  );
}
