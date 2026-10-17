"""Compare direct torch adapter to saved original SentenceTransformer vectors."""
import json
import os
from pathlib import Path
import sys
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[2]))
os.environ.setdefault('HF_HOME',str(Path(__file__).resolve().parents[2]/'data/models'));os.environ['HF_HUB_OFFLINE']='1'
from app.embeddings import EmbeddingGemma2
from PIL import Image
P=Path(__file__).parent
texts=['task: search result | query: temperature at which water freezes','title: Facts | text: Water freezes at zero degrees Celsius.','title: Cats | text: A domestic feline sleeps indoors.','task: search result | query: חתול ישן בבית']
report={}
for vision in [False,True]:
 runtime=EmbeddingGemma2(vision=vision);vectors=runtime.encode(texts)
 original=np.load(P/('full-fp32-text.npy' if vision else 'text-fp32-text.npy'))
 report['vision' if vision else 'text_only']={'min_cosine':float((vectors*original).sum(1).min()),'max_absolute_difference':float(abs(vectors-original).max())}
 if vision:
    images=[]
    for color in ['red','blue']:
        with Image.new('RGB',(512,512),color) as im:images.append(runtime.encode([im],images=True))
    images=np.concatenate(images);old=np.load(P/'full-fp32-image.npy')
    report['images']={'min_cosine':float((images*old).sum(1).min()),'max_absolute_difference':float(abs(images-old).max())}
 runtime.clear();del runtime.model;runtime.clear();del runtime
assert min(v['min_cosine'] for v in report.values())>.9999,report
report['limitations']='Four original English/Hebrew prefixed strings and two generated images; validates adapter mechanics against saved SentenceTransformer outputs, not production quality.'
(P/'torch-fallback-compatibility.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))
