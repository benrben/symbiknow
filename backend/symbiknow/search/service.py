"""Shared search operations used by HTTP, MCP and local jobs.

Transport adapters project these results; current originals and every evidence
and relationship dependency are revalidated in a distinct protected final read.
"""

import hashlib
import json
from symbiknow.core.contracts import DomainResult


class SearchService:
    def __init__(self, context):
        self.context = context

    def retrieve(
        self,
        query: str,
        mode: str = "hybrid",
        limit: int = 10,
        folder: str | None = None,
        group: str | None = None,
        evaluate: bool = False,
        on_retrieved=None,
    ) -> DomainResult:
        """Retrieve current-version evidence and relevance explanations; optionally judge with Jev.

        mode is semantic, keyword, hybrid, or answer (hybrid plus Jev evaluation).
        Answer mode and evaluate=True return only accepted complete/partial answers or premise corrections;
        empty matches with answer.status explain no supported answer, uncertainty, or provider failure. Logical folder/group filters are metadata. Images
        distinguish visual matches from OCR/caption evidence used for text judgments.
        """
        if mode == "answer":
            mode, evaluate = "hybrid", True
        if (
            not query.strip()
            or mode not in ("semantic", "keyword", "hybrid", "grep")
            or not 1 <= limit <= 100
        ):
            raise self.context.search_error(
                "Use a nonempty query, valid mode and limit between 1 and 100"
            )
        if self.context.STORAGE_ONLY:
            return DomainResult(
                {
                    "matches": [],
                    "status": "indexing_disabled",
                    "evaluation": {"status": "unavailable", "error": "Storage-only mode"},
                }
            )
        from symbiknow.search.index import IndexChangedError
        from symbiknow.ai.jev import ANSWER_CANDIDATES, MAX_MATCHES

        # Answer checking has one server-owned retrieval window. A caller's larger
        # display limit must not deepen retrieval and overflow the verifier context.
        retrieval_limit = min(limit, MAX_MATCHES) if evaluate else limit

        # find_documents releases INDEX_LOCK while embedding, then validates its
        # current-version rows. An outer lock would serialize unrelated searches.
        from symbiknow.search.metrics import add, stage

        def retrieve(count):
            with stage("retrieval"):
                # One retry for concurrent ingestion/organization, before spending any
                # provider budget. Never spin or return a mixed-version snapshot.
                for attempt in range(2):
                    try:
                        return self.context.evidence.find_documents(
                            query,
                            mode,
                            count,
                            folder,
                            group,
                            defer_links=True,
                        )
                    except IndexChangedError:
                        if attempt:
                            raise self.context.search_error(
                                "The library is changing during retrieval. Retry this search after indexing or Jev organization finishes."
                            ) from None
                        add("retrieval_retries", 1)

        def judge(matches):
            from symbiknow.ai.jev import judge_matches

            epochs = {match["document_id"]: match.get("evidence_revision", "") for match in matches}
            try:
                with stage("jev"):
                    evaluation = judge_matches(
                        query, matches, cache_namespace=str(self.context.DATA_DIR.resolve()),
                        scope=dict(folder=folder, group=group) if folder or group else None,
                    )
                matches = evaluation.get("matches", matches)
                for match in matches:
                    judgment = match.get("jev", {})
                    if judgment.get("verification_dependencies"):
                        match["jev"] = {**judgment, "verification_dependencies": [
                            {**dependency, "evidence_revision": epochs.get(dependency["document_id"], "")}
                            for dependency in judgment["verification_dependencies"]
                        ]}
            except Exception as exc:
                from symbiknow.ai.provider_errors import provider_failure

                evaluation = provider_failure(exc)
            return matches, evaluation

        matches = retrieve(retrieval_limit)
        if on_retrieved:
            on_retrieved(matches)
        evaluation = {"status": "not_requested"}
        if evaluate:
            from symbiknow.ai.jev import answer_results

            matches, evaluation = judge(matches)
            deeper = min(ANSWER_CANDIDATES, MAX_MATCHES)
            # Jev found no answer in a full small window: a needed premise often
            # ranks just below a lookalike, so check one deeper window once.
            if (len(matches) == retrieval_limit < deeper
                    and answer_results(matches, evaluation)[1]["status"] == "no_answer_in_evaluated_candidates"):
                add("answer_retrieval_deepened", 1)
                wider = retrieve(deeper)
                if on_retrieved:
                    on_retrieved(wider)
                wider, wide_evaluation = judge(wider)
                # The deeper check can only add an answer; it never turns the
                # first window's checked negative into a less certain one.
                if answer_results(wider, wide_evaluation)[1]["status"] in {"answered", "partial", "corrected_premise"}:
                    matches, evaluation = wider, wide_evaluation
        evaluation = {key: value for key, value in evaluation.items() if key != "matches"}
        matches, revision = self.refresh(matches, folder, group)
        comparison = evaluation.get("cross_document_assessment", {})
        compared = set(comparison.get("compared_chunk_ids", []))
        if compared:
            # A cross-document decision depends on every compared current window,
            # including a counterpart removed by final head/scope validation.
            current = {
                window["chunk_id"]
                for match in matches
                if match.get("jev", {}).get("status") == "evaluated"
                for window in match["jev"].get("evaluated_evidence", [])
            }
            if not compared <= current:
                comparison.update(status="unavailable", reason="evidence_changed")
                for match in matches:
                    judgment = match.get("jev", {})
                    if any(
                        window["chunk_id"] in compared
                        for window in judgment.get("evaluated_evidence", [])
                    ):
                        match["jev"] = {
                            "status": "not_evaluated",
                            "reason": "disagreement_evidence_changed",
                        }
        answer = {"status": "not_requested"}
        related = []
        if evaluate:
            from symbiknow.ai.jev import answer_results, related_results

            related = related_results(matches, evaluation)
            matches, answer = answer_results(matches, evaluation)
        unavailable = answer.get("status") == "unavailable"
        return DomainResult(
            {
                "matches": matches,
                "status": "unavailable" if unavailable else "ok",
                "evaluation": evaluation,
                "answer": answer,
                # Relevant files Jev found no answer in; never answer evidence.
                **({"related": related} if related else {}),
                # Keep checked matches reserved for accepted evidence. A fresh
                # retrieval-only call uses the same scope and version guards,
                # without mistaking unchecked candidates for verified answers.
                **({"retrieval_fallback": {
                    "tool": "search",
                    "arguments": {
                        "query": query, "mode": mode, "limit": retrieval_limit,
                        "folder": folder, "group": group, "evaluate": False,
                    },
                }} if unavailable else {}),
                "indexing": {
                    "processing": self.context.processing.is_set(),
                    "queued_uploads": self.context.pending.qsize(),
                    "retry_documents": len(self.context.retry_ids),
                },
            }
        )

    def refresh(self, matches, folder, group, expected_revision=None):
        # Refresh display metadata after provider latency, and validate every
        # accepted evidence reference against the still-current stored passage.
        from symbiknow.search.index import revisions

        from time import perf_counter
        from symbiknow.search.metrics import add, stage

        waiting = perf_counter()
        with self.context.snapshots.read() as snapshot:
            add("final_lock_wait_seconds", perf_counter() - waiting)
            if (
                expected_revision is not None
                and revisions(self.context.DATA_DIR) != expected_revision
            ):
                raise self.context.search_error(
                    "Continuation invalidated by index/organization changes; restart search"
                )
            add("final_lock_acquisitions", 1)
            refreshed = []
            dependency_ids = {
                dep["document_id"]
                for match in matches
                for dep in match.get("jev", {}).get("verification_dependencies", [])
            }
            states = self.context.evidence.document_statuses(
                {match["document_id"] for match in matches} | dependency_ids
            )
            target_ids = {
                link["document_id"]
                for state in states.values()
                for link in json.loads(state.get("links_json", "[]"))
            } - states.keys()
            if target_ids:
                states.update(self.context.evidence.document_statuses(target_ids))
            with stage("final_heads"):
                heads = snapshot.heads_many(list(states.keys() | dependency_ids))

            def final_head(identity, role="final"):
                # Role counts include final relationship endpoints separately.
                # Reuse only inside the cross-process storage snapshot; every
                # supported writer is excluded until final publication completes.
                add(role + "_head_checks", 1)
                return heads.get(identity)

            requested = []
            for match in matches:
                identity, version = match["document_id"], match["version"]
                j = match.get("jev", {})
                refs = [r.get("evidence_id") for r in match.get("evidence", [])]
                refs.extend(r["chunk_id"] for r in j.get("evaluated_evidence", []))
                for key in (
                    "supporting_chunk_ids",
                    "conflicting_chunk_ids",
                    "possible_conflicting_chunk_ids",
                    "disagreement_chunk_ids",
                ):
                    refs.extend(j.get(key, []))
                requested.extend((identity, version, ref) for ref in refs)
                requested.extend(
                    (dep["document_id"], dep["version"], dep["chunk_id"])
                    for dep in j.get("verification_dependencies", [])
                )
                for link in json.loads(states.get(identity, {}).get("links_json", "[]")):
                    requested.append((identity, version, link.get("source_chunk_id")))
                    requested.append(
                        (link["document_id"], link["version"], link.get("target_chunk_id"))
                    )
            with stage("final_evidence"):
                passages = self.context.evidence.resolve_evidence_many(requested)

            def resolve(document_id, version, evidence_id):
                return passages.get((document_id, str(version), evidence_id))

            for match in matches:
                row = states.get(match["document_id"])
                if (
                    row is None
                    or row["status"] != "indexed"
                    or row["indexed_version"] != match["version"]
                    or row["version"] != match["version"]
                    or final_head(match["document_id"]) != match["version"]
                ):
                    continue
                if folder is not None and not (
                    row["folder"] == folder or (folder and row["folder"].startswith(folder + " / "))
                ):
                    continue
                if group is not None and group not in row["groups"]:
                    continue
                match.update(
                    folder=row["folder"],
                    groups=row["groups"],
                    created_at=row.get("created_at", ""),
                    organization_status=row["organization_status"],
                )
                match["links"] = [
                    dict(link, filename=states[link["document_id"]]["filename"])
                    for link in json.loads(row.get("links_json", "[]"))
                    if link["document_id"] in states
                    and states[link["document_id"]]["version"] == link["version"]
                    and states[link["document_id"]]["indexed_version"] == link["version"]
                    and states[link["document_id"]]["status"] == "indexed"
                    and link.get("source_version") == match["version"]
                    and final_head(link["document_id"], "final_relationship") == link["version"]
                    and resolve(match["document_id"], match["version"], link.get("source_chunk_id"))
                    and resolve(link["document_id"], link["version"], link.get("target_chunk_id"))
                ]
                judgment = match.get("jev", {})
                references = [
                    *judgment.get("supporting_chunk_ids", []),
                    *judgment.get("conflicting_chunk_ids", []),
                    *judgment.get("possible_conflicting_chunk_ids", []),
                    *judgment.get("disagreement_chunk_ids", []),
                ]
                resolved = {
                    ref: resolve(match["document_id"], match["version"], ref) for ref in references
                }
                changed = (row.get("evidence_revision", "") != match.get("evidence_revision", "")
                           or any(not value for value in resolved.values()))
                match["evidence_revision"] = row.get("evidence_revision", "")
                # A numeric answer can rely on an alias/correction in a document
                # that is not itself an answer result. Keep validating those exact
                # windows even when refreshing a retained continuation page.
                for dep in judgment.get("verification_dependencies", []):
                    context = states.get(dep["document_id"])
                    passage = resolve(dep["document_id"], dep["version"], dep["chunk_id"])
                    if (
                        context is None
                        or context["status"] != "indexed"
                        or context["version"] != dep["version"]
                        or context["indexed_version"] != dep["version"]
                        or context.get("evidence_revision", "") != dep.get("evidence_revision", "")
                        or final_head(dep["document_id"]) != dep["version"]
                        or (
                            folder is not None
                            and not (
                                context["folder"] == folder
                                or (folder and context["folder"].startswith(folder + " / "))
                            )
                        )
                        or (group is not None and group not in context["groups"])
                        or not passage
                        or hashlib.sha256(
                            passage["text"][dep["text_start"] : dep["text_end"]].encode()
                        ).hexdigest()
                        != dep["sha256"]
                    ):
                        changed = True
                for window in judgment.get("evaluated_evidence", []):
                    ref = window["chunk_id"]
                    current = resolved.get(ref) or resolve(
                        match["document_id"], match["version"], ref
                    )
                    if (
                        not current
                        or current["text"][window["text_start"] : window["text_end"]]
                        != window["text"]
                    ):
                        changed = True
                # Validate retrieval windows too, including evaluate=False searches.
                for passage in match.get("evidence", []):
                    current = resolve(
                        match["document_id"], match["version"], passage.get("evidence_id")
                    )
                    if not current or current.get("text") != passage.get("text"):
                        changed = True
                if changed:
                    match["jev"] = {"status": "not_evaluated", "reason": "evidence_changed"}
                    match["evidence"] = [
                        current
                        for passage in match.get("evidence", [])
                        if (
                            current := resolve(
                                match["document_id"],
                                match["version"],
                                passage.get("evidence_id"),
                            )
                        )
                    ]
                refreshed.append(match)
            matches = refreshed
            revision = revisions(self.context.DATA_DIR)
        return matches, revision
