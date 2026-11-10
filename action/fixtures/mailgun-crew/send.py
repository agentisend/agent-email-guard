import mailgun
from crewai import Agent


def deliver(mg):
    return mg.messages.create("example.com", {"from": "a@b.co", "to": "c@d.co", "subject": "Hi", "text": "Hi"})
