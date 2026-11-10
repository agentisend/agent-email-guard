import langchain


def deliver(resend):
    return resend.Emails.send({"from": "a@b.co", "to": "c@d.co", "subject": "Hi", "text": "Hi"})
