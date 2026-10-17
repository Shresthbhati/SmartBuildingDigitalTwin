import logging
from app.api.routes import router
from app.core.config import settings
from app.core.database import init_db
from app.services.alert_service import alert_service
from app.services.anomaly_service import anomaly_service
from app.services.mqtt_service import mqtt_service
from app.services.retention_service import retention_service
from app.services.simulator_service import sensor_simulator
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

logging.basicConfig(
    level=logging.INFO if not settings.app_debug else logging.DEBUG,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Starting up Smart Building Digital Twin Backend")
    init_db()
    logger.info("Database initialized")

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
    logger.info("Retention service stopped")

    anomaly_service.stop()
    logger.info("Anomaly detection service stopped")

    alert_service.stop()
    logger.info("Alert service stopped")

    sensor_simulator.stop()
    logger.info("Sensor simulator stopped")

    mqtt_service.disconnect()
    logger.info("MQTT service stopped")


app = FastAPI(
    title="Smart Building Digital Twin API",
    description="REST API for Smart Building Digital Twin with real-time sensor monitoring",
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
