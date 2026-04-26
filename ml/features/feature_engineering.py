# FILE: ml/features/feature_engineering.py
"""
Feature Engineering
────────────────────
Builds the 19-dimensional feature vector used by the LSTM:

  Raw pollutants (7):  aqi, pm25, pm10, no2, so2, co, o3
  Rolling stats  (6):  24h_mean_aqi, 24h_std_aqi, 72h_mean_aqi,
                       24h_mean_pm25, lag_24h_aqi, lag_48h_aqi
  Lag            (1):  lag_168h_aqi  (same hour last week)
  Cyclical time  (6):  hour_sin/cos, dow_sin/dow_cos, month_sin/month_cos

All features are MinMax-scaled per city. Scaler state is persisted to
disk alongside model checkpoints so inference uses identical scaling.
"""

import os
import math
import pickle
from datetime import datetime, timezone
from typing import Optional

import numpy as np
import pandas as pd
from loguru import logger

# ── Constants ─────────────────────────────────────────────────────────────────
SEQ_LEN      = 168          # 7 days of hourly data as LSTM input window
HORIZON      = 48           # 48-hour forecast horizon
FEATURE_COLS = [
    "aqi", "pm25", "pm10", "no2", "so2", "co", "o3",
    "rolling_24h_mean_aqi", "rolling_24h_std_aqi", "rolling_72h_mean_aqi",
    "rolling_24h_mean_pm25", "lag_24h_aqi", "lag_48h_aqi", "lag_168h_aqi",
    "hour_sin", "hour_cos", "dow_sin", "dow_cos", "month_sin", "month_cos",
]
N_FEATURES   = len(FEATURE_COLS)   # 20
TARGET_COL   = "aqi"


# ── Cyclical Encoding ─────────────────────────────────────────────────────────

def cyclical(val: float, period: float) -> tuple[float, float]:
    """
    Encode a periodic value as (sin, cos) pair.

    Args:
        val:    Numeric value in [0, period).
        period: Total cycle length (e.g. 24 for hours).

    Returns:
        (sin_enc, cos_enc) both in [-1, 1].
    """
    angle = 2 * math.pi * val / period
    return math.sin(angle), math.cos(angle)


def add_time_features(df: pd.DataFrame) -> pd.DataFrame:
    """
    Add cyclical time-encoding columns to a DataFrame that has a DatetimeIndex
    or a 'timestamp' column (UTC).

    Args:
        df: DataFrame with DatetimeIndex or 'timestamp' column.

    Returns:
        DataFrame with added sin/cos columns.
    """
    if not isinstance(df.index, pd.DatetimeIndex):
        df = df.set_index("timestamp")

    # Ensure UTC-aware index
    if df.index.tz is None:
        df.index = df.index.tz_localize("UTC")
    ist = df.index.tz_convert("Asia/Kolkata")

    df["hour_sin"],  df["hour_cos"]  = zip(*[cyclical(h, 24)  for h in ist.hour])
    df["dow_sin"],   df["dow_cos"]   = zip(*[cyclical(d, 7)   for d in ist.dayofweek])
    df["month_sin"], df["month_cos"] = zip(*[cyclical(m-1, 12) for m in ist.month])

    return df.reset_index()


# ── Rolling & Lag Features ────────────────────────────────────────────────────

def add_lag_and_rolling(df: pd.DataFrame) -> pd.DataFrame:
    """
    Add rolling-window statistics and lag features.

    Assumes df is sorted by timestamp ascending and already contains
    'aqi' and 'pm25' columns. Missing intermediate hours are forward-filled
    before computation, then backfilled.

    Args:
        df: DataFrame with 'aqi', 'pm25', 'timestamp' columns.

    Returns:
        DataFrame with additional rolling/lag columns.
    """
    df = df.sort_values("timestamp").reset_index(drop=True)

    # Rolling statistics (min_periods allows partial windows at the start)
    df["rolling_24h_mean_aqi"]  = df["aqi"].rolling(24,  min_periods=1).mean()
    df["rolling_24h_std_aqi"]   = df["aqi"].rolling(24,  min_periods=2).std().fillna(0)
    df["rolling_72h_mean_aqi"]  = df["aqi"].rolling(72,  min_periods=1).mean()
    df["rolling_24h_mean_pm25"] = df["pm25"].rolling(24, min_periods=1).mean()

    # Lag features
    df["lag_24h_aqi"]  = df["aqi"].shift(24)
    df["lag_48h_aqi"]  = df["aqi"].shift(48)
    df["lag_168h_aqi"] = df["aqi"].shift(168)

    # Backfill lags at the beginning of history
    lag_cols = ["lag_24h_aqi", "lag_48h_aqi", "lag_168h_aqi"]
    df[lag_cols] = df[lag_cols].fillna(method="bfill").fillna(df["aqi"].median())

    return df


# ── Imputation ────────────────────────────────────────────────────────────────

def impute_pollutants(df: pd.DataFrame) -> pd.DataFrame:
    """
    Forward-fill then backward-fill missing pollutant values.
    Any remaining NaNs are filled with 0 (sensor offline → treat as zero).

    Args:
        df: DataFrame with pollutant columns.

    Returns:
        DataFrame with no NaN values in pollutant columns.
    """
    poll_cols = ["pm25", "pm10", "no2", "so2", "co", "o3"]
    for col in poll_cols:
        if col not in df.columns:
            df[col] = 0.0
    df[poll_cols] = (
        df[poll_cols]
        .fillna(method="ffill")
        .fillna(method="bfill")
        .fillna(0.0)
    )
    return df


def reindex_hourly(df: pd.DataFrame) -> pd.DataFrame:
    """
    Reindex the DataFrame to a complete hourly UTC timeline, forward-filling gaps.
    Gaps longer than 6 hours are left as NaN (sensor offline flag) and filled with 0.

    Args:
        df: DataFrame with 'timestamp' column (UTC datetimes).

    Returns:
        Hourly-reindexed DataFrame.
    """
    df = df.copy()
    df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True)
    df = df.set_index("timestamp").sort_index()

    full_range = pd.date_range(df.index.min(), df.index.max(), freq="h", tz="UTC")
    df = df.reindex(full_range)
    df.index.name = "timestamp"

    # Forward-fill up to 6 hours for short gaps
    df = df.fillna(method="ffill", limit=6).fillna(0)
    df = df.reset_index()
    return df


# ── Scaling ───────────────────────────────────────────────────────────────────

class CityScaler:
    """
    MinMax scaler stored per city. Persisted to disk as a pickle file.

    Attributes:
        city:   City name.
        mins_:  Dict of feature → min value.
        maxs_:  Dict of feature → max value.
        fitted: Whether the scaler has been fitted.
    """

    def __init__(self, city: str):
        self.city    = city
        self.mins_: dict[str, float] = {}
        self.maxs_: dict[str, float] = {}
        self.fitted  = False

    def fit(self, df: pd.DataFrame) -> "CityScaler":
        """
        Fit scaler from a DataFrame containing FEATURE_COLS.

        Args:
            df: Training DataFrame.

        Returns:
            self (for chaining).
        """
        for col in FEATURE_COLS:
            if col in df.columns:
                self.mins_[col] = float(df[col].min())
                self.maxs_[col] = float(df[col].max())
            else:
                self.mins_[col] = 0.0
                self.maxs_[col] = 1.0
        self.fitted = True
        return self

    def transform(self, df: pd.DataFrame) -> pd.DataFrame:
        """
        Scale FEATURE_COLS to [0, 1] using fitted min/max.

        Args:
            df: DataFrame with FEATURE_COLS columns.

        Returns:
            Scaled DataFrame (same columns, values in [0, 1]).
        """
        if not self.fitted:
            raise RuntimeError("Scaler not fitted — call .fit() first")
        df = df.copy()
        for col in FEATURE_COLS:
            lo, hi = self.mins_.get(col, 0), self.maxs_.get(col, 1)
            rng = hi - lo if hi != lo else 1.0
            df[col] = (df[col] - lo) / rng
        return df

    def inverse_transform_aqi(self, scaled: np.ndarray) -> np.ndarray:
        """
        Reverse-scale AQI predictions back to original range.

        Args:
            scaled: Array of scaled AQI values in [0, 1].

        Returns:
            AQI values in original units.
        """
        lo = self.mins_.get("aqi", 0)
        hi = self.maxs_.get("aqi", 500)
        return scaled * (hi - lo) + lo

    def save(self, path: str):
        """Persist scaler state to a pickle file."""
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            pickle.dump({"mins": self.mins_, "maxs": self.maxs_, "city": self.city}, f)
        logger.debug(f"Scaler saved → {path}")

    @classmethod
    def load(cls, path: str) -> "CityScaler":
        """
        Load a persisted scaler from disk.

        Args:
            path: Path to pickle file.

        Returns:
            Fitted CityScaler instance.

        Raises:
            FileNotFoundError: If pickle file does not exist.
        """
        if not os.path.isfile(path):
            raise FileNotFoundError(f"Scaler not found: {path}")
        with open(path, "rb") as f:
            state = pickle.load(f)
        sc = cls(city=state["city"])
        sc.mins_  = state["mins"]
        sc.maxs_  = state["maxs"]
        sc.fitted = True
        return sc


# ── Full Pipeline ─────────────────────────────────────────────────────────────

def build_features(df: pd.DataFrame, scaler: Optional[CityScaler] = None,
                   fit_scaler: bool = False) -> tuple[pd.DataFrame, CityScaler]:
    """
    Run the complete feature engineering pipeline on raw ml_history data.

    Steps:
        1. Reindex to hourly grid (fill gaps up to 6h)
        2. Impute missing pollutants
        3. Add time encodings
        4. Add rolling stats and lags
        5. Fit/transform scaler

    Args:
        df:          Raw DataFrame from ml_history (must have 'timestamp', 'aqi').
        scaler:      Pre-fitted CityScaler (use for inference/validation).
                     Pass None + fit_scaler=True for training.
        fit_scaler:  Whether to fit a new scaler from df.

    Returns:
        (feature_df, scaler) — feature_df has all FEATURE_COLS scaled to [0,1].
    """
    city = df["city"].iloc[0] if "city" in df.columns else "unknown"

    # 1. Hourly reindex
    df = reindex_hourly(df)

    # 2. Impute pollutants
    df = impute_pollutants(df)

    # 3. Time features (uses timestamp index)
    df = add_time_features(df)

    # 4. Rolling + lag (needs sorted, imputed aqi/pm25)
    df = add_lag_and_rolling(df)

    # 5. Ensure all feature cols exist
    for col in FEATURE_COLS:
        if col not in df.columns:
            df[col] = 0.0

    # Drop rows still containing NaN in feature cols
    df = df.dropna(subset=FEATURE_COLS).reset_index(drop=True)

    # 6. Scale
    if scaler is None:
        scaler = CityScaler(city=city)
    if fit_scaler:
        scaler.fit(df)

    df = scaler.transform(df)
    return df, scaler


def make_sequences(df: pd.DataFrame,
                   seq_len: int = SEQ_LEN,
                   horizon: int = HORIZON
                   ) -> tuple[np.ndarray, np.ndarray]:
    """
    Slice the feature DataFrame into (X, y) sliding window sequences.

    Args:
        df:      Scaled feature DataFrame with FEATURE_COLS.
        seq_len: Number of past hours as input (default 168).
        horizon: Number of future hours as output (default 48).

    Returns:
        X: shape (n_samples, seq_len, n_features)
        y: shape (n_samples, horizon)  — scaled AQI targets
    """
    feature_arr = df[FEATURE_COLS].values.astype(np.float32)
    target_col_idx = FEATURE_COLS.index(TARGET_COL)

    X_list, y_list = [], []
    total = len(feature_arr) - seq_len - horizon + 1
    if total <= 0:
        raise ValueError(
            f"Not enough data: need at least {seq_len + horizon} rows, got {len(feature_arr)}"
        )

    for i in range(total):
        X_list.append(feature_arr[i : i + seq_len])
        y_list.append(feature_arr[i + seq_len : i + seq_len + horizon, target_col_idx])

    return np.array(X_list, dtype=np.float32), np.array(y_list, dtype=np.float32)


def get_inference_window(df: pd.DataFrame,
                         scaler: CityScaler,
                         seq_len: int = SEQ_LEN) -> Optional[np.ndarray]:
    """
    Build a single inference input from the most recent `seq_len` hours.

    Args:
        df:      Raw (unscaled) ml_history DataFrame for one city.
        scaler:  Fitted CityScaler for this city.
        seq_len: Lookback window (default 168).

    Returns:
        Numpy array of shape (1, seq_len, n_features) or None if
        insufficient data is available.
    """
    feat_df, _ = build_features(df, scaler=scaler, fit_scaler=False)
    if len(feat_df) < seq_len:
        logger.warning(
            f"Insufficient data for inference: need {seq_len}, have {len(feat_df)}"
        )
        return None

    window = feat_df[FEATURE_COLS].values[-seq_len:].astype(np.float32)
    return window[np.newaxis, ...]   # (1, seq_len, n_features)
