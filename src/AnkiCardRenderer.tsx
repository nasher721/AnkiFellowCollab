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
}

// Anki's default card CSS (matches Anki's built-in baseline)
const ANKI_BASE_CSS = `.card {
  font-family: arial;
  font-size: 20px;
  text-align: center;
  color: black;
  background-color: white;
}`;

function renderCloze(html: string, activeClozeNum: number | undefined, side: 'front' | 'back'): string {
  return html.replace(/\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g, (_match, num, text, hint) => {
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

function applyTemplate(
  template: string,
  fields: Record<string, string>,
  deckId: string,
  frontHtml: string | undefined,
  clozeOrd: number | undefined,
  side: 'front' | 'back',
): string {
  let result = template;

  // {{FrontSide}} — replaced with pre-rendered front HTML
  if (frontHtml !== undefined) {
    result = result.replace(/\{\{FrontSide\}\}/gi, frontHtml);
  }

  // Conditional sections {{#Field}}...{{/Field}}
  result = result.replace(/\{\{#([^}]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_m, name, content) => {
    const val = fields[name.trim()] ?? fields[name.trim().toLowerCase()] ?? '';
    return val.trim() ? content : '';
  });

  // Inverse conditionals {{^Field}}...{{/Field}}
  result = result.replace(/\{\{\^([^}]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_m, name, content) => {
    const val = fields[name.trim()] ?? fields[name.trim().toLowerCase()] ?? '';
    return val.trim() ? '' : content;
  });

  // Field substitutions {{FieldName}} and special prefixes
  result = result.replace(/\{\{([^}]+)\}\}/g, (_match, ref) => {
    const r = ref.trim();
    if (r === 'FrontSide') return '';

    if (r.startsWith('text:')) {
      const name = r.slice(5).trim();
      const val = fields[name] ?? fields[name.toLowerCase()] ?? '';
      return val.replace(/<[^>]+>/g, '');
    }
    if (r.startsWith('type:')) {
      const name = r.slice(5).trim();
      return fields[name] ?? fields[name.toLowerCase()] ?? '';
    }
    if (r.startsWith('cloze:')) {
      const name = r.slice(6).trim();
      const val = fields[name] ?? fields[name.toLowerCase()] ?? '';
      const activeClozeNum = clozeOrd !== undefined ? clozeOrd + 1 : undefined;
      return renderCloze(val, activeClozeNum, side);
    }
    // Remaining Anki specials (closing tags etc.) — swallow
    if (r.startsWith('#') || r.startsWith('/') || r.startsWith('^')) return '';

    return fields[r] ?? fields[r.toLowerCase()] ?? '';
  });

  return renderMediaHtml(deckId, result);
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
  if (side === 'front' && card.templateFront) {
    return applyTemplate(card.templateFront, card.fields, deckId, undefined, clozeOrd, 'front');
  }
  if (side === 'back' && card.templateBack) {
    return applyTemplate(card.templateBack, card.fields, deckId, frontHtml, clozeOrd, 'back');
  }
  return buildFallbackHtml(card, deckId, side);
}

export function AnkiCardRenderer({ card, deckId, side, frontHtml, clozeOrd, className = '' }: Props) {
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const bodyHtml = useMemo(
    () => renderCardHtml(card, deckId, side, frontHtml, clozeOrd),
    [card, deckId, side, frontHtml, clozeOrd],
  );

  const modelCss = card.modelCss?.trim() ? card.modelCss : ANKI_BASE_CSS;

  const htmlDoc = useMemo(
    () => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
html,body{margin:0;padding:16px;box-sizing:border-box;background:#fff;}
img,video{max-width:100%;height:auto;}
audio{display:block;margin:8px auto;}
.cloze{font-weight:bold;color:#00a;}
${ANKI_BASE_CSS}
${modelCss !== ANKI_BASE_CSS ? modelCss : ''}
</style>
</head>
<body class="card">
${bodyHtml}
</body>
</html>`,
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
    return () => clearTimeout(t);
  }, [htmlDoc]);

  return (
    <iframe
      ref={iframeRef}
      className={`anki-card-iframe ${className}`.trim()}
      title={`Card ${side}`}
      style={{ width: '100%', border: 'none', minHeight: '60px', display: 'block' }}
    />
  );
}
