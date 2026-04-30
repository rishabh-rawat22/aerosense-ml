# FILE: ml/inference/predict.py
"""
48-Hour AQI Inference
──────────────────────
Loads a city's latest checkpoint + scaler, builds the inference window
from ml_history, and returns 48 forecast objects with (aqi, lower, upper).

Usage:
    python inference/predict.py --city Delhi
    python inference/predict.py --city Mumbai --stale-hours 48
"""

import os
import sys
import argparse
import math
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional

# Lazy-loaded imports inside functions to save memory on Render free tier
import pandas as pd
from pymongo import MongoClient
from loguru import logger
from dotenv import load_dotenv

# ── Path setup ────────────────────────────────────────────────────────────────
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

load_dotenv(dotenv_path=ROOT.parent / "server" / ".env")
load_dotenv(dotenv_path=ROOT / ".env", override=False)

from features.feature_engineering import (
    build_features, get_inference_window, CityScaler, SEQ_LEN, N_FEATURES,
)
from models.lstm_model import AQILSTMForecaster, load_checkpoint

# ── Config ────────────────────────────────────────────────────────────────────
MONGO_URI      = os.environ["MONGO_URI"]
CHECKPOINT_DIR = Path(os.getenv("MODEL_CHECKPOINT_DIR", str(ROOT / "models" / "checkpoints")))
SCALER_DIR     = CHECKPOINT_DIR / "scalers"
STALE_HOURS    = int(os.getenv("ML_STALE_HOURS", "24"))
HORIZON        = 48
IST_OFFSET     = timedelta(hours=5, minutes=30)


class ModelStaleError(Exception):
    """Raised when the model checkpoint is older than STALE_HOURS."""


class InsufficientDataError(Exception):
    """Raised when fewer than SEQ_LEN hours of data are available for a city."""


def _latest_checkpoint(city: str) -> Path:
    """
    Resolve the latest .pt checkpoint for a city.

    Args:
        city: City name (used to build filename).

    Returns:
        Resolved path to checkpoint file.

    Raises:
        FileNotFoundError: If no checkpoint exists for this city.
        ModelStaleError:   If checkpoint mtime exceeds STALE_HOURS.
    """
    safe = city.lower().replace(" ", "_")
    link = CHECKPOINT_DIR / f"lstm_{safe}_latest.pt"

    if not link.exists():
        raise FileNotFoundError(f"No checkpoint found for city '{city}' at {link}")

    # Follow symlink to real file for mtime check
    real = link.resolve()
    age_hours = (datetime.now().timestamp() - real.stat().st_mtime) / 3600
    if age_hours > STALE_HOURS:
        raise ModelStaleError(
            f"Model for '{city}' is {age_hours:.1f}h old (limit: {STALE_HOURS}h). "
            "Run the training job to refresh."
        )

    return link


def fetch_recent_history(db, city: str, hours: int = SEQ_LEN + 48) -> Optional[pd.DataFrame]:
    """
    Fetch the most recent `hours` records from ml_history for a city.

    Args:
        db:    PyMongo database handle.
        city:  City name.
        hours: How many hours of history to retrieve.

    Returns:
        DataFrame sorted by timestamp ascending, or None if empty.
    """
    import re
    cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)
    query  = {
        "city":      re.compile(f"^{re.escape(city.strip())}$", re.IGNORECASE),
        "timestamp": {"$gte": cutoff},
    }
    docs = list(db["ml_history"].find(query, {"_id": 0}).sort("timestamp", 1))
    if not docs:
        return None
    df = pd.DataFrame(docs)
    df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True)
    return df


def run_inference(city: str, db) -> list[dict]:
    """
    Run a full 48-hour forecast for one city.
    """
    import torch
    import numpy as np
    device = "cuda" if torch.cuda.is_available() else "cpu"

    # 1. Checkpoint freshness
    ckpt_path = _latest_checkpoint(city)

    # 2. Load model + scaler
    safe_city = city.lower().replace(" ", "_")
    model     = load_checkpoint(str(ckpt_path), device=device)

    scaler_path = SCALER_DIR / f"{safe_city}.pkl"
    scaler      = CityScaler.load(str(scaler_path))

    # 3. Fetch history
    df = fetch_recent_history(db, city, hours=SEQ_LEN + 48)
    if df is None or len(df) < SEQ_LEN:
        got = 0 if df is None else len(df)
        raise InsufficientDataError(
            f"'{city}' has only {got}h of history — need {SEQ_LEN}h. "
            "Run live_sync.py or wait for more data to accumulate."
        )

    # 4. Build inference window
    window = get_inference_window(df, scaler, seq_len=SEQ_LEN)
    if window is None:
        raise InsufficientDataError(f"Feature engineering returned no data for '{city}'")

    # 5. Forward pass
    with torch.no_grad():
        x_tensor = torch.from_numpy(window).to(device)   # (1, SEQ_LEN, N_FEATURES)
        preds    = model(x_tensor)                         # (1, horizon, 3)
        preds_np  = preds.cpu().numpy()[0]                 # (horizon, 3)  scaled

    # 6. Inverse-scale — all three quantiles
    q_lower_s = preds_np[:, 0]   # q10
    q_med_s   = preds_np[:, 1]   # q50 — point forecast
    q_upper_s = preds_np[:, 2]   # q90

    q_lower = np.clip(scaler.inverse_transform_aqi(q_lower_s), 0, 500).round().astype(int)
    q_med   = np.clip(scaler.inverse_transform_aqi(q_med_s),   0, 500).round().astype(int)
    q_upper = np.clip(scaler.inverse_transform_aqi(q_upper_s), 0, 500).round().astype(int)

    # 7. Build output list
    now_utc   = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    forecast  = []
    for i in range(HORIZON):
        ts_utc  = now_utc + timedelta(hours=i + 1)
        ist_dt  = ts_utc + IST_OFFSET
        hour_ist = ist_dt.hour
        forecast.append({
            "timestamp": ts_utc.isoformat(),
            "hour_ist":  hour_ist,
            "aqi":       int(q_med[i]),
            "lower":     int(q_lower[i]),
            "upper":     int(q_upper[i]),
        })

    logger.info(f"Forecast generated for '{city}' — {HORIZON} hours from {now_utc.isoformat()}")
    return forecast


def predict_city(city: str) -> Optional[list[dict]]:
    """
    Public entry point: connect to DB, run inference, close connection.

    Args:
        city: City name.

    Returns:
        Forecast list or None on error.
    """
    try:
        client   = MongoClient(MONGO_URI)
        db       = client.get_default_database()
        forecast = run_inference(city, db)
        client.close()
        return forecast
    except (FileNotFoundError, ModelStaleError, InsufficientDataError) as exc:
        logger.error(f"[{city}] Prediction aborted: {exc}")
        raise
    except Exception as exc:
        logger.exception(f"[{city}] Unexpected error during inference: {exc}")
        raise


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Run 48h AQI forecast for a city")
    ap.add_argument("--city",        required=True)
    ap.add_argument("--stale-hours", type=int, default=None,
                    help="Override ML_STALE_HOURS env var")
    args = ap.parse_args()

    if args.stale_hours is not None:
        STALE_HOURS = args.stale_hours

    result = predict_city(args.city)
    if result:
        for row in result[:5]:
            print(row)
        print(f"... {len(result)} total forecast hours")
