"""The hosted adapter: the same rules, enforced by AgentiSend at its API.

The local :class:`~agent_email_guard.Guard` is advisory. It runs inside the
agent's process, so an agent that skips ``check()`` or edits its own config
skips the guard. This adapter moves the rules to the API key itself:

* ``apply_limits()`` sets the key's budget and per-minute ceiling
  (``PATCH /limits/keys/{id}``). An API key may lower its own limits; raising
  one is a person's decision, made in the AgentiSend console.
* ``check()`` asks ``POST /emails/preflight``: every send gate runs, nothing
  is sent or stored.
* ``send()`` posts to ``POST /emails``. The API checks the kill switch, the
  budget, the ceiling, loop detection and the approval queue before it
  accepts the email, and this adapter turns its answer into the same
  :class:`~agent_email_guard.Decision` and exceptions the local guard raises.
* ``kill_switch.pause()`` stops the key (``POST /limits/keys/{id}/kill``).
  Resuming is for a person signed in to the console; the paused key cannot
  resume itself, so ``kill_switch.resume()`` raises.
* ``approvals.list()`` lists held sends (``GET /agent-actions?state=pending``).
  A person approves or rejects them in the console.

Standard library only: no extra install. ``AGENTISEND_API_KEY`` and
``AGENTISEND_BASE_URL`` are read from the environment when not passed.
"""

from __future__ import annotations

import json
import os
import platform
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable, Dict, Mapping, Optional, Tuple

from ._version import __version__
from . import messages
from .decisions import REASON_TOKENS, Decision
from .errors import ApprovalRequired, GuardRefused

DEFAULT_BASE_URL = "https://api.agentisend.com"

#: Transport: (method, url, headers, body) -> (status, headers, body). Injectable for tests.
Transport = Callable[[str, str, Dict[str, str], Optional[bytes]], Tuple[int, Mapping[str, str], bytes]]

#: API error code -> (outcome, reason token) for the codes that are guard decisions.
CODE_TO_DECISION: Dict[str, Tuple[str, str]] = {
    "kill_switch_active": ("refuse", "kill_switch_active"),
    "agent_budget_exceeded": ("refuse", "agent_budget_exceeded"),
    "rate_ceiling_exceeded": ("refuse", "rate_ceiling_exceeded"),
    "suppressed_recipient": ("refuse", "recipient_suppressed"),
    "approval_required": ("hold_for_approval", "recipient_requires_approval"),
}

_PERIODS = {"per_hour": "hourly", "per_day": "daily", "per_month": "monthly"}


class AgentiSendAPIError(Exception):
    """An API error that is not a guard decision (bad key, unverified domain, invalid payload...)."""

    def __init__(self, status: int, code: str, message: str, fix: str = "", body: Any = None) -> None:
        self.status, self.code, self.message, self.fix, self.body = status, code, message, fix, body
        super().__init__(f"[{code}] {message}" + (f" {fix}" if fix else ""))


def _urllib_transport(timeout: float) -> Transport:
    def send(method: str, url: str, headers: Dict[str, str], body: Optional[bytes]) -> Tuple[int, Mapping[str, str], bytes]:
        req = urllib.request.Request(url, data=body, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.status, dict(resp.headers.items()), resp.read()
        except urllib.error.HTTPError as err:
            return err.code, dict(err.headers.items()) if err.headers else {}, err.read()

    return send


def decision_from_error(status: int, body: Any) -> Optional[Decision]:
    """Map an AgentiSend error body to a guard Decision, or None when the error is not a guard decision."""
    err = body.get("error") if isinstance(body, Mapping) and isinstance(body.get("error"), Mapping) else body
    if not isinstance(err, Mapping):
        return None
    code = str(err.get("code") or "")
    mapped = CODE_TO_DECISION.get(code)
    if mapped is None:
        return None
    outcome, reason = mapped
    details = err.get("details") if isinstance(err.get("details"), Mapping) else {}
    # A loop hold carries the guard's own reason token (loop_repetition_detected, ...).
    if details.get("reason") in REASON_TOKENS and details.get("reason") != "ok":
        reason = details["reason"]
    message = str(err.get("message") or "").strip()
    if not message.endswith("."):
        message += "."
    evidence: Dict[str, Any] = {}
    if isinstance(details.get("evidence"), Mapping):
        evidence.update(details["evidence"])
    evidence.update({"enforced_by": "agentisend", "code": code, "status": status})
    for name in ("action_id", "retry_after_seconds", "fix", "docs_url"):
        if err.get(name) is not None:
            evidence[name] = err[name]
    return Decision(outcome, reason, message, evidence)  # type: ignore[arg-type]


class _HostedKillSwitch:
    def __init__(self, owner: "AgentiSendGuard") -> None:
        self._owner = owner

    def pause(self, reason: Optional[str] = None, by: Optional[str] = None) -> Any:
        """Stop this key sending, at the API, from its next request on."""
        body = {"reason": reason} if reason else None
        return self._owner._request("POST", f"/limits/keys/{self._owner._key()}/kill", body)

    def resume(self, by: Optional[str] = None) -> Any:
        """Always raises: resuming a key is a person's action in the AgentiSend console."""
        raise NotImplementedError(
            "A paused key cannot resume itself. A person signed in to the AgentiSend console resumes it "
            "(POST /limits/keys/{id}/resume is not available to an API key)."
        )

    def state(self) -> Any:
        return self._owner.limits()


class _Approvals:
    def __init__(self, owner: "AgentiSendGuard") -> None:
        self._owner = owner

    def list(self, **query: Any) -> Any:
        """Held sends waiting for a person (``GET /agent-actions?state=pending``)."""
        params = {"state": "pending"}
        params.update({k: str(v) for k, v in query.items() if v is not None})
        return self._owner._request("GET", "/agent-actions?" + urllib.parse.urlencode(params))


class AgentiSendGuard:
    """Enforce budgets, the rate ceiling, loop detection, approvals and the kill switch at AgentiSend's API."""

    def __init__(
        self,
        api_key: Optional[str] = None,
        *,
        key_id: Optional[str] = None,
        base_url: Optional[str] = None,
        timeout: float = 30.0,
        transport: Optional[Transport] = None,
    ) -> None:
        key = api_key or os.environ.get("AGENTISEND_API_KEY", "")
        if not key:
            raise ValueError("AgentiSendGuard needs an API key: pass api_key or set AGENTISEND_API_KEY.")
        self.api_key = key
        self.key_id = key_id
        self.base_url = (base_url or os.environ.get("AGENTISEND_BASE_URL") or DEFAULT_BASE_URL).rstrip("/")
        self._transport = transport or _urllib_transport(timeout)
        self.kill_switch = _HostedKillSwitch(self)
        self.approvals = _Approvals(self)

    # -- plumbing ------------------------------------------------------------

    def _key(self) -> str:
        if not self.key_id:
            raise ValueError("This call needs key_id: the id of the API key whose limits it changes (GET /api-keys lists them).")
        return self.key_id

    def _call(self, method: str, path: str, body: Any = None, idempotency_key: Optional[str] = None) -> Tuple[int, Any]:
        headers = {
            "authorization": f"Bearer {self.api_key}",
            "accept": "application/json",
            "user-agent": f"agent-email-guard-python/{__version__} python/{platform.python_version()}",
        }
        data = None
        if body is not None:
            headers["content-type"] = "application/json"
            data = json.dumps(body).encode("utf-8")
        if idempotency_key:
            headers["idempotency-key"] = idempotency_key
        status, _headers, raw = self._transport(method, self.base_url + path, headers, data)
        parsed: Any = None
        if raw:
            try:
                parsed = json.loads(raw.decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                parsed = {"error": {"code": "unexpected_response", "message": raw[:300].decode("utf-8", "replace")}}
        return status, parsed

    def _request(self, method: str, path: str, body: Any = None, idempotency_key: Optional[str] = None) -> Any:
        status, parsed = self._call(method, path, body, idempotency_key)
        if status >= 400:
            raise self._error(status, parsed)
        return parsed

    @staticmethod
    def _error(status: int, parsed: Any) -> AgentiSendAPIError:
        err = parsed.get("error") if isinstance(parsed, Mapping) and isinstance(parsed.get("error"), Mapping) else {}
        return AgentiSendAPIError(
            status, str(err.get("code") or "http_" + str(status)), str(err.get("message") or ""), str(err.get("fix") or ""), parsed
        )

    # -- the enforced send ---------------------------------------------------

    def send(self, payload: Mapping[str, Any], *, idempotency_key: Optional[str] = None) -> Any:
        """``POST /emails``. Returns the API's answer (``{"id": ...}``).

        Raises :class:`GuardRefused` or :class:`ApprovalRequired` when the API
        stopped the send; ``.decision.evidence["action_id"]`` names a held send.
        Raises :class:`AgentiSendAPIError` for every other error.
        """
        status, parsed = self._call("POST", "/emails", dict(payload), idempotency_key)
        if status < 400:
            return parsed
        decision = decision_from_error(status, parsed)
        if decision is None:
            raise self._error(status, parsed)
        if decision.outcome == "hold_for_approval":
            raise ApprovalRequired(decision)
        raise GuardRefused(decision)

    def check(self, payload: Mapping[str, Any]) -> Decision:
        """Ask ``POST /emails/preflight`` whether the API would accept this send. Nothing is sent or stored.

        Returns a Decision; errors that are not guard decisions (an unverified
        domain, an invalid payload) raise :class:`AgentiSendAPIError`.
        """
        status, parsed = self._call("POST", "/emails/preflight", dict(payload))
        if status >= 400:
            decision = decision_from_error(status, parsed)
            if decision is None:
                raise self._error(status, parsed)
            return decision
        if isinstance(parsed, Mapping) and parsed.get("ok") is False and isinstance(parsed.get("error"), Mapping):
            decision = decision_from_error(status, parsed)
            if decision is None:
                raise self._error(422, parsed)
            return decision
        evidence: Dict[str, Any] = {"enforced_by": "agentisend"}
        if isinstance(parsed, Mapping) and isinstance(parsed.get("simulated"), bool):
            evidence["simulated"] = parsed["simulated"]
        return Decision("allow", "ok", messages.ok(), evidence)

    # -- limits, approvals ---------------------------------------------------

    def set_limits(
        self,
        *,
        budget: Any = ...,
        period: Optional[str] = None,
        per_minute: Any = ...,
    ) -> Any:
        """``PATCH /limits/keys/{id}``. ``period`` is hourly, daily or monthly; ``None`` clears a ceiling.

        A key may only lower its own limits; raising one is a person's decision in the console.
        """
        body: Dict[str, Any] = {}
        if budget is not ...:
            body["budget_per_period"] = budget
        if period is not None:
            if period not in ("hourly", "daily", "monthly"):
                raise ValueError("period is hourly, daily or monthly.")
            body["period"] = period
        if per_minute is not ...:
            body["rate_ceiling_per_minute"] = per_minute
        if not body:
            raise ValueError("set_limits needs budget, period or per_minute.")
        return self._request("PATCH", f"/limits/keys/{self._key()}", body)

    def apply_limits(
        self,
        *,
        budgets: Optional[Mapping[str, Optional[int]]] = None,
        rate: Optional[Mapping[str, Optional[int]]] = None,
    ) -> Any:
        """The local guard's config shape, sent to :meth:`set_limits`.

        The API keeps one budget per key: pass exactly one of per_hour, per_day or per_month.
        """
        kwargs: Dict[str, Any] = {}
        if budgets:
            unknown = set(budgets) - set(_PERIODS)
            if unknown:
                raise ValueError(f"budgets accepts per_hour, per_day or per_month; got {sorted(unknown)!r}.")
            if len(budgets) != 1:
                raise ValueError("AgentiSend keeps one budget per key: pass exactly one of per_hour, per_day or per_month.")
            ((name, value),) = budgets.items()
            kwargs["budget"], kwargs["period"] = value, _PERIODS[name]
        if rate is not None:
            if set(rate) - {"per_minute"}:
                raise ValueError("rate accepts per_minute only.")
            kwargs["per_minute"] = rate.get("per_minute")
        return self.set_limits(**kwargs)

    def limits(self) -> Any:
        """The key's budget, ceiling, consumption and kill-switch state (``GET /limits/keys/{id}``)."""
        return self._request("GET", f"/limits/keys/{self._key()}")

    def pending_approvals(self, **query: Any) -> Any:
        """Same as ``approvals.list()``."""
        return self.approvals.list(**query)


__all__ = ["AgentiSendAPIError", "AgentiSendGuard", "CODE_TO_DECISION", "decision_from_error"]
