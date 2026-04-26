# FILE: ml/data/backfill_openaq.py
"""
OpenAQ Historical Backfill
──────────────────────────
Fetches up to N months of hourly PM2.5 / PM10 / NO2 / SO2 / CO / O3
measurements from the OpenAQ v3 API for every Indian city that the
live WAQI sync already tracks.

Writes records into the `ml_history` MongoDB collection with
data_source = "backfill_openaq".

Usage (one-time):
    python data/backfill_openaq.py --months 12
    python data/backfill_openaq.py --months 6 --city Delhi
"""

import os
import sys
import time
import argparse
import math
from datetime import datetime, timezone, timedelta
from typing import Optional

import requests
from pymongo import MongoClient, UpdateOne
from pymongo.errors import BulkWriteError
from loguru import logger
from dotenv import load_dotenv

# ── Load .env (looks for server/.env or ml/.env) ─────────────────────────────
load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), "../../server/.env"))
load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), "../.env"), override=False)

MONGO_URI   = os.environ["MONGO_URI"]
OPENAQ_KEY  = os.getenv("OPENAQ_API_KEY", "")   # optional — raises rate limit

# OpenAQ v3 base
OPENAQ_BASE = "https://api.openaq.org/v3"

# Parameter IDs in OpenAQ v3 (stable)
PARAM_IDS = {
    "pm25": 2,
    "pm10": 1,
    "no2":  7,
    "so2":  9,
    "co":   4,
    "o3":   3,
}

IST_OFFSET = timedelta(hours=5, minutes=30)


def _headers() -> dict:
    """Build request headers, including API key if available."""
    h = {"Accept": "application/json"}
    if OPENAQ_KEY:
        h["X-API-Key"] = OPENAQ_KEY
    return h


def _get_json(url: str, params: dict, retries: int = 3) -> dict:
    """
    GET a JSON endpoint with simple retry + back-off.

    Args:
        url:     Full URL to request.
        params:  Query parameters dict.
        retries: Number of attempts before giving up.

    Returns:
        Parsed JSON dict, or empty dict on failure.
    """
    for attempt in range(retries):
        try:
            resp = requests.get(url, params=params, headers=_headers(), timeout=30)
            if resp.status_code == 429:
                wait = int(resp.headers.get("Retry-After", 10))
                logger.warning(f"Rate limited — sleeping {wait}s")
                time.sleep(wait)
                continue
            resp.raise_for_status()
            return resp.json()
        except requests.RequestException as exc:
            logger.warning(f"Request failed (attempt {attempt + 1}/{retries}): {exc}")
            time.sleep(2 ** attempt)
    return {}


def get_india_locations() -> list[dict]:
    """
    Retrieve all active OpenAQ locations in India.

    Returns:
        List of dicts with keys: id, name, city, lat, lon.
    """
    logger.info("Fetching OpenAQ location list for India...")
    locations = []
    page = 1
    limit = 1000

    while True:
        data = _get_json(f"{OPENAQ_BASE}/locations", {
            "country_id": "IN",
            "limit":      limit,
            "page":       page,
        })
        results = data.get("results", [])
        if not results:
            break

        for loc in results:
            coords = loc.get("coordinates") or {}
            locations.append({
                "id":   loc["id"],
                "name": loc.get("name", ""),
                "city": (loc.get("city") or "").strip(),
                "lat":  coords.get("latitude"),
                "lon":  coords.get("longitude"),
            })

        meta = data.get("meta", {})
        total = meta.get("total", 0)
        if page * limit >= total:
            break
        page += 1
        time.sleep(0.5)  # polite pacing

    logger.info(f"Found {len(locations)} OpenAQ locations in India")
    return locations


def fetch_measurements(
    location_id: int,
    param_id: int,
    date_from: datetime,
    date_to: datetime,
) -> list[dict]:
    """
    Fetch hourly measurements for a single location + parameter.

    Args:
        location_id: OpenAQ location integer ID.
        param_id:    OpenAQ parameter integer ID.
        date_from:   Start datetime (UTC).
        date_to:     End datetime (UTC).

    Returns:
        List of raw measurement dicts from OpenAQ.
    """
    measurements = []
    page = 1

    while True:
        data = _get_json(f"{OPENAQ_BASE}/measurements", {
            "location_id":  location_id,
            "parameter_id": param_id,
            "date_from":    date_from.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "date_to":      date_to.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "limit":        1000,
            "page":         page,
        })

        results = data.get("results", [])
        measurements.extend(results)

        meta = data.get("meta", {})
        total = meta.get("total", 0)
        if not results or page * 1000 >= total:
            break
        page += 1
        time.sleep(0.3)

    return measurements


def _round_to_hour_ist(dt_utc: datetime) -> tuple[datetime, str, int]:
    """
    Round a UTC datetime to the nearest IST hour boundary.

    Returns:
        (timestamp_utc, date_ist_str, hour_ist)
    """
    ist = dt_utc + IST_OFFSET
    rounded = ist.replace(minute=0, second=0, microsecond=0)
    # Convert back to UTC for storage consistency
    ts_utc = rounded - IST_OFFSET
    return ts_utc, rounded.strftime("%Y-%m-%d"), rounded.hour


def measurements_to_ml_history(
    city: str,
    param_measurements: dict[str, list],
) -> list[dict]:
    """
    Merge per-parameter measurement lists into hourly ml_history documents.

    Args:
        city:               City name (matched to HourlySnapshot.city).
        param_measurements: Dict of param_name → list of raw measurement dicts.

    Returns:
        List of ml_history documents ready for MongoDB upsert.
    """
    # Build a bucket: {timestamp_utc: {param: value}}
    buckets: dict[datetime, dict] = {}

    for param, meas_list in param_measurements.items():
        for m in meas_list:
            try:
                raw_dt_str = m.get("date", {}).get("utc", "")
                if not raw_dt_str:
                    continue
                dt_utc = datetime.fromisoformat(raw_dt_str.replace("Z", "+00:00"))
                ts_utc, date_ist, hour_ist = _round_to_hour_ist(dt_utc)
                key = ts_utc
                if key not in buckets:
                    buckets[key] = {"date_ist": date_ist, "hour_ist": hour_ist}
                # Average duplicates within the same hour
                existing = buckets[key].get(param)
                val = float(m.get("value", 0) or 0)
                if existing is None:
                    buckets[key][param] = val
                else:
                    buckets[key][param] = (existing + val) / 2
            except (ValueError, KeyError, TypeError):
                continue

    docs = []
    for ts_utc, fields in buckets.items():
        pm25 = fields.get("pm25")
        # Derive AQI from PM2.5 using India NAQI breakpoints
        aqi = _pm25_to_aqi(pm25) if pm25 is not None else None

        docs.append({
            "city":          city,
            "timestamp":     ts_utc,
            "hour_ist":      fields.get("hour_ist", 0),
            "date_ist":      fields.get("date_ist", ""),
            "aqi":           aqi,
            "pm25":          pm25,
            "pm10":          fields.get("pm10"),
            "no2":           fields.get("no2"),
            "so2":           fields.get("so2"),
            "co":            fields.get("co"),
            "o3":            fields.get("o3"),
            "data_source":   "backfill_openaq",
            "station_count": 1,
        })

    return docs


def _pm25_to_aqi(pm25: float) -> Optional[int]:
    """Convert PM2.5 (µg/m³) to India NAQI AQI value."""
    if pm25 is None or math.isnan(pm25) or pm25 < 0:
        return None
    bp = [
        (0,   30,   0,  50),
        (30,  60,  51, 100),
        (60,  90, 101, 200),
        (90, 120, 201, 300),
        (120, 250, 301, 400),
        (250, 500, 401, 500),
    ]
    for c_lo, c_hi, i_lo, i_hi in bp:
        if c_lo <= pm25 <= c_hi:
            return round(((i_hi - i_lo) / (c_hi - c_lo)) * (pm25 - c_lo) + i_lo)
    return 500 if pm25 > 500 else None


def upsert_ml_history(collection, docs: list[dict]) -> int:
    """
    Bulk-upsert ml_history documents into MongoDB.

    Args:
        collection: PyMongo collection object.
        docs:       List of documents to upsert.

    Returns:
        Number of records inserted/modified.
    """
    if not docs:
        return 0

    ops = [
        UpdateOne(
            {"city": d["city"], "timestamp": d["timestamp"]},
            {"$setOnInsert": d},
            upsert=True,
        )
        for d in docs
        if d.get("aqi") is not None
    ]

    if not ops:
        return 0

    try:
        result = collection.bulk_write(ops, ordered=False)
        return result.upserted_count + result.modified_count
    except BulkWriteError as bwe:
        logger.warning(f"Bulk write partial failure: {bwe.details.get('nInserted', 0)} inserted")
        return 0


def get_live_cities(db) -> list[str]:
    """
    Retrieve city names already tracked in HourlySnapshot (live data).

    Args:
        db: PyMongo database handle.

    Returns:
        Sorted list of unique city strings.
    """
    cities = db["hourlySnapshots"].distinct("city")
    return sorted(set(c.strip() for c in cities if c.strip()))


def match_openaq_location(city: str, locations: list[dict]) -> Optional[dict]:
    """
    Find the best-matching OpenAQ location for a given city name.

    Strategy: case-insensitive city field match first; then name substring match.

    Args:
        city:      Target city string from HourlySnapshot.
        locations: All OpenAQ India locations.

    Returns:
        Best-matching location dict, or None.
    """
    city_lo = city.lower()
    # Exact city match
    for loc in locations:
        if loc["city"].lower() == city_lo:
            return loc
    # Substring in name
    for loc in locations:
        if city_lo in loc["name"].lower():
            return loc
    return None


def run_backfill(months: int = 12, target_city: Optional[str] = None):
    """
    Main backfill entry point.

    Args:
        months:      How many months of history to fetch (default 12).
        target_city: Restrict to a single city (default: all live cities).
    """
    client = MongoClient(MONGO_URI)
    db     = client.get_default_database()
    col    = db["ml_history"]

    # Ensure index
    col.create_index([("city", 1), ("timestamp", 1)], unique=True, background=True)

    locations = get_india_locations()

    if target_city:
        cities = [target_city]
    else:
        cities = get_live_cities(db)
        logger.info(f"Found {len(cities)} cities in live HourlySnapshot collection")

    date_to   = datetime.now(timezone.utc)
    date_from = date_to - timedelta(days=30 * months)

    total_written = 0

    for city in cities:
        loc = match_openaq_location(city, locations)
        if not loc:
            logger.warning(f"No OpenAQ location match for city: {city}")
            continue

        logger.info(f"Backfilling {city} (OpenAQ id={loc['id']}) — {months} months")
        param_measurements: dict[str, list] = {}

        for param_name, param_id in PARAM_IDS.items():
            meas = fetch_measurements(loc["id"], param_id, date_from, date_to)
            if meas:
                param_measurements[param_name] = meas
                logger.debug(f"  {param_name}: {len(meas)} records")
            time.sleep(0.5)

        docs = measurements_to_ml_history(city, param_measurements)
        written = upsert_ml_history(col, docs)
        logger.info(f"  → Wrote {written}/{len(docs)} records for {city}")
        total_written += written

    logger.info(f"✅ OpenAQ backfill complete — {total_written} total records written")
    client.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Backfill historical AQI from OpenAQ")
    parser.add_argument("--months", type=int, default=12, help="Months of history to fetch")
    parser.add_argument("--city",   type=str, default=None, help="Restrict to single city")
    args = parser.parse_args()

    run_backfill(months=args.months, target_city=args.city)
