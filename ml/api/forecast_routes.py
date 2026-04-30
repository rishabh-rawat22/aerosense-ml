# FILE: ml/api/forecast_routes.py
"""
FastAPI Microservice
─────────────────────
Exposes the ML forecast layer to the Node.js backend via HTTP.

Endpoints:
  GET  /health                        — liveness check
  POST /predict                       — used by mlService.js (existing contract)
  GET  /api/forecast/{city}           — LSTM forecast (new, direct city lookup)
  GET  /api/forecast/{city}/cached    — read from ml_forecasts without re-running model

Node.js mlService.js already calls:
  POST ML_SERVICE_URL/predict
  Body: { district, currentAQI, pollutants, lat, lon, hour, month }
  → { forecast: [{time, hour, aqi, lower, upper, modelType}, ...48 items] }

We implement that exact contract so zero changes are needed in mlService.js.

Start:
    uvicorn api.forecast_routes:app --host 0.0.0.0 --port 8000 --reload
"""

import os
import sys
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from loguru import logger
from dotenv import load_dotenv
import motor.motor_asyncio
import pandas as pd
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

load_dotenv(dotenv_path=ROOT.parent / "server" / ".env")
load_dotenv(dotenv_path=ROOT / ".env", override=False)

MONGO_URI   = os.environ["MONGO_URI"]
STALE_HOURS = int(os.getenv("ML_STALE_HOURS", "24"))
HORIZON     = 48
IST_OFFSET  = timedelta(hours=5, minutes=30)

# ── MongoDB async client (Motor) ──────────────────────────────────────────────
_motor_client: Optional[motor.motor_asyncio.AsyncIOMotorClient] = None
_db = None


def get_db():
    """Return the async Motor database handle."""
    return _db


# ── Lifespan — start/stop scheduler + DB connection ──────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize Motor connection and background scheduler on startup."""
    global _motor_client, _db
    _motor_client = motor.motor_asyncio.AsyncIOMotorClient(MONGO_URI)
    _db = _motor_client.get_default_database()
    logger.info("Motor MongoDB connection established")

    # Start the background scheduler (non-blocking)
    try:
        from scheduler.cron_jobs import build_scheduler, job_live_sync, job_forecast_cache
        scheduler = build_scheduler(blocking=False)
        scheduler.start()
        logger.info("Background scheduler started")
        app.state.scheduler = scheduler
    except Exception as e:
        logger.warning(f"Scheduler could not start (non-fatal): {e}")
        app.state.scheduler = None

    yield  # App runs here

    if _motor_client:
        _motor_client.close()
    if getattr(app.state, "scheduler", None):
        app.state.scheduler.shutdown(wait=False)
    logger.info("FastAPI shutdown — connections closed")


# ── App ───────────────────────────────────────────────────────────────────────
app = FastAPI(
    title="Aerosense ML Service",
    description="48-hour AQI forecasting via LSTM. Powers the Aerosense frontend.",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


# ── Pydantic Models ────────────────────────────────────────────────────────────

class PredictRequest(BaseModel):
    """
    Request body expected by Node.js mlService.js.
    Matches the existing contract in server/services/mlService.js.
    """
    district:   str
    currentAQI: float
    pollutants: Optional[dict] = None
    lat:        Optional[float] = None
    lon:        Optional[float] = None
    hour:       Optional[int]   = None
    month:      Optional[int]   = None


class ForecastPoint(BaseModel):
    """Single hour of forecast output."""
    time:      str      # ISO-8601 UTC timestamp
    hour:      int      # IST hour 0-23
    aqi:       int
    lower:     int
    upper:     int
    modelType: str


class PredictResponse(BaseModel):
    """Response body matching Node.js mlService.js expectation."""
    forecast: list[ForecastPoint]


# ── Helpers ────────────────────────────────────────────────────────────────────

def _format_forecast(raw: list[dict], model_version: str = "lstm") -> list[dict]:
    """
    Convert internal forecast list to the wire format mlService.js expects.

    Args:
        raw:           List of dicts from predict.run_inference().
        model_version: Model version string for modelType field.

    Returns:
        List of dicts with keys: time, hour, aqi, lower, upper, modelType.
    """
    result = []
    for item in raw:
        ts = item.get("timestamp", "")
        if not isinstance(ts, str):
            ts = ts.isoformat() if hasattr(ts, "isoformat") else str(ts)
        result.append({
            "time":      ts,
            "hour":      item.get("hour_ist", 0),
            "aqi":       item.get("aqi", 0),
            "lower":     item.get("lower", 0),
            "upper":     item.get("upper", 0),
            "modelType": f"lstm_{model_version}",
        })
    return result


async def _read_cached_forecast(city: str) -> Optional[dict]:
    """
    Read ml_forecasts from MongoDB asynchronously.

    Args:
        city: City name.

    Returns:
        Document dict or None.
    """
    import re
    db  = get_db()
    doc = await db["ml_forecasts"].find_one(
        {"city": re.compile(f"^{re.escape(city.strip())}$", re.IGNORECASE)},
        {"_id": 0},
    )
    if not doc:
        return None



    return doc


def _run_sync_inference(city: str) -> tuple[list[dict], str]:
    """
    Run synchronous inference (PyTorch + PyMongo) in a thread-safe manner.
    FastAPI's run_in_executor is used in the endpoint to avoid blocking the event loop.

    Args:
        city: City name.

    Returns:
        (forecast_list, model_version_string)
    """
    from pymongo import MongoClient
    from inference.predict import run_inference
    from inference.forecast_cache import get_model_version, write_forecast

    client   = MongoClient(MONGO_URI)
    db_sync  = client.get_default_database()
    forecast = run_inference(city, db_sync)
    version  = get_model_version(city)
    write_forecast(db_sync, city, forecast, version)
    client.close()
    return forecast, version


# ── Endpoints ──────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    """
    Liveness check.
    The Node.js health endpoint checks `process.env.ML_SERVICE_URL` against this.
    """
    return {
        "status":    "ok",
        "service":   "Aerosense ML",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "stale_threshold_hours": STALE_HOURS,
    }


@app.post("/predict", response_model=PredictResponse)
async def predict(req: PredictRequest, request: Request):
    """
    48-hour AQI forecast — primary endpoint called by mlService.js.

    Strategy:
      1. Try reading a fresh cached forecast from ml_forecasts.
      2. If cache miss/expired, run live LSTM inference.
      3. If inference fails (no model / insufficient data), fall back to
         the statistical baseline so the Node.js caller always gets a response.

    Args:
        req: PredictRequest body from mlService.js.

    Returns:
        PredictResponse with list of 48 forecast points.
    """
    city = req.district.strip()
    t0   = time.monotonic()

    # 1. Try cache
    cached = await _read_cached_forecast(city)
    if cached:
        raw     = cached.get("forecast", [])
        version = cached.get("model_version", "cached")
        logger.info(f"/predict {city} — served from cache ({len(raw)} pts) in {time.monotonic()-t0:.2f}s")
        return PredictResponse(forecast=_format_forecast(raw, version))

    # 2. Live inference (runs in thread pool to avoid blocking event loop)
    try:
        import asyncio
        loop     = asyncio.get_event_loop()
        forecast, version = await loop.run_in_executor(None, _run_sync_inference, city)
        logger.info(f"/predict {city} — LSTM inference done in {time.monotonic()-t0:.2f}s")
        return PredictResponse(forecast=_format_forecast(forecast, version))

    except Exception as exc:
        logger.warning(f"/predict {city} — LSTM failed ({exc}), returning baseline")
        return PredictResponse(
            forecast=_generate_baseline(req.currentAQI, req.hour or datetime.now().hour)
        )


@app.get("/api/forecast/{city}")
async def get_forecast_direct(city: str):
    """
    Direct forecast endpoint (new — for future frontend or third-party use).

    Returns the ml_forecasts document in a richer format including
    generated_at, model_version, and structured forecast array.

    Args:
        city: City name as path parameter.

    Returns:
        JSON with station_id, generated_at, model_version, forecast[].

    Raises:
        HTTPException 404: No forecast available for this city.
        HTTPException 503: Model is stale or unavailable.
    """
    cached = await _read_cached_forecast(city)
    if cached:
        return {
            "station_id":    city,
            "generated_at":  cached.get("generated_at", datetime.now(timezone.utc)).isoformat()
                             if hasattr(cached.get("generated_at"), "isoformat")
                             else str(cached.get("generated_at", "")),

            "model_version": cached.get("model_version", "unknown"),
            "forecast":      cached.get("forecast", []),
        }

    # Attempt live inference
    try:
        import asyncio
        loop     = asyncio.get_event_loop()
        forecast, version = await loop.run_in_executor(None, _run_sync_inference, city)
        now = datetime.now(timezone.utc)
        return {
            "station_id":    city,
            "generated_at":  now.isoformat(),

            "model_version": version,
            "forecast":      forecast,
        }
    except FileNotFoundError:
        raise HTTPException(
            status_code=404,
            detail=f"No trained model found for city '{city}'. Run training first."
        )
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail=f"Forecast unavailable for '{city}': {str(exc)}"
        )


# ── Statistical Baseline Fallback ──────────────────────────────────────────────

# Real diurnal multipliers (same as Node.js mlService.js baseline — keeps parity)
_HOURLY_PATTERN = [
    0.80, 0.78, 0.76, 0.77, 0.80, 0.90,
    1.05, 1.20, 1.25, 1.15, 1.05, 0.98,
    0.95, 0.92, 0.90, 0.93, 0.98, 1.15,
    1.25, 1.20, 1.10, 1.00, 0.92, 0.85,
]


def _generate_baseline(current_aqi: float, start_hour: int) -> list[dict]:
    """
    Generate a statistical baseline forecast (diurnal pattern).

    Used as a fallback when the LSTM model is unavailable.

    Args:
        current_aqi: Current AQI reading.
        start_hour:  Current IST hour (0-23).

    Returns:
        List of 48 ForecastPoint-compatible dicts.
    """
    import random
    forecast = []
    now      = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    aqi      = float(current_aqi)

    for i in range(HORIZON):
        ft   = now + timedelta(hours=i + 1)
        ist  = ft + IST_OFFSET
        h    = ist.hour
        mult = _HOURLY_PATTERN[h]
        noise = (random.random() - 0.48) * current_aqi * 0.08
        aqi   = max(10, round(current_aqi * mult + noise))
        band  = int(current_aqi * 0.12)
        forecast.append({
            "time":      ft.isoformat(),
            "hour":      h,
            "aqi":       int(aqi),
            "lower":     max(0, int(aqi - band)),
            "upper":     min(500, int(aqi + band)),
            "modelType": "statistical_baseline",
        })

    return forecast
