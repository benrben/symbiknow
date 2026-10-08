/** Synthetic, independently written home fixtures; send only after explicit heldout approval. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { HERE, makeDoc, type Doc } from '../common.mts';
function example(id: string, title: string, sections: Array<[string, string]>, canvasId: string): Doc {
  return makeDoc(`home-example-${id}`, title, `# ${title}\n\n${sections.map(([name, body]) => `## ${name}\n\n${body}`).join('\n\n')}`, canvasId);
}
export const heldoutHomeCanvases = [
  { id: 'field', name: 'Gardens and field ecology' },
  { id: 'collections', name: 'Collections and archives' },
  { id: 'coast', name: 'Sailing practice' },
  { id: 'stage', name: 'Theatre operations' },
  { id: 'bakery', name: 'Bread workshop' },
  { id: 'observatory', name: 'Observatory instruments' },
  { id: 'woodshop', name: 'Woodworking practice' },
];
export const heldoutHomeExamples = [
  example('planting', 'Seasonal garden care', [['Pruning', 'Remove crossing branches and inspect fruit trees for healthy growth.'], ['Watering', 'Set drip lines to moisten roots and inspect emitters each week.']], 'field'),
  example('ecology', 'Wetland and bird surveys', [['Drainage', 'Use planted basins to retain stormwater and protect nearby soil.'], ['Bird counts', 'Record birds at fixed field stations and compare counts across visits.']], 'field'),
  example('records', 'Collection records', [['Catalogue', 'Assign an accession number and record each museum object’s material and condition.'], ['Storage', 'Use padded supports and inspect storage humidity.']], 'collections'),
  example('images', 'Archive image care', [['Scanning', 'Scan photographs with a scale and preserve an untouched master image.'], ['Preservation', 'Store verified copies in separate locations and check their integrity.']], 'collections'),
  example('piloting', 'Sailing passage practice', [['Navigation', 'Plot coastal bearings and confirm charted landmarks before a tack.'], ['Safety', 'Inspect life jackets and rehearse a crew recovery manoeuvre.']], 'coast'),
  example('crew', 'Preparing the stage', [['Rigging', 'Inspect suspended equipment and document the load rating of each attachment.'], ['Evacuation', 'Keep exit routes clear and rehearse emergency cues with the crew.']], 'stage'),
  example('loaves', 'Daily bread making', [['Starter', 'Feed the sourdough culture and check its rise before mixing dough.'], ['Fermentation', 'Track dough temperature and adjust resting time before shaping loaves.']], 'bakery'),
  example('optics', 'Observatory equipment care', [['Alignment', 'Align the telescope axes and verify star tracking after adjustments.'], ['Lens care', 'Remove dust gently and inspect optical surfaces under diffuse light.']], 'observatory'),
  example('joints', 'Workshop bench exercises', [['Joinery', 'Mark timber joints and check their fit before glue-up.'], ['Maintenance', 'Sharpen hand-tool edges and inspect handles before use.']], 'woodshop'),
];
const fixtures = [
  ['orchard', 'field', 'collections'], ['drainage', 'field', 'stage'], ['wildlife', 'field', 'field'],
  ['museum', 'collections', 'bakery'], ['archive', 'collections', 'coast'], ['sailing', 'coast', 'observatory'],
  ['theatre', 'stage', 'woodshop'], ['bread', 'bakery', 'bakery'], ['observatory', 'observatory', 'field'],
  ['apprentice', 'woodshop', 'collections'],
] as const;
export const heldoutHomeCases = fixtures.map(([id, right, current]) => {
  const body = readFileSync(path.join(HERE, 'data/profile-heldout', `${id}.md`), 'utf8');
  return { doc: makeDoc(`home-heldout-${id}`, body.match(/^#\s+(.+)$/m)?.[1] ?? id, body, current), current, right };
});
