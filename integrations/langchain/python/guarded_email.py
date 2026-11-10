"""LangChain tool. hold_for_approval calls LangGraph interrupt().

Targeted langchain 1.4.9 and langgraph 1.2.20. LangGraph runs the node again on
resume: a hold records nothing, so the second check holds again and interrupt()
returns the person's answer. An approve sends through check(send, approved=True),
which skips the approval rules and still applies the budgets, the rate ceiling
and loop detection. A refusal is tool text and does not interrupt.
"""

from __future__ import annotations

from langchain_core.tools import tool
from langgraph.types import interrupt

from adapter import EmailGuard, Send, decision_text, send_allowed, send_through_guard, to_email_send


def guarded_email_tool(guard: EmailGuard, send: Send, key: str | None = None):
    @tool
    def send_email(to: str, subject: str, text: str = "") -> str:
        """Send one email. agent-email-guard checks it first; a hold pauses on a LangGraph interrupt."""
        email = to_email_send({"to": to, "subject": subject, "text": text}, key)
        decision = guard.check(email)
        if decision.outcome == "refuse":
            return decision_text(decision)
        if decision.outcome == "hold_for_approval":
            resume = interrupt(
                {
                    "outcome": "hold_for_approval",
                    "reason": decision.reason,
                    "message": decision.message,
                    "to": to,
                    "subject": subject,
                }
            )
            action = resume.get("action") if isinstance(resume, dict) else ""
            if action != "approve":
                return decision_text(decision)
            return send_through_guard(guard, send, email, approved=True)
        return send_allowed(guard, send, email, decision)

    return send_email
