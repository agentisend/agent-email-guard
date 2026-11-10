from crewai import Agent

note = "mailgun"


def deliver(mg):
    return mg.messages.create("example.com", {"from": "a@b.co"})
