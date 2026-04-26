# FILE: ml/models/lstm_model.py
"""
LSTM Model Definition
──────────────────────
Architecture:
  - 2-layer stacked LSTM (hidden=128, dropout=0.2)
  - Linear head: 128 → 64 → 48 × 3
  - Output: 48 forecast steps × 3 quantiles (q10, q50, q90)
    → q50 is the point forecast; q10/q90 form the confidence band

Loss: Pinball (quantile) loss — differentiable, directly produces calibrated
      prediction intervals without Monte-Carlo Dropout overhead.
"""

import torch
import torch.nn as nn
import numpy as np
from loguru import logger


QUANTILES = [0.1, 0.5, 0.9]   # lower, median, upper


class AQILSTMForecaster(nn.Module):
    """
    Stacked LSTM for 48-hour AQI forecasting with quantile outputs.

    Args:
        n_features:  Number of input features per time step (default 20).
        hidden_size: LSTM hidden state dimensionality (default 128).
        num_layers:  Number of stacked LSTM layers (default 2).
        horizon:     Number of hours to forecast (default 48).
        dropout:     Dropout rate applied between LSTM layers (default 0.2).
        n_quantiles: Number of quantile outputs (default 3 → q10, q50, q90).
    """

    def __init__(
        self,
        n_features:  int = 20,
        hidden_size: int = 128,
        num_layers:  int = 2,
        horizon:     int = 48,
        dropout:     float = 0.2,
        n_quantiles: int = 3,
    ):
        super().__init__()
        self.hidden_size = hidden_size
        self.num_layers  = num_layers
        self.horizon     = horizon
        self.n_quantiles = n_quantiles

        self.lstm = nn.LSTM(
            input_size=n_features,
            hidden_size=hidden_size,
            num_layers=num_layers,
            dropout=dropout if num_layers > 1 else 0.0,
            batch_first=True,
        )

        self.head = nn.Sequential(
            nn.Linear(hidden_size, 64),
            nn.ReLU(),
            nn.Dropout(dropout),
            nn.Linear(64, horizon * n_quantiles),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        """
        Forward pass.

        Args:
            x: Input tensor of shape (batch, seq_len, n_features).

        Returns:
            Tensor of shape (batch, horizon, n_quantiles).
        """
        lstm_out, _ = self.lstm(x)
        last_hidden  = lstm_out[:, -1, :]          # (batch, hidden_size)
        out          = self.head(last_hidden)       # (batch, horizon * n_quantiles)
        return out.view(-1, self.horizon, self.n_quantiles)


# ── Quantile (Pinball) Loss ───────────────────────────────────────────────────

class PinballLoss(nn.Module):
    """
    Quantile / pinball loss for probabilistic forecasting.

    L_q(y, ŷ) = q * max(y - ŷ, 0) + (1-q) * max(ŷ - y, 0)

    Args:
        quantiles: List of quantile levels, e.g. [0.1, 0.5, 0.9].
    """

    def __init__(self, quantiles: list[float] = QUANTILES):
        super().__init__()
        self.quantiles = quantiles

    def forward(self, preds: torch.Tensor, targets: torch.Tensor) -> torch.Tensor:
        """
        Compute mean pinball loss across all quantiles.

        Args:
            preds:   Predicted quantiles, shape (batch, horizon, n_quantiles).
            targets: Ground-truth AQI, shape (batch, horizon).

        Returns:
            Scalar loss tensor.
        """
        losses = []
        for i, q in enumerate(self.quantiles):
            y_hat = preds[:, :, i]              # (batch, horizon)
            err   = targets - y_hat
            loss  = torch.max(q * err, (q - 1) * err)
            losses.append(loss.mean())
        return torch.stack(losses).mean()


# ── Checkpoint Utilities ──────────────────────────────────────────────────────

def save_checkpoint(model: AQILSTMForecaster, path: str, metadata: dict = None):
    """
    Save model weights + architecture hyperparams to a .pt checkpoint.

    Args:
        model:    Trained model instance.
        path:     Destination file path (e.g. 'checkpoints/lstm_v20260425.pt').
        metadata: Optional dict of extra info stored alongside weights.
    """
    import os
    os.makedirs(os.path.dirname(path), exist_ok=True)
    torch.save({
        "state_dict":  model.state_dict(),
        "hparams": {
            "n_features":  model.lstm.input_size,
            "hidden_size": model.hidden_size,
            "num_layers":  model.num_layers,
            "horizon":     model.horizon,
            "n_quantiles": model.n_quantiles,
        },
        "metadata": metadata or {},
    }, path)
    logger.info(f"Checkpoint saved → {path}")


def load_checkpoint(path: str, device: str = "cpu") -> AQILSTMForecaster:
    """
    Load model weights and reconstruct model from checkpoint.

    Args:
        path:   Path to .pt file.
        device: Torch device string ('cpu' or 'cuda').

    Returns:
        AQILSTMForecaster in eval mode.

    Raises:
        FileNotFoundError: If checkpoint file does not exist.
    """
    import os
    if not os.path.isfile(path):
        raise FileNotFoundError(f"Model checkpoint not found: {path}")

    ckpt   = torch.load(path, map_location=device)
    hp     = ckpt["hparams"]
    model  = AQILSTMForecaster(**hp)
    model.load_state_dict(ckpt["state_dict"])
    model.to(device)
    model.eval()
    logger.info(f"Checkpoint loaded ← {path}  |  metadata: {ckpt.get('metadata', {})}")
    return model
