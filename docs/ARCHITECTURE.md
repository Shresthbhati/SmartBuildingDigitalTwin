# Smart Building Digital Twin - Architecture Documentation

## Current Architecture (Phase 0 Baseline)

### System Overview
The current implementation is a minimal Flask-based dashboard with MQTT-connected temperature sensors.

### Components

#### Backend (`app.py`)
- **Framework**: Flask 3.1.3
- **MQTT Client**: paho-mqtt 2.1.0 (broker: test.mosquitto.org:1883)
- **State Management**: In-memory dictionaries
  - `latest_data`: Dict[room_id, {temperature, timestamp, status}]
  - `history`: Dict[room_id, List[{temperature, timestamp}]]
  - `activity_log`: List[{room, temperature, timestamp, event}]
  - `room_status`: Dict[room_id, status] (NORMAL/WARNING/CRITICAL)
- **Thresholds**: WARNING > 25°C, CRITICAL > 30°C
- **API Endpoints**:
  - `GET /api/latest` - Latest readings for all rooms
  - `GET /api/history/<room>` - Historical data for a room
  - `GET /api/activity` - Recent activity log
  - `GET /api/status` - Room statuses
- **WebSocket**: None (polling-based frontend)

#### Sensor Simulator (`sensor.py`)
- **Protocol**: MQTT v3.1.1
- **Topics**: `building/roomXXX/temperature` (rooms 101-104)
- **Simulation**: Random walk with bounds [20, 40]
- **Soft Ceiling**: 30°C (reduced upward drift)
- **Interval**: 2 seconds
- **Payload**: JSON `{temperature: float, timestamp: ISO8601}`

#### Frontend (`templates/index.html`)
- **Styling**: Dark theme, CSS Grid layout
- **Charts**: Chart.js line charts per room
- **Polling**: 5-second interval for all API endpoints
- **Features**: Room cards, temperature display, status badges, activity log

### Data Flow
```
sensor.py (MQTT Publish) → test.mosquitto.org → app.py (MQTT Subscribe) → In-Memory State → Flask API → Frontend (Polling)
```

### Limitations (Current State)
1. **No persistence** - All data lost on restart
2. **No deterministic simulation** - Random walk, non-reproducible
3. **No WebSocket** - Polling introduces latency
4. **No 3D visualization** - 2D charts only
5. **No alerting engine** - Thresholds only, no escalation
6. **No historical database** - In-memory history limited
7. **Single sensor type** - Temperature only
8. **External MQTT broker** - test.mosquitto.org dependency

---

## Target Architecture (Phases 1-20)

### High-Level Design

```
┌─────────────────────────────────────────────────────────────────┐
│                        Frontend (React/TypeScript)              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │ 3D Building  │  │  Dashboards  │  │  Alert Management    │  │
│  │  (Three.js)  │  │  (Recharts)  │  │  (Acknowledge/Resolve)│  │
│  └──────────────┘  └──────────────┘  └──────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │ WebSocket (Socket.IO)
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Backend (FastAPI)                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │  REST API    │  │  WebSocket   │  │  Alert Engine        │  │
│  │  (CRUD)      │  │  Server      │  │  (Rules/Escalation)  │  │
│  └──────────────┘  └──────────────┘  └──────────────────────┘  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │  MQTT Ingest │  │  Simulation  │  │  Persistence         │  │
│  │  Service     │  │  Engine      │  │  (SQLAlchemy/SQLite) │  │
│  └──────────────┘  └──────────────┘  └──────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
        ┌──────────┐   ┌──────────┐    ┌────────────┐
        │  SQLite  │   │  Local   │    │  MQTT      │
        │  (Main)  │   │  Broker  │    │  (Optional)│
        └──────────┘   └──────────┘    └────────────┘
```

### Technology Stack

| Layer | Technology | Version |
|-------|------------|---------|
| Frontend | React + TypeScript + Vite | 18.x / 5.x |
| 3D Graphics | Three.js + React Three Fiber | Latest |
| Charts | Recharts | Latest |
| State | Zustand / React Query | Latest |
| Backend | FastAPI | 0.109+ |
| Database | SQLAlchemy + SQLite | 2.0+ |
| Real-time | Socket.IO | Latest |
| MQTT | paho-mqtt / Eclipse Mosquitto (local) | Latest |
| Simulation | Deterministic PRNG (PCG64) | NumPy |
| Testing | Pytest + Playwright | Latest |

### Database Schema (SQLAlchemy Models)

```python
# Core Models
class Room(Base):
    id: str(PK)  # e.g., "101"
    name: str  # "Conference Room A"
    floor: int
    x: float  # 3D position
    y: float
    z: float
    sensor_types: JSON  # ["temperature", "humidity", "co2", "occupancy"]


class SensorReading(Base):
    id: int(PK, autoincrement)
    room_id: str(FK)
    sensor_type: str  # "temperature", "humidity", "co2", "occupancy"
    value: float
    timestamp: DateTime  # UTC, timezone-aware
    quality: str  # "GOOD", "UNCERTAIN", "BAD"


class Alert(Base):
    id: int(PK, autoincrement)
    room_id: str(FK)
    sensor_type: str
    severity: str  # "INFO", "WARNING", "CRITICAL"
    message: str
    value: float
    threshold: float
    acknowledged: bool
    acknowledged_by: str(nullable)
    acknowledged_at: DateTime(nullable)
    resolved: bool
    resolved_at: DateTime(nullable)
    created_at: DateTime


class SimulationState(Base):
    id: int(PK, autoincrement)
    room_id: str(FK)
    sensor_type: str
    seed_state: bytes  # PRNG state for reproducibility
    last_value: float
    updated_at: DateTime
```

### Deterministic Simulation Engine

- **PRNG**: NumPy PCG64 (per-room, per-sensor independent streams)
- **State Persistence**: PRNG state saved to database every N ticks
- **Replay**: Given seed + tick count, exact values reproducible
- **Models**:
  - Temperature: Seasonal + daily cycle + noise + HVAC response
  - Humidity: Inverse correlation with temperature + noise
  - CO2: Occupancy-driven + ventilation decay
  - Occupancy: Schedule-based (business hours) + random variation

### Alert Engine

- **Rules**: Configurable per sensor type per room
- **Escalation**: WARNING → CRITICAL → EMERGENCY (time-based)
- **Notifications**: WebSocket push, in-app, (future: email/webhook)
- **Acknowledgment**: Operator acknowledgment with audit trail
- **Auto-resolution**: When value returns to normal range

### API Contract (OpenAPI 3.0)

#### REST Endpoints
```
GET    /api/v1/rooms                    # List all rooms
GET    /api/v1/rooms/{room_id}          # Room details + current readings
GET    /api/v1/rooms/{room_id}/readings # Historical readings (query: sensor_type, from, to, limit)
GET    /api/v1/alerts                   # List alerts (query: severity, acknowledged, room_id)
PATCH  /api/v1/alerts/{alert_id}/ack    # Acknowledge alert
PATCH  /api/v1/alerts/{alert_id}/resolve # Resolve alert
GET    /api/v1/simulation/state         # Get simulation state (for replay)
POST   /api/v1/simulation/seed          # Set simulation seed
POST   /api/v1/simulation/step          # Advance simulation by N steps
```

#### WebSocket Events
```
Server → Client:
  - reading: {room_id, sensor_type, value, timestamp}
  - alert_created: Alert
  - alert_acknowledged: {alert_id, by, at}
  - alert_resolved: {alert_id, at}
  - room_status: {room_id, status}

Client → Server:
  - subscribe: {room_ids?, sensor_types?}
  - acknowledge_alert: {alert_id}
  - set_simulation_speed: {multiplier}
```

### MQTT Integration

- **Local Broker**: Eclipse Mosquitto (Docker or native)
- **Topics**: `building/{room_id}/{sensor_type}` (structured)
- **QoS**: 1 (at least once)
- **Bridge**: Optional bridge to external brokers

### 3D Visualization (Three.js)

- **Scene**: Building model (GLTF) or procedural floors/rooms
- **Rooms**: Interactive meshes with color-coded status
- **Sensors**: Visual indicators on room surfaces
- **Camera**: OrbitControls + preset views (floor, room, overview)
- **Performance**: InstancedMesh for sensors, LOD for geometry

### Configuration

```yaml
# config.yaml
building:
  name: "Smart Building Demo"
  timezone: "UTC"
  floors: 2
  rooms_per_floor: 4

simulation:
  tick_interval_seconds: 10
  seed: 42
  persist_interval_ticks: 100

sensors:
  temperature:
    min: 15
    max: 35
    warning_threshold: 25
    critical_threshold: 30
  humidity:
    min: 20
    max: 80
    warning_threshold: 60
    critical_threshold: 75
  co2:
    min: 400
    max: 2000
    warning_threshold: 1000
    critical_threshold: 1500
  occupancy:
    min: 0
    max: 50
    warning_threshold: 40
    critical_threshold: 50

alerts:
  escalation_minutes:
    warning_to_critical: 15
    critical_to_emergency: 30

mqtt:
  broker: "localhost"
  port: 1883
  username: null
  password: null

database:
  url: "sqlite:///./data/building.db"
```

### Migration Path

| Phase | Focus | Deliverable |
|-------|-------|-------------|
| 1 | Project Setup | FastAPI + React scaffold, SQLite, config.yaml |
| 2 | Database Models | SQLAlchemy models, Alembic migrations |
| 3 | MQTT Ingestion | Local broker, structured topics, ingest service |
| 4 | Deterministic Simulation | PRNG engine, 4 sensor types, state persistence |
| 5 | REST API | CRUD endpoints, OpenAPI docs |
| 6 | WebSocket Server | Real-time updates, subscription model |
| 7 | Alert Engine | Rules, escalation, acknowledgment API |
| 8 | React Dashboard | Room grid, charts, alert panel |
| 9 | 3D Visualization | Three.js scene, room status colors |
| 10 | Simulation Controls | Speed, seed, replay UI |
| 11 | Historical Analytics | Trends, comparisons, exports |
| 12 | Operator Workflow | Acknowledgment, annotations, handoff |
| 13 | Configuration UI | Thresholds, schedules, sensor config |
| 14 | Testing | Unit, integration, E2E, load |
| 15 | Documentation | Architecture, API, operator guide |
| 16 | Performance | Optimization, indexing, caching |
| 17 | Security | Input validation, CORS, rate limiting |
| 18 | Deployment | Docker Compose, systemd, backup |
| 19 | Polish | Accessibility, i18n, error boundaries |
| 20 | Handoff | Final review, demo, documentation |

---

## Data Provenance Rules (Non-Negotiable)

1. **Every reading** must have: `room_id`, `sensor_type`, `value`, `timestamp (UTC)`, `quality`
2. **Every alert** must trace to: originating reading, rule configuration, escalation history
3. **Every simulation state** must be: seeded, reproducible, auditable
4. **No mock data** in production code paths - simulation is a first-class service
5. **Schema versioning** via Alembic migrations for all database changes

## Feature Status Tracking

See `docs/FEATURE_STATUS.md` for current implementation status per phase.
