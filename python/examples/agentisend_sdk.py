"""agent-email-guard in front of the AgentiSend Python SDK (pip install agentisend agent-email-guard).

Two layers: the local guard stops a runaway agent before a request leaves the
process, and AgentiSend enforces the key's own limits at the API, where the
agent cannot remove them. Run: AGENTISEND_API_KEY=... python agentisend_sdk.py
"""

from agent_email_guard import ApprovalRequired, Guard, GuardRefused


def build_send(client, guard=None):
    guard = guard or Guard(budgets={"per_hour": 50, "per_day": 500}, rate={"per_minute": 10})
    return guard.wrap(client.send_email)


def main():
    from agentisend import AgentiSend

    send = build_send(AgentiSend())  # reads AGENTISEND_API_KEY
    try:
        result = send({"from": "Acme <billing@acme.dev>", "to": "customer@example.com", "subject": "Your receipt", "text": "Thanks for your order."})
        print("sent", result["id"])
    except GuardRefused as stop:
        print("refused:", stop.decision.reason, "-", stop.decision.message)
    except ApprovalRequired as held:
        print("held for a person:", held.decision.message)


if __name__ == "__main__":
    main()
