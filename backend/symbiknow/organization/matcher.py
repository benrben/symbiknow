"""Reusable exact multi-pattern recognition with Python re.I/Unicode boundaries.

Aliases are already casefolded by the catalog policy. Matching must still use
regex simple case equivalence (not casefold expansion of evidence text): e.g.
the alias ``strasse`` does not match ``Straße`` under the prior re.I policy.
The pinned CPython regex tables provide the same single-codepoint equivalence
classes as re.I, including dotted/dotless I and Greek sigma variants.
"""
from array import array
from bisect import bisect_left
from collections import deque
from functools import lru_cache
import _sre
from re._casefix import _EXTRA_CASES


@lru_cache(maxsize=4096)
def _character(char):
    lower = _sre.unicode_tolower(ord(char))
    return min((lower, *_EXTRA_CASES.get(lower, ())))


def _word(char):
    return char == "_" or char.isalnum()


class ProjectMatcher:
    """Aho-Corasick automaton over compact sorted Unicode transitions.

    Failure output links retain overlapping/suffix aliases without copying their
    output lists into every state. Corpus size does not affect per-document
    traversal. Owned storage is exposed solely for the catalog's byte accounting.
    """
    __slots__ = ("_starts", "_labels", "_targets", "_fail", "_output", "_terminal_starts",
                 "_lengths", "_name_ids", "_names", "_empty", "owned_indexes")

    def __init__(self, canonical):
        edges, terminal, empty = [{}], {}, set()
        for alias, name in canonical.items():
            if not alias:
                empty.add(name)
                continue
            state = 0
            for char in alias:
                char = _character(char)
                child = edges[state].get(char)
                if child is None:
                    child = len(edges)
                    edges[state][char] = child
                    edges.append({})
                state = child
            terminal.setdefault(state, []).append((len(alias), name))
        fail, output = array("I", [0]) * len(edges), array("i", [-1]) * len(edges)
        queue = deque(edges[0].values())
        while queue:
            state = queue.popleft()
            fallback = fail[state]
            output[state] = fallback if fallback in terminal else output[fallback]
            for char, child in edges[state].items():
                queue.append(child)
                candidate = fallback
                while candidate and char not in edges[candidate]:
                    candidate = fail[candidate]
                fail[child] = edges[candidate].get(char, 0)
        # Dict-per-state tries can exceed the retained catalog budget at 100k
        # owners. Flatten transitions and outputs into fixed-width arrays;
        # construction dictionaries are released before catalog publication.
        starts, labels, targets = array("I", [0]), array("I"), array("I")
        terminal_starts, lengths, name_ids = array("I", [0]), array("I"), array("I")
        names, identities = [], {}
        for state, transitions in enumerate(edges):
            for char, target in sorted(transitions.items()):
                labels.append(char)
                targets.append(target)
            starts.append(len(labels))
            for length, name in terminal.get(state, ()):
                identity = identities.get(name)
                if identity is None:
                    identity = len(names)
                    identities[name] = identity
                    names.append(name)
                lengths.append(length)
                name_ids.append(identity)
            terminal_starts.append(len(lengths))
        self._starts, self._labels, self._targets = starts, labels, targets
        self._fail, self._output = fail, output
        self._terminal_starts, self._lengths, self._name_ids = terminal_starts, lengths, name_ids
        self._names, self._empty = tuple(names), empty
        self.owned_indexes = (starts, labels, targets, fail, output, terminal_starts, lengths, name_ids, self._names, empty)

    def _step(self, state, char):
        end = self._starts[state + 1]
        found = bisect_left(self._labels, char, self._starts[state], end)
        return self._targets[found] if found < end and self._labels[found] == char else None

    def find(self, text):
        found, state = set(), 0
        for end, char in enumerate(text):
            char = _character(char)
            next_state = self._step(state, char)
            while state and next_state is None:
                state = self._fail[state]
                next_state = self._step(state, char)
            state = next_state or 0
            # The regex lookahead is independent of alias spelling/case.
            if end + 1 < len(text) and _word(text[end + 1]):
                continue
            matched = state
            while matched != -1:
                for index in range(self._terminal_starts[matched], self._terminal_starts[matched + 1]):
                    start = end + 1 - self._lengths[index]
                    if start == 0 or not _word(text[start - 1]):
                        found.add(self._names[self._name_ids[index]])
                matched = self._output[matched]
        if self._empty:
            # Preserve even a malformed legacy empty alias's zero-width policy.
            import re
            if re.search(r"(?<!\w)(?!\w)", text):
                found.update(self._empty)
        return found
