import type { KeyboardEvent } from 'react';
import type { ChatSettings, ModelProvider } from '../shared/types';
import { ModelPicker } from './SettingsModelPicker';
import { Section } from './SettingsSection';
import { providerInfo } from './settings-page-values';
import { providerIsReady, type SettingsDraft, type UpdateSettingsDraft } from './settings-page-model';

function cycleProviders(event: KeyboardEvent<HTMLDivElement>) {
  if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(event.key)) return;
  const radios = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
  const current = radios.indexOf(document.activeElement as HTMLButtonElement);
  if (current < 0) return;
  event.preventDefault();
  const delta = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1;
  const next = radios[(current + delta + radios.length) % radios.length];
  next.click();
  next.focus();
}

export function SettingsModels({ draft, settings, apiKey, setApiKey, update }: {
  draft: SettingsDraft; settings: ChatSettings; apiKey: string; setApiKey: (key: string) => void; update: UpdateSettingsDraft;
}) {
  const provider = providerInfo[draft.provider];
  const providerReady = providerIsReady(settings, draft.provider);
  return <Section id="models" title="Models" description="Choose who runs the chat agent. Any provider with tool calling works with Deep Agents.">
        <div className="provider-grid" role="radiogroup" aria-label="Model provider" onKeyDown={cycleProviders}>{(Object.keys(providerInfo) as ModelProvider[]).map(id => {
          const info = providerInfo[id];
          const ready = providerIsReady(settings, id);
          return <button type="button" role="radio" aria-checked={draft.provider === id} tabIndex={draft.provider === id ? 0 : -1} key={id} className={`provider-option${draft.provider === id ? ' is-selected' : ''}`}
            onClick={() => { update('provider', id); setApiKey(''); }}>
            <span className="provider-logo">{info.glyph}</span><span><strong>{info.name}</strong><small>{info.description}</small></span>
            <span className={'provider-status ' + (ready ? 'connected' : '')}>{ready ? 'Connected' : 'Not set'}</span>
          </button>;
        })}</div>
        {draft.provider === 'custom' && <label>Base URL<input value={draft.baseUrl} onChange={event => update('baseUrl', event.target.value)} placeholder="https://llm.example.com/v1"/>
          <small>An OpenAI-compatible <code>/v1</code> endpoint that the canvas server can reach.</small></label>}
        <label>{provider.name} API key<input type="password" autoComplete="new-password" value={apiKey} onChange={event => setApiKey(event.target.value)}
          placeholder={providerReady ? 'Saved — enter a new key to replace' : provider.placeholder}/>
          <small>{providerReady ? 'A key is saved. It is never returned to this browser after saving.' : 'Stored on the canvas server and sent only to this provider.'}</small></label>
        <ModelPicker provider={draft.provider} value={draft.model} onChange={value => update('model', value)} ready={providerReady}/>
      </Section>;
}
