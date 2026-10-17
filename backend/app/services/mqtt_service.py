import json
import logging
import paho.mqtt.client as mqtt
from app.core.config import settings
from app.core.database import SessionLocal
from app.models.sensor import ActivityLog, ReadingSource, RoomStatus, SensorReading
from app.services.alert_service import alert_service
from app.services.anomaly_service import anomaly_service
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

        try:
            self.client.connect(settings.mqtt_broker, settings.mqtt_port, 60)
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

            # Try to parse as JSON first (new format)
            try:
                data = json.loads(payload)
                sensor_id = data.get("sensor_id", f"sensor-{room}")
                measurement = data.get("measurement", "temperature")
                value = float(data.get("value", 0))
                unit = data.get("unit", "celsius")
                source_str = data.get("source", "simulated")
                source = (
                    ReadingSource(source_str)
                    if source_str in [s.value for s in ReadingSource]
                    else ReadingSource.SIMULATED
                )
                event_timestamp_str = data.get("event_timestamp")
                if event_timestamp_str:
                    event_timestamp = datetime.fromisoformat(
                        event_timestamp_str.replace("Z", "+00:00")
                    )
                else:
                    event_timestamp = datetime.now(UTC)
                idempotency_key = data.get("idempotency_key")
            except (json.JSONDecodeError, ValueError, KeyError):
                # Fallback to old format: plain float temperature
                logger.debug(f"Using legacy payload format for {room}")
                value = float(payload)
                sensor_id = f"sensor-{room}"
                measurement = "temperature"
                unit = "celsius"
                source = ReadingSource.SIMULATED
                event_timestamp = datetime.now(UTC)
                idempotency_key = None

            self._process_reading(
                room, sensor_id, measurement, value, unit, source, event_timestamp, idempotency_key
            )

        except Exception as e:
            logger.error(f"Error processing MQTT message: {e}")

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

            status_record = db.query(RoomStatus).filter(RoomStatus.room == room).first()
            if not status_record:
                status_record = RoomStatus(room=room)
                db.add(status_record)

            old_status = status_record.status

            # Update latest state only if this reading is newer than what we have
            if measurement == "temperature" and (
                status_record.current_temperature is None
                or event_timestamp
                >= (status_record.last_updated or datetime.min.replace(tzinfo=UTC))
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
                        level = "ALERT"
                    elif new_status == "HIGH":
                        message = f"🟠 {room} entered HIGH temperature state at {value}°C"
                        level = "HIGH"
                    else:
                        message = f"🟢 {room} returned to NORMAL at {value}°C"
                        level = "NORMAL"

                    activity = ActivityLog(room=room, message=message, level=level)
                    db.add(activity)

                    recent_activities = (
                        db.query(ActivityLog)
                        .order_by(ActivityLog.timestamp.desc())
                        .limit(settings.activity_log_limit + 1)
                        .all()
                    )
                    if len(recent_activities) > settings.activity_log_limit:
                        for old_activity in recent_activities[settings.activity_log_limit :]:
                            db.delete(old_activity)

            db.commit()
            logger.info(
                f"Processed reading: {room}/{sensor_id} = {value}{unit} (source: {source.value}, status: {status_record.status})"
            )

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
