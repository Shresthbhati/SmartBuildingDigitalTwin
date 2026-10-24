"""Row factories shared by the test modules (synthetic data only)."""

import json
from app.models.alert import Alert, AlertSeverity, AlertStatus, AlertType
from app.models.anomaly import AnomalyCategory, AnomalyEvent, AnomalySeverity, AnomalyStatus
from app.models.sensor import ReadingSource, SensorReading
from datetime import UTC, datetime, timedelta

_counter = {"n": 0}


def now() -> datetime:
    return datetime.now(UTC)


def add_reading(
    db,
    sensor_id="temp-sensor-101",
    room="room101",
    value=22.0,
    ts=None,
    measurement="temperature",
    unit="celsius",
    source=ReadingSource.SIMULATED,
):
    _counter["n"] += 1
    r = SensorReading(
        room=room,
        sensor_id=sensor_id,
        measurement=measurement,
        value=value,
        unit=unit,
        source=source,
        event_timestamp=ts or now(),
        idempotency_key=f"test-{_counter['n']}",
    )
    db.add(r)
    return r


def add_alert(
    db,
    room="room101",
    sensor_id="temp-sensor-101",
    alert_type=AlertType.HIGH_TEMPERATURE,
    severity=AlertSeverity.WARNING,
    status=AlertStatus.OPEN,
    started=None,
    resolved=None,
    acknowledged=None,
):
    started = started or now()
    a = Alert(
        room=room,
        sensor_id=sensor_id,
        alert_type=alert_type,
        severity=severity,
        title=f"{severity.value.title()} temperature in {room}",
        description="synthetic",
        status=status,
        first_occurrence=started,
        last_occurrence=resolved or started,
        acknowledged_at=acknowledged,
        resolved_at=resolved,
        last_reading_value=31.0,
        threshold_value=30.0,
        occurrence_count=1,
        metadata_json=json.dumps({"note": "synthetic"}),
    )
    db.add(a)
    db.flush()
    return a


def add_anomaly(
    db,
    room="room101",
    sensor_id="temp-sensor-101",
    category=AnomalyCategory.Z_SCORE_SPIKE,
    severity=AnomalySeverity.WARNING,
    status=AnomalyStatus.OPEN,
    detected=None,
    resolved=None,
    meta=None,
):
    detected = detected or now()
    a = AnomalyEvent(
        room=room,
        sensor_id=sensor_id,
        anomaly_category=category,
        severity=severity,
        title=f"{severity.value.title()} statistical spike in {room}",
        description="synthetic",
        status=status,
        detected_at=detected,
        last_observed_at=detected,
        resolved_at=resolved,
        observed_value=32.0,
        expected_baseline=22.0,
        deviation_score=6.5,
        occurrence_count=1,
        metadata_json=json.dumps(
            meta
            or {
                "rolling_mean": 22.0,
                "rolling_stddev": 0.5,
                "sample_count": 20,
                "window_size": 20,
                "detector_config": {"z_score_threshold": 3.0},
            }
        ),
    )
    db.add(a)
    db.flush()
    return a


def minutes_ago(n: float) -> datetime:
    return now() - timedelta(minutes=n)
