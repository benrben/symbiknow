"""Canonical immutable identities crossing application service boundaries.

Derived records are never proof of a current original. Revision tokens describe
the protected snapshot in which originals and derived evidence were validated.
"""

from dataclasses import dataclass
from typing import Protocol, Mapping, Any
from types import MappingProxyType


@dataclass(frozen=True, slots=True)
class DocumentReference:
    document_id: str
    version: str


@dataclass(frozen=True, slots=True)
class EvidenceReference:
    document: DocumentReference
    evidence_id: str
    digest: str


@dataclass(frozen=True, slots=True)
class ProcessingDescriptor:
    converter: str
    extraction_schema: str
    tokenizer: str
    chunking_policy: str
    model: str


@dataclass(frozen=True, slots=True)
class RevisionToken:
    library_id: str
    index: str
    organization: str
    snapshot: str


def freeze_json(value):
    if isinstance(value, Mapping):
        return MappingProxyType({key: freeze_json(item) for key, item in value.items()})
    if isinstance(value, (tuple, list)):
        return tuple(freeze_json(item) for item in value)
    if value is None or isinstance(value, (str, bool, int, float)):
        return value
    raise TypeError("Domain results must contain JSON primitives")


def _project(value):
    if isinstance(value, Mapping):
        return {key: _project(item) for key, item in value.items()}
    if isinstance(value, tuple):
        return [_project(item) for item in value]
    return value


@dataclass(frozen=True, slots=True)
class DomainResult:
    """Owned immutable publication; each transport gets a private wire projection."""

    payload: Mapping[str, Any]

    def __post_init__(self):
        object.__setattr__(self, "payload", freeze_json(self.payload))

    def to_wire(self) -> dict[str, Any]:
        return _project(self.payload)


class OriginalRepository(Protocol):
    def heads_many(self, document_ids: list[str]) -> Mapping[str, str | None]: ...
    def metadata_many(self, document_ids: list[str]) -> Mapping[str, Mapping[str, Any] | None]: ...
    def metadata(self, document_id: str, version: str | None = None) -> Mapping[str, Any]: ...
    def verified_file(self, document_id: str, version: str | None = None): ...
    def commit(self, content, filename: str, **metadata) -> Mapping[str, Any]: ...
    def history_page(self, document_id: str, **page) -> Mapping[str, Any]: ...
    def delete(self, document_id: str, expected_version: str) -> None: ...


class IndexRepository(Protocol):
    def document_statuses(self, document_ids: list[str]) -> Mapping[str, Mapping[str, Any]]: ...
    def resolve_evidence_many(self, references: list[tuple[str, str, str]]) -> Mapping: ...
