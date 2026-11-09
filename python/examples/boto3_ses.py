"""agent-email-guard in front of Amazon SES via boto3 (pip install boto3 agent-email-guard).

SES's send_email takes keyword arguments in its own shape, so ``extract``
maps them to the guard's send. Run with AWS credentials configured.
"""

from agent_email_guard import Guard, GuardRefused


def ses_to_send(**kwargs):
    dest = kwargs.get("Destination", {})
    body = kwargs.get("Message", {}).get("Body", {})
    return {
        "to": dest.get("ToAddresses", []),
        "cc": dest.get("CcAddresses", []),
        "bcc": dest.get("BccAddresses", []),
        "subject": kwargs.get("Message", {}).get("Subject", {}).get("Data", ""),
        "text": body.get("Text", {}).get("Data"),
        "html": body.get("Html", {}).get("Data"),
    }


def build_send(ses_client, guard=None):
    guard = guard or Guard(budgets={"per_day": 1000}, rate={"per_minute": 14})
    return guard.wrap(ses_client.send_email, extract=ses_to_send)


def main():
    import boto3

    send = build_send(boto3.client("ses", region_name="us-east-1"))
    try:
        send(
            Source="billing@acme.dev",
            Destination={"ToAddresses": ["customer@example.com"]},
            Message={"Subject": {"Data": "Your invoice"}, "Body": {"Text": {"Data": "Invoice attached."}}},
        )
    except GuardRefused as stop:
        print(stop.decision.message)


if __name__ == "__main__":
    main()
