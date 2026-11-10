"""Stub send. No socket. A real Guard with a daily budget of 1: allow, then refuse."""

from adapter import Transport, make_test_guard
from guarded_email import guarded_email_tool

transport = Transport()
tool = guarded_email_tool(make_test_guard(budgets={"per_day": 1}), transport.send, key="agent-1")
print(tool.invoke({"to": "user@example.com", "subject": "Receipt", "text": "Paid."}))
print(tool.invoke({"to": "user@example.com", "subject": "Receipt", "text": "Second receipt."}))
print(f"sent {len(transport.sent)}")
