// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { assistantFixture } from './AppAssistantPanel.test.helpers';
import { installWorkspaceBrowser } from './AppWorkspaceView.test.helpers';

installWorkspaceBrowser();

describe('canvas task navigation through the app', () => {
  it('opens tasks, retains the task URL after remount, and returns through browser history', async () => {
    const fixture = await assistantFixture(undefined, false, async request => {
      const workspaces = await request('/api/workspaces').then(response => response.json());
      await request(`/api/workspaces/${workspaces[0].id}/canvases`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Second canvas' }),
      });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Tasks' }));
    await screen.findByRole('main', { name: 'Tasks for Product Roadmap' });
    expect(window.location.search).toContain('view=todos');
    expect(screen.queryByRole('button', { name: 'Create note' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Back to canvas' })).toHaveProperty('disabled', false);
    fixture.unmount();
    render(<App />);
    await screen.findByRole('main', { name: 'Tasks for Product Roadmap' });
    fireEvent.click(screen.getByRole('button', { name: 'Back to canvas' }));
    await screen.findByRole('region', { name: 'Product Roadmap infinite canvas' });
    expect(new URLSearchParams(window.location.search).has('view')).toBe(false);
    act(() => {
      window.history.replaceState(null, '', '/?canvas=product-roadmap&view=todos');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await screen.findByRole('main', { name: 'Tasks for Product Roadmap' });
    const other = (await fixture.documents()).flatMap(workspace => workspace.canvases).find(canvas => canvas.id !== 'product-roadmap')!;
    fireEvent.click(screen.getByRole('button', { name: `Open canvas: ${other.name}` }));
    await screen.findByRole('region', { name: `${other.name} infinite canvas` });
    expect(new URLSearchParams(window.location.search).has('view')).toBe(false);
  });
  it('focuses tasks on a small screen and lets the user reopen the assistant', async () => {
    await assistantFixture(undefined, false);
    fireEvent.click(screen.getByRole('button', { name: 'Tasks' }));
    await screen.findByRole('main', { name: 'Tasks for Product Roadmap' });
    vi.stubGlobal('innerWidth', 390);
    fireEvent(window, new Event('resize'));
    expect(screen.queryByRole('complementary', { name: 'Symbi assistant' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Toggle Symbi' }));
    expect(screen.getByRole('complementary', { name: 'Symbi assistant' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back to canvas' }));
    await screen.findByRole('region', { name: 'Product Roadmap infinite canvas' });
    fireEvent.click(screen.getByRole('button', { name: 'Tasks' }));
    await screen.findByRole('main', { name: 'Tasks for Product Roadmap' });
    expect(screen.queryByRole('complementary', { name: 'Symbi assistant' })).toBeNull();
    vi.unstubAllGlobals();
  });
});
