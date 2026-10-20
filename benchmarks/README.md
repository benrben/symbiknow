# Symbiknow measurement runners

These runners use isolated fixtures. Write generated reports to ignored `artifacts/`.

Detailed commands, reuse boundaries, and measurement limits live in the MCP guide
**Symbiknow — Reuse work and evaluate performance claims**:
`b5e0fd9b-e705-5880-a514-5e8b57cd3fcc`.
Retrieve it using the instructions in [AGENTS.md](../AGENTS.md).

For local discovery without MCP, run `.venv/bin/python benchmarks/probes/paired.py --help`
and read the selected runner. Historical `baselines/` describe their capture conditions;
they do not establish performance of the current worktree.
