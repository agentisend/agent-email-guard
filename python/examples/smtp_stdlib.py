"""agent-email-guard in front of plain SMTP with the standard library (pip install agent-email-guard).

Works with any SMTP server. Run: SMTP_HOST=... SMTP_USER=... SMTP_PASSWORD=... python smtp_stdlib.py
"""

import os
import smtplib
from email.message import EmailMessage

from agent_email_guard import Guard, GuardRefused


def message_to_send(msg):
    return {
        "to": msg.get_all("To", []),
        "cc": msg.get_all("Cc", []),
        "subject": msg.get("Subject", ""),
        "text": msg.get_content() if not msg.is_multipart() else "",
    }


def build_send(smtp_factory, guard=None):
    guard = guard or Guard(budgets={"per_hour": 100}, rate={"per_minute": 20})

    def deliver(msg):
        with smtp_factory() as smtp:
            smtp.send_message(msg)

    return guard.wrap(deliver, extract=message_to_send)


def main():
    def factory():
        smtp = smtplib.SMTP(os.environ["SMTP_HOST"], int(os.environ.get("SMTP_PORT", "587")))
        smtp.starttls()
        smtp.login(os.environ["SMTP_USER"], os.environ["SMTP_PASSWORD"])
        return smtp

    msg = EmailMessage()
    msg["From"], msg["To"], msg["Subject"] = "alerts@acme.dev", "oncall@acme.dev", "Disk at 91%"
    msg.set_content("db-1 crossed 90% disk.")
    try:
        build_send(factory)(msg)
    except GuardRefused as stop:
        print(stop.decision.message)


if __name__ == "__main__":
    main()
