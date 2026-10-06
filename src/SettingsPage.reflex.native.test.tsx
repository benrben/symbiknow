// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import { assistantFixture, installAssistantBrowser } from './AppAssistantPanel.test.helpers';
import type { JevWorkspaceState } from '../shared/jev-types';

installAssistantBrowser();

it('closes ordinary Settings and opens the current workspace Reflex settings through the real application event', async () => {
  const native = await assistantFixture(undefined, false);
  const source = await native.read('product-roadmap');
  fireEvent.click(screen.getByRole('button', { name: 'Symbi settings' }));
  const settings = await screen.findByRole('dialog', { name: 'Settings' });
  fireEvent.click(within(settings).getByRole('button', { name: 'Open Symbi Reflex settings' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull());
  expect(screen.getByRole('tab', { name: 'Symbi Reflex' }).getAttribute('aria-selected')).toBe('true');
  const panel = await screen.findByRole('region', { name: 'Symbi Reflex organization' });
  await within(panel).findByRole('heading', { name: 'Automatic knowledge organization' });
  const state = await native.request('/api/canvases/product-roadmap/jev/state').then(response => response.json()) as JevWorkspaceState;
  expect(state.settings.externalProcessing).toBe(true);
  expect(state.jobs).toEqual([]);
  expect(await native.read('product-roadmap')).toEqual(source);
});
