from app.core.config import TopologyConfig, TopologySensorConfig, settings
from app.core.timeutil import as_utc, iso
from app.models.topology import Asset, Building, Floor, Room, Sensor
from dataclasses import dataclass
from datetime import datetime
from sqlalchemy.orm import Session


@dataclass(frozen=True)
class SimSensor:
    sensor_id: str
    location: str  # room code or asset code: the `room` field of telemetry
    type: str
    unit: str
    baseline: float
    variation: float
    min_value: float
    max_value: float


def _upsert(db: Session, model, filters: dict, values: dict):
    row = db.query(model).filter_by(**filters).first()
    if row is None:
        row = model(**filters, **values)
        db.add(row)
    else:
        for key, val in values.items():
            setattr(row, key, val)
    db.flush()
    return row


def _upsert_sensor(
    db: Session, cfg: TopologySensorConfig, room: Room | None, asset: Asset | None
) -> None:
    _upsert(
        db,
        Sensor,
        {"sensor_id": cfg.sensor_id},
        {
            "room_id": room.id if room else None,
            "asset_id": asset.id if asset else None,
            "type": cfg.type,
            "unit": cfg.unit,
            "source": cfg.source,
            "enabled": cfg.enabled,
            "baseline": cfg.baseline,
            "variation": cfg.variation,
            "min_value": cfg.min_value,
            "max_value": cfg.max_value,
        },
    )


def seed_topology(db: Session, topo: TopologyConfig | None = None) -> None:
    """Idempotent upsert of the configured topology. Config is the source of truth for
    structure and simulation parameters; runtime state (`last_seen_at`) is preserved."""
    topo = topo or settings.topology
    building = _upsert(
        db,
        Building,
        {"code": topo.building.code},
        {"name": topo.building.name, "timezone": topo.building.timezone},
    )
    for f in topo.floors:
        floor = _upsert(
            db,
            Floor,
            {"building_id": building.id, "level": f.level},
            {"name": f.name, "elevation_m": f.elevation_m, "height_m": f.height_m},
        )
        rooms_by_code: dict[str, Room] = {}
        for r in f.rooms:
            room = _upsert(
                db,
                Room,
                {"code": r.code},
                {
                    "floor_id": floor.id,
                    "name": r.name,
                    "x": r.x,
                    "z": r.z,
                    "width": r.width,
                    "depth": r.depth,
                },
            )
            rooms_by_code[r.code] = room
            for s in r.sensors:
                _upsert_sensor(db, s, room, None)
        for a in f.assets:
            room = rooms_by_code.get(a.room) if a.room else None
            asset = _upsert(
                db,
                Asset,
                {"code": a.code},
                {
                    "floor_id": floor.id,
                    "room_id": room.id if room else None,
                    "kind": a.kind,
                    "name": a.name,
                    "x": a.x,
                    "z": a.z,
                },
            )
            for s in a.sensors:
                _upsert_sensor(db, s, None, asset)
    db.commit()


def sensor_dict(s: Sensor) -> dict:
    return {
        "sensor_id": s.sensor_id,
        "type": s.type,
        "unit": s.unit,
        "source": s.source,
        "enabled": s.enabled,
        "last_seen_at": iso(s.last_seen_at),
        "location": s.location_code,
        "floor": s.floor_level,
    }


def get_topology_tree(db: Session) -> dict:
    building = db.query(Building).order_by(Building.id).first()
    if building is None:
        return {"building": None, "floors": []}
    return {
        "building": {"code": building.code, "name": building.name, "timezone": building.timezone},
        "floors": [
            {
                "level": f.level,
                "name": f.name,
                "elevation_m": f.elevation_m,
                "height_m": f.height_m,
                "rooms": [
                    {
                        "code": r.code,
                        "name": r.name,
                        "x": r.x,
                        "z": r.z,
                        "width": r.width,
                        "depth": r.depth,
                        "sensors": [sensor_dict(s) for s in r.sensors],
                    }
                    for r in f.rooms
                ],
                "assets": [
                    {
                        "code": a.code,
                        "kind": a.kind,
                        "name": a.name,
                        "x": a.x,
                        "z": a.z,
                        "room": a.room.code if a.room else None,
                        "sensors": [sensor_dict(s) for s in a.sensors],
                    }
                    for a in f.assets
                ],
            }
            for f in building.floors
        ],
    }


def list_sensors(db: Session) -> list[dict]:
    return [sensor_dict(s) for s in db.query(Sensor).order_by(Sensor.sensor_id).all()]


def room_codes(db: Session) -> list[str]:
    return [code for (code,) in db.query(Room.code).order_by(Room.code).all()]


def location_codes(db: Session) -> set[str]:
    """Every valid `room` value in telemetry: room codes plus asset codes (meters, AHUs)."""
    return set(room_codes(db)) | {c for (c,) in db.query(Asset.code).all()}


def sim_sensors(db: Session) -> list[SimSensor]:
    """Enabled simulated sensors with the parameters the simulator needs."""
    out = []
    for s in db.query(Sensor).filter(Sensor.enabled.is_(True), Sensor.source == "simulated").all():
        if s.location_code is None or s.baseline is None:
            continue
        out.append(
            SimSensor(
                sensor_id=s.sensor_id,
                location=s.location_code,
                type=s.type,
                unit=s.unit,
                baseline=s.baseline,
                variation=s.variation if s.variation is not None else 1.0,
                min_value=s.min_value if s.min_value is not None else s.baseline - 10,
                max_value=s.max_value if s.max_value is not None else s.baseline + 10,
            )
        )
    return sorted(out, key=lambda x: x.sensor_id)


def touch_last_seen(db: Session, sensor_id: str, ts: datetime) -> None:
    """Record that a sensor was heard from (only moves forward). Caller commits."""
    sensor = db.query(Sensor).filter(Sensor.sensor_id == sensor_id).first()
    if sensor is None:
        return
    ts = as_utc(ts)
    if sensor.last_seen_at is None or ts > as_utc(sensor.last_seen_at):
        sensor.last_seen_at = ts


def sensor_context(db: Session, sensor_id: str) -> dict | None:
    """Structural context for a sensor: location, floor, sibling sensors on the floor, assets."""
    sensor = db.query(Sensor).filter(Sensor.sensor_id == sensor_id).first()
    if sensor is None:
        return None
    owner = sensor.room or sensor.asset
    floor = owner.floor
    floor_sensors = [s for r in floor.rooms for s in r.sensors if s.sensor_id != sensor_id] + [
        s for a in floor.assets for s in a.sensors if s.sensor_id != sensor_id
    ]
    room_assets = list(sensor.room.assets) if sensor.room else []
    return {
        "sensor": sensor_dict(sensor),
        "room": {"code": sensor.room.code, "name": sensor.room.name} if sensor.room else None,
        "asset": {"code": sensor.asset.code, "kind": sensor.asset.kind, "name": sensor.asset.name}
        if sensor.asset
        else None,
        "floor": {"level": floor.level, "name": floor.name},
        "assets": [{"code": a.code, "kind": a.kind, "name": a.name} for a in room_assets]
        + [
            {"code": a.code, "kind": a.kind, "name": a.name}
            for a in floor.assets
            if a.room_id is None and a.kind == "hvac"
        ],
        "siblings": [sensor_dict(s) for s in floor_sensors],
    }
