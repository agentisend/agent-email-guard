"""agent-email-guard in front of the Resend Python SDK (pip install resend agent-email-guard).

resend.Emails.send(params) keeps its signature; the guard checks first and
records only what Resend accepted. Run: RESEND_API_KEY=... python resend_sdk.py
"""

from agent_email_guard import Guard, GuardRefused


def build_send(emails_api, guard=None):
    guard = guard or Guard(budgets={"per_day": 500}, rate={"per_minute": 10}, approval={"recipients": ["@bigcustomer.com"]})
    return guard.wrap(emails_api.send)


def main():
    import os

    import resend

    resend.api_key = os.environ["RESEND_API_KEY"]
    send = build_send(resend.Emails)
    try:
        print(send({"from": "Acme <onboarding@acme.dev>", "to": ["new-user@example.com"], "subject": "Welcome", "html": "<p>Hi!</p>"}))
    except GuardRefused as stop:
        print(stop.decision.reason, stop.decision.message)


if __name__ == "__main__":
    main()
