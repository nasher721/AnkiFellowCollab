import { useState, useEffect, useCallback, useRef } from 'react';
import type { DeckCard } from './types';

interface Props {
  card: DeckCard;
  canSuggest: boolean;
  busy: boolean;
  onSubmit: (proposedFields: Record<string, string>, proposedTags: string[], reason: string) => void;
  onCancel: () => void;
}

function FormattingToolbar({ textareaId }: { textareaId: string }) {
  function wrapSelection(before: string, after: string) {
    const textarea = document.getElementById(textareaId) as HTMLTextAreaElement | null;
    if (!textarea) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selected = textarea.value.substring(start, end);
    const newValue = textarea.value.substring(0, start) + before + selected + after + textarea.value.substring(end);
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    nativeInputValueSetter?.call(textarea, newValue);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.focus();
    textarea.selectionStart = start + before.length;
    textarea.selectionEnd = start + before.length + selected.length;
  }

  return (
    <div className="format-toolbar" role="toolbar" aria-label="Formatting tools">
      <button type="button" aria-label="Bold selected text" aria-controls={textareaId} title="Bold" onClick={() => wrapSelection('**', '**')}><b aria-hidden="true">B</b></button>
      <button type="button" aria-label="Italicize selected text" aria-controls={textareaId} title="Italic" onClick={() => wrapSelection('*', '*')}><i aria-hidden="true">I</i></button>
      <button type="button" aria-label="Turn selected text into a list item" aria-controls={textareaId} title="List" onClick={() => wrapSelection('- ', '')}>List</button>
      <button type="button" aria-label="Wrap selected text in Anki cloze markup" aria-controls={textareaId} title="Cloze" onClick={() => wrapSelection('{{c1::', '}}')}>{'{{}}'}</button>
      <button type="button" aria-label="Wrap selected text as inline code" aria-controls={textareaId} title="Code" onClick={() => wrapSelection('`', '`')}>{'<>'}</button>
    </div>
  );
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
        <button type="button" className="btn btn-ghost card-editor-close" onClick={onCancel} aria-label="Cancel edit">✕</button>
      </div>

      <div className="card-editor-fields">
        {fieldNames.map((name, i) => (
          <div className="card-editor-field" key={name}>
            <label htmlFor={`card-edit-${name.toLowerCase()}`}>{name}</label>
            {(name.toLowerCase() === 'front' || name.toLowerCase() === 'back') && (
              <FormattingToolbar textareaId={`card-edit-${name.toLowerCase()}`} />
            )}
            <textarea
              id={`card-edit-${name.toLowerCase()}`}
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
          <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={handleSubmit} disabled={busy || !canSuggest} aria-label={busy ? 'Submitting suggestion' : 'Submit suggestion'}>
            {busy ? 'Submitting…' : 'Submit suggestion'}
          </button>
        </div>
      </div>
    </div>
  );
}
