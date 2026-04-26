# FILE: ml/data/backfill_kaggle.py
"""
Kaggle Dataset Backfill
────────────────────────
Loads the "Air Quality Data in India (2015-2020)" Kaggle city_day.csv
and writes it into ml_history with data_source = "backfill_kaggle".

Download: https://www.kaggle.com/datasets/rohanrao/air-quality-data-in-india

Usage:
    python data/backfill_kaggle.py --csv /path/to/city_day.csv
    python data/backfill_kaggle.py --csv /path/to/city_day.csv --city Delhi
"""

import os
import argparse
import math
from datetime import datetime, timezone, timedelta
from typing import Optional

import pandas as pd
from pymongo import MongoClient, UpdateOne
from pymongo.errors import BulkWriteError
from loguru import logger
from dotenv import load_dotenv

load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), "../../server/.env"))
load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), "../.env"), override=False)

MONGO_URI  = os.environ["MONGO_URI"]
IST_OFFSET = timedelta(hours=5, minutes=30)

# Kaggle city name → WAQI/CPCB city name
CITY_NAME_MAP = {
    "Ahmedabad": "Ahmedabad", "Bengaluru": "Bengaluru", "Bhopal": "Bhopal",
    "Chandigarh": "Chandigarh", "Chennai": "Chennai", "Delhi": "Delhi",
    "Gurugram": "Gurugram", "Guwahati": "Guwahati", "Hyderabad": "Hyderabad",
    "Jaipur": "Jaipur", "Kolkata": "Kolkata", "Lucknow": "Lucknow",
    "Mumbai": "Mumbai", "Patna": "Patna", "Visakhapatnam": "Visakhapatnam",
    "Amritsar": "Amritsar", "Coimbatore": "Coimbatore", "Ernakulam": "Ernakulam",
    "Kochi": "Kochi", "Shillong": "Shillong", "Thiruvananthapuram": "Thiruvananthapuram",
}


def _pm25_to_aqi(pm25: float) -> Optional[int]:
    """Convert PM2.5 (µg/m³) to India NAQI AQI using linear interpolation."""
    if pm25 is None or math.isnan(pm25) or pm25 < 0:
        return None
    bp = [(0,30,0,50),(30,60,51,100),(60,90,101,200),
          (90,120,201,300),(120,250,301,400),(250,500,401,500)]
    for c_lo, c_hi, i_lo, i_hi in bp:
        if c_lo <= pm25 <= c_hi:
            return round(((i_hi - i_lo) / (c_hi - c_lo)) * (pm25 - c_lo) + i_lo)
    return 500 if pm25 > 500 else None


def safe_float(val) -> Optional[float]:
    """Return float or None for missing/NaN values."""
    try:
        v = float(val)
        return None if math.isnan(v) else v
    except (TypeError, ValueError):
        return None


def csv_row_to_doc(row: pd.Series, city_mapped: str) -> Optional[dict]:
    """
    Convert one daily CSV row into an ml_history document at IST midnight (hour=0).

    Args:
        row:        DataFrame row.
        city_mapped: Normalized city name.

    Returns:
        ml_history dict or None if AQI is indeterminate.
    """
    dt_utc = row["Date"].to_pydatetime()
    ist    = dt_utc + IST_OFFSET
    ts_utc = ist.replace(hour=0, minute=0, second=0, microsecond=0) - IST_OFFSET

    pm25 = safe_float(row.get("PM2.5"))
    aqi  = safe_float(row.get("AQI")) or _pm25_to_aqi(pm25)
    if aqi is None:
        return None

    return {
        "city":          city_mapped,
        "timestamp":     ts_utc.replace(tzinfo=timezone.utc),
        "hour_ist":      0,
        "date_ist":      ist.strftime("%Y-%m-%d"),
        "aqi":           int(round(aqi)),
        "pm25":          pm25,
        "pm10":          safe_float(row.get("PM10")),
        "no2":           safe_float(row.get("NO2")),
        "so2":           safe_float(row.get("SO2")),
        "co":            safe_float(row.get("CO")),
        "o3":            safe_float(row.get("O3")),
        "data_source":   "backfill_kaggle",
        "station_count": 1,
    }


def upsert_ml_history(col, docs: list[dict]) -> int:
    """Bulk-upsert with $setOnInsert — never overwrites higher-quality live data."""
    if not docs:
        return 0
    ops = [UpdateOne(
        {"city": d["city"], "timestamp": d["timestamp"]},
        {"$setOnInsert": d}, upsert=True
    ) for d in docs]
    try:
        r = col.bulk_write(ops, ordered=False)
        return r.upserted_count
    except BulkWriteError as e:
        return e.details.get("nInserted", 0)


def run_backfill(csv_path: str, target_city: Optional[str] = None):
    """
    Main entry point.

    Args:
        csv_path:    Path to Kaggle city_day.csv.
        target_city: Optional single city filter (Kaggle spelling).
    """
    if not os.path.isfile(csv_path):
        raise FileNotFoundError(f"CSV not found: {csv_path}")

    df = pd.read_csv(csv_path, parse_dates=["Date"])
    df["Date"] = pd.to_datetime(df["Date"], utc=True)
    df = df.dropna(subset=["Date"])
    logger.info(f"Loaded {len(df):,} rows from {csv_path}")

    client = MongoClient(MONGO_URI)
    db     = client.get_default_database()
    col    = db["ml_history"]
    col.create_index([("city", 1), ("timestamp", 1)], unique=True, background=True)

    cities = df["City"].unique().tolist()
    if target_city:
        cities = [c for c in cities if c.lower() == target_city.lower()]

    total = 0
    for kc in cities:
        mapped  = CITY_NAME_MAP.get(kc, kc)
        rows    = df[df["City"] == kc]
        docs    = [doc for _, r in rows.iterrows() if (doc := csv_row_to_doc(r, mapped))]
        written = upsert_ml_history(col, docs)
        logger.info(f"  {kc:20s} -> {mapped:20s}: {written}/{len(docs)} rows")
        total += written

    logger.success(f"Kaggle backfill done — {total:,} records written")
    client.close()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv",  required=True)
    ap.add_argument("--city", default=None)
    args = ap.parse_args()
    run_backfill(args.csv, args.city)
