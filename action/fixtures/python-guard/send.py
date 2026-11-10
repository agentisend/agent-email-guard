import langchain
from agent_email_guard import Guard


def deliver(ses):
    return ses.send_email(Source="a@b.co")
