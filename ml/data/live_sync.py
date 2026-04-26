# FILE: ml/data/live_sync.py
"""
Live Data Sync
──────────────
Pulls the latest HourlySnapshot records from MongoDB and merges them
into ml_history with data_source = "live". Called by the scheduler
before every inference and training run.

Usage:
    python data/live_sync.py                  # sync last 7 days
    python data/live_sync.py --days 30        # sync last N days
    python data/live_sync.py --city Delhi     # single city
"""

import os
import argparse
from datetime import datetime, timezone, timedelta
from typing import Optional

from pymongo import MongoClient, UpdateOne
from pymongo.errors import BulkWriteError
from loguru import logger
from dotenv import load_dotenv

load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), "../../server/.env"))
load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), "../.env"), override=False)

MONGO_URI = os.environ["MONGO_URI"]


def snapshot_to_ml_doc(snap: dict) -> Optional[dict]:
    """
    Convert a HourlySnapshot Mongo document to an ml_history document.

    Args:
        snap: Raw MongoDB document from hourlySnapshots collection.

    Returns:
        ml_history-compatible dict, or None if required fields are missing.
    """
    city = snap.get("city", "").strip()
    ts   = snap.get("timestamp")
    aqi  = snap.get("actual")

    if not city or not ts or aqi is None:
        return None

    ist_hour = snap.get("hour", 0)
    date_ist = snap.get("date", "")
    polls    = snap.get("pollutants") or {}

    return {
        "city":          city,
        "timestamp":     ts if ts.tzinfo else ts.replace(tzinfo=timezone.utc),
        "hour_ist":      ist_hour,
        "date_ist":      date_ist,
        "aqi":           int(round(aqi)),
        "pm25":          polls.get("pm25"),
        "pm10":          polls.get("pm10"),
        "no2":           polls.get("no2"),
        "so2":           polls.get("so2"),
        "co":            polls.get("co"),
        "o3":            polls.get("o3"),
        "data_source":   "live",
        "station_count": snap.get("stationCount", 1),
    }


def upsert_ml_history(col, docs: list[dict]) -> int:
    """
    Upsert live documents into ml_history.

    Live data takes precedence: uses $set (not $setOnInsert) so that
    live readings overwrite any earlier Kaggle/OpenAQ placeholder for
    the same city+timestamp slot.

    Args:
        col:  PyMongo collection.
        docs: Documents to upsert.

    Returns:
        Total records upserted + modified.
    """
    if not docs:
        return 0

    ops = []
    for d in docs:
        ops.append(UpdateOne(
            {"city": d["city"], "timestamp": d["timestamp"]},
            {"$set": d},
            upsert=True,
        ))

    try:
        r = col.bulk_write(ops, ordered=False)
        return r.upserted_count + r.modified_count
    except BulkWriteError as e:
        logger.warning(f"Bulk write partial error: {e.details.get('nInserted', 0)} inserted")
        return 0


def sync_live(days: int = 7, target_city: Optional[str] = None) -> int:
    """
    Pull recent HourlySnapshots and merge into ml_history.

    Args:
        days:        How many days back to sync (default 7).
        target_city: Restrict to a single city name.

    Returns:
        Number of records written/updated.
    """
    client = MongoClient(MONGO_URI)
    db     = client.get_default_database()

    src_col = db["hourlySnapshots"]
    dst_col = db["ml_history"]

    dst_col.create_index([("city", 1), ("timestamp", 1)], unique=True, background=True)

    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    query: dict = {"timestamp": {"$gte": cutoff}, "actual": {"$ne": None}}

    if target_city:
        import re
        query["city"] = re.compile(f"^{re.escape(target_city.strip())}$", re.IGNORECASE)

    snapshots = list(src_col.find(query).sort("timestamp", 1))
    logger.info(f"Found {len(snapshots)} HourlySnapshots to sync (last {days} days)")

    docs = [doc for snap in snapshots if (doc := snapshot_to_ml_doc(snap))]
    written = upsert_ml_history(dst_col, docs)

    logger.success(f"Live sync: {written}/{len(docs)} records written to ml_history")
    client.close()
    return written


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Sync live HourlySnapshots into ml_history")
    ap.add_argument("--days", type=int, default=7, help="Days of history to sync")
    ap.add_argument("--city", default=None,        help="Single city filter")
    args = ap.parse_args()
    sync_live(days=args.days, target_city=args.city)
