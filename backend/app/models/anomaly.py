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


class AnomalyCategory(StrEnum):
    Z_SCORE_SPIKE = "z_score_spike"
    Z_SCORE_DROP = "z_score_drop"
    SUSTAINED_DEVIATION = "sustained_deviation"


class AnomalySeverity(StrEnum):
    INFO = "INFO"
    WARNING = "WARNING"
    CRITICAL = "CRITICAL"


class AnomalyStatus(StrEnum):
    OPEN = "OPEN"
    ACKNOWLEDGED = "ACKNOWLEDGED"
    RESOLVED = "RESOLVED"


class AnomalyEvent(Base):
    __tablename__ = "anomaly_events"

    id = Column(Integer, primary_key=True, autoincrement=True)
    room = Column(String(50), nullable=False, index=True)
    sensor_id = Column(String(50), nullable=False, index=True)
    anomaly_category = Column(SQLEnum(AnomalyCategory), nullable=False, index=True)
    severity = Column(SQLEnum(AnomalySeverity), nullable=False, index=True)
    title = Column(String(200), nullable=False)
    description = Column(Text, nullable=False)
    status = Column(SQLEnum(AnomalyStatus), nullable=False, default=AnomalyStatus.OPEN, index=True)
    detected_at = Column(DateTime(timezone=True), nullable=False)
    last_observed_at = Column(DateTime(timezone=True), nullable=False)
    acknowledged_at = Column(DateTime(timezone=True), nullable=True)
    acknowledged_by = Column(String(100), nullable=True)
    resolved_at = Column(DateTime(timezone=True), nullable=True)
    observed_value = Column(Float, nullable=False)
    expected_baseline = Column(Float, nullable=False)
    deviation_score = Column(Float, nullable=False)
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
        Index("ix_anomalies_room_status", "room", "status"),
        Index("ix_anomalies_sensor_status", "sensor_id", "status"),
        Index("ix_anomalies_category_status", "anomaly_category", "status"),
    )
