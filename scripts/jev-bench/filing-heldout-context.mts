import { createHash } from 'node:crypto';
import type { JevEvaluationContext, JevInputDocument } from '../../server/jev/actions/context.js';
import type { JevDecider } from '../../server/jev.js';
import { emptyJevWorkspace } from '../../server/jev/workspace.js';
import type { HeldoutFilingCase, HeldoutGroup, HeldoutPeer } from './data/filing-heldout.mjs';

function document(id: string, title: string, content: string, canvasId: string): JevInputDocument {
  const contentHash = createHash('sha256').update(content).digest('hex');
  return { canvasId, block: { id, title, content, file: id + '.md', kind: 'markdown', x: 0, y: 0, width: 400, height: 300, links: [] },
    snapshot: { workspaceId: 'synthetic-filing', canvasId, blockId: id, incarnation: id + '-original', sourceGeneration: 1, metadataRevision: 1, contentHash } };
}
function peerDocument(item: HeldoutFilingCase, group: HeldoutGroup, peer: HeldoutPeer, index: number): JevInputDocument {
  const content = '# ' + peer.title + '\n\n' + peer.sections.map(section => '## ' + section + '\n' + group.definition).join('\n\n');
  const peerSource = document(item.id + '-peer-' + group.id.replace('custom:', '') + '-' + index, peer.title, content, item.id);
  peerSource.block.group = group.id;
  return peerSource;
}
/** A source is never its own member evidence; each of the three groups supplies two other document outlines. */
export function filingHeldoutContext(item: HeldoutFilingCase, decider: JevDecider, apiKey = 'local-synthetic-fixture'): JevEvaluationContext {
  const source = document(item.id, item.source.title, item.source.content, item.id);
  const peers = item.groups.flatMap(group => group.peers.map((peer, index) => peerDocument(item, group, peer, index)));
  return { workspaceId: 'synthetic-filing', documents: [source, ...peers],
    canvases: [{ id: item.id, name: 'Independent ' + item.domain + ' context',
      groups: item.groups.map(group => ({ id: group.id, name: group.name, definition: group.definition })) }],
    vocabulary: [], tasks: [], settings: emptyJevWorkspace().settings, apiKey, decider };
}
