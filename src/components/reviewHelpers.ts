import type { DeckCard } from '../types';
import { fieldValue } from '../hooks/common';
import type { QualityReviewItem } from '../reviewModel';

export function formatFieldValue(value?: string) {
  const trimmed = (value || '').trim();
  return trimmed || 'Empty';
}

export function reviewCardPrompt(card?: DeckCard) {
  if (!card) return 'Card not found';
  return fieldValue(card, 'Front') || Object.values(card.fields)[0] || card.id;
}

export function affectedFieldsLabel(item: QualityReviewItem) {
  const fields = [...item.changedFields];
  if (item.changedTags) fields.push('Tags');
  return fields.length ? fields.join(', ') : 'Card context';
}

export function hasRenderFallback(card: DeckCard, side: 'front' | 'back') {
  const rendered = side === 'front' ? card.renderedFront : card.renderedBack;
  const template = side === 'front' ? card.templateFront : card.templateBack;
  return !rendered?.trim() && !template?.trim();
}

export function sourceCheckLabel(item: QualityReviewItem, sourceCheckState?: 'needs' | 'checked') {
  if (sourceCheckState === 'checked') return 'Source checked this session';
  if (sourceCheckState === 'needs') return 'Needs source check this session';
  if (item.needsSourceCheck) return 'Needs source check';
  return 'Source checked';
}
