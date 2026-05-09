import { useRef, useEffect, useMemo } from 'react';
import type { DeckCard } from './types';
import { renderMediaHtml } from './media';

interface Props {
  card: DeckCard;
  deckId: string;
  side: 'front' | 'back';
  frontHtml?: string;
  clozeOrd?: number;
  className?: string;
  onDocumentClick?: () => void;
}

// Anki's default card CSS (matches Anki's built-in baseline)
const ANKI_BASE_CSS = `.card {
  font-family: arial;
  font-size: 20px;
  text-align: center;
  color: black;
  background-color: white;
}`;

type TemplateSide = 'front' | 'back';

interface TemplateContext {
  card: DeckCard;
  fields: Record<string, string>;
  deckId: string;
  frontHtml?: string;
  activeClozeNum?: number;
  side: TemplateSide;
}

function resolveField(fields: Record<string, string>, name: string): string {
  const requested = name.trim();
  if (!requested) return '';
  if (Object.prototype.hasOwnProperty.call(fields, requested)) return fields[requested] ?? '';
  const match = Object.keys(fields).find((key) => key.toLowerCase() === requested.toLowerCase());
  return match ? fields[match] ?? '' : '';
}

function stripHtml(value: string): string {
  if (typeof window !== 'undefined' && typeof window.DOMParser !== 'undefined') {
    const parser = new window.DOMParser();
    const document = parser.parseFromString(value, 'text/html');
    return document.body.textContent || '';
  }
  return value.replace(/<[^>]+>/g, '');
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function resolveSpecialValue(name: string, context: TemplateContext): string | undefined {
  const key = name.trim().toLowerCase();
  if (key === 'frontside') return context.frontHtml ?? '';
  if (key === 'tags') return context.card.tags.join(' ');
  if (key === 'type') return context.card.modelName || context.card.type || '';
  if (key === 'deck') return context.card.sourceDeckName || context.card.sourceDeckPath || '';
  if (key === 'subdeck') {
    const path = context.card.sourceDeckPath || context.card.sourceDeckName || '';
    const parts = path.split('::').filter(Boolean);
    return parts.length ? parts[parts.length - 1] : '';
  }
  if (key === 'card') return context.card.type || context.card.modelName || '';
  return undefined;
}

function resolveTemplateValue(name: string, context: TemplateContext): string {
  const special = resolveSpecialValue(name, context);
  if (special !== undefined) return special;
  return resolveField(context.fields, name);
}

function renderClozeField(value: string, activeClozeNum: number | undefined, side: TemplateSide): string {
  return value.replace(/\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g, (_match, num, text, hint) => {
    const n = parseInt(num, 10);
    if (side === 'front' && activeClozeNum !== undefined && n === activeClozeNum) {
      return `<span class="cloze">[${hint ?? '...'}]</span>`;
    }
    if (side === 'back' && activeClozeNum !== undefined && n === activeClozeNum) {
      return `<span class="cloze">${text}</span>`;
    }
    return text;
  });
}

function renderHint(value: string, label: string): string {
  if (!value.trim()) return '';
  const safeLabel = escapeAttribute(label.trim() || 'hint');
  return `<a class="hint" href="#" onclick="this.style.display='none';this.nextElementSibling.style.display='block';return false;">Show ${safeLabel}</a><div class="hint-content" style="display:none">${value}</div>`;
}

function renderTypeAnswer(value: string, context: TemplateContext): string {
  if (context.side === 'front') {
    return `<input class="type-answer" type="text" aria-label="Type answer" autocomplete="off" data-answer="${escapeAttribute(stripHtml(value))}">`;
  }
  return `<div class="type-answer type-answer-back">${value}</div>`;
}

function applyFieldReference(ref: string, context: TemplateContext): string {
  const parts = ref.split(':').map((part) => part.trim()).filter(Boolean);
  if (!parts.length) return '';
  const fieldName = parts[parts.length - 1];
  const filters = parts.slice(0, -1).map((filter) => filter.toLowerCase());
  let value = resolveTemplateValue(fieldName, context);

  for (const filter of filters.reverse()) {
    if (filter === 'text') {
      value = stripHtml(value);
    } else if (filter === 'hint') {
      value = renderHint(value, fieldName);
    } else if (filter === 'type') {
      value = renderTypeAnswer(value, context);
    } else if (filter === 'cloze') {
      value = renderClozeField(value, context.activeClozeNum, context.side);
    } else if (filter.startsWith('tts ')) {
      value = '';
    }
  }

  return value;
}

function isTruthyField(ref: string, context: TemplateContext): boolean {
  return stripHtml(applyFieldReference(ref, context)).trim().length > 0;
}

function parseSection(template: string, context: TemplateContext, startIndex = 0, closingName?: string): { html: string; index: number } {
  const tokenPattern = /\{\{\s*([#/^]?)([^}]+?)\s*\}\}/g;
  let html = '';
  let cursor = startIndex;
  tokenPattern.lastIndex = startIndex;

  while (true) {
    const token = tokenPattern.exec(template);
    if (!token) break;
    const [raw, marker, rawName] = token;
    const name = rawName.trim();
    html += template.slice(cursor, token.index);
    cursor = tokenPattern.lastIndex;

    if (marker === '/') {
      if (closingName && name.toLowerCase() === closingName.toLowerCase()) {
        return { html, index: cursor };
      }
      continue;
    }

    if (marker === '#' || marker === '^') {
      const inner = parseSection(template, context, cursor, name);
      const include = isTruthyField(name, context);
      if ((marker === '#' && include) || (marker === '^' && !include)) {
        html += inner.html;
      }
      cursor = inner.index;
      tokenPattern.lastIndex = cursor;
      continue;
    }

    html += applyFieldReference(name, context);
  }

  html += template.slice(cursor);
  return { html, index: template.length };
}

function renderAnkiTemplate(template: string, context: TemplateContext): string {
  const rendered = parseSection(template, context).html;
  return renderMediaHtml(context.deckId, rendered);
}

function buildFallbackHtml(card: DeckCard, deckId: string, side: 'front' | 'back'): string {
  const keys = card.fieldOrder ?? Object.keys(card.fields);
  if (side === 'front') {
    const key = keys[0] ?? 'Front';
    return renderMediaHtml(deckId, card.fields[key] ?? card.fields['Front'] ?? '');
  }
  return keys
    .map((k, i) => {
      const html = renderMediaHtml(deckId, card.fields[k] ?? '');
      return i === 0 ? html : `<hr id="answer">${html}`;
    })
    .join('');
}

export function renderCardHtml(
  card: DeckCard,
  deckId: string,
  side: 'front' | 'back',
  frontHtml?: string,
  clozeOrd?: number,
): string {
  const renderedHtml = side === 'front' ? card.renderedFront : card.renderedBack;
  if (renderedHtml?.trim()) {
    return renderMediaHtml(deckId, renderedHtml);
  }

  const effectiveClozeOrd = clozeOrd ?? card.clozeOrd;
  const context: TemplateContext = {
    card,
    fields: card.fields,
    deckId,
    frontHtml,
    activeClozeNum: effectiveClozeOrd !== undefined ? effectiveClozeOrd + 1 : undefined,
    side
  };
  if (side === 'front' && card.templateFront) {
    return renderAnkiTemplate(card.templateFront, { ...context, frontHtml: undefined });
  }
  if (side === 'back' && card.templateBack) {
    return renderAnkiTemplate(card.templateBack, context);
  }
  return buildFallbackHtml(card, deckId, side);
}

export function buildAnkiCardDocument(bodyHtml: string, modelCss?: string): string {
  const effectiveModelCss = modelCss?.trim() ? modelCss : ANKI_BASE_CSS;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
html,body{margin:0;padding:16px;box-sizing:border-box;background:#fff;}
img,video{max-width:100%;height:auto;}
audio{display:block;margin:8px auto;}
.anki-tts-control{display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;margin:8px 0;border-radius:999px;background:#fff;border:1px solid rgba(0,0,0,.16);box-shadow:0 1px 2px rgba(0,0,0,.18);}
.anki-tts-control::before{content:"";display:block;width:0;height:0;margin-left:3px;border-top:8px solid transparent;border-bottom:8px solid transparent;border-left:13px solid #5b6470;}
.cloze{font-weight:bold;color:#00a;}
${ANKI_BASE_CSS}
${effectiveModelCss !== ANKI_BASE_CSS ? effectiveModelCss : ''}
</style>
</head>
<body class="card">
${bodyHtml}
</body>
</html>`;
}

export function AnkiCardRenderer({ card, deckId, side, frontHtml, clozeOrd, className = '', onDocumentClick }: Props) {
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const bodyHtml = useMemo(
    () => renderCardHtml(card, deckId, side, frontHtml, clozeOrd),
    [card, deckId, side, frontHtml, clozeOrd],
  );

  const modelCss = card.modelCss?.trim() ? card.modelCss : ANKI_BASE_CSS;

  const htmlDoc = useMemo(
    () => buildAnkiCardDocument(bodyHtml, modelCss),
    [bodyHtml, modelCss],
  );

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    const doc = iframe.contentDocument;
    if (!doc) return;
    doc.open();
    doc.write(htmlDoc);
    doc.close();

    const resize = () => {
      if (iframe.contentDocument?.body) {
        const h = iframe.contentDocument.body.scrollHeight;
        iframe.style.height = `${Math.max(h + 32, 60)}px`;
      }
    };
    resize();
    const t = setTimeout(resize, 150);
    const handleDocumentClick = () => onDocumentClick?.();
    if (onDocumentClick) {
      doc.addEventListener('click', handleDocumentClick);
    }
    return () => {
      clearTimeout(t);
      doc.removeEventListener('click', handleDocumentClick);
    };
  }, [htmlDoc, onDocumentClick]);

  return (
    <iframe
      ref={iframeRef}
      className={`anki-card-iframe ${className}`.trim()}
      title={`Card ${side}`}
      style={{ width: '100%', border: 'none', minHeight: '60px', display: 'block' }}
    />
  );
}
