import { useState } from 'react';
import type { CanvasBookmark, CanvasPlace } from './useCanvasJourney';
import './canvas-navigation.css';

type Props = {
  canvasName: string;
  canBack: boolean;
  canForward: boolean;
  bookmarks: CanvasBookmark[];
  recent: CanvasPlace[];
  headerHidden: boolean;
  onBack: () => void;
  onForward: () => void;
  onBookmark: (name: string) => void;
  onRemoveBookmark: (id: string) => void;
  onNavigate: (place: CanvasPlace) => void;
  onToggleHeader: () => void;
};

export function CanvasNavigation({ canvasName, canBack, canForward, bookmarks, recent, headerHidden,
  onBack, onForward, onBookmark, onRemoveBookmark, onNavigate, onToggleHeader }: Props) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  return <div className="canvas-navigation">
    <button type="button" onClick={onBack} disabled={!canBack} aria-label="Back to previous canvas view">←</button>
    <button type="button" onClick={onForward} disabled={!canForward} aria-label="Forward to next canvas view">→</button>
    <span className="canvas-navigation__place">{canvasName}</span>
    <button type="button" onClick={() => setOpen(value => !value)} aria-expanded={open} aria-label="Bookmarks and recently viewed">♧ <span>Places</span></button>
    <button type="button" onClick={onToggleHeader}>{headerHidden ? 'Show header' : 'Hide header'}</button>
    {open && <div className="canvas-navigation__menu">
      <form onSubmit={event => { event.preventDefault(); if (!name.trim()) return; onBookmark(name); setName(''); }}>
        <label htmlFor="bookmark-name">Save this view</label>
        <div><input id="bookmark-name" value={name} onChange={event => setName(event.target.value)} placeholder="Name this place" maxLength={60}/><button type="submit" disabled={!name.trim()}>Pin</button></div>
      </form>
      <section><h3>Bookmarks</h3>{bookmarks.length === 0 && <p>No saved places yet.</p>}{bookmarks.map(item => <div key={item.id} className="canvas-navigation__item"><button type="button" onClick={() => { onNavigate(item); setOpen(false); }}><strong>{item.name}</strong><small>{item.canvasName}{item.title ? ` › ${item.title}` : ''}</small></button><button type="button" onClick={() => onRemoveBookmark(item.id)} aria-label={`Remove bookmark ${item.name}`}>×</button></div>)}</section>
      <section><h3>Recently viewed</h3>{recent.length === 0 && <p>Select a document to start a history.</p>}{recent.map(item => <button className="canvas-navigation__recent" type="button" key={`${item.canvasId}:${item.blockId}`} onClick={() => { onNavigate(item); setOpen(false); }}><strong>{item.title}</strong><small>{item.canvasName}</small></button>)}</section>
    </div>}
  </div>;
}
