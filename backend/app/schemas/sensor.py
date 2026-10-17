from datetime import datetime
from enum import StrEnum
from pydantic import BaseModel, Field


class ReadingSource(StrEnum):
    SIMULATED = "simulated"
    MEASURED = "measured"


class RoomStatusEnum(StrEnum):
    NORMAL = "NORMAL"
    HIGH = "HIGH"
    ALERT = "ALERT"


class SensorReadingCreate(BaseModel):
    room: str = Field(..., min_length=1, max_length=50)
    sensor_id: str = Field(..., min_length=1, max_length=50)
    measurement: str = Field(default="temperature", min_length=1, max_length=50)
    value: float = Field(..., ge=-100, le=200)
    unit: str = Field(default="celsius", min_length=1, max_length=20)
    source: ReadingSource = Field(default=ReadingSource.SIMULATED)
    event_timestamp: datetime
    idempotency_key: str | None = Field(default=None, max_length=100)


class SensorReadingResponse(BaseModel):
    id: int
    room: str
    sensor_id: str
    measurement: str
    value: float
    unit: str
    source: ReadingSource
    event_timestamp: datetime
    ingestion_timestamp: datetime
    idempotency_key: str | None = None

    class Config:
        from_attributes = True


class RoomStatusResponse(BaseModel):
    room: str
    status: RoomStatusEnum
    current_temperature: float | None = None
    last_updated: datetime

    class Config:
        from_attributes = True


class ActivityLogResponse(BaseModel):
    id: int
    room: str
    message: str
    level: str
    timestamp: datetime

    class Config:
        from_attributes = True


class LatestDataResponse(BaseModel):
    room: str
    temperature: float
    status: RoomStatusEnum


class HistoryResponse(BaseModel):
    room: str
    readings: list[SensorReadingResponse]


class HealthResponse(BaseModel):
    status: str
    version: str
    database: str
    mqtt: str


# Aggregation schemas
class AggregateBucket(BaseModel):
    bucket_start: datetime
    bucket_end: datetime
    avg_value: float | None = None
    min_value: float | None = None
    max_value: float | None = None
    count: int
    unit: str
    room: str
    sensor_id: str
    measurement: str
    source: ReadingSource | None = None


class AggregateResponse(BaseModel):
    room: str
    sensor_id: str
    measurement: str
    interval: str
    buckets: list[AggregateBucket]
    total_count: int


class BuildingRoomResponse(BaseModel):
    id: str
    name: str
    floor: int
    position_x: float
    position_y: float
    position_z: float
    size_x: float
    size_y: float
    size_z: float
    sensor_id: str | None = None


class BuildingFloorResponse(BaseModel):
    level: int
    name: str
    height: float
    rooms: list[BuildingRoomResponse]


class BuildingLayoutResponse(BaseModel):
    floors: list[BuildingFloorResponse]
    dimensions: dict[str, float]
