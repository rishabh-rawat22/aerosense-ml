# FILE: ml/inference/forecast_cache.py
"""
Forecast Cache Writer
──────────────────────
Runs inference for every known city and writes the results into the
`ml_forecasts` MongoDB collection, from which the Node.js API reads.

This is the bridge between the Python ML layer and the Node.js backend.

Usage:
    python inference/forecast_cache.py           # all cities
    python inference/forecast_cache.py --city Delhi
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
STALE_HOURS = int(os.getenv("ML_STALE_HOURS", "24"))
HORIZON     = 48


def get_model_version(city: str) -> str:
    """
    Read the version string from a city's latest checkpoint metadata.

    Args:
        city: City name.

    Returns:
        Version string or 'unknown'.
    """
    import torch
    from pathlib import Path
    checkpoint_dir = Path(os.getenv(
        "MODEL_CHECKPOINT_DIR",
        str(ROOT / "models" / "checkpoints")
    ))
    safe  = city.lower().replace(" ", "_")
    link  = checkpoint_dir / f"lstm_{safe}_latest.pt"
    if not link.exists():
        return "unknown"
    try:
        ckpt = torch.load(str(link), map_location="cpu")
        return ckpt.get("metadata", {}).get("version", "unknown")
    except Exception:
        return "unknown"


def write_forecast(db, city: str, forecast: list[dict], model_version: str):
    """
    Write a forecast result into the ml_forecasts collection.

    The document is upserted by city — only one active forecast per city
    is stored at a time. A 48-hour TTL is applied so stale documents are
    automatically purged by MongoDB.

    Args:
        db:            PyMongo database handle.
        city:          City name.
        forecast:      List of 48 forecast dicts from predict.run_inference().
        model_version: Model version string for provenance.
    """
    col          = db["ml_forecasts"]
    now          = datetime.now(timezone.utc)
    valid_until  = now + timedelta(hours=2)   # frontend should re-fetch after 2h

    doc = {
        "city":          city,
        "generated_at":  now,
        "valid_until":   valid_until,
        "model_version": model_version,
        "forecast":      forecast,
    }

    col.update_one(
        {"city": city},
        {"$set": doc},
        upsert=True,
    )
    logger.info(f"ml_forecasts updated for '{city}' (model={model_version})")


def get_all_model_cities() -> list[str]:
    """
    List all cities that have a trained model checkpoint on disk.

    Returns:
        Sorted list of city names derived from checkpoint filenames.
    """
    checkpoint_dir = Path(os.getenv(
        "MODEL_CHECKPOINT_DIR",
        str(ROOT / "models" / "checkpoints")
    ))
    if not checkpoint_dir.exists():
        return []

    cities = []
    for f in checkpoint_dir.glob("lstm_*_latest.pt"):
        # filename: lstm_{safe_city}_latest.pt
        name = f.stem                          # lstm_{safe_city}_latest
        name = name[len("lstm_"):]             # {safe_city}_latest
        name = name[: -len("_latest")]         # {safe_city}
        cities.append(name.replace("_", " ").title())
    return sorted(cities)


def cache_all_forecasts(target_city: Optional[str] = None) -> dict:
    """
    Run inference for all (or one) cities and cache results.

    Args:
        target_city: Restrict to a single city name (default: all).

    Returns:
        Summary dict: {success: [...], failed: [...]}.
    """
    # Import here to avoid circular import at module level
    from inference.predict import run_inference, ModelStaleError, InsufficientDataError

    client = MongoClient(MONGO_URI)
    db     = client.get_default_database()

    # Ensure indexes on ml_forecasts
    db["ml_forecasts"].create_index("city", unique=True, background=True)
    db["ml_forecasts"].create_index(
        "generated_at",
        expireAfterSeconds=HORIZON * 3600 * 2,   # auto-purge after 96h
        background=True,
    )

    if target_city:
        cities = [target_city]
    else:
        # Union: cities with a model checkpoint OR cities in ml_history
        model_cities   = get_all_model_cities()
        history_cities = db["ml_history"].distinct("city")
        cities         = sorted(set(model_cities) | set(history_cities))

    summary = {"success": [], "failed": [], "skipped": []}

    for city in cities:
        logger.info(f"─── Caching forecast for: {city} ───")
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
        f"Forecast cache run complete — "
        f"ok={len(summary['success'])} "
        f"skipped={len(summary['skipped'])} "
        f"failed={len(summary['failed'])}"
    )
    return summary


def get_cached_forecast(db, city: str) -> Optional[dict]:
    """
    Read the latest cached forecast for a city from ml_forecasts.

    Args:
        db:   PyMongo database handle.
        city: City name.

    Returns:
        Forecast document dict or None if not found / expired.
    """
    import re
    doc = db["ml_forecasts"].find_one(
        {"city": re.compile(f"^{re.escape(city.strip())}$", re.IGNORECASE)},
        {"_id": 0},
    )
    if not doc:
        return None

    # Check if still valid
    valid_until = doc.get("valid_until")
    if valid_until and valid_until.tzinfo is None:
        valid_until = valid_until.replace(tzinfo=timezone.utc)
    if valid_until and datetime.now(timezone.utc) > valid_until:
        logger.warning(f"Cached forecast for '{city}' has expired — regenerating")
        return None

    return doc


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Update ml_forecasts cache for all cities")
    ap.add_argument("--city", default=None, help="Single city (default: all)")
    args = ap.parse_args()
    cache_all_forecasts(target_city=args.city)
