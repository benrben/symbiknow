"""Shared library/detail domain operations with authoritative snapshot validation."""

import json
import uuid
from copy import deepcopy
from contextlib import nullcontext
from symbiknow.library.relationships import unique_relationships
from symbiknow.organization.policy import representative_evidence
from symbiknow.core.cache import CoalescingCache, dependency_key
from symbiknow.core.contracts import DomainResult
from symbiknow.library.storage import source_revision
from symbiknow.search.index import get_document_status, document_evidence, INDEX_LOCK, browse_documents, revisions, metadata_batches

_AGGREGATES = CoalescingCache(max_entries=16, max_bytes=8 * 1024**2, max_inflight=16)


def public(row):
    if row is None:
        raise FileNotFoundError("Document not found")
    return {
        k: v
        for k, v in row.items()
        if k not in ("source", "links_json", "organization_json", "request_id", "index_error", "evidence_dependencies_json")
    }


class LibraryService:
    def __init__(self, context):
        self.context = context

    def connections(self, doc_id, version, deduplicate=True, snapshot=None):
        """Bounded incoming/outgoing relations from the published organization view."""
        from symbiknow.search.index import relationship_rows

        with nullcontext(snapshot) if snapshot else self.context.snapshots.read() as snapshot:
            if snapshot.heads_many([doc_id]).get(doc_id) != version:
                return []
            states = relationship_rows(self.context.DATA_DIR, doc_id)
            identities = set(states)
            identities.update(
                link.get("document_id")
                for row in states.values()
                for link in json.loads(row["links_json"])
            )
            metadata = snapshot.metadata_many(identities)
            result = []
            for row in states.values():
                source = metadata.get(row["document_id"])
                if not source or source["version"] != row["version"]:
                    continue
                for link in json.loads(row["links_json"]):
                    target = metadata.get(link.get("document_id"))
                    if row["document_id"] != doc_id and link.get("document_id") != doc_id:
                        continue
                    if (
                        not target
                        or link.get("source_version") != row["version"]
                        or target["version"] != link.get("version")
                    ):
                        continue
                    result.append(
                        {
                            **link,
                            "source_document_id": row["document_id"],
                            "source_filename": source["filename"],
                            "target_filename": target["filename"],
                        }
                    )
            return (unique_relationships(result) if deduplicate else result)[:100]

    def detail(self, doc_id, version=None, section="full") -> DomainResult:
        with self.context.snapshots.read() as snapshot:
            current_metadata = snapshot.metadata_many([doc_id]).get(doc_id)
            if not current_metadata:
                raise FileNotFoundError("Document not found")
            metadata = (
                dict(current_metadata)
                if version is None or version == current_metadata["version"]
                else self.context.originals.metadata(doc_id, version)
            )
            row = get_document_status(self.context.DATA_DIR, doc_id)
            current = current_metadata["version"]
            history = self.context.originals.history_page(doc_id) if section == "full" else None
            return DomainResult(
                {
                    "document": public(metadata),
                    "current_version": current,
                    "indexing_error": row.get("index_error", "")[:1000]
                    if row and metadata["version"] == current
                    else "",
                    "organization": public(row) if row and metadata["version"] == current else None,
                    "organization_review": {
                        key: value
                        for key, value in json.loads(row["organization_json"]).items()
                        if key
                        in {
                            "project_scope",
                            "canonical_project",
                            "ownership",
                            "organization_reason",
                            "folder_confidence",
                            "folder_probabilities",
                            "prompt_version",
                            "folder_candidates",
                            "link_evaluations",
                            "origin",
                            "basis",
                            "folder",
                            "groups",
                            "evidence_ids",
                        }
                    }
                    if section != "summary" and row and metadata["version"] == current
                    else None,
                    "evidence": document_evidence(
                        self.context.DATA_DIR, doc_id, metadata["version"]
                    )
                    if section != "summary" and metadata["version"] == current
                    else [],
                    "connections": self.connections(doc_id, metadata["version"], snapshot=snapshot)[
                        : 5 if section == "summary" else 100
                    ],
                    "versions": [public(v) for v in reversed(history["versions"])]
                    if section == "full"
                    else [public(metadata)],
                    "versions_page": {
                        key: value for key, value in history.items() if key != "versions"
                    }
                    if history
                    else None,
                }
            )

    def library(self, params) -> DomainResult:
        # The listing is a derived index view. Its body, aggregate view and
        # source/publication token must nevertheless describe one protected read.
        with self.context.snapshots.read():
            result = self._library(params).to_wire()
        badges = self.context.freshness.badges([d["document_id"] for d in result["documents"]])
        for document in result["documents"]:
            if document["document_id"] in badges:
                document["freshness_labels"] = badges[document["document_id"]]
        return DomainResult(result)

    def _library(self, params):
        offset, limit = int(params.get("offset", 0)), int(params.get("limit", 60))
        if offset < 0 or not 1 <= limit <= 100:
            raise ValueError("Use a nonnegative offset and limit 1–100")
        result = browse_documents(
            self.context.DATA_DIR,
            offset,
            limit,
            params.get("folder"),
            params.get("group"),
            params.get("recent") == "true",
            params.get("sort", "filename"),
            params.get("descending") == "true",
        )
        result["documents"] = [public(r) for r in result["documents"]]
        result.update(
            self._aggregates(
                str(self.context.DATA_DIR),
                json.dumps(revisions(self.context.DATA_DIR), sort_keys=True),
                self._manual_revision(),
                params.get("folder"),
                params.get("group"),
            )
        )
        result.update(
            processing=self.context.processing.is_set(),
            max_file_bytes=self.context.MAX_FILE,
            max_chunk_bytes=self.context.MAX_CHUNK,
        )
        result.update(self.progress())
        return DomainResult(result)

    def _manual_revision(
        self,
    ):
        from symbiknow.organization.edits import summary

        return summary(self.context.DATA_DIR).get("revision", "")

    def _aggregates(self, data_dir, revision, manual_revision, selected_folder, selected_group):
        key = dependency_key(
            "library-aggregates",
            library=data_dir,
            revision=revision,
            originals=source_revision(data_dir),
            manual=manual_revision,
            group=selected_group,
        )
        result = deepcopy(_AGGREGATES.get_or_compute(
            key, lambda: self._aggregate_rows(data_dir, None, selected_group)))
        # Global counts and the exact group/folder joint counts do not change
        # when navigating within a folder tree. Derive this view privately from
        # the same revision-bound aggregate instead of scanning the corpus again.
        if selected_folder is not None:
            result["scoped_folders"] = {
                folder: count for folder, count in result["scoped_folders"].items()
                if folder == selected_folder or (selected_folder and folder.startswith(selected_folder + " / "))
            }
        return result

    def _aggregate_rows(self, data_dir, selected_folder, selected_group):
        from symbiknow.organization.edits import assignment_ids

        manual_ids = assignment_ids(data_dir)
        result = {}
        unfiled_review_count = 0
        with INDEX_LOCK:
            counts, groups, scoped, states = {}, set(), {}, {}
            for batch in metadata_batches(
                data_dir,
                columns=[
                    "document_id",
                    "version",
                    "folder",
                    "groups",
                    "status",
                    "organization_status",
                ],
            ):
                for row in batch:
                    if not row["folder"] and row["document_id"] not in manual_ids:
                        unfiled_review_count += 1
                    states[row["status"]] = states.get(row["status"], 0) + 1
                    if "failed" in row["organization_status"]:
                        states["organization_failed"] = states.get("organization_failed", 0) + 1
                    if (
                        row["organization_status"] in {"pending", "reset_pending"}
                        and row["status"] == "indexed"
                    ):
                        states["organization_pending"] = states.get("organization_pending", 0) + 1
                    counts[row["folder"]] = counts.get(row["folder"], 0) + 1
                    groups.update(row["groups"])
                    in_folder = (
                        selected_folder is None
                        or row["folder"] == selected_folder
                        or (
                            bool(selected_folder)
                            and row["folder"].startswith(selected_folder + " / ")
                        )
                    )
                    if in_folder and (selected_group is None or selected_group in row["groups"]):
                        scoped[row["folder"]] = scoped.get(row["folder"], 0) + 1
            result.update(
                folders=counts,
                scoped_folders=scoped,
                groups=sorted(groups),
                processing=self.context.processing.is_set(),
                processing_states=states,
                library_total=sum(counts.values()),
                unfiled_review_count=unfiled_review_count,
                max_file_bytes=self.context.MAX_FILE,
                max_chunk_bytes=self.context.MAX_CHUNK,
            )
        return result

    def progress(self):
        result = {"processing": self.context.processing.is_set()}
        from symbiknow.organization.rebuild import progress as rebuild_progress

        with INDEX_LOCK:
            derived = revisions(self.context.DATA_DIR)
        result["index_revision"] = derived["index"]
        manual_revision = self.context.DATA_DIR / "temp" / "organization-revision.txt"
        job = rebuild_progress(self.context) or {}
        result["organization_reset"] = {
            "revision": job.get("layout_revision", ""),
            "scope": job.get("layout_scope"),
        }
        result["organization_revision"] = (
            derived["organization"]
            + source_revision(self.context.DATA_DIR)
            + job.get("layout_revision", "")
            + (manual_revision.read_text() if manual_revision.exists() else "")
        )
        from symbiknow.organization.edits import summary, atomic

        ledger = summary(self.context.DATA_DIR)
        result["organization_revision"] += ledger.get("revision", "")
        result["manual_revision"] = ledger.get("revision", "")
        result["organization_change"] = ledger.get("change")
        identity_path = self.context.DATA_DIR / "temp" / "library-identity.json"
        with self.context.write_lock:
            if not identity_path.exists():
                atomic(identity_path, {"schema": 1, "id": str(uuid.uuid4())})
            result["library_id"] = json.loads(identity_path.read_text())["id"]
        result["revision"] = [derived["index"], result["organization_revision"]]
        result["rebuild_progress"] = job or None
        return result

    def delete_item(self, action, args):
        from symbiknow.organization.rebuild import status
        from symbiknow.search.index import remove_document

        with self.context.write_lock, INDEX_LOCK:
            state = status(self.context)
            if state and state["status"] in ("queued", "running"):
                raise ValueError("Wait for the organization rebuild to finish before deleting")
            if action == "delete-document":
                identity = args["document_id"]
                self.context.originals.delete(identity, args["expected_version"])
                remove_document(self.context.DATA_DIR, identity)
                self.context.status_cache.pop(identity, None)
                self.context.retry_ids.discard(identity)
                self.context.organization_attempts.difference_update(
                    entry
                    for entry in list(self.context.organization_attempts)
                    if entry[0] == identity
                )
                for path in (self.context.DATA_DIR / "temp" / "thumbnails").glob(
                    f"{identity}-*.jpg"
                ):
                    path.unlink(missing_ok=True)
                    path.with_suffix(".json").unlink(missing_ok=True)
                result = {"deleted": identity}
                from symbiknow.organization.edits import clear

                clear(self.context.DATA_DIR, [identity])
            else:
                folder = args["folder"]
                if not isinstance(folder, str) or not folder:
                    raise ValueError("Choose a named folder to delete")
                selection = browse_documents(self.context.DATA_DIR, limit=1, folder=folder)
                rows = selection["documents"]
                if not rows:
                    raise FileNotFoundError("Folder not found")
                from symbiknow.organization.edits import edit

                edit("remove-folder", {"folder": folder}, context=self.context)
                result = {"deleted_folder": folder, "moved_to_unfiled": selection["total"]}
            revision = self.context.DATA_DIR / "temp" / "organization-revision.txt"
            revision.parent.mkdir(parents=True, exist_ok=True)
            temporary = revision.with_suffix(".tmp")
            temporary.write_text(str(uuid.uuid4()))
            temporary.replace(revision)
            return result

    def card(self, doc_id, version) -> DomainResult:
        with self.context.snapshots.read() as snapshot:
            from symbiknow.organization.rebuild import common_context

            common = common_context(self.context)
            evidence = (
                representative_evidence(
                    document_evidence(self.context.DATA_DIR, doc_id, version), common
                )
                if snapshot.heads_many([doc_id]).get(doc_id) == version
                else []
            )
            # Fixed text budget, no original bodies or PDF embeds on browse cards.
            result = {"evidence": [{**row, "text": row["text"][:1600]} for row in evidence[:2]]}
            metadata = self.context.originals.metadata(doc_id, version)
            if (
                metadata["filename"].lower().endswith(".csv")
                and metadata.get("size", 0) <= 2 * 1024 * 1024
            ):
                import csv
                from itertools import islice
                from io import StringIO

                with self.context.originals.verified_file(doc_id, version) as (path, _):
                    with path.open("rb") as handle:
                        content = handle.read(64 * 1024)
                # Bound both the parser input and the returned cells. Never interpret formulas.
                sample = content[: 64 * 1024].decode("utf-8-sig", errors="replace")
                try:
                    result["table"] = [
                        [cell[:160] for cell in row[:6]]
                        for row in islice(csv.reader(StringIO(sample)), 9)
                    ]
                except csv.Error:
                    pass  # Extracted text and original download remain available.
            return DomainResult(result)
