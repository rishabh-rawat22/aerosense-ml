# FILE: ml/models/train_all.py
"""
Batch Training Script
─────────────────────
Trains LSTM models for all cities from local CSVs or MongoDB.

Usage:
    python models/train_all.py --data-dir ../data --epochs 50
    python models/train_all.py --data-dir ../data --epochs 50 --cities "Delhi,Mumbai,Bengaluru"
    python models/train_all.py --epochs 50 --min-rows 2000   # from MongoDB
"""

import os
import sys
import argparse
import time
from datetime import datetime
from pathlib import Path

from pymongo import MongoClient
from loguru import logger
from dotenv import load_dotenv

# ── Path setup ────────────────────────────────────────────────────────────────
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

load_dotenv(dotenv_path=ROOT.parent / "server" / ".env")
load_dotenv(dotenv_path=ROOT / ".env", override=False)

MONGO_URI = os.environ.get("MONGO_URI", "")
# Minimum hourly records needed to train a useful model
# 168 (input window) + 48 (output) + some buffer ≈ 500 minimum
# But for a good model, we want at least ~2000 hours (≈ 3 months)
DEFAULT_MIN_ROWS = 2000


def get_trainable_cities(min_rows: int) -> list[dict]:
    """
    Query ml_history to find all cities with enough data for training.

    Args:
        min_rows: Minimum number of hourly records required.

    Returns:
        List of {city, count, earliest, latest} dicts, sorted by count descending.
    """
    client = MongoClient(MONGO_URI)
    db = client.get_default_database()
    col = db["ml_history"]

    pipeline = [
        {"$group": {
            "_id": "$city",
            "count": {"$sum": 1},
            "earliest": {"$min": "$timestamp"},
            "latest": {"$max": "$timestamp"},
        }},
        {"$match": {"count": {"$gte": min_rows}}},
        {"$sort": {"count": -1}},
    ]

    results = list(col.aggregate(pipeline))
    client.close()

    return [
        {
            "city": r["_id"],
            "count": r["count"],
            "earliest": r["earliest"],
            "latest": r["latest"],
        }
        for r in results
    ]


def train_city(city: str, epochs: int, mode: str = "full", data_dir: str = None) -> bool:
    """
    Train the LSTM model for a single city by calling train.py's run_training.

    Args:
        city:     City name.
        epochs:   Number of training epochs.
        mode:     'full' or 'finetune'.
        data_dir: Path to CSV data directory (optional).

    Returns:
        True if training succeeded, False otherwise.
    """
    try:
        from models.train import run_training
        run_training(mode=mode, epochs=epochs, target_city=city, data_dir=data_dir)
        return True
    except Exception as e:
        logger.error(f"Training failed for {city}: {e}")
        return False


def main():
    ap = argparse.ArgumentParser(description="Train LSTM models for all cities")
    ap.add_argument("--epochs", type=int, default=50, help="Training epochs per city")
    ap.add_argument("--min-rows", type=int, default=DEFAULT_MIN_ROWS,
                    help=f"Minimum ml_history records to consider a city trainable (default: {DEFAULT_MIN_ROWS})")
    ap.add_argument("--data-dir", type=str, default=None,
                    help="Path to local CSV data directory (recommended for initial training)")
    ap.add_argument("--cities", type=str, default=None,
                    help="Comma-separated list of specific cities to train (e.g. 'Delhi,Mumbai')")
    ap.add_argument("--mode", choices=["full", "finetune"], default="full",
                    help="Training mode: full (from scratch) or finetune (last 90 days)")
    args = ap.parse_args()

    use_csv = args.data_dir is not None

    if not use_csv and not MONGO_URI:
        logger.error("Provide --data-dir for CSV training, or set MONGO_URI in .env")
        return

    # Get cities to train
    if args.cities:
        # User specified exact cities
        city_list = [c.strip() for c in args.cities.split(",")]
        logger.info(f"Training specified cities: {city_list}")
        cities = [{"city": c, "count": "?", "earliest": "?", "latest": "?"} for c in city_list]
    elif use_csv:
        # Discover cities from CSV metadata
        from data.backfill_cpcb_csv import load_station_info
        from pathlib import Path
        station_info = load_station_info(Path(args.data_dir).resolve())
        city_list = sorted(station_info["city"].unique().tolist())
        logger.info(f"Found {len(city_list)} cities from stations_info.csv")
        cities = [{"city": c, "count": "?", "earliest": "?", "latest": "?"} for c in city_list]
    else:
        # Auto-discover cities with enough data
        logger.info(f"Finding cities with ≥ {args.min_rows} records in ml_history...")
        cities = get_trainable_cities(args.min_rows)

        if not cities:
            logger.error(
                f"No cities found with ≥ {args.min_rows} records. "
                "Run the backfill first: python data/backfill_cpcb_csv.py --data-dir ../data"
            )
            return

        logger.info(f"Found {len(cities)} trainable cities:")
        for c in cities:
            logger.info(f"  {c['city']:20s} — {c['count']:>8,} records ({c['earliest'].date()} → {c['latest'].date()})")

    # Train each city
    results = {"success": [], "failed": []}
    total_start = time.time()

    for i, city_info in enumerate(cities, 1):
        city = city_info["city"]
        logger.info(f"\n{'─' * 60}")
        logger.info(f"[{i}/{len(cities)}] Training {city} ({args.mode}, {args.epochs} epochs)")
        logger.info(f"{'─' * 60}")

        t0 = time.time()
        ok = train_city(city, epochs=args.epochs, mode=args.mode, data_dir=args.data_dir)
        elapsed = time.time() - t0

        if ok:
            results["success"].append(city)
            logger.success(f"✅ {city} — done in {elapsed:.1f}s")
        else:
            results["failed"].append(city)
            logger.error(f"❌ {city} — failed after {elapsed:.1f}s")

    # Summary
    total_elapsed = time.time() - total_start
    logger.info(f"\n{'═' * 60}")
    logger.info(f"BATCH TRAINING COMPLETE — {total_elapsed:.1f}s total")
    logger.info(f"  ✅ Success: {len(results['success'])} cities — {', '.join(results['success']) or 'none'}")
    if results["failed"]:
        logger.warning(f"  ❌ Failed:  {len(results['failed'])} cities — {', '.join(results['failed'])}")
    logger.info(f"{'═' * 60}")


if __name__ == "__main__":
    main()
