"""Likely stored credentials; such text is never sent to the hosted judge.

Local storage, indexing and retrieval are unchanged. Whole documents are
withheld rather than redacted: redaction would break the exact-text and
sha256 evidence contracts that every published judgment depends on.

Detection rules are adapted from jevgrep ``packages/core/src/secrets.ts``:

    MIT License. Copyright (c) 2026 David Zhang.

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE.

Two independent signals: a distinctive provider key prefix followed by key
material, or a credential-named assignment whose value looks real. Library
text is prose as well as code, so two adaptations apply: an assignment value
must be one token (``Password: must be 12 characters`` is policy, not a
secret), and each physical line is also scanned on its own, because prose
apostrophes would otherwise join unrelated lines into one quoted value.
"""

import hashlib
import math
import re
import threading

from symbiknow.core.cache import ByteLRU

_KNOWN_PREFIXES = (
    "sk-live-", "sk_test_", "sk_live_", "sk-ant-", "npm_", "pypi-", "hf_", "dop_v1_",
    "sq0csp-", "sq0atp-", "ya29.", "SG.", "sk-", "ghp_", "gho_", "ghu_", "ghs_",
    "github_pat_", "glpat-", "xoxb-", "xoxp-", "xoxa-", "xoxr-", "AKIA", "ASIA", "AIza",
    "tvly-", "dsk-", "rk_live_", "whsec_",
)
# Longest prefix first so sk-live- wins over sk- at the same position; the
# lookbehind keeps sk- from firing inside a longer word such as disk-.
_PREFIX_PATTERNS = [
    re.compile(rf"(?<![A-Za-z0-9_]){re.escape(prefix)}([A-Za-z0-9_\-]{{16,}})")
    for prefix in sorted(_KNOWN_PREFIXES, key=len, reverse=True)
]
_SLACK_WEBHOOK = re.compile(r"hooks\.slack\.com/services/[A-Za-z0-9_\-/]{24,}")
_PRIVATE_KEY = re.compile(r"-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----")
# Bare token/pwd/credential are too noisy alone (getToken(), tokenizers).
_KEY_NAME = re.compile(
    r"(?:^|[^a-z0-9])(?:api[_-]?key|client[_-]?secret|passwd|password|private[_-]?key|secret|"
    r"auth[_-]?token|access[_-]?token|api[_-]?token|bearer[_-]?token)(?:[^a-z]|$)",
    re.I,
)
_ASSIGNMENT = re.compile(
    r"^\s*(?:(?:const|let|var|export|default|public|private|protected|static|readonly|final)\s+)*"
    r"[\"']?([^\"'=\s:]+)[\"']?\s*[:=]\s*"
)
_PLACEHOLDER = re.compile(
    r"^(?:your|example|test|fake|dummy|sample|changeme|placeholder|redacted|masked|todo|fixme|"
    r"none|null|undefined|nil|tbd)[\w-]*$|^x+$|^<.*>$|^\*+$|^\$\{[^}]*\}$|^\{\{[^}]*\}\}$",
    re.I | re.A,
)
_UUID = re.compile(r"^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$", re.I)
_REFERENCE = re.compile(
    r"^(?:process|import\.meta|env|config|settings|secrets)(?:\.[A-Za-z_$][\w$]*)+$", re.A
)
_LONG_TOKEN_RUN = re.compile(r"[A-Za-z0-9_\-+=/]{32,}")
_MIN_SECRET_LENGTH = 16
_MIN_SECRET_ENTROPY = 3.5
_QUOTES = "\"'`"
# Verdicts by text digest: entry filters and the final request guard rescan the
# same passages, and a digest key never retains the scanned text itself.
_VERDICTS = ByteLRU(max_entries=8192, max_bytes=2 * 1024**2)
_VERDICTS_LOCK = threading.Lock()


def _entropy(value):
    counts = {}
    for char in value:
        counts[char] = counts.get(char, 0) + 1
    return -sum(n / len(value) * math.log2(n / len(value)) for n in counts.values())


def _placeholder_tail(tail):
    lower = tail.lower()
    return bool(re.search(r"xxx|example|placeholder|redacted|masked", lower)) or len(set(lower)) == 1


def _secret_token(line):
    # A placeholder suppresses shorter prefixes at the same position: sk- must
    # not re-fire inside an already-redacted sk-live-XXXX.
    placeholders = set()
    for pattern in _PREFIX_PATTERNS:
        for match in pattern.finditer(line):
            # npm exposes package metadata as npm_package_* names, not tokens.
            if match[0].lower().startswith("npm_package_") or match.start() in placeholders:
                continue
            if not _placeholder_tail(match[1]):
                return match[0]
            placeholders.add(match.start())
    return None


def _clean_value(raw):
    value = re.sub(r"[,;\s]+$", "", raw.strip()).strip()
    if value.endswith("}") and not value.startswith(("${", "{{")):
        value = value[:-1].strip()
    if len(value) < 2 or value[0] not in _QUOTES:
        return value
    i = 1
    while i < len(value):
        if value[i] == "\\":
            i += 2
            continue
        if value[i] == value[0]:
            return value[1:i].strip()
        i += 1
    return value


def _assignments(line):
    """Assignment-shaped expressions outside quoted strings on one logical line."""
    found, quote, index = [], None, 0
    while index < len(line):
        char = line[index]
        if quote is not None:
            if char == "\\":
                index += 1
            elif char == quote:
                quote = None
        elif char in _QUOTES:
            quote = char
        elif index == 0 or char in "{,;":
            candidate = line[index if index == 0 else index + 1:]
            match = _ASSIGNMENT.match(candidate)
            if match:
                found.append((match[1], candidate[match.end():]))
        index += 1
    return found


def _unclosed_quote(raw):
    text = raw.strip()
    if not text or text[0] not in _QUOTES:
        return False
    i = 1
    while i < len(text):
        if text[i] == "\\":
            i += 2
            continue
        if text[i] == text[0]:
            return False
        i += 1
    return True


def _secret_value(value):
    if len(value) < _MIN_SECRET_LENGTH or not value or _PLACEHOLDER.search(value):
        return False
    if re.search(r"\s", value) or _REFERENCE.search(value) or _UUID.search(value):
        return False
    return (_secret_token(value) is not None or bool(_LONG_TOKEN_RUN.search(value))
            or _entropy(value) >= _MIN_SECRET_ENTROPY)


def _logical_lines(source):
    """Quote-aware lines: multi-line quoted values stay one unit; # and // start
    comments only outside quotes, and // after : is a URL scheme."""
    lines, current, quote = [], "", None
    for physical in source.split("\n"):
        stripped, i = "", 0
        while i < len(physical):
            char = physical[i]
            if quote is not None:
                if char == "\\" and i + 1 < len(physical):
                    stripped += physical[i:i + 2]
                    i += 2
                    continue
                if char == quote:
                    quote = None
            elif char in _QUOTES:
                quote = char
            elif char == "#" or (char == "/" and physical[i + 1:i + 2] == "/"
                                 and physical[i - 1:i] != ":"):
                break
            stripped += char
            i += 1
        current += ("\n" if current else "") + stripped
        if quote is None:
            lines.append(current)
            current = ""
    if current:
        lines.append(current)
    return lines


def _scan(lines):
    for line in lines:
        trimmed = line.strip()
        if not trimmed or trimmed.startswith(("#", "//")):
            continue
        if _secret_token(trimmed) is not None or _SLACK_WEBHOOK.search(trimmed):
            return True
        for key, raw in _assignments(trimmed):
            if _KEY_NAME.search(key) and (_unclosed_quote(raw) or _secret_value(_clean_value(raw))):
                return True
    return False


def contains_likely_secret(text):
    """True when the text looks like it stores a usable credential."""
    if not isinstance(text, str) or not text:
        return False
    key = hashlib.sha256(text.encode("utf-8", "surrogatepass")).digest()
    with _VERDICTS_LOCK:
        if key in _VERDICTS:
            return _VERDICTS[key]
    found = bool(_PRIVATE_KEY.search(text)) or _scan(_logical_lines(text)) or any(
        _scan(_logical_lines(line)) for line in text.split("\n"))
    with _VERDICTS_LOCK:
        _VERDICTS[key] = found
    return found


def strings(value):
    """Every string inside a JSON-like request value, keys included."""
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for key, item in value.items():
            yield from strings(key)
            yield from strings(item)
    elif isinstance(value, (list, tuple, set)):
        for item in value:
            yield from strings(item)
