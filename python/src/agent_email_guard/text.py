"""Address and text normalization.

ASCII-only on purpose: Unicode case folding differs between runtimes, and the
conformance vectors must give the same answer in every language port.
"""

from __future__ import annotations

import re
from typing import Any, Iterable, List, Mapping, Optional, Set

#: How much normalized body text the similarity comparison reads.
BODY_COMPARE_CHARS = 4096

_UPPER = re.compile(r"[A-Z]")
_WS = " \t\n\r\f\v"
_ANGLE = re.compile(r"<([^<>]*)>[ \t\n\r\f\v]*$")
_NON_ALNUM = re.compile(r"[^a-z0-9]+")


def ascii_lower(s: str) -> str:
    """Lowercase A-Z only."""
    return _UPPER.sub(lambda m: chr(ord(m.group(0)) + 32), s)


def ascii_trim(s: str) -> str:
    """Trim space, tab, newline, carriage return, form feed and vertical tab."""
    return s.strip(_WS)


def normalize_address(raw: str) -> str:
    """The part inside <...> when present, trimmed and ASCII-lowercased."""
    s = ascii_trim(raw)
    m = _ANGLE.search(s)
    if m:
        s = m.group(1)
    return ascii_lower(ascii_trim(s))


def address_list(field: Any) -> List[str]:
    """Every address in a To/Cc/Bcc field, normalized, in order, duplicates dropped.

    A string splits on commas; a mapping or object reads ``address`` then ``email``.
    """
    if field is None:
        return []
    items: Iterable[Any] = field if isinstance(field, (list, tuple)) else [field]
    out: List[str] = []
    seen: Set[str] = set()
    for item in items:
        if isinstance(item, str):
            parts = item.split(",")
        else:
            value: Optional[Any]
            if isinstance(item, Mapping):
                value = item.get("address") if isinstance(item.get("address"), str) else item.get("email")
            else:
                address = getattr(item, "address", None)
                value = address if isinstance(address, str) else getattr(item, "email", None)
            parts = [value if isinstance(value, str) else ""]
        for part in parts:
            a = normalize_address(part)
            if a == "" or a in seen:
                continue
            seen.add(a)
            out.append(a)
    return out


def normalize_text(text: str) -> str:
    """ASCII-lowercase; every run outside [a-z0-9] becomes one space; trimmed."""
    return _NON_ALNUM.sub(" ", ascii_lower(text)).strip(" ")


def trigrams(normalized: str) -> Set[str]:
    padded = "  " + normalized + " "
    return {padded[i : i + 3] for i in range(len(padded) - 2)}


def jaccard(a: Set[str], b: Set[str]) -> float:
    if not a and not b:
        return 1.0
    inter = len(a & b)
    union = len(a) + len(b) - inter
    return 1.0 if union == 0 else inter / union


def text_similarity(a: str, b: str) -> float:
    """Similarity of two raw strings: normalize, trigram, Jaccard. 0..1."""
    na, nb = normalize_text(a), normalize_text(b)
    if na == nb:
        return 1.0
    return jaccard(trigrams(na), trigrams(nb))
