import { expect, it } from 'vitest';
import type { JevVocabularyTerm } from '../../../shared/jev-types.js';
import type { JevAnswer, JevDecider } from '../../jev.js';
import { sourceSnapshot } from '../stamps.js';
import { emptyJevWorkspace } from '../workspace.js';
import type { JevEvaluationContext, JevInputDocument } from './context.js';
import { file } from './profile.js';

function document(id: string, group?: string): JevInputDocument {
  const block = { id, title: `Robot ${id}`, file: `${id}.md`, kind: 'markdown' as const, group,
    content: '# Robotics\n\nRobot controllers use sensor feedback to steer the wheels.',
    incarnation: id, sourceGeneration: 1, metadataRevision: 1, x: 0, y: 0, width: 400, height: 300, links: [],
    // The pinned source keeps the decline path local, so the test observes only the filing question.
    jevOwnership: { managed: [], pins: id === 'source' ? ['group' as const] : [], removedLabels: [], removedLinks: [] } };
  return { canvasId: 'canvas', block, snapshot: sourceSnapshot('workspace', 'canvas', block) };
}
const retiredArchive: JevVocabularyTerm = { id: 'archive', kind: 'group', name: 'Archive', groupKey: 'custom:archive',
  definition: 'Superseded material', aliases: [], state: 'retired', version: 1, members: [] };

it('offers no retired group and names an undefined canvas group by its own name when filing', async () => {
  const offered: Array<Array<{ key: string; name: string; definition: string }>> = [];
  const decider: JevDecider = async (_key, state, questions) => {
    if ('place' in questions) offered.push((state as { groups: Array<{ key: string; name: string; definition: string }> }).groups);
    return Object.fromEntries(Object.entries(questions).map(([id, question]): [string, JevAnswer] => {
      if (question.type !== 'choice') return [id, { type: 'noul', noul: .01 }];
      const probabilities = Object.fromEntries(Object.keys(question.criteria).map(option => [option, Number(option === 'none')]));
      return [id, { type: 'choice', choice: 'none', confidence: .99, probabilities }];
    }));
  };
  const context: JevEvaluationContext = { workspaceId: 'workspace', tasks: [], indexes: {}, vocabulary: [retiredArchive],
    documents: [document('source'), document('archived', 'custom:archive'), document('controller', 'custom:robotics')],
    canvases: [{ id: 'canvas', name: 'Robotics lab', groups: [{ id: 'custom:handbook', name: 'Handbook' }] }],
    settings: emptyJevWorkspace().settings, confidenceThreshold: .7, apiKey: 'local-fixture', decider };
  const result = await file(context, { action: 'file', canvasId: 'canvas', blockIds: ['source'] });
  expect(result.proposals).toEqual([]);
  expect(offered).toHaveLength(1);
  expect(offered[0].map(group => group.key)).toEqual(['custom:robotics', 'custom:handbook']);
  expect(offered[0][1]).toMatchObject({ name: 'Handbook', definition: 'Handbook' });
});
