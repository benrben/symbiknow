import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const react = new URL('../../node_modules/react/index.js', import.meta.url).href;
const source = (await readFile(new URL('../../src/shared/api/client.ts', import.meta.url),'utf8'))
  .replace('from "react"', `from ${JSON.stringify(react)}`);
const { outputText } = ts.transpileModule(source, {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}});
const {api,invalidateResponses}=await import('data:text/javascript;base64,'+Buffer.from(outputText).toString('base64'));
const reply = value => ({ok:true,json:async()=>value});
function deferred() {let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}

test('coalesced consumers cancel independently and successful response is reused',async()=>{
  invalidateResponses('coalescing');
  const pending=deferred();let calls=0;
  globalThis.fetch=(_url,options)=>{calls++;assert.equal(options.signal,undefined);return pending.promise;};
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
  globalThis.fetch=(_url,options)=>{calls++;assert.equal(options.method,'POST');assert.equal(options.signal,undefined);assert.equal(JSON.parse(options.body).query,'same');return pending.promise;};
  const cancel=new AbortController();
  const one=api('search',{query:'same',limit:8},cancel.signal);
  const two=api('search',{limit:8,query:'same'});
  cancel.abort();await assert.rejects(one,{name:'AbortError'});
  pending.resolve(reply({matches:[{document_id:'result'}]}));
  assert.equal((await two).matches[0].document_id,'result');assert.equal(calls,1);
});
