"""SQL time-bucketing for sensor_readings, shared by replay and energy summaries."""

from app.core.timeutil import as_utc
from app.models.sensor import SensorReading
from datetime import datetime
from sqlalchemy import Integer, cast, func
from sqlalchemy.orm import Session


def epoch_expr(db: Session, column):
    """Seconds since the epoch for a timestamp column, on SQLite and Postgres."""
    if db.get_bind().dialect.name == "sqlite":
        return cast(func.strftime("%s", column), Integer)
    return cast(func.extract("epoch", column), Integer)


def bucketed(
    db: Session, sensor_id: str, start: datetime, end: datetime, bucket_seconds: int
) -> list[dict]:
    """Aggregate a sensor's readings into fixed buckets anchored at `start`.

    Each row: idx, t (timestamp of the last sample in the bucket), avg, lo, hi, n.
    """
    start_epoch = int(as_utc(start).timestamp())
    idx = cast(
        (epoch_expr(db, SensorReading.event_timestamp) - start_epoch) // bucket_seconds, Integer
    )
    rows = (
        db.query(
            idx.label("idx"),
            func.avg(SensorReading.value),
            func.min(SensorReading.value),
            func.max(SensorReading.value),
            func.count(SensorReading.id),
            func.max(SensorReading.event_timestamp),
        )
        .filter(
            SensorReading.sensor_id == sensor_id,
            SensorReading.event_timestamp >= as_utc(start),
            SensorReading.event_timestamp <= as_utc(end),
        )
        .group_by("idx")
        .order_by("idx")
        .all()
    )
    return [
        {"idx": r[0], "avg": r[1], "lo": r[2], "hi": r[3], "n": r[4], "t": as_utc(r[5])}
        for r in rows
    ]
