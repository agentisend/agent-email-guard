"""CrewAI tool. Targeted crewai 1.15.39, BaseTool plus args_schema.

A refusal or a hold is the string returned from _run. The send callable is not called.
"""

from __future__ import annotations

from crewai.tools import BaseTool
from pydantic import BaseModel, ConfigDict, Field

from adapter import EmailGuard, Send, send_through_guard, to_email_send


class EmailInput(BaseModel):
    """Arguments for one email."""

    to: str = Field(description="Recipient email address")
    subject: str = Field(description="Subject line")
    text: str = Field(default="", description="Plain-text body")


class GuardedEmailTool(BaseTool):
    name: str = "send_email"
    description: str = (
        "Send one email. agent-email-guard checks the budgets, the rate ceiling, "
        "repeats and approval rules first. A refusal or a hold is the tool result."
    )
    args_schema: type[BaseModel] = EmailInput
    model_config = ConfigDict(arbitrary_types_allowed=True)
    # Protocol types are not valid Pydantic field types. Callers still pass an EmailGuard.
    guard: object
    send: object
    key: str | None = None

    def _run(self, to: str, subject: str, text: str = "") -> str:
        email = to_email_send({"to": to, "subject": subject, "text": text}, self.key)
        return send_through_guard(self.guard, self.send, email)  # type: ignore[arg-type]


def guarded_email_tool(guard: EmailGuard, send: Send, key: str | None = None) -> GuardedEmailTool:
    return GuardedEmailTool(guard=guard, send=send, key=key)
