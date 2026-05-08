function localFilename(value: string) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  if (/^(https?:|data:)/i.test(trimmed)) return '';
  const withoutQuery = trimmed.split(/[?#]/, 1)[0] || trimmed;
  let decoded = withoutQuery;
  try {
    decoded = decodeURIComponent(withoutQuery);
  } catch {
    decoded = withoutQuery;
  }
  const parts = decoded.split(/[\\/]/);
  return parts[parts.length - 1] || '';
}

export function mediaUrl(deckId: string, filename: string) {
  return `/api/decks/${encodeURIComponent(deckId)}/media/${encodeURIComponent(filename)}`;
}

export function renderMediaHtml(deckId: string, html: string) {
  const withAudio = String(html || '').replace(/\[sound:([^\]]+)\]/gi, (_match, rawRef) => {
    const filename = localFilename(rawRef);
    if (!filename) return '';
    const src = mediaUrl(deckId, filename);
    return `<audio controls preload="none" src="${src}"></audio>`;
  });

  if (typeof window === 'undefined' || typeof window.DOMParser === 'undefined') return withAudio;

  const parser = new window.DOMParser();
  const document = parser.parseFromString(withAudio, 'text/html');
  for (const image of document.querySelectorAll('img[src]')) {
    const filename = localFilename(image.getAttribute('src') || '');
    if (filename) image.setAttribute('src', mediaUrl(deckId, filename));
  }
  return document.body.innerHTML;
}
