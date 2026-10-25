"""Bounded grep over extracted passages, with no shell or filesystem operands."""
from __future__ import annotations

import shlex
import subprocess

MAX_BYTES = 32 * 1024 * 1024
MAX_ROWS = 20_000
MAX_LINES = 250_000


def parse_command(command: str) -> list[str]:
    if len(command) > 2048:
        raise ValueError("Grep command is too long (maximum 2048 characters)")
    try:
        tokens = shlex.split(command)
    except ValueError as exc:
        raise ValueError("Check the quotes in your grep command") from exc
    if not tokens or tokens.pop(0) != "grep":
        raise ValueError('Use a grep command, for example: grep -in "cache"')
    flags, patterns = [], []
    positional = False
    while tokens:
        token = tokens.pop(0)
        if token == "--" and not positional:
            positional = True
        elif token == "-e" and not positional:
            if not tokens:
                raise ValueError("The -e option needs a pattern")
            patterns.append(tokens.pop(0))
        elif token.startswith("-") and not positional:
            if len(token) < 2 or any(c not in "iFEwxvn" for c in token[1:]):
                raise ValueError("Supported grep options: -i, -F, -E, -w, -x, -v, -n and -e")
            flags.extend("-" + c for c in token[1:] if c != "n")
        elif not patterns:
            patterns.append(token)
            positional = True
        else:
            raise ValueError("Grep searches the selected scope; file paths and shell operators are not supported")
    if not patterns or any(not pattern or "\n" in pattern or "\x00" in pattern for pattern in patterns):
        raise ValueError("Provide a nonempty, single-line grep pattern")
    if "-F" in flags and "-E" in flags:
        raise ValueError("Choose either -F (literal) or -E (regular expression)")
    return ["/usr/bin/grep", "-a", "-n", *flags, *(part for pattern in patterns for part in ("-e", pattern))]


def matching_rows(command: str, batches, limit: int):
    """Stream bounded passage batches; only the result window stays in memory.

    Called by the durable search worker. A large corpus costs worker time but
    never enlarges a request's memory or holds the index publication lock.
    """
    argv = parse_command(command)
    output, counts = [], {}
    for batch in batches:
        rows, lines, owners = [], [], []
        for row in batch.to_pylist():
            rows.append(row)
            chunk_lines = (row.get("text") or "").splitlines()
            lines.extend(chunk_lines)
            owners.extend([len(rows) - 1] * len(chunk_lines))
        if not lines:
            continue
        try:
            result = subprocess.run(argv, input="\n".join(lines) + "\n", capture_output=True,
                                    text=True, encoding="utf-8", errors="replace", timeout=3,
                                    check=False)
        except subprocess.TimeoutExpired as exc:
            raise ValueError("Grep took too long; simplify the pattern") from exc
        if result.returncode not in (0, 1):
            raise ValueError("Invalid grep pattern; check the expression and flags")
        indexes = {owners[int(line.split(":", 1)[0]) - 1]
                   for line in result.stdout.splitlines() if line.split(":", 1)[0].isdigit()}
        for index in sorted(indexes):
            row = rows[index]
            identity = row["document_id"]
            if counts.get(identity, 0) >= 8:
                continue
            counts[identity] = counts.get(identity, 0) + 1
            output.append(row)
            if len(output) >= min(limit * 8, 800):
                return output
    return output
