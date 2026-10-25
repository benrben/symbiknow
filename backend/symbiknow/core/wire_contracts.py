"""Canonical HTTP/MCP response shapes and generated browser contracts.

Optional keys describe bounded projections; extra provider/domain fields may be
present. These schemas document transport results without making derived records
an authority for original versions. Run scripts/contracts/generate.py after edits.
"""
from typing import Any, Literal, NotRequired, TypedDict, get_type_hints

from symbiknow.core.contracts import DocumentReference

IdentityFields = TypedDict("IdentityFields", get_type_hints(DocumentReference))


class PageLocation(TypedDict, total=False):
    page_no: int


class Provenance(TypedDict, total=False):
    page: int
    pages: list[PageLocation]
    headings: list[str]


class Evidence(TypedDict):
    evidence_id: str
    text: str
    basis: str
    provenance: Provenance


class NumericSource(TypedDict):
    document_id: str
    version: str
    chunk_id: str
    quote: str
    start: int
    end: int


class NumericContext(TypedDict):
    document_id: str
    version: str
    chunk_id: str


class Calculation(TypedDict):
    source_value: str
    source_unit: str
    factor_numerator: int
    factor_denominator: int


class NumericValue(TypedDict):
    value: str
    unit: str
    display: str
    source: NumericSource
    context_sources: list[NumericContext]
    calculation: Calculation | None


class SearchAnswer(TypedDict):
    status: str
    reason: NotRequired[str]
    candidate_count: NotRequired[int]
    evaluated_count: NotRequired[int]
    withheld_count: NotRequired[int]
    values: NotRequired[list[NumericValue]]


class StoredLink(TypedDict):
    document_id: str
    version: str
    source_version: str
    relation: str
    source_chunk_id: str
    target_chunk_id: str
    reviewed_by: NotRequired[str]
    reviewed_at: NotRequired[str]
    decision_id: NotRequired[str]
    correction_id: NotRequired[str]
    confidence: NotRequired[float]
    reason: NotRequired[str]
    proof: NotRequired[dict[str, Any]]
    additional_evidence: NotRequired[list[dict[str, Any]]]


class Link(StoredLink):
    source_document_id: str
    source_filename: str
    target_filename: str


class JudgedEvidence(TypedDict):
    chunk_id: str
    text: str
    text_start: NotRequired[int]
    text_end: NotRequired[int]
    truncated: NotRequired[bool]
    original_text_length: NotRequired[int]
    location: NotRequired[Provenance]


class VerificationDependency(TypedDict):
    document_id: str
    version: str
    chunk_id: str
    sha256: str
    text_start: int
    text_end: int
    truncated: NotRequired[bool]
    original_text_length: NotRequired[int]
    evidence_revision: NotRequired[str]


class JevDecision(TypedDict):
    status: str
    label: NotRequired[str]
    model_label: NotRequired[str]
    model_confidence: NotRequired[float]
    confidence_meaning: NotRequired[str]
    policy_label: NotRequired[str]
    decision_reason: NotRequired[str]
    policy_version: NotRequired[str]
    prompt_version: NotRequired[str]
    basis: NotRequired[list[str] | str]
    supporting_chunk_ids: NotRequired[list[str]]
    conflicting_chunk_ids: NotRequired[list[str]]
    possible_conflicting_chunk_ids: NotRequired[list[str]]
    coverage: NotRequired[str]
    evidence_presence: NotRequired[str]
    conflict_status: NotRequired[str]
    premise_correction_status: NotRequired[str]
    evidence_disagreement: NotRequired[str]
    disagreement_chunk_ids: NotRequired[list[str]]
    disagreement_scope: NotRequired[str]
    cross_document_assessment_status: NotRequired[str]
    possible_conflict_reasons: NotRequired[dict[str, str]]
    evaluated_evidence: NotRequired[list[JudgedEvidence]]
    verification_dependencies: NotRequired[list[VerificationDependency]]
    explanation: NotRequired[str]


class Doc(IdentityFields):
    freshness_labels: NotRequired[list[str]]
    evidence_revision: NotRequired[str]
    filename: str
    mime_type: str
    folder: NotRequired[str]
    groups: NotRequired[list[str]]
    status: NotRequired[str]
    organization_status: NotRequired[str]
    size: NotRequired[int]
    created_at: NotRequired[str]
    index_error: NotRequired[str]
    evidence: NotRequired[list[Evidence]]
    excerpt: NotRequired[str]
    links: NotRequired[list[StoredLink]]
    jev: NotRequired[JevDecision]


class OrganizationReset(TypedDict):
    revision: str
    scope: str | None


RenamedPaths = TypedDict("RenamedPaths", {"from": str, "to": str})


class OrganizationChange(TypedDict):
    all_documents: NotRequired[bool]
    kind: str
    paths: NotRequired[RenamedPaths | None]
    document_ids: list[str]


class Library(TypedDict):
    next_cursor: NotRequired[str | None]
    taxonomy_has_more: NotRequired[bool]
    taxonomy_next_after: NotRequired[str | None]
    organization_reset: NotRequired[OrganizationReset]
    manual_revision: NotRequired[str]
    library_id: NotRequired[str]
    library_total: NotRequired[int]
    unfiled_review_count: NotRequired[int]
    processing_states: NotRequired[dict[str, int]]
    organization_change: NotRequired[OrganizationChange | None]
    organization_revision: NotRequired[str]
    index_revision: NotRequired[str]
    documents: list[Doc]
    total: int
    has_more: bool
    folders: dict[str, int]
    scoped_folders: NotRequired[dict[str, int]]
    groups: list[str]
    processing: bool
    max_file_bytes: int
    max_chunk_bytes: int
    offset: NotRequired[int]
    revision: NotRequired[list[str]]
    rebuild_progress: NotRequired["Rebuild | None"]


class HistoryWindow(TypedDict):
    total: int
    head: str
    offset: int
    has_more: bool


class VersionsPage(HistoryWindow):
    versions: list[Doc]


class Detail(TypedDict):
    indexing_error: NotRequired[str]
    organization_review: NotRequired[dict[str, Any] | None]
    document: Doc
    current_version: str
    organization: Doc | None
    evidence: list[Evidence]
    connections: list[Link]
    versions: list[Doc]
    versions_page: NotRequired[HistoryWindow | None]


class FreshnessEvidence(TypedDict):
    id: str
    document_id: str
    version: str
    filename: str
    evidence_revision: str
    evidence_id: str
    text: str
    start: int
    end: int
    sha256: str
    position: int
    provenance: Provenance


class FreshnessJudgment(TypedDict):
    choice: str
    confidence: float
    probabilities: dict[str, float]


class FreshnessDecision(TypedDict):
    scope: str
    relation: str
    confidence: NotRequired[float]
    uncertain: NotRequired[bool]
    judgments: NotRequired[dict[str, FreshnessJudgment]]
    used_judgments: NotRequired[list[str]]


class FreshnessFinding(TypedDict):
    scan_id: str
    finding_id: str
    category: str
    label: str
    affected_document_id: str | None
    evidence: list[FreshnessEvidence]
    decision: FreshnessDecision
    reason: str
    reference_document_ids: list[str]
    checked_at: str
    model: str
    policy: str
    context_complete: bool
    review: str
    revision: int
    validity: str
    review_note: NotRequired[str]


class FreshnessScan(TypedDict):
    scan_id: str
    status: str
    revision: int
    created_at: str
    checked_at: str
    document_ids: list[str] | None
    reference_document_ids: list[str]
    model: str
    policy: str
    documents_total: int
    documents_read: int
    passages_read: int
    passages_classified: int
    passages_matched: int
    pairs_total: int
    pairs_checked: int
    findings_total: int
    gaps: dict[str, int]
    usage: dict[str, float]
    current_filename: str
    coverage_changed: NotRequired[bool]
    error: NotRequired[str]
    completed_at: NotRequired[str]


class FreshnessScanSummary(TypedDict):
    scan_id: str
    created_at: str
    status: str


class FreshnessPage(TypedDict):
    scan: FreshnessScan | None
    findings: list[FreshnessFinding]
    has_more: bool
    next_after: str
    recent_scans: list[FreshnessScanSummary]


class RebuildDetail(TypedDict):
    document_id: str
    filename: str
    outcome: str
    reason: str


class Rebuild(TypedDict):
    mode: NotRequired[Literal["reset", "unfiled", "links"]]
    current_filename: NotRequired[str]
    activity: NotRequired[str]
    phase: NotRequired[str]
    layout_revision: NotRequired[str]
    layout_scope: NotRequired[str | None]
    status: str
    request_id: str
    total: int
    completed: int
    failed: int
    skipped: int
    grouped: NotRequired[int | None]
    unfiled: NotRequired[int | None]
    links_added: NotRequired[int | None]
    details: list[RebuildDetail]
    failures: dict[str, str]
    folder: str | None
    grouping: bool
    links: bool


class CardPreview(TypedDict):
    evidence: list[Evidence]
    table: NotRequired[list[list[str]]]


class Evaluation(TypedDict):
    status: str
    error: NotRequired[str]


class IndexingProgress(TypedDict):
    processing: bool
    queued_uploads: int
    retry_documents: int


class SearchResponse(TypedDict):
    matches: list[Doc]
    status: NotRequired[str]
    evaluation: Evaluation
    answer: NotRequired[SearchAnswer]
    continue_search: NotRequired[str | None]
    indexing: NotRequired[IndexingProgress]


class LinkEvidence(TypedDict):
    source: list[Evidence]
    target: list[Evidence]
    link: NotRequired[Link]


class OrganizationDecision(TypedDict):
    id: str
    kind: Literal["folder", "connection"]
    document_id: str
    version: str
    evidence_revision: str
    filename: str
    suggested: str
    options: list[str]
    current: str
    reason: str
    excerpt: str
    evidence_ids: list[str]
    target_document_id: NotRequired[str]
    target_version: NotRequired[str]
    target_evidence_revision: NotRequired[str]
    target_filename: NotRequired[str]
    target_excerpt: NotRequired[str]
    source_chunk_id: NotRequired[str]
    target_chunk_id: NotRequired[str]


class JevDecisionQueue(TypedDict):
    revision: NotRequired[str]
    next_cursor: NotRequired[str | None]
    next_after: NotRequired[str]
    decisions: list[OrganizationDecision]
    has_more: bool


class AgentProvider(TypedDict):
    id: str
    name: str
    installed: bool
    available: bool
    version: str
    reason: str
    untested: bool


class AgentModel(TypedDict):
    id: str
    name: str
    description: str
    default: bool
    efforts: list[str]
    default_effort: str


class AgentSession(TypedDict):
    session_id: str
    token: str
    provider: str
    model: str
    model_name: str
    effort: str


class AgentEvent(TypedDict):
    type: str
    session_id: str
    run_id: str
    seq: int
    timestamp: NotRequired[int]
    automatic: NotRequired[bool]
    model: NotRequired[str]
    id: NotRequired[str]
    name: NotRequired[str]
    kind: NotRequired[str]
    text: NotRequired[str]
    message: NotRequired[str]
    status: NotRequired[str]
    args: NotRequired[dict[str, Any]]
    preview: NotRequired[dict[str, Any]]
    result: NotRequired[Any]
    ok: NotRequired[bool]
    expires_at: NotRequired[int]


class JobResponse(TypedDict):
    job_id: str
    status: Literal["queued", "running", "completed", "failed"]
    result: NotRequired[dict[str, Any] | None]
    error: NotRequired[str | None]
    next_cursor: NotRequired[str | None]


class InventoryProject(TypedDict):
    id: str
    name: str


class InventoryDocument(TypedDict):
    document_id: str
    version: str
    filename: str
    mime_type: str
    size: int
    sha256: str
    created_at: str
    source_filename: str
    stored: bool
    storage_status: str
    indexing_status: str
    searchable: bool
    searchable_text: bool
    searchable_visual: bool
    indexing_error: str
    project: InventoryProject | None
    folder: str
    topics: list[str]
    groups: list[str]
    organization_status: str
    evidence_revision: str
    folder_origin: str


class InventoryPage(TypedDict):
    documents: list[InventoryDocument]
    count: int
    total_originals: int
    total: NotRequired[int]
    revision: str
    has_more: bool
    next_cursor: str | None
    filters: dict[str, str | None]
    scope: str


class TaxonomyFacet(TypedDict):
    dimension: Literal["projects", "folders", "topics", "statuses"]
    id: str
    name: str
    count: int
    definition: str | None


class TaxonomyPage(TypedDict):
    items: list[TaxonomyFacet]
    revision: str
    has_more: bool
    next_cursor: str | None
    semantics: dict[str, str]


class OrganizationHistoryEntry(TypedDict):
    id: str
    kind: str
    action: str
    actor: str | None
    timestamp: str | None
    reason: str | None
    version: str | None
    document_id: str
    evidence_revision: NotRequired[str | None]
    value: NotRequired[Any]
    effective_owner: NotRequired[InventoryProject | None]
    automatic_owner_suggestion: NotRequired[InventoryProject | None]
    target_document_id: NotRequired[str]
    target_version: NotRequired[str]


class OrganizationHistoryPage(TypedDict):
    document_id: str
    current: dict[str, Any]
    entries: list[OrganizationHistoryEntry]
    revision: str
    has_more: bool
    next_cursor: str | None
    limitations: list[str]


class RecoverableJob(TypedDict):
    job_id: str
    status: str
    created_at: str
    kind: str
    error: str | None


class RecoverableJobPage(TypedDict):
    jobs: list[RecoverableJob]
    revision: str
    has_more: bool
    next_cursor: str | None
    scope: str
