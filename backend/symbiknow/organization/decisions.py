"""Shared, evidence-pinned human/agent queue. Automatic policy is unchanged.

Only actionable uncertainty is projected; provider failures, intentional unfiled
results and accepted work are not decisions. Receipts live beside manual edits.
"""
import hashlib
import json

from symbiknow.organization import edits
from symbiknow.search import index


class DecisionService:
    def __init__(self, context):
        self.context = context
        self.root = context.DATA_DIR
        self.path = self.root / "temp" / "jev-decisions.json"

    def _receipts(self):
        return json.loads(self.path.read_text()) if self.path.exists() else {}

    def _proposals(self, row, snapshot):
        from symbiknow.ai.jev import SUBJECT_CONFIDENCE

        identity, version = row["document_id"], row["version"]
        state = json.loads(row.get("organization_json") or "{}")
        if state.get("status") != "evaluated":
            return
        outcome = state.get("ownership", {}).get("outcome", "")
        folder_uncertain = outcome == "multiple_projects" or (
            outcome.startswith("o") and outcome[1:].isdigit()) or (
            outcome == "accepted" and state.get("folder_confidence", 1) < SUBJECT_CONFIDENCE)
        link_uncertain = any(not item.get("accepted") and 0.5 <= item.get("topic", 0) < 0.8
                             for item in state.get("link_evaluations", []))
        if not folder_uncertain and not link_uncertain:
            return
        if (row.get("status") != "indexed" or row.get("indexed_version") != version
                or snapshot.heads_many([identity]).get(identity) != version):
            return
        common = dict(document_id=identity, version=version, filename=row["filename"],
                      evidence_revision=row["evidence_revision"])
        evidence = list(state.get("evidence_ids", []))[:12]
        refs = [(identity, version, ref) for ref in evidence]
        resolved = index.resolve_evidence_many(self.root, refs)
        if not refs or any(ref not in resolved for ref in refs):
            return
        excerpt = resolved[refs[0]].get("text", "")[:1200]
        ownership = state.get("ownership", {})
        options = []
        # Explicit negative/no-evidence judgments are quiet; ambiguous positive
        # ownership has concrete choices the person can actually resolve.
        outcome = ownership.get("outcome", "")
        if outcome == "multiple_projects" or (outcome.startswith("o") and outcome[1:].isdigit()):
            candidates = ownership.get("candidates", {})
            probabilities = ownership.get("probabilities", {})
            keys = [key for key in candidates if key.startswith("o") and key[1:].isdigit()]
            keys.sort(key=lambda key: -probabilities.get(key, 0))
            options = [candidates[key] for key in keys]
        elif outcome == "accepted" and state.get("folder_confidence", 1) < SUBJECT_CONFIDENCE:
            probabilities = state.get("folder_probabilities", {})
            candidates = state.get("folder_candidates", [])
            ranked = sorted(enumerate(candidates), key=lambda pair: -probabilities.get(f"f{pair[0]}", 0))
            options = [name for i, name in ranked if probabilities.get(f"f{i}", 0) > 0]
        options = list(dict.fromkeys(name for name in options if name and name != row.get("folder")))[:8]
        if options and not edits.override(self.root, identity):
            yield self._identify(dict(common, kind="folder", suggested=options[0], options=options,
                                      current=row.get("folder") or "Unfiled", excerpt=excerpt,
                                      reason="More than one folder may fit this file.",
                                      evidence_ids=evidence))
        accepted = {link["document_id"] for link in json.loads(row.get("links_json") or "[]")}
        seen = set()
        dependencies = json.loads(row.get("evidence_dependencies_json") or "{}")
        for audit in sorted(state.get("link_evaluations", []), key=lambda item: -item.get("topic", 0)):
            target_id = audit.get("document_id")
            # The second-pass judge supplies topic/support/conflict scores. A
            # rejected, strongly unrelated pair is not a useful question.
            if (not target_id or target_id in accepted or target_id in seen or audit.get("accepted")
                    or not 0.5 <= audit.get("topic", 0) < 0.8):
                continue
            target = index.get_document_status(self.root, target_id)
            if (not target or target.get("status") != "indexed"
                    or target.get("indexed_version") != target["version"]
                    or target["version"] != audit.get("version")
                    or dependencies.get(target_id) != target.get("evidence_revision")
                    or snapshot.heads_many([target_id]).get(target_id) != target["version"]):
                continue
            if any(link.get("document_id") == identity and link.get("version") == version
                   for link in json.loads(target.get("links_json") or "[]")):
                continue  # The other endpoint already records this connection.
            pair = [(identity, version, audit.get("source_chunk_id")),
                    (target_id, target["version"], audit.get("target_chunk_id"))]
            passages = index.resolve_evidence_many(self.root, pair)
            if any(ref not in passages for ref in pair):
                continue
            seen.add(target_id)
            yield self._identify(dict(common, kind="connection", suggested="related",
                                      options=["related", "supports", "contradicts"], current="No connection",
                                      target_document_id=target_id, target_version=target["version"],
                                      target_evidence_revision=target["evidence_revision"],
                                      target_filename=target["filename"],
                                      source_chunk_id=pair[0][2], target_chunk_id=pair[1][2],
                                      excerpt=passages[pair[0]].get("text", "")[:1200],
                                      target_excerpt=passages[pair[1]].get("text", "")[:1200],
                                      reason="These passages may connect, but the evidence is not clear enough to link automatically.",
                                      evidence_ids=evidence))

    @staticmethod
    def _identify(proposal):
        digest = hashlib.sha256(json.dumps(proposal, sort_keys=True).encode()).hexdigest()
        return dict(proposal, id=proposal["document_id"] + ":" + digest)

    @staticmethod
    def _scope(proposal):
        if proposal["kind"] != "connection":
            return proposal["id"]
        endpoints = sorted([
            [proposal["document_id"], proposal["version"], proposal["evidence_revision"]],
            [proposal["target_document_id"], proposal["target_version"], proposal["target_evidence_revision"]],
        ])
        return "connection:" + hashlib.sha256(json.dumps(endpoints).encode()).hexdigest()

    def list(self, limit=50):
        if not isinstance(limit, int) or not 1 <= limit <= 100:
            raise ValueError("limit must be between 1 and 100")
        with self.context.snapshots.read() as snapshot:
            receipts, pending = self._receipts(), []
            seen = {receipt.get("scope", identity) for identity, receipt in receipts.items()}
            for batch in index.metadata_batches(self.root):
                for row in batch:
                    for proposal in self._proposals(row, snapshot):
                        scope = self._scope(proposal)
                        if proposal["id"] not in receipts and scope not in seen:
                            seen.add(scope)
                            pending.append(proposal)
                            if len(pending) > limit:
                                return {"decisions": pending[:limit], "has_more": True}
            return {"decisions": pending, "has_more": False}

    def resolve(self, decision_id, action, value=None, *, actor="user"):
        if action not in {"accept", "change", "skip"}:
            raise ValueError("Use accept, change or skip")
        if actor not in {"user", "agent"}:
            raise ValueError("Invalid decision actor")
        if not isinstance(decision_id, str) or len(decision_id) > 200:
            raise ValueError("Invalid decision ID")
        if action != "change" and value is not None:
            raise ValueError("Only change accepts a value")
        with self.context.snapshots.read() as snapshot:
            receipts = self._receipts()
            previous = receipts.get(decision_id)
            if previous:
                if previous["action"] != action or previous.get("value") != value:
                    raise ValueError("This decision was already handled; refresh the queue")
                return previous
            identity = decision_id.split(":", 1)[0]
            row = index.get_document_status(self.root, identity)
            proposal = next((p for p in self._proposals(row, snapshot) if p["id"] == decision_id), None) if row else None
            if not proposal:
                raise ValueError("This decision changed or was handled elsewhere; refresh the queue")
            scope = self._scope(proposal)
            if any(receipt.get("scope") == scope for receipt in receipts.values()):
                raise ValueError("This decision was already handled; refresh the queue")
            chosen = proposal["suggested"] if action == "accept" else value
            if action != "skip":
                if proposal["kind"] == "folder":
                    destination = edits.normalize(chosen, allow_empty=True)
                    edits.edit("move-documents", {"folder": destination, "documents": [
                        {"document_id": identity, "expected_version": proposal["version"]}]}, self.context)
                else:
                    if chosen not in proposal["options"]:
                        raise ValueError("Choose related, supports or contradicts")
                    state = json.loads(row["organization_json"])
                    links = json.loads(row["links_json"])
                    links.append({"document_id": proposal["target_document_id"],
                                  "version": proposal["target_version"], "source_version": proposal["version"],
                                  "source_chunk_id": proposal["source_chunk_id"],
                                  "target_chunk_id": proposal["target_chunk_id"],
                                  "relation": chosen, "reviewed_by": actor, "decision_id": decision_id})
                    index.save_organization(self.root, identity, proposal["version"], dict(
                        state, links=links, evidence_revision=proposal["evidence_revision"],
                        dependency_evidence_revisions=json.loads(row.get("evidence_dependencies_json") or "{}")))
            receipt = dict(id=decision_id, action=action, value=value, actor=actor, scope=scope)
            receipts[decision_id] = receipt
            edits.atomic(self.path, receipts)
            return receipt
