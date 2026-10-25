"""Application-owned durable jobs; adapters only submit and read bounded results."""
import copy
import logging
import threading
import time

INTERACTIVE = ("ask", "search")
ARTIFACTS = ("preview", "original-prepare", "original-range")


class JobService:
    def __init__(self, context):
        self.context = context
        self.wakes = []
        self.stop = threading.Event()
        self.threads = []

    def start(self, kind, args, request_id=None):
        if kind == "organization-rebuild":
            from symbiknow.organization.rebuild import validate_request
            validate_request(**args)
        if kind in {"ask", "search"}:
            if not isinstance(args.get("query"), str) or not args["query"].strip() or len(args["query"]) > 8192:
                raise ValueError("Use a nonempty query up to 8192 characters")
            if type(args.get("limit", 10)) is not int or not 1 <= args.get("limit", 10) <= 100:
                raise ValueError("Use a search limit between 1 and 100")
        result = self.context.work.start(kind, args, request_id)
        missing_catalog = kind == "library-catalog" and result["status"] == "completed" and not (
            self.context.catalog.taxonomy_ready() if args.get("read") == "taxonomy" else self.context.catalog.ready())
        if missing_catalog or (result["status"] == "failed" and kind in {"upload-commit", "folder-upload", "organization-edit", "library-catalog"}):
            self.context.work.enqueue("jobs", result["job_id"], {"kind": kind, "args": args}, replace=True)
            result["status"] = "queued"
        for wake in self.wakes:
            wake.set()
        return result

    def get(self, identity):
        record = self.context.work.get("jobs", identity)
        result = record["result"]
        if result and record["payload"]["kind"] in {"ask", "search"}:
            args = record["payload"]["args"]
            original = result.get("matches", [])
            matches, _ = self.context.search.refresh(copy.deepcopy(original), args.get("folder"), args.get("group"))
            result["matches"] = matches
            if matches != original and "answer" in result and result["answer"].get("status") != "pending":
                from symbiknow.ai.jev import answer_results
                result["matches"], result["answer"] = answer_results(matches, result.get("evaluation", {}))
        return {"job_id": identity, "status": record["state"], "result": result, "error": record["error"]}

    def process_one(self, kinds=None, *, exclude=False):
        items = self.context.work.claim("jobs", kinds=kinds, exclude=exclude)
        if not items:
            return False
        item = items[0]
        kind, args = item["payload"]["kind"], item["payload"]["args"]
        started = time.perf_counter()
        try:
            if kind in {"ask", "search"}:
                from symbiknow.search.metrics import CURRENT, stage
                metrics = {}
                token = CURRENT.set(metrics)
                try:
                    with stage("total"):
                        result = self.context.search.retrieve(**args, on_retrieved=lambda matches: self.context.work.progress(
                            item, {"matches": matches, "status": "evaluating", "evaluation": {"status": "pending"}, "answer": {"status": "pending"}})).to_wire()
                    result["metrics"] = metrics
                finally:
                    CURRENT.reset(token)
            elif kind == "upload-commit":
                result = self.context.transfers.commit_upload(args["request_id"])
            elif kind == "preview":
                from symbiknow.previews.service import prepare
                result = prepare(self.context, **args)
            elif kind == "original-prepare":
                from symbiknow.library import storage
                metadata = storage.prepare_ranges(self.context.DATA_DIR, args["document_id"], args.get("version"))
                result = {"ready": True, "version": metadata["version"]}
            elif kind == "library-catalog":
                if args["read"] not in {"list_documents", "taxonomy"}:
                    raise ValueError("Unknown catalogue read")
                self.context.catalog.prepare()
                if args["read"] == "taxonomy":
                    self.context.catalog.prepare_taxonomy()
                result = getattr(self.context.catalog, args["read"])(**args["args"])
                if "job_id" in result:
                    raise ValueError("The library changed during preparation; retry the read")
            elif kind == "original-range":
                from symbiknow.library import storage
                item_args = args["item"]
                storage.prepare_ranges(self.context.DATA_DIR, item_args["document_id"], item_args.get("version"))
                result = self.context.transfers.download([item_args])["files"][0]
            elif kind == "bulk-export":
                from symbiknow.transfers.exports import prepare
                result = prepare(self.context, args["documents"], item["id"])
            elif kind == "folder-upload":
                import json
                from symbiknow.transfers.folders import upload_folder
                payload = json.loads((self.context.DATA_DIR / "temp" / "folder-upload-jobs" / (args["input"] + ".json")).read_text())
                result = upload_folder(**payload, context=self.context)
            elif kind == "folder-export":
                from symbiknow.transfers.folders import download_folder
                result = download_folder(**args, context=self.context, on_snapshot=lambda sources: self.context.work.track_sources(item, sources))
            elif kind == "organization-rebuild":
                from symbiknow.organization.rebuild import request, progress
                request(**args, request_id=item["id"])
                result = progress(self.context)
            elif kind == "organization-edit":
                from symbiknow.organization.edits import edit
                if args["action"] == "remove-folder":
                    from symbiknow.organization.rebuild import status
                    if (status(self.context) or {}).get("status") in {"queued", "running"}:
                        raise ValueError("Wait for the organization rebuild to finish before deleting")
                result = edit(args["action"], args["args"], self.context, operation_id=item["id"])
                if args["action"] == "remove-folder":
                    result.update(deleted_folder=args["args"]["folder"], moved_to_unfiled=result["updated"])
            else:
                raise ValueError("Unknown job kind")
            self.context.work.finish(item, result, error="Some files need retry; inspect per-file results" if kind == "folder-upload" and not result.get("complete") else None)
            if kind == "folder-upload" and result.get("complete"):
                (self.context.DATA_DIR / "temp" / "folder-upload-jobs" / (args["input"] + ".json")).unlink(missing_ok=True)
        except InterruptedError:
            self.context.work.finish(item, retry_after=0)
        except Exception as error:
            logging.getLogger(__name__).exception("Job failed: %s", kind)
            failure = self.context.transfers.commit_failure(args["request_id"], error) if kind == "upload-commit" else None
            if kind == "bulk-export" and hasattr(error, "failures"):
                failure = {"error": str(error), "failures": error.failures}
            self.context.work.finish(item, result=failure, error="Library preparation failed; retry the read." if kind == "library-catalog" else str(error)[:500])
        elapsed = time.perf_counter() - started
        if elapsed >= .2:
            logging.getLogger(__name__).info("Background job kind=%s seconds=%.3f argument_bytes=%d", kind, elapsed, len(str(item["payload"]).encode()))
        self.context.work.prune()
        return True

    def open(self):
        self.stop.clear()
        self.threads = []
        self.wakes = []
        # Reserve execution capacity so exports and bulk edits cannot occupy the
        # workers needed to search or open a document. Admission remains capped.
        for number, (kinds, exclude) in enumerate(((("search",), False), (("ask",), False), (ARTIFACTS, False), (INTERACTIVE + ARTIFACTS, True))):
            wake = threading.Event()
            self.wakes.append(wake)
            thread = threading.Thread(target=self._run, args=(kinds, exclude, wake), name=f"symbiknow-jobs-{number}", daemon=True)
            self.threads.append(thread)
            thread.start()

    def _run(self, kinds, exclude, wake):
        next_cleanup = 0
        while not self.stop.is_set():
            if exclude and time.monotonic() >= next_cleanup:
                try:
                    from symbiknow.transfers.exports import cleanup
                    from symbiknow.transfers.folders import cleanup_staged
                    cleanup(self.context.DATA_DIR)
                    cleanup_staged(self.context)
                    self.context.transfers.cleanup_staging()
                    self.context.work.prune()
                except Exception:
                    logging.getLogger(__name__).exception("Transfer expiry cleanup failed")
                next_cleanup = time.monotonic() + 60
            wake.clear()
            if self.process_one(kinds, exclude=exclude):
                continue
            wake.wait(1)

    def close(self):
        self.stop.set()
        for wake in self.wakes:
            wake.set()
        for thread in self.threads:
            thread.join()
