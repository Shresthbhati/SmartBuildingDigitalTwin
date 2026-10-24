from app.core.database import Base
from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    UniqueConstraint,
)
from sqlalchemy.orm import relationship


class Building(Base):
    __tablename__ = "buildings"

    id = Column(Integer, primary_key=True, autoincrement=True)
    code = Column(String(50), nullable=False, unique=True)
    name = Column(String(200), nullable=False)
    timezone = Column(String(64), nullable=False, default="UTC")

    floors = relationship("Floor", back_populates="building", order_by="Floor.level")


class Floor(Base):
    __tablename__ = "floors"

    id = Column(Integer, primary_key=True, autoincrement=True)
    building_id = Column(Integer, ForeignKey("buildings.id"), nullable=False, index=True)
    level = Column(Integer, nullable=False)
    name = Column(String(100), nullable=False)
    elevation_m = Column(Float, nullable=False, default=0.0)
    height_m = Column(Float, nullable=False, default=4.0)

    building = relationship("Building", back_populates="floors")
    rooms = relationship("Room", back_populates="floor", order_by="Room.code")
    assets = relationship("Asset", back_populates="floor", order_by="Asset.code")

    __table_args__ = (UniqueConstraint("building_id", "level", name="uq_floor_building_level"),)


class Room(Base):
    __tablename__ = "rooms"

    id = Column(Integer, primary_key=True, autoincrement=True)
    floor_id = Column(Integer, ForeignKey("floors.id"), nullable=False, index=True)
    code = Column(String(50), nullable=False, unique=True)
    name = Column(String(100), nullable=False)
    x = Column(Float, nullable=False)
    z = Column(Float, nullable=False)
    width = Column(Float, nullable=False, default=5.0)
    depth = Column(Float, nullable=False, default=5.0)

    floor = relationship("Floor", back_populates="rooms")
    sensors = relationship("Sensor", back_populates="room", order_by="Sensor.sensor_id")
    assets = relationship("Asset", back_populates="room")


class Asset(Base):
    """Equipment the user can inspect (HVAC, AHU, meter, ...). Lives on a floor, optionally in a room."""

    __tablename__ = "assets"

    id = Column(Integer, primary_key=True, autoincrement=True)
    floor_id = Column(Integer, ForeignKey("floors.id"), nullable=False, index=True)
    room_id = Column(Integer, ForeignKey("rooms.id"), nullable=True, index=True)
    code = Column(String(50), nullable=False, unique=True)
    kind = Column(String(50), nullable=False)
    name = Column(String(100), nullable=False)
    x = Column(Float, nullable=False)
    z = Column(Float, nullable=False)

    floor = relationship("Floor", back_populates="assets")
    room = relationship("Room", back_populates="assets")
    sensors = relationship("Sensor", back_populates="asset", order_by="Sensor.sensor_id")


class Sensor(Base):
    __tablename__ = "sensors"

    id = Column(Integer, primary_key=True, autoincrement=True)
    room_id = Column(Integer, ForeignKey("rooms.id"), nullable=True, index=True)
    asset_id = Column(Integer, ForeignKey("assets.id"), nullable=True, index=True)
    sensor_id = Column(String(50), nullable=False, unique=True)
    type = Column(String(50), nullable=False, default="temperature")
    unit = Column(String(20), nullable=False, default="celsius")
    source = Column(String(20), nullable=False, default="simulated")
    enabled = Column(Boolean, nullable=False, default=True)
    last_seen_at = Column(DateTime(timezone=True), nullable=True)
    # Simulation parameters; meaningful only when source == "simulated".
    baseline = Column(Float, nullable=True)
    variation = Column(Float, nullable=True)
    min_value = Column(Float, nullable=True)
    max_value = Column(Float, nullable=True)

    room = relationship("Room", back_populates="sensors")
    asset = relationship("Asset", back_populates="sensors")

    @property
    def location_code(self) -> str | None:
        """The code used as `room` in telemetry: the room code, or the asset code for meters."""
        if self.room is not None:
            return self.room.code
        if self.asset is not None:
            return self.asset.code
        return None

    @property
    def floor_level(self) -> int | None:
        owner = self.room or self.asset
        return owner.floor.level if owner is not None else None
