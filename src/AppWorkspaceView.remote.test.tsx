// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://workspace.team.test/"}
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { assistantFixture } from './AppAssistantPanel.test.helpers';
import { installWorkspaceBrowser } from './AppWorkspaceView.test.helpers';

installWorkspaceBrowser();
describe('workspace browser origin status', () => {
  it('shows the actual remote host in the sidebar', async () => {
    await assistantFixture(undefined, false);
    expect(window.location.host).toBe('workspace.team.test');
    expect(screen.getByText('workspace.team.test').getAttribute('title')).toBe('workspace.team.test');
    expect(screen.queryByText('Local workspace')).toBeNull();
  });
});
