# FILE: ml/data/backfill_cpcb_csv.py
"""
CPCB Station CSV Backfill
──────────────────────────
Reads the local CPCB station-level hourly CSV files from the `data/` directory
and writes them into `ml_history` with data_source = "backfill_cpcb".

The `data/` directory contains:
  - stations_info.csv  — metadata (file_name, state, city, agency, location, ...)
  - {XX}NNN.csv        — hourly pollutant readings per station (e.g. DL001.csv)

This script:
  1. Parses stations_info.csv for file → city mapping
  2. Reads each station CSV, normalises varying column schemas
  3. Computes AQI using the Indian NAQI formula (max sub-index)
  4. Aggregates multiple stations per city per hour (average)
  5. Bulk-upserts into ml_history (won't overwrite live data)

Usage:
    python data/backfill_cpcb_csv.py --data-dir ../../data
    python data/backfill_cpcb_csv.py --data-dir ../../data --city Delhi
    python data/backfill_cpcb_csv.py --data-dir ../../data --state "Uttar Pradesh"
    python data/backfill_cpcb_csv.py --data-dir ../../data --dry-run
"""

import os
import sys
import math
import argparse
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional

import numpy as np
import pandas as pd
from pymongo import MongoClient, UpdateOne
from pymongo.errors import BulkWriteError
from loguru import logger
from dotenv import load_dotenv

# ── Path setup ────────────────────────────────────────────────────────────────
ROOT = Path(__file__).resolve().parent.parent
load_dotenv(dotenv_path=ROOT.parent / "server" / ".env")
load_dotenv(dotenv_path=ROOT / ".env", override=False)

MONGO_URI  = os.environ.get("MONGO_URI", "")
IST_OFFSET = timedelta(hours=5, minutes=30)

# Batch size for bulk MongoDB writes
UPSERT_BATCH = 5000


# ── Indian NAQI Sub-Index Breakpoints ─────────────────────────────────────────
# Each entry: (C_low, C_high, I_low, I_high)
# Source: CPCB National Air Quality Index (NAQI) standards
# PM2.5 & PM10: 24-hr avg; SO2 & NO2: 24-hr avg; CO: 8-hr avg (mg/m3); O3: 8-hr avg; NH3: 24-hr avg
# We apply them to hourly values as approximation (consistent with live pipeline)

BREAKPOINTS = {
    "pm25": [
        (0, 30, 0, 50), (30, 60, 51, 100), (60, 90, 101, 200),
        (90, 120, 201, 300), (120, 250, 301, 400), (250, 380, 401, 500),
    ],
    "pm10": [
        (0, 50, 0, 50), (50, 100, 51, 100), (100, 250, 101, 200),
        (250, 350, 201, 300), (350, 430, 301, 400), (430, 510, 401, 500),
    ],
    "no2": [
        (0, 40, 0, 50), (40, 80, 51, 100), (80, 180, 101, 200),
        (180, 280, 201, 300), (280, 400, 301, 400), (400, 510, 401, 500),
    ],
    "so2": [
        (0, 40, 0, 50), (40, 80, 51, 100), (80, 380, 101, 200),
        (380, 800, 201, 300), (800, 1600, 301, 400), (1600, 2100, 401, 500),
    ],
    "co": [
        # CO breakpoints are in mg/m3 — CSV data is already in mg/m3
        (0, 1.0, 0, 50), (1.0, 2.0, 51, 100), (2.0, 10.0, 101, 200),
        (10.0, 17.0, 201, 300), (17.0, 34.0, 301, 400), (34.0, 49.0, 401, 500),
    ],
    "o3": [
        (0, 50, 0, 50), (50, 100, 51, 100), (100, 168, 101, 200),
        (168, 208, 201, 300), (208, 748, 301, 400), (748, 1000, 401, 500),
    ],
    "nh3": [
        (0, 200, 0, 50), (200, 400, 51, 100), (400, 800, 101, 200),
        (800, 1200, 201, 300), (1200, 1800, 301, 400), (1800, 2400, 401, 500),
    ],
}


def _sub_index(value: float, breakpoints: list[tuple]) -> Optional[int]:
    """
    Compute a single NAQI sub-index via linear interpolation.

    Args:
        value:       Pollutant concentration.
        breakpoints: List of (C_low, C_high, I_low, I_high) tuples.

    Returns:
        Integer sub-index or None if value is invalid.
    """
    if value is None or math.isnan(value) or value < 0:
        return None
    for c_lo, c_hi, i_lo, i_hi in breakpoints:
        if c_lo <= value <= c_hi:
            return round(((i_hi - i_lo) / (c_hi - c_lo)) * (value - c_lo) + i_lo)
    # Above max range
    if value > breakpoints[-1][1]:
        return 500
    return None


def compute_naqi(pm25=None, pm10=None, no2=None, so2=None,
                 co=None, o3=None, nh3=None) -> Optional[int]:
    """
    Compute the Indian National Air Quality Index (NAQI).

    AQI = max(sub-indices of available pollutants).
    Requires at least one of PM2.5 or PM10 to be valid.

    Args:
        pm25..nh3: Pollutant concentrations (pm25/pm10/no2/so2 in µg/m³,
                   co in mg/m³, o3 in µg/m³, nh3 in µg/m³).

    Returns:
        Integer AQI (0-500) or None if insufficient data.
    """
    sub_indices = []

    pairs = [
        (pm25, "pm25"), (pm10, "pm10"), (no2, "no2"), (so2, "so2"),
        (co, "co"), (o3, "o3"), (nh3, "nh3"),
    ]

    has_pm = False
    for val, key in pairs:
        if val is not None and not (isinstance(val, float) and math.isnan(val)):
            si = _sub_index(float(val), BREAKPOINTS[key])
            if si is not None:
                sub_indices.append(si)
                if key in ("pm25", "pm10"):
                    has_pm = True

    if not sub_indices or not has_pm:
        return None

    return max(sub_indices)


# ── CSV Column Mapping ────────────────────────────────────────────────────────
# Maps the varying column names found across station CSVs → standard names

COLUMN_MAP = {
    # Timestamp
    "From Date":           "timestamp",
    "To Date":             "_to_date",
    # Core pollutants
    "PM2.5 (ug/m3)":       "pm25",
    "PM10 (ug/m3)":        "pm10",
    "NO2 (ug/m3)":         "no2",
    "NO (ug/m3)":          "no",
    "NOx (ppb)":           "nox",
    "NH3 (ug/m3)":         "nh3",
    "SO2 (ug/m3)":         "so2",
    "CO (mg/m3)":          "co",
    "Ozone (ug/m3)":       "o3",
    # VOCs (not used for AQI but kept for completeness)
    "Benzene (ug/m3)":     "benzene",
    "Toluene (ug/m3)":     "toluene",
    "Eth-Benzene (ug/m3)": "eth_benzene",
    "MP-Xylene (ug/m3)":   "mp_xylene",
    "O Xylene (ug/m3)":    "o_xylene",
    "Xylene (ug/m3)":      "xylene",
    # Meteorological
    "Temp (degree C)":     "temp",
    "AT (degree C)":       "temp_at",   # alternative temperature column
    "RH (%)":              "rh",
    "WS (m/s)":            "ws",
    "WD (deg)":            "wd",
    "SR (W/mt2)":          "sr",
    "BP (mmHg)":           "bp",
    "VWS (m/s)":           "vws",
    "RF (mm)":             "rf",
    # Other
    "CH4 (ug/m3)":         "ch4",
    "CH4 ()":              "ch4",
    "NMHC ()":             "nmhc",
    "THC (ug/m3)":         "thc",
}

# The columns we need for ml_history
REQUIRED_POLLUTANTS = ["pm25", "pm10", "no2", "so2", "co", "o3"]
OPTIONAL_POLLUTANTS = ["nh3"]


def safe_float(val) -> Optional[float]:
    """Return float or None for missing/NaN values."""
    try:
        v = float(val)
        return None if math.isnan(v) else v
    except (TypeError, ValueError):
        return None


# ── Station Info Loader ───────────────────────────────────────────────────────

def load_station_info(data_dir: Path) -> pd.DataFrame:
    """
    Load stations_info.csv and return a DataFrame with columns:
    [file_name, state, city, station_location, start_year].

    Args:
        data_dir: Path to the data/ directory.

    Returns:
        DataFrame of station metadata.
    """
    info_path = data_dir / "stations_info.csv"
    if not info_path.exists():
        raise FileNotFoundError(f"stations_info.csv not found in {data_dir}")

    df = pd.read_csv(info_path)
    df["city"] = df["city"].str.strip()
    df["state"] = df["state"].str.strip()
    df["file_name"] = df["file_name"].str.strip()
    logger.info(f"Loaded station info: {len(df)} stations across {df['state'].nunique()} states")
    return df


# ── Single Station CSV Loader ────────────────────────────────────────────────

def load_station_csv(csv_path: Path) -> Optional[pd.DataFrame]:
    """
    Load a single station CSV, normalise column names, and return a clean DataFrame.

    Args:
        csv_path: Path to the station CSV file.

    Returns:
        DataFrame with standardised columns and UTC timestamps, or None if empty/invalid.
    """
    try:
        df = pd.read_csv(csv_path, low_memory=False)
    except Exception as e:
        logger.warning(f"Failed to read {csv_path.name}: {e}")
        return None

    if df.empty or "From Date" not in df.columns:
        logger.warning(f"Skipping {csv_path.name}: empty or missing 'From Date'")
        return None

    # Rename columns using the mapping
    rename = {}
    for orig_col in df.columns:
        stripped = orig_col.strip()
        if stripped in COLUMN_MAP:
            rename[orig_col] = COLUMN_MAP[stripped]
        else:
            rename[orig_col] = stripped.lower().replace(" ", "_").replace("(", "").replace(")", "").replace("/", "_")
    df = df.rename(columns=rename)

    # Parse timestamp
    df["timestamp"] = pd.to_datetime(df["timestamp"], format="%Y-%m-%d %H:%M:%S", errors="coerce")
    df = df.dropna(subset=["timestamp"])
    if df.empty:
        return None

    # Assume CSV timestamps are IST → convert to UTC
    df["timestamp"] = df["timestamp"] - IST_OFFSET
    df["timestamp"] = df["timestamp"].dt.tz_localize("UTC")

    # Ensure required pollutant columns exist
    for col in REQUIRED_POLLUTANTS + OPTIONAL_POLLUTANTS:
        if col not in df.columns:
            df[col] = np.nan

    # Convert pollutant columns to numeric
    for col in REQUIRED_POLLUTANTS + OPTIONAL_POLLUTANTS:
        df[col] = pd.to_numeric(df[col], errors="coerce")

    return df


# ── AQI Computation (Vectorised) ─────────────────────────────────────────────

def compute_aqi_column(df: pd.DataFrame) -> pd.Series:
    """
    Compute AQI for each row of a DataFrame using Indian NAQI formula.
    Vectorised for performance over large datasets.

    Args:
        df: DataFrame with columns pm25, pm10, no2, so2, co, o3, nh3.

    Returns:
        Series of integer AQI values (NaN where insufficient data).
    """
    aqi_values = []
    for _, row in df.iterrows():
        aqi = compute_naqi(
            pm25=safe_float(row.get("pm25")),
            pm10=safe_float(row.get("pm10")),
            no2=safe_float(row.get("no2")),
            so2=safe_float(row.get("so2")),
            co=safe_float(row.get("co")),
            o3=safe_float(row.get("o3")),
            nh3=safe_float(row.get("nh3")),
        )
        aqi_values.append(aqi)
    return pd.Series(aqi_values, index=df.index)


def compute_aqi_column_fast(df: pd.DataFrame) -> pd.Series:
    """
    Faster AQI computation using numpy instead of row-by-row iteration.

    Args:
        df: DataFrame with pollutant columns.

    Returns:
        Series of AQI values.
    """
    def _sub_index_arr(values: np.ndarray, bp_key: str) -> np.ndarray:
        """Compute sub-index for an array of values."""
        bp = BREAKPOINTS[bp_key]
        result = np.full(len(values), np.nan)
        for c_lo, c_hi, i_lo, i_hi in bp:
            mask = (values >= c_lo) & (values <= c_hi) & np.isfinite(values)
            result[mask] = ((i_hi - i_lo) / (c_hi - c_lo)) * (values[mask] - c_lo) + i_lo
        # Values above max range
        max_c = bp[-1][1]
        over_mask = (values > max_c) & np.isfinite(values)
        result[over_mask] = 500
        return result

    # Compute sub-index for each pollutant
    sub_indices = {}
    for col in ["pm25", "pm10", "no2", "so2", "co", "o3", "nh3"]:
        if col in df.columns:
            vals = pd.to_numeric(df[col], errors="coerce").values.astype(np.float64)
            sub_indices[col] = _sub_index_arr(vals, col)

    if not sub_indices:
        return pd.Series(np.nan, index=df.index)

    # Stack all sub-indices and take max across pollutants (ignoring NaN)
    stack = np.column_stack(list(sub_indices.values()))
    with np.errstate(invalid="ignore"):
        aqi = np.nanmax(stack, axis=1)

    # Require at least PM2.5 or PM10 to be valid
    has_pm25 = np.isfinite(sub_indices.get("pm25", np.full(len(df), np.nan)))
    has_pm10 = np.isfinite(sub_indices.get("pm10", np.full(len(df), np.nan)))
    has_pm = has_pm25 | has_pm10
    aqi[~has_pm] = np.nan

    result = pd.array(np.round(aqi), dtype=pd.Int64Dtype())
    return pd.Series(result, index=df.index)


# ── City Aggregation ─────────────────────────────────────────────────────────

def aggregate_city_hour(city_dfs: list[pd.DataFrame], city: str) -> pd.DataFrame:
    """
    Merge multiple station DataFrames for one city, averaging pollutant values
    per hour across stations.

    Args:
        city_dfs: List of DataFrames (one per station) for this city.
        city:     City name.

    Returns:
        Single DataFrame with hourly city-level averages and computed AQI.
    """
    if not city_dfs:
        return pd.DataFrame()

    # Concatenate all stations
    combined = pd.concat(city_dfs, ignore_index=True)
    pollutant_cols = [c for c in REQUIRED_POLLUTANTS + OPTIONAL_POLLUTANTS if c in combined.columns]

    # Group by timestamp (hour), average pollutants, count stations
    grouped = combined.groupby("timestamp").agg(
        **{col: (col, "mean") for col in pollutant_cols},
        station_count=("timestamp", "size"),
    ).reset_index()

    # Compute AQI from averaged pollutants
    grouped["aqi"] = compute_aqi_column_fast(grouped)

    # Drop rows where AQI could not be computed
    grouped = grouped.dropna(subset=["aqi"])

    if grouped.empty:
        return pd.DataFrame()

    # Add metadata
    grouped["city"] = city
    grouped["data_source"] = "backfill_cpcb"

    # Compute IST fields
    grouped["_ist"] = grouped["timestamp"] + IST_OFFSET
    grouped["hour_ist"] = grouped["_ist"].dt.hour
    grouped["date_ist"] = grouped["_ist"].dt.strftime("%Y-%m-%d")
    grouped.drop(columns=["_ist"], inplace=True)

    return grouped


# ── MongoDB Upsert ────────────────────────────────────────────────────────────

def upsert_ml_history(col, docs: list[dict]) -> int:
    """
    Bulk upsert documents into ml_history.
    Uses $setOnInsert so existing live/higher-quality data is never overwritten.

    Args:
        col:  PyMongo collection handle.
        docs: List of ml_history documents.

    Returns:
        Number of newly inserted documents.
    """
    if not docs:
        return 0

    total_upserted = 0
    for i in range(0, len(docs), UPSERT_BATCH):
        batch = docs[i : i + UPSERT_BATCH]
        ops = [
            UpdateOne(
                {"city": d["city"], "timestamp": d["timestamp"]},
                {"$setOnInsert": d},
                upsert=True,
            )
            for d in batch
        ]
        try:
            r = col.bulk_write(ops, ordered=False)
            total_upserted += r.upserted_count
        except BulkWriteError as e:
            total_upserted += e.details.get("nInserted", 0)

    return total_upserted


def df_to_docs(df: pd.DataFrame) -> list[dict]:
    """
    Convert an aggregated city DataFrame into ml_history documents.

    Args:
        df: DataFrame with city, timestamp, aqi, pollutants, etc.

    Returns:
        List of document dicts ready for MongoDB.
    """
    docs = []
    for _, row in df.iterrows():
        doc = {
            "city":          row["city"],
            "timestamp":     row["timestamp"].to_pydatetime(),
            "hour_ist":      int(row["hour_ist"]),
            "date_ist":      row["date_ist"],
            "aqi":           int(row["aqi"]),
            "pm25":          safe_float(row.get("pm25")),
            "pm10":          safe_float(row.get("pm10")),
            "no2":           safe_float(row.get("no2")),
            "so2":           safe_float(row.get("so2")),
            "co":            safe_float(row.get("co")),
            "o3":            safe_float(row.get("o3")),
            "data_source":   "backfill_cpcb",
            "station_count": int(row.get("station_count", 1)),
        }
        docs.append(doc)
    return docs


# ── Main Pipeline ─────────────────────────────────────────────────────────────

def run_backfill(
    data_dir: str,
    target_city: Optional[str] = None,
    target_state: Optional[str] = None,
    dry_run: bool = False,
):
    """
    Main backfill entry point.

    Args:
        data_dir:     Path to the data/ directory containing CSVs.
        target_city:  Optional: process only this city.
        target_state: Optional: process only stations in this state.
        dry_run:      If True, parse and compute but don't write to DB.
    """
    data_path = Path(data_dir).resolve()
    station_info = load_station_info(data_path)

    # Filter stations
    if target_state:
        station_info = station_info[
            station_info["state"].str.lower() == target_state.strip().lower()
        ]
        logger.info(f"Filtered to state '{target_state}': {len(station_info)} stations")

    if target_city:
        station_info = station_info[
            station_info["city"].str.lower() == target_city.strip().lower()
        ]
        logger.info(f"Filtered to city '{target_city}': {len(station_info)} stations")

    if station_info.empty:
        logger.error("No stations match the filter criteria.")
        return

    # Group stations by city
    city_groups = station_info.groupby("city")
    logger.info(f"Processing {len(station_info)} stations across {len(city_groups)} cities")

    # Connect to MongoDB
    client = None
    col = None
    if not dry_run:
        if not MONGO_URI:
            logger.error("MONGO_URI not set. Create a .env file or set the environment variable.")
            return
        client = MongoClient(MONGO_URI)
        db = client.get_default_database()
        col = db["ml_history"]
        col.create_index([("city", 1), ("timestamp", 1)], unique=True, background=True)

    grand_total = 0
    city_summary = []

    for city, group in city_groups:
        logger.info(f"═══ {city} ({len(group)} stations) ═══")
        city_dfs = []

        for _, station in group.iterrows():
            fname = station["file_name"]
            csv_path = data_path / f"{fname}.csv"

            if not csv_path.exists():
                logger.warning(f"  CSV not found: {csv_path.name}")
                continue

            df = load_station_csv(csv_path)
            if df is None or df.empty:
                logger.warning(f"  {csv_path.name}: no valid data")
                continue

            logger.debug(f"  {csv_path.name}: {len(df):,} rows")
            city_dfs.append(df)

        if not city_dfs:
            logger.warning(f"  No valid station data for {city} — skipping")
            continue

        # Aggregate stations → city-level hourly data
        agg_df = aggregate_city_hour(city_dfs, city)

        if agg_df.empty:
            logger.warning(f"  {city}: no rows with computable AQI — skipping")
            continue

        total_rows = len(agg_df)
        date_range = f"{agg_df['timestamp'].min().date()} → {agg_df['timestamp'].max().date()}"

        if dry_run:
            logger.info(
                f"  {city}: {total_rows:,} hourly records ({date_range}) "
                f"| AQI range: {int(agg_df['aqi'].min())}–{int(agg_df['aqi'].max())} [DRY RUN]"
            )
            grand_total += total_rows
        else:
            docs = df_to_docs(agg_df)
            written = upsert_ml_history(col, docs)
            logger.info(
                f"  {city}: {written:,}/{total_rows:,} records written ({date_range}) "
                f"| AQI range: {int(agg_df['aqi'].min())}–{int(agg_df['aqi'].max())}"
            )
            grand_total += written

        city_summary.append({
            "city": city,
            "state": group.iloc[0]["state"],
            "stations": len(group),
            "records": total_rows,
            "date_range": date_range,
        })

        # Free memory after each city
        del city_dfs, agg_df

    # Summary
    logger.success(
        f"\nBackfill complete — {grand_total:,} total records "
        f"{'(dry run)' if dry_run else 'written'} "
        f"across {len(city_summary)} cities"
    )

    if city_summary:
        summary_df = pd.DataFrame(city_summary)
        logger.info(f"\n{summary_df.to_string(index=False)}")

    if client:
        client.close()


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Backfill ml_history from CPCB station CSVs")
    ap.add_argument(
        "--data-dir", required=True,
        help="Path to the data/ directory containing station CSVs and stations_info.csv"
    )
    ap.add_argument("--city", default=None, help="Process only this city")
    ap.add_argument("--state", default=None, help="Process only this state")
    ap.add_argument("--dry-run", action="store_true", help="Parse and compute without writing to DB")
    args = ap.parse_args()

    run_backfill(
        data_dir=args.data_dir,
        target_city=args.city,
        target_state=args.state,
        dry_run=args.dry_run,
    )
