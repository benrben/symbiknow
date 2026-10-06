// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useState } from 'react';
import type { CanvasBlock, CanvasDocument } from '../shared/types';
import { assistantFixture, installAssistantBrowser, jsonBody } from './AppAssistantPanel.test.helpers';
import { useAppModel } from './app-model';
import { MainColumn, Sidebar } from './AppWorkspaceView';

installAssistantBrowser();
function NativeWorkspace({ other, block }: { other: CanvasDocument; block: CanvasBlock }) {
  const model = useAppModel();
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  return <>
    <Sidebar model={model}/>
    <MainColumn model={model} theme={theme} onToggleTheme={() => setTheme(current => current === 'light' ? 'dark' : 'light')}/>
    <button onClick={() => model.showBlockOnCanvas(other.id, block.id, block.title)}>Focus destination document</button>
    <output aria-label="Requested document canvas">{model.focusRequest?.canvasId}</output>
  </>;
}
describe('workspace focus requests across native browser navigation', () => {
  it('ignores a retained destination focus after the browser returns to the original canvas', async () => {
    let other!: CanvasDocument;
    let block!: CanvasBlock;
    const fixture = await assistantFixture(undefined, false, async request => {
      other = await request('/api/workspaces/acme-team/canvases', jsonBody({ name: 'Destination' })).then(response => response.json()) as CanvasDocument;
      block = await request('/api/canvases/' + other.id + '/blocks', jsonBody({ title: 'Destination evidence', kind: 'markdown', content: 'Durable source' })).then(response => response.json()) as CanvasBlock;
    });
    const original = await fixture.read('product-roadmap');
    fixture.unmount();
    render(<NativeWorkspace other={other} block={block}/>);
    await screen.findByText(original.name, { selector: '.canvas-label h1' });
    fireEvent.click(screen.getByRole('button', { name: 'Focus destination document' }));
    await screen.findByText(other.name, { selector: '.canvas-label h1' });
    expect(screen.getByLabelText('Requested document canvas').textContent).toBe(other.id);
    window.history.back();
    await screen.findByText(original.name, { selector: '.canvas-label h1' });
    expect(screen.getByLabelText('Requested document canvas').textContent).toBe(other.id);
    await waitFor(() => expect(document.querySelectorAll('.react-flow__node[data-id="' + block.id + '"]')).toHaveLength(0));
    expect(await fixture.read(original.id)).toEqual(original);
    expect((await fixture.read(other.id)).blocks).toEqual([block]);
  });
});
