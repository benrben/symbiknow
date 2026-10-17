"""Pinned-checkpoint 4/8-bit experiments, isolated from production data.

Commands: prepare; convert {4,8}; run {pt-fp32,pt-bf16,mlx-bf16,mlx-8,mlx-4} {text,vision}.
Shared preprocessed inputs keep tokenizer/image processing identical across runtimes.
"""
import ctypes
import gc
import hashlib
import json
import os
from pathlib import Path
import sys
import threading
import time
import traceback

ROOT = Path(__file__).resolve().parents[2]
BASE = Path(__file__).resolve().parent / 'quantization'
SOURCE = ROOT / 'data/models/hub/models--google--embeddinggemma-2/snapshots/2c791de4ddbe5cabd592cc93692f7acb67e52555'
BASE.mkdir(exist_ok=True)
os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'
os.environ['HF_HUB_DISABLE_PROGRESS_BARS'] = '1'
os.environ['TOKENIZERS_PARALLELISM'] = 'false'
if sys.argv[1] == 'convert' or (sys.argv[1] == 'run' and sys.argv[2].startswith('mlx')):
    os.environ['USE_TORCH'] = '0'
    sys.path.insert(0, str(BASE.parent / 'mlx-runtime'))
import numpy as np


def prepare():
    from transformers import AutoProcessor
    from PIL import Image, ImageDraw
    pairs = [
        ('The Atlas production database is PostgreSQL. Redis is used only for caching.', 'Which database stores production records for Atlas?', 'איזה מסד נתונים שומר את נתוני הייצור של אטלס?'),
        ('The Beacon production database is MySQL. PostgreSQL is used only in a prototype.', 'What is the production database for Beacon?', 'מהו מסד הנתונים של ביקון בסביבת הייצור?'),
        ('Atlas database backups run every night at 02:00 UTC and are kept for thirty days.', 'When are Atlas backups made and how long are they retained?', 'מתי מתבצעים גיבויי אטלס וכמה זמן שומרים אותם?'),
        ('Beacon backups run each Sunday and are retained for ninety days.', 'How often does Beacon back up its data?', 'באיזו תדירות ביקון מגבה את הנתונים?'),
        ('The Atlas launch was moved from June 10 to July 15 because security review is incomplete.', 'What is the revised Atlas launch date?', 'מהו תאריך ההשקה המעודכן של אטלס?'),
        ('The Beacon launch remains June 10. Its security review has been completed.', 'Which launch is still scheduled for June 10?', 'איזו השקה עדיין מתוכננת לעשרה ביוני?'),
        ('Employees may work remotely three days per week. Managers approve the chosen days.', 'How many remote work days can employees take?', 'כמה ימים בשבוע אפשר לעבוד מהבית?'),
        ('Contractors must work from the office five days per week; the employee remote policy does not apply.', 'Does the employee work-from-home policy cover contractors?', 'האם מדיניות העבודה מהבית חלה על קבלנים?'),
        ('The server has high memory usage because embedding model weights and OCR models remain loaded.', 'Why does the server keep using RAM after an upload?', 'למה השרת ממשיך לצרוך זיכרון אחרי העלאת קובץ?'),
        ('The server has high disk usage because every original document version is retained in OCFL.', 'Why does storing new document versions increase disk space?', 'למה גרסאות חדשות של מסמכים מגדילות את נפח הדיסק?'),
        ('Refunds are available within fourteen days of delivery if the product has not been used.', 'What is the refund deadline for an unused delivered product?', 'עד מתי ניתן לקבל החזר על מוצר שלא נעשה בו שימוש?'),
        ('Warranty repairs are available for one year after purchase and do not extend the refund deadline.', 'How long is the repair warranty?', 'כמה זמן תקפה האחריות לתיקונים?'),
        ('המשרד בתל אביב פתוח בימים ראשון עד חמישי, משעה תשע עד שש בערב.', 'What are the opening hours of the Tel Aviv office?', 'באילו שעות פתוח המשרד בתל אביב?'),
        ('המשרד בירושלים פתוח בימים ראשון עד חמישי, משעה שמונה עד ארבע אחר הצהריים.', 'When does the Jerusalem office close?', 'מתי נסגר המשרד בירושלים?'),
        ('נועה אחראית על בדיקות אבטחה בפרויקט אטלס. דניאל אחראי על עיצוב הממשק.', 'Who owns security testing on Atlas?', 'מי אחראית על בדיקות האבטחה באטלס?'),
        ('דניאל אחראי על עיצוב הממשק בפרויקט אטלס. הוא אינו אחראי לבדיקות אבטחה.', 'Who designs the Atlas user interface?', 'מי אחראי על עיצוב הממשק באטלס?'),
        ('API clients must retry HTTP 429 using exponential backoff and honor the Retry-After header.', 'How should clients handle API rate limits?', 'איך לקוח צריך לטפל בהגבלת קצב של ה-API?'),
        ('API clients must not retry HTTP 401 with the same credentials; refresh authentication first.', 'Should an API client repeat an unauthorized request unchanged?', 'האם צריך לשלוח שוב בקשה לא מורשית עם אותם פרטי הזדהות?'),
        ('Uploaded originals are saved before indexing. An indexing failure does not delete the original.', 'Is an uploaded original lost if indexing fails?', 'האם הקובץ המקורי אובד כאשר האינדוקס נכשל?'),
        ('Deleting a document permanently removes all its versions. Removing a folder only changes organization.', 'What happens to history when a document is deleted?', 'מה קורה להיסטוריית הגרסאות כאשר מוחקים מסמך?'),
        ('Lithium batteries must be stored in a cool dry place away from direct sunlight.', 'Where should spare lithium batteries be stored?', 'איפה יש לאחסן סוללות ליתיום חלופיות?'),
        ('Houseplants should receive indirect sunlight and be watered when the topsoil becomes dry.', 'When should indoor plants be watered?', 'מתי צריך להשקות צמחים בתוך הבית?'),
        ('A cached search result expires after five minutes. Changed document versions invalidate it earlier.', 'How long can a search continuation remain valid?', 'לכמה זמן תקף המשך של תוצאות חיפוש?'),
        ('An upload retry must reuse its request UUID and identical bytes to avoid creating a new document.', 'How can a client safely retry an upload?', 'כיצד אפשר לנסות שוב העלאת קובץ בלי ליצור מסמך נוסף?'),
    ]
    docs = [f'title: none | text: {p[0]}' for p in pairs]
    queries = [f'task: search result | query: {q}' for p in pairs for q in p[1:]]
    expected = [i for i in range(len(pairs)) for _ in range(2)]
    processor = AutoProcessor.from_pretrained(str(SOURCE), local_files_only=True)
    jobs = []
    def save_job(kind, texts=None, image=None, indices=None):
        features = processor(text=texts, padding=True, truncation=True, max_length=512, return_tensors='np') if image is None else processor(images=[image], return_tensors='np')
        filename = f'input-{len(jobs):03d}.npz'
        np.savez(BASE / filename, **{k:np.asarray(v) for k,v in features.items()})
        jobs.append({'kind':kind,'file':filename,'indices':indices})
    for start in range(0,len(docs),4): save_job('documents', docs[start:start+4], indices=list(range(start,start+4)))
    for i,q in enumerate(queries): save_job('queries',[q],indices=[i])
    image_queries=[]
    for color in ['red','blue','green','yellow']:
        for shape in ['circle','square','triangle']:
            im=Image.new('RGB',(512,512),'white'); draw=ImageDraw.Draw(im)
            if shape=='circle': draw.ellipse((96,96,416,416),fill=color)
            elif shape=='square': draw.rectangle((96,96,416,416),fill=color)
            else: draw.polygon([(256,80),(80,432),(432,432)],fill=color)
            i=len(image_queries); im.save(BASE/f'image-{i:02d}.png')
            save_job('images',image=im,indices=[i])
            image_queries.append(f'task: search result | query: A {color} {shape} on a white background')
    for i,q in enumerate(image_queries): save_job('image_queries',[q],indices=[i])
    data={'documents':docs,'queries':queries,'expected':expected,'image_queries':image_queries,'jobs':jobs,'source_revision':SOURCE.name,'synthetic':True}
    (BASE/'fixtures.json').write_text(json.dumps(data,ensure_ascii=False,indent=2))
    print('Prepared',len(docs),'documents,',len(queries),'queries and',len(image_queries),'images',flush=True)


def convert(bits):
    import mlx.core as mx
    import mlx.nn as nn
    from mlx.utils import tree_flatten
    from mlx_vlm.embedding_loader import load_embedding_model
    from mlx_vlm.utils import get_class_predicate
    config=json.loads((SOURCE/'config.json').read_text()); config['audio_config']=None
    model=load_embedding_model(SOURCE,config=config)
    nn.quantize(model,group_size=64,bits=bits,mode='affine',class_predicate=get_class_predicate(skip_vision=True))
    mx.eval(model.parameters())
    destination=BASE/f'model-{bits}bit'; destination.mkdir(exist_ok=True)
    weights=dict(tree_flatten(model.parameters()))
    mx.save_safetensors(str(destination/'model.safetensors'),weights)
    config['quantization']={'group_size':64,'bits':bits,'mode':'affine'}
    (destination/'config.json').write_text(json.dumps(config,indent=2))
    record={'source_revision':SOURCE.name,'bits':bits,'group_size':64,'audio':False,'vision_precision':'bfloat16','quantized_modules':[k.removesuffix('.scales') for k in weights if k.endswith('.scales')],'weight_bytes':(destination/'model.safetensors').stat().st_size}
    (destination/'conversion.json').write_text(json.dumps(record,indent=2))
    print(json.dumps({k:v for k,v in record.items() if k!='quantized_modules'}),flush=True)


def run(mode,modality):
    libproc=ctypes.CDLL('/usr/lib/libproc.dylib')
    def footprint():
        data=ctypes.create_string_buffer(1024)
        if libproc.proc_pid_rusage(os.getpid(),0,ctypes.byref(data)) != 0: raise RuntimeError('footprint read failed')
        return ctypes.c_uint64.from_buffer(data,72).value/2**20
    report={'mode':mode,'modality':modality,'source_revision':SOURCE.name,'measurements':[]}
    peak=[footprint()]; done=threading.Event()
    def monitor():
        while not done.wait(.02): peak[0]=max(peak[0],footprint())
    monitor_thread=threading.Thread(target=monitor,daemon=True); monitor_thread.start()
    mlx=mode.startswith('mlx')
    if mlx:
        import mlx.core as mx
        from mlx_vlm.embedding_loader import load_embedding_model
        if os.getenv('QUANT_CACHE_LIMIT_MIB'):
            limit=int(os.environ['QUANT_CACHE_LIMIT_MIB'])
            mx.set_cache_limit(limit*2**20)
            report['cache_limit_mib']=limit
    else:
        import torch
        from transformers import AutoModel
    def snapshot(stage):
        if mlx: mx.synchronize()
        else: torch.mps.synchronize()
        d={'stage':stage,'physical_mib':footprint(),'sampled_peak_physical_mib':peak[0]}
        if mlx: d.update(active_mib=mx.get_active_memory()/2**20,cache_mib=mx.get_cache_memory()/2**20,peak_allocator_mib=mx.get_peak_memory()/2**20)
        else: d.update(active_mib=torch.mps.current_allocated_memory()/2**20,driver_mib=torch.mps.driver_allocated_memory()/2**20)
        report['measurements'].append(d); print(json.dumps(d),flush=True)
    snapshot('imports')
    config=json.loads((SOURCE/'config.json').read_text()); config['audio_config']=None
    if modality=='text': config['vision_config']=None
    start=time.perf_counter()
    if mlx:
        path=SOURCE if mode=='mlx-bf16' else BASE/f'model-{mode.split("-")[1]}bit'
        if path!=SOURCE:
            config=json.loads((path/'config.json').read_text())
            if modality=='text': config['vision_config']=None
        model=load_embedding_model(path,config=config)
        def encode(data):
            inputs={k:mx.array(v) for k,v in data.items()}
            if 'pixel_values' in inputs: inputs['pixel_values']=inputs['pixel_values'].astype(mx.bfloat16)
            output=model(**inputs).text_embeds.astype(mx.float32)
            mx.eval(output); return np.array(output)
    else:
        from transformers import AutoConfig
        hfconfig=AutoConfig.from_pretrained(str(SOURCE),local_files_only=True)
        hfconfig.audio_config=None
        if modality=='text': hfconfig.vision_config=None
        dtype=torch.float32 if mode=='pt-fp32' else torch.bfloat16
        model=AutoModel.from_pretrained(str(SOURCE),config=hfconfig,torch_dtype=dtype,local_files_only=True).to('mps').eval()
        @torch.inference_mode()
        def encode(data):
            inputs={k:torch.from_numpy(v).to('mps') for k,v in data.items()}
            if 'pixel_values' in inputs: inputs['pixel_values']=inputs['pixel_values'].to(dtype)
            hidden=model(**inputs).last_hidden_state.float()
            mask=inputs['attention_mask'].unsqueeze(-1)
            pooled=(hidden*mask).sum(1)/mask.sum(1).clamp(min=1)
            return torch.nn.functional.normalize(pooled,dim=-1).cpu().numpy()
    report['load_seconds']=time.perf_counter()-start
    snapshot('loaded')
    fixtures=json.loads((BASE/'fixtures.json').read_text())
    outputs={k:[] for k in ['documents','queries','images','image_queries']}
    query_inputs=[]; durations=[]
    for job in fixtures['jobs']:
        if modality=='text' and job['kind'] in ['images','image_queries']: continue
        with np.load(BASE/job['file']) as f: data=dict(f)
        t=time.perf_counter(); vector=encode(data); elapsed=time.perf_counter()-t
        if not np.isfinite(vector).all() or vector.shape[1]!=768: raise ValueError('Invalid embedding')
        outputs[job['kind']].append(vector)
        if job['kind']=='queries': query_inputs.append(data)
        durations.append({'kind':job['kind'],'seconds':elapsed})
    snapshot('workload_complete')
    warm=[]
    for repeat in range(3):
        for data in query_inputs[:12]:
            t=time.perf_counter(); encode(data); warm.append(time.perf_counter()-t)
    report['warm_query_seconds']=warm
    report['warm_query_median_ms']=float(np.median(warm)*1000)
    report['warm_query_p95_ms']=float(np.percentile(warm,95)*1000)
    report['initial_timings']=durations
    snapshot('warm_queries')
    if mlx: mx.clear_cache()
    else: torch.mps.empty_cache()
    time.sleep(1)
    snapshot('cache_cleared_model_live')
    arrays={k:np.concatenate(v) for k,v in outputs.items() if v}
    suffix=f'-cache{report["cache_limit_mib"]}' if 'cache_limit_mib' in report else ''
    np.savez(BASE/f'{mode}-{modality}{suffix}-vectors.npz',**arrays)
    del encode,model
    gc.collect()
    if mlx: mx.clear_cache()
    else: torch.mps.empty_cache()
    time.sleep(2)
    snapshot('unloaded')
    done.set(); monitor_thread.join()
    (BASE/f'{mode}-{modality}{suffix}.json').write_text(json.dumps(report,indent=2))
    print('Finished',mode,modality,flush=True)


if __name__=='__main__':
    if sys.argv[1]=='prepare': prepare()
    elif sys.argv[1]=='convert': convert(int(sys.argv[2]))
    else: run(sys.argv[2],sys.argv[3])
