import { useState, useEffect, useCallback, useRef } from 'react';
import type { DeckCard } from './types';

interface Props {
  card: DeckCard;
  canSuggest: boolean;
  busy: boolean;
  onSubmit: (proposedFields: Record<string, string>, proposedTags: string[], reason: string) => void;
  onCancel: () => void;
}

export function CardEditor({ card, canSuggest, busy, onSubmit, onCancel }: Props) {
  const fieldNames = card.fieldOrder?.length ? card.fieldOrder : Object.keys(card.fields);
  const [fields, setFields] = useState<Record<string, string>>(() => ({ ...card.fields }));
  const [tagsInput, setTagsInput] = useState(card.tags.join(', '));
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const firstRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    firstRef.current?.focus();
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel();
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') handleSubmit();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  function handleSubmit() {
    const changed = fieldNames.some((f) => fields[f] !== card.fields[f]);
    const parsedTags = tagsInput.split(',').map((t) => t.trim()).filter(Boolean);
    const tagsChanged = JSON.stringify(parsedTags.sort()) !== JSON.stringify([...card.tags].sort());
    if (!changed && !tagsChanged) {
      setError('No changes detected — modify at least one field or tag.');
      return;
    }
    if (!reason.trim()) {
      setError('Please add a reason for this suggestion.');
      return;
    }
    onSubmit(fields, parsedTags, reason.trim());
  }

  const setField = useCallback((name: string, value: string) => {
    setFields((prev) => ({ ...prev, [name]: value }));
    setError('');
  }, []);

  const charCount = Object.values(fields).reduce((sum, v) => sum + v.length, 0);

  return (
    <div className="card-editor" role="form" aria-label="Edit card">
      <div className="card-editor-header">
        <strong>Edit card</strong>
        <span className="card-editor-hint">Submits as a suggestion for owner review</span>
        <button className="btn btn-ghost card-editor-close" onClick={onCancel} aria-label="Cancel edit">✕</button>
      </div>

      <div className="card-editor-fields">
        {fieldNames.map((name, i) => (
          <div className="card-editor-field" key={name}>
            <label htmlFor={`field-${name}`}>{name}</label>
            <div className="card-editor-toolbar">
              <button type="button" className="toolbar-btn" title="Bold" onClick={() => {
                const el = document.getElementById(`field-${name}`) as HTMLTextAreaElement;
                if (!el) return;
                const { selectionStart: s, selectionEnd: e } = el;
                setField(name, fields[name].slice(0, s) + `<b>${fields[name].slice(s, e)}</b>` + fields[name].slice(e));
              }}>B</button>
              <button type="button" className="toolbar-btn" title="Italic" onClick={() => {
                const el = document.getElementById(`field-${name}`) as HTMLTextAreaElement;
                if (!el) return;
                const { selectionStart: s, selectionEnd: e } = el;
                setField(name, fields[name].slice(0, s) + `<i>${fields[name].slice(s, e)}</i>` + fields[name].slice(e));
              }}><em>I</em></button>
              <button type="button" className="toolbar-btn" title="Cloze deletion" onClick={() => {
                const el = document.getElementById(`field-${name}`) as HTMLTextAreaElement;
                if (!el) return;
                const { selectionStart: s, selectionEnd: e } = el;
                const n = (fields[name].match(/{{c(\d+)::/g) || []).length + 1;
                setField(name, fields[name].slice(0, s) + `{{c${n}::${fields[name].slice(s, e)}}}` + fields[name].slice(e));
              }}>[ ]</button>
            </div>
            <textarea
              id={`field-${name}`}
              ref={i === 0 ? firstRef : undefined}
              className="card-editor-textarea"
              value={fields[name] ?? ''}
              onChange={(e) => setField(name, e.target.value)}
              rows={name.toLowerCase() === 'front' ? 3 : 5}
              aria-label={name}
            />
          </div>
        ))}

        <div className="card-editor-field">
          <label htmlFor="editor-tags">Tags <small>(comma-separated)</small></label>
          <input
            id="editor-tags"
            className="card-editor-input"
            value={tagsInput}
            onChange={(e) => { setTagsInput(e.target.value); setError(''); }}
            placeholder="tag1, tag2, tag3"
          />
        </div>

        <div className="card-editor-field">
          <label htmlFor="editor-reason">Reason for change <small>(required)</small></label>
          <textarea
            id="editor-reason"
            className="card-editor-textarea"
            value={reason}
            onChange={(e) => { setReason(e.target.value); setError(''); }}
            rows={2}
            placeholder="Corrected factual error, improved clarity, added source…"
          />
        </div>
      </div>

      {error && <div className="card-editor-error">{error}</div>}

      <div className="card-editor-footer">
        <span className="card-editor-chars">{charCount} chars</span>
        <span className="card-editor-shortcuts"><kbd>Ctrl+Enter</kbd> submit · <kbd>Esc</kbd> cancel</span>
        <div className="card-editor-actions">
          <button className="btn btn-ghost" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSubmit} disabled={busy || !canSuggest}>
            {busy ? 'Submitting…' : 'Submit suggestion'}
          </button>
        </div>
      </div>
    </div>
  );
}
