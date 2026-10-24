# Import every model module so `Base.metadata` is complete (create_all, Alembic autogenerate).
from app.models.alert import Alert
from app.models.anomaly import AnomalyEvent
from app.models.lifecycle import EventLifecycleEvent
from app.models.scenario import ScenarioRun
from app.models.sensor import ActivityLog, RoomStatus, SensorReading
from app.models.topology import Asset, Building, Floor, Room, Sensor

__all__ = [
    "ActivityLog",
    "Alert",
    "AnomalyEvent",
    "Asset",
    "Building",
    "EventLifecycleEvent",
    "Floor",
    "Room",
    "RoomStatus",
    "ScenarioRun",
    "Sensor",
    "SensorReading",
]
