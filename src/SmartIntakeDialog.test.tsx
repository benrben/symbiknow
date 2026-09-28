// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SmartIntakeDialog, type IntakeDraft } from './SmartIntakeDialog';

afterEach(cleanup);

describe('Jev smart upload review', () => {
  const draft: IntakeDraft = { fileName: 'launch.md', title: 'launch', kind: 'markdown', sourceCanvasId: 'planning',
    index: 0, total: 1, previewing: false, error: '', suggestion: { canvasId: 'research', purpose: 'plan',
      workArea: 'product', tags: ['launch'], linkTargets: [{ blockId: 'roadmap', title: 'Roadmap', confidence: 0.91 }] } };
  const workspaces = [{ id: 'team', name: 'Team', canvases: [
    { id: 'planning', name: 'Planning' }, { id: 'research', name: 'Research' },
  ] }];

  it('lets the user accept selected suggestions and change the destination', () => {
    const onSave = vi.fn();
    render(<SmartIntakeDialog draft={draft} workspaces={workspaces} busy={false} onSave={onSave} onSkip={vi.fn()} onCancel={vi.fn()}/>);
    expect((screen.getByLabelText('Add to canvas') as HTMLSelectElement).value).toBe('research');
    expect(screen.getByLabelText('Link to Roadmap')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Add to canvas'), { target: { value: 'planning' } });
    fireEvent.click(screen.getByLabelText('Tags: launch'));
    expect(screen.queryByLabelText('Link to Roadmap')).toBeNull();
    expect(screen.getByText('Suggested links belong to another canvas, so they will not be added here.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add document' }));
    expect(onSave).toHaveBeenCalledWith({ canvasId: 'planning', purpose: 'plan', workArea: 'product', tags: [], links: [] });
  });

  it('explains when Jev has no suggestions and summarizes the upload destination', () => {
    render(<SmartIntakeDialog draft={{ ...draft, suggestion: null }} workspaces={workspaces} busy={false} onSave={vi.fn()} onSkip={vi.fn()} onCancel={vi.fn()}/>);
    expect(screen.getByText(/Jev has no suggestions/)).toBeTruthy();
    expect(screen.getByText(/still add it to the selected canvas/)).toBeTruthy();
    expect(screen.getByLabelText('Upload summary').textContent).toContain('Planning');
    expect(screen.getByRole('button', { name: 'Skip this file' })).toBeTruthy();
  });

  it('lets an upload continue if Jev preview failed', () => {
    const onSave = vi.fn();
    render(<SmartIntakeDialog draft={{ ...draft, suggestion: null, error: 'Jev unavailable' }} workspaces={workspaces}
      busy={false} onSave={onSave} onSkip={vi.fn()} onCancel={vi.fn()}/>);
    expect(screen.getByRole('alert').textContent).toContain('Jev unavailable');
    expect(screen.getByLabelText('Upload summary').textContent).toContain('launch');
    expect(screen.getByLabelText('Upload summary').textContent).toContain('Planning');
    fireEvent.click(screen.getByRole('button', { name: 'Add document' }));
    expect(onSave).toHaveBeenCalledWith({ canvasId: 'planning', tags: [], links: [] });
  });

  it('prevents a duplicate save when the result of adding a document is uncertain', () => {
    const onSave = vi.fn();
    render(<SmartIntakeDialog draft={{ ...draft, error: 'Connection lost', errorStage: 'save' }} workspaces={workspaces}
      busy={false} onSave={onSave} onSkip={vi.fn()} onCancel={vi.fn()}/>);
    expect(screen.getByRole('alert').textContent).toContain('inspect the destination canvas before trying again');
    expect(screen.getByRole('button', { name: 'Add document' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Skip this file' }).hasAttribute('disabled')).toBe(true);
    expect(onSave).not.toHaveBeenCalled();
  });
});
