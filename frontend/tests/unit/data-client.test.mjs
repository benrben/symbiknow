import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const react = new URL('../../node_modules/react/index.js', import.meta.url).href;
const source = (await readFile(new URL('../../src/shared/api/client.ts', import.meta.url),'utf8'))
  .replace('from "react"', `from ${JSON.stringify(react)}`);
const { outputText } = ts.transpileModule(source, {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}});
const {api,invalidateResponses,peekCachedLibrary}=await import('data:text/javascript;base64,'+Buffer.from(outputText).toString('base64'));
const reply = value => ({ok:true,json:async()=>value});
function deferred() {let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}

test('coalesced consumers cancel independently and successful response is reused',async()=>{
  invalidateResponses('coalescing');
  const pending=deferred();let calls=0;
  globalThis.fetch=(_url,options)=>{calls++;assert.ok(options.signal instanceof AbortSignal);return pending.promise;};
  const cancel=new AbortController();
  const first=api('card?id=one&version=v1',undefined,cancel.signal);
  const second=api('card?id=one&version=v1');
  cancel.abort();
  await assert.rejects(first,{name:'AbortError'});
  pending.resolve(reply({evidence:[{text:'source'}]}));
  assert.deepEqual(await second,{evidence:[{text:'source'}]});
  assert.deepEqual(await api('card?id=one&version=v1'),{evidence:[{text:'source'}]});
  assert.equal(calls,1);
});
test('same-head evidence publication invalidates retained and in-flight values',async()=>{
  invalidateResponses('index-one');
  const old=deferred();let calls=0;
  globalThis.fetch=()=>{calls++;return calls===1?old.promise:Promise.resolve(reply({evidence:[{text:'new evidence'}]}));};
  const stale=api('card?id=one&version=v1');
  invalidateResponses('index-two');
  const current=await api('card?id=one&version=v1');
  old.resolve(reply({evidence:[{text:'old evidence'}]}));
  await assert.rejects(stale,{name:'AbortError'});
  assert.deepEqual(await api('card?id=one&version=v1'),current);
  assert.equal(current.evidence[0].text,'new evidence');assert.equal(calls,2);
});
test('failed work is never cached',async()=>{
  invalidateResponses('failure');let calls=0;
  globalThis.fetch=async()=>++calls===1?{ok:false,json:async()=>({error:'unavailable'})}:reply({evidence:[]});
  await assert.rejects(api('card?id=failure&version=v1'),/unavailable/);
  assert.deepEqual(await api('card?id=failure&version=v1'),{evidence:[]});assert.equal(calls,2);
});
test('pending read budget rejects overflow and releases slots after completion',async()=>{
  invalidateResponses('budget');const pending=deferred();globalThis.fetch=()=>pending.promise;
  const reads=Array.from({length:128},(_,i)=>api(`evidence?id=${i}`));
  await assert.rejects(api('evidence?id=overflow'),/Too many pending/);
  pending.resolve(reply({evidence:[]}));await Promise.all(reads);
  assert.deepEqual(await api('evidence?id=after'),{evidence:[]});
});
test('out of order library responses cannot roll the observed revision backward',async()=>{
  invalidateResponses('epoch');
  const old=deferred();let calls=0;
  const version=(index)=>({library_id:'library',index_revision:index,organization_revision:'org',manual_revision:'manual'});
  globalThis.fetch=()=>++calls===1?old.promise:Promise.resolve(reply(version('new')));
  const stale=api('library?folder=old');
  assert.equal((await api('library?folder=new')).index_revision,'new');
  old.resolve(reply(version('old')));
  await assert.rejects(stale,{name:'AbortError'});
});
test('search and nonfinal upload chunks keep unchanged preview reuse',async()=>{
  invalidateResponses('read-only-post');let cards=0;
  globalThis.fetch=async url=>{if(url.includes('/card?'))cards++;return reply({evidence:[{text:'current'}]});};
  await api('card?id=stable&version=v1');
  await api('search',{query:'word'});
  await api('upload',{files:[{total_size:100,final:false}]});
  await api('card?id=stable&version=v1');assert.equal(cards,1);
});
test('a lost final upload response invalidates potentially committed previews',async()=>{
  invalidateResponses('lost-response');let cards=0;
  globalThis.fetch=async url=>{if(url.includes('/upload'))throw new Error('connection lost');cards++;return reply({evidence:[{text:'version'}]});};
  await api('card?id=committed&version=v1');
  await assert.rejects(api('upload',{files:[{total_size:100,final:true}]}),/connection lost/);
  await api('card?id=committed&version=v1');assert.equal(cards,2);
});
test('each coalesced and retained consumer owns a private response',async()=>{
  invalidateResponses('private-values');
  const pending=deferred();globalThis.fetch=()=>pending.promise;
  const one=api('card?id=private&version=v1'),two=api('card?id=private&version=v1');
  pending.resolve(reply({evidence:[{text:'original'}]}));
  const first=await one,second=await two;first.evidence[0].text='changed';
  assert.equal(second.evidence[0].text,'original');
  assert.equal((await api('card?id=private&version=v1')).evidence[0].text,'original');
});
test('identical POST searches coalesce by exact canonical arguments with private cancellation',async()=>{
  invalidateResponses('post-coalescing');const pending=deferred();let calls=0;
  globalThis.fetch=(_url,options)=>{calls++;assert.equal(options.method,'POST');assert.ok(options.signal instanceof AbortSignal);assert.equal(JSON.parse(options.body).query,'same');return pending.promise;};
  const cancel=new AbortController();
  const one=api('search',{query:'same',limit:8},cancel.signal);
  const two=api('search',{limit:8,query:'same'});
  cancel.abort();await assert.rejects(one,{name:'AbortError'});
  pending.resolve(reply({matches:[{document_id:'result'}]}));
  assert.equal((await two).matches[0].document_id,'result');assert.equal(calls,1);
});

test('last canceled consumer aborts transport and an already canceled request never starts',async()=>{
  invalidateResponses('transport-abort');let transport;let calls=0;
  globalThis.fetch=(_url,{signal})=>{calls++;transport=signal;return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError'))));};
  const one=new AbortController(),two=new AbortController();
  const a=api('card?id=abort',undefined,one.signal),b=api('card?id=abort',undefined,two.signal);
  one.abort();await assert.rejects(a,{name:'AbortError'});assert.equal(transport.aborted,false);
  two.abort();await assert.rejects(b,{name:'AbortError'});assert.equal(transport.aborted,true);
  await assert.rejects(api('card?id=never',undefined,one.signal),{name:'AbortError'});assert.equal(calls,1);
});

const library = (changes={}) => ({library_id:'folder-fixture',index_revision:'index-1',organization_revision:'org-1',manual_revision:'manual-1',
  documents:[{document_id:'one',filename:'Original.txt'}],folders:{},groups:[],total:1,has_more:false,processing:false,...changes});
test('visited folder snapshots are private exact-page hints and every visit still refreshes',async()=>{
  invalidateResponses('folder-snapshots');let calls=0;
  globalThis.fetch=async()=>reply(library({total:++calls}));
  const action='library?folder=Atlas&sort=filename&cursor=page-two';
  await api(action);
  assert.equal(peekCachedLibrary('library?cursor=page-two&sort=filename&folder=Atlas').total,1);
  const snapshot=peekCachedLibrary(action);snapshot.documents[0].filename='Changed';
  assert.equal(peekCachedLibrary(action).documents[0].filename,'Original.txt');
  for(const other of ['library?folder=Other&sort=filename&cursor=page-two','library?folder=Atlas&sort=created_at&cursor=page-two',
    'library?folder=Atlas&sort=filename','library?folder=Atlas&sort=filename&cursor=page-three'])
    assert.equal(peekCachedLibrary(other),undefined);
  const refresh=deferred();globalThis.fetch=()=>{calls++;return refresh.promise;};
  const pending=api(action);assert.equal(peekCachedLibrary(action).total,1);assert.equal(calls,2);
  refresh.resolve(reply(library({documents:[],total:0})));
  await pending;assert.deepEqual(peekCachedLibrary(action).documents,[]);
});
test('all library revision dimensions and mutations invalidate folder snapshots',async()=>{
  for(const field of ['library_id','index_revision','organization_revision','manual_revision']) {
    invalidateResponses('reset-'+field);
    globalThis.fetch=async()=>reply(library());await api('library?folder=Atlas');
    assert.ok(peekCachedLibrary('library?folder=Atlas'));
    globalThis.fetch=async()=>reply(library({[field]:'changed'}));await api('progress');
    assert.equal(peekCachedLibrary('library?folder=Atlas'),undefined,field);
  }
  globalThis.fetch=async()=>reply(library());await api('library?folder=Atlas');
  const mutation=deferred();globalThis.fetch=()=>mutation.promise;
  const removal=api('delete-document',{document_id:'one',expected_version:'v1'});
  assert.equal(peekCachedLibrary('library?folder=Atlas'),undefined);
  mutation.resolve(reply({deleted:'one'}));await removal;
});
test('folder snapshots evict old pages and bound retained bytes',async()=>{
  invalidateResponses('folder-lru');globalThis.fetch=async()=>reply(library());
  for(let i=0;i<16;i++)await api('library?folder='+i);
  assert.ok(peekCachedLibrary('library?folder=0'));
  await api('library?folder=16');
  assert.ok(peekCachedLibrary('library?folder=0'));assert.equal(peekCachedLibrary('library?folder=1'),undefined);
  invalidateResponses('folder-bytes');
  globalThis.fetch=async()=>reply(library({documents:[{document_id:'large',filename:'x'.repeat(800000)}]}));
  for(let i=0;i<6;i++)await api('library?folder=large-'+i);
  assert.equal(peekCachedLibrary('library?folder=large-0'),undefined);
  assert.ok(peekCachedLibrary('library?folder=large-5'));
  globalThis.fetch=async()=>reply(library({documents:[{filename:'x'.repeat(1100000)}]}));
  await api('library?folder=oversize');assert.equal(peekCachedLibrary('library?folder=oversize'),undefined);
});
test('canceled and out-of-order folder reads never revive a snapshot',async()=>{
  invalidateResponses('folder-canceled');
  const delayed=deferred();globalThis.fetch=()=>delayed.promise;
  const controller=new AbortController();
  const canceled=api('library?folder=canceled',undefined,controller.signal);
  controller.abort();await assert.rejects(canceled,{name:'AbortError'});
  delayed.resolve(reply(library()));await new Promise(resolve=>setImmediate(resolve));
  assert.equal(peekCachedLibrary('library?folder=canceled'),undefined);
  const old=deferred();let calls=0;
  globalThis.fetch=()=>++calls===1?old.promise:Promise.resolve(reply(library({index_revision:'new'})));
  const stale=api('library?folder=old');await api('progress');old.resolve(reply(library()));
  await assert.rejects(stale,{name:'AbortError'});
  assert.equal(peekCachedLibrary('library?folder=old'),undefined);
});
