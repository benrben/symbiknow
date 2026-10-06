import { useEffect, useRef, useState } from 'react';
import type { ModelProvider } from '../shared/types';
import { api } from './api';
import type { ModelOption } from './settings-page-types';

export function ModelPicker({ provider, value, onChange, ready }: { provider: ModelProvider; value: string; onChange: (value: string) => void; ready: boolean }) {
  const [models, setModels] = useState<ModelOption[] | null>(null);
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const requestVersion = useRef(0);
  useEffect(() => {
    requestVersion.current++;
    setModels(null); setError(''); setLoading(false);
    return () => { requestVersion.current++; };
  }, [provider]);

  async function load() {
    setOpen(true);
    if (loading) return;
    const request = ++requestVersion.current;
    setLoading(true);
    setError('');
    try {
      const result = await api<ModelOption[]>(`/models?provider=${provider}`);
      if (requestVersion.current === request) setModels(result);
    }
    catch (failure) { if (requestVersion.current === request) setError(modelFailure(failure)); }
    finally { if (requestVersion.current === request) setLoading(false); }
  }

  return <div className="model-picker">
    <label>Model<input aria-label="Model" required value={value} onChange={event => onChange(event.target.value)} placeholder="provider/model-id"/>
      <small>Pick a model that supports tool calling. {ready ? 'Browse the provider’s current list:' : 'Save a key first to browse models.'}</small></label>
    <button type="button" className="secondary-button" onClick={() => void load()} disabled={!ready && provider !== 'openrouter'}>{open ? 'Refresh list' : 'Browse models'}</button>
    {open && <ModelCatalog models={models} filter={filter} setFilter={setFilter} loading={loading} error={error} value={value} onChoose={id => { onChange(id); setOpen(false); }}/>}
  </div>;
}

function modelFailure(failure: unknown) { return failure instanceof Error ? failure.message : 'Could not load models.'; }

function ModelCatalog({ models, filter, setFilter, loading, error, value, onChoose }: { models: ModelOption[] | null; filter: string; setFilter: (value: string) => void; loading: boolean; error: string; value: string; onChoose: (value: string) => void }) {
  const shown = (models ?? []).filter(model => `${model.id} ${model.name}`.toLowerCase().includes(filter.toLowerCase())).slice(0, 80);
  return <div className="model-picker__panel">
      <input aria-label="Filter models" value={filter} onChange={event => setFilter(event.target.value)} placeholder="Filter by name…"/>
      {loading && <p className="model-picker__note">Loading models…</p>}
      {error && <p className="model-picker__note model-picker__note--error" role="alert">{error}</p>}
      {models && <ul role="listbox" aria-label="Available models">{shown.map(model => <li key={model.id}>
        <button type="button" role="option" aria-selected={model.id === value} onClick={() => onChoose(model.id)}>
          <span><strong>{model.name}</strong><code>{model.id}</code></span>
          <span className="model-picker__badges">{model.tools && <em>tools</em>}{model.context ? <em>{Math.round(model.context / 1000)}k</em> : null}</span>
        </button></li>)}
        {!shown.length && <li className="model-picker__note">No models match.</li>}
      </ul>}
    </div>;
}
