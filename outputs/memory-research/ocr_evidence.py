"""Real Docling child conversion: scanned two-page table/heading evidence and page numbers.
Generated fixture checks mechanics, not representative OCR/model quality.
"""
import json
import os
from pathlib import Path
import sys
import tempfile
sys.path[:0]=[str(Path(__file__).resolve().parents[2]),str(Path(__file__).resolve().parents[2]/'tests')]
from PIL import Image,ImageDraw,ImageFont
from test_search import FixtureEmbedder
from app.ingest import extract_units
font=ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial.ttf',32)
with tempfile.TemporaryDirectory(prefix='symbiknow-ocr-evidence-') as temporary:
    pages=[]
    for index in range(2):
        page=Image.new('RGB',(1000,1400),'white');draw=ImageDraw.Draw(page)
        draw.text((60,70),f'ATLAS RELEASE SCHEDULE - PAGE {index+1}',font=font,fill='black')
        rows=[['Team','Milestone','Date'],['Security','Review','July 15'],['Design','Interface','June 10']]
        for r,row in enumerate(rows):
            for c,cell in enumerate(row):
                x,y=60+c*290,200+r*100
                draw.rectangle((x,y,x+290,y+100),outline='black',width=2)
                draw.text((x+15,y+25),cell,font=font,fill='black')
        draw.text((60,600),'Original file versions are preserved.',font=font,fill='black')
        pages.append(page)
    path=Path(temporary)/'scanned-table.pdf'
    pages[0].save(path,'PDF',save_all=True,append_images=pages[1:])
    units,visual,warnings=extract_units({'filename':path.name,'mime_type':'application/pdf'},path,FixtureEmbedder(),isolated=True)
    text='\n'.join(u['text'] for u in units)
    found={word:word.casefold() in text.casefold() for word in ['ATLAS','Team','Security','Review','July','Original']}
    page_numbers=sorted({p['page_no'] for u in units for p in u['provenance']['pages']})
    report={'found':found,'evidence_pages':page_numbers,'visual_pages':len(visual),'warnings':warnings,'units':units}
    assert all(found.values()),found
    assert page_numbers==[1,2] and len(visual)==2
    (Path(__file__).parent/'ocr-evidence.json').write_text(json.dumps(report,indent=2))
    print(json.dumps({k:v for k,v in report.items() if k!='units'},indent=2))
