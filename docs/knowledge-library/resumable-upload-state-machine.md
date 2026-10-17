# Symbiknow / Storage / Resumable upload state machine

Repository implementation guide. Snapshot: 12 October 2026.

## Persistent transfer identity
A chunked upload sends filename, source/MIME, request_id, total_size, lowercase SHA-256 and offset. The server stores an identity manifest and a .part file under data/temp. Later chunks must agree with the original identity.

## Receive and replay
An offset beyond received bytes is rejected with the expected offset. A replay inside the existing file must contain identical bytes. A new chunk appends, flushes and fsyncs before reporting received_bytes. Empty nonterminal data cannot make progress.

A non-final result says receiving and stored=false. final=true requires the full declared size and hash. Only then does the owner commit an OCFL version, register/schedule it, save the completed receipt and remove the part file.

## Client rule
Keep the same request ID, total size, hash and metadata throughout the transfer. Retry a lost response rather than starting a second object. The client helper uses bounded chunks and checks per-item errors. After completion, download the pinned version and verify the reconstructed full hash.

## Failure boundary
A partially received file is not a stored original. A completed transfer receipt can be replayed without another content version. Current code stages the complete file before native commit; a chunked protocol does not imply zero whole-file buffering or a proven large-file memory budget.

## Source references
- `app/server.py`
- `client.py`
- `tests/test_mcp.py`

This guide describes the checked implementation and its stated limits, not a separately certified external specification.
