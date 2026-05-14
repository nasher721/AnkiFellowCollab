import { type FormEvent } from 'react';
import { Icon } from './Icon';

export function AuthScreen({
  authMode,
  authEmail,
  authPassword,
  authBusy,
  authNotice,
  onSubmit,
  onEmailChange,
  onPasswordChange,
  onToggleMode
}: {
  authMode: 'sign-in' | 'sign-up';
  authEmail: string;
  authPassword: string;
  authBusy: boolean;
  authNotice: string;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onEmailChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onToggleMode: () => void;
}) {
  const isSignIn = authMode === 'sign-in';
  return (
    <div className="auth-screen">
      <section className="auth-hero" aria-label="DeckBridge sign in">
        <div className="auth-visual" aria-hidden="true">
          <div className="auth-visual-ribbon ribbon-a" />
          <div className="auth-visual-ribbon ribbon-b" />
          <div className="auth-visual-ribbon ribbon-c" />
          <div className="auth-preview-card preview-owner">
            <span>Owner review</span>
            <strong>12 changes ready</strong>
            <em>ABPN NCC deck</em>
          </div>
          <div className="auth-preview-card preview-sync">
            <span>Anki bridge</span>
            <strong>Dry-run passed</strong>
            <em>285 notes scanned</em>
          </div>
          <div className="auth-preview-card preview-source">
            <span>Source-backed edits</span>
            <strong>3 conflicts held</strong>
            <em>No silent overwrites</em>
          </div>
          <div className="auth-lattice">
            {Array.from({ length: 28 }, (_, index) => <i key={`lattice-${index}`} />)}
          </div>
        </div>
        <div className="auth-copy">
          <div className="auth-brandline">
            <span className="brand-mark"><Icon name="cards" /></span>
            <span>DeckBridge</span>
          </div>
          <h1>Bring every Anki deck review into one calm command center.</h1>
          <p>
            Sync from Anki, review collaborator edits, protect source-backed cards, and keep the owner in control before changes land.
          </p>
          <div className="auth-proof-strip" aria-label="DeckBridge highlights">
            <span><Icon name="sync" /> Local add-on sync</span>
            <span><Icon name="users" /> Study group review</span>
            <span><Icon name="check" /> Owner approval</span>
          </div>
        </div>
      </section>

      <section className="auth-panel" aria-label={isSignIn ? 'Sign in to DeckBridge' : 'Create a DeckBridge account'}>
        <div className="auth-panel-heading">
          <span className="auth-kicker">{isSignIn ? 'Welcome back' : 'Start your workspace'}</span>
          <h2>{isSignIn ? 'Sign in to DeckBridge' : 'Create your DeckBridge account'}</h2>
          <p className="auth-subtitle">
            {isSignIn
              ? 'One account unlocks the web workspace and the Anki add-on token flow.'
              : 'Create an account, then let DeckBridge issue the add-on credential for Anki.'}
          </p>
        </div>
        <form className="auth-form" onSubmit={onSubmit}>
          <label>
            <span>Email</span>
            <input
              aria-label="Email"
              autoComplete="email"
              placeholder="you@example.com"
              type="email"
              value={authEmail}
              onChange={(event) => onEmailChange(event.target.value)}
              required
            />
          </label>
          <label>
            <span>Password</span>
            <input
              aria-label="Password"
              autoComplete={isSignIn ? 'current-password' : 'new-password'}
              placeholder="Enter your password"
              type="password"
              minLength={6}
              value={authPassword}
              onChange={(event) => onPasswordChange(event.target.value)}
              required
            />
          </label>
          <button className="button primary auth-submit" type="submit" disabled={authBusy}>
            {authBusy ? 'Working...' : isSignIn ? 'Sign in' : 'Create account'}
          </button>
        </form>
        <button className="auth-switch" type="button" onClick={onToggleMode}>
          {isSignIn ? 'Create a new DeckBridge account' : 'Use an existing DeckBridge account'}
        </button>
        {authNotice ? <p className="auth-notice" role="alert">{authNotice}</p> : null}
      </section>
    </div>
  );
}
