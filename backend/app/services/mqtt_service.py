import json
import logging
import paho.mqtt.client as mqtt
from app.core.config import settings
from app.core.database import SessionLocal
from app.core.timeutil import as_utc
from app.models.sensor import ActivityLog, ReadingSource, RoomStatus, SensorReading
from app.services.alert_service import alert_service
from app.services.anomaly_service import anomaly_service
from app.services.lifecycle import emit_after_commit
from app.services.topology_service import touch_last_seen
from collections.abc import Callable
from datetime import UTC, datetime

logger = logging.getLogger(__name__)


class MQTTService:
    def __init__(self):
        self.client: mqtt.Client | None = None
        self.connected = False
        self._message_handler: Callable | None = None

    def connect(self):
        self.client = mqtt.Client(
            mqtt.CallbackAPIVersion.VERSION2, client_id=settings.mqtt_client_id
        )
        self.client.on_connect = self._on_connect
        self.client.on_message = self._on_message
        self.client.on_disconnect = self._on_disconnect

        # connect_async + loop_start keeps retrying (bounded backoff) when the broker is down
        # at startup or drops later; a blocking connect() would raise and never retry.
        self.client.reconnect_delay_set(min_delay=1, max_delay=10)
        try:
            self.client.connect_async(settings.mqtt_broker, settings.mqtt_port, 60)
            self.client.loop_start()
            logger.info(f"Connecting to MQTT broker at {settings.mqtt_broker}:{settings.mqtt_port}")
        except Exception as e:
            logger.warning(f"Failed to connect to MQTT broker (will retry in background): {e}")

    def disconnect(self):
        if self.client:
            self.client.loop_stop()
            self.client.disconnect()
            self.connected = False
            logger.info("Disconnected from MQTT broker")

    def _on_connect(self, client, userdata, flags, reason_code, properties=None):
        if not reason_code.is_failure:
            self.connected = True
            client.subscribe(settings.mqtt_topic)
            logger.info(f"Connected to MQTT broker, subscribed to {settings.mqtt_topic}")
        else:
            logger.error(f"Failed to connect to MQTT broker: {reason_code}")

    def _on_disconnect(self, client, userdata, flags, reason_code, properties=None):
        self.connected = False
        logger.warning(f"Disconnected from MQTT broker: {reason_code}")

    def _on_message(self, client, userdata, message):
        try:
            payload = message.payload.decode()
            topic_parts = message.topic.split("/")
            room = topic_parts[1] if len(topic_parts) > 1 else "unknown"
            measurement_from_topic = topic_parts[2] if len(topic_parts) > 2 else "temperature"

            try:
                data = json.loads(payload)
                if not isinstance(data, dict):
                    raise ValueError("payload is not an object")
            except ValueError:
                # Legacy format: a bare float temperature
                logger.debug(f"Using legacy payload format for {room}")
                data = {"value": float(payload), "measurement": measurement_from_topic}

            data.setdefault("measurement", measurement_from_topic)
            self.ingest(room, data)

        except Exception as e:
            logger.error(f"Error processing MQTT message: {e}")

    def ingest(self, room: str, data: dict) -> None:
        """Validate one telemetry payload and persist it. Shared by MQTT and in-process publishers."""
        measurement = data.get("measurement", "temperature")
        value = float(data["value"])
        source_str = data.get("source", "simulated")
        source = (
            ReadingSource(source_str)
            if source_str in [s.value for s in ReadingSource]
            else ReadingSource.SIMULATED
        )
        ts_str = data.get("event_timestamp")
        event_timestamp = (
            datetime.fromisoformat(ts_str.replace("Z", "+00:00")) if ts_str else datetime.now(UTC)
        )
        self._process_reading(
            data.get("room", room),
            data.get("sensor_id", f"sensor-{room}"),
            measurement,
            value,
            data.get("unit", "celsius"),
            source,
            as_utc(event_timestamp),
            data.get("idempotency_key"),
        )

    def _process_reading(
        self,
        room: str,
        sensor_id: str,
        measurement: str,
        value: float,
        unit: str,
        source: ReadingSource,
        event_timestamp: datetime,
        idempotency_key: str | None = None,
    ):
        db = SessionLocal()
        try:
            # Check for duplicate using idempotency key if provided
            if idempotency_key:
                existing = (
                    db.query(SensorReading)
                    .filter(SensorReading.idempotency_key == idempotency_key)
                    .first()
                )
                if existing:
                    logger.debug(f"Duplicate reading ignored: {idempotency_key}")
                    return

            reading = SensorReading(
                room=room,
                sensor_id=sensor_id,
                measurement=measurement,
                value=value,
                unit=unit,
                source=source,
                event_timestamp=event_timestamp,
                idempotency_key=idempotency_key,
            )
            db.add(reading)
            touch_last_seen(db, sensor_id, event_timestamp)

            status_value = None
            # Room status is a temperature concept; meters and other measurements skip it.
            if measurement == "temperature":
                status_record = db.query(RoomStatus).filter(RoomStatus.room == room).first()
                if not status_record:
                    status_record = RoomStatus(room=room)
                    db.add(status_record)

                old_status = status_record.status

                # Update latest state only if this reading is newer than what we have
                if (
                    status_record.current_temperature is None
                    or status_record.last_updated is None
                    or event_timestamp >= as_utc(status_record.last_updated)
                ):
                    status_record.current_temperature = value
                    status_record.last_updated = datetime.now(UTC)

                    if value > settings.threshold_high:
                        new_status = "ALERT"
                    elif value > settings.threshold_normal:
                        new_status = "HIGH"
                    else:
                        new_status = "NORMAL"

                    status_record.status = new_status

                    if new_status != old_status:
                        if new_status == "ALERT":
                            message = f"🔴 {room} entered ALERT state at {value}°C"
                        elif new_status == "HIGH":
                            message = f"🟠 {room} entered HIGH temperature state at {value}°C"
                        else:
                            message = f"🟢 {room} returned to NORMAL at {value}°C"
                        db.add(ActivityLog(room=room, message=message, level=new_status))

                        recent_activities = (
                            db.query(ActivityLog)
                            .order_by(ActivityLog.timestamp.desc())
                            .limit(settings.activity_log_limit + 1)
                            .all()
                        )
                        if len(recent_activities) > settings.activity_log_limit:
                            for old_activity in recent_activities[settings.activity_log_limit :]:
                                db.delete(old_activity)
                status_value = status_record.status

            emit_after_commit(
                db,
                "reading",
                {
                    "sensor_id": sensor_id,
                    "room": room,
                    "measurement": measurement,
                    "value": value,
                    "unit": unit,
                    "source": source.value,
                    "event_timestamp": event_timestamp.isoformat(),
                    "room_status": status_value,
                },
            )
            db.commit()
            logger.debug(f"Processed reading: {room}/{sensor_id} = {value}{unit} ({source.value})")

            # Evaluate alert conditions for this reading
            try:
                alert_service.evaluate_reading(
                    room=room,
                    sensor_id=sensor_id,
                    value=value,
                    unit=unit,
                    source=source.value,
                    event_timestamp=event_timestamp,
                    measurement=measurement,
                )
            except Exception as e:
                logger.error(f"Alert evaluation failed for {room}/{sensor_id}: {e}")

            # Evaluate anomaly conditions for this reading (statistical baseline)
            try:
                anomaly_service.evaluate_reading(
                    room=room,
                    sensor_id=sensor_id,
                    value=value,
                    unit=unit,
                    source=source.value,
                    event_timestamp=event_timestamp,
                    measurement=measurement,
                    db=db,
                )
            except Exception as e:
                logger.error(f"Anomaly evaluation failed for {room}/{sensor_id}: {e}")

        except Exception as e:
            db.rollback()
            logger.error(f"Error processing reading: {e}")
        finally:
            db.close()

    def publish(self, topic: str, payload: str):
        if self.client and self.connected:
            self.client.publish(topic, payload)
        else:
            logger.warning("MQTT client not connected, cannot publish")


mqtt_service = MQTTService()
