from app.core.database import Base
from enum import StrEnum
from sqlalchemy import Column, DateTime, Float, Index, Integer, String
from sqlalchemy import Enum as SQLEnum
from sqlalchemy.sql import func


class ReadingSource(StrEnum):
    SIMULATED = "simulated"
    MEASURED = "measured"
    SCENARIO = "scenario"  # deliberately injected by the demo/E2E scenario endpoint


class SensorReading(Base):
    __tablename__ = "sensor_readings"

    id = Column(Integer, primary_key=True)
    room = Column(String(50), nullable=False)
    sensor_id = Column(String(50), nullable=False)
    measurement = Column(String(50), nullable=False, default="temperature")
    value = Column(Float, nullable=False)
    unit = Column(String(20), nullable=False, default="celsius")
    source = Column(SQLEnum(ReadingSource), nullable=False, default=ReadingSource.SIMULATED)
    event_timestamp = Column(DateTime(timezone=True), nullable=False)
    ingestion_timestamp = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    idempotency_key = Column(String(100), nullable=True, unique=True)

    __table_args__ = (
        Index("ix_sensor_readings_room", "room"),
        Index("ix_sensor_readings_sensor", "sensor_id"),
        Index("ix_sensor_readings_measurement", "measurement"),
        Index("ix_sensor_readings_event_timestamp", "event_timestamp"),
        Index("ix_sensor_readings_room_sensor", "room", "sensor_id"),
        Index("ix_sensor_readings_room_measurement", "room", "measurement"),
        Index("ix_sensor_readings_sensor_timestamp", "sensor_id", "event_timestamp"),
        Index("ix_sensor_readings_idempotency_key", "idempotency_key"),
    )


class RoomStatus(Base):
    __tablename__ = "room_status"

    room = Column(String(50), primary_key=True)
    status = Column(String(20), nullable=False, default="NORMAL")
    current_temperature = Column(Float, nullable=True)
    last_updated = Column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )


class ActivityLog(Base):
    __tablename__ = "activity_log"

    id = Column(Integer, primary_key=True)
    room = Column(String(50), nullable=False)
    message = Column(String(500), nullable=False)
    level = Column(String(20), nullable=False)
    timestamp = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    __table_args__ = (
        Index("ix_activity_log_room", "room"),
        Index("ix_activity_log_timestamp", "timestamp"),
    )
