def put_chunks(data_dir, metadata, rows, model_id):
    """Idempotent replacement of derived chunks, never a storage version commit."""
    if isinstance(rows, list):
        if not rows:
            return
        dimension = len(rows[0]["vector"])
        schema = chunk_schema(dimension)
        batches = (
            pa.Table.from_pylist(
                rows[start : start + 64], schema=pa.schema(list(schema)[:1] + list(schema)[3:7])
            )
            for start in range(0, len(rows), 64)
        )
    else:
        dimension = rows.schema.field("vector").type.list_size
        schema = chunk_schema(dimension)
        batches = rows
    with INDEX_LOCK:
        table = _table(data_dir, "chunks", schema)
        if table.schema.field("vector").type.list_size != dimension:
            raise ValueError("Index embedding dimensions differ; rebuild the derived index")
        where = f"document_id = {_literal(metadata['document_id'])}"
        table.delete(where)
        for batch in batches:
            batch = pa.Table.from_batches([batch]) if isinstance(batch, pa.RecordBatch) else batch
            values = {
                "document_id": metadata["document_id"],
                "version": str(metadata["version"]),
                "embedding_model": model_id,
                "active": False,
                "folder": "",
                "groups": [],
            }
            for key, value in values.items():
                batch = batch.append_column(
                    key, pa.array([value] * batch.num_rows, type=schema.field(key).type)
                )
            table.add(batch.select(schema.names).cast(schema))
        if not any(index.index_type == "FTS" for index in table.list_indices()):
            from lancedb.index import FTS

            table.create_index("text", config=FTS())
        # All batches are durable before activation. Status publication still gates search.
        table.update(where=where, values={"active": True})
