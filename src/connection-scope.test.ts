import { describe, expect, it } from 'vitest';
import { toolsForAccess } from './connection-scope';

describe('ordinary MCP connection tool choices', () => {
  it('retains document, file and version tools and excludes removed tools', () => {
    const ordinaryRead = ['list_canvases', 'read_canvas', 'search_docs', 'read_doc', 'download_file', 'list_versions'];
    expect(toolsForAccess('write')).not.toContain('recall');
    const reflexRead = ['jev_profile', 'find_by', 'related', 'memory_map', 'jev_activity', 'brain_inbox', 'jev_job'];
    const read = [...ordinaryRead, ...reflexRead];
    expect(toolsForAccess('read')).toEqual(read);
    expect(toolsForAccess('propose')).toEqual([...read, 'jev_propose']);
    expect(toolsForAccess('write')).toEqual([...read.slice(0, 4), 'create_doc', 'edit_doc', 'delete_doc', 'move_block',
      'link_blocks', 'unlink_blocks', 'upload_file', 'download_file', 'claim_doc', 'release_doc',
      'list_versions', 'create_branch', 'switch_branch', 'merge_branch', 'restore_revision', ...reflexRead, 'jev_do', 'jev_propose']);
    expect(toolsForAccess('write').some(name => name.includes('task'))).toBe(false);
    expect(toolsForAccess('write')).not.toEqual(expect.arrayContaining(['analyze_canvas', 'find_duplicates', 'merge_documents',
      'undo_merge', 'connect_across_canvases', 'score_documents', 'run_workspace_automation']));
  });
});
