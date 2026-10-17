import logging
import math
import threading
import time
from app.core.config import settings
from app.core.database import SessionLocal
from app.models.alert import Alert, AlertSeverity, AlertStatus, AlertType
from datetime import UTC, datetime, timedelta
from sqlalchemy import func
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)


class AlertService:
    """Configuration-driven alert evaluation engine with persistent lifecycle.

    Evaluates telemetry readings against configurable thresholds with hysteresis,
    persists alerts to SQLite, and manages the OPEN -> ACKNOWLEDGED -> RESOLVED
    lifecycle. A separate periodic worker detects stale sensors even when no
    new telemetry arrives.
    """

    def __init__(self):
        self.running = False
        self.thread: threading.Thread | None = None
        self.last_run: datetime | None = None
        self.last_deleted_count: int = 0
        self.last_error: str | None = None
        self._lock = threading.Lock()
        self._stale_sensor_cache: dict[str, datetime] = {}

    # ------------------------------------------------------------------ #
    # Lifecycle (start/stop) – same pattern as RetentionService/Simulator #
    # ------------------------------------------------------------------ #
    def start(self):
        if self.running:
            logger.warning("Alert service already running")
            return
        if not settings.alerts.enabled:
            logger.info("Alert service disabled in config")
            return
        self.running = True
        self.thread = threading.Thread(target=self._run_loop, daemon=True)
        self.thread.start()
        logger.info(
            f"Alert service started: eval_interval={settings.alerts.evaluation_interval_seconds}s, "
            f"stale_sensor_seconds={settings.alerts.stale_sensor_seconds}"
        )

    def stop(self):
        if not self.running:
            return
        self.running = False
        if self.thread:
            self.thread.join(timeout=10)
            self.thread = None
        logger.info("Alert service stopped")

    def _run_loop(self):
        while self.running:
            start_time = time.time()
            try:
                self.evaluate_stale_sensors()
            except Exception as e:
                logger.error(f"Error in alert stale-sensor loop: {e}")
                with self._lock:
                    self.last_error = str(e)
            elapsed = time.time() - start_time
            sleep_seconds = max(0, settings.alerts.evaluation_interval_seconds - elapsed)
            while sleep_seconds > 0 and self.running:
                sleep_chunk = min(5, sleep_seconds)
                time.sleep(sleep_chunk)
                sleep_seconds -= sleep_chunk

    # ------------------------------------------------------------------ #
    # Public evaluation entry points                                      #
    # ------------------------------------------------------------------ #
    def evaluate_reading(
        self,
        room: str,
        sensor_id: str,
        value: float,
        unit: str = "celsius",
        source: str = "simulated",
        event_timestamp: datetime | None = None,
        measurement: str = "temperature",
        db: Session | None = None,
    ) -> None:
        """Evaluate a single telemetry reading and update alert state.

        Idempotent: calling repeatedly with the same condition updates the
        existing alert rather than creating duplicates.
        """
        own_session = False
        if db is None:
            db = SessionLocal()
            own_session = True

        if event_timestamp is None:
            event_timestamp = datetime.now(UTC)

        try:
            # 1. Invalid / out-of-range readings
            if self._is_invalid_reading(value, measurement):
                self._handle_invalid_reading(db, room, sensor_id, value, unit, event_timestamp)
                return

            # 2. Clear any existing invalid-reading alert for this sensor
            self._resolve_alert_by_type(db, room, sensor_id, AlertType.INVALID_READING, actor=None)

            # 3. Clear any stale-sensor alert (we just heard from this sensor)
            self._resolve_alert_by_type(db, room, sensor_id, AlertType.STALE_SENSOR, actor=None)
            self._stale_sensor_cache.pop(room, None)

            # 4. Temperature-based alerts with hysteresis
            if measurement == "temperature":
                self._evaluate_temperature(db, room, sensor_id, value, event_timestamp)

            db.commit()
        except Exception as e:
            db.rollback()
            logger.error(f"Error evaluating reading for {room}/{sensor_id}: {e}")
            raise
        finally:
            if own_session:
                db.close()

    def evaluate_stale_sensors(self, db: Session | None = None) -> None:
        """Mark sensors as stale if no reading has arrived within the threshold.

        Runs on a timer; does not require new telemetry.
        """
        own_session = False
        if db is None:
            db = SessionLocal()
            own_session = True

        now = datetime.now(UTC)
        stale_threshold = timedelta(seconds=settings.alerts.stale_sensor_seconds)

        try:
            # Gather the most recent reading timestamp per room/sensor
            latest_by_room: dict[str, datetime] = {}

            from app.models.sensor import SensorReading
            from sqlalchemy import func

            subq = (
                db.query(
                    SensorReading.room,
                    func.max(SensorReading.event_timestamp).label("latest"),
                )
                .group_by(SensorReading.room)
                .subquery()
            )
            rows = db.query(subq).all()
            for row in rows:
                latest_by_room[row.room] = row.latest

            # Also include rooms with no readings at all
            from app.core.config import settings as _s

            for room in _s.simulation_rooms:
                if room not in latest_by_room:
                    self._handle_stale_sensor(db, room, None, now)
                else:
                    last = latest_by_room[room]
                    if now - last > stale_threshold:
                        self._handle_stale_sensor(db, room, None, now)
                    else:
                        self._resolve_alert_by_type(
                            db, room, None, AlertType.STALE_SENSOR, actor=None
                        )

            db.commit()
        except Exception as e:
            db.rollback()
            logger.error(f"Error in stale sensor evaluation: {e}")
            raise
        finally:
            if own_session:
                db.close()

    # ------------------------------------------------------------------ #
    # Lifecycle transitions                                               #
    # ------------------------------------------------------------------ #
    def acknowledge_alert(
        self,
        alert_id: int,
        actor: str | None = None,
        db: Session | None = None,
    ) -> Alert | None:
        own_session = False
        if db is None:
            db = SessionLocal()
            own_session = True
        try:
            alert = db.query(Alert).filter(Alert.id == alert_id).first()
            if not alert:
                return None
            if alert.status == AlertStatus.RESOLVED:
                raise ValueError("Cannot acknowledge a resolved alert")
            alert.status = AlertStatus.ACKNOWLEDGED
            alert.acknowledged_at = datetime.now(UTC)
            alert.acknowledged_by = actor
            alert.updated_at = datetime.now(UTC)
            db.commit()
            db.refresh(alert)
            return alert
        except Exception:
            db.rollback()
            raise
        finally:
            if own_session:
                db.close()

    def resolve_alert(
        self,
        alert_id: int,
        actor: str | None = None,
        db: Session | None = None,
    ) -> Alert | None:
        own_session = False
        if db is None:
            db = SessionLocal()
            own_session = True
        try:
            alert = db.query(Alert).filter(Alert.id == alert_id).first()
            if not alert:
                return None
            if alert.status == AlertStatus.RESOLVED:
                raise ValueError("Alert is already resolved")
            alert.status = AlertStatus.RESOLVED
            alert.resolved_at = datetime.now(UTC)
            alert.updated_at = datetime.now(UTC)
            db.commit()
            db.refresh(alert)
            return alert
        except Exception:
            db.rollback()
            raise
        finally:
            if own_session:
                db.close()

    # ------------------------------------------------------------------ #
    # Queries                                                             #
    # ------------------------------------------------------------------ #
    def get_alert(
        self,
        alert_id: int,
        db=None,
    ) -> Alert | None:
        own_session = False
        if db is None:
            db = SessionLocal()
            own_session = True
        try:
            return db.query(Alert).filter(Alert.id == alert_id).first()
        finally:
            if own_session:
                db.close()

    def get_alerts(self, filters: dict, db=None) -> list[Alert]:
        own_session = False
        if db is None:
            db = SessionLocal()
            own_session = True
        try:
            query = db.query(Alert)
            if filters.get("room"):
                query = query.filter(Alert.room == filters["room"])
            if filters.get("sensor_id"):
                query = query.filter(Alert.sensor_id == filters["sensor_id"])
            if filters.get("alert_type"):
                query = query.filter(Alert.alert_type == filters["alert_type"])
            if filters.get("severity"):
                query = query.filter(Alert.severity == filters["severity"])
            if filters.get("status"):
                query = query.filter(Alert.status == filters["status"])

            sort_by = filters.get("sort_by", "last_occurrence")
            sort_order = filters.get("sort_order", "desc")
            sort_col = getattr(Alert, sort_by, Alert.last_occurrence)
            if sort_order == "asc":
                query = query.order_by(sort_col.asc())
            else:
                query = query.order_by(sort_col.desc())

            limit = int(filters.get("limit", 50))
            offset = int(filters.get("offset", 0))
            query = query.limit(limit).offset(offset)
            return query.all()
        finally:
            if own_session:
                db.close()

    def get_alert_counts(self, db=None) -> dict:
        own_session = False
        if db is None:
            db = SessionLocal()
            own_session = True
        try:
            total = db.query(Alert).count()

            by_severity_rows = (
                db.query(Alert.severity, func.count(Alert.id)).group_by(Alert.severity).all()
            )
            by_status_rows = (
                db.query(Alert.status, func.count(Alert.id)).group_by(Alert.status).all()
            )

            return {
                "total": total,
                "by_severity": [
                    {"severity": sev.value, "count": cnt} for sev, cnt in by_severity_rows
                ],
                "by_status": [{"status": st.value, "count": cnt} for st, cnt in by_status_rows],
            }
        finally:
            if own_session:
                db.close()

    # ------------------------------------------------------------------ #
    # Internal evaluation helpers                                         #
    # ------------------------------------------------------------------ #
    def _is_invalid_reading(self, value: float, measurement: str) -> bool:
        if value is None or not math.isfinite(value):
            return True
        return measurement == "temperature" and (
            value < settings.temp_min or value > settings.temp_max
        )

    def _handle_invalid_reading(
        self,
        db,
        room: str,
        sensor_id: str,
        value: float,
        unit: str,
        event_timestamp: datetime,
    ) -> None:
        alert = self._find_active_alert(db, room, sensor_id, AlertType.INVALID_READING)
        if alert:
            alert.last_occurrence = event_timestamp
            alert.last_reading_value = value
            alert.occurrence_count = min(
                alert.occurrence_count + 1, settings.alerts.max_occurrence_count
            )
            alert.description = (
                f"Invalid {unit} reading of {value} received from {sensor_id} in {room}"
            )
            alert.threshold_value = None
            alert.severity = AlertSeverity.WARNING
            alert.updated_at = datetime.now(UTC)
            return

        self._create_alert(
            db=db,
            room=room,
            sensor_id=sensor_id,
            alert_type=AlertType.INVALID_READING,
            severity=AlertSeverity.WARNING,
            title=f"Invalid reading in {room}",
            description=(f"Received invalid {unit} reading of {value} from sensor {sensor_id}"),
            event_timestamp=event_timestamp,
            reading_value=value,
            threshold_value=None,
        )

    def _evaluate_temperature(
        self, db, room: str, sensor_id: str, value: float, event_timestamp: datetime
    ) -> None:
        cfg = settings.alerts.temperature
        warn = cfg.warning
        crit = cfg.critical
        rec = cfg.recovery
        gap = settings.alerts.hysteresis.threshold_gap
        hyst = settings.alerts.hysteresis.enabled

        # Validate threshold ordering
        if rec >= warn:
            raise ValueError(f"Alert config error: recovery ({rec}) must be < warning ({warn})")
        if warn >= crit:
            raise ValueError(f"Alert config error: warning ({warn}) must be < critical ({crit})")

        # Determine desired severity from raw value
        if value > crit:
            desired_severity = AlertSeverity.CRITICAL
            desired_type = AlertType.CRITICAL_TEMPERATURE
        elif value > warn:
            desired_severity = AlertSeverity.WARNING
            desired_type = AlertType.HIGH_TEMPERATURE
        else:
            desired_severity = None
            desired_type = None

        active = self._find_active_alert(db, room, sensor_id, AlertType.HIGH_TEMPERATURE)
        critical_active = self._find_active_alert(
            db, room, sensor_id, AlertType.CRITICAL_TEMPERATURE
        )

        # No active temperature alert
        if not active and not critical_active:
            if desired_severity is None:
                return  # All normal, nothing to do
            self._create_alert(
                db=db,
                room=room,
                sensor_id=sensor_id,
                alert_type=desired_type,
                severity=desired_severity,
                title=f"{desired_severity.value.title()} temperature in {room}",
                description=(
                    f"Temperature {value}°C exceeds "
                    f"{'critical' if desired_severity == AlertSeverity.CRITICAL else 'warning'} "
                    f"threshold"
                ),
                event_timestamp=event_timestamp,
                reading_value=value,
                threshold_value=crit if desired_severity == AlertSeverity.CRITICAL else warn,
            )
            return

        # We have an active alert; apply hysteresis
        if critical_active:
            alert = critical_active
            if value < rec:
                # Recovered below recovery threshold
                self._resolve_alert_obj(db, alert)
            elif hyst and value < crit - gap:
                # De-escalate critical -> warning
                alert.alert_type = AlertType.HIGH_TEMPERATURE
                alert.severity = AlertSeverity.WARNING
                alert.title = f"Warning temperature in {room}"
                alert.description = (
                    f"Temperature {value}°C is above warning threshold "
                    f"but below critical (de-escalated from critical)"
                )
                alert.threshold_value = warn
                alert.last_occurrence = event_timestamp
                alert.last_reading_value = value
                alert.occurrence_count = min(
                    alert.occurrence_count + 1, settings.alerts.max_occurrence_count
                )
                alert.updated_at = datetime.now(UTC)
                # Keep acknowledgment history if any
            else:
                # Stay critical; update occurrence metadata
                alert.last_occurrence = event_timestamp
                alert.last_reading_value = value
                alert.occurrence_count = min(
                    alert.occurrence_count + 1, settings.alerts.max_occurrence_count
                )
                alert.updated_at = datetime.now(UTC)
        elif active:
            alert = active
            if desired_severity == AlertSeverity.CRITICAL:
                # Escalate warning -> critical
                alert.alert_type = AlertType.CRITICAL_TEMPERATURE
                alert.severity = AlertSeverity.CRITICAL
                alert.title = f"Critical temperature in {room}"
                alert.description = f"Temperature {value}°C exceeds critical threshold of {crit}°C"
                alert.threshold_value = crit
                alert.last_occurrence = event_timestamp
                alert.last_reading_value = value
                alert.occurrence_count = min(
                    alert.occurrence_count + 1, settings.alerts.max_occurrence_count
                )
                alert.updated_at = datetime.now(UTC)
                # Keep acknowledgment history if any
            elif value < rec:
                # Recovered below recovery threshold
                self._resolve_alert_obj(db, alert)
            else:
                # Stay warning (hysteresis band: rec <= value < warn)
                alert.last_occurrence = event_timestamp
                alert.last_reading_value = value
                alert.occurrence_count = min(
                    alert.occurrence_count + 1, settings.alerts.max_occurrence_count
                )
                alert.updated_at = datetime.now(UTC)

    def _handle_stale_sensor(
        self, db, room: str, sensor_id: str | None, event_timestamp: datetime
    ) -> None:
        effective_sensor = sensor_id or f"sensor-{room}"
        alert = self._find_active_alert(db, room, effective_sensor, AlertType.STALE_SENSOR)
        if alert:
            alert.last_occurrence = event_timestamp
            alert.occurrence_count = min(
                alert.occurrence_count + 1, settings.alerts.max_occurrence_count
            )
            alert.description = f"No telemetry received for {room} since last known reading"
            alert.updated_at = datetime.now(UTC)
            return

        self._create_alert(
            db=db,
            room=room,
            sensor_id=effective_sensor,
            alert_type=AlertType.STALE_SENSOR,
            severity=AlertSeverity.WARNING,
            title=f"Stale sensor in {room}",
            description=f"No telemetry received for room {room}",
            event_timestamp=event_timestamp,
            reading_value=None,
            threshold_value=None,
        )

    def _resolve_alert_by_type(
        self,
        db,
        room: str,
        sensor_id: str | None,
        alert_type: AlertType,
        actor: str | None = None,
    ) -> None:
        alert = self._find_active_alert(db, room, sensor_id or "", alert_type)
        if alert:
            self._resolve_alert_obj(db, alert, actor=actor)

    def _resolve_alert_obj(self, db, alert: Alert, actor: str | None = None) -> None:
        alert.status = AlertStatus.RESOLVED
        alert.resolved_at = datetime.now(UTC)
        alert.updated_at = datetime.now(UTC)

    # ------------------------------------------------------------------ #
    # Internal CRUD helpers                                               #
    # ------------------------------------------------------------------ #
    def _find_active_alert(
        self, db, room: str, sensor_id: str, alert_type: AlertType
    ) -> Alert | None:
        """Find an OPEN or ACKNOWLEDGED alert for the given room/sensor/type.

        A RESOLVED alert is not considered active; a new incident is created
        instead when the condition recurs.
        """
        return (
            db.query(Alert)
            .filter(Alert.room == room)
            .filter(Alert.sensor_id == sensor_id)
            .filter(Alert.alert_type == alert_type)
            .filter(Alert.status.in_([AlertStatus.OPEN, AlertStatus.ACKNOWLEDGED]))
            .first()
        )

    def _create_alert(
        self,
        db,
        room: str,
        sensor_id: str,
        alert_type: AlertType,
        severity: AlertSeverity,
        title: str,
        description: str,
        event_timestamp: datetime,
        reading_value: float | None,
        threshold_value: float | None,
    ) -> Alert:
        alert = Alert(
            room=room,
            sensor_id=sensor_id,
            alert_type=alert_type,
            severity=severity,
            title=title,
            description=description,
            status=AlertStatus.OPEN,
            first_occurrence=event_timestamp,
            last_occurrence=event_timestamp,
            last_reading_value=reading_value,
            threshold_value=threshold_value,
            occurrence_count=1,
            metadata_json=None,
        )
        db.add(alert)
        db.flush()
        logger.info(f"Alert created: {room}/{sensor_id} {alert_type.value} {severity.value}")
        return alert


alert_service = AlertService()
