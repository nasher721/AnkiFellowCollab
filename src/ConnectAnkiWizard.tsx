import { useState, useCallback, useEffect, useMemo } from 'react';
import { api, type AddonDownloadAvailability, type AddonVersion, type CreatedToken, type MeResponse } from './api';
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
  const [addonVersion, setAddonVersion] = useState<AddonVersion | null>(null);
  const [versionLoading, setVersionLoading] = useState(true);
  const [versionError, setVersionError] = useState('');
  const [downloadAvailability, setDownloadAvailability] = useState<AddonDownloadAvailability | null>(null);
  const [downloadLoading, setDownloadLoading] = useState(true);
  const [createdToken, setCreatedToken] = useState<CreatedToken | null>(null);
  const [copied, setCopied] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');
  const [selectedDeckId, setSelectedDeckId] = useState(decks[0]?.id || '');
  const [localDeckName, setLocalDeckName] = useState('');
  const [conflictPolicy, setConflictPolicy] = useState<'detect' | 'overwrite-platform'>('detect');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<MeResponse | null>(null);
  const [testError, setTestError] = useState('');
  const localDeckNameForConfig = localDeckName.trim();

  const availableDecks = useMemo(() => {
    if (testResult && Array.isArray(testResult.decks)) return testResult.decks;
    return decks;
  }, [decks, testResult]);

  const autoConfigUrl = createdToken && selectedDeckId
    ? [
      `anki://deckbridge?url=${encodeURIComponent(platformUrl)}`,
      `token=${encodeURIComponent(createdToken.raw)}`,
      `deckId=${encodeURIComponent(selectedDeckId)}`,
      localDeckNameForConfig ? `localDeck=${encodeURIComponent(localDeckNameForConfig)}` : null,
      `conflictPolicy=${encodeURIComponent(conflictPolicy)}`
    ].filter(Boolean).join('&')
    : null;

  useEffect(() => {
    let mounted = true;
    setVersionLoading(true);
    setDownloadLoading(true);
    api.addonVersion()
      .then(async (version) => {
        if (!mounted) return;
        setAddonVersion(version);
        setVersionError('');
        const availability = await api.addonDownloadAvailability(version.downloadUrl || '/api/addon/download');
        if (!mounted) return;
        setDownloadAvailability(availability);
      })
      .catch((err) => {
        if (!mounted) return;
        setVersionError(err instanceof Error ? err.message : 'Unable to load add-on version');
        api.addonDownloadAvailability('/api/addon/download').then((availability) => {
          if (!mounted) return;
          setDownloadAvailability(availability);
        });
      })
      .finally(() => {
        if (mounted) {
          setVersionLoading(false);
          setDownloadLoading(false);
        }
      });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!availableDecks.some((deck) => deck.id === selectedDeckId)) {
      setSelectedDeckId(availableDecks[0]?.id || '');
    }
  }, [availableDecks, selectedDeckId]);

  const generateToken = useCallback(async () => {
    setGenerating(true);
    setError('');
    setTestResult(null);
    setTestError('');
    try {
      const token = await api.tokens.create('Anki Add-on');
      setCreatedToken({ ...token, raw: token.raw || token.token || '' });
      setStep('connect');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate token');
    } finally {
      setGenerating(false);
    }
  }, []);

  const copyToken = useCallback(() => {
    if (!createdToken) return;
    if (!navigator.clipboard?.writeText) {
      setError('Clipboard copy is not available in this browser. Select the token and copy it manually.');
      return;
    }
    navigator.clipboard.writeText(createdToken.raw).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => setError('Clipboard copy failed. Select the token and copy it manually.'));
  }, [createdToken]);

  const copyText = useCallback((value: string) => {
    if (!navigator.clipboard?.writeText) {
      setError('Clipboard copy is not available in this browser. Select the value and copy it manually.');
      return;
    }
    navigator.clipboard.writeText(value).catch(() => {
      setError('Clipboard copy failed. Select the value and copy it manually.');
    });
  }, []);

  const testConnection = useCallback(async () => {
    if (!createdToken?.raw) return;
    setTesting(true);
    setTestError('');
    try {
      const me = await api.meWithToken(createdToken.raw);
      setTestResult(me);
    } catch (err) {
      setTestResult(null);
      setTestError(err instanceof Error ? err.message : 'Token test failed');
    } finally {
      setTesting(false);
    }
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
              <div className="wizard-status-card">
                {versionLoading ? (
                  <span>Checking add-on package...</span>
                ) : versionError ? (
                  <span className="wizard-error-inline">Version unavailable: {versionError}</span>
                ) : addonVersion ? (
                  <>
                    <strong>{addonVersion.name || 'DeckBridge Sync'}</strong>
                    <span>Version {addonVersion.version} · Anki {addonVersion.minVersion} or newer</span>
                  </>
                ) : null}
                {downloadLoading ? (
                  <span>Checking download availability...</span>
                ) : downloadAvailability?.available ? (
                  <span className="wizard-success-inline">Download package is ready.</span>
                ) : downloadAvailability ? (
                  <span className="wizard-error-inline">
                    {downloadAvailability.code === 'addon_not_built' ? 'addon_not_built: ' : 'Download unavailable: '}
                    {downloadAvailability.message}
                  </span>
                ) : null}
              </div>
              <div className="wizard-actions">
                <a
                  href={addonVersion?.downloadUrl || '/api/addon/download'}
                  download="deckbridge-sync.ankiaddon"
                  className="btn btn-primary"
                >
                  ↓ Download Add-on
                </a>
              </div>
              {downloadAvailability && !downloadAvailability.available ? (
                <p className="wizard-hint">
                  The direct download link remains available so you can retry after the package is built.
                </p>
              ) : null}
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
              {error && <div className="wizard-error">{error}</div>}
              <div className="wizard-field-row">
                <label>Platform URL</label>
                <div className="wizard-copy-row">
                  <code className="wizard-token-display">{platformUrl}</code>
                  <button className="btn btn-secondary btn-sm" onClick={() => copyText(platformUrl)}>
                    Copy
                  </button>
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
              <p className="wizard-warning">
                Save this token — it won't be shown again.
              </p>
              <div className="wizard-test-card">
                <strong>Test token from this browser</strong>
                <p>
                  This checks <code>/api/me</code> with the new add-on token. It does not save
                  the token in browser storage or replace your current login session.
                </p>
                <button className="btn btn-secondary" onClick={testConnection} disabled={testing || !createdToken.raw}>
                  {testing ? 'Testing...' : 'Test / Refresh'}
                </button>
                {testResult ? (
                  <div className="wizard-success">
                    Connected as {testResult.user.name || testResult.user.email}. {testResult.decks?.length || 0} DeckBridge decks visible.
                  </div>
                ) : null}
                {testError ? <div className="wizard-error">{testError}</div> : null}
              </div>
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
                Choose the DeckBridge target and enter the local Anki deck name you want
                the add-on to sync. Step 3 will replace the manual local-deck field with
                a live Anki deck picker.
              </p>
              {testResult ? (
                <div className="wizard-success">
                  Showing decks visible to {testResult.user.email}.
                </div>
              ) : (
                <div className="wizard-hint-box">
                  Use Test / Refresh on the previous step to confirm token access and refresh this deck list from <code>/api/me</code>.
                </div>
              )}
              {availableDecks.length ? (
                <div className="wizard-field-row">
                  <label htmlFor="wizard-deck-select">DeckBridge Deck</label>
                  <select
                    id="wizard-deck-select"
                    className="wizard-select"
                    value={selectedDeckId}
                    onChange={(e) => setSelectedDeckId(e.target.value)}
                  >
                    {availableDecks.map((deck) => (
                      <option key={deck.id} value={deck.id}>{deck.name}</option>
                    ))}
                  </select>
                </div>
              ) : (
                <div className="wizard-empty-state">
                  No DeckBridge decks are visible to this token. Import or create a deck in DeckBridge, then use Test / Refresh again.
                </div>
              )}
              <div className="wizard-field-row">
                <label htmlFor="wizard-local-deck">Local Anki Deck</label>
                <input
                  id="wizard-local-deck"
                  className="wizard-input"
                  placeholder="Example: Zanki Step 2 CK::Cardiology"
                  value={localDeckName}
                  onChange={(e) => setLocalDeckName(e.target.value)}
                />
              </div>
              <div className="wizard-field-row">
                <label htmlFor="wizard-conflict-policy">Conflict Policy</label>
                <select
                  id="wizard-conflict-policy"
                  className="wizard-select"
                  value={conflictPolicy}
                  onChange={(e) => setConflictPolicy(e.target.value as 'detect' | 'overwrite-platform')}
                >
                  <option value="detect">Detect conflicts</option>
                  <option value="overwrite-platform">Overwrite DeckBridge from Anki</option>
                </select>
              </div>
              <div className="wizard-field-row">
                <label>Deck ID (paste into add-on)</label>
                <div className="wizard-copy-row">
                  <code className="wizard-token-display">{selectedDeckId}</code>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => copyText(selectedDeckId)}
                    disabled={!selectedDeckId}
                  >
                    Copy
                  </button>
                </div>
              </div>
              <div className="wizard-config-summary">
                <strong>Add-on mapping contract</strong>
                <span>Platform URL: {platformUrl}</span>
                <span>DeckBridge deck ID: {selectedDeckId || 'Select a deck'}</span>
                <span>Local Anki deck: {localDeckName || 'Manual entry until add-on deck picker ships'}</span>
                <span>Conflict policy: {conflictPolicy}</span>
              </div>
              {autoConfigUrl && (
                <div className="wizard-autoconfig">
                  <p className="wizard-hint">Open this link after mapping to save these settings in Anki:</p>
                  <a href={autoConfigUrl} className="btn btn-outline">⚡ Auto-Configure with Mapping</a>
                </div>
              )}
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
