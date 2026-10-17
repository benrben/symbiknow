"""Observable actual judgment payload ownership with deterministic official SDK fixtures."""
import json
from pathlib import Path
import sys
sys.path[:0]=[str(Path(__file__).resolve().parents[2]),str(Path(__file__).resolve().parents[2]/'tests')]
from app import jev
from test_jev import match,sdk_client
jev._JUDGMENTS.clear();jev._DISAGREEMENTS.clear()
calls=[]
def call(state,questions,client=None):
 calls.append(1)
 with sdk_client() as sdk:return sdk.system_one(state=state,questions=questions)
jev._call=call
a=jev.judge_matches('Question',[match('one'),match('two')],cache_namespace='isolated-probe')
b=jev.judge_matches('Question',[match('one'),match('two')],cache_namespace='isolated-probe')
assert len(calls)==3 and b['cached']==2
report={'provider_calls_first_and_repeat':len(calls),'cached_repeat':b['cached'],'caches':{name:{'entries':len(cache),'owned_payload_bytes':cache.bytes,'max_entries':cache.max_entries,'max_payload_bytes':cache.max_bytes} for name,cache in [('judgments',jev._JUDGMENTS),('disagreements',jev._DISAGREEMENTS)]},'limitations':'Deterministic short SDK fixture payloads, not production payload distribution. Owned recursive Python payload size excludes bounded mapping/accounting overhead and native memory. These caches are not proven causes of multi-GB memory use.'}
(Path(__file__).parent/'cache-probe.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))
