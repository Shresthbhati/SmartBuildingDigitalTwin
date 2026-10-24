import asyncio
import contextlib
import logging
from app.api.nexus import router as nexus_router
from app.api.routes import router
from app.api.ws import health_publisher
from app.api.ws import router as ws_router
from app.core import recent_errors
from app.core.config import settings
from app.core.database import SessionLocal
from app.core.events import bus
from app.core.migrations import run_migrations
from app.services.alert_service import alert_service
from app.services.anomaly_service import anomaly_service
from app.services.mqtt_service import mqtt_service
from app.services.retention_service import retention_service
from app.services.simulator_service import sensor_simulator
from app.services.topology_service import seed_topology
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

logging.basicConfig(
    level=logging.INFO if not settings.app_debug else logging.DEBUG,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
# SQLAlchemy and paho are chatty at DEBUG; keep them at WARNING even in debug mode.
for noisy in ("sqlalchemy.engine", "paho"):
    logging.getLogger(noisy).setLevel(logging.WARNING)
recent_errors.install()
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Starting up Smart Building Digital Twin Backend")
    run_migrations()
    logger.info("Database migrated to head")

    db = SessionLocal()
    try:
        seed_topology(db)
    finally:
        db.close()
    logger.info("Topology seeded")

    # Worker threads publish events through the bus; give it the running loop.
    bus.bind_loop(asyncio.get_running_loop())
    health_task = asyncio.create_task(health_publisher())

    mqtt_service.connect()
    logger.info("MQTT service started")

    sensor_simulator.start()
    logger.info("Sensor simulator started")

    alert_service.start()
    logger.info("Alert service started")

    anomaly_service.start()
    logger.info("Anomaly detection service started")

    retention_service.start()
    logger.info("Retention service started")

    yield

    logger.info("Shutting down Smart Building Digital Twin Backend")
    retention_service.stop()
    anomaly_service.stop()
    alert_service.stop()
    sensor_simulator.stop()
    mqtt_service.disconnect()
    health_task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await health_task
    bus.bind_loop(None)
    logger.info("Shutdown complete")


app = FastAPI(
    title="Smart Building Digital Twin API",
    description="REST + WebSocket API for the NEXUS Smart Building Digital Twin",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router, prefix="")
app.include_router(nexus_router, prefix="")
app.include_router(ws_router, prefix="")


@app.get("/")
def root():
    return {
        "message": "Smart Building Digital Twin API",
        "version": "1.0.0",
        "docs": "/docs",
        "health": "/health",
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "app.main:app",
        host=settings.app_host,
        port=settings.app_port,
        reload=settings.app_debug,
    )
