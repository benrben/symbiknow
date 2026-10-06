import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import type { AgentProfile } from '../shared/types';
import { uniqueSettingsId } from './settings-page-values';

export function ProfileEditor({ profiles, onChange }: { profiles: AgentProfile[]; onChange: (profiles: AgentProfile[]) => void }) {
  const [name, setName] = useState('');
  const [instructions, setInstructions] = useState('');
  const canAdd = Boolean(name.trim() && instructions.trim());
  function add() {
    const base = `custom-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'profile'}`;
    onChange([...profiles, { id: uniqueSettingsId(base, profiles), name: name.trim(), instructions: instructions.trim() }]);
    setName('');
    setInstructions('');
  }
  return <div className="profile-editor">
    {profiles.map((profile, index) => <div className="profile-editor__item" key={profile.id}>
      <input aria-label={`Name for ${profile.name}`} value={profile.name} onChange={event => onChange(profiles.map((item, position) => position === index ? { ...item, name: event.target.value } : item))}/>
      <textarea aria-label={`Instructions for ${profile.name}`} rows={2} value={profile.instructions} onChange={event => onChange(profiles.map((item, position) => position === index ? { ...item, instructions: event.target.value } : item))}/>
      <button type="button" className="icon-button" aria-label={`Remove ${profile.name}`} onClick={() => onChange(profiles.filter((_, position) => position !== index))}><Trash2 size={14}/></button>
    </div>)}
    <div className="profile-editor__new">
      <input aria-label="New profile name" value={name} onChange={event => setName(event.target.value)} placeholder="Profile name, e.g. Sales coach"/>
      <textarea aria-label="New profile instructions" rows={2} value={instructions} onChange={event => setInstructions(event.target.value)} placeholder="How should this agent work?"/>
      <button type="button" className="secondary-button" onClick={add} disabled={!canAdd}>Add profile</button>
    </div>
  </div>;
}
