"""
Forecast Cache Writer
──────────────────────
Runs inference for every known city and writes results into
ml_forecasts MongoDB collection AND stamps predicted values
into hourlySnapshots for the history chart.
"""

import os
import sys
import argparse
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional

from pymongo import MongoClient, UpdateOne
from pymongo.errors import BulkWriteError
from loguru import logger
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

load_dotenv(dotenv_path=ROOT.parent / "server" / ".env")
load_dotenv(dotenv_path=ROOT / ".env", override=False)

MONGO_URI   = os.environ["MONGO_URI"]
STALE_HOURS = int(os.getenv("ML_STALE_HOURS", "999999"))  # disabled by default
HORIZON     = 48
IST_OFFSET  = timedelta(hours=5, minutes=30)


def get_model_version(city: str) -> str:
    try:
        import torch
        checkpoint_dir = Path(os.getenv(
            "MODEL_CHECKPOINT_DIR",
            str(ROOT / "models" / "checkpoints")
        ))
        safe = city.lower().replace(" ", "_")
        link = checkpoint_dir / f"lstm_{safe}_latest.pt"
        if not link.exists():
            return "unknown"
        ckpt = torch.load(str(link), map_location="cpu")
        return ckpt.get("metadata", {}).get("version", "unknown")
    except Exception:
        return "unknown"


def write_forecast(db, city: str, forecast: list[dict], model_version: str):
    """
    Write forecast into ml_forecasts AND stamp predicted values
    into hourlySnapshots for ALL 48 future hours.
    """
    col         = db["ml_forecasts"]
    now         = datetime.now(timezone.utc)
    valid_until = now + timedelta(hours=2)

    doc = {
        "city":          city,
        "generated_at":  now,
        "valid_until":   valid_until,
        "model_version": model_version,
        "forecast":      forecast,
    }

    col.update_one({"city": city}, {"$set": doc}, upsert=True)
    logger.info(f"ml_forecasts updated for '{city}' (model={model_version})")

    # ── Stamp ALL 48 predicted hours into hourlySnapshots ─────────────────────
    # This is what makes the blue predicted line appear on the history chart
    if not forecast:
        return

    ops = []
    for point in forecast:
        try:
            ts_str  = point["timestamp"].replace("Z", "+00:00")
            ts_utc  = datetime.fromisoformat(ts_str)
            ts_ist  = ts_utc + IST_OFFSET
            date_str = ts_ist.strftime("%Y-%m-%d")
            hour_ist = ts_ist.hour

            ops.append(UpdateOne(
                {
                    "city": city,
                    "date": date_str,
                    "hour": hour_ist,
                },
                {
                    "$set": {
                        "predicted":  point["aqi"],
                        "timestamp":  ts_utc,
                        "city":       city,
                        "date":       date_str,
                        "hour":       hour_ist,
                        "stationCount": 0,
                    },
                    "$setOnInsert": {
                        "actual": None,  # no actual yet for future hours
                    }
                },
                upsert=True,
            ))
        except Exception as e:
            logger.warning(f"Could not build op for {city} point: {e}")

    if ops:
        try:
            result = db["hourlySnapshots"].bulk_write(ops, ordered=False)
            logger.info(
                f"Stamped {len(ops)} predicted hours into hourlySnapshots for '{city}' "
                f"(upserted={result.upserted_count} modified={result.modified_count})"
            )
        except BulkWriteError as e:
            logger.warning(f"Bulk write partial error for {city}: {e.details}")


def get_all_model_cities() -> list[str]:
    checkpoint_dir = Path(os.getenv(
        "MODEL_CHECKPOINT_DIR",
        str(ROOT / "models" / "checkpoints")
    ))
    if not checkpoint_dir.exists():
        return []

    cities = []
    for f in checkpoint_dir.glob("lstm_*_latest.pt"):
        name = f.stem
        name = name[len("lstm_"):]
        name = name[: -len("_latest")]
        cities.append(name.replace("_", " ").title())
    return sorted(cities)


def get_all_live_cities(db) -> list[str]:
    """Get all cities from hourlySnapshots (live WAQI data)."""
    return sorted(db["hourlysnapshots"].distinct("city"))


def cache_all_forecasts(target_city: Optional[str] = None) -> dict:
    from inference.predict import run_inference, ModelStaleError, InsufficientDataError

    client = MongoClient(MONGO_URI)
    db     = client.get_default_database()

    # Ensure indexes
    db["ml_forecasts"].create_index("city", unique=True, background=True)

    if target_city:
        cities = [target_city]
    else:
        # All cities that have a trained model
        model_cities   = get_all_model_cities()
        history_cities = db["ml_history"].distinct("city")
        cities         = sorted(set(model_cities) | set(history_cities))

    logger.info(f"Running forecast cache for {len(cities)} cities...")
    summary = {"success": [], "failed": [], "skipped": []}

    for city in cities:
        logger.info(f"─── Processing: {city} ───")
        try:
            forecast = run_inference(city, db)
            version  = get_model_version(city)
            write_forecast(db, city, forecast, version)
            summary["success"].append(city)
        except (FileNotFoundError, ModelStaleError) as exc:
            logger.warning(f"Skipped '{city}': {exc}")
            summary["skipped"].append(city)
        except InsufficientDataError as exc:
            logger.warning(f"Insufficient data for '{city}': {exc}")
            summary["skipped"].append(city)
        except Exception as exc:
            logger.exception(f"Unexpected error for '{city}': {exc}")
            summary["failed"].append(city)

    client.close()
    logger.success(
        f"Forecast cache complete — "
        f"ok={len(summary['success'])} "
        f"skipped={len(summary['skipped'])} "
        f"failed={len(summary['failed'])}"
    )
    return summary


def get_cached_forecast(db, city: str) -> Optional[dict]:
    import re
    doc = db["ml_forecasts"].find_one(
        {"city": re.compile(f"^{re.escape(city.strip())}$", re.IGNORECASE)},
        {"_id": 0},
    )
    if not doc:
        return None

    valid_until = doc.get("valid_until")
    if valid_until and valid_until.tzinfo is None:
        valid_until = valid_until.replace(tzinfo=timezone.utc)
    if valid_until and datetime.now(timezone.utc) > valid_until:
        logger.warning(f"Cached forecast for '{city}' expired")
        return None

    return doc


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--city", default=None)
    args = ap.parse_args()
    cache_all_forecasts(target_city=args.city)
