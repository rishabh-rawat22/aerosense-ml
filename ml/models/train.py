# FILE: ml/models/train.py
"""
Training & Fine-Tuning Loop
────────────────────────────
Modes:
  full   — trains from scratch on all ml_history data (backfill + live)
  finetune — continues training on last 90 days of live data only

Usage:
    python models/train.py --mode full     --epochs 50
    python models/train.py --mode finetune --epochs 10
    python models/train.py --mode full     --city Delhi --epochs 50
"""

import os
import sys
import argparse
import math
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional

import numpy as np
import torch
from torch.utils.data import DataLoader, TensorDataset
from pymongo import MongoClient
from loguru import logger
from dotenv import load_dotenv

# ── Path setup ────────────────────────────────────────────────────────────────
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

load_dotenv(dotenv_path=ROOT.parent / "server" / ".env")
load_dotenv(dotenv_path=ROOT / ".env", override=False)

from features.feature_engineering import (
    build_features, make_sequences, CityScaler,
    FEATURE_COLS, SEQ_LEN, HORIZON, N_FEATURES,
)
from models.lstm_model import AQILSTMForecaster, PinballLoss, save_checkpoint, load_checkpoint

# ── Config ────────────────────────────────────────────────────────────────────
MONGO_URI       = os.environ["MONGO_URI"]
CHECKPOINT_DIR  = Path(os.getenv("MODEL_CHECKPOINT_DIR", str(ROOT / "models" / "checkpoints")))
SCALER_DIR      = CHECKPOINT_DIR / "scalers"
BATCH_SIZE      = 64
LR_FULL         = 3e-4
LR_FINETUNE     = 1e-4
FINETUNE_DAYS   = 90
DEVICE          = "cuda" if torch.cuda.is_available() else "cpu"
MIN_TRAIN_ROWS  = SEQ_LEN + HORIZON + 10   # minimum rows needed to train


def fetch_city_data(db, city: str, days: Optional[int] = None) -> Optional[object]:
    """
    Fetch ml_history rows for one city, optionally restricted to last N days.

    Args:
        db:   PyMongo database handle.
        city: City name.
        days: If set, only fetch records newer than this many days ago.

    Returns:
        Pandas DataFrame or None if insufficient data.
    """
    import pandas as pd, re
    query: dict = {"city": re.compile(f"^{re.escape(city.strip())}$", re.IGNORECASE)}
    if days:
        cutoff = datetime.now(timezone.utc) - timedelta(days=days)
        query["timestamp"] = {"$gte": cutoff}

    docs = list(db["ml_history"].find(query, {"_id": 0}).sort("timestamp", 1))
    if len(docs) < MIN_TRAIN_ROWS:
        logger.warning(f"{city}: only {len(docs)} rows — skipping (need {MIN_TRAIN_ROWS})")
        return None

    df = pd.DataFrame(docs)
    df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True)
    logger.info(f"{city}: fetched {len(df):,} rows from ml_history")
    return df


def train_city(
    city: str,
    df,
    mode:   str   = "full",
    epochs: int   = 50,
    existing_model: Optional[AQILSTMForecaster] = None,
    existing_scaler: Optional[CityScaler]       = None,
) -> tuple[AQILSTMForecaster, CityScaler]:
    """
    Train or fine-tune the LSTM for a single city.

    Args:
        city:            City name (used for checkpoint naming).
        df:              Raw ml_history DataFrame (from fetch_city_data).
        mode:            'full' or 'finetune'.
        epochs:          Number of training epochs.
        existing_model:  Pre-loaded model for fine-tuning (None = train from scratch).
        existing_scaler: Pre-loaded scaler for fine-tuning (None = fit new scaler).

    Returns:
        (trained_model, scaler)
    """
    fit_scaler = existing_scaler is None
    feat_df, scaler = build_features(df, scaler=existing_scaler, fit_scaler=fit_scaler)

    if len(feat_df) < MIN_TRAIN_ROWS:
        raise ValueError(f"{city}: insufficient data after feature engineering ({len(feat_df)} rows)")

    X, y = make_sequences(feat_df, seq_len=SEQ_LEN, horizon=HORIZON)
    logger.info(f"{city}: sequences X{X.shape} y{y.shape}")

    # Chronological 80/20 split
    split      = int(len(X) * 0.8)
    X_tr, X_va = X[:split], X[split:]
    y_tr, y_va = y[:split], y[split:]

    tr_ds = TensorDataset(torch.from_numpy(X_tr), torch.from_numpy(y_tr))
    va_ds = TensorDataset(torch.from_numpy(X_va), torch.from_numpy(y_va))
    tr_dl = DataLoader(tr_ds, batch_size=BATCH_SIZE, shuffle=False)
    va_dl = DataLoader(va_ds, batch_size=BATCH_SIZE, shuffle=False)

    # Model
    if existing_model is not None:
        model = existing_model
    else:
        model = AQILSTMForecaster(n_features=N_FEATURES)
    model.to(DEVICE)
    model.train()

    lr        = LR_FINETUNE if mode == "finetune" else LR_FULL
    optimizer = torch.optim.Adam(model.parameters(), lr=lr)
    scheduler = torch.optim.lr_scheduler.ReduceLROnPlateau(
        optimizer, patience=5, factor=0.5, min_lr=1e-6
    )
    criterion = PinballLoss()

    best_val_loss = math.inf
    best_state    = None

    for epoch in range(1, epochs + 1):
        # ── Training ─────────────────────────────────────────────────────────
        model.train()
        tr_losses = []
        for xb, yb in tr_dl:
            xb, yb = xb.to(DEVICE), yb.to(DEVICE)
            optimizer.zero_grad()
            preds = model(xb)
            loss  = criterion(preds, yb)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=1.0)
            optimizer.step()
            tr_losses.append(loss.item())

        # ── Validation ───────────────────────────────────────────────────────
        model.eval()
        va_losses = []
        with torch.no_grad():
            for xb, yb in va_dl:
                xb, yb = xb.to(DEVICE), yb.to(DEVICE)
                preds  = model(xb)
                loss   = criterion(preds, yb)
                va_losses.append(loss.item())

        tr_mean = sum(tr_losses) / len(tr_losses)
        va_mean = sum(va_losses) / len(va_losses) if va_losses else float("nan")
        scheduler.step(va_mean)

        if epoch % 5 == 0 or epoch == 1:
            logger.info(
                f"[{city}] epoch {epoch:03d}/{epochs} "
                f"train={tr_mean:.4f} val={va_mean:.4f} "
                f"lr={optimizer.param_groups[0]['lr']:.2e}"
            )

        if va_mean < best_val_loss:
            best_val_loss = va_mean
            best_state    = {k: v.clone() for k, v in model.state_dict().items()}

    if best_state:
        model.load_state_dict(best_state)

    logger.success(f"[{city}] Training complete — best val loss: {best_val_loss:.4f}")
    return model, scaler


def save_city_artifacts(city: str, model: AQILSTMForecaster, scaler: CityScaler, version: str):
    """
    Persist model checkpoint and scaler for a city.

    Args:
        city:    City name (used in filename).
        model:   Trained model.
        scaler:  Fitted scaler.
        version: Version string, e.g. '20260425'.
    """
    safe_city = city.lower().replace(" ", "_")

    # Versioned checkpoint
    ckpt_path = CHECKPOINT_DIR / f"lstm_{safe_city}_v{version}.pt"
    save_checkpoint(model, str(ckpt_path), metadata={
        "city":    city,
        "version": version,
        "trained_at": datetime.now(timezone.utc).isoformat(),
    })

    # Overwrite 'latest' symlink
    latest = CHECKPOINT_DIR / f"lstm_{safe_city}_latest.pt"
    if latest.exists() or latest.is_symlink():
        latest.unlink()
    latest.symlink_to(ckpt_path.name)
    logger.info(f"Symlink updated: {latest} → {ckpt_path.name}")

    # Save scaler
    SCALER_DIR.mkdir(parents=True, exist_ok=True)
    scaler.save(str(SCALER_DIR / f"{safe_city}.pkl"))


def get_all_cities(db) -> list[str]:
    """Return all distinct city names in ml_history."""
    return sorted(db["ml_history"].distinct("city"))


def run_training(mode: str, epochs: int, target_city: Optional[str] = None):
    """
    Main training entry point.

    Args:
        mode:        'full' | 'finetune'.
        epochs:      Training epochs.
        target_city: Train only this city (default: all cities).
    """
    client  = MongoClient(MONGO_URI)
    db      = client.get_default_database()
    version = datetime.now(timezone.utc).strftime("%Y%m%d")

    cities = [target_city] if target_city else get_all_cities(db)
    logger.info(f"Training mode={mode}, epochs={epochs}, cities={len(cities)}, device={DEVICE}")

    CHECKPOINT_DIR.mkdir(parents=True, exist_ok=True)

    days = FINETUNE_DAYS if mode == "finetune" else None

    for city in cities:
        logger.info(f"═══ Processing: {city} ═══")
        df = fetch_city_data(db, city, days=days)
        if df is None:
            continue

        existing_model  = None
        existing_scaler = None

        if mode == "finetune":
            safe_city = city.lower().replace(" ", "_")
            latest    = CHECKPOINT_DIR / f"lstm_{safe_city}_latest.pt"
            s_path    = SCALER_DIR / f"{safe_city}.pkl"
            if latest.exists():
                try:
                    existing_model  = load_checkpoint(str(latest), device=DEVICE)
                    existing_scaler = CityScaler.load(str(s_path))
                    logger.info(f"Loaded existing model+scaler for {city}")
                except Exception as e:
                    logger.warning(f"Could not load existing artifacts for {city}: {e}")

        try:
            model, scaler = train_city(
                city, df, mode=mode, epochs=epochs,
                existing_model=existing_model, existing_scaler=existing_scaler,
            )
            save_city_artifacts(city, model, scaler, version)
        except Exception as exc:
            logger.error(f"Training failed for {city}: {exc}")

    client.close()
    logger.success(f"All cities processed for mode={mode}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Train/fine-tune AQI LSTM")
    ap.add_argument("--mode",   choices=["full", "finetune"], default="full")
    ap.add_argument("--epochs", type=int, default=50)
    ap.add_argument("--city",   default=None, help="Single city (default: all)")
    args = ap.parse_args()
    run_training(mode=args.mode, epochs=args.epochs, target_city=args.city)
