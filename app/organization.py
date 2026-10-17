"""Content-derived organization candidates and representative, versioned evidence."""

import re
from collections import Counter


class ProjectNames(tuple):
    """Reusable exact-name lookup, so recognition never scans every project per document."""

    def __new__(cls, names):
        result = super().__new__(cls, sorted(set(names)))
        result.lookup = {name.casefold(): name for name in reversed(result)}
        result.max_words = max((len(name.split()) for name in result), default=0)
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
                and all(p and len(p) <= 60 and len(p.split()) <= 4 for p in prefix)
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


def heading_projects(evidence):
    """Explicit product names in root titles, including lowercase product names."""
    names = set()
    for row in evidence:
        headings = row.get("provenance", {}).get("headings", [])
        if not headings:
            continue
        title = re.fullmatch(
            r"(.{1,60}?)\s+(?:plan|decisions|status|architecture|documentation|handbook|overview|readme)",
            headings[0].strip(), re.I,
        )
        if title:
            name = title[1]
            words = re.findall(r"[^\W\d_]+", name.lower())
            if words and len(words) <= 4 and not any(w in GENERIC | {"validation", "ui", "user"} for w in words):
                names.add(name)
    return names


def project_candidates(evidence, folders=(), projects=(), limit=16):
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
    # A generated topic vocabulary is not a registry of accepted projects.
    canonical = {f.split(" / ")[0].casefold(): f.split(" / ")[0] for f in (folders if not projects else ())
                 if any(c.isalpha() for c in f.split(" / ")[0])
                 and not any(word in generic for word in re.findall(r"[^\W\d_]+", f.split(" / ")[0].casefold()))}
    for project in projects:
        for name in [project["name"], *project.get("aliases", [])]:
            canonical[name.casefold()] = project["name"]
    known = ProjectNames(canonical.values())
    text = "\n".join(r.get("text", "") for r in evidence if r.get("basis") != "title")
    headings = "\n".join(h for r in evidence for h in r.get("provenance", {}).get("headings", []))
    context = text + "\n" + headings
    hinted = {name for alias, name in canonical.items()
              if any(re.search(r"(?<!\w)" + re.escape(alias) + r"(?!\w)", r.get("text", ""), re.I)
                     for r in evidence if r.get("basis") == "title")}
    grounded = {
        name for alias, name in canonical.items()
        if re.search(r"(?<!\w)" + re.escape(alias) + r"(?!\w)", context, re.I)
    }
    # Prefixes in headings such as Product / Search or Product MCP protocol are
    # subjects of a known product, unless independently registered as an owner.
    ocr_only = bool(evidence) and all(r.get("basis") in {"ocr", "title"} for r in evidence)
    def normalize(name):
        name = _canonical_root(name, known, ocr=ocr_only)
        if name.casefold() in canonical:
            return canonical[name.casefold()]
        for alias in sorted(canonical, key=lambda a: (-len(a), a)):
            if name.casefold().startswith(alias + " "):
                suffix = name[len(alias):].strip().lower().split()
                if suffix and all(word in {"mcp", "api", "sdk", "protocol", "search", "storage", "interface"} for word in suffix):
                    return canonical[alias]
        return name

    def plausible(name):
        words = re.findall(r"[^\W\d_]+", name.lower())
        return bool(words) and not any(w in generic for w in words)

    paths = {normalize(path.split(" / ")[0]) for path in topic_paths(evidence, known)}
    grounded = {name for name in grounded if name in paths or not any(
        path.casefold().startswith(name.casefold() + " ") for path in paths
    )}
    hypothesis = normalize(project_scope(evidence, known))
    new = {name for name in paths | {hypothesis} if name and plausible(name)}
    new.update(normalize(name) for name in heading_projects(evidence) if plausible(name))
    # An explicit comparison names another possible owner even when it is not
    # registered yet. Keep it for Jev to reject; topic vocabulary is not enough.
    for match in re.finditer(r"\b(?:[Uu]nlike|[Cc]ompared (?:to|with)) ([A-Z][\w-]*(?: [A-Z][\w-]*)*)", context):
        name = normalize(match[1])
        if plausible(name):
            new.add(name)
    # Scan sentence subjects only when no known identity is grounded. This keeps
    # discovery of new projects without promoting every capitalized UI label.
    if not grounded:
        for sentence in _sentences(text):
            name = normalize(project_scope([{"text": sentence}], known))
            if name and plausible(name):
                new.add(name)
    return sorted(grounded | hinted | new, key=lambda name: (
        name not in grounded, name not in hinted, name not in paths, name != hypothesis, name.casefold()
    ))[:limit]


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

    for project in projects:
        if name.casefold() in {
            n.casefold() for n in [project["name"], *project.get("aliases", [])]
        }:
            return project
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


def project_scope(evidence, known=()):
    """Prefer explicit project headings, then the first named entity in substantive prose."""
    known = known if isinstance(known, ProjectNames) else ProjectNames(known)
    paths = topic_paths(evidence, known)
    if paths:
        return paths[0].split(" / ")[0]
    explicit_names = heading_projects(evidence)
    if len(explicit_names) == 1:
        return _canonical_root(next(iter(explicit_names)), known)
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
        for item, cluster in zip(documents, _topic_clusters(documents, scope)):
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
    from .search import INDEX_LOCK, _table

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
                for row in batch.to_pylist():
                    identity = owners.get(row["chunk_id"])
                    if identity is not None:
                        key = (identity, row["embedding_model"])
                        vector = np.asarray(row["vector"], dtype=np.float32)
                        if key in centers:
                            centers[key] += vector
                        else:
                            centers[key] = vector
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
