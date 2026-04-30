# Aerosense LSTM Training — Google Colab / Kaggle Notebook
# ═══════════════════════════════════════════════════════════
# Run this on Google Colab (free T4 GPU) or Kaggle (free T4 GPU)
#
# Steps:
#   1. Upload this script to Colab/Kaggle
#   2. Upload your data/ folder (454 CSVs + stations_info.csv)
#   3. Set runtime to GPU (Runtime → Change runtime type → T4 GPU)
#   4. Run all cells
#   5. Download the checkpoints/ folder when done

# ── Cell 1: Setup & Dependencies ──────────────────────────────────────────────
# !pip install torch pandas numpy loguru pymongo python-dotenv scikit-learn

import os
import sys
import math
import pickle
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional

import numpy as np
import pandas as pd
import torch
from torch.utils.data import DataLoader, TensorDataset
from loguru import logger

print(f"PyTorch: {torch.__version__}")
print(f"CUDA available: {torch.cuda.is_available()}")
if torch.cuda.is_available():
    print(f"GPU: {torch.cuda.get_device_name(0)}")
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"


# ── Cell 2: Configuration ────────────────────────────────────────────────────
# IMPORTANT: Update this path to where your data/ folder is uploaded
# Colab:  /content/data  (upload via Files panel or Google Drive)
# Kaggle: /kaggle/input/aerosense-data  (upload as dataset)

DATA_DIR = Path("/content/data")  # ← CHANGE THIS for Kaggle
CHECKPOINT_DIR = Path("/content/checkpoints")
SCALER_DIR = CHECKPOINT_DIR / "scalers"
CHECKPOINT_DIR.mkdir(parents=True, exist_ok=True)
SCALER_DIR.mkdir(parents=True, exist_ok=True)

# Training config
EPOCHS = 50
BATCH_SIZE = 128  # larger batch for GPU
LR = 3e-4
SEQ_LEN = 168      # 7 days input window
HORIZON = 48       # 48-hour forecast
IST_OFFSET = timedelta(hours=5, minutes=30)


# ── Cell 3: NAQI AQI Computation ─────────────────────────────────────────────

BREAKPOINTS = {
    "pm25": [(0,30,0,50),(30,60,51,100),(60,90,101,200),(90,120,201,300),(120,250,301,400),(250,380,401,500)],
    "pm10": [(0,50,0,50),(50,100,51,100),(100,250,101,200),(250,350,201,300),(350,430,301,400),(430,510,401,500)],
    "no2":  [(0,40,0,50),(40,80,51,100),(80,180,101,200),(180,280,201,300),(280,400,301,400),(400,510,401,500)],
    "so2":  [(0,40,0,50),(40,80,51,100),(80,380,101,200),(380,800,201,300),(800,1600,301,400),(1600,2100,401,500)],
    "co":   [(0,1.0,0,50),(1.0,2.0,51,100),(2.0,10.0,101,200),(10.0,17.0,201,300),(17.0,34.0,301,400),(34.0,49.0,401,500)],
    "o3":   [(0,50,0,50),(50,100,51,100),(100,168,101,200),(168,208,201,300),(208,748,301,400),(748,1000,401,500)],
    "nh3":  [(0,200,0,50),(200,400,51,100),(400,800,101,200),(800,1200,201,300),(1200,1800,301,400),(1800,2400,401,500)],
}

COLUMN_MAP = {
    "From Date": "timestamp", "To Date": "_to_date",
    "PM2.5 (ug/m3)": "pm25", "PM10 (ug/m3)": "pm10",
    "NO2 (ug/m3)": "no2", "NO (ug/m3)": "no", "NOx (ppb)": "nox",
    "NH3 (ug/m3)": "nh3", "SO2 (ug/m3)": "so2", "CO (mg/m3)": "co",
    "Ozone (ug/m3)": "o3", "Benzene (ug/m3)": "benzene",
    "Toluene (ug/m3)": "toluene", "Temp (degree C)": "temp",
    "AT (degree C)": "temp_at", "RH (%)": "rh", "WS (m/s)": "ws",
    "WD (deg)": "wd", "SR (W/mt2)": "sr", "BP (mmHg)": "bp",
}

POLLUTANT_COLS = ["pm25", "pm10", "no2", "so2", "co", "o3"]
OPTIONAL_COLS = ["nh3"]

FEATURE_COLS = [
    "aqi", "pm25", "pm10", "no2", "so2", "co", "o3",
    "rolling_24h_mean_aqi", "rolling_24h_std_aqi", "rolling_72h_mean_aqi",
    "rolling_24h_mean_pm25", "lag_24h_aqi", "lag_48h_aqi", "lag_168h_aqi",
    "hour_sin", "hour_cos", "dow_sin", "dow_cos", "month_sin", "month_cos",
]
N_FEATURES = len(FEATURE_COLS)  # 20


def safe_float(val):
    try:
        v = float(val)
        return None if math.isnan(v) else v
    except (TypeError, ValueError):
        return None


def compute_aqi_fast(df):
    """Vectorised NAQI AQI computation."""
    def _sub_idx(values, bp_key):
        bp = BREAKPOINTS[bp_key]
        result = np.full(len(values), np.nan)
        for c_lo, c_hi, i_lo, i_hi in bp:
            mask = (values >= c_lo) & (values <= c_hi) & np.isfinite(values)
            result[mask] = ((i_hi - i_lo) / (c_hi - c_lo)) * (values[mask] - c_lo) + i_lo
        over = (values > bp[-1][1]) & np.isfinite(values)
        result[over] = 500
        return result

    sub = {}
    for col in ["pm25", "pm10", "no2", "so2", "co", "o3", "nh3"]:
        if col in df.columns:
            vals = pd.to_numeric(df[col], errors="coerce").values.astype(np.float64)
            sub[col] = _sub_idx(vals, col)
    if not sub:
        return pd.Series(np.nan, index=df.index)
    stack = np.column_stack(list(sub.values()))
    with np.errstate(invalid="ignore"):
        aqi = np.nanmax(stack, axis=1)
    has_pm = np.isfinite(sub.get("pm25", np.full(len(df), np.nan))) | \
             np.isfinite(sub.get("pm10", np.full(len(df), np.nan)))
    aqi[~has_pm] = np.nan
    return pd.Series(pd.array(np.round(aqi), dtype=pd.Int64Dtype()), index=df.index)


# ── Cell 4: CSV Loading ──────────────────────────────────────────────────────

def load_station_csv(csv_path):
    """Load and normalize a single station CSV."""
    try:
        df = pd.read_csv(csv_path, low_memory=False)
    except Exception:
        return None
    if df.empty or "From Date" not in df.columns:
        return None

    rename = {}
    for c in df.columns:
        s = c.strip()
        rename[c] = COLUMN_MAP.get(s, s.lower().replace(" ", "_").replace("(", "").replace(")", ""))
    df = df.rename(columns=rename)

    df["timestamp"] = pd.to_datetime(df["timestamp"], format="%Y-%m-%d %H:%M:%S", errors="coerce")
    df = df.dropna(subset=["timestamp"])
    if df.empty:
        return None
    df["timestamp"] = (df["timestamp"] - IST_OFFSET).dt.tz_localize("UTC")

    for col in POLLUTANT_COLS + OPTIONAL_COLS:
        if col not in df.columns:
            df[col] = np.nan
        df[col] = pd.to_numeric(df[col], errors="coerce")
    return df


def load_city_data(data_dir, city, station_info):
    """Load all station CSVs for a city and aggregate."""
    city_stations = station_info[station_info["city"].str.lower() == city.lower()]
    if city_stations.empty:
        return None

    dfs = []
    for _, st in city_stations.iterrows():
        p = data_dir / f"{st['file_name']}.csv"
        if p.exists():
            df = load_station_csv(p)
            if df is not None and not df.empty:
                dfs.append(df)
    if not dfs:
        return None

    combined = pd.concat(dfs, ignore_index=True)
    pcols = [c for c in POLLUTANT_COLS + OPTIONAL_COLS if c in combined.columns]
    grouped = combined.groupby("timestamp").agg(
        **{col: (col, "mean") for col in pcols},
        station_count=("timestamp", "size"),
    ).reset_index()
    grouped["aqi"] = compute_aqi_fast(grouped)
    grouped = grouped.dropna(subset=["aqi"])
    if grouped.empty:
        return None

    grouped["city"] = city
    grouped["aqi"] = grouped["aqi"].astype(float)
    keep = ["timestamp", "city", "aqi"] + [c for c in POLLUTANT_COLS if c in grouped.columns]
    return grouped[keep].sort_values("timestamp").reset_index(drop=True)


# ── Cell 5: Feature Engineering ──────────────────────────────────────────────

def cyclical(val, period):
    angle = 2 * math.pi * val / period
    return math.sin(angle), math.cos(angle)


def build_features(df):
    """Build 20-dimensional feature vector from raw city data."""
    df = df.copy()
    df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True)
    df = df.set_index("timestamp").sort_index()

    # Reindex to complete hourly timeline
    full_range = pd.date_range(df.index.min(), df.index.max(), freq="h", tz="UTC")
    df = df.reindex(full_range)
    df.index.name = "timestamp"

    # Impute pollutants
    for col in POLLUTANT_COLS:
        if col not in df.columns:
            df[col] = 0.0
    df[POLLUTANT_COLS] = df[POLLUTANT_COLS].ffill().bfill().fillna(0.0)

    # Impute AQI
    df["aqi"] = df["aqi"].ffill().bfill().fillna(0.0)

    # Time features (IST)
    ist = df.index.tz_convert("Asia/Kolkata")
    df["hour_sin"],  df["hour_cos"]  = zip(*[cyclical(h, 24) for h in ist.hour])
    df["dow_sin"],   df["dow_cos"]   = zip(*[cyclical(d, 7) for d in ist.dayofweek])
    df["month_sin"], df["month_cos"] = zip(*[cyclical(m-1, 12) for m in ist.month])

    # Rolling features
    df["rolling_24h_mean_aqi"]  = df["aqi"].rolling(24, min_periods=1).mean()
    df["rolling_24h_std_aqi"]   = df["aqi"].rolling(24, min_periods=2).std().fillna(0)
    df["rolling_72h_mean_aqi"]  = df["aqi"].rolling(72, min_periods=1).mean()
    df["rolling_24h_mean_pm25"] = df["pm25"].rolling(24, min_periods=1).mean()

    # Lag features
    df["lag_24h_aqi"]  = df["aqi"].shift(24)
    df["lag_48h_aqi"]  = df["aqi"].shift(48)
    df["lag_168h_aqi"] = df["aqi"].shift(168)
    lag_cols = ["lag_24h_aqi", "lag_48h_aqi", "lag_168h_aqi"]
    df[lag_cols] = df[lag_cols].bfill().fillna(df["aqi"].median())

    df = df.reset_index()
    df = df.dropna(subset=FEATURE_COLS)
    return df


def make_sequences(df, seq_len=SEQ_LEN, horizon=HORIZON):
    """Create sliding window sequences for LSTM."""
    data = df[FEATURE_COLS].values.astype(np.float32)
    target = df["aqi"].values.astype(np.float32)

    X, y = [], []
    for i in range(len(data) - seq_len - horizon + 1):
        X.append(data[i : i + seq_len])
        y.append(target[i + seq_len : i + seq_len + horizon])
    return np.array(X), np.array(y)


# ── Cell 6: Scaler ───────────────────────────────────────────────────────────

class CityScaler:
    """MinMax scaler that persists per-city scaling parameters."""
    def __init__(self):
        self.min_vals = None
        self.max_vals = None
        self.fitted = False

    def fit_transform(self, df):
        cols = FEATURE_COLS
        data = df[cols].values.astype(np.float64)
        self.min_vals = np.nanmin(data, axis=0)
        self.max_vals = np.nanmax(data, axis=0)
        rng = self.max_vals - self.min_vals
        rng[rng == 0] = 1.0
        scaled = (data - self.min_vals) / rng
        df = df.copy()
        df[cols] = scaled
        self.fitted = True
        return df

    def transform(self, df):
        cols = FEATURE_COLS
        data = df[cols].values.astype(np.float64)
        rng = self.max_vals - self.min_vals
        rng[rng == 0] = 1.0
        scaled = (data - self.min_vals) / rng
        df = df.copy()
        df[cols] = scaled
        return df

    def save(self, path):
        with open(path, "wb") as f:
            pickle.dump({"min": self.min_vals, "max": self.max_vals}, f)

    @classmethod
    def load(cls, path):
        s = cls()
        with open(path, "rb") as f:
            d = pickle.load(f)
        s.min_vals = d["min"]
        s.max_vals = d["max"]
        s.fitted = True
        return s


# ── Cell 7: LSTM Model ──────────────────────────────────────────────────────

class AQILSTMForecaster(torch.nn.Module):
    def __init__(self, n_features=N_FEATURES, hidden=128, layers=2, dropout=0.2, horizon=HORIZON, quantiles=3):
        super().__init__()
        self.lstm = torch.nn.LSTM(n_features, hidden, layers, batch_first=True, dropout=dropout)
        self.fc1 = torch.nn.Linear(hidden, 64)
        self.relu = torch.nn.ReLU()
        self.drop = torch.nn.Dropout(dropout)
        self.fc2 = torch.nn.Linear(64, horizon * quantiles)
        self.horizon = horizon
        self.quantiles = quantiles

    def forward(self, x):
        out, _ = self.lstm(x)
        out = out[:, -1, :]  # last timestep
        out = self.drop(self.relu(self.fc1(out)))
        out = self.fc2(out)
        return out.view(-1, self.horizon, self.quantiles)


class PinballLoss(torch.nn.Module):
    def __init__(self, quantiles=(0.1, 0.5, 0.9)):
        super().__init__()
        self.quantiles = quantiles

    def forward(self, preds, target):
        target = target.unsqueeze(-1).expand_as(preds)
        losses = []
        for i, q in enumerate(self.quantiles):
            err = target[..., i] - preds[..., i]
            losses.append(torch.max(q * err, (q - 1) * err).mean())
        return sum(losses) / len(losses)


# ── Cell 8: Training Loop ───────────────────────────────────────────────────

def train_one_city(city, df, epochs=EPOCHS):
    """Full training pipeline for one city."""
    MIN_ROWS = SEQ_LEN + HORIZON + 10

    # Feature engineering
    feat_df = build_features(df)
    scaler = CityScaler()
    feat_df = scaler.fit_transform(feat_df)

    X, y = make_sequences(feat_df)
    if len(X) < 10:
        logger.warning(f"{city}: too few sequences ({len(X)}) — skipping")
        return None, None

    logger.info(f"{city}: X{X.shape} y{y.shape}")

    # 80/20 split
    split = int(len(X) * 0.8)
    tr_ds = TensorDataset(torch.from_numpy(X[:split]), torch.from_numpy(y[:split]))
    va_ds = TensorDataset(torch.from_numpy(X[split:]), torch.from_numpy(y[split:]))
    tr_dl = DataLoader(tr_ds, batch_size=BATCH_SIZE, shuffle=False)
    va_dl = DataLoader(va_ds, batch_size=BATCH_SIZE, shuffle=False)

    model = AQILSTMForecaster().to(DEVICE)
    optimizer = torch.optim.Adam(model.parameters(), lr=LR)
    scheduler = torch.optim.lr_scheduler.ReduceLROnPlateau(optimizer, patience=5, factor=0.5, min_lr=1e-6)
    criterion = PinballLoss()

    best_val_loss = math.inf
    best_state = None

    for epoch in range(1, epochs + 1):
        # Train
        model.train()
        tr_losses = []
        for xb, yb in tr_dl:
            xb, yb = xb.to(DEVICE), yb.to(DEVICE)
            optimizer.zero_grad()
            preds = model(xb)
            loss = criterion(preds, yb)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
            tr_losses.append(loss.item())

        # Validate
        model.eval()
        va_losses = []
        with torch.no_grad():
            for xb, yb in va_dl:
                xb, yb = xb.to(DEVICE), yb.to(DEVICE)
                loss = criterion(model(xb), yb)
                va_losses.append(loss.item())

        tr_mean = sum(tr_losses) / len(tr_losses)
        va_mean = sum(va_losses) / len(va_losses) if va_losses else float("nan")
        scheduler.step(va_mean)

        if va_mean < best_val_loss:
            best_val_loss = va_mean
            best_state = {k: v.cpu().clone() for k, v in model.state_dict().items()}

        if epoch % 10 == 0 or epoch == 1:
            logger.info(f"  [{city}] epoch {epoch:03d}/{epochs} train={tr_mean:.4f} val={va_mean:.4f}")

    if best_state:
        model.load_state_dict(best_state)

    logger.success(f"  [{city}] done — best val loss: {best_val_loss:.4f}")
    return model, scaler


def save_artifacts(city, model, scaler):
    """Save model checkpoint and scaler."""
    safe = city.lower().replace(" ", "_")
    # Save model
    ckpt_path = CHECKPOINT_DIR / f"lstm_{safe}_latest.pt"
    torch.save({
        "model_state_dict": model.state_dict(),
        "metadata": {"city": city, "trained_at": datetime.now(timezone.utc).isoformat()},
    }, ckpt_path)
    # Save scaler
    scaler.save(str(SCALER_DIR / f"{safe}.pkl"))


# ── Cell 9: Run Training ────────────────────────────────────────────────────

def main():
    # Load station metadata
    station_info = pd.read_csv(DATA_DIR / "stations_info.csv")
    station_info["city"] = station_info["city"].str.strip()
    station_info["file_name"] = station_info["file_name"].str.strip()
    cities = sorted(station_info["city"].unique().tolist())
    logger.info(f"Found {len(cities)} cities, device={DEVICE}")

    results = {"ok": [], "fail": []}
    t_start = time.time()

    for i, city in enumerate(cities, 1):
        logger.info(f"\n═══ [{i}/{len(cities)}] {city} ═══")
        t0 = time.time()

        try:
            df = load_city_data(DATA_DIR, city, station_info)
            if df is None or len(df) < SEQ_LEN + HORIZON + 50:
                logger.warning(f"  {city}: insufficient data — skipping")
                results["fail"].append(city)
                continue

            model, scaler = train_one_city(city, df, epochs=EPOCHS)
            if model is None:
                results["fail"].append(city)
                continue

            save_artifacts(city, model, scaler)
            results["ok"].append(city)
            logger.info(f"  {city}: {time.time()-t0:.1f}s")

        except Exception as e:
            logger.error(f"  {city}: FAILED — {e}")
            results["fail"].append(city)

    elapsed = time.time() - t_start
    logger.success(f"\n{'═'*60}")
    logger.success(f"DONE — {len(results['ok'])} OK, {len(results['fail'])} failed in {elapsed/60:.1f} min")
    logger.success(f"Checkpoints saved to: {CHECKPOINT_DIR}")
    logger.info(f"{'═'*60}")


if __name__ == "__main__":
    main()

# After training completes, download checkpoints:
# Colab: !zip -r /content/checkpoints.zip /content/checkpoints && from google.colab import files; files.download('/content/checkpoints.zip')
# Kaggle: checkpoints will be in /content/checkpoints — add as output
