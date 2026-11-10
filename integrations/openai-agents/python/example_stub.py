"""Stub send. No socket. A real Guard with a daily budget of 1: allow, then refuse."""

import asyncio

from adapter import Transport, make_test_guard
from guarded_email import apply_email_guardrail, guarded_email_tool


async def main() -> None:
    transport = Transport()
    tool = guarded_email_tool(make_test_guard(budgets={"per_day": 1}), transport.send, key="agent-1")
    print(await apply_email_guardrail(tool, {"to": "user@example.com", "subject": "Receipt", "text": "Paid."}))
    print(await apply_email_guardrail(tool, {"to": "user@example.com", "subject": "Receipt", "text": "Second receipt."}))
    print(f"sent {len(transport.sent)}")


if __name__ == "__main__":
    asyncio.run(main())
