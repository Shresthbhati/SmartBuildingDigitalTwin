from app.core.config import settings
from app.core.database import get_db
from app.models.sensor import ActivityLog, RoomStatus, SensorReading
from app.schemas.alert import (
    AlertAcknowledgeRequest,
    AlertCountBySeverity,
    AlertCountByStatus,
    AlertCountsResponse,
    AlertListItem,
    AlertResolveRequest,
    AlertResponse,
    APIAlertSeverity,
    APIAlertStatus,
    APIAlertType,
)
from app.schemas.anomaly import (
    AnomalyAcknowledgeRequest,
    AnomalyCountByCategory,
    AnomalyCountBySeverity,
    AnomalyCountByStatus,
    AnomalyCountsResponse,
    AnomalyListItem,
    AnomalyResolveRequest,
    AnomalyResponse,
    APIAnomalyCategory,
    APIAnomalySeverity,
    APIAnomalyStatus,
)
from app.schemas.sensor import (
    ActivityLogResponse,
    AggregateBucket,
    AggregateResponse,
    BuildingFloorResponse,
    BuildingLayoutResponse,
    BuildingRoomResponse,
    HealthResponse,
    HistoryResponse,
    LatestDataResponse,
    ReadingSource,
    RoomStatusEnum,
    RoomStatusResponse,
    SensorReadingResponse,
)
from app.services.alert_service import alert_service
from app.services.anomaly_service import anomaly_service
from app.services.mqtt_service import mqtt_service
from app.services.retention_service import retention_service
from app.services.simulator_service import sensor_simulator
from datetime import UTC, datetime, timedelta
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import desc, text
from sqlalchemy.orm import Session

router = APIRouter()


@router.get("/health", response_model=HealthResponse)
def health_check(db: Session = Depends(get_db)):
    db_status = "connected"
    mqtt_status = "connected" if mqtt_service.connected else "disconnected"
    try:
        db.execute(text("SELECT 1"))
    except Exception:
        db_status = "error"

    return HealthResponse(
        status="healthy" if db_status == "connected" and mqtt_status == "connected" else "degraded",
        version="1.0.0",
        database=db_status,
        mqtt=mqtt_status,
    )


@router.get("/health/detailed")
def detailed_health_check(db: Session = Depends(get_db)):
    db_status = "connected"
    mqtt_status = "connected" if mqtt_service.connected else "disconnected"
    simulator_status = "running" if sensor_simulator.running else "stopped"
    last_ingestion = None
    latest_event = None
    last_retention_run = None
    recent_errors = []

    try:
        db.execute(text("SELECT 1"))

        # Get last ingestion timestamp
        last_reading = (
            db.query(SensorReading).order_by(desc(SensorReading.ingestion_timestamp)).first()
        )
        if last_reading:
            last_ingestion = last_reading.ingestion_timestamp.isoformat()

        # Get latest event timestamp
        latest_reading = (
            db.query(SensorReading).order_by(desc(SensorReading.event_timestamp)).first()
        )
        if latest_reading:
            latest_event = latest_reading.event_timestamp.isoformat()

        # Get retention info
        last_retention_run = (
            retention_service.last_run.isoformat() if retention_service.last_run else None
        )

    except Exception:
        db_status = "error"

    return {
        "status": "healthy"
        if db_status == "connected" and mqtt_status == "connected"
        else "degraded",
        "version": "1.0.0",
        "database": db_status,
        "mqtt": mqtt_status,
        "simulator": simulator_status,
        "last_ingestion": last_ingestion,
        "latest_event_timestamp": latest_event,
        "last_retention_run": last_retention_run,
        "recent_errors": recent_errors,
    }


@router.get("/api/layout", response_model=BuildingLayoutResponse)
def get_building_layout():
    """Get building layout metadata including floors, rooms, and sensor relationships.

    This endpoint provides the authoritative source for room identity and layout.
    Frontend should not hardcode room definitions.
    """
    from app.core.config import settings

    # Build layout from simulator sensor config which is the source of truth
    floors_map: dict[int, dict] = {}

    for sensor in settings.simulator.sensors:
        # Extract floor from room ID (room101 -> floor 0, room201 -> floor 1)
        room_id = sensor.room
        floor_num = 0
        if room_id.startswith("room"):
            try:
                floor_digit = int(room_id[4:5])
                floor_num = floor_digit - 1
            except (ValueError, IndexError):
                floor_num = 0

        if floor_num not in floors_map:
            floors_map[floor_num] = {
                "level": floor_num,
                "name": f"Floor {floor_num}" if floor_num > 0 else "Ground Floor",
                "height": floor_num * 4.0,
                "rooms": [],
            }

        # Calculate position based on room index within floor
        floor_rooms = [
            s for s in settings.simulator.sensors if s.room.startswith(f"room{floor_num + 1}")
        ]
        room_index = floor_rooms.index(sensor)
        col = room_index % 2
        row = room_index // 2

        floors_map[floor_num]["rooms"].append(
            BuildingRoomResponse(
                id=sensor.room,
                name=sensor.room.upper().replace("ROOM", "Room "),
                floor=floor_num,
                position_x=2.5 + col * 10.0,
                position_y=0.0,
                position_z=2.5 + row * 7.5,
                size_x=5.0,
                size_y=3.0,
                size_z=5.0,
                sensor_id=sensor.sensor_id,
            )
        )

    floors = [floors_map[k] for k in sorted(floors_map.keys())]

    return BuildingLayoutResponse(
        floors=[
            BuildingFloorResponse(
                level=f["level"],
                name=f["name"],
                height=f["height"],
                rooms=f["rooms"],
            )
            for f in floors
        ],
        dimensions={
            "width": 20.0,
            "depth": 15.0,
            "floorHeight": 4.0,
        },
    )


@router.get("/api/latest", response_model=list[LatestDataResponse])
def get_latest_data(db: Session = Depends(get_db)):
    rooms = settings.simulation_rooms
    result = []

    for room in rooms:
        status_record = db.query(RoomStatus).filter(RoomStatus.room == room).first()
        if status_record:
            result.append(
                LatestDataResponse(
                    room=room,
                    temperature=status_record.current_temperature or 0.0,
                    status=RoomStatusEnum(status_record.status),
                )
            )
        else:
            result.append(
                LatestDataResponse(
                    room=room,
                    temperature=0.0,
                    status=RoomStatusEnum.NORMAL,
                )
            )

    return result


@router.get("/api/history/{room}", response_model=HistoryResponse)
def get_room_history(
    room: str,
    sensor_id: str | None = Query(default=None),
    measurement: str | None = Query(default="temperature"),
    start: datetime | None = Query(default=None),
    end: datetime | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=1000),
    db: Session = Depends(get_db),
):
    if room not in settings.simulation_rooms:
        raise HTTPException(status_code=404, detail=f"Room {room} not found")

    # Validate time range
    if start and end and end < start:
        raise HTTPException(status_code=400, detail="End time must be after start time")

    query = db.query(SensorReading).filter(
        SensorReading.room == room,
        SensorReading.measurement == measurement,
    )

    if sensor_id:
        query = query.filter(SensorReading.sensor_id == sensor_id)

    if start:
        query = query.filter(SensorReading.event_timestamp >= start)

    if end:
        query = query.filter(SensorReading.event_timestamp <= end)

    readings = query.order_by(desc(SensorReading.event_timestamp)).limit(limit).all()
    readings.reverse()

    return HistoryResponse(
        room=room,
        readings=[SensorReadingResponse.model_validate(r) for r in readings],
    )


@router.get("/api/history", response_model=list[HistoryResponse])
def get_all_history(
    sensor_id: str | None = Query(default=None),
    measurement: str | None = Query(default="temperature"),
    start: datetime | None = Query(default=None),
    end: datetime | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=500),
    source: ReadingSource | None = Query(default=None),
    db: Session = Depends(get_db),
):
    if start and end and end < start:
        raise HTTPException(status_code=400, detail="End time must be after start time")

    result = []
    for room in settings.simulation_rooms:
        query = db.query(SensorReading).filter(
            SensorReading.room == room,
            SensorReading.measurement == measurement,
        )

        if sensor_id:
            query = query.filter(SensorReading.sensor_id == sensor_id)

        if start:
            query = query.filter(SensorReading.event_timestamp >= start)

        if end:
            query = query.filter(SensorReading.event_timestamp <= end)

        if source:
            query = query.filter(SensorReading.source == source)

        readings = query.order_by(desc(SensorReading.event_timestamp)).limit(limit).all()
        readings.reverse()

        result.append(
            HistoryResponse(
                room=room,
                readings=[SensorReadingResponse.model_validate(r) for r in readings],
            )
        )
    return result


@router.get("/api/telemetry/aggregate", response_model=AggregateResponse)
def get_telemetry_aggregate(
    room: str = Query(...),
    sensor_id: str = Query(...),
    measurement: str = Query(default="temperature"),
    start: datetime = Query(...),
    end: datetime = Query(...),
    interval: str = Query(default="15m"),
    source: ReadingSource | None = Query(default=None),
    db: Session = Depends(get_db),
):
    if room not in settings.simulation_rooms:
        raise HTTPException(status_code=404, detail=f"Room {room} not found")

    if end < start:
        raise HTTPException(status_code=400, detail="End time must be after start time")

    if interval not in settings.aggregation.supported_intervals:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported interval. Supported: {settings.aggregation.supported_intervals}",
        )

    interval_minutes = _parse_interval(interval)
    max_interval = settings.aggregation.max_bucket_interval_hours * 60
    if interval_minutes > max_interval:
        raise HTTPException(
            status_code=400,
            detail=f"Interval {interval} exceeds maximum allowed ({max_interval} minutes)",
        )

    query = db.query(SensorReading).filter(
        SensorReading.room == room,
        SensorReading.sensor_id == sensor_id,
        SensorReading.measurement == measurement,
        SensorReading.event_timestamp >= start,
        SensorReading.event_timestamp <= end,
    )

    if source:
        query = query.filter(SensorReading.source == source)

    # Bucket in Python: SQLite has no EXTRACT(epoch ...). SQLite returns naive datetimes (UTC).
    def _utc(dt: datetime) -> datetime:
        return dt.replace(tzinfo=UTC) if dt.tzinfo is None else dt.astimezone(UTC)

    start_utc = _utc(start)
    interval_seconds = interval_minutes * 60
    groups: dict[int, list[SensorReading]] = {}
    for r in query.all():
        idx = int((_utc(r.event_timestamp) - start_utc).total_seconds() // interval_seconds)
        groups.setdefault(idx, []).append(r)

    buckets = []
    for idx in sorted(groups):
        rows = groups[idx]
        values = [r.value for r in rows]
        bucket_start_ts = start_utc + timedelta(minutes=idx * interval_minutes)
        src = min(r.source for r in rows if r.source) if any(r.source for r in rows) else None
        buckets.append(
            AggregateBucket(
                bucket_start=bucket_start_ts,
                bucket_end=bucket_start_ts + timedelta(minutes=interval_minutes),
                avg_value=sum(values) / len(values),
                min_value=min(values),
                max_value=max(values),
                count=len(rows),
                unit=min((r.unit for r in rows if r.unit), default="celsius"),
                room=room,
                sensor_id=sensor_id,
                measurement=measurement,
                source=ReadingSource(src) if src else None,
            )
        )

    total_count = sum(b.count for b in buckets)

    return AggregateResponse(
        room=room,
        sensor_id=sensor_id,
        measurement=measurement,
        interval=interval,
        buckets=buckets,
        total_count=total_count,
    )


@router.get("/api/activity", response_model=list[ActivityLogResponse])
def get_activity_log(
    limit: int = Query(default=50, ge=1, le=200),
    db: Session = Depends(get_db),
):
    activities = db.query(ActivityLog).order_by(desc(ActivityLog.timestamp)).limit(limit).all()
    activities.reverse()
    return [ActivityLogResponse.model_validate(a) for a in activities]


@router.get("/api/status", response_model=list[RoomStatusResponse])
def get_room_status(db: Session = Depends(get_db)):
    rooms = settings.simulation_rooms
    result = []

    for room in rooms:
        status_record = db.query(RoomStatus).filter(RoomStatus.room == room).first()
        if status_record:
            result.append(RoomStatusResponse.model_validate(status_record))
        else:
            result.append(
                RoomStatusResponse(
                    room=room,
                    status=RoomStatusEnum.NORMAL,
                    current_temperature=None,
                    last_updated=datetime.now(UTC),
                )
            )

    return result


@router.get("/api/retention/status")
def get_retention_status():
    return {
        "enabled": settings.retention.enabled,
        "raw_telemetry_days": settings.retention.raw_telemetry_days,
        "cleanup_interval_hours": settings.retention.cleanup_interval_hours,
        "batch_size": settings.retention.batch_size,
        "dry_run": settings.retention.dry_run,
        "last_run": retention_service.last_run.isoformat() if retention_service.last_run else None,
        "last_deleted_count": retention_service.last_deleted_count,
        "last_error": retention_service.last_error,
    }


@router.post("/api/retention/run")
def run_retention_manually():
    deleted_count = retention_service.run_cleanup()
    return {
        "deleted_count": deleted_count,
        "last_run": retention_service.last_run.isoformat() if retention_service.last_run else None,
    }


# --------------------------------------------------------------------- #
# Alert endpoints                                                       #
# --------------------------------------------------------------------- #
@router.get("/api/alerts", response_model=list[AlertListItem])
def list_alerts(
    room: str | None = None,
    sensor_id: str | None = None,
    alert_type: APIAlertType | None = None,
    severity: APIAlertSeverity | None = None,
    status: APIAlertStatus | None = None,
    limit: int = Query(default=50, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    sort_by: str = Query(default="last_occurrence"),
    sort_order: str = Query(default="desc"),
    db: Session = Depends(get_db),
):
    """List alerts with optional filtering, pagination, and stable sorting."""
    allowed_sorts = {
        "id",
        "room",
        "sensor_id",
        "alert_type",
        "severity",
        "status",
        "first_occurrence",
        "last_occurrence",
        "acknowledged_at",
        "resolved_at",
        "occurrence_count",
        "created_at",
        "updated_at",
    }
    if sort_by not in allowed_sorts:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid sort_by '{sort_by}'. Allowed: {sorted(allowed_sorts)}",
        )

    filters = {
        "room": room,
        "sensor_id": sensor_id,
        "alert_type": alert_type,
        "severity": severity,
        "status": status,
        "limit": limit,
        "offset": offset,
        "sort_by": sort_by,
        "sort_order": sort_order,
    }

    alerts = alert_service.get_alerts(filters, db=db)
    return [AlertListItem.model_validate(a) for a in alerts]


@router.get("/api/alerts/counts", response_model=AlertCountsResponse)
def get_alert_counts(db: Session = Depends(get_db)):
    """Return alert counts grouped by severity and status."""
    counts = alert_service.get_alert_counts(db=db)
    return AlertCountsResponse(
        total=counts["total"],
        by_severity=[
            AlertCountBySeverity(severity=APIAlertSeverity(i["severity"]), count=i["count"])
            for i in counts["by_severity"]
        ],
        by_status=[
            AlertCountByStatus(status=APIAlertStatus(i["status"]), count=i["count"])
            for i in counts["by_status"]
        ],
    )


@router.get("/api/alerts/{alert_id}", response_model=AlertResponse)
def get_alert(
    alert_id: int,
    db: Session = Depends(get_db),
):
    """Retrieve a single alert by identifier."""
    alert = alert_service.get_alert(alert_id, db=db)
    if not alert:
        raise HTTPException(status_code=404, detail=f"Alert {alert_id} not found")
    return AlertResponse.model_validate(alert)


@router.post("/api/alerts/{alert_id}/acknowledge", response_model=AlertResponse)
def acknowledge_alert(
    alert_id: int,
    request: AlertAcknowledgeRequest | None = None,
    db: Session = Depends(get_db),
):
    """Acknowledge an OPEN or ACKNOWLEDGED alert."""
    try:
        alert = alert_service.acknowledge_alert(
            alert_id, actor=(request.actor if request else None)
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from None
    if not alert:
        raise HTTPException(status_code=404, detail=f"Alert {alert_id} not found")
    return AlertResponse.model_validate(alert)


@router.post("/api/alerts/{alert_id}/resolve", response_model=AlertResponse)
def resolve_alert_endpoint(
    alert_id: int,
    request: AlertResolveRequest | None = None,
    db: Session = Depends(get_db),
):
    """Resolve an OPEN or ACKNOWLEDGED alert."""
    try:
        alert = alert_service.resolve_alert(alert_id, actor=(request.actor if request else None))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from None
    if not alert:
        raise HTTPException(status_code=404, detail=f"Alert {alert_id} not found")
    return AlertResponse.model_validate(alert)


# --------------------------------------------------------------------- #
# Anomaly endpoints                                                     #
# --------------------------------------------------------------------- #
@router.get("/api/anomalies", response_model=list[AnomalyListItem])
def list_anomalies(
    room: str | None = None,
    sensor_id: str | None = None,
    anomaly_category: APIAnomalyCategory | None = None,
    severity: APIAnomalySeverity | None = None,
    status: APIAnomalyStatus | None = None,
    start: datetime | None = None,
    end: datetime | None = None,
    limit: int = Query(default=50, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    sort_by: str = Query(default="detected_at"),
    sort_order: str = Query(default="desc"),
    db: Session = Depends(get_db),
):
    """List anomalies with optional filtering, pagination, and stable sorting."""
    allowed_sorts = {
        "id",
        "room",
        "sensor_id",
        "anomaly_category",
        "severity",
        "status",
        "detected_at",
        "last_observed_at",
        "acknowledged_at",
        "resolved_at",
        "observed_value",
        "expected_baseline",
        "deviation_score",
        "occurrence_count",
        "created_at",
        "updated_at",
    }
    if sort_by not in allowed_sorts:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid sort_by '{sort_by}'. Allowed: {sorted(allowed_sorts)}",
        )

    if start and end and end < start:
        raise HTTPException(status_code=400, detail="End time must be after start time")

    filters = {
        "room": room,
        "sensor_id": sensor_id,
        "anomaly_category": anomaly_category,
        "severity": severity,
        "status": status,
        "start": start,
        "end": end,
        "limit": limit,
        "offset": offset,
        "sort_by": sort_by,
        "sort_order": sort_order,
    }

    anomalies = anomaly_service.get_anomalies(filters, db=db)
    return [AnomalyListItem.model_validate(a) for a in anomalies]


@router.get("/api/anomalies/counts", response_model=AnomalyCountsResponse)
def get_anomaly_counts(db: Session = Depends(get_db)):
    """Return anomaly counts grouped by severity, status, and category."""
    counts = anomaly_service.get_anomaly_counts(db=db)
    return AnomalyCountsResponse(
        total=counts["total"],
        by_severity=[
            AnomalyCountBySeverity(severity=APIAnomalySeverity(i["severity"]), count=i["count"])
            for i in counts["by_severity"]
        ],
        by_status=[
            AnomalyCountByStatus(status=APIAnomalyStatus(i["status"]), count=i["count"])
            for i in counts["by_status"]
        ],
        by_category=[
            AnomalyCountByCategory(category=APIAnomalyCategory(i["category"]), count=i["count"])
            for i in counts["by_category"]
        ],
    )


@router.get("/api/anomalies/{anomaly_id}", response_model=AnomalyResponse)
def get_anomaly(
    anomaly_id: int,
    db: Session = Depends(get_db),
):
    """Retrieve a single anomaly by identifier."""
    anomaly = anomaly_service.get_anomaly(anomaly_id, db=db)
    if not anomaly:
        raise HTTPException(status_code=404, detail=f"Anomaly {anomaly_id} not found")
    return AnomalyResponse.model_validate(anomaly)


@router.post("/api/anomalies/{anomaly_id}/acknowledge", response_model=AnomalyResponse)
def acknowledge_anomaly(
    anomaly_id: int,
    request: AnomalyAcknowledgeRequest | None = None,
    db: Session = Depends(get_db),
):
    """Acknowledge an OPEN or ACKNOWLEDGED anomaly."""
    try:
        anomaly = anomaly_service.acknowledge_anomaly(
            anomaly_id, actor=(request.actor if request else None), db=db
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from None
    if not anomaly:
        raise HTTPException(status_code=404, detail=f"Anomaly {anomaly_id} not found")
    return AnomalyResponse.model_validate(anomaly)


@router.post("/api/anomalies/{anomaly_id}/resolve", response_model=AnomalyResponse)
def resolve_anomaly_endpoint(
    anomaly_id: int,
    request: AnomalyResolveRequest | None = None,
    db: Session = Depends(get_db),
):
    """Resolve an OPEN or ACKNOWLEDGED anomaly."""
    try:
        anomaly = anomaly_service.resolve_anomaly(
            anomaly_id, actor=(request.actor if request else None), db=db
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from None
    if not anomaly:
        raise HTTPException(status_code=404, detail=f"Anomaly {anomaly_id} not found")
    return AnomalyResponse.model_validate(anomaly)


@router.get("/api/simulator/status")
def get_simulator_status():
    return {
        "enabled": settings.simulator.enabled,
        "running": sensor_simulator.running,
        "interval_seconds": settings.simulator.interval_seconds,
        "seed": settings.simulator.seed,
        "sensors": [
            {
                "room": s.room,
                "sensor_id": s.sensor_id,
                "baseline": s.baseline,
                "variation": s.variation,
                "min_temp": s.min_temp,
                "max_temp": s.max_temp,
            }
            for s in settings.simulator.sensors
        ],
        "current_temperatures": sensor_simulator.temperatures,
    }


@router.post("/api/simulator/start")
def start_simulator():
    sensor_simulator.start()
    return {"status": "started", "running": sensor_simulator.running}


@router.post("/api/simulator/stop")
def stop_simulator():
    sensor_simulator.stop()
    return {"status": "stopped", "running": sensor_simulator.running}


def _parse_interval(interval: str) -> int:
    """Parse interval string like '15m', '1h', '24h' into minutes."""
    if interval.endswith("m"):
        return int(interval[:-1])
    elif interval.endswith("h"):
        return int(interval[:-1]) * 60
    elif interval.endswith("d"):
        return int(interval[:-1]) * 24 * 60
    else:
        raise ValueError(f"Invalid interval format: {interval}")
