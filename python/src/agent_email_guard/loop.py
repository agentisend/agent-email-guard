"""Loop detection: two independent signals over a key's recent accepted sends.

1. Repetition: near-identical sends (same To line, subject AND body trigram
   similarity at or above the threshold) inside the window. Catches the retry
   loop that sends one message 4,000 times.
2. Recipient entropy: a looping agent's recipients collapse onto one or two
   inboxes even when it rewrites the content each time. Collapse holds only a
   candidate addressed to one of the dominant inboxes, so a key that pages its
   owner 30 times an hour still sends a sign-in code to a new user.

Pure functions over a window and ``now`` (epoch ms).
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple, Union

from . import messages
from .decisions import Decision, Evidence, refuse
from .messages import round3
from .text import BODY_COMPARE_CHARS, address_list, jaccard, normalize_text, trigrams

LOOP_MODES = ("off", "repetition_only", "full")

#: The thresholds the guard runs with when a caller passes none.
LOOP_DEFAULTS: Dict[str, Any] = {
    "mode": "full",
    "window_ms": 60 * 60 * 1000,
    "similarity_threshold": 0.85,
    "max_identical_sends": 3,
    "min_window_for_entropy": 20,
    "recipient_perplexity_floor": 3,
}


@dataclass(frozen=True)
class SendRecord:
    """One accepted send as the loop detector compares it. Text fields are already normalized."""

    to_line: str  # sorted, comma-joined To addresses
    recipients: Tuple[str, ...]  # every address reached (To, Cc, Bcc)
    subject: str  # normalize_text(subject)
    body: str  # normalize_text(body)[:BODY_COMPARE_CHARS]
    at: int  # epoch ms

    def to_dict(self) -> Dict[str, Any]:
        return {
            "to_line": self.to_line,
            "recipients": list(self.recipients),
            "subject": self.subject,
            "body": self.body,
            "at": self.at,
        }

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "SendRecord":
        return cls(
            to_line=data["to_line"],
            recipients=tuple(data["recipients"]),
            subject=data["subject"],
            body=data["body"],
            at=int(data["at"]),
        )


def _get(send: Any, *names: str) -> Any:
    for name in names:
        if isinstance(send, Mapping):
            if name in send:
                return send[name]
        elif hasattr(send, name):
            return getattr(send, name)
    return None


def to_record(send: Any, at: Optional[int] = None) -> SendRecord:
    """Build a :class:`SendRecord` from a raw send (mapping or object) or pass one through.

    ``to`` (string or list) makes the To line; ``recipients`` overrides the
    address list, otherwise To + Cc + Bcc. The body is ``text`` when it is a
    non-empty string, else ``html``, else ``body``.
    """
    if isinstance(send, SendRecord):
        return send
    to = address_list(_get(send, "to"))
    listed = _get(send, "recipients")
    if listed is not None:
        recipients = address_list(list(listed))
    else:
        recipients = list(to)
        for a in address_list(_get(send, "cc")) + address_list(_get(send, "bcc")):
            if a not in recipients:
                recipients.append(a)
    # SPEC 2.2: the body is text when it is a non-empty string, else html, else "".
    # ``body`` is a Python convenience, read last.
    text = _get(send, "text")
    if isinstance(text, str) and text != "":
        body = text
    else:
        body = next((v for v in (_get(send, "html"), _get(send, "body")) if isinstance(v, str)), "")
    when = at if at is not None else _get(send, "at", "sent_at", "sentAt")
    return SendRecord(
        to_line=",".join(sorted(to)),
        recipients=tuple(recipients),
        subject=normalize_text(_get(send, "subject") or ""),
        body=normalize_text(body)[:BODY_COMPARE_CHARS],
        at=int(when or 0),
    )


def resolve_loop_config(config: Optional[Mapping[str, Any]] = None) -> Dict[str, Any]:
    """Defaults filled in. Thresholds may sit at the top level or under ``thresholds``."""
    cfg = dict(LOOP_DEFAULTS)
    for k, v in (config or {}).items():
        if v is None:
            continue
        if k == "thresholds" and isinstance(v, Mapping):
            cfg.update({tk: tv for tk, tv in v.items() if tv is not None})
        elif k in cfg:
            cfg[k] = v
        else:
            raise ValueError(f"loop accepts {', '.join(sorted(LOOP_DEFAULTS))}; got {k!r}.")
    mode = str(cfg["mode"]).replace("-", "_")
    if mode not in LOOP_MODES:
        raise ValueError(f"loop mode must be one of {', '.join(LOOP_MODES)}; got {cfg['mode']!r}.")
    cfg["mode"] = mode
    return cfg


@dataclass(frozen=True)
class RepetitionSignal:
    flagged: bool
    matching_sends_in_window: int
    threshold: int
    closest_subject: Optional[float]
    closest_body: Optional[float]


@dataclass(frozen=True)
class EntropySignal:
    flagged: bool
    window_collapsed: bool
    trusted_sample: bool
    window_size: int
    distinct_recipients: int
    entropy_bits: float
    effective_recipients: float
    candidate_recipient_share: float
    dominant_share_floor: float


@dataclass(frozen=True)
class LoopResult:
    verdict: str  # clean | repetition_loop | entropy_collapse | both_signals
    #: A refuse decision, or None when clean.
    decision: Optional[Decision]
    #: Window statistics, reported on an allow too.
    stats: Evidence
    repetition: RepetitionSignal
    entropy: EntropySignal


def recipient_entropy(window: Sequence[Any]) -> Tuple[float, int]:
    """Shannon entropy in bits over the window's recipient slots, and how many distinct addresses."""
    counts: Dict[str, int] = {}
    for send in window:
        for r in to_record(send).recipients:
            counts[r] = counts.get(r, 0) + 1
    slots = sum(counts.values())
    bits = 0.0
    for c in counts.values():
        p = c / slots
        bits -= p * math.log2(p)
    return bits, len(counts)


def detect_loop(
    recent: Sequence[Any],
    candidate: Any,
    now: int,
    config: Optional[Mapping[str, Any]] = None,
) -> LoopResult:
    """Evaluate one candidate against the key's recent sends as of ``now``.

    ``recent`` and ``candidate`` may be :class:`SendRecord` or raw sends.
    """
    cfg = resolve_loop_config(config)
    records = [to_record(s) for s in recent]
    cand = to_record(candidate, at=now)
    window = [s for s in records if now - s.at <= cfg["window_ms"]]
    threshold = cfg["similarity_threshold"]

    # Signal 1: repetition.
    matches = 0
    closest_s = closest_b = 0.0
    closest_sum = -1.0
    cand_subject = trigrams(cand.subject)
    cand_body = trigrams(cand.body)
    for prior in window:
        if prior.to_line != cand.to_line:
            continue
        s = 1.0 if prior.subject == cand.subject else jaccard(trigrams(prior.subject), cand_subject)
        if s < threshold:
            continue
        b = 1.0 if prior.body == cand.body else jaccard(trigrams(prior.body), cand_body)
        if b < threshold:
            continue
        matches += 1
        if s + b > closest_sum:
            closest_sum, closest_s, closest_b = s + b, s, b
    repetition_flagged = cfg["mode"] != "off" and matches >= cfg["max_identical_sends"]

    # Signal 2: recipient entropy. Each address on a send counts once.
    counts: Dict[str, int] = {}
    slots = 0
    for send in window:
        for r in send.recipients:
            counts[r] = counts.get(r, 0) + 1
            slots += 1
    bits = 0.0
    for c in counts.values():
        p = c / slots
        bits -= p * math.log2(p)
    perplexity = math.pow(2, bits)
    floor = cfg["recipient_perplexity_floor"]
    trusted = len(window) >= cfg["min_window_for_entropy"]
    collapsed = trusted and perplexity < floor
    dominant = 1 / floor
    share = 0.0
    if slots > 0:
        for r in cand.recipients:
            share = max(share, counts.get(r, 0) / slots)
    entropy_flagged = cfg["mode"] == "full" and collapsed and share >= dominant

    stats: Evidence = {
        "window_size": len(window),
        "distinct_recipients": len(counts),
        "entropy_bits": round3(bits),
        "effective_recipients": round3(perplexity),
    }
    repetition = RepetitionSignal(
        repetition_flagged, matches, cfg["max_identical_sends"],
        closest_s if matches else None, closest_b if matches else None,
    )
    entropy = EntropySignal(
        entropy_flagged, collapsed, trusted, len(window), len(counts), bits, perplexity, share, dominant
    )

    if not repetition_flagged and not entropy_flagged:
        return LoopResult("clean", None, stats, repetition, entropy)

    if repetition_flagged and entropy_flagged:
        verdict = "both_signals"
    elif repetition_flagged:
        verdict = "repetition_loop"
    else:
        verdict = "entropy_collapse"
    evidence: Evidence = {
        "signal_repetition": repetition_flagged,
        "signal_entropy": entropy_flagged,
        "matching_sends_in_window": matches,
        "repetition_threshold": cfg["max_identical_sends"],
        "closest_subject_similarity": round3(closest_s) if matches else None,
        "closest_body_similarity": round3(closest_b) if matches else None,
    }
    evidence.update(stats)
    evidence.update(
        {
            "perplexity_floor": floor,
            "candidate_recipient_share": round3(share),
            "dominant_share_floor": round3(dominant),
            "window_ms": cfg["window_ms"],
        }
    )
    minutes = int(math.floor(cfg["window_ms"] / 60000 + 0.5))
    effective = round3(perplexity)
    if verdict == "repetition_loop":
        message = messages.loop_repetition_detected(matches, cand.to_line, minutes)
    elif verdict == "entropy_collapse":
        message = messages.recipient_entropy_collapse(len(window), effective)
    else:
        message = messages.loop_both_signals(matches, cand.to_line, effective)
    token = "loop_repetition_detected" if repetition_flagged else "recipient_entropy_collapse"
    return LoopResult(verdict, refuse(token, message, evidence), stats, repetition, entropy)
