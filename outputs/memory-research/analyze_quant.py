"""Compare quantized vectors and all sampled process measurements."""
import json
from pathlib import Path
import numpy as np

BASE=Path(__file__).resolve().parent/'quantization'
fixture=json.loads((BASE/'fixtures.json').read_text())
baseline=dict(np.load(BASE/'pt-fp32-vision-vectors.npz'))

def retrieval(queries,documents,expected):
    scores=queries@documents.T
    rankings=np.argsort(-scores,axis=1)
    positions=np.array([np.where(row==e)[0][0]+1 for row,e in zip(rankings,expected)])
    return {'top1_correct':int((positions==1).sum()),'top5_correct':int((positions<=5).sum()),'count':len(expected),'mrr':float((1/positions).mean()),'ranks':positions.tolist(),'top1':rankings[:,0].tolist(),'top5':rankings[:,:5].tolist()}

def agreement(a,b):
    a=a.astype('float64'); b=b.astype('float64')
    c=(a*b).sum(1)/(np.linalg.norm(a,axis=1)*np.linalg.norm(b,axis=1))
    return {'min_cosine':float(c.min()),'mean_cosine':float(c.mean()),'max_abs_difference':float(abs(a-b).max())}

base_retrieval=retrieval(baseline['queries'],baseline['documents'],fixture['expected'])
summary={'source_revision':fixture['source_revision'],'text_documents':24,'text_queries':48,'synthetic_images':12,
 'method':'Independent fresh processes; same pinned local checkpoint; audio disabled; shared preprocessed arrays; normalized 768-dimensional mean-pooled embeddings; MLX affine quantization group size 64 on text encoder, vision retained BF16. Query timings exclude preprocessing and include evaluation plus CPU output synchronization; 36 warm samples. Process physical footprint sampled every 20 ms including model loading. Memory excludes Docling, the live server, and database.',
 'limitations':['Synthetic small-corpus smoke benchmark, not broad retrieval accuracy.','No photographs, real scanned PDFs, long documents, concurrency, or long-running stress.','No production runtime/index modification.','8/4-bit weight labels do not describe BF16 vision weights or working tensors.'],
 'baseline_retrieval':base_retrieval,'runs':{}}
for path in sorted(BASE.glob('*-vectors.npz')):
    name=path.name.removesuffix('-vectors.npz')
    measurement=BASE/f'{name}.json'
    if not measurement.exists(): continue
    vectors=dict(np.load(path)); m=json.loads(measurement.read_text())
    result={'measurements':m['measurements'],'warm_query_median_ms':m['warm_query_median_ms'],'warm_query_p95_ms':m['warm_query_p95_ms'],'load_seconds':m['load_seconds']}
    result['text_drift_vs_fp32']=agreement(vectors['queries'],baseline['queries'])
    for label,docs in [('reembedded',vectors['documents']),('existing_fp32_index',baseline['documents'])]:
        r=retrieval(vectors['queries'],docs,fixture['expected'])
        r['top1_agreement_with_fp32']=sum(a==b for a,b in zip(r['top1'],base_retrieval['top1']))/len(fixture['expected'])
        r['mean_top5_overlap_with_fp32']=float(np.mean([len(set(a)&set(b))/5 for a,b in zip(r['top5'],base_retrieval['top5'])]))
        r['english_top1_correct']=sum(rank==1 for rank in r['ranks'][::2]); r['hebrew_top1_correct']=sum(rank==1 for rank in r['ranks'][1::2])
        result[label]=r
    if 'images' in vectors:
        result['image_drift_vs_fp32']=agreement(vectors['images'],baseline['images'])
        result['image_retrieval']=retrieval(vectors['image_queries'],vectors['images'],range(12))
        result['image_existing_fp32_index']=retrieval(vectors['image_queries'],baseline['images'],range(12))
    mlxbase=BASE/f'mlx-bf16-{m["modality"]}-vectors.npz'
    if mlxbase.exists():
        mb=dict(np.load(mlxbase)); result['text_drift_vs_mlx_bf16']=agreement(vectors['queries'],mb['queries'])
    summary['runs'][name]=result
    live=next(r for r in m['measurements'] if r['stage']=='cache_cleared_model_live')['physical_mib']
    peak=max(r['sampled_peak_physical_mib'] for r in m['measurements'])
    print(name, 'memory MiB',round(live),'peak',round(peak),'query ms',round(m['warm_query_median_ms'],1),'text top1',result['reembedded']['top1_correct'],'/48','existing',result['existing_fp32_index']['top1_correct'],'min cosine',round(result['text_drift_vs_fp32']['min_cosine'],5),'images',result.get('image_retrieval',{}).get('top1_correct'))
(BASE/'summary.json').write_text(json.dumps(summary,indent=2))
