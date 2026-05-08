import { useEffect, useState, type FormEvent } from 'react';
import { api, type DeckInvite, type ShareLink } from '../api';
import type { Deck } from '../types';

export interface DeckSettingsViewProps {
  deck: Deck;
  visibility: string;
  canReview: boolean;
  embedCode: string;
  copiedShare: string;
  onCopied: (value: string) => void;
  onSetVisibility: (value: 'public' | 'private' | 'unlisted') => void;
}

function shareLinkUrl(token: string) {
  return `${window.location.origin}/share/${encodeURIComponent(token)}`;
}

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
  onSetVisibility
}: DeckSettingsViewProps) {
  const [shareLinks, setShareLinks] = useState<ShareLink[]>([]);
  const [shareLoading, setShareLoading] = useState(false);
  const [shareError, setShareError] = useState('');
  const [invites, setInvites] = useState<DeckInvite[]>([]);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<DeckInvite['role']>('contributor');
  const [inviteLoading, setInviteLoading] = useState(false);
  const [inviteError, setInviteError] = useState('');
  const primaryShareLink = shareLinks.find((link) => !link.disabledAt) || shareLinks[0] || null;
  const primaryShareUrl = primaryShareLink ? shareLinkUrl(primaryShareLink.token) : '';

  useEffect(() => {
    if (!canReview) {
      setShareLinks([]);
      setShareError('');
      return;
    }
    let mounted = true;
    setShareLoading(true);
    setShareError('');
    api.shareLinks.list(deck.id)
      .then(({ shareLinks: links }) => {
        if (mounted) setShareLinks(links);
      })
      .catch((err) => {
        if (mounted) setShareError(err instanceof Error ? err.message : 'Unable to load share links');
      })
      .finally(() => {
        if (mounted) setShareLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [canReview, deck.id]);

  useEffect(() => {
    if (!canReview) { setInvites([]); return; }
    let mounted = true;
    api.invites.list(deck.id)
      .then(({ invites: list }) => { if (mounted) setInvites(list); })
      .catch(() => { /* invites not available in this mode */ });
    return () => { mounted = false; };
  }, [canReview, deck.id]);

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
            <input readOnly value={primaryShareUrl} placeholder={shareLoading ? 'Loading share links...' : 'Create a tokenized share link'} aria-label="Deck share link" />
            <button className="button secondary" onClick={() => copy(primaryShareUrl, 'Share link copied')} disabled={!primaryShareUrl}>Copy</button>
          </div>
          <button className="button secondary" onClick={createShareLink} disabled={!canReview || shareLoading}>
            {primaryShareLink ? 'Create another share link' : 'Create share link'}
          </button>
          {shareError ? <p className="settings-note">{shareError}</p> : null}
          {!canReview ? <p className="settings-note">Owner access is required to create share links.</p> : null}
          <small>Share URLs use backend-generated tokens. Public access depends on the share route and backend availability.</small>
        </section>
        <section>
          <h3>Embed</h3>
          <textarea readOnly value={embedCode} aria-label="Deck embed code" rows={3} />
          <button className="button secondary" onClick={() => copy(embedCode, 'Embed code copied')}>Copy embed code</button>
          <small>Placeholder code for a future embeddable public preview route.</small>
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
      </div>
      {copiedShare ? <div className="inline-notice">{copiedShare}</div> : null}
    </div>
  );
}
