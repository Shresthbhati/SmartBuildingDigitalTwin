from app.core.database import Base
from enum import StrEnum
from sqlalchemy import (
    Column,
    DateTime,
    Float,
    Index,
    Integer,
    String,
    Text,
)
from sqlalchemy import Enum as SQLEnum
from sqlalchemy.sql import func


class AlertStatus(StrEnum):
    OPEN = "OPEN"
    ACKNOWLEDGED = "ACKNOWLEDGED"
    RESOLVED = "RESOLVED"


class AlertSeverity(StrEnum):
    INFO = "INFO"
    WARNING = "WARNING"
    CRITICAL = "CRITICAL"


class AlertType(StrEnum):
    HIGH_TEMPERATURE = "high_temperature"
    CRITICAL_TEMPERATURE = "critical_temperature"
    LOW_TEMPERATURE = "low_temperature"
    STALE_SENSOR = "stale_sensor"
    CONNECTIVITY_LOSS = "connectivity_loss"
    INVALID_READING = "invalid_reading"


class Alert(Base):
    __tablename__ = "alerts"

    id = Column(Integer, primary_key=True, autoincrement=True)
    room = Column(String(50), nullable=False, index=True)
    sensor_id = Column(String(50), nullable=False, index=True)
    alert_type = Column(SQLEnum(AlertType), nullable=False, index=True)
    severity = Column(SQLEnum(AlertSeverity), nullable=False, index=True)
    title = Column(String(200), nullable=False)
    description = Column(Text, nullable=False)
    status = Column(SQLEnum(AlertStatus), nullable=False, default=AlertStatus.OPEN, index=True)
    first_occurrence = Column(DateTime(timezone=True), nullable=False)
    last_occurrence = Column(DateTime(timezone=True), nullable=False)
    acknowledged_at = Column(DateTime(timezone=True), nullable=True)
    acknowledged_by = Column(String(100), nullable=True)
    resolved_at = Column(DateTime(timezone=True), nullable=True)
    last_reading_value = Column(Float, nullable=True)
    threshold_value = Column(Float, nullable=True)
    occurrence_count = Column(Integer, nullable=False, default=1)
    metadata_json = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at = Column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    __table_args__ = (
        Index("ix_alerts_room_status", "room", "status"),
        Index("ix_alerts_sensor_status", "sensor_id", "status"),
        Index("ix_alerts_type_status", "alert_type", "status"),
    )
