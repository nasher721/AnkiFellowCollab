import { useState, useCallback } from 'react';
import { api, type CreatedToken } from './api';
import type { DeckSummary } from './types';

type Step = 'download' | 'token' | 'connect' | 'map';

interface Props {
  decks: DeckSummary[];
  platformUrl: string;
  onClose: () => void;
}

interface StepIndicatorProps {
  current: Step;
}

const STEPS: { id: Step; label: string }[] = [
  { id: 'download', label: 'Download' },
  { id: 'token', label: 'Get Token' },
  { id: 'connect', label: 'Connect' },
  { id: 'map', label: 'Map Deck' },
];

function StepIndicator({ current }: StepIndicatorProps) {
  const currentIndex = STEPS.findIndex((s) => s.id === current);
  return (
    <div className="wizard-steps">
      {STEPS.map((step, i) => (
        <div
          key={step.id}
          className={`wizard-step ${i < currentIndex ? 'done' : ''} ${step.id === current ? 'active' : ''}`}
        >
          <span className="wizard-step-number">{i < currentIndex ? '✓' : i + 1}</span>
          <span className="wizard-step-label">{step.label}</span>
          {i < STEPS.length - 1 && <span className="wizard-step-line" />}
        </div>
      ))}
    </div>
  );
}

export function ConnectAnkiWizard({ decks, platformUrl, onClose }: Props) {
  const [step, setStep] = useState<Step>('download');
  const [createdToken, setCreatedToken] = useState<CreatedToken | null>(null);
  const [copied, setCopied] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');
  const [selectedDeckId, setSelectedDeckId] = useState(decks[0]?.id || '');

  const autoConfigUrl = createdToken && selectedDeckId
    ? `anki://deckbridge?url=${encodeURIComponent(platformUrl)}&token=${encodeURIComponent(createdToken.raw)}&deckId=${encodeURIComponent(selectedDeckId)}`
    : null;

  const generateToken = useCallback(async () => {
    setGenerating(true);
    setError('');
    try {
      const token = await api.tokens.create('Anki Add-on');
      setCreatedToken(token);
      setStep('connect');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate token');
    } finally {
      setGenerating(false);
    }
  }, []);

  const copyToken = useCallback(() => {
    if (!createdToken) return;
    navigator.clipboard.writeText(createdToken.raw).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [createdToken]);

  return (
    <div className="wizard-overlay" role="dialog" aria-modal="true" aria-label="Connect Anki Add-on">
      <div className="wizard-panel">
        <div className="wizard-header">
          <h2>Connect Anki</h2>
          <button className="wizard-close" onClick={onClose} aria-label="Close wizard">✕</button>
        </div>

        <StepIndicator current={step} />

        <div className="wizard-body">
          {step === 'download' && (
            <div className="wizard-step-content">
              <h3>Step 1: Install the Add-on</h3>
              <p>Download the DeckBridge Sync add-on and open the file in Anki to install it.</p>
              <div className="wizard-actions">
                <a
                  href="/api/addon/download"
                  download="deckbridge-sync.ankiaddon"
                  className="btn btn-primary"
                >
                  ↓ Download Add-on
                </a>
              </div>
              <p className="wizard-hint">
                After downloading, double-click the <code>.ankiaddon</code> file or open it via
                Anki → Tools → Add-ons → Install from file.
              </p>
              <div className="wizard-nav">
                <button className="btn btn-secondary" onClick={() => setStep('token')}>
                  Already installed → Next
                </button>
              </div>
            </div>
          )}

          {step === 'token' && (
            <div className="wizard-step-content">
              <h3>Step 2: Generate Your Token</h3>
              <p>Generate a secure API token. You'll paste this into the add-on once.</p>
              {error && <div className="wizard-error">{error}</div>}
              <div className="wizard-actions">
                <button className="btn btn-primary" onClick={generateToken} disabled={generating}>
                  {generating ? 'Generating…' : 'Generate Token'}
                </button>
              </div>
              <div className="wizard-nav">
                <button className="btn btn-ghost" onClick={() => setStep('download')}>← Back</button>
              </div>
            </div>
          )}

          {step === 'connect' && createdToken && (
            <div className="wizard-step-content">
              <h3>Step 3: Connect the Add-on</h3>
              <p>
                In Anki, open <strong>Tools → DeckBridge Sync → Settings</strong> and paste
                these values:
              </p>
              <div className="wizard-field-row">
                <label>Platform URL</label>
                <div className="wizard-copy-row">
                  <code className="wizard-token-display">{platformUrl}</code>
                </div>
              </div>
              <div className="wizard-field-row">
                <label>API Token</label>
                <div className="wizard-copy-row">
                  <code className="wizard-token-display">{createdToken.raw}</code>
                  <button className="btn btn-secondary btn-sm" onClick={copyToken}>
                    {copied ? '✓ Copied' : 'Copy'}
                  </button>
                </div>
              </div>
              {autoConfigUrl && (
                <div className="wizard-autoconfig">
                  <p className="wizard-hint">Or click to auto-configure if Anki is open:</p>
                  <a href={autoConfigUrl} className="btn btn-outline">⚡ Auto-Configure</a>
                </div>
              )}
              <p className="wizard-warning">
                Save this token — it won't be shown again.
              </p>
              <div className="wizard-nav">
                <button className="btn btn-ghost" onClick={() => setStep('token')}>← Back</button>
                <button className="btn btn-primary" onClick={() => setStep('map')}>Next →</button>
              </div>
            </div>
          )}

          {step === 'map' && (
            <div className="wizard-step-content">
              <h3>Step 4: Map Your Deck</h3>
              <p>
                In the add-on Settings, enter your local Anki deck name, then select which
                DeckBridge deck to sync it with:
              </p>
              <div className="wizard-field-row">
                <label htmlFor="wizard-deck-select">DeckBridge Deck</label>
                <select
                  id="wizard-deck-select"
                  className="wizard-select"
                  value={selectedDeckId}
                  onChange={(e) => setSelectedDeckId(e.target.value)}
                >
                  {decks.map((deck) => (
                    <option key={deck.id} value={deck.id}>{deck.name}</option>
                  ))}
                </select>
              </div>
              <div className="wizard-field-row">
                <label>Deck ID (paste into add-on)</label>
                <div className="wizard-copy-row">
                  <code className="wizard-token-display">{selectedDeckId}</code>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => navigator.clipboard.writeText(selectedDeckId)}
                  >
                    Copy
                  </button>
                </div>
              </div>
              <p className="wizard-hint">
                After saving add-on settings, click <strong>Test connection</strong> in the
                DeckBridge Sync menu to verify everything works.
              </p>
              <div className="wizard-nav">
                <button className="btn btn-ghost" onClick={() => setStep('connect')}>← Back</button>
                <button className="btn btn-primary" onClick={onClose}>Done ✓</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
