import { useState } from 'react';
import type { JevSettings } from '../shared/jev-types';
import type { JevWorkspaceModel } from './useJevWorkspace';

export function JevAdvancedSettings({ model, settings }: { model: JevWorkspaceModel; settings: JevSettings; canvasId: string }) {
  const [name, setName] = useState(''); const [role, setRole] = useState('');
  return <details><summary>Known people</summary>
    <p>Known people help identify meaningful mentions in document profiles. You can add names and roles here.</p>
    {settings.people.map(person => <div className="jev-card" key={person.id}><span>{person.name} · {person.role}</span>
      <button type="button" disabled={model.busy} onClick={() => void model.send('settings', { people: settings.people.filter(item => item.id !== person.id) }, 'PUT')}>Remove {person.name}</button></div>)}
    <label>Person name<input value={name} onChange={event => setName(event.target.value)}/></label>
    <label>Role<input value={role} onChange={event => setRole(event.target.value)}/></label>
    <button type="button" disabled={model.busy || !name.trim()} onClick={() => void model.send('settings', { people: [...settings.people,
      { id: crypto.randomUUID(), name: name.trim(), role: role.trim() }] }, 'PUT').then(result => { if (result) { setName(''); setRole(''); } })}>Add known person</button>
  </details>;
}
