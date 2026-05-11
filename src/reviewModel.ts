import type { AiQualityPulse, AppState, DeckCard, Suggestion } from './types';

export type ReviewRiskLabel =
  | 'Answer changed'
  | 'Source check'
  | 'Tag-only'
  | 'Formatting/render'
  | 'Sync conflict'
  | 'Media change'
  | 'AI assist';

export type ReviewBucket = 'all' | 'answer' | 'source' | 'tag' | 'render' | 'conflict';

export interface QualityReviewItem {
  id: string;
  kind: 'suggestion' | 'conflict' | 'ai' | 'recent-change';
  source: string;
  label: string;
  detail: string;
  status: 'pending' | 'revision' | 'accepted' | 'rejected';
  tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger';
  risk: 'low' | 'medium' | 'high';
  actionLabel: string;
  changedFields: string[];
  changedTags: boolean;
  labels: ReviewRiskLabel[];
  needsSourceCheck: boolean;
  affectsNextPull: boolean;
  blocksPush: boolean;
  sortAt: string;
  priority: number;
  cardId?: string;
  suggestionId?: string;
  conflictId?: string;
  artifactId?: string;
  authorName?: string;
}

const ANSWER_FIELD_RE = /(answer|back|text|cloze|extra|explanation|rationale)/i;
const RENDER_FIELD_RE = /(template|css|model|format|layout|front|card)/i;
const MEDIA_RE = /(<img\b|<audio\b|<video\b|\[sound:|\.(png|jpe?g|gif|webp|svg|mp3|wav|mp4)\b)/i;

function severityRisk(severity: AiQualityPulse['items'][number]['severity']): QualityReviewItem['risk'] {
  if (severity === 'high') return 'high';
  if (severity === 'medium') return 'medium';
  return 'low';
}

function severityTone(severity: AiQualityPulse['items'][number]['severity']): QualityReviewItem['tone'] {
  if (severity === 'high') return 'danger';
  if (severity === 'medium') return 'warning';
  return 'info';
}

function recentSuggestionCutoff(nowMs: number) {
  return nowMs - 7 * 24 * 60 * 60 * 1000;
}

function sameTags(left: string[], right: string[]) {
  return [...left].sort().join('\u0000') === [...right].sort().join('\u0000');
}

function uniqueLabels(labels: ReviewRiskLabel[]) {
  return Array.from(new Set(labels));
}

export function deriveSuggestionChangeModel(suggestion: Suggestion, card?: DeckCard) {
  const changedFields = Object.keys(suggestion.proposedFields || {}).filter((field) => {
    if (!card) return true;
    return (card.fields[field] || '') !== (suggestion.proposedFields[field] || '');
  });
  const changedTags = card ? !sameTags(card.tags, suggestion.proposedTags || []) : (suggestion.proposedTags || []).length > 0;
  const changedValues = changedFields.map((field) => suggestion.proposedFields[field] || '').join(' ');
  const answerChanged = changedFields.some((field) => ANSWER_FIELD_RE.test(field));
  const renderRisk = changedFields.some((field) => RENDER_FIELD_RE.test(field)) || /{{|<table\b|<div\b|<br\b|<hr\b|<span\b/i.test(changedValues);
  const mediaChange = MEDIA_RE.test(changedValues);
  const tagOnly = changedTags && changedFields.length === 0;
  const needsSourceCheck = answerChanged || mediaChange || suggestion.reason.toLowerCase().includes('source') || suggestion.reason.toLowerCase().includes('factual');
  const labels = uniqueLabels([
    ...(answerChanged ? ['Answer changed' as const] : []),
    ...(needsSourceCheck ? ['Source check' as const] : []),
    ...(tagOnly ? ['Tag-only' as const] : []),
    ...(renderRisk ? ['Formatting/render' as const] : []),
    ...(mediaChange ? ['Media change' as const] : [])
  ]);
  const risk: QualityReviewItem['risk'] = answerChanged || mediaChange || renderRisk
    ? 'high'
    : tagOnly
      ? 'low'
      : 'medium';

  return { changedFields, changedTags, labels, needsSourceCheck, risk };
}

export function reviewItemMatchesBucket(item: QualityReviewItem, bucket: ReviewBucket) {
  if (bucket === 'all') return true;
  if (bucket === 'answer') return item.labels.includes('Answer changed');
  if (bucket === 'source') return item.needsSourceCheck;
  if (bucket === 'tag') return item.labels.includes('Tag-only');
  if (bucket === 'render') return item.labels.includes('Formatting/render');
  return item.blocksPush || item.labels.includes('Sync conflict');
}

export function deriveReviewBucketCounts(items: QualityReviewItem[]) {
  return {
    all: items.length,
    answer: items.filter((item) => reviewItemMatchesBucket(item, 'answer')).length,
    source: items.filter((item) => reviewItemMatchesBucket(item, 'source')).length,
    tag: items.filter((item) => reviewItemMatchesBucket(item, 'tag')).length,
    render: items.filter((item) => reviewItemMatchesBucket(item, 'render')).length,
    conflict: items.filter((item) => reviewItemMatchesBucket(item, 'conflict')).length
  } satisfies Record<ReviewBucket, number>;
}

export function selectSuggestionForReview(
  selectedItem: QualityReviewItem | undefined,
  suggestions: Suggestion[],
  selectedSuggestionId: string | null
) {
  if (selectedItem?.suggestionId) {
    return suggestions.find((item) => item.id === selectedItem.suggestionId);
  }
  if (selectedItem) return undefined;
  return suggestions.find((item) => item.id === selectedSuggestionId);
}

export function selectCardForReview(
  selectedItem: QualityReviewItem | undefined,
  selectedSuggestion: Suggestion | undefined,
  cards: DeckCard[],
  selectedCardId: string | null
) {
  return cards.find((card) => card.id === (selectedItem?.cardId || selectedSuggestion?.cardId || selectedCardId)) || cards[0];
}

export function deriveOwnerReviewQueue({
  suggestions,
  conflicts,
  pulse,
  cards = [],
  now = Date.now()
}: {
  suggestions: Suggestion[];
  conflicts: AppState['sync']['conflicts'];
  pulse: AiQualityPulse | null;
  cards?: DeckCard[];
  now?: number;
}): QualityReviewItem[] {
  const cardsById = new Map(cards.map((card) => [card.id, card]));
  const items = new Map<string, QualityReviewItem>();
  const addItem = (item: QualityReviewItem) => {
    const existing = items.get(item.id);
    if (!existing || item.priority < existing.priority || (item.priority === existing.priority && item.sortAt > existing.sortAt)) {
      items.set(item.id, item);
    }
  };

  for (const conflict of conflicts) {
    const changedFields = Array.from(new Set([...Object.keys(conflict.localFields || {}), ...Object.keys(conflict.incomingFields || {})])).sort();
    addItem({
      id: `conflict:${conflict.id}`,
      kind: 'conflict',
      source: conflict.source || 'Sync conflict',
      label: 'Sync conflict',
      detail: 'Choose which source of truth should win before pushing accepted changes.',
      status: 'pending',
      tone: 'danger',
      risk: 'high',
      actionLabel: 'Resolve source of truth',
      changedFields,
      changedTags: false,
      labels: ['Sync conflict', 'Source check'],
      needsSourceCheck: true,
      affectsNextPull: true,
      blocksPush: true,
      sortAt: conflict.detectedAt,
      priority: 10,
      cardId: conflict.cardId,
      conflictId: conflict.id
    });
  }

  const recentCutoff = recentSuggestionCutoff(now);
  for (const suggestion of suggestions) {
    const sortAt = suggestion.reviewedAt || suggestion.createdAt;
    const changeModel = deriveSuggestionChangeModel(suggestion, cardsById.get(suggestion.cardId));
    if (suggestion.status === 'pending' || suggestion.status === 'revision') {
      addItem({
        id: `suggestion:${suggestion.id}`,
        kind: 'suggestion',
        source: suggestion.authorName,
        label: suggestion.status === 'revision' ? 'Revision requested' : 'Pending suggestion',
        detail: suggestion.reason || 'Review proposed card changes.',
        status: suggestion.status,
        tone: suggestion.status === 'revision' ? 'info' : changeModel.risk === 'high' ? 'danger' : 'warning',
        risk: changeModel.risk,
        actionLabel: suggestion.status === 'revision' ? 'Review revision' : 'Decide',
        changedFields: changeModel.changedFields,
        changedTags: changeModel.changedTags,
        labels: changeModel.labels,
        needsSourceCheck: changeModel.needsSourceCheck,
        affectsNextPull: suggestion.status === 'pending',
        blocksPush: false,
        sortAt,
        priority: suggestion.status === 'pending' ? (changeModel.risk === 'high' ? 18 : 20) : 35,
        cardId: suggestion.cardId,
        suggestionId: suggestion.id,
        authorName: suggestion.authorName
      });
      continue;
    }

    if (new Date(sortAt).getTime() >= recentCutoff) {
      addItem({
        id: `recent:${suggestion.id}`,
        kind: 'recent-change',
        source: suggestion.authorName,
        label: suggestion.status === 'accepted' ? 'Recently accepted' : 'Recently rejected',
        detail: suggestion.reason || 'Recent owner decision.',
        status: suggestion.status,
        tone: suggestion.status === 'accepted' ? 'success' : 'neutral',
        risk: changeModel.risk === 'high' ? 'medium' : 'low',
        actionLabel: 'Inspect',
        changedFields: changeModel.changedFields,
        changedTags: changeModel.changedTags,
        labels: changeModel.labels,
        needsSourceCheck: false,
        affectsNextPull: suggestion.status === 'accepted',
        blocksPush: false,
        sortAt,
        priority: suggestion.status === 'accepted' ? 55 : 60,
        cardId: suggestion.cardId,
        suggestionId: suggestion.id,
        authorName: suggestion.authorName
      });
    }
  }

  if (pulse?.enabled && pulse.status === 'attention') {
    for (const pulseItem of pulse.items) {
      const subjectKey = pulseItem.subjectId || pulseItem.artifactId;
      const duplicateKey = pulseItem.subjectType === 'suggestion'
        ? `suggestion:${pulseItem.subjectId}`
        : pulseItem.subjectType === 'conflict'
          ? `conflict:${pulseItem.subjectId}`
          : '';
      if (duplicateKey && items.has(duplicateKey)) continue;

      const staleQualityFinding = pulseItem.kind === 'quality-issue' && pulseItem.staleness !== 'fresh';
      const risk = severityRisk(pulseItem.severity);
      addItem({
        id: `ai:${pulseItem.artifactId || subjectKey}`,
        kind: 'ai',
        source: pulseItem.kind === 'review-brief' ? 'AI review brief' : staleQualityFinding ? 'Stale quality finding' : 'AI pulse',
        label: pulseItem.label,
        detail: `${pulseItem.severity} risk · ${pulseItem.staleness} · ${pulseItem.detail}`,
        status: 'pending',
        tone: severityTone(pulseItem.severity),
        risk,
        actionLabel: pulseItem.action === 'conflict' ? 'Resolve' : pulseItem.action === 'setup' ? 'Repair' : 'Inspect',
        changedFields: [],
        changedTags: false,
        labels: uniqueLabels(['AI assist', ...(risk === 'high' ? ['Source check' as const] : [])]),
        needsSourceCheck: risk === 'high',
        affectsNextPull: pulseItem.action === 'suggestion' || pulseItem.action === 'conflict' || staleQualityFinding,
        blocksPush: pulseItem.action === 'conflict',
        sortAt: pulseItem.createdAt,
        priority: pulseItem.severity === 'high' ? 25 : pulseItem.severity === 'medium' ? 40 : 50,
        cardId: pulseItem.subjectType === 'card' ? pulseItem.subjectId : undefined,
        suggestionId: pulseItem.subjectType === 'suggestion' ? pulseItem.subjectId : undefined,
        conflictId: pulseItem.subjectType === 'conflict' ? pulseItem.subjectId : undefined,
        artifactId: pulseItem.artifactId
      });
    }
  }

  return Array.from(items.values()).sort((left, right) => (
    left.priority - right.priority || new Date(right.sortAt).getTime() - new Date(left.sortAt).getTime() || left.id.localeCompare(right.id)
  ));
}
