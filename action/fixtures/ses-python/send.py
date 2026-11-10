import langchain


def deliver(ses):
    return ses.send_email(Source="a@b.co", Destination={"ToAddresses": ["c@d.co"]}, Message={})
