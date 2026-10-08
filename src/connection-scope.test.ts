import { describe, expect, it } from 'vitest';
import { toolsForAccess } from './connection-scope';
import type { ChatSettings } from '../shared/types';

const catalog: ChatSettings['mcpToolCatalog'] = [
  { name: 'ask_symbi', access: 'read' },
  { name: 'upload_file', access: 'propose' },
  { name: 'delete_doc', access: 'write' },
  { name: 'apply_file_proposal', access: 'write', canApprove: true },
  { name: 'jev_configure', access: 'write', canConfigure: true },
];
describe('MCP connection tool choices from server discovery', () => {
  it('uses the supplied catalog and requires explicit approval and configuration grants', () => {
    expect(toolsForAccess('read', catalog)).toEqual(['ask_symbi']);
    expect(toolsForAccess('propose', catalog)).toEqual(['ask_symbi', 'upload_file']);
    expect(toolsForAccess('write', catalog)).toEqual(['ask_symbi', 'upload_file', 'delete_doc']);
    expect(toolsForAccess('write', catalog, { canApprove: true, canConfigure: true })).toEqual(catalog.map(tool => tool.name));
  });
  it('does not invent tools when server discovery is absent and includes newly registered tools', () => {
    expect(toolsForAccess('write')).toEqual([]);
    expect(toolsForAccess('read', [...catalog, { name: 'new_source_reader', access: 'read' }])).toContain('new_source_reader');
    expect(toolsForAccess('read', catalog, { canApprove: true })).not.toContain('apply_file_proposal');
  });
});
