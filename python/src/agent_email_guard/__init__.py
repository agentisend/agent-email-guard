"""agent-email-guard: blast-radius control for agents that send email.

Budgets, a rate ceiling, loop detection, approval holds and a kill switch.

Works with any provider. The library is advisory: it runs inside the agent's
own process. AgentiSend enforces the same rules at its API, where the agent
cannot skip them (see ``agent_email_guard.agentisend``).
"""

from ._version import __version__
from .decisions import REASON_TOKENS, Decision, Reservation, is_valid_decision
from .errors import ApprovalRequired, GuardError, GuardRefused
from .guard import AsyncGuard, AsyncKillSwitch, Guard, KillSwitch, KillSwitchState, create_guard, period_bounds
from .policy import POLICY_FILE, PolicyError, load_policy, policy_problems, validate_policy
from .loop import LOOP_DEFAULTS, LoopResult, SendRecord, detect_loop, recipient_entropy, resolve_loop_config, to_record
from .messages import format_instant, format_number, round3
from .stores import AsyncMemoryStore, MemoryStore
from .text import BODY_COMPARE_CHARS, address_list, normalize_address, normalize_text, text_similarity

__all__ = [
    "BODY_COMPARE_CHARS",
    "LOOP_DEFAULTS",
    "REASON_TOKENS",
    "ApprovalRequired",
    "AsyncGuard",
    "AsyncKillSwitch",
    "AsyncMemoryStore",
    "Decision",
    "Guard",
    "GuardError",
    "GuardRefused",
    "KillSwitch",
    "KillSwitchState",
    "LoopResult",
    "MemoryStore",
    "POLICY_FILE",
    "PolicyError",
    "Reservation",
    "SendRecord",
    "__version__",
    "address_list",
    "create_guard",
    "detect_loop",
    "format_instant",
    "format_number",
    "is_valid_decision",
    "load_policy",
    "normalize_address",
    "normalize_text",
    "period_bounds",
    "policy_problems",
    "recipient_entropy",
    "resolve_loop_config",
    "round3",
    "text_similarity",
    "to_record",
    "validate_policy",
]
