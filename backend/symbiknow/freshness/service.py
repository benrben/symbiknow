"""Explicit manual freshness scans. UI, MCP and the worker share this service."""
from datetime import datetime, timezone
from contextlib import nullcontext
from concurrent.futures import ThreadPoolExecutor
from contextvars import copy_context
import hashlib
import json
import re
import threading
import time
import uuid

from symbiknow.ai.sensitive import contains_likely_secret
from symbiknow.freshness import judgments
from symbiknow.freshness.store import FreshnessStore, encode
from symbiknow.search.metrics import CURRENT, add, stage

ACTIVE = {"queued", "reading", "matching", "comparing"}
CACHE_ENTRIES = 100000
COMPARE_WORKERS = 2  # At most half of Jev's four shared provider slots.
LABELS = {
    "possibly_outdated": "Possibly outdated",
    "possibly_replaced": "Possibly replaced",
    "possibly_deprecated": "Possibly deprecated",
    "conflicting": "Conflicting",
}
REASONS = {
    "possibly_outdated": "These claims disagree. The scan used the selected reference document to suggest which passage needs attention.",
    "possibly_replaced": "One passage explicitly describes replacing the other document or section. Review the source and applicability.",
    "possibly_deprecated": "One passage describes retiring a feature or procedure recommended by the other. Review the effective date and setting.",
    "conflicting": "These claims appear incompatible in the same setting. The evidence does not establish which is correct.",
}


def digest(value):
    return hashlib.sha256(encode(value).encode()).hexdigest()


def now():
    return datetime.now(timezone.utc).isoformat()


def tokens(text):
    return set(re.findall(r"[\w/-]{3,}", text.casefold()))


def segments(row, document, position):
    """Exact source spans; no model-generated quotes or truncation."""
    text = row["text"]
    # Prefer paragraph boundaries, then split exceptionally long paragraphs.
    for match in re.finditer(r"\S[\s\S]*?(?=\n[ \t]*\n|\Z)", text):
        for start in range(match.start(), match.end(), 1600):
            end = min(start + 1600, match.end())
            yield {
                "id": digest([document["document_id"], document["version"], row["evidence_id"], start, end]),
                "document_id": document["document_id"], "version": document["version"],
                "filename": document["filename"], "evidence_revision": document["evidence_revision"],
                "evidence_id": row["evidence_id"], "text": text[start:end],
                "start": start, "end": end, "sha256": hashlib.sha256(text.encode()).hexdigest(),
                "position": position, "provenance": row["provenance"],
            }
            position += 1


class FreshnessService:
    def __init__(self, context):
        self.context = context
        self.store = FreshnessStore(context.DATA_DIR)
        self.lock = threading.RLock()
        self.processing = threading.Lock()

    def start(self, document_ids=None, reference_document_ids=None, request_id=None):
        from symbiknow.library.storage import source_revision
        from symbiknow.search.index import revisions, capture_metadata

        for ids in (document_ids, reference_document_ids):
            if ids is not None and (not isinstance(ids, list) or not all(isinstance(i, str) for i in ids)):
                raise ValueError("Document IDs must be a list of strings")
            if ids is not None and len(ids) > 100:
                raise ValueError("Select at most 100 documents, or omit the scope for a whole-library job")
        if document_ids == []:
            raise ValueError("Choose documents or omit the scope to scan the whole library")
        if request_id is not None and (not isinstance(request_id, str) or not 1 <= len(request_id) <= 128):
            raise ValueError("Use a request ID of 1–128 characters")
        refs = sorted(set(reference_document_ids or []))
        scope = sorted(set(document_ids)) if document_ids else None
        identity = digest({"scope": scope, "references": refs})
        with self.lock, self.context.snapshots.read(), self.store.connection(create=True) as db:
            if request_id:
                old = db.execute("SELECT payload FROM jobs WHERE request_key=?", (request_id,)).fetchone()
                if old:
                    job = json.loads(old[0])
                    if job["scope_identity"] != identity:
                        raise ValueError("This request ID was already used with different scan options")
                    return self._public_job(job)
            if db.execute("SELECT 1 FROM jobs WHERE active=1").fetchone():
                raise ValueError("A freshness scan is already running; open or cancel it first")
            selected = set(scope or []) | set(refs)
            known = self.context.originals.metadata_many(selected)
            if any(not known.get(identity) for identity in selected):
                raise ValueError("A selected document or reference no longer exists")
            capture = capture_metadata(self.context.DATA_DIR)
            # Scoped rechecks still retrieve peers from the entire captured library.
            scan = str(uuid.uuid4())
            job = {
                "scan_id": scan, "status": "queued", "revision": 1,
                "created_at": now(), "checked_at": now(), "scope_identity": identity,
                "document_ids": scope, "reference_document_ids": refs,
                "source_revision": source_revision(self.context.DATA_DIR),
                "index_revision": revisions(self.context.DATA_DIR)["index"],
                "model": judgments.model_identity(), "policy": judgments.POLICY_VERSION,
                "documents_total": capture["count"], "documents_read": 0,
                "capture": capture, "capture_after": "", "capture_complete": False,
                "original_capture_complete": False,
                "passages_read": 0, "passages_classified": 0, "passages_matched": 0,
                "pairs_total": 0, "pairs_checked": 0, "findings_total": 0,
                "gaps": {}, "usage": {}, "current_filename": "",
            }
            db.execute("INSERT INTO jobs VALUES(?,?,?,?,?)",
                       (scan, request_id, 1, encode(job), time.time_ns()))
        self.context.wake.set()
        return self._public_job(job)

    @staticmethod
    def _public_job(job):
        return {key: value for key, value in job.items()
                if key not in {"source_revision", "index_revision", "scope_identity", "matching_document_id", "capture", "capture_after", "capture_complete", "original_capture_complete"}}

    @staticmethod
    def _gap(job, name, count=1):
        job["gaps"][name] = job["gaps"].get(name, 0) + count

    def _valid_documents(self, documents, snapshot=None, states=None):
        with (nullcontext(snapshot) if snapshot else self.context.snapshots.read()) as snapshot:
            ids = [d["document_id"] for d in documents]
            heads = snapshot.heads_many(ids)
            states = self.context.evidence.document_statuses(ids) if states is None else states
            for d in documents:
                if heads.get(d["document_id"]) is None:
                    return "source_removed"
                state = states.get(d["document_id"]) or {}
                if (heads[d["document_id"]] != d["version"]
                        or state.get("status") != "indexed"
                        or state.get("indexed_version") != d["version"]
                        or state.get("evidence_revision", "") != d["evidence_revision"]):
                    return "needs_recheck"
        return "valid"

    def _valid_finding(self, finding, documents, snapshot=None, states=None, resolved=None):
        # Context, not just the two focus passages, is a dependency.
        with (nullcontext(snapshot) if snapshot else self.context.snapshots.read()) as snapshot:
            status = self._valid_documents(documents, snapshot, states)
            if status != "valid":
                return status
            refs = [(p["document_id"], p["version"], p["evidence_id"]) for p in finding["evidence"]]
            rows = self.context.evidence.resolve_evidence_many(refs) if resolved is None else resolved
            for p, key in zip(finding["evidence"], refs):
                row = rows.get(key)
                if (not row or hashlib.sha256(row["text"].encode()).hexdigest() != p["sha256"]
                        or row["text"][p["start"]:p["end"]] != p["text"]):
                    return "needs_recheck"
        # Effective dates can change applicability even without a source edit.
        if finding["checked_at"][:10] != now()[:10]:
            return "needs_recheck"
        return "valid"

    def get(self, scan_id=None, after="", limit=30, category=None, document_id=None):
        from symbiknow.library.storage import source_revision
        from symbiknow.search.index import revisions
        if not isinstance(limit, int) or not 1 <= limit <= 100:
            raise ValueError("Use a page limit between 1 and 100")
        if category and category not in LABELS:
            raise ValueError("Unknown freshness label")
        with self.lock, self.context.snapshots.read() as snapshot, self.store.connection() as db:
            job = self.store.job(db, scan_id)
            if not job:
                return {"scan": None, "findings": [], "has_more": False, "next_after": "", "recent_scans": []}
            clauses, args = ["scan=?", "id>?"], [job["scan_id"], after]
            if category:
                clauses.append("category=?")
                args.append(category)
            if document_id:
                clauses.append("(document_a=? OR document_b=?)")
                args.extend([document_id, document_id])
            rows = db.execute("SELECT * FROM findings WHERE " + " AND ".join(clauses) +
                              " ORDER BY id LIMIT ?", (*args, limit + 1)).fetchall()
            findings, docs_by_id, source_refs = [], {}, []
            for row in rows[:limit]:
                f = json.loads(row["payload"])
                for i in {e["document_id"] for e in f["evidence"]}:
                    if i not in docs_by_id:
                        docs_by_id[i] = json.loads(db.execute("SELECT payload FROM documents WHERE scan=? AND id=?",
                                                             (job["scan_id"], i)).fetchone()[0])
                source_refs.extend((e["document_id"], e["version"], e["evidence_id"]) for e in f["evidence"])
                f.update(review=row["review"], revision=row["revision"])
                findings.append(f)
            heads = snapshot.heads_many(docs_by_id)
            states = self.context.evidence.document_statuses(docs_by_id)
            resolved = self.context.evidence.resolve_evidence_many(source_refs)
            for f in findings:
                docs = [docs_by_id[i] for i in {e["document_id"] for e in f["evidence"]}]
                f["validity"] = self._valid_finding(f, docs, snapshot, states, resolved)
                if f["validity"] == "source_removed":
                    # A deletion may have completed after this page was read.
                    for e in f["evidence"]:
                        if heads.get(e["document_id"]) is None:
                            e.update(text="", filename="(removed file)", provenance={})
            public = self._public_job(job)
            public["coverage_changed"] = (
                job["source_revision"] != source_revision(self.context.DATA_DIR)
                or job["index_revision"] != revisions(self.context.DATA_DIR)["index"]
                or job["checked_at"][:10] != now()[:10])
            return {"scan": public, "findings": findings, "has_more": len(rows) > limit,
                    "next_after": rows[limit - 1]["id"] if len(rows) > limit else "",
                    "recent_scans": [
                        {k: j[k] for k in ("scan_id", "created_at", "status")}
                        for r in db.execute("SELECT payload FROM jobs ORDER BY created DESC LIMIT 20")
                        for j in [json.loads(r[0])]]}

    def badges(self, identities):
        """Bounded listing decoration; detailed evidence is validated on opening."""
        if not identities or not self.store.path.exists():
            return {}
        with self.lock, self.context.snapshots.read() as snapshot, self.store.connection() as db:
            job = self.store.job(db)
            if not job:
                return {}
            result, findings, docs = {}, {}, {}
            for identity in identities:
                # Keep listing work bounded. Full findings remain paginated in
                # the review screen; a badge is not a validity verdict.
                rows = db.execute(
                    "SELECT payload FROM findings WHERE scan=? AND (document_a=? OR document_b=?) "
                    "AND review IN ('pending','confirmed') ORDER BY id LIMIT 20",
                    (job["scan_id"], identity, identity)).fetchall()
                findings[identity] = []
                for row in rows:
                    f = json.loads(row[0])
                    findings[identity].append(f)
                    for e in f["evidence"]:
                        if e["document_id"] not in docs:
                            docs[e["document_id"]] = json.loads(db.execute(
                                "SELECT payload FROM documents WHERE scan=? AND id=?",
                                (job["scan_id"], e["document_id"])).fetchone()[0])
            heads = snapshot.heads_many(docs)
            states = {}
            dependency_ids = list(docs)
            for offset in range(0, len(dependency_ids), 500):
                states.update(self.context.evidence.document_statuses(dependency_ids[offset:offset + 500]))
            valid = {i: (
                heads.get(i) == d["version"] and states.get(i, {}).get("status") == "indexed"
                and states.get(i, {}).get("indexed_version") == d["version"]
                and states.get(i, {}).get("evidence_revision", "") == d["evidence_revision"]
            ) for i, d in docs.items()}
            for identity, values in findings.items():
                labels = set()
                for f in values:
                    current = all(valid[e["document_id"]] for e in f["evidence"]) and job["checked_at"][:10] == now()[:10]
                    labels.add(LABELS[f["category"]] if current else "Needs recheck")
                if labels:
                    result[identity] = sorted(labels)
            return result

    def cancel(self, scan_id):
        with self.lock, self.store.connection() as db:
            job = self.store.job(db, scan_id)
            if job is None:
                raise FileNotFoundError("Freshness scan not found")
            if job["status"] in ACTIVE:
                job["status"] = "cancelled"
                FreshnessStore.save_job(db, job)
            return self._public_job(job)

    def review(self, scan_id, finding_id, expected_revision, decision, note=""):
        if decision not in {"confirmed", "dismissed", "historical", "pending"}:
            raise ValueError("Choose confirmed, dismissed, historical or pending")
        if not isinstance(note, str) or len(note) > 2000:
            raise ValueError("Review note must be at most 2000 characters")
        with self.lock, self.context.snapshots.read(), self.store.connection() as db:
            self.store.job(db, scan_id)
            row = db.execute("SELECT * FROM findings WHERE scan=? AND id=?", (scan_id, finding_id)).fetchone() if db else None
            if row is None:
                raise FileNotFoundError("Finding not found")
            if row["revision"] != expected_revision:
                raise ValueError("Finding changed; refresh before reviewing")
            f = json.loads(row["payload"])
            docs = [json.loads(db.execute("SELECT payload FROM documents WHERE scan=? AND id=?",
                                         (scan_id, i)).fetchone()[0]) for i in {e["document_id"] for e in f["evidence"]}]
            if self._valid_finding(f, docs) != "valid":
                raise ValueError("Evidence changed; recheck before reviewing")
            revision = row["revision"] + 1
            event = {"decision": decision, "note": note, "at": now()}
            db.execute("INSERT INTO reviews VALUES(?,?,?,?)", (scan_id, finding_id, revision, encode(event)))
            f["review_note"] = note
            db.execute("UPDATE findings SET review=?,revision=?,payload=? WHERE scan=? AND id=?",
                       (decision, revision, encode(f), scan_id, finding_id))
            return {**f, "review": decision, "revision": revision, "validity": "valid"}

    def _cached(self, key, compute):
        key = digest([judgments.POLICY_VERSION, judgments.model_identity(), key])
        with self.lock, self.store.connection() as db:
            row = db.execute("SELECT payload FROM cache WHERE id=?", (key,)).fetchone()
            if row:
                return json.loads(row[0])
        value = compute()  # No application/store lock during hosted work.
        with self.lock, self.store.connection() as db:
            db.execute("INSERT OR REPLACE INTO cache VALUES(?,?,?)", (key, encode(value), time.time_ns()))
            self._trim_cache(db)
        return value

    @staticmethod
    def _trim_cache(db):
        excess = db.execute("SELECT COUNT(*) FROM cache").fetchone()[0] - CACHE_ENTRIES
        if excess > 0:
            db.execute("DELETE FROM cache WHERE id IN (SELECT id FROM cache ORDER BY touched LIMIT ?)", (excess,))

    def _decisions(self, pairs, contexts, as_of, scan):
        # Each answer is cached independently: batching/order changes do not
        # invalidate successful comparisons. Context changes still invalidate all.
        dependency = digest([judgments.POLICY_VERSION, judgments.model_identity(), contexts, as_of])
        keys = {p["id"]: digest(["compare-batch-1", dependency, p["a"]["id"], p["b"]["id"]]) for p in pairs}
        answers = {}
        with self.lock, self.store.connection() as db:
            for identity, key in keys.items():
                row = db.execute("SELECT payload FROM cache WHERE id=?", (key,)).fetchone()
                if row:
                    answers[identity] = json.loads(row[0])
        add("freshness_cached_pairs", len(answers))
        pending = [p for p in pairs if p["id"] not in answers]
        def save(values):
            if set(values) - keys.keys():
                raise ValueError("Unexpected comparison identity")
            with self.lock, self.store.connection() as db:
                for identity, value in values.items():
                    if identity not in answers:
                        db.execute("INSERT OR REPLACE INTO cache VALUES(?,?,?)",
                                   (keys[identity], encode(value), time.time_ns()))
                self._trim_cache(db)
            answers.update(values)
        def continuing():
            with self.lock, self.store.connection() as db:
                return not self.context.stop.is_set() and self.store.job(db, scan)["status"] in ACTIVE
        if pending:
            values = judgments.compare_many(pending, contexts, as_of, on_batch=save, should_continue=continuing)
            if set(values) != {p["id"] for p in pending}:
                raise ValueError("Incomplete batch response")
            save(values)
        return answers

    def process_one(self):
        """One bounded unit; the process owner calls this only for explicit jobs."""
        if self.context.stop.is_set() or not self.processing.acquire(blocking=False):
            return False
        try:
            with self.lock, self.store.connection() as db:
                if db is None:
                    return False
                active = db.execute("SELECT payload FROM jobs WHERE active=1").fetchone()
                if not active:
                    return False
                job = json.loads(active[0])
                scan = job["scan_id"]
                # Persist the next stage before work so progress is visible.
                if job["status"] == "queued":
                    job["status"] = "reading"
                    self.store.save_job(db, job)
            metrics = {}
            token = CURRENT.set(metrics)
            from symbiknow.embeddings.scheduling import BACKGROUND_WORK
            background_token = BACKGROUND_WORK.set(True)
            try:
                with stage("freshness_work"):
                    self._step(job)
            except Exception as error:
                with self.lock, self.store.connection() as db:
                    current = self.store.job(db, scan)
                    if current["status"] in ACTIVE and not (isinstance(error, InterruptedError) and self.context.stop.is_set()):
                        current["status"] = "failed"
                        current["error"] = f"Scan stopped ({type(error).__name__}). Completed results are saved; start a new scan to retry."
                        self.store.save_job(db, current)
            finally:
                CURRENT.reset(token)
                BACKGROUND_WORK.reset(background_token)
                with self.lock, self.store.connection() as db:
                    current = self.store.job(db, scan)
                    for k, v in metrics.items():
                        if isinstance(v, (int, float)):
                            current["usage"][k] = current["usage"].get(k, 0) + v
                    self.store.save_job(db, current)
            return True
        finally:
            self.processing.release()

    def _step(self, job):
        if job["model"] != judgments.model_identity() or job["policy"] != judgments.POLICY_VERSION:
            raise ValueError("Scan model/policy changed; start a new scan")
        scan = job["scan_id"]
        if job.get("capture_complete") is False:
            from symbiknow.search.index import captured_metadata_page
            rows = captured_metadata_page(self.context.DATA_DIR, job["capture"], job["capture_after"], 128)
            with self.lock, self.store.connection() as db:
                current = self.store.job(db, scan)
                if current["status"] not in ACTIVE:
                    return
                for row in rows:
                    data = {**row, "index_status": row.get("status", "pending")}
                    db.execute("INSERT OR IGNORE INTO documents(scan,id,payload,filename) VALUES(?,?,?,?)",
                               (scan, row["document_id"], encode(data), row["filename"]))
                current["capture_after"] = rows[-1]["document_id"] if rows else current["capture_after"]
                current["capture_complete"] = len(rows) < 128
                self.store.save_job(db, current)
            return
        if job.get("original_capture_complete") is False:
            # Include originals whose index registration has not finished. The
            # inventory runs only in the worker and flushes bounded batches;
            # INSERT OR IGNORE makes an interrupted capture safe to replay.
            from itertools import islice
            from symbiknow.library.storage import iter_documents
            originals = iter(iter_documents(self.context.DATA_DIR))
            try:
                while batch := list(islice(originals, 128)):
                    if self.context.stop.is_set():
                        return
                    with self.lock, self.store.connection() as db:
                        current = self.store.job(db, scan)
                        if current["status"] not in ACTIVE:
                            return
                        before = db.total_changes
                        db.executemany("INSERT OR IGNORE INTO documents(scan,id,payload,filename) VALUES(?,?,?,?)",
                                       [(scan, row["document_id"], encode({**row, "index_status": "pending", "evidence_revision": ""}), row["filename"]) for row in batch])
                        current["documents_total"] += db.total_changes - before
                        self.store.save_job(db, current)
            finally:
                originals.close()
            with self.lock, self.store.connection() as db:
                current = self.store.job(db, scan)
                current["original_capture_complete"] = True
                self.store.save_job(db, current)
            return
        with self.lock, self.store.connection() as db:
            pending = db.execute("SELECT payload FROM documents WHERE scan=? AND status='pending' ORDER BY id LIMIT 1", (scan,)).fetchone()
        if pending:
            with stage("freshness_read"):
                self._read_document(job, json.loads(pending[0]))
            return
        with self.lock, self.store.connection() as db:
            # Finish matching one document, then publish its comparisons before
            # advancing. Reading remains complete so late qualifiers are present.
            pair = db.execute("SELECT * FROM pairs WHERE scan=? AND status='pending' ORDER BY id LIMIT 1", (scan,)).fetchone()
            unfinished = db.execute("SELECT 1 FROM passages WHERE scan=? AND document=? AND matched=0 LIMIT 1",
                                    (scan, job.get("matching_document_id", ""))).fetchone()
            source = db.execute("SELECT document FROM passages WHERE scan=? AND matched=0 ORDER BY document,position LIMIT 1",
                                (scan,)).fetchone()
            batch = db.execute("SELECT payload FROM passages WHERE scan=? AND document=? AND kind IS NULL ORDER BY position LIMIT 12",
                               (scan, source[0])).fetchall() if source else []
        if pair and not unfinished:
            self._compare_pending(job, dict(pair))
            return
        if batch:
            values = [json.loads(r[0]) for r in batch]
            # A classification call never mixes documents.
            values = [p for p in values if p["document_id"] == values[0]["document_id"]]
            with stage("freshness_classify"):
                result = self._cached(["classify", values], lambda: judgments.classify(values, values[0]["filename"]))
            with self.lock, self.store.connection() as db:
                current = self.store.job(db, scan)
                if current["status"] not in ACTIVE:
                    return
                classified = 0
                for p in values:
                    classified += db.execute("UPDATE passages SET kind=? WHERE scan=? AND id=?", (result[p["id"]], scan, p["id"])).rowcount
                current["passages_classified"] += classified
                if classified != len(values):
                    self._gap(current, "changed_evidence_pairs")
                current["current_filename"] = values[0]["filename"]
                self.store.save_job(db, current)
            return
        with self.lock, self.store.connection() as db:
            pending = db.execute("SELECT payload FROM passages WHERE scan=? AND matched=0 ORDER BY document,position LIMIT 1", (scan,)).fetchone()
        if pending:
            with stage("freshness_match"):
                self._match(job, json.loads(pending[0]))
            return
        with self.lock, self.store.connection() as db:
            pair = db.execute("SELECT * FROM pairs WHERE scan=? AND status='pending' ORDER BY id LIMIT 1", (scan,)).fetchone()
        if pair:
            self._compare_pending(job, dict(pair))
            return
        with self.lock, self.store.connection() as db:
            current = self.store.job(db, scan)
            if current["status"] in ACTIVE:
                current["status"] = "partial" if current["gaps"] else "completed"
                current["current_filename"] = ""
                current["completed_at"] = now()
                self.store.save_job(db, current)

    def _compare_pending(self, job, first):
        """Independent document groups share the same cache/publication owner."""
        with self.lock, self.store.connection() as db:
            # One representative per group prevents two workers claiming the
            # same pending pairs. The process_one guard owns this work unit.
            peers = db.execute(
                "SELECT q.* FROM pairs q JOIN (SELECT MIN(id) AS id FROM pairs "
                "WHERE scan=? AND status='pending' AND context_key<>? "
                "GROUP BY context_key ORDER BY MIN(id) LIMIT ?) work ON q.id=work.id "
                "WHERE q.scan=?",
                (job["scan_id"], first["context_key"], COMPARE_WORKERS - 1, job["scan_id"])).fetchall()
        groups = [first, *(dict(p) for p in peers)]
        with stage("freshness_compare"):
            if len(groups) == 1:
                self._compare(job, first)
                return
            def run(pair, metrics):
                token = CURRENT.set(metrics)
                try:
                    self._compare(job, pair)
                finally:
                    CURRENT.reset(token)
            # Bounded per-work-unit lifetime: shutdown waits for both writers;
            # cancellation is checked between their individual hosted requests.
            with ThreadPoolExecutor(max_workers=COMPARE_WORKERS, thread_name_prefix="freshness") as pool:
                work = []
                for pair in groups:
                    metrics = {}
                    work.append((pool.submit(copy_context().run, run, pair, metrics), metrics))
                errors = []
                for future, metrics in work:
                    try:
                        future.result()
                    except Exception as error:
                        errors.append(error)
                    finally:
                        for key, value in metrics.items():
                            add(key, value)
                if errors:
                    raise errors[0]

    def _read_document(self, job, doc):
        scan = job["scan_id"]
        valid = self._valid_documents([doc]) == "valid"
        count, chunks, empty, sensitive = 0, 0, 0, False
        if valid:
            for batch in self.context.evidence.batches(doc["document_id"], doc["version"]):
                # Likely credentials are never sent to the hosted comparison.
                if any(contains_likely_secret(row["text"]) for row in batch):
                    sensitive = True
                    break
                if self.context.stop.is_set():
                    return
                with self.lock, self.store.connection() as db:
                    if self.store.job(db, scan)["status"] not in ACTIVE:
                        return
                    state = db.execute("SELECT status FROM documents WHERE scan=? AND id=?", (scan, doc["document_id"])).fetchone()
                    if state and state[0] == "removed":
                        return
                    for row in batch:
                        chunks += 1
                        if not row["text"].strip():
                            empty += 1
                        for p in segments(row, doc, count):
                            db.execute("INSERT OR IGNORE INTO passages(scan,id,document,position,payload) VALUES(?,?,?,?,?)",
                                       (scan, p["id"], doc["document_id"], count, encode(p)))
                            count += 1
        with self.lock, self.store.connection() as db:
            current = self.store.job(db, scan)
            if current["status"] not in ACTIVE:
                return
            state = db.execute("SELECT status FROM documents WHERE scan=? AND id=?", (scan, doc["document_id"])).fetchone()
            if state and state[0] == "removed":
                return
            if sensitive:
                count = empty = 0
                self._gap(current, "sensitive_content_withheld")
                db.execute("DELETE FROM passages WHERE scan=? AND document=?", (scan, doc["document_id"]))
            elif not valid or not count:
                self._gap(current, "unreadable_or_changed_documents")
                db.execute("DELETE FROM passages WHERE scan=? AND document=?", (scan, doc["document_id"]))
            if empty:
                self._gap(current, "passages_without_text", empty)
            db.execute("UPDATE documents SET status=? WHERE scan=? AND id=?",
                       ("read" if valid and count else "unavailable", scan, doc["document_id"]))
            current["documents_read"] += int(valid and count > 0)
            current["passages_read"] += count
            current["current_filename"] = doc["filename"]
            self.store.save_job(db, current)

    def _match(self, job, p):
        scan = job["scan_id"]
        with self.lock, self.store.connection() as db:
            current = self.store.job(db, scan)
            if current["status"] not in ACTIVE:
                return
            current["status"] = "matching"
            current["matching_document_id"] = p["document_id"]
            current["current_filename"] = p["filename"]
            self.store.save_job(db, current)
            row = db.execute("SELECT kind FROM passages WHERE scan=? AND id=?", (scan, p["id"])).fetchone()
            if row is None:
                return
            kind = row[0]
        scope = job["document_ids"]
        candidates, gaps, retrieved_passages = {}, 0, {}
        if kind != "other" and (scope is None or p["document_id"] in scope):
            target_ids = {p["document_id"], *job["reference_document_ids"]}
            for mode, limit in (("keyword", 24), ("semantic", 16)):
                results = self.context.evidence.find_documents(p["text"], mode, limit, None, None, defer_links=True)
                if len(results) >= limit:
                    gaps += 1
                target_ids.update(r["document_id"] for r in results)
                for result in results:
                    retrieved_passages.setdefault(result["document_id"], set()).update(
                        e["evidence_id"] for e in result.get("evidence", []))
            with self.lock, self.store.connection() as db:
                # Named document IDs/filenames bypass ranking limits. This is
                # explicit reference resolution, never authority from a name.
                named = db.execute("SELECT id FROM documents WHERE scan=? AND (instr(?, id)>0 OR instr(lower(?),lower(filename))>0)",
                                   (scan, p["text"], p["text"])).fetchall()
                target_ids.update(r[0] for r in named)
                for identity in sorted(target_ids):
                    rows = db.execute("SELECT payload FROM passages WHERE scan=? AND document=? ORDER BY position LIMIT 201",
                                      (scan, identity)).fetchall()
                    if len(rows) > 200:
                        gaps += 1
                    values = [json.loads(r[0]) for r in rows[:200]]
                    words = tokens(p["text"])
                    values = sorted((v for v in values if v["id"] != p["id"]),
                                    key=lambda v: (
                                        v["evidence_id"] not in retrieved_passages.get(identity, set()),
                                        -len(words & tokens(v["text"])), v["id"]))
                    # Retain explicit targets in full within the bounded window;
                    # otherwise use multiple passages per retrieved document.
                    selected = values if identity in {r[0] for r in named} else values[:4]
                    if len(selected) < len(values):
                        gaps += 1
                    candidates.update({v["id"]: v["document_id"] for v in selected})
        with self.lock, self.store.connection() as db:
            current = self.store.job(db, scan)
            if current["status"] not in ACTIVE:
                return
            for other in candidates:
                a, b = sorted([p["id"], other])
                context_key = "\n".join(sorted([p["document_id"], candidates[other]]))
                cursor = db.execute("INSERT OR IGNORE INTO pairs(scan,id,a,b,context_key) VALUES(?,?,?,?,?)",
                                    (scan, digest([a, b]), a, b, context_key))
                current["pairs_total"] += cursor.rowcount
            db.execute("UPDATE passages SET matched=1 WHERE scan=? AND id=?", (scan, p["id"]))
            current["passages_matched"] += 1
            if gaps:
                self._gap(current, "bounded_candidate_windows", gaps)
            self.store.save_job(db, current)

    def _compare(self, job, pair):
        scan = job["scan_id"]
        with self.lock, self.store.connection() as db:
            current = self.store.job(db, scan)
            if current["status"] not in ACTIVE:
                return
            current["status"] = "comparing"
            self.store.save_job(db, current)
            rows = [db.execute("SELECT payload FROM passages WHERE scan=? AND id=?", (scan, pair[k])).fetchone()
                    for k in ("a", "b")]
            if any(row is None for row in rows):
                db.execute("UPDATE pairs SET status='done' WHERE scan=? AND id=?", (scan, pair["id"]))
                current["pairs_checked"] += 1
                self._gap(current, "changed_evidence_pairs")
                self.store.save_job(db, current)
                return
            a, b = [json.loads(row[0]) for row in rows]
            # An indexed context group prevents rescanning the whole queue for
            # each batch. IDs keep each decision tied to its original pair.
            batch_rows = db.execute(
                "SELECT q.*,a.payload AS payload_a,b.payload AS payload_b FROM pairs q "
                "JOIN passages a ON a.scan=q.scan AND a.id=q.a "
                "JOIN passages b ON b.scan=q.scan AND b.id=q.b "
                "WHERE q.scan=? AND q.context_key=? AND q.status='pending' ORDER BY q.id LIMIT ?",
                (scan, pair["context_key"], judgments.MAX_BATCH_PAIRS)).fetchall()
            batch = [{"id": r["id"], "a": json.loads(r["payload_a"]), "b": json.loads(r["payload_b"])}
                     for r in batch_rows]
            docs = [json.loads(db.execute("SELECT payload FROM documents WHERE scan=? AND id=?", (scan, i)).fetchone()[0])
                    for i in sorted({a["document_id"], b["document_id"]})]
            contexts, total = [], 0
            for d in docs:
                size = db.execute("SELECT COALESCE(SUM(length(CAST(json_extract(payload,'$.text') AS BLOB)) "
                                  "+ length(CAST(json_extract(payload,'$.provenance') AS BLOB)) + 32),0) "
                                  "FROM passages WHERE scan=? AND document=?",
                                  (scan, d["document_id"])).fetchone()[0]
                total += size
                if total <= judgments.MAX_CONTEXT:
                    contexts.append({"document_id": d["document_id"], "filename": d["filename"],
                                     "passages": [json.loads(r[0]) for r in db.execute(
                                         "SELECT payload FROM passages WHERE scan=? AND document=? ORDER BY position",
                                         (scan, d["document_id"]))]})
        valid = self._valid_documents(docs)
        incomplete = total > judgments.MAX_CONTEXT
        if not incomplete:
            documents, _ = judgments.prepare_context(contexts)
            incomplete = judgments.encoded_size({"documents": documents, "as_of": job["checked_at"][:10]}) > judgments.MAX_CONTEXT
        decisions = {p["id"]: {"scope": "unclear", "relation": "unknown"} for p in batch}
        if valid == "valid" and not incomplete:
            decisions = self._decisions(batch, contexts, job["checked_at"][:10], scan)
        self._publish(job, batch, docs, decisions, incomplete)

    def _publish(self, job, batch, docs, decisions, incomplete):
        scan, refs = job["scan_id"], job["reference_document_ids"]
        with self.lock, self.context.snapshots.read() as snapshot, self.store.connection() as db:
            current = self.store.job(db, scan)
            if current["status"] not in ACTIVE:
                return
            states = self.context.evidence.document_statuses([d["document_id"] for d in docs])
            valid = self._valid_documents(docs, snapshot, states)
            evidence_refs = {(p[s]["document_id"], p[s]["version"], p[s]["evidence_id"])
                             for p in batch for s in ("a", "b")}
            resolved = self.context.evidence.resolve_evidence_many(evidence_refs) if valid == "valid" else {}
            for pair in batch:
                a, b, decision = pair["a"], pair["b"], decisions[pair["id"]]
                trusted = ("a" if a["document_id"] in refs else "b") if ((a["document_id"] in refs) != (b["document_id"] in refs)) else None
                category, target = judgments.label(decision, trusted)
                if decision.get("uncertain"):
                    self._gap(current, "uncertain_comparisons")
                if incomplete:
                    self._gap(current, "context_limit_pairs")
                if valid != "valid":
                    self._gap(current, "changed_evidence_pairs")
                if category and valid == "valid":
                    finding = {
                        "scan_id": scan, "finding_id": pair["id"], "category": category,
                        "label": LABELS[category], "affected_document_id": (a if target == "a" else b)["document_id"] if target else None,
                        "evidence": [a, b], "decision": decision,
                        "reason": REASONS[category],
                        "reference_document_ids": refs, "checked_at": job["checked_at"],
                        "model": job["model"], "policy": job["policy"], "context_complete": not incomplete,
                    }
                    # One protected snapshot and evidence batch; every exact
                    # anchor and each full context dependency is still checked.
                    if self._valid_finding(finding, docs, snapshot, states, resolved) == "valid":
                        cursor = db.execute("INSERT OR IGNORE INTO findings VALUES(?,?,?,?,?,?,?,?)",
                                            (scan, pair["id"], a["document_id"], b["document_id"], category, "pending", 1, encode(finding)))
                        current["findings_total"] += cursor.rowcount
                    else:
                        self._gap(current, "changed_evidence_pairs")
                db.execute("UPDATE pairs SET status='done' WHERE scan=? AND id=?", (scan, pair["id"]))
                current["pairs_checked"] += 1
            self.store.save_job(db, current)
