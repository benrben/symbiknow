"""Generated bilingual questions over real repository guides, not independent labels.
Run using the pinned MLX sidecar PYTHONPATH and HF_HOME from runtime_quality.py.
All thresholds below were chosen before inspecting this run. Originals untouched.
"""
import gc
import hashlib
import json
from pathlib import Path
import sys
import time
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from app.embeddings import EmbeddingGemma2, MLXEmbeddingGemma2
from PIL import Image
ROOT = Path(__file__).resolve().parents[2]
OUT = Path(__file__).parent
# One actual source guide and two independently phrased language variants per topic.
CASES = '''ranged-download-integrity-procedure|How do I verify the version, offsets and checksum while downloading a file in ranges?|איך מאמתים גרסה, היסטים וחתימת קובץ בהורדה בחלקים?
request-identities-and-idempotent-version-commits|What prevents a retried upload request from creating an extra version?|מה מונע יצירת גרסה נוספת כשמנסים שוב אותה בקשת העלאה?
safe-document-updates-and-conflict-handling|How should an update detect that someone else already changed the current document?|איך עדכון מזהה שמישהו כבר שינה את הגרסה הנוכחית?
resumable-upload-state-machine|How can a partially uploaded file resume after the server restarts?|איך ממשיכים העלאה חלקית אחרי הפעלה מחדש של השרת?
bulk-zip-exact-versions-and-filename-collisions|Does ZIP export preserve the selected versions when two files have identical names?|האם ייצוא ZIP שומר על הגרסאות שנבחרו כששמות הקבצים זהים?
original-bytes-and-version-history|Where are original bytes and earlier versions kept?|איפה נשמרים הבתים המקוריים והגרסאות הקודמות?
de letion-boundaries-backup-and-restore|What must be backed up, and does deleting a document remove its old versions?|מה צריך לגבות והאם מחיקת מסמך מסירה גם גרסאות ישנות?
startup-reconciliation-and-recovery-runbook|How does startup recovery reconcile stored files with a missing or stale search index?|איך שחזור בעת ההפעלה מתאם קבצים שמורים עם אינדקס חיפוש חסר או מיושן?
atomic-metadata-transactions-failure-matrix|What happens if metadata publication is interrupted between its multiple steps?|מה קורה כשפרסום מטא נתונים נקטע בין שלבי העדכון?
rebuild-checkpoints-and-interruption-replay-trace|How does an interrupted organization rebuild resume its checkpointed work?|איך בנייה מחדש של ארגון המסמכים ממשיכה מנקודת ביקורת לאחר הפרעה?
full-selective-reset-and-recovery-contract|How do selective resets differ when clearing folders, links, or both?|מה ההבדל בין איפוס תיקיות, קישורים או שניהם?
manual-folder-corrections-and-durable-overrides|Do manual folder corrections survive automatic organization and restarts?|האם תיקוני תיקיות ידניים נשמרים אחרי ארגון אוטומטי והפעלה מחדש?
concurrency-and-safe-publication|How are searches protected from partially published document versions during ingestion?|איך מגינים על חיפושים מפני גרסאות שפורסמו חלקית בזמן קליטה?
current-head-checks-at-retrieval-boundaries|When must current versions be rechecked before returning search evidence?|מתי צריך לבדוק שוב את הגרסה הנוכחית לפני החזרת ראיות חיפוש?
evidence-ids-provenance-and-current-head-rules|How do passage identifiers record page provenance and endpoint versions?|איך מזהי קטעים מתעדים מקורות בעמודים וגרסאות מסמכים?
relationship-acceptance-and-stale-evidence-checklist|Which checks reject a relationship whose evidence has become stale?|אילו בדיקות דוחות קשר שהראיות שלו התיישנו?
relationships-deduplication-and-link-evidence|How are exact duplicates distinguished from evidence-backed related documents?|איך מבדילים בין כפילויות מדויקות למסמכים קשורים המבוססים על ראיות?
neighbor-discovery-budgets-and-link-coverage|Does the neighbor search guarantee discovery of every valid relationship?|האם חיפוש השכנים מבטיח גילוי של כל קשר תקף?
project-subject-taxonomy-and-candidate-cohesion|How are project identities separated from subject topics during organization?|איך מבדילים בין זהות פרויקט לנושא בתהליך ארגון מסמכים?
ocr-aliases-and-project-identity-policy|How should OCR spelling mistakes and aliases affect project identity decisions?|איך שגיאות כתיב של OCR וכינויים משפיעים על זיהוי פרויקט?
bounded-taxonomy-preparation-and-scale-limits|Which limits bound taxonomy preparation, and what scalability is still unproven?|אילו מגבלות תוחמות הכנת טקסונומיה ואיזו יכולת גדילה עדיין לא נבדקה?
text-pdf-image-and-ocr-ingestion|How are text, scanned PDF pages and native images ingested for retrieval?|איך קולטים טקסט, עמודי PDF סרוקים ותמונות לצורך חיפוש?
ingestion-lifecycle-and-processing-states|What do queued, processing, indexed, skipped and failed mean during ingestion?|מה המשמעות של ממתין, בעיבוד, מאונדקס, דולג ונכשל בזמן קליטה?
embedding-runtime-and-vector-compatibility|Which dimensions, prefixes and devices define embedding compatibility?|אילו ממדים, קידומות והתקנים קובעים תאימות של וקטורי הטמעה?
index-maintenance-vector-dimensions-and-migration|What must be rebuilt when changing the vector dimension?|מה צריך לבנות מחדש כשמשנים את ממד הווקטור?
lancedb-document-and-chunk-schema|What belongs in document rows versus searchable text or visual chunk rows?|מה נשמר ברשומות מסמכים לעומת רשומות קטעי טקסט או תמונה?
retrieval-modes-ranking-and-scopes|What is the difference between keyword, semantic and hybrid retrieval scopes?|מה ההבדל בין חיפוש מילות מפתח, חיפוש סמנטי וחיפוש משולב?
visual-similarity-versus-textual-answer-support|Can a visually similar picture be labeled as a direct textual answer?|האם תמונה דומה מבחינה חזותית יכולה לקבל תווית של תשובה טקסטואלית ישירה?
jev-answerability-labels-and-safeguards|How are direct, partial, related and uncertain answerability judgments distinguished?|איך מבדילים בין שיפוטי מענה ישיר, חלקי, קשור ולא ודאי?
quality-corpus-json-schema-and-offline-scoring|What provenance and labels are needed to evaluate saved Jev predictions offline?|אילו מקורות ותוויות נדרשים להערכת תחזיות Jev שמורות ללא חיבור לשירות?
capacity-and-independent-quality-evaluation-plan|What evidence is still required before claiming capacity for one hundred thousand documents?|אילו ראיות עדיין נדרשות לפני שטוענים לתמיכה במאה אלף מסמכים?
performance-measurement-exclusions-and-reproducibility|Which work is excluded from the published synthetic performance measurements?|איזו עבודה לא נכללת במדידות הביצועים הסינתטיות שפורסמו?
launch-modes-and-single-owner-checklist|Can the stdio and HTTP servers own the same data directory simultaneously?|האם שרת stdio ושרת HTTP יכולים להחזיק באותה תיקיית נתונים בו זמנית?
local-security-and-content-rendering-boundaries|How are hostile HTML originals and remote resources restricted in the reader?|איך מגבילים קובצי HTML זדוניים ומשאבים מרוחקים בתצוגת המסמך?
configuration-dependency-and-secret-boundaries|Where should API secrets be configured without entering the library or repository?|איפה מגדירים סודות API בלי להכניס אותם לספרייה או למאגר הקוד?
lazy-content-cards-cache-and-text-budgets|How are content card previews loaded and cached within text and image budgets?|איך תצוגות מקדימות של כרטיסים נטענות ונשמרות במטמון במסגרת מגבלות טקסט ותמונה?
canvas-overview-reading-and-saved-positions|How do canvas overview zoom levels and saved manual positions work?|איך עובדים רמות הזום במפה ומיקומים ידניים שמורים?
keyboard-shortcuts-focus-and-accessibility|Which keyboard shortcuts open quick look and avoid hijacking focused controls?|אילו קיצורי מקלדת פותחים מבט מהיר בלי להפריע לפקדים שבמיקוד?
shared-search-state-and-presentation-invalidation|Does switching between List, Cards and Canvas rerun a submitted search?|האם מעבר בין רשימה, כרטיסים ומפה מריץ שוב את החיפוש שנשלח?
preview-history-gfm-and-pdf-behavior|How can I preview an old version, a Markdown table or a specific PDF page?|איך מציגים גרסה ישנה, טבלת Markdown או עמוד PDF מסוים?'''.replace('de letion','deletion')
cases=[]
for row in CASES.splitlines():
    slug, en, he = row.split('|')
    assert (ROOT/'docs/knowledge-library'/f'{slug}.md').exists(), slug
    cases.extend([{'source':slug+'.md','language':lang,'question':q} for lang,q in [('en',en),('he',he)]])
passages=[]
for source in sorted((ROOT/'docs/knowledge-library').glob('*.md')):
    body=source.read_text();title=body.splitlines()[0].lstrip('# ')
    for start in range(0,len(body),1000):
        passages.append({'source':source.name,'start':start,'text':f'title: {title} | text: {body[start:start+1200]}'})
fixture={'provenance':{'annotator':'Codex generated; user requested generation','split':'generated_regression','independent':False,'source':'actual repository guides, October 12 snapshot; not authoritative current behavior'},'cases':cases,'passages':passages}
fixture_bytes=json.dumps(fixture,ensure_ascii=False,indent=2).encode()
(OUT/'generated-quality-corpus.json').write_bytes(fixture_bytes)
thresholds={'minimum_query_cosine':.995,'allowed_top1_regressions':1,'allowed_top3_regressions':0,'required_photo_top1':10,'minimum_text_top3_fraction':.90}
report={'provenance':fixture['provenance'],'thresholds_chosen_before_run':thresholds,'fixture_sha256':hashlib.sha256(fixture_bytes).hexdigest(),'passage_count':len(passages),'question_count':len(cases),'results':{}}
outputs={}
photo_names=['astronaut','chelsea','coffee','camera','rocket']
photo_questions=['astronaut in a space suit','חתול עם פרווה חומה','cup of coffee on a saucer','צלם מחזיק מצלמה','rocket launch at night','אסטרונאוט בחליפת חלל','brown tabby cat','כוס קפה על צלחת','man taking a photograph with a camera','שיגור טיל בלילה']
for name, cls in [('torch', EmbeddingGemma2),('mlx',MLXEmbeddingGemma2)]:
    start=time.perf_counter();runtime=cls(vision=False)
    def encode(texts):return np.concatenate([runtime.encode(texts[i:i+4]) for i in range(0,len(texts),4)])
    docs=encode([p['text'] for p in passages]);queries=encode(['task: search result | query: '+c['question'] for c in cases])
    runtime.clear();del runtime.model;runtime.clear();del runtime;gc.collect()
    runtime=cls(vision=True)
    photos=[]
    for photo in photo_names:
        with Image.open(OUT/'real-photos'/f'{photo}.png') as im:photos.append(runtime.encode([im.convert('RGB')],images=True))
    photo_vectors=np.concatenate(photos);photo_queries=encode(['task: search result | query: '+q for q in photo_questions])
    outputs[name]={'docs':docs,'queries':queries,'photo_vectors':photo_vectors,'photo_queries':photo_queries}
    report['results'][name]={'seconds':time.perf_counter()-start,'photo_top1':int(np.sum((photo_queries@photo_vectors.T).argmax(1)==np.arange(10)%5))}
    runtime.clear();del runtime.model;runtime.clear();del runtime;gc.collect()
    np.savez(OUT/f'generated-quality-{name}.npz',**outputs[name]);print(name,report['results'][name],flush=True)
def score(q,d):
    ranks=np.argsort(-(q@d.T),axis=1);details=[]
    for c,rank in zip(cases,ranks):
        unique=list(dict.fromkeys(passages[int(i)]['source'] for i in rank))
        details.append({'language':c['language'],'source':c['source'],'rank':unique.index(c['source'])+1,'first':unique[0]})
    return {'top1':sum(c['rank']==1 for c in details),'top3':sum(c['rank']<=3 for c in details),'details':details}
for name in outputs:report['results'][name].update(score(outputs[name]['queries'],outputs[name]['docs']))
report['results']['mlx_query_float32']=score(outputs['mlx']['queries'],outputs['torch']['docs'])
report['minimum_query_cosine']=float(np.sum(outputs['mlx']['queries']*outputs['torch']['queries'],axis=1).min())
report['minimum_document_cosine']=float(np.sum(outputs['mlx']['docs']*outputs['torch']['docs'],axis=1).min())
a=report['results']['torch'];b=report['results']['mlx'];c=report['results']['mlx_query_float32']
report['passed_generated_regression']=(report['minimum_query_cosine']>=.995 and min(b['top1'],c['top1'])>=a['top1']-1 and min(b['top3'],c['top3'])>=a['top3'] and b['top3']/len(cases)>=.90 and b['photo_top1']==10)
report['limitations']=['Generated questions are not an independent user-labeled held-out production evaluation.','Document ranking after aggregating 1200-character passages, not end-to-end production hybrid search.','Photo test uses five public sample photographs, not a representative photo library.','This run never reads or modifies the live index.']
(OUT/'generated-quality.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
print(json.dumps({k:v for k,v in report.items() if k!='results'},ensure_ascii=False,indent=2))
print({k:{n:v for n,v in r.items() if n!='details'} for k,r in report['results'].items()})
