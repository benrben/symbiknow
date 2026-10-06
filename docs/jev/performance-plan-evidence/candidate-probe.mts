import { readFile, writeFile } from 'node:fs/promises';
import { canvasTopicCatalog } from '/Users/benreich/allteam/server/jev/actions/group-topics.ts';
import { sharedSourceCategories } from '/Users/benreich/allteam/server/jev/actions/source-categories.ts';
import { sourcePassages, passageCoverage } from '/Users/benreich/allteam/server/jev/actions/source-passages.ts';
import { filingPassages } from '/Users/benreich/allteam/server/jev/actions/group-passages.ts';
import { sourceSnapshot } from '/Users/benreich/allteam/server/jev/stamps.ts';
import type { StoredCanvas } from '/Users/benreich/allteam/server/storage-shapes.ts';
import type { JevWorkspaceState } from '/Users/benreich/allteam/shared/jev-types.ts';
import type { JevEvaluationContext } from '/Users/benreich/allteam/server/jev/actions/context.ts';
const root='/Users/benreich/allteam/data';
const canvasFile=root+'/canvases/6a671ad9-377e-4868-9ad2-bbf40d9ad95c.json';
const ledgerFile=root+'/jev/workspaces/acme-team/state.json';
const canvasBytes=await readFile(canvasFile,'utf8'), ledgerBytes=await readFile(ledgerFile,'utf8');
const canvas=JSON.parse(canvasBytes) as StoredCanvas, ledger=JSON.parse(ledgerBytes) as JevWorkspaceState;
const documents=await Promise.all(canvas.blocks.map(async (entry)=>{const block={...entry,content:await readFile(root+'/'+entry.file,'utf8')};return {canvasId:canvas.id,block,snapshot:sourceSnapshot('acme-team',canvas.id,block)}}));
const report=JSON.parse(await readFile('/Users/benreich/allteam/jev-real146-postfix-result.json','utf8')) as {docs:Array<{id:string}>};
const targetIds=new Set(report.docs.map((d)=>d.id));
const context:JevEvaluationContext={workspaceId:'acme-team',documents,canvases:[{id:canvas.id,name:canvas.name}],tasks:[],vocabulary:ledger.vocabulary,settings:ledger.settings};
const rows=documents.filter((d)=>targetIds.has(d.block.id)).map((d)=>{
 const catalog=canvasTopicCatalog(context,d), categories=sharedSourceCategories(documents,d), all=sourcePassages(d.block.content), sampled=filingPassages(d);
 const sampledRaw=new Set(sampled.map((p)=>`${p.start}:${p.end}`));
 const sampledSource=all.filter((p)=>sampledRaw.has(`${p.start}:${p.end}`));
 return {id:d.block.id,candidates:catalog.length,sharedCategories:categories.length,categoryCandidateNames:categories.filter((c)=>catalog.some((g)=>g.name===c.name)).length,
 categoryEvidenceSampled:categories.some((c)=>c.origins.some((p)=>p.source.blockId===d.block.id&&sampledRaw.has(`${p.start}:${p.end}`))),visiblePassages:all.length,evidencePassages:sampled.length,coverage:passageCoverage(all,sampledSource),
 exactEvidence:sampled.every((p)=>d.block.content.slice(p.start,p.end)===p.quote)};
});
const hist=(key:'candidates'|'sharedCategories')=>Object.fromEntries([...new Set(rows.map((r)=>r[key]))].sort((a,b)=>a-b).map(v=>[String(v),rows.filter((r)=>r[key]===v).length]));
const summary={scope:'read-only current retained corpus; no provider answers replayed',documents:rows.length,candidateCount:hist('candidates'),sharedCategoryCount:hist('sharedCategories'),
 withSharedCategoryInCandidates:rows.filter((r)=>r.categoryCandidateNames>0).length,withSharedCategoryEvidenceSampled:rows.filter((r)=>r.categoryEvidenceSampled).length,
 coverage:{min:Math.min(...rows.map((r)=>r.coverage)),median:rows.map((r)=>r.coverage).sort((a:number,b:number)=>a-b)[Math.floor(rows.length/2)],max:Math.max(...rows.map((r)=>r.coverage))},
 exactEvidenceAll:rows.every((r)=>r.exactEvidence),canonicalBytesUnchanged:canvasBytes===await readFile(canvasFile,'utf8')&&ledgerBytes===await readFile(ledgerFile,'utf8'),providerCalls:0};
await writeFile('/private/tmp/jev-candidate-readonly-probe-result.json',JSON.stringify({summary,rows},null,2));
console.log(JSON.stringify(summary,null,2));
