"""Version-pinned organization publications, independent of evidence/vector tables.

Lance merge_insert commits one organization table version. The fsynced manifest is
its only publication point. Readers checkout that immutable version on a distinct
handle. Leases protect active readers during bounded retention cleanup. A journal
rolls back unpublished Lance commits and discards unfinished generation tables;
an already switched manifest completes publication on restart.
"""
from functools import lru_cache
import json
from pathlib import Path
import uuid
import weakref
import re

import pyarrow as pa

from symbiknow.core.cache import CoalescingCache, dependency_key

_LIVE = weakref.WeakValueDictionary()
_MANIFEST_CACHE = CoalescingCache(max_entries=8, max_bytes=16 * 1024**2, max_inflight=4)

FIELDS = ["document_id", "version", "evidence_revision", "folder", "groups", "links_json", "organization_status", "organization_json", "evidence_dependencies_json"]
SCHEMA = pa.schema([(name, pa.list_(pa.string()) if name == "groups" else pa.string()) for name in FIELDS])


def _path(root, name):
    return Path(root) / "temp" / ("organization-" + name + ".json")


def manifest(root):
    file = _path(root, "published")
    if not file.exists():
        return None
    stamp = file.stat()
    key = dependency_key("organization-manifest", library=str(Path(root).resolve()),
                         inode=stamp.st_ino, modified=stamp.st_mtime_ns, size=stamp.st_size)
    # Private immutable-by-contract snapshot. Public roster access returns copies.
    return _MANIFEST_CACHE.get_or_compute(key, lambda: json.loads(file.read_text()))


def revision(root):
    from symbiknow.organization.edits import summary
    value = manifest(root)
    return ((value or {}).get("revision", ""), summary(root).get("revision", ""))


@lru_cache(maxsize=8)
def _pinned(root, name, version):
    from symbiknow.search.index import _db
    table = _db(root).open_table(name)
    table.checkout(version)
    _LIVE[(root, name, version)] = table
    return table


def published_table(root):
    value = manifest(root)
    return _pinned(str(Path(root).resolve()), value.get("table", "organization"), value["version"]) if value else None


def initialize(root):
    """Narrow data-boundary upgrade from the existing organization columns."""
    from symbiknow.search.index import _db, _table
    from symbiknow.organization.edits import atomic
    current = manifest(root)
    if current:
        if current.get("evidence_schema") == 1:
            return
        table = _db(root).open_table(current.get("table", "organization"))
        if table.version != current["version"]:
            table.restore(current["version"])
        missing = {name: "cast('{}' as string)" if name == "evidence_dependencies_json" else "cast('' as string)"
                   for name in ("evidence_revision", "evidence_dependencies_json") if name not in table.schema.names}
        if missing:
            table.add_columns(missing)
            atomic(_path(root, "published"), {**current, "version": table.version, "evidence_schema": 1})
        elif current.get("evidence_schema") != 1:
            atomic(_path(root, "published"), {**current, "version": table.version, "evidence_schema": 1})
        return
    db = _db(root)
    try:
        db.drop_table("organization")  # An unpublished initial write is disposable.
    except (FileNotFoundError, ValueError):
        pass
    source = _table(root, "documents")
    if source is None:
        table = db.create_table("organization", schema=SCHEMA)
    else:
        selected = [field for field in FIELDS if field in source.schema.names]
        source_batches = source.search().select(selected).limit(max(1, source.count_rows())).to_batches(batch_size=256)
        def batches():
            for batch in source_batches:
                for field in FIELDS:
                    if field not in batch.schema.names:
                        default = "{}" if field == "evidence_dependencies_json" else ""
                        batch = batch.append_column(field, pa.array([default] * batch.num_rows, type=SCHEMA.field(field).type))
                yield batch.select(FIELDS).cast(SCHEMA)
        table = db.create_table("organization", data=pa.RecordBatchReader.from_batches(SCHEMA, batches()))
    atomic(_path(root, "published"), {"schema": 2, "evidence_schema": 1, "table": "organization", "version": table.version,
                                         "revision": str(uuid.uuid4()), "catalog": _catalog_reference(root, {}, {})})


def recover(root, *, prepared=True):
    from symbiknow.search.index import INDEX_LOCK, _db
    with INDEX_LOCK:
        initialize(root)
        if prepared:
            for file in (Path(root) / "temp" / "organization-staging").glob("*/publication.json"):
                pending = json.loads(file.read_text())["prepared"]
                if pending.get("table") != manifest(root).get("table", "organization"):
                    try:
                        _db(root).drop_table(pending["table"])
                    except (FileNotFoundError, ValueError):
                        pass
                file.unlink(missing_ok=True)
            job_path = Path(root) / "temp" / "organization-rebuild.json"
            if job_path.exists():
                job = json.loads(job_path.read_text())
                if job.get("status") in {"completed", "partial_failure"}:
                    cleanup_staging(root, job["request_id"])
        journal = _path(root, "publication")
        if not journal.exists():
            return
        event = json.loads(journal.read_text())
        current = manifest(root)
        if event.get("reset") is not None and event.get("prepared") is not None:
            # Both the immutable Lance version and catalog are durable. Finish
            # the same boundary after a crash, rather than exposing old folders
            # after removing their manual assignments.
            if current["revision"] not in {event["base"]["revision"], event["revision"]}:
                raise RuntimeError("Organization reset publication conflicts with a later revision")
            from symbiknow.organization.edits import reset_expected, atomic
            reset_expected(root, event["reset"]["assignments"], event["reset"]["request_id"])
            atomic(_path(root, "published"), event["prepared"])
            journal.unlink(missing_ok=True)
            return
        if current["revision"] != event["revision"]:
            table = _db(root).open_table(current.get("table", "organization"))
            if table.version != current["version"]:
                table.restore(current["version"])
        journal.unlink(missing_ok=True)


def publish(root, rows, *, remove=(), reset=None):
    """Caller validates original/evidence dependencies under the final snapshot."""
    from symbiknow.search.index import INDEX_LOCK, _db
    from symbiknow.organization.edits import atomic
    with INDEX_LOCK:
        recover(root, prepared=False)
        current = manifest(root)
        table = _db(root).open_table(current.get("table", "organization"))
        # Any orphan commit left by an interrupted caller is excluded first.
        if table.version != current["version"]:
            table.restore(current["version"])
        token = str(uuid.uuid4())
        existing_projects = catalog(root, current)
        projects = {}
        atomic(_path(root, "publication"), {"schema": 1, "base": current, "revision": token})
        if remove:
            from symbiknow.search.index import _literal
            table.delete("document_id IN (" + ",".join(_literal(identity) for identity in remove) + ")")
        def batches():
            from itertools import islice
            iterator = iter(rows)
            while batch := list(islice(iterator, 256)):
                for row in batch:
                    project = json.loads(row["organization_json"]).get("canonical_project")
                    if project and existing_projects.by_id.get(project["id"]) != project:
                        projects[project["id"]] = project
                yield pa.RecordBatch.from_pylist(
                    [{field: row.get(field, "{}" if field == "evidence_dependencies_json" else "") for field in FIELDS} for row in batch], schema=SCHEMA)
        table.merge_insert("document_id").when_matched_update_all().when_not_matched_insert_all().execute(
            pa.RecordBatchReader.from_batches(SCHEMA, batches())
        )
        reset_catalog = reset is not None and reset.get("catalog_reset", False)
        catalog_updates = {**(reset.get("projects", {}) if reset_catalog else {}), **projects}
        prepared = {"schema": 2, "evidence_schema": 1, "table": current.get("table", "organization"),
                                           "version": table.version, "revision": token,
                                           "publications": current.get("publications", 0) + 1,
                                           "catalog": _catalog_reference(root, current, catalog_updates, replace=reset_catalog)}
        if current.get("reset_request"):
            prepared["reset_request"] = current["reset_request"]
        if reset is not None:
            prepared["reset_request"] = reset["request_id"]
            atomic(_path(root, "publication"), {"schema": 1, "base": current, "revision": token,
                                                "prepared": prepared, "reset": {
                                                    "request_id": reset["request_id"], "assignments": reset["assignments"]}})
            from symbiknow.organization.edits import reset_expected
            reset_expected(root, reset["assignments"], reset["request_id"])
        atomic(_path(root, "published"), prepared)
        _path(root, "publication").unlink(missing_ok=True)
        if (current.get("publications", 0) + 1) % 32 == 0:
            prune(root)
        return token


def overlay(root, rows, columns=None):
    """Bind source and neighbor evidence epochs before applying manual placement."""
    from symbiknow.search.index import _literal, _table
    from symbiknow.organization.edits import overrides
    binding = {"document_id", "version", "evidence_revision", "evidence_dependencies_json"}
    fields = [name for name in FIELDS if name not in binding and (columns is None or name in columns)]
    table = published_table(root) if fields else None
    found, dependencies = {}, {}
    if rows and table is not None:
        condition = "document_id IN (" + ",".join(_literal(row["document_id"]) for row in rows) + ")"
        selected = ["document_id", "version", *fields]
        selected += [name for name in ("evidence_revision", "evidence_dependencies_json") if name in table.schema.names]
        found = {row["document_id"]: row for row in table.search().where(condition)
                 .select(selected).limit(len(rows)).to_list()}
        dependencies = {identity: json.loads(row.get("evidence_dependencies_json", "{}")) for identity, row in found.items()}
    wanted = sorted({identity for values in dependencies.values() for identity in values})
    epochs = {}
    if wanted:
        from symbiknow.library.storage import heads_many
        source = _table(root, "documents")
        if source is not None:
            for offset in range(0, len(wanted), 800):
                batch = wanted[offset:offset + 800]
                from symbiknow.search.metrics import add
                add("organization_dependency_head_checks", len(batch))
                add("organization_dependency_head_batches", 1)
                heads = heads_many(root, batch)
                condition = "document_id IN (" + ",".join(_literal(identity) for identity in batch) + ")"
                epochs.update({row["document_id"]: row["evidence_revision"] for row in source.search().where(condition)
                               .select(["document_id", "version", "indexed_version", "status", "evidence_revision"])
                               .limit(800).to_list() if row["status"] == "indexed"
                               and row["version"] == row["indexed_version"] == heads.get(row["document_id"])})
    manual_rows = overrides(root, (row["document_id"] for row in rows)) if "folder" in fields or "organization_json" in fields else {}
    result = []
    for source in rows:
        row = dict(source)
        derived = found.get(row["document_id"])
        valid = (derived and derived["version"] == row["version"]
                 and derived.get("evidence_revision", "") == row.get("evidence_revision", "")
                 and all(epochs.get(identity) == expected for identity, expected in dependencies.get(row["document_id"], {}).items()))
        if valid:
            row.update({name: derived[name] for name in fields})
            if columns is None:
                row["evidence_dependencies_json"] = derived.get("evidence_dependencies_json", "{}")
        elif table is not None:
            defaults = {"folder": "", "groups": [], "links_json": "[]",
                        "organization_json": "{}", "organization_status": "pending"}
            row.update({name: defaults[name] for name in fields})
            if columns is None:
                row["evidence_dependencies_json"] = "{}"
        if "folder" in fields or "organization_json" in fields:
            manual = manual_rows.get(row["document_id"])
            if manual:
                if "folder" in fields:
                    row["folder"] = manual["folder"]
                if "organization_json" in fields:
                    decision = json.loads(row.get("organization_json", "{}"))
                    row["organization_json"] = json.dumps({**decision, "folder": manual["folder"], "origin": "manual"})
        result.append(row)
    return result


_SCOPE_CACHE = CoalescingCache(max_entries=64, max_bytes=8 * 1024**2, max_inflight=4)


def scope_condition(root, folder=None, group=None):
    from symbiknow.search.index import revisions
    from symbiknow.library.storage import source_revision
    key = dependency_key("organization-scope", library=str(Path(root).resolve()),
                         revision=revisions(root), source_revision=source_revision(root), folder=folder, group=group)
    return _SCOPE_CACHE.get_or_compute(key, lambda: _scope_condition(root, folder, group))


def _scope_condition(root, folder=None, group=None):
    """Indexed candidate selection followed by exact version/manual validation.

    A named folder or group selects organization metadata first. Unfiled includes
    new sources absent from the published table and therefore scans source metadata
    in bounded batches. Evidence text and vectors are never read or copied.
    """
    from symbiknow.search.index import _table, _literal, folder_condition
    from symbiknow.organization.edits import assignment_ids
    source = _table(root, "documents")
    if source is None:
        return "false"
    organization = published_table(root) or source
    selected = None
    if folder or group is not None:
        conditions = []
        if folder is not None:
            conditions.append(folder_condition(folder))
        if group is not None:
            conditions.append(f"array_contains(groups, {_literal(group)})")
        selected = {row["document_id"] for batch in organization.search().where(" AND ".join(conditions) or "true")
                    .select(["document_id"]).limit(max(1, organization.count_rows())).to_batches(batch_size=512)
                    for row in batch.to_pylist()}
        selected.update(assignment_ids(root))
    identities = []
    ordered = sorted(selected) if selected is not None else []
    queries = [source.search()] if selected is None else [
        source.search().where("document_id IN (" + ",".join(_literal(i) for i in ordered[offset:offset + 800]) + ")")
        for offset in range(0, len(ordered), 800)
    ]
    for query in queries:
        for batch in query.select(["document_id", "version", "evidence_revision", "folder", "groups"]).limit(max(1, source.count_rows())).to_batches(batch_size=512):
            for row in overlay(root, batch.to_pylist(), columns=["folder", "groups"]):
                placed = row["folder"]
                if folder is not None and not (placed == folder or (folder and placed.startswith(folder + " / "))):
                    continue
                if group is not None and group not in row["groups"]:
                    continue
                identities.append(row["document_id"])
    return "document_id IN (" + ",".join(_literal(i) for i in identities) + ")" if identities else "false"


def _staged_path(root, generation, identity):
    import hashlib
    return Path(root) / "temp" / "organization-staging" / generation / (hashlib.sha256(identity.encode()).hexdigest() + ".json")


def staged_document(root, generation, identity):
    file = _staged_path(root, generation, identity)
    return json.loads(file.read_text()) if file.exists() else None


def discard_staged_document(root, generation, identity):
    _staged_path(root, generation, identity).unlink(missing_ok=True)


def stage(root, generation, identity, version, decision, evidence=(), neighbors=(), *, outcome=None):
    from symbiknow.organization.edits import atomic
    dependencies = [{"document_id": identity, "version": str(version), "evidence": list(evidence)}]
    dependencies.extend({"document_id": row["document_id"], "version": row["version"],
                         "evidence": row.get("evidence", [])} for row in neighbors)
    atomic(_staged_path(root, generation, identity),
           {"document_id": identity, "version": str(version), "decision": decision,
            "dependencies": dependencies, **({"outcome": outcome} if outcome is not None else {})})


def staged(root, generation):
    folder = Path(root) / "temp" / "organization-staging" / generation
    for file in sorted(folder.glob("*.json")):
        if file.name != "publication.json":
            yield json.loads(file.read_text())


def prepare_generation(root, generation, rows, base):
    """Build a complete organization-only table without changing readers' manifest."""
    from symbiknow.search.index import _db
    from symbiknow.organization.edits import atomic
    name = "organization_" + uuid.uuid4().hex
    db = _db(root)
    journal = Path(root) / "temp" / "organization-staging" / generation / "publication.json"
    if journal.exists():
        previous = json.loads(journal.read_text())["prepared"]["table"]
        live_names = {name for library, name, version in list(_LIVE) if library == str(Path(root).resolve())}
        if previous != manifest(root).get("table", "organization") and previous not in live_names:
            try:
                db.drop_table(previous)
            except (FileNotFoundError, ValueError):
                pass
    atomic(journal, {"schema": 1, "base": base, "prepared": {"table": name, "version": None}})
    source = _pinned(str(Path(root).resolve()), base.get("table", "organization"), base["version"])
    batches = source.search().select(FIELDS).limit(max(1, source.count_rows())).to_batches(batch_size=256)
    table = db.create_table(name, data=pa.RecordBatchReader.from_batches(SCHEMA, batches))
    existing_projects = catalog(root, base)
    projects = {}
    def organization_batches():
        for batch in rows:
            for value in batch.column("organization_json").to_pylist():
                project = json.loads(value).get("canonical_project")
                if project and existing_projects.by_id.get(project["id"]) != project:
                    projects[project["id"]] = project
            yield batch
    table.merge_insert("document_id").when_matched_update_all().when_not_matched_insert_all().execute(
        pa.RecordBatchReader.from_batches(SCHEMA, organization_batches()))
    from lancedb.index import BTree, LabelList
    table.create_index("document_id", config=BTree())
    table.create_index("folder", config=BTree())
    table.create_index("groups", config=LabelList())
    prepared = {"schema": 2, "evidence_schema": 1, "table": name, "version": table.version, "revision": str(uuid.uuid4()),
                "catalog": _catalog_reference(root, base, projects, journal=journal)}
    if base.get("reset_request"):
        prepared["reset_request"] = base["reset_request"]
    atomic(Path(root) / "temp" / "organization-staging" / generation / "publication.json",
           {"schema": 1, "base": base, "prepared": prepared})
    return prepared


def switch_generation(root, generation, base, prepared):
    """The final caller already holds the validated source/index snapshot."""
    from symbiknow.organization.edits import atomic
    if manifest(root) != base:
        from symbiknow.search.index import IndexChangedError
        raise IndexChangedError("Organization changed while preparing publication")
    atomic(_path(root, "published"), prepared)
    (Path(root) / "temp" / "organization-staging" / generation / "publication.json").unlink(missing_ok=True)


def prune(root):
    """Release unleased organization tables and versions older than live readers.

    Cached pinned handles count as leases (at most eight). External references
    remain weakly tracked until released. No evidence/vector table is touched.
    """
    from datetime import datetime, timezone, timedelta
    from symbiknow.search.index import INDEX_LOCK, _db
    from symbiknow.organization.edits import atomic
    root = str(Path(root).resolve())
    with INDEX_LOCK:
        current = manifest(root)
        if not current:
            return
        selected = current.get("table", "organization")
        live = list(_LIVE)
        names = {name for library, name, version in live if library == root}
        names.add(selected)
        catalogs = {current.get("catalog")}
        catalogs.update(reference for library, reference in list(_CATALOG_LIVE) if library == root)
        for file in (Path(root) / "temp" / "organization-staging").glob("*/publication.json"):
            pending = json.loads(file.read_text())
            names.add(pending["prepared"]["table"])
            catalogs.update([pending.get("base", {}).get("catalog"), pending["prepared"].get("catalog")])
        for file in (Path(root) / "temp" / "organization-catalogs").glob("*.json"):
            if file.name not in catalogs:
                file.unlink(missing_ok=True)
        db = _db(root)
        cursor = None
        while True:
            page = db.list_tables(page_token=cursor, limit=100)
            for name in page.tables:
                if (name == "organization" or re.fullmatch(r"organization_[0-9a-f]{32}", name)) and name not in names:
                    db.drop_table(name)
            cursor = page.page_token
            if not cursor:
                break
        table = db.open_table(selected)
        protected = {version for library, name, version in live if library == root and name == selected}
        protected.add(current["version"])
        versions = table.list_versions()
        timestamps = [entry["timestamp"] for entry in versions if entry["version"] in protected]
        if timestamps and len(versions) > len(protected) + 8:
            age = datetime.now(timezone.utc).replace(tzinfo=None) - min(timestamps) + timedelta(seconds=1)
            table.optimize(cleanup_older_than=max(age, timedelta(seconds=1)))
            # Compaction preserves data; select its new immutable version without
            # changing the semantic organization revision or cursor dependencies.
            atomic(_path(root, "published"), {**current, "version": table.version})


def cleanup_staging(root, generation):
    """Terminal progress is durable before disposable prepared evidence is removed."""
    import shutil
    if Path(generation).name != generation:
        raise ValueError("Invalid organization generation identity")
    shutil.rmtree(Path(root) / "temp" / "organization-staging" / generation, ignore_errors=True)


class _FrozenDict(dict):
    __slots__ = ()
    def _immutable(self, *args, **kwargs):
        raise TypeError("Published catalog records are immutable")
    __setitem__ = __delitem__ = clear = pop = popitem = setdefault = update = __ior__ = _immutable
    def __deepcopy__(self, memo):
        import copy
        return {key: copy.deepcopy(value, memo) for key, value in self.items()}


class _FrozenList(list):
    __slots__ = ()
    def _immutable(self, *args, **kwargs):
        raise TypeError("Published catalog records are immutable")
    __setitem__ = __delitem__ = append = extend = insert = pop = remove = reverse = sort = clear = __iadd__ = __imul__ = _immutable
    def __deepcopy__(self, memo):
        import copy
        return [copy.deepcopy(value, memo) for value in self]


def _freeze(value):
    if isinstance(value, dict):
        return _FrozenDict({key: _freeze(item) for key, item in value.items()})
    if isinstance(value, list):
        return _FrozenList(_freeze(item) for item in value)
    return value


class ProjectCatalog(_FrozenList):
    """One immutable roster with exact-name/identity preprocessing per revision."""
    def __init__(self, projects):
        from types import MappingProxyType
        from symbiknow.organization.policy import ProjectNames
        from symbiknow.organization.matcher import ProjectMatcher
        list.__init__(self, (_freeze(project) for project in projects))
        names, canonical = {}, {}
        for project in self:
            for name in [project["name"], *project.get("aliases", [])]:
                key = name.casefold()
                names.setdefault(key, project)
                canonical[key] = project["name"]
        identities = {project["id"]: project for project in self}
        self.lookup = MappingProxyType(names)
        self.by_id = MappingProxyType(identities)
        self.canonical_names = MappingProxyType(canonical)
        self.names = ProjectNames(canonical.values())
        self.matcher = ProjectMatcher(canonical)
        self.owned_indexes = (names, identities, canonical, self.names, self.names.lookup, self.matcher.owned_indexes)


_CATALOG_CACHE = CoalescingCache(max_entries=4, max_bytes=128 * 1024**2, max_inflight=4)
_CATALOG_LIVE = weakref.WeakValueDictionary()


def catalog(root, publication=None):
    current = publication if publication is not None else manifest(root)
    reference = (current or {}).get("catalog")
    if reference:
        if Path(reference).name != reference:
            raise ValueError("Invalid organization catalog reference")
        key = dependency_key("organization-catalog", library=str(Path(root).resolve()), reference=reference)
        def load():
            value = ProjectCatalog(json.loads((Path(root) / "temp" / "organization-catalogs" / reference).read_text())["projects"])
            return value, value.owned_indexes
        value = _CATALOG_CACHE.get_or_compute(key, load)[0]
        _CATALOG_LIVE[(str(Path(root).resolve()), reference)] = value
        return value
    # Only the upgrade boundary consumes the earlier inline roster/ledger.
    projects = (current or {}).get("projects")
    if projects is None:
        file = Path(root) / "temp" / "canonical-projects.json"
        projects = json.loads(file.read_text()).get("projects", []) if file.exists() else []
    return ProjectCatalog(projects)


def _catalog_reference(root, base, updates, *, journal=None, replace=False):
    from symbiknow.organization.edits import atomic
    if not replace and not updates and base.get("catalog"):
        return base["catalog"]
    records = {} if replace else dict(catalog(root, base).by_id)
    records.update(updates)
    reference = uuid.uuid4().hex + ".json"
    if journal is not None:
        pending = json.loads(journal.read_text())
        pending["prepared"]["catalog"] = reference
        atomic(journal, pending)
    atomic(Path(root) / "temp" / "organization-catalogs" / reference,
           {"schema": 1, "projects": list(records.values())})
    return reference
