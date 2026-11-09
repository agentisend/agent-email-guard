import pytest

NOW = 1_800_000_000_000


class Clock:
    def __init__(self, now: int = NOW) -> None:
        self.now = now

    def __call__(self) -> int:
        return self.now


@pytest.fixture
def clock():
    return Clock()
