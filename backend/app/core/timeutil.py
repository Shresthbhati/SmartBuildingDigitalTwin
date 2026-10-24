from datetime import UTC, datetime


def as_utc(dt: datetime) -> datetime:
    """SQLite returns naive datetimes that are really UTC; normalise to aware UTC."""
    return dt.replace(tzinfo=UTC) if dt.tzinfo is None else dt.astimezone(UTC)


def iso(dt: datetime | None) -> str | None:
    return as_utc(dt).isoformat() if dt is not None else None
