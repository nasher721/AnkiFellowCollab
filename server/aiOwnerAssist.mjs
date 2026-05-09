import { createHash } from 'node:crypto';

export const SUGGESTION_BRIEF_PROMPT_VERSION = 'suggestion-review-brief-v1';
export const CONFLICT_SUMMARY_PROMPT_VERSION = 'conflict-summary-v1';
export const SETUP_DIAGNOSTIC_PROMPT_VERSION = 'setup-diagnostic-v1';

const BRIEF_CATEGORIES = new Set([
  'grammar',
  'formatting',
  'factual-correction',
  'duplicate-risk',
  'style-cleanup',
  'quality-risk',
  'other'
]);
const IMPACT_LEVELS = new Set(['low', 'medium', 'high']);
const RISK_LEVELS = new Set(['low', 'medium', 'high']);
const CONFLICT_RECOMMENDATIONS = new Set(['keep-local', 'use-incoming', 'skip-for-now', 'manual-review']);
const RECOMMENDED_ACTIONS = new Set([
  'review',
  'accept-with-care',
  'request-revision',
  'compare-duplicate',
  'dismiss'
]);

export function inputHash(value) {
  return createHash('sha256')
    .update(JSON.stringify(value ?? null))
    .digest('hex');
}

export function validateObject(value, requiredKeys = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, message: 'AI response must be a JSON object' };
  }
  for (const key of requiredKeys) {
    if (!(key in value)) {
      return { ok: false, message: `AI response is missing ${key}` };
    }
  }
  return { ok: true };
}

export function normalizeAiArtifactBase({
  kind,
  subjectType,
  subjectId,
  model,
  promptVersion,
  input,
  confidence = 0,
  severity = 'info',
  status = 'active',
  payload = {}
}) {
  return {
    kind,
    subjectType,
    subjectId,
    severity,
    status,
    confidence,
    model,
    promptVersion,
    inputHash: inputHash(input),
    payload,
    createdAt: new Date().toISOString()
  };
}

export function buildSuggestionBriefInput({ deck, card, suggestion }) {
  return {
    deck: {
      id: deck.id,
      name: deck.name,
      description: deck.description || '',
      cardCount: Array.isArray(deck.cards) ? deck.cards.length : 0,
      source: {
        deckName: deck.source?.deckName || null,
        deckPath: deck.source?.deckPath || null,
        format: deck.source?.format || null
      },
      noteTypes: Array.from(new Set((deck.cards || []).map((item) => item.modelName || item.type || 'Unknown'))).slice(0, 20),
      topTags: topTags(deck.cards || [])
    },
    card: {
      id: card.id,
      type: card.type,
      modelName: card.modelName || card.type,
      fieldOrder: card.fieldOrder || Object.keys(card.fields || {}),
      fields: card.fields || {},
      tags: card.tags || [],
      state: card.state || null,
      suspended: Boolean(card.suspended)
    },
    suggestion: {
      id: suggestion.id,
      authorName: suggestion.authorName,
      status: suggestion.status,
      reason: suggestion.reason || '',
      proposedFields: suggestion.proposedFields || {},
      proposedTags: suggestion.proposedTags || [],
      createdAt: suggestion.createdAt
    }
  };
}

export async function generateSuggestionReviewBrief({ aiGateway, deck, card, suggestion }) {
  const input = buildSuggestionBriefInput({ deck, card, suggestion });
  const result = await aiGateway.chatJson({
    messages: [
      {
        role: 'system',
        content: [
          'You are an advisory reviewer for DeckBridge Anki card suggestions.',
          'Return only JSON. Do not rewrite card content. Do not decide for the owner.',
          'Evaluate whether the proposed fields/tags look useful, risky, or need revision.',
          'Ground evidence only in the provided existing card, proposed changes, reason, and deck context.'
        ].join(' ')
      },
      {
        role: 'user',
        content: JSON.stringify({
          task: 'Create an owner-facing suggestion review brief.',
          outputShape: {
            category: 'grammar | formatting | factual-correction | duplicate-risk | style-cleanup | quality-risk | other',
            impact: 'low | medium | high',
            risk: 'low | medium | high',
            recommendedAction: 'review | accept-with-care | request-revision | compare-duplicate | dismiss',
            rationale: 'one or two concise sentences',
            evidence: ['short evidence item grounded in provided input'],
            confidence: 'number from 0 to 1'
          },
          input
        })
      }
    ],
    validate: validateSuggestionBriefPayload,
    temperature: 0.1,
    maxTokens: 700
  });
  const payload = normalizeSuggestionBriefPayload(result.value);
  return {
    artifact: normalizeAiArtifactBase({
      kind: 'review-brief',
      subjectType: 'suggestion',
      subjectId: suggestion.id,
      model: result.model,
      promptVersion: SUGGESTION_BRIEF_PROMPT_VERSION,
      input,
      confidence: payload.confidence,
      severity: severityFromBrief(payload),
      status: 'active',
      payload
    }),
    input
  };
}

export function buildConflictSummaryInput({ deck, conflict }) {
  return {
    deck: {
      id: deck.id,
      name: deck.name,
      cardCount: Array.isArray(deck.cards) ? deck.cards.length : 0
    },
    conflict: {
      id: conflict.id,
      deckId: conflict.deckId,
      cardId: conflict.cardId,
      source: conflict.source || 'unknown',
      detectedAt: conflict.detectedAt || null,
      localFields: boundRecord(conflict.localFields || {}, 24, 2000),
      incomingFields: boundRecord(conflict.incomingFields || {}, 24, 2000)
    }
  };
}

export async function generateConflictSummary({ aiGateway, deck, conflict }) {
  const input = buildConflictSummaryInput({ deck, conflict });
  const result = await aiGateway.chatJson({
    messages: [
      {
        role: 'system',
        content: [
          'You are an advisory sync-conflict reviewer for DeckBridge Anki cards.',
          'Return only JSON. Do not rewrite card content. Do not decide for the owner.',
          'Use only the provided local and incoming fields. Do not infer facts outside those fields.',
          'Recommend a review direction while keeping the owner in control.'
        ].join(' ')
      },
      {
        role: 'user',
        content: JSON.stringify({
          task: 'Summarize a DeckBridge sync conflict for owner review.',
          outputShape: {
            summary: 'one concise sentence describing what changed',
            risk: 'low | medium | high',
            recommendation: 'keep-local | use-incoming | skip-for-now | manual-review',
            rationale: 'one or two concise sentences grounded in localFields and incomingFields',
            evidence: ['short cited field comparison from the provided conflict'],
            confidence: 'number from 0 to 1'
          },
          input
        })
      }
    ],
    validate: validateConflictSummaryPayload,
    temperature: 0.1,
    maxTokens: 700
  });
  const payload = normalizeConflictSummaryPayload(result.value);
  return {
    artifact: normalizeAiArtifactBase({
      kind: 'conflict-summary',
      subjectType: 'conflict',
      subjectId: conflict.id,
      model: result.model,
      promptVersion: CONFLICT_SUMMARY_PROMPT_VERSION,
      input,
      confidence: payload.confidence,
      severity: severityFromRisk(payload.risk),
      status: 'active',
      payload
    }),
    input
  };
}

export function buildSetupDiagnosticInput({ deck, error }) {
  return {
    deck: deck ? {
      id: deck.id,
      name: deck.name,
      cardCount: Array.isArray(deck.cards) ? deck.cards.length : 0
    } : null,
    error: {
      code: cleanString(error.code, 120),
      path: cleanString(error.path, 240),
      message: cleanString(error.message, 1000),
      status: Number.isFinite(Number(error.status)) ? Number(error.status) : null,
      method: cleanString(error.method || '', 20) || null,
      source: cleanString(error.source || 'setup-wizard', 120),
      details: boundRecord(error.details || {}, 16, 600)
    }
  };
}

export async function generateSetupDiagnostic({ aiGateway, deck, error }) {
  const input = buildSetupDiagnosticInput({ deck, error });
  const result = await aiGateway.chatJson({
    messages: [
      {
        role: 'system',
        content: [
          'You are an advisory DeckBridge setup and sync diagnostic assistant.',
          'Return only JSON. Use only the structured error payload provided.',
          'Do not invent external causes, service outages, credentials, local files, or Anki state not present in the payload.',
          'Every rationale must cite the provided error code, path, status, or message.'
        ].join(' ')
      },
      {
        role: 'user',
        content: JSON.stringify({
          task: 'Create grounded setup or sync recovery guidance from the structured error payload.',
          outputShape: {
            summary: 'one concise sentence',
            risk: 'low | medium | high',
            recommendedAction: 'one concise action grounded in the error payload',
            rationale: 'one or two concise sentences that cite the error code/path/message used',
            recoverySteps: ['short concrete step grounded in the payload'],
            citedError: {
              code: 'same error code from input',
              path: 'same path from input',
              message: 'same message from input'
            },
            confidence: 'number from 0 to 1'
          },
          input
        })
      }
    ],
    validate: (value) => validateSetupDiagnosticPayload(value, input.error),
    temperature: 0.1,
    maxTokens: 800
  });
  const validation = validateSetupDiagnosticPayload(result.value, input.error);
  if (validation.ok !== true) {
    const error = new Error(validation.message || 'AI response failed validation');
    error.code = 'ai_validation_failed';
    throw error;
  }
  const payload = normalizeSetupDiagnosticPayload(result.value, input.error);
  return {
    artifact: normalizeAiArtifactBase({
      kind: 'diagnostic',
      subjectType: 'setup-error',
      subjectId: `setup-error:${inputHash(input).slice(0, 16)}`,
      model: result.model,
      promptVersion: SETUP_DIAGNOSTIC_PROMPT_VERSION,
      input,
      confidence: payload.confidence,
      severity: severityFromRisk(payload.risk),
      status: 'active',
      payload
    }),
    input
  };
}

export function validateSuggestionBriefPayload(value) {
  const base = validateObject(value, ['category', 'impact', 'risk', 'recommendedAction', 'rationale', 'evidence', 'confidence']);
  if (base.ok !== true) return base;
  if (!BRIEF_CATEGORIES.has(value.category)) return { ok: false, message: 'AI response has invalid category' };
  if (!IMPACT_LEVELS.has(value.impact)) return { ok: false, message: 'AI response has invalid impact' };
  if (!RISK_LEVELS.has(value.risk)) return { ok: false, message: 'AI response has invalid risk' };
  if (!RECOMMENDED_ACTIONS.has(value.recommendedAction)) return { ok: false, message: 'AI response has invalid recommendedAction' };
  if (typeof value.rationale !== 'string' || !value.rationale.trim()) return { ok: false, message: 'AI response must include rationale' };
  if (!Array.isArray(value.evidence) || value.evidence.some((item) => typeof item !== 'string')) {
    return { ok: false, message: 'AI response evidence must be an array of strings' };
  }
  const confidence = Number(value.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return { ok: false, message: 'AI response confidence must be between 0 and 1' };
  }
  return { ok: true };
}

export function validateConflictSummaryPayload(value) {
  const base = validateObject(value, ['summary', 'risk', 'recommendation', 'rationale', 'evidence', 'confidence']);
  if (base.ok !== true) return base;
  if (typeof value.summary !== 'string' || !value.summary.trim()) return { ok: false, message: 'AI response must include summary' };
  if (!RISK_LEVELS.has(value.risk)) return { ok: false, message: 'AI response has invalid risk' };
  if (!CONFLICT_RECOMMENDATIONS.has(value.recommendation)) return { ok: false, message: 'AI response has invalid recommendation' };
  if (typeof value.rationale !== 'string' || !value.rationale.trim()) return { ok: false, message: 'AI response must include rationale' };
  if (!Array.isArray(value.evidence) || value.evidence.some((item) => typeof item !== 'string')) {
    return { ok: false, message: 'AI response evidence must be an array of strings' };
  }
  const confidence = Number(value.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return { ok: false, message: 'AI response confidence must be between 0 and 1' };
  }
  return { ok: true };
}

export function validateSetupDiagnosticPayload(value, expectedError = null) {
  const base = validateObject(value, ['summary', 'risk', 'recommendedAction', 'rationale', 'recoverySteps', 'citedError', 'confidence']);
  if (base.ok !== true) return base;
  if (typeof value.summary !== 'string' || !value.summary.trim()) return { ok: false, message: 'AI response must include summary' };
  if (!RISK_LEVELS.has(value.risk)) return { ok: false, message: 'AI response has invalid risk' };
  if (typeof value.recommendedAction !== 'string' || !value.recommendedAction.trim()) return { ok: false, message: 'AI response must include recommendedAction' };
  if (typeof value.rationale !== 'string' || !value.rationale.trim()) return { ok: false, message: 'AI response must include rationale' };
  if (!Array.isArray(value.recoverySteps) || value.recoverySteps.some((item) => typeof item !== 'string')) {
    return { ok: false, message: 'AI response recoverySteps must be an array of strings' };
  }
  const citedError = validateObject(value.citedError, ['code', 'path', 'message']);
  if (citedError.ok !== true) return { ok: false, message: 'AI response must cite error code, path, and message' };
  for (const key of ['code', 'path', 'message']) {
    if (typeof value.citedError[key] !== 'string' || !value.citedError[key].trim()) {
      return { ok: false, message: `AI response citedError.${key} must be a non-empty string` };
    }
  }
  if (expectedError) {
    const citedError = {
      code: cleanString(value.citedError.code, 120),
      path: cleanString(value.citedError.path, 240),
      message: cleanString(value.citedError.message, 1000)
    };
    for (const key of ['code', 'path', 'message']) {
      if (citedError[key] !== expectedError[key]) {
        return { ok: false, message: `AI response citedError.${key} must match the submitted setup error` };
      }
    }
  }
  const confidence = Number(value.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return { ok: false, message: 'AI response confidence must be between 0 and 1' };
  }
  return { ok: true };
}

function normalizeSuggestionBriefPayload(value) {
  return {
    category: value.category,
    impact: value.impact,
    risk: value.risk,
    recommendedAction: value.recommendedAction,
    rationale: value.rationale.trim().slice(0, 1200),
    evidence: value.evidence.map((item) => item.trim()).filter(Boolean).slice(0, 6),
    confidence: Math.min(Math.max(Number(value.confidence), 0), 1)
  };
}

function normalizeConflictSummaryPayload(value) {
  return {
    summary: value.summary.trim().slice(0, 600),
    risk: value.risk,
    recommendation: value.recommendation,
    rationale: value.rationale.trim().slice(0, 1200),
    evidence: value.evidence.map((item) => item.trim()).filter(Boolean).slice(0, 6),
    confidence: Math.min(Math.max(Number(value.confidence), 0), 1)
  };
}

function normalizeSetupDiagnosticPayload(value, inputError) {
  return {
    summary: value.summary.trim().slice(0, 600),
    risk: value.risk,
    recommendedAction: value.recommendedAction.trim().slice(0, 600),
    rationale: value.rationale.trim().slice(0, 1200),
    recoverySteps: value.recoverySteps.map((item) => item.trim()).filter(Boolean).slice(0, 6),
    citedError: {
      code: cleanString(value.citedError?.code, 120) || inputError.code,
      path: cleanString(value.citedError?.path, 240) || inputError.path,
      message: cleanString(value.citedError?.message, 1000) || inputError.message
    },
    confidence: Math.min(Math.max(Number(value.confidence), 0), 1)
  };
}

function severityFromBrief(payload) {
  if (payload.risk === 'high') return 'high';
  if (payload.risk === 'medium' || payload.impact === 'high') return 'medium';
  if (payload.impact === 'medium') return 'low';
  return 'info';
}

function severityFromRisk(risk) {
  if (risk === 'high') return 'high';
  if (risk === 'medium') return 'medium';
  if (risk === 'low') return 'low';
  return 'info';
}

function cleanString(value, maxLength = 1000) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function boundRecord(record, maxKeys, maxValueLength) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return {};
  return Object.fromEntries(
    Object.entries(record)
      .slice(0, maxKeys)
      .map(([key, value]) => [String(key).slice(0, 120), cleanString(String(value ?? ''), maxValueLength)])
  );
}

function topTags(cards) {
  const counts = new Map();
  for (const card of cards) {
    for (const tag of card.tags || []) counts.set(tag, (counts.get(tag) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 12)
    .map(([tag, count]) => ({ tag, count }));
}
