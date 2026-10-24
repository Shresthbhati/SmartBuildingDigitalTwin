import logging
from collections import deque
from datetime import UTC, datetime


class RecentErrorsHandler(logging.Handler):
    """Ring buffer of the most recent WARNING+ log records, surfaced by /health/detailed."""

    def __init__(self, capacity: int = 50):
        super().__init__(level=logging.WARNING)
        self._records: deque[dict] = deque(maxlen=capacity)

    def emit(self, record: logging.LogRecord) -> None:
        self._records.append(
            {
                "ts": datetime.fromtimestamp(record.created, UTC).isoformat(),
                "level": record.levelname,
                "logger": record.name,
                "message": record.getMessage()[:500],
            }
        )

    def snapshot(self) -> list[dict]:
        return list(self._records)

    def clear(self) -> None:
        self._records.clear()


recent_errors = RecentErrorsHandler()


def install() -> None:
    root = logging.getLogger()
    if recent_errors not in root.handlers:
        root.addHandler(recent_errors)
