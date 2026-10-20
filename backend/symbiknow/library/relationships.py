"""Canonical presentation keys without changing stored link evidence or direction."""


def relationship_key(link):
    endpoints = (
        (link["source_document_id"], link["source_version"]),
        (link["document_id"], link["version"]),
    )
    if link["relation"] in {"related", "duplicate"}:
        endpoints = tuple(sorted(endpoints))
    return link["relation"], endpoints


def unique_relationships(links):
    selected = {}
    # Prefer a stable, actually stored orientation and keep its evidence IDs intact.
    for link in sorted(
        links,
        key=lambda item: (
            item["source_document_id"],
            item["source_version"],
            item["document_id"],
            item["version"],
            item.get("source_chunk_id", ""),
            item.get("target_chunk_id", ""),
        ),
    ):
        selected.setdefault(relationship_key(link), link)
    return list(selected.values())
