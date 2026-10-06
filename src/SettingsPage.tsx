import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { AgentPlugin, ChatSettings } from '../shared/types';
import { ConnectAgents, type OpenActivityHistory } from './SettingsConnections';
import { Section } from './SettingsSection';
import { SettingsModels } from './SettingsModels';
import { initialSettingsDraft, settingsPayload, settingsSecretNames, withEditedProfiles } from './settings-page-model';
import { ProfileEditor } from './SettingsProfiles';
import { SecretsEditor } from './SettingsSecrets';
import { ServersEditor } from './SettingsServers';
import { builtInProfiles, pluginInfo, sections } from './settings-page-values';
import type { SectionId, SettingsPayload } from './settings-page-types';
import { SettingsFooter } from './SettingsFooter';
import './settings.css';
export type { SettingsPayload } from './settings-page-types';

/** The section crossing the middle of the view; at the very bottom, the last section even when it is short. */
function sectionAt(scrollRoot: HTMLElement): SectionId {
  const atBottom = scrollRoot.scrollTop > 0 && scrollRoot.scrollHeight - scrollRoot.scrollTop - scrollRoot.clientHeight < 2;
  if (atBottom) return sections.at(-1)!.id;
  const rootBounds = scrollRoot.getBoundingClientRect();
  const activationLine = rootBounds.top + rootBounds.height / 2;
  let current: SectionId = sections[0].id;
  for (const section of sections) {
    const element = scrollRoot.querySelector<HTMLElement>(`[data-section="${section.id}"]`);
    if (!element) continue;
    if (element.getBoundingClientRect().top <= activationLine) current = section.id;
    else break;
  }
  return current;
}

export function SettingsPage({ settings, busy, onSave, onCancel, onSettings, onOpenHistory }: {
  settings: ChatSettings;
  busy: boolean;
  onSave: (payload: SettingsPayload) => Promise<void>;
  onCancel: () => void;
  onSettings: (settings: ChatSettings) => void;
  onOpenHistory?: OpenActivityHistory;
}) {
  const [draft, setDraft] = useState(() => initialSettingsDraft(settings));
  const [apiKey, setApiKey] = useState('');
  const [saveError, setSaveError] = useState('');
  const [secrets, setSecrets] = useState<Record<string, string | null>>({});
  const [active, setActive] = useState<SectionId>('models');
  const scroller = useRef<HTMLDivElement>(null);
  // A clicked section stays highlighted while its smooth scroll passes the sections in between.
  const jumping = useRef(0);
  const secretNames = useMemo(() => settingsSecretNames(settings, secrets), [settings.secretNames, secrets]);

  useEffect(() => {
    // The scroller is unconditional, and this effect runs after its ref commits.
    const scrollRoot = scroller.current!;
    function updateActiveSection() { if (!jumping.current) setActive(sectionAt(scrollRoot)); }
    function endJump() { window.clearTimeout(jumping.current); jumping.current = 0; }
    scrollRoot.addEventListener('scroll', updateActiveSection, { passive: true });
    scrollRoot.addEventListener('scrollend', endJump);
    window.addEventListener('resize', updateActiveSection);
    return () => {
      endJump();
      scrollRoot.removeEventListener('scroll', updateActiveSection);
      scrollRoot.removeEventListener('scrollend', endJump);
      window.removeEventListener('resize', updateActiveSection);
    };
  }, []);

  function jump(id: SectionId) {
    window.clearTimeout(jumping.current);
    // scrollend never fires when the section is already in place, so the pause also ends on its own.
    jumping.current = window.setTimeout(() => { jumping.current = 0; }, 900);
    setActive(id);
    document.getElementById(`settings-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function update<K extends keyof typeof draft>(key: K, value: (typeof draft)[K]) { setDraft(current => ({ ...current, [key]: value })); }

  function togglePlugin(id: AgentPlugin) {
    update('agentPlugins', draft.agentPlugins.includes(id) ? draft.agentPlugins.filter(item => item !== id) : [...draft.agentPlugins, id]);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const payload = settingsPayload(draft, secretNames, secrets);
    if (apiKey.trim()) payload.apiKey = apiKey.trim();
    setSaveError('');
    try { await onSave(payload); }
    catch (failure) { setSaveError(failure instanceof Error ? failure.message : 'Could not save Settings.'); }
  }

  const profiles = [...builtInProfiles, ...draft.customProfiles];

  return <form onSubmit={submit} className="settings-page">
    <nav className="settings-page__nav" aria-label="Settings sections">{sections.map(section => <button type="button" key={section.id}
      className={active === section.id ? 'active' : ''} aria-current={active === section.id ? 'true' : undefined} onClick={() => jump(section.id)}>
      <span aria-hidden="true">{section.icon}</span>{section.label}</button>)}
      <p>Keys and secrets stay on the canvas server. The browser only learns whether they are set.</p></nav>
    <div className="settings-page__main"><div className="settings-page__scroll" ref={scroller}>
      <SettingsModels draft={draft} settings={settings} apiKey={apiKey} setApiKey={setApiKey} update={update}/>

      <Section id="agents" title="Agents" description="Profiles set how the chat agent works. Tool access is chosen under Plugins.">
        <label>Agent profile<select value={draft.agentProfile} onChange={event => update('agentProfile', event.target.value)}>
          {profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select>
          <small>{profiles.find(profile => profile.id === draft.agentProfile)?.instructions}</small></label>
        <div className="settings-subheading">Custom profiles</div>
        <ProfileEditor profiles={draft.customProfiles} onChange={profiles => setDraft(current => withEditedProfiles(current, profiles))}/>
        <label>System prompt<textarea rows={4} value={draft.systemPrompt} onChange={event => update('systemPrompt', event.target.value)} placeholder="How should Symbi work?"/></label>
      </Section>

      <Section id="secrets" title="Secrets" description="Named values for outside MCP servers and integrations. Saved with the rest of the settings.">
        <SecretsEditor names={settings.secretNames ?? []} pending={secrets} onPending={setSecrets}/>
      </Section>

      <Section id="servers" title="External tools Symbi can use" description="Connect outside MCP servers to give Symbi’s chat agent tools such as GitHub, Linear, or your own services. Changes here are pending until you save Settings.">
        <ServersEditor servers={draft.mcpServers} secretNames={secretNames} onChange={value => update('mcpServers', value)}/>
      </Section>

      <Section id="connect" title="Agents that can access this workspace" description="Create access tokens for Codex, Claude Code, Claude.ai, and other MCP clients. Token creation and revocation take effect immediately, independent of pending Settings changes.">
        <ConnectAgents settings={settings} onSettings={onSettings} onOpenHistory={onOpenHistory}/>
      </Section>

      <Section id="plugins" title="Plugins & loaders" description="Choose which tool packs the chat agent can call. Canvas buttons and MCP clients keep their own controls.">
        {pluginInfo.map(item => <label className="plugin-toggle" key={item.id}><span><strong>{item.title}</strong><small>{item.detail}</small></span>
          <input type="checkbox" checked={draft.agentPlugins.includes(item.id)} onChange={() => togglePlugin(item.id)}/></label>)}
        <div className="settings-page__section-heading settings-page__section-heading--spaced"><h3>Installed canvas loaders</h3><p>These render document content in the canvas and full-page reader.</p></div>
        <div className="loader-list">{['Markdown + GFM', 'Shiki code', 'Mermaid diagrams', 'Marp slides', 'Video', 'MDX components', 'Interactive HTML', 'Full websites'].map(item => <span key={item}>✓ {item}</span>)}</div>
      </Section>

      <Section id="jev" title="Symbi Reflex organization" description="Workspace consent, action modes, review, and pause are managed in Symbi Reflex's organization panel. Save TYPESAFE_API_KEY as a named secret above.">
        <button type="button" className="secondary-button" onClick={() => { onCancel(); window.dispatchEvent(new Event('symbiknow:open-jev')); }}>Open Symbi Reflex settings</button>
      </Section>

    </div><SettingsFooter saveError={saveError} busy={busy} onCancel={onCancel}/></div>
  </form>;
}
