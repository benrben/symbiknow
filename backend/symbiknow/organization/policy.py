"""Content-derived organization candidates and representative, versioned evidence."""

import re
from collections import Counter
from functools import wraps
import copy

from symbiknow.core.cache import CoalescingCache, dependency_key

# Stable evidence analysis and corpus decisions have separate byte budgets.
_ANALYSIS = CoalescingCache(max_entries=2048, max_bytes=16 * 1024**2, max_inflight=8)
_CORPUS = CoalescingCache(max_entries=16, max_bytes=16 * 1024**2, max_inflight=2)
ANALYSIS_POLICY = "organization-features-3-identity-subject-separation"


def _reused(cache, namespace):
    def decorate(function):
        @wraps(function)
        def reuse(*args, **kwargs):
            def dependencies(value):
                if isinstance(value, ProjectNames):
                    return {"project_names_digest": value.digest}
                if isinstance(value, dict):
                    return {key: dependencies(item) for key, item in value.items()}
                if isinstance(value, (list, tuple)):
                    return [dependencies(item) for item in value]
                return value
            key = dependency_key(namespace, policy=ANALYSIS_POLICY,
                                 args=dependencies(args), kwargs=dependencies(kwargs))
            return copy.deepcopy(cache.get_or_compute(key, lambda: function(*args, **kwargs)))
        return reuse
    return decorate


class ProjectNames(tuple):
    """Reusable exact-name lookup, so recognition never scans every project per document."""

    def __new__(cls, names):
        result = super().__new__(cls, sorted(set(names)))
        result.lookup = {name.casefold(): name for name in reversed(result)}
        result.max_words = max((len(name.split()) for name in result), default=0)
        result.digest = dependency_key("organization-project-names", names=list(result))
        return result


def _canonical_root(root, known, ocr=False):
    """Resolve casing and a dangling OCR possessive only against a known identity.

    Deliberately do not fuzzy-merge arbitrary names, or a real company named Atlas S.
    Extracted evidence and its provenance remain untouched.
    """
    if ocr:
        if root.casefold() in known.lookup:
            return known.lookup[root.casefold()]
        base = re.sub(r"(?:\s+s|['’]s)$", "", root)
        if base != root and base.casefold() in known.lookup:
            return known.lookup[base.casefold()]
    return known.lookup.get(root.casefold(), root)


@_reused(_ANALYSIS, "topic_paths")
def topic_paths(evidence, known=()):
    """A heading like Project / Subject / Title names a reusable subject folder."""
    known = known if isinstance(known, ProjectNames) else ProjectNames(known)
    paths = []
    for row in evidence:
        headings = row.get("provenance", {}).get("headings", [])
        for heading in [*headings, *row.get("text", "").splitlines()]:
            heading = heading.strip().lstrip("#").strip()
            parts = [p.strip() for p in re.split(r"\s+[/>›]\s+", heading)]
            # The final document title is free to be long or sentence-shaped;
            # the reusable prefix must still look like folder labels.
            prefix = parts[:-1] if len(parts) > 2 else parts
            reusable = " / ".join(prefix)
            if (
                len(heading) <= 1000
                and 2 <= len(parts) <= 5
                and parts[-1]
                and all(p and any(c.isalnum() for c in p)
                        and len(p) <= 60 and len(p.split()) <= 4 for p in prefix)
                and not re.search(r"https?://|[.!?;=`{}]", reusable)
                and not re.search(
                    r"\b(?:is|are|was|were|must|should|can|will|when|because|then)\b",
                    reusable,
                    re.I,
                )
            ):
                parts[0] = _canonical_root(parts[0], known, row.get("basis") == "ocr")
                paths.append(" / ".join(parts[:-1] if len(parts) > 2 else parts))
    return sorted(set(paths), key=lambda p: (p.casefold(), p))


@_reused(_ANALYSIS, "heading_projects")
def heading_projects(evidence):
    """Owner hypotheses from root titles, never filenames or section mentions."""
    names = set()
    for row in evidence:
        if row.get("basis") == "title":
            continue  # A filename alone must not become an explicit owner heading.
        headings = row.get("provenance", {}).get("headings", [])
        roots = headings[:1] if headings else re.findall(r"(?m)^#\s+(.+)$", row.get("text", ""))
        for root in roots:
            root = root.strip().lstrip("#").strip()
            title = re.fullmatch(r"(.{1,60}?)\s+[—–-]\s+\S.*", root) or re.fullmatch(
                r"(.{1,60}?)\s+(?:plan|decisions|status|architecture|documentation|handbook|overview|readme)",
                root, re.I,
            )
            if title:
                name = title[1].strip()
                words = re.findall(r"[^\W\d_]+", name.lower())
                if words and len(words) <= 4 and not any(w in GENERIC | {"validation", "ui", "user"} for w in words):
                    names.add(name)
    return names


def identity_statements(evidence):
    """Explicit identity claims are hypotheses with exact supporting passages.

    They are local evidence, never permission to merge registry identities.
    Names can be lowercase product names; dates, title suffixes and feature
    headings are not identity claims.
    """
    token = r"[\w](?:[\w-]|\.(?=\w))*"
    name = rf"{token}(?:[ \t]+[A-Z](?:[\w-]|\.(?=\w))*){{0,3}}"
    patterns = [
        rf"(?P<left>{name})\s+is\s+(?:the\s+)?(?:user-facing\s+|public\s+|new\s+)?name\s+(?:of|for)\s+(?P<right>{name})",
        rf"(?P<left>{name})\s+(?:is\s+)?(?:also\s+known\s+as|formerly\s+known\s+as|renamed\s+to)\s+(?P<right>{name})",
    ]
    claims = []
    for row in evidence:
        if row.get("basis") == "title":
            continue
        text = row.get("text", "")
        for pattern in patterns:
            for match in re.finditer(pattern, text):
                claims.append({"left": match["left"], "right": match["right"],
                               "reason": "explicit identity statement",
                               "evidence_id": row.get("evidence_id", row.get("chunk_id")),
                               "passage": match.group(), "start": match.start(), "end": match.end()})
    return claims


def project_candidates(evidence, folders=(), projects=(), limit=16):
    return [candidate["name"] for candidate in project_candidate_details(evidence, folders, projects, limit)]


def project_candidate_details(evidence, folders=(), projects=(), limit=16):
    """Small, canonical owner hypotheses grounded in the full document context.

    Candidate discovery is not assignment: Jev still decides membership. A known
    project must not lose its slot to diagram numbers or generic sentence starts.
    """
    generic = GENERIC | {
        "validation", "browser", "candidate", "canvas", "desktop", "library", "pdf",
        "positions", "bounds", "existing", "rebuild", "refresh", "repository", "keyword",
        "download", "upload", "convert", "selection", "compact", "evidence", "passage",
        "provider", "continuation", "cached", "premise", "parameters", "details",
    }
    # Folder roots are spelling hints only: they become candidates only when
    # corroborated by source text (including narrow OCR normalization below).
    # They never register an identity or establish ownership on their own.
    folder_hints = {f.split(" / ")[0].casefold(): f.split(" / ")[0] for f in folders
                    if any(c.isalpha() for c in f.split(" / ")[0])
                    and not any(word in generic for word in re.findall(r"[^\W\d_]+", f.split(" / ")[0].casefold()))}
    canonical = dict(folder_hints) if not projects else {}
    if hasattr(projects, "canonical_names"):
        canonical = projects.canonical_names
        known = projects.names
        matcher = projects.matcher
    else:
        for project in projects:
            for name in [project["name"], *project.get("aliases", []), *project.get("features", [])]:
                canonical[name.casefold()] = project["name"]
        known = ProjectNames(canonical.values())
        from symbiknow.organization.matcher import ProjectMatcher
        matcher = ProjectMatcher(canonical)
    text = "\n".join(r.get("text", "") for r in evidence if r.get("basis") != "title")
    headings = "\n".join(h for r in evidence for h in r.get("provenance", {}).get("headings", []))
    context = text + "\n" + headings
    hinted = (set().union(*(matcher.find(row.get("text", "")) for row in evidence if row.get("basis") == "title"))
              if projects else set())
    grounded = matcher.find(context)
    # Prefixes in headings such as Product / Search or Product MCP protocol are
    # subjects of a known product, unless independently registered as an owner.
    ocr_only = bool(evidence) and all(r.get("basis") in {"ocr", "title"} for r in evidence)
    def normalize(name):
        name = _canonical_root(name, known, ocr=ocr_only)
        if name.casefold() in canonical:
            return canonical[name.casefold()]
        folded = name.casefold()
        # Only a prefix ending at one of this hypothesis's spaces can match.
        # Longest first preserves the previous alias precedence without sorting
        # or visiting an entire registry for each proposed name.
        for boundary in reversed([i for i, char in enumerate(folded) if char == " "]):
            alias = folded[:boundary]
            if alias in canonical:
                suffix = name[len(alias):].strip().lower().split()
                if suffix and all(word in {"mcp", "api", "sdk", "protocol", "search", "storage", "interface",
                                           "app", "engine", "overview", "playground", "decision", "log",
                                           "speed", "plan", "parallel", "jobs", "results", "comparison"}
                                  or word in canonical for word in suffix):
                    return canonical[alias]
        return name

    def plausible(name):
        words = re.findall(r"[^\W\d_]+", name.lower())
        return (name.casefold() in canonical or
                (bool(words) and len(words) <= 4 and not any(w in generic for w in words)
                 and not re.search(r"\d{4}|[():?]", name)))

    paths = {normalize(path.split(" / ")[0]) for path in topic_paths(evidence, known)}
    grounded = {name for name in grounded if name in paths or not any(
        path.casefold().startswith(name.casefold() + " ") for path in paths
    )}
    hypothesis = normalize(project_scope(evidence, known))
    explicit = {normalize(name) for name in heading_projects(evidence) if plausible(name)}
    new = {name for name in paths if name and plausible(name)}
    # Multiword proper names in ordinary prose (Vela Labs, Oak Garden) remain
    # plausible owners even without a project heading. A lone first word such
    # as Decode, Installed or Final has no equivalent identity evidence.
    if (hypothesis and plausible(hypothesis) and len(hypothesis.split()) >= 2
            and all(word[:1].isupper() for word in hypothesis.split())):
        new.add(hypothesis)
    new.update(explicit)
    statements = identity_statements(evidence)
    identity_names = {normalize(claim[side]) for claim in statements for side in ("left", "right")}
    new.update(name for name in identity_names if plausible(name))
    # An explicit comparison names another possible owner even when it is not
    # registered yet. Keep it for Jev to reject; topic vocabulary is not enough.
    for match in re.finditer(r"\b(?:[Uu]nlike|[Cc]ompared (?:to|with)) ([A-Z][\w-]*(?: [A-Z][\w-]*)*)", context):
        name = normalize(match[1])
        if plausible(name):
            new.add(name)
    # A recognized dependency must not suppress an unfamiliar owning project.
    # Require a named sentence subject with substantive product behavior, not
    # an arbitrary capitalized section or a question's opening word.
    subject_pattern = (r"(?:^|[.!?\n]\s*)([A-Z][\w'-]*(?:[ \t]+[A-Z][\w'-]*){0,3})"
                       r"\s+(?:owns|manages|accepts|processes|provisions|disables|provides|stores|runs|builds|uses|implements|serves|powers|offers|supports)\b")
    subject_names = {normalize(m[1]) for m in re.finditer(subject_pattern, text)}
    subject_names.update(normalize(m[1]) for m in re.finditer(
        r"(?:^|[.!?\n]\s*)([\w'-]+(?:[ \t]+[A-Z][\w'-]*){0,3})"
        r"\s+is\s+(?:an?|our|the)\s+(?:[\w-]+\s+){0,3}(?:project|app|engine|platform|product|service)\b", text))
    subject_names.update(normalize(m[1]) for m in re.finditer(
        r"\b(?:At|For|at|for)\s+([A-Z][\w'-]*(?:[ \t]+[A-Z][\w'-]*){0,3})\b", text))
    new.update(name for name in subject_names if plausible(name))
    if not grounded:
        for sentence in _sentences(text):
            name = normalize(project_scope([{"text": sentence}], known))
            if name and plausible(name) and name in subject_names:
                new.add(name)
    # A one-letter name ("S" from a size label) is not an identity, and once
    # registered it would match ordinary text in nearly every document.
    names = sorted({name for name in grounded | hinted | new
                    if len(re.findall(r"[^\W\d_]", name)) >= 2}, key=lambda name: (
        name not in explicit, name not in identity_names, name not in grounded, name not in hinted,
        name not in paths, name != hypothesis, name.casefold()
    ))[:limit]
    result = []
    for name in names:
        if hasattr(projects, "lookup"):
            record = projects.lookup.get(name.casefold(), {})
            aliases = [name, *record.get("aliases", []), *record.get("features", [])]
        else:
            aliases = [alias for alias, owner in canonical.items() if owner == name] or [name]
        support = []
        for row in evidence:
            passage = row.get("text", "")
            matched = next((alias for alias in aliases if re.search(
                r"(?<!\w)" + re.escape(alias) + r"(?!\w)", passage, re.I)), None)
            if matched:
                match = re.search(r"(?<!\w)" + re.escape(matched) + r"(?!\w)", passage, re.I)
                start, end = max(0, match.start() - 200), min(len(passage), match.end() + 600)
                support.append({"evidence_id": row.get("evidence_id", row.get("chunk_id")),
                                "basis": row.get("basis", "text"), "passage": passage[start:end],
                                "start": start, "end": end, "matched_name": matched})
        reasons = []
        if name in explicit:
            reasons.append("project heading")
        if name in identity_names:
            reasons.append("explicit identity statement")
        if name in grounded:
            reasons.append("registered project, alias or feature in content" if projects
                           else "source name corroborated by a folder spelling hint; ownership unverified")
        if name in paths:
            reasons.append("project prefix in contextual heading")
        if name in subject_names:
            reasons.append("named subject describing product behavior")
        if name in hinted:
            reasons.append("filename hint requiring content corroboration")
        result.append({"name": name, "reasons": reasons or ["content-derived owner hypothesis"],
                       "supporting_passages": support[:6]})
    return result


def ownership_evidence(evidence, owners=(), limit=6):
    """Keep project-bearing source windows independent of topical diversity.

    IDs/provenance stay attached to the original extracted passages. Text remains
    untrusted evidence, including headings; a matching name is not an assignment.
    """
    rows = [r for r in evidence if r.get("text") and r.get("basis") not in {"visual", "image", "native_image", "title"}]
    def rank(row):
        text = row["text"]
        headings = row.get("provenance", {}).get("headings", [])
        named = sum(bool(re.search(r"(?<!\w)" + re.escape(name) + r"(?!\w)", text, re.I)) for name in owners)
        tagged = bool(re.search(r"(?:project:|/|›)", text)) and named > 0
        return (-tagged, -bool(headings and named), -named, row.get("evidence_id", row.get("chunk_id", "")))
    return sorted(rows, key=rank)[:limit]


def project_identity(name, projects=()):
    """Stable IDs are independent of ingestion and supplied choice order."""
    import uuid

    if hasattr(projects, "lookup"):
        found = projects.lookup.get(name.casefold())
        if found is not None:
            return {key: found[key] for key in ("id", "name", "aliases", "features") if key in found}
    for project in (() if hasattr(projects, "lookup") else projects):
        if name.casefold() in {
            n.casefold() for n in [project["name"], *project.get("aliases", [])]
        }:
            return {key: project[key] for key in ("id", "name", "aliases", "features") if key in project}
    return {
        "id": str(uuid.uuid5(uuid.NAMESPACE_URL, "symbiknow:project:" + name.casefold())),
        "name": name,
        "aliases": [],
    }


# These terms describe document form or test context, rather than its subject.
GENERIC = frozenset(
    "policy policies procedure procedures note notes document documents guide guides "
    "test tests testing fictional synthetic fixture fixtures qa example examples "
    "project projects team specialist department new original related current "
    "approved rejected proposal draft status record records receive receives "
    "require requires check checks verify verifies confirms grants issuing "
    "accepts issuing freely draining prune remove place keep only avoid "
    "match compare submit attach ensure enter select click use add send note follow".split()
)


def _sentences(text):
    return [part.strip() for part in re.split(r"(?<=[.!?])\s+|\n+", text) if part.strip()]


def _boilerplate(text):
    lower = text.lower().strip(" #")
    return bool(
        re.match(
            r"(?:this is|these are|all details are|synthetic|fictional|for testing|test fixture|shared synthetic)\b",
            lower,
        )
        and re.search(r"\b(?:test|fictional|synthetic|fixture|qa)\b", lower)
    )


def clean_text(text, common_lines=()):
    common = {re.sub(r"\s+", " ", line).casefold().strip() for line in common_lines}
    return "\n".join(
        sentence
        for sentence in _sentences(text)
        if not _boilerplate(sentence) and re.sub(r"\s+", " ", sentence).casefold() not in common
    )


@_reused(_ANALYSIS, "representative_evidence")
def representative_evidence(evidence, common_lines=(), limit=3):
    """Remove non-substantive notices throughout passages, retaining real evidence IDs."""
    rows = []
    for row in evidence:
        if not row.get("text") or row.get("basis") in {"visual", "image", "native_image"}:
            continue
        # Repetition is useful for topic ranking, not grounds to erase evidence.
        # Shared project headers and policies still establish ownership/context.
        text = clean_text(row["text"])
        if text:
            rows.append({**row, "text": text})
    opening = rows[0] if rows else None
    rows.sort(
        key=lambda r: (
            -bool(topic_paths([{"text": r["text"]}])),
            -bool(r.get("provenance", {}).get("headings")),
            -len(set(re.findall(r"\w+", clean_text(r["text"], common_lines).lower()))),
            r.get("evidence_id", ""),
        )
    )
    return ([opening, *[r for r in rows if r is not opening]] if opening else rows)[:limit]


def _tokens(text):
    from sklearn.feature_extraction.text import ENGLISH_STOP_WORDS

    tokens = re.findall(r"[^\W\d_]+(?:-[^\W\d_]+)*", text.lower())
    # Keep named subjects stable across employee/employees and invoice/invoices.
    return [
        {
            "employees": "employee",
            "invoices": "invoice",
            "customers": "customer",
            "users": "user",
        }.get(word, word)
        for word in tokens
        if word not in GENERIC and word not in ENGLISH_STOP_WORDS
    ]


@_reused(_ANALYSIS, "project_scope")
def project_scope(evidence, known=()):
    """Prefer explicit project headings, then the first named entity in substantive prose."""
    known = known if isinstance(known, ProjectNames) else ProjectNames(known)
    explicit_names = heading_projects(evidence)
    if len(explicit_names) == 1:
        return _canonical_root(next(iter(explicit_names)), known)
    paths = topic_paths(evidence, known)
    if paths:
        return paths[0].split(" / ")[0]
    text = "\n".join(clean_text(row.get("text", "")) for row in evidence)
    candidates = []
    from sklearn.feature_extraction.text import ENGLISH_STOP_WORDS

    # Sentence subjects identify unfamiliar single-word entities as well as names
    # like Vela Labs. Do not treat every capitalized heading or workflow noun as
    # an entity, or let a later cross-reference override the document's subject.
    non_entities = (
        GENERIC
        | ENGLISH_STOP_WORDS
        | {
            "customer",
            "customers",
            "employee",
            "employees",
            "staff",
            "return",
            "returns",
            "opened",
            "unused",
            "billing",
            "commerce",
            "identity",
            "invoice",
            "invoices",
            "introduction",
            "overview",
            "architecture",
            "search",
            "storage",
            "retrieval",
            "approved",
            "rejected",
            "acceptance",
            "flow",
            "design",
            "account",
            "accounts",
        }
    )
    for match in re.finditer(r"\b[A-Z][A-Za-z'-]+(?:\s+[A-Z][A-Za-z'-]+){1,3}\b", text):
        words = match.group().split()
        while words and words[0].lower() in non_entities:
            words.pop(0)
        if len(words) >= 2 and not any(w.lower() in non_entities for w in words):
            name = " ".join(words)
            candidates.append((text.find(name, match.start()), _canonical_root(name, known)))
    for match in re.finditer(
        r"(?:^|[.!?\n]\s*|\bAt\s+|\bFor\s+)([A-Z][A-Za-z'-]+(?:\s+[A-Z][A-Za-z'-]+){0,3})"
        r"(?=\s+[a-z])",
        text,
    ):
        words = match.group(1).split()
        following = text[match.end(1) :].split()[0].strip(",.;:").lower()
        if len(words) == 1 and following in ENGLISH_STOP_WORDS:
            continue
        while words and (
            words[0].lower() in GENERIC
            or words[0].lower() in ENGLISH_STOP_WORDS
            or words[0] in {"At", "When"}
        ):
            words.pop(0)
        if words and not any(w.lower() in non_entities for w in words):
            name = " ".join(words)
            candidates.append((match.start(1), _canonical_root(name, known)))
    words = list(re.finditer(r"[^\W\d_]+(?:[-'’][^\W\d_]+)*", text))
    for i, word in enumerate(words):
        for size in range(1, min(known.max_words, len(words) - i) + 1):
            end = words[i + size - 1].end()
            name = known.lookup.get(re.sub(r"\s+", " ", text[word.start() : end]).casefold())
            if name and name.lower() not in GENERIC:
                candidates.append((word.start(), name))
    if not candidates:
        return ""
    # Repeated ownership and headings outweigh an incidental opening reference.
    headings = [
        heading for row in evidence for heading in row.get("provenance", {}).get("headings", [])
    ]
    headings += [line.lstrip("# ") for line in text.splitlines() if line.startswith("#")]

    def ownership(candidate):
        position, name = candidate
        occurrences = len(re.findall(r"(?<!\w)" + re.escape(name) + r"(?!\w)", text, re.I))
        named_heading = any(
            re.search(r"(?<!\w)" + re.escape(name) + r"(?!\w)", h, re.I) for h in headings
        )
        before = text[max(0, position - 50) : position].lower()
        incidental = bool(
            re.search(
                r"(?:unlike|compared (?:with|to)|reference to|similar to|see|mentions?)\s*$", before
            )
        )
        return (named_heading, not incidental, occurrences, -position)

    return max(candidates, key=ownership)[1]


def topical_name(name):
    return (
        bool(_tokens(name) or any(char.isalpha() and not char.isascii() for char in name))
        and not _boilerplate(name)
        and not any(
            token in {"fictional", "synthetic", "fixture", "test", "qa"}
            for token in re.findall(r"\w+", name.lower())
        )
    )


def meaningful_subject(name, evidence):
    """Require a contextual noun-like subject, not an incidental sentence token.

    This applies only to automatic child folders. Project identities and manual
    folder names have separate authorities, so a project named Read is valid.
    """
    subject = name.split(" / ")[-1].strip()
    if not topical_name(subject) or len(subject.split()) > 5 or re.search(r"\d{4}|[?!]", subject):
        return False
    occurrences = 0
    for row in evidence:
        if row.get("basis") == "title":
            continue
        text = row.get("text", "")
        for match in re.finditer(r"(?<!\w)" + re.escape(subject) + r"(?!\w)", text, re.I):
            before = text[max(0, match.start() - 100):match.start()]
            after = text[match.end():match.end() + 100]
            # Introductory questions/instructions do not name a reusable subject.
            if (not before.strip(" #\n\t\"'“”") or before.endswith("\n")
                    or re.search(r"[.!?]\s*$", before)) and re.match(
                        r"\s+(?:this|these|that|those|the document|you|when|whether)\b", after, re.I):
                continue
            line = text[text.rfind("\n", 0, match.start()) + 1:text.find("\n", match.end()) if "\n" in text[match.end():] else len(text)]
            if re.match(r"\s*(?:does|do|is|are|can|could|should|would|read|see)\s", line, re.I):
                continue
            occurrences += 1
    if occurrences:
        return True
    # Descriptive compound subjects can be expressed across a sentence (an
    # employee receives an account after access approval) rather than as a
    # literal adjacent phrase. Every content word still needs support.
    words = _tokens(subject)
    if len(words) >= 2:
        return any(set(words) <= set(_tokens(row.get("text", "")))
                   for row in evidence if row.get("basis") != "title")
    return False


def descriptive_metadata(evidence):
    """Keep literal dates, security identifiers and document form out of topics."""
    values = {"dates": [], "tickers": [], "document_roles": []}
    seen = set()
    for row in evidence:
        if row.get("basis") == "title":
            continue
        text = row.get("text", "")
        headings = "\n".join(row.get("provenance", {}).get("headings", []))
        for key, pattern, source in (
            ("dates", r"\b\d{4}-\d{2}-\d{2}\b", text),
            ("tickers", r"\b(?:NYSE|NASDAQ|AMEX|TSX):\s*[A-Z][A-Z0-9.-]{0,9}\b", text),
            ("document_roles", r"\b(?:overview|decision log|research report|benchmark|runbook|plan|index)\b", headings or text.split("\n", 1)[0]),
        ):
            for match in re.finditer(pattern, source, re.I if key == "document_roles" else 0):
                value = match.group()
                if (key, value.casefold()) in seen or len(values[key]) >= 32:
                    continue
                seen.add((key, value.casefold()))
                values[key].append({"value": value, "evidence_id": row.get("evidence_id", row.get("chunk_id"))})
    return values


def _subject(texts, project):
    """Name a shared subject from content, avoiding the project and document type."""
    project_words = set(_tokens(project))
    tokens = [[w for w in _tokens(text) if w not in project_words] for text in texts]
    frequencies = Counter(w for words in tokens for w in set(words))
    phrases = Counter()
    for words in tokens:
        phrases.update(
            {" ".join(words[i : i + n]) for n in (1, 2) for i in range(len(words) - n + 1)}
        )
    threshold = 2 if len(texts) > 1 else 1
    candidates = [p for p, count in phrases.items() if count >= threshold]
    if not candidates:
        candidates = list(phrases)
    # Access is a subject; the security key/account used by the workflow is a detail.
    for modifier in ("employee", "customer", "user", "document"):
        for subject in ("access", "support", "storage", "retrieval"):
            if frequencies[modifier] >= threshold and frequencies[subject] >= threshold:
                candidates.append(modifier + " " + subject)
    roles = set(
        re.findall(r"\b([a-z]+)\s+(?:team|specialist|department)\b", " ".join(texts).lower())
    )
    named = {
        word.lower() for text in texts for word in re.findall(r"\b[A-Z][a-z]+\b", text)
    } - project_words
    named_positions = {
        word.lower(): min(
            (
                match.start()
                for text in texts
                for match in re.finditer(r"\b" + re.escape(word) + r"\b", text)
            ),
            default=100000,
        )
        for text in texts
        for word in re.findall(r"\b[A-Z][a-z]+\b", text)
        if word.lower() in named
    }
    positions = {
        word: min((words.index(word) for words in tokens if word in words), default=100000)
        for word in frequencies
    }

    def score(phrase):
        words = phrase.split()
        identity_subject = (
            len(words) == 2
            and words[0] in {"employee", "customer", "user", "document"}
            and words[1] in {"access", "support", "storage", "retrieval"}
        )
        return (
            bool(identity_subject),
            phrase in roles,
            min(frequencies[w] for w in words),
            len(words) == 1 and words[0] in named,
            -min((named_positions.get(w, 100000) for w in words), default=100000),
            -min((positions.get(w, 100000) for w in words), default=100000),
            sum(frequencies[w] for w in words) / len(words),
            -len(words),
        )

    best = (
        min(set(candidates), key=lambda p: (*[-float(v) for v in score(p)], p))
        if candidates
        else ""
    )
    return best[:1].upper() + best[1:]


# Fixed feature and centroid budgets avoid document-by-vocabulary dense matrices
# and pairwise clustering. These bounds apply even to a wholly unscoped library.
FEATURE_BUDGET = 8192
TOPIC_BUDGET = 128
LABEL_SAMPLE = 24


def project_catalog(profiles, folders=()):
    """Only non-OCR evidence establishes aliases for uncertain OCR project names."""
    return ProjectNames(
        {
            scope
            for rows in profiles.values()
            if (trusted := [r for r in rows if r.get("basis") != "ocr"])
            if (scope := project_scope(trusted))
        }
        | {name.split(" / ")[0] for name in folders if " / " in name}
    )


def _topic_features(text, scope):
    scope_words = set(_tokens(scope))
    words = [w for w in _tokens(text) if w not in scope_words]
    features = words + [" ".join(words[i : i + 2]) for i in range(len(words) - 1)]
    named = {
        token for word in re.findall(r"\b[A-Z][a-z]+\b", text) for token in _tokens(word)
    } - scope_words
    named.update(re.findall(r"\b([a-z]+)\s+(?:team|specialist|department)\b", text.lower()))
    features.extend(word for word in words if word in named for _ in range(5))
    return features


def _topic_clusters(documents, scope):
    """Sparse online assignment for small scopes; bounded minibatches for large ones."""
    if len(documents) == 1:
        return [0]
    import numpy as np
    from scipy.sparse import vstack
    from sklearn.cluster import MiniBatchKMeans
    from sklearn.feature_extraction.text import HashingVectorizer
    from sklearn.preprocessing import normalize

    matrix = HashingVectorizer(
        analyzer=lambda text: _topic_features(text, scope),
        n_features=FEATURE_BUDGET,
        alternate_sign=False,
        dtype=np.float32,
    ).transform(text for _, text in documents)
    if len(documents) > TOPIC_BUDGET:
        # Only this fixed-size centroid array is dense (at most 4 MiB).
        model = MiniBatchKMeans(
            n_clusters=TOPIC_BUDGET,
            random_state=0,
            n_init=1,
            batch_size=1024,
            max_iter=10,
            reassignment_ratio=0,
            init_size=TOPIC_BUDGET * 3,
        )
        return model.fit_predict(matrix)
    centers, labels = [], []
    for row in matrix:
        if centers:
            scores = (row @ normalize(vstack(centers)).T).toarray()[0]
            best = int(scores.argmax())
        else:
            best, scores = 0, np.array([])
        if scores.size and scores[best] >= 0.18:
            centers[best] = centers[best] + row
        else:
            best = len(centers)
            centers.append(row)
        labels.append(best)
    return labels


def prose_paths(profiles, common_lines=()):
    """Build shared subjects with sparse features and a fixed per-scope topic budget."""
    known = project_catalog(profiles)
    scoped = {}
    for identity, rows in profiles.items():
        text = "\n".join(r["text"] for r in representative_evidence(rows, common_lines, limit=12))
        if text and not topic_paths(rows, known):
            scope = project_scope(rows, known)
            scoped.setdefault(scope, []).append((identity, text))
    result = {}
    for scope, documents in sorted(scoped.items()):
        documents.sort(key=lambda item: (item[1], item[0]))
        clusters = {}
        labels = _CORPUS.get_or_compute(
            dependency_key("organization-clusters", policy=ANALYSIS_POLICY, scope=scope,
                           documents=documents, feature_budget=FEATURE_BUDGET, topic_budget=TOPIC_BUDGET),
            lambda: tuple(int(label) for label in _topic_clusters(documents, scope)),
        )
        for item, cluster in zip(documents, labels):
            clusters.setdefault(int(cluster), []).append(item)
        isolated = [members[0] for members in clusters.values() if len(members) == 1]
        shared_terms = Counter(
            word for _, text in isolated for word in set(_tokens(text)) - set(_tokens(scope))
        )
        shared_subject = (
            _subject([text for _, text in isolated[:LABEL_SAMPLE]], scope)
            if isolated and any(count >= len(isolated) for count in shared_terms.values())
            else ""
        )
        for members in clusters.values():
            # A single isolated detail is not evidence for a useful child topic.
            # The shared project parent remains meaningful without inventing a label.
            if scope and len(members) == 1 and len(isolated) > 1:
                result[members[0][0]] = f"{scope} / {shared_subject}" if shared_subject else scope
                continue
            # Naming has a fixed sample budget too; it must not rescan a whole
            # large cluster once for every capitalized token.
            subject = _subject([text for _, text in members[:LABEL_SAMPLE]], scope)
            if subject:
                folder = f"{scope} / {subject}" if scope else subject
                result.update((identity, folder) for identity, _ in members)
    return result


def common_lines(profiles):
    """Find repeated opening/closing notices once per rebuild."""
    sentences = Counter()
    for rows in profiles.values():
        parts = [part for row in rows for part in _sentences(row.get("text", ""))]
        if len(parts) > 1:
            sentences.update({parts[0].casefold(), parts[-1].casefold()})
    return sorted(part for part, count in sentences.items() if count >= max(3, len(profiles) // 4))


def shared_vocabulary(profiles, folders=(), groups=(), *, common=None, generated=None):
    """Prepare shared project/subject names before individual Jev membership decisions."""
    common = common_lines(profiles) if common is None else common
    generated = prose_paths(profiles, common) if generated is None else generated
    known = project_catalog(profiles, folders)
    paths = {p for rows in profiles.values() for p in topic_paths(rows, known)}
    paths.update(generated.values())
    paths.update(name for name in folders if topical_name(name))
    return {
        "folders": sorted(paths),
        "groups": sorted(name for name in set(groups) if topical_name(name)),
    }, common


def rank_names(names, evidence, limit=12, scope_required=True, accepted_project=None):
    known = sorted({name.split(" / ")[0] for name in names if " / " in name})
    paths = {p.casefold() for p in topic_paths(evidence, known)}
    scope = accepted_project if accepted_project is not None else project_scope(evidence, known)
    text = " ".join(clean_text(r.get("text", "")) for r in evidence).lower()
    tokens = Counter(_tokens(text))
    names = {n for n in names if topical_name(n.split(" / ")[-1])}
    if scope:
        # Existing subjects may be reused, but another project's folder is not a candidate.
        names = {
            n
            for n in names
            if n.casefold() == scope.casefold()
            or n.casefold().startswith(scope.casefold() + " / ")
            or (not scope_required and " / " not in n)
        }
    elif scope_required:
        # Unknown scope is not permission to choose another company's folder.
        names = {n for n in names if " / " not in n}

    def score(name):
        words = (
            [word for word in _tokens(name) if word not in set(_tokens(scope))]
            if scope
            else _tokens(name)
        )
        coverage = sum(w in tokens for w in words) / max(1, len(words))
        return (
            name.casefold() in paths,
            coverage,
            name.lower() in text,
            sum(min(tokens[w], 3) for w in words) / max(1, len(words)),
        )

    return sorted(names, key=lambda n: (*[-float(v) for v in score(n)], n.casefold()))[:limit]


def embedding_candidates(data_dir, profiles, vocabulary, common_lines=(), generated=None):
    """Stream existing vectors, then compare only a bounded set of scoped prototypes."""
    import numpy as np
    from symbiknow.search.index import INDEX_LOCK, _table

    known = project_catalog(profiles, vocabulary["folders"])
    profiles = {
        identity: representative_evidence(rows, common_lines, limit=12)
        for identity, rows in profiles.items()
    }
    owners = {r["evidence_id"]: identity for identity, rows in profiles.items() for r in rows}
    centers = {}
    with INDEX_LOCK:
        chunks = _table(data_dir, "chunks")
        if chunks is not None:
            for batch in (
                chunks.search()
                .where("active = true")
                .select(["chunk_id", "vector", "embedding_model"])
                .limit(max(1, chunks.count_rows()))
                .to_batches(batch_size=256)
            ):
                vectors = batch.column("vector")
                matrix = vectors.flatten().to_numpy(zero_copy_only=False).reshape(batch.num_rows, -1)
                chunk_ids = batch.column("chunk_id").to_pylist()
                models = batch.column("embedding_model").to_pylist()
                for offset, (chunk_id, model) in enumerate(zip(chunk_ids, models)):
                    identity = owners.get(chunk_id)
                    if identity is not None:
                        key = (identity, model)
                        if key in centers:
                            centers[key] += matrix[offset]
                        else:
                            centers[key] = matrix[offset].astype(np.float32, copy=True)
    del owners
    for center in centers.values():
        norm = np.linalg.norm(center)
        if norm:
            center /= norm
    if generated is None:
        generated = prose_paths(profiles, common_lines)
    prototypes, counts = {}, Counter()
    for (identity, model), center in centers.items():
        for path in [
            *topic_paths(profiles[identity], known),
            *([generated[identity]] if identity in generated else []),
        ]:
            key = (path, model)
            counts[path] += 1
            if key in prototypes:
                prototypes[key] += center
            else:
                prototypes[key] = center.copy()
    for prototype in prototypes.values():
        norm = np.linalg.norm(prototype)
        if norm:
            prototype /= norm
    by_scope = {}
    for path in vocabulary["folders"]:
        scope = path.split(" / ")[0] if " / " in path else ""
        by_scope.setdefault(scope, []).append(path)
    by_scope = {
        scope: sorted(set(paths), key=lambda path: (-counts[path], path))[:TOPIC_BUDGET]
        for scope, paths in by_scope.items()
    }
    by_identity = {}
    for (identity, model), center in centers.items():
        by_identity.setdefault(identity, []).append((model, center))
    result = {}
    for identity, evidence in profiles.items():
        scope = project_scope(evidence, known)
        paths = by_scope.get(scope, [])
        scores = {}
        for model, center in by_identity.get(identity, []):
            for path in paths:
                prototype = prototypes.get((path, model))
                if prototype is not None:
                    scores[path] = float(center @ prototype)
        semantic = sorted(scores, key=lambda p: (-scores[p], p))[:6]
        result[identity] = list(
            dict.fromkeys(
                [
                    *topic_paths(evidence, known),
                    *([generated[identity]] if identity in generated else []),
                    *rank_names(semantic, evidence, 6),
                    *rank_names(paths, evidence, 6),
                ]
            )
        )[:12]
    return result
