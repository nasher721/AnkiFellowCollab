import { useState, useEffect, useCallback } from 'react';
import { api, type Template } from './api';

interface Props {
  onUse: (deckId: string, name: string) => void;
}

const CATEGORIES = [
  { value: 'all', label: 'All' },
  { value: 'language', label: '🌍 Language' },
  { value: 'medical', label: '🏥 Medical' },
  { value: 'programming', label: '💻 Programming' },
  { value: 'humanities', label: '📚 Humanities' },
  { value: 'general', label: '📋 General' },
];

export function TemplateGallery({ onUse }: Props) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [category, setCategory] = useState('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [usingId, setUsingId] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [nameInputId, setNameInputId] = useState<string | null>(null);
  const [deckName, setDeckName] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const { templates: data } = await api.templates(category);
      setTemplates(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load templates');
    } finally {
      setLoading(false);
    }
  }, [category]);

  useEffect(() => { load(); }, [load]);

  async function handleUse(template: Template) {
    const name = deckName.trim() || template.name;
    setUsingId(template.id);
    try {
      const { deckId, name: finalName } = await api.useTemplate(template.id, name);
      setNameInputId(null);
      setDeckName('');
      onUse(deckId, finalName);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create deck from template');
    } finally {
      setUsingId(null);
    }
  }

  const preview = templates.find((t) => t.id === previewId);

  return (
    <div className="template-gallery">
      <div className="template-header">
        <div>
          <h2>Template Gallery</h2>
          <p>Start a new deck from a pre-built structure with example cards.</p>
        </div>
      </div>

      <div className="template-categories">
        {CATEGORIES.map((c) => (
          <button
            key={c.value}
            className={`category-pill ${category === c.value ? 'active' : ''}`}
            onClick={() => setCategory(c.value)}
          >
            {c.label}
          </button>
        ))}
      </div>

      {error && <div className="template-error">{error}</div>}

      {loading ? (
        <div className="template-loading">Loading templates…</div>
      ) : (
        <div className="template-grid">
          {templates.map((tpl) => (
            <div key={tpl.id} className={`template-card ${tpl.isFeatured ? 'featured' : ''}`}>
              {tpl.isFeatured && <span className="featured-badge">⭐ Featured</span>}
              <div className="template-card-body">
                <h3>{tpl.name}</h3>
                <p>{tpl.description}</p>
                <div className="template-fields">
                  {tpl.fields.slice(0, 4).map((f) => (
                    <span key={f.name} className="field-chip">{f.name}</span>
                  ))}
                  {tpl.fields.length > 4 && <span className="field-chip muted">+{tpl.fields.length - 4} more</span>}
                </div>
                <div className="template-tags">
                  {(tpl.tags || []).map((tag) => (
                    <em key={tag} className="template-tag">{tag}</em>
                  ))}
                </div>
              </div>
              <div className="template-card-actions">
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => setPreviewId(previewId === tpl.id ? null : tpl.id)}
                >
                  {previewId === tpl.id ? 'Hide preview' : 'Preview cards'}
                </button>
                {nameInputId === tpl.id ? (
                  <div className="template-name-input">
                    <input
                      className="card-editor-input"
                      placeholder={tpl.name}
                      value={deckName}
                      onChange={(e) => setDeckName(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleUse(tpl); if (e.key === 'Escape') { setNameInputId(null); setDeckName(''); } }}
                      autoFocus
                    />
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={() => handleUse(tpl)}
                      disabled={usingId === tpl.id}
                    >
                      {usingId === tpl.id ? 'Creating…' : 'Create deck'}
                    </button>
                    <button className="btn btn-ghost btn-sm" onClick={() => { setNameInputId(null); setDeckName(''); }}>✕</button>
                  </div>
                ) : (
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => { setNameInputId(tpl.id); setDeckName(tpl.name); }}
                  >
                    Use template
                  </button>
                )}
              </div>

              {previewId === tpl.id && tpl.sampleCards.length > 0 && (
                <div className="template-preview">
                  <p className="preview-label">Sample cards ({tpl.sampleCards.length}):</p>
                  {tpl.sampleCards.slice(0, 3).map((card, i) => (
                    <div key={i} className="preview-card">
                      {Object.entries(card).map(([k, v]) => (
                        <div key={k} className="preview-row">
                          <span className="preview-field">{k}</span>
                          <span className="preview-value">{v}</span>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
