import { useState, useCallback, useEffect, useMemo } from 'react';
import { ApiRequestError, api, type AddonDownloadAvailability, type AddonVersion, type CreatedToken, type MeResponse } from './api';
import type { AiArtifact, AiSetupDiagnosticPayload, AppState, DeckSummary, StructuredSetupError } from './types';

type Step = 'download' | 'token' | 'map' | 'prove' | 'manual';

interface Props {
  decks: DeckSummary[];
  platformUrl: string;
  currentState: AppState;
  onRefreshState: () => Promise<AppState>;
  onClose: () => void;
}

interface StepIndicatorProps {
  current: Step;
}

const STEPS: { id: Step; label: string }[] = [
  { id: 'download', label: 'Download' },
  { id: 'token', label: 'Authorize' },
  { id: 'map', label: 'Map Deck' },
  { id: 'prove', label: 'Prove Sync' },
];

function StepIndicator({ current }: StepIndicatorProps) {
  const currentIndex = STEPS.findIndex((s) => s.id === (current === 'manual' ? 'map' : current));
  return (
    <div className="wizard-steps">
      {STEPS.map((step, i) => (
        <div
          key={step.id}
          className={`wizard-step ${i < currentIndex ? 'done' : ''} ${step.id === (current === 'manual' ? 'map' : current) ? 'active' : ''}`}
        >
          <span className="wizard-step-number">{i < currentIndex ? '✓' : i + 1}</span>
          <span className="wizard-step-label">{step.label}</span>
          {i < STEPS.length - 1 && <span className="wizard-step-line" />}
        </div>
      ))}
    </div>
  );
}

function syncProofFromState(state: AppState, deckId: string) {
  const summary = state.summaries.find((deck) => deck.id === deckId);
  const deck = state.decks.find((item) => item.id === deckId);
  const lastAddonSync = state.sync.lastAddonSync;
  const syncedAt = lastAddonSync?.syncedAt || summary?.lastSyncedAt || deck?.lastSyncedAt || state.sync.lastPushAt || state.sync.lastPullAt || null;
  return {
    syncedAt,
    lastAddonSync,
    summary,
    conflictCount: state.sync.conflicts.length || lastAddonSync?.stats.conflicts || 0,
    verified: Boolean(lastAddonSync || syncedAt || state.sync.conflicts.length)
  };
}

function relativeProofTime(value?: string | null) {
  if (!value) return 'Not yet';
  const diff = Date.now() - new Date(value).getTime();
  const minutes = Math.max(1, Math.round(diff / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function structuredErrorFromCatch(err: unknown, fallbackPath: string, source: string): StructuredSetupError | null {
  if (err instanceof ApiRequestError) {
    return {
      code: err.code,
      path: err.path || fallbackPath,
      message: err.message,
      status: err.status,
      source,
      details: err.details
    };
  }
  return null;
}

function structuredErrorFromDownload(availability: AddonDownloadAvailability | null): StructuredSetupError | null {
  if (!availability || availability.available || !availability.code || !availability.message) return null;
  return {
    code: availability.code,
    path: '/api/addon/download',
    message: availability.message,
    status: availability.status,
    method: 'HEAD',
    source: 'setup-wizard-download'
  };
}

function isDiagnosticPayload(value: unknown): value is AiSetupDiagnosticPayload {
  const payload = value as Partial<AiSetupDiagnosticPayload>;
  return Boolean(
    payload &&
    typeof payload.summary === 'string' &&
    typeof payload.recommendedAction === 'string' &&
    typeof payload.rationale === 'string' &&
    Array.isArray(payload.recoverySteps) &&
    (payload.risk === 'low' || payload.risk === 'medium' || payload.risk === 'high')
  );
}

export function ConnectAnkiWizard({ decks, platformUrl, currentState, onRefreshState, onClose }: Props) {
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
  const [structuredSetupError, setStructuredSetupError] = useState<StructuredSetupError | null>(null);
  const [diagnosticArtifact, setDiagnosticArtifact] = useState<AiArtifact | null>(null);
  const [diagnosticLoading, setDiagnosticLoading] = useState(false);
  const [diagnosticMessage, setDiagnosticMessage] = useState('');
  const [proofLoading, setProofLoading] = useState(false);
  const [proofError, setProofError] = useState('');
  const [proofState, setProofState] = useState(() => syncProofFromState(currentState, selectedDeckId));
  const [showManualToken, setShowManualToken] = useState(false);
  const localDeckNameForConfig = localDeckName.trim();
  const activeSetupError = structuredSetupError || structuredErrorFromDownload(downloadAvailability);
  const diagnosticPayload = isDiagnosticPayload(diagnosticArtifact?.payload) ? diagnosticArtifact.payload : null;

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

  useEffect(() => {
    setProofState(syncProofFromState(currentState, selectedDeckId));
  }, [currentState, selectedDeckId]);

  const generateToken = useCallback(async () => {
    setGenerating(true);
    setError('');
    setTestResult(null);
    setTestError('');
    try {
      const token = await api.tokens.create('Anki Add-on');
      const nextToken = { ...token, raw: token.raw || token.token || '' };
      setCreatedToken(nextToken);
      const me = await api.meWithToken(nextToken.raw);
      setTestResult(me);
      setStructuredSetupError(null);
      setDiagnosticArtifact(null);
      setDiagnosticMessage('');
      setStep('map');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to prepare the Anki connection');
      setStructuredSetupError(structuredErrorFromCatch(err, '/api/tokens', 'setup-wizard-token'));
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
      setStructuredSetupError(null);
      setDiagnosticArtifact(null);
      setDiagnosticMessage('');
    } catch (err) {
      setTestResult(null);
      setTestError(err instanceof Error ? err.message : 'Token test failed');
      setStructuredSetupError(structuredErrorFromCatch(err, '/api/me', 'setup-wizard-token-test'));
    } finally {
      setTesting(false);
    }
  }, [createdToken]);

  const checkSyncProof = useCallback(async () => {
    setProofLoading(true);
    setProofError('');
    try {
      const nextState = await onRefreshState();
      setProofState(syncProofFromState(nextState, selectedDeckId));
      setStructuredSetupError(null);
      setDiagnosticArtifact(null);
      setDiagnosticMessage('');
    } catch (err) {
      setProofError(err instanceof Error ? err.message : 'Unable to refresh sync proof');
      setStructuredSetupError(structuredErrorFromCatch(err, '/api/state', 'setup-wizard-sync-proof'));
    } finally {
      setProofLoading(false);
    }
  }, [onRefreshState, selectedDeckId]);

  const generateDiagnostic = useCallback(async () => {
    if (!selectedDeckId || !activeSetupError) return;
    setDiagnosticLoading(true);
    setDiagnosticMessage('');
    try {
      const result = await api.aiSetupDiagnostics.generate(selectedDeckId, activeSetupError);
      setDiagnosticArtifact(result.artifact);
      setDiagnosticMessage(result.status === 'created' ? '' : (result.message || 'AI setup diagnostic is unavailable.'));
    } catch (err) {
      setDiagnosticMessage(err instanceof Error ? err.message : 'AI setup diagnostic is unavailable.');
    } finally {
      setDiagnosticLoading(false);
    }
  }, [activeSetupError, selectedDeckId]);

  const diagnosticPanel = activeSetupError ? (
    <div className="wizard-test-card" aria-label="AI setup diagnostic">
      <strong>AI setup diagnostic</strong>
      <span aria-label={`AI diagnostic uses ${activeSetupError.code} at ${activeSetupError.path}: ${activeSetupError.message}`}>
        Uses the structured error shown above for this setup step.
      </span>
      {diagnosticPayload ? (
        <>
          <span>{diagnosticPayload.summary}</span>
          <span>Risk: {diagnosticPayload.risk} · {diagnosticPayload.recommendedAction}</span>
          <span>{diagnosticPayload.rationale}</span>
          {diagnosticPayload.recoverySteps.length ? (
            <ul>
              {diagnosticPayload.recoverySteps.slice(0, 4).map((stepText) => <li key={stepText}>{stepText}</li>)}
            </ul>
          ) : null}
        </>
      ) : (
        <span>{diagnosticMessage || 'Generate recovery guidance from this structured error payload.'}</span>
      )}
      <button className="btn btn-secondary" onClick={generateDiagnostic} disabled={diagnosticLoading || !selectedDeckId}>
        {diagnosticLoading ? 'Generating...' : diagnosticPayload ? 'Refresh diagnostic' : 'Generate diagnostic'}
      </button>
    </div>
  ) : null;

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
              {diagnosticPanel}
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
              <h3>Step 2: Authorize Anki</h3>
              <p>
                DeckBridge will create and test the add-on credential for you. You will
                use a connection link instead of copying an API token by hand.
              </p>
              {error && <div className="wizard-error">{error}</div>}
              {testError ? <div className="wizard-error">{testError}</div> : null}
              {diagnosticPanel}
              <div className="wizard-actions">
                <button className="btn btn-primary" onClick={generateToken} disabled={generating}>
                  {generating ? 'Preparing connection...' : 'Create connection link'}
                </button>
                {createdToken ? (
                  <button className="btn btn-secondary" onClick={() => setStep('map')}>
                    Use existing link
                  </button>
                ) : null}
              </div>
              <div className="wizard-hint-box">
                If you prefer to log in from Anki, open Tools → DeckBridge Sync → Settings
                and use your DeckBridge email and password. The add-on will create its own
                token after login.
              </div>
              <div className="wizard-nav">
                <button className="btn btn-ghost" onClick={() => setStep('download')}>← Back</button>
              </div>
            </div>
          )}

          {step === 'manual' && createdToken && (
            <div className="wizard-step-content">
              <h3>Manual setup</h3>
              <p>
                Manual setup is available if your browser cannot open the connection link.
                In Anki, open <strong>Tools → DeckBridge Sync → Settings</strong> and paste
                these values.
              </p>
              {error && <div className="wizard-error">{error}</div>}
              {diagnosticPanel}
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
                <button className="btn btn-ghost" onClick={() => setStep('map')}>← Back</button>
                <button className="btn btn-primary" onClick={() => setStep('prove')}>Prove sync →</button>
              </div>
            </div>
          )}

          {step === 'map' && (
            <div className="wizard-step-content">
              <h3>Step 3: Map Your Deck</h3>
              <p>
                Choose the DeckBridge target and enter the local Anki deck name you want
                the add-on to sync. Then open the connection link to save everything in Anki.
              </p>
              {testResult ? (
                <div className="wizard-success">
                  Showing decks visible to {testResult.user.email}.
                </div>
              ) : (
                <div className="wizard-hint-box">
                  DeckBridge has not refreshed this token yet. Use Test / Refresh below if the deck list looks wrong.
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
                <div className="wizard-autoconfig wizard-primary-action">
                  <p className="wizard-hint">This saves the platform URL, credential, deck, and conflict policy in Anki.</p>
                  <a href={autoConfigUrl} className="btn btn-primary">Open connection link</a>
                  <button className="btn btn-secondary" onClick={() => copyText(autoConfigUrl)}>
                    Copy link
                  </button>
                </div>
              )}
              {createdToken ? (
                <div className="wizard-test-card">
                  <strong>Connection check</strong>
                  <p>
                    DeckBridge can retest the add-on credential without changing your browser login.
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
                  {diagnosticPanel}
                </div>
              ) : null}
              {createdToken ? (
                <div className="wizard-manual-fallback">
                  <button className="auth-switch" type="button" onClick={() => setShowManualToken((value) => !value)}>
                    {showManualToken ? 'Hide manual token' : 'Show manual token fallback'}
                  </button>
                  {showManualToken ? (
                    <div className="wizard-copy-row wizard-manual-token">
                      <code className="wizard-token-display">{createdToken.raw}</code>
                      <button className="btn btn-secondary btn-sm" onClick={copyToken}>
                        {copied ? '✓ Copied' : 'Copy'}
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : null}
              <p className="wizard-hint">
                After saving add-on settings, click <strong>Test connection</strong> in the
                DeckBridge Sync menu to verify everything works.
              </p>
              <div className="wizard-nav">
                <button className="btn btn-ghost" onClick={() => setStep('token')}>← Back</button>
                {createdToken ? <button className="btn btn-secondary" onClick={() => setStep('manual')}>Manual setup</button> : null}
                <button className="btn btn-primary" onClick={() => setStep('prove')} disabled={!selectedDeckId}>Prove sync →</button>
              </div>
            </div>
          )}

          {step === 'prove' && (
            <div className="wizard-step-content">
              <h3>Step 4: Prove Sync</h3>
              <p>
                Run <strong>Preview push</strong> or <strong>Push Anki deck to DeckBridge</strong> from the
                DeckBridge Sync add-on, then check for the posted sync result here.
              </p>
              <div className="wizard-config-summary">
                <strong>Current setup target</strong>
                <span>DeckBridge deck: {availableDecks.find((deck) => deck.id === selectedDeckId)?.name || selectedDeckId || 'Select a deck'}</span>
                <span>Local Anki deck: {localDeckName || 'Add-on active deck'}</span>
                <span>Conflict policy: {conflictPolicy}</span>
              </div>
              {autoConfigUrl ? (
                <div className="wizard-autoconfig wizard-primary-action">
                  <p className="wizard-hint">Use this again if Anki has not saved the mapping yet.</p>
                  <a href={autoConfigUrl} className="btn btn-secondary">Open connection link</a>
                  <button className="btn btn-secondary" onClick={() => copyText(autoConfigUrl)}>
                    Copy link
                  </button>
                </div>
              ) : null}
              <div className={proofState.verified ? 'wizard-success' : 'wizard-proof-card'}>
                <strong>{proofState.verified ? 'Sync proof captured' : 'Waiting for add-on proof'}</strong>
                {proofState.lastAddonSync ? (
                  <>
                    <span>{proofState.lastAddonSync.stats.total} cards scanned by {proofState.lastAddonSync.client?.name || proofState.lastAddonSync.source}.</span>
                    <span>{proofState.lastAddonSync.stats.created} new · {proofState.lastAddonSync.stats.updated} updated · {proofState.lastAddonSync.stats.skipped} unchanged.</span>
                    <span>{proofState.lastAddonSync.stats.dryRun ? 'Dry-run result' : 'Sync result'} posted {relativeProofTime(proofState.lastAddonSync.syncedAt)}.</span>
                  </>
                ) : (
                  <>
                    <span>Last sync: {relativeProofTime(proofState.syncedAt)}</span>
                    <span>Conflicts: {proofState.conflictCount}</span>
                    <span>{proofState.summary?.cardCount ?? 0} cards visible in this DeckBridge deck.</span>
                  </>
                )}
              </div>
              {proofError ? <div className="wizard-error">{proofError}</div> : null}
              {diagnosticPanel}
              <div className="wizard-actions">
                <button className="btn btn-primary" onClick={checkSyncProof} disabled={proofLoading || !selectedDeckId}>
                  {proofLoading ? 'Checking...' : 'Check for sync result'}
                </button>
                <button className="btn btn-secondary" onClick={onClose} disabled={!proofState.verified}>
                  Go to workbench
                </button>
              </div>
              {!proofState.verified ? (
                <p className="wizard-hint">
                  No posted result yet. Keep this window open, run the add-on dry-run or sync, then check again.
                </p>
              ) : null}
              <div className="wizard-nav">
                <button className="btn btn-ghost" onClick={() => setStep('map')}>← Back</button>
                <button className="btn btn-secondary" onClick={onClose}>Close</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
