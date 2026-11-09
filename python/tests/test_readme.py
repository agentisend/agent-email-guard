"""The README's quick example runs as written, against a stub provider."""

import re
from pathlib import Path

README = (Path(__file__).resolve().parents[1] / "README.md").read_text()


def test_quick_example_runs(capsys):
    block = re.search(r"## Twelve lines\n\n```python\n(.*?)```", README, re.S).group(1)
    assert len([line for line in block.splitlines() if line.strip()]) <= 12

    class Provider:
        sent = []

        def send(self, email):
            self.sent.append(email)
            return {"id": "1"}

    provider = Provider()
    exec(block, {"provider": provider})
    assert provider.sent == [{"to": "customer@example.com", "subject": "Your receipt", "text": "Thanks."}]
    assert capsys.readouterr().out == ""


def test_readme_names_no_banned_words():
    banned = ["supercharge", "unleash", "unlock", "effortless", "seamless", "revolution", "game-changing", "robust", "cutting-edge", "empower", "blocklist", "ai guardrails", "stops prompt injection", "prevents prompt injection"]
    lowered = README.lower()
    assert [w for w in banned if w in lowered] == []
