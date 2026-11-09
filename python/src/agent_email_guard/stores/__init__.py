"""Storage backends. The in-memory store needs nothing; Redis and Postgres are extras:

    from agent_email_guard.stores.redis import RedisStore        # pip install "agent-email-guard[redis]"
    from agent_email_guard.stores.postgres import PostgresStore  # pip install "agent-email-guard[postgres]"
"""

from .base import SEND_LOG_CAP, AsyncStore, CounterResult, Store, WindowResult
from .memory import AsyncMemoryStore, MemoryStore

__all__ = ["SEND_LOG_CAP", "AsyncMemoryStore", "AsyncStore", "CounterResult", "MemoryStore", "Store", "WindowResult"]
