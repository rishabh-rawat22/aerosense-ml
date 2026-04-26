# FILE: ml/scheduler/cron_jobs.py
"""
APScheduler Orchestrator
─────────────────────────
Runs three recurring jobs:

  1. Every 15 minutes — live_sync: pull HourlySnapshots into ml_history
  2. Every hour       — forecast cache: run inference for all cities
  3. Every night 2 AM IST — fine-tune: retrain LSTM on last 90 days

Start with:
    python scheduler/cron_jobs.py

Or via uvicorn if combined with the FastAPI app:
    uvicorn api.forecast_routes:app --host 0.0.0.0 --port 8000
    (the FastAPI startup event starts the scheduler automatically)
"""

import os
import sys
from pathlib import Path
from datetime import datetime, timezone

from apscheduler.schedulers.blocking import BlockingScheduler
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger
from loguru import logger
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

load_dotenv(dotenv_path=ROOT.parent / "server" / ".env")
load_dotenv(dotenv_path=ROOT / ".env", override=False)


# ── Job Definitions ────────────────────────────────────────────────────────────

def job_live_sync():
    """
    Pull the last 7 days of HourlySnapshots into ml_history.
    Runs every 15 minutes in sync with the Node.js WAQI poller.
    """
    logger.info("[scheduler] ▶ live_sync starting")
    try:
        from data.live_sync import sync_live
        written = sync_live(days=7)
        logger.info(f"[scheduler] ✅ live_sync done — {written} records")
    except Exception as exc:
        logger.error(f"[scheduler] ❌ live_sync failed: {exc}")


def job_forecast_cache():
    """
    Run inference for all cities and update the ml_forecasts collection.
    Runs every hour, 5 minutes after the WAQI sync.
    """
    logger.info("[scheduler] ▶ forecast_cache starting")
    try:
        from inference.forecast_cache import cache_all_forecasts
        summary = cache_all_forecasts()
        logger.info(
            f"[scheduler] ✅ forecast_cache done — "
            f"ok={len(summary['success'])} "
            f"skipped={len(summary['skipped'])} "
            f"failed={len(summary['failed'])}"
        )
    except Exception as exc:
        logger.error(f"[scheduler] ❌ forecast_cache failed: {exc}")


def job_nightly_finetune():
    """
    Fine-tune the LSTM on the last 90 days of live ml_history data.
    Runs nightly at 02:00 IST to avoid impacting daytime API traffic.
    """
    logger.info("[scheduler] ▶ nightly fine-tune starting")
    try:
        from models.train import run_training
        run_training(mode="finetune", epochs=10)
        logger.info("[scheduler] ✅ nightly fine-tune complete")
    except Exception as exc:
        logger.error(f"[scheduler] ❌ nightly fine-tune failed: {exc}")


# ── Scheduler Factory ─────────────────────────────────────────────────────────

def build_scheduler(blocking: bool = True):
    """
    Build and configure the APScheduler instance.

    Args:
        blocking: If True, returns a BlockingScheduler (run as standalone).
                  If False, returns a BackgroundScheduler (embed in FastAPI).

    Returns:
        Configured scheduler (not yet started).
    """
    SchedulerClass = BlockingScheduler if blocking else BackgroundScheduler
    scheduler = SchedulerClass(timezone="Asia/Kolkata")

    # Job 1 — live sync every 15 min at :00, :15, :30, :45
    scheduler.add_job(
        job_live_sync,
        trigger=IntervalTrigger(minutes=15),
        id="live_sync",
        name="Live data sync",
        replace_existing=True,
        misfire_grace_time=120,
    )

    # Job 2 — forecast cache every hour at :10 (gives live_sync 10 min to finish)
    scheduler.add_job(
        job_forecast_cache,
        trigger=CronTrigger(minute=10, timezone="Asia/Kolkata"),
        id="forecast_cache",
        name="Forecast cache refresh",
        replace_existing=True,
        misfire_grace_time=300,
    )

    # Job 3 — nightly fine-tune at 02:00 IST
    scheduler.add_job(
        job_nightly_finetune,
        trigger=CronTrigger(hour=2, minute=0, timezone="Asia/Kolkata"),
        id="nightly_finetune",
        name="Nightly LSTM fine-tune",
        replace_existing=True,
        misfire_grace_time=1800,
    )

    logger.info(
        "[scheduler] Jobs registered:\n"
        "  live_sync     — every 15 min\n"
        "  forecast_cache — every hour at :10 IST\n"
        "  nightly_finetune — 02:00 IST daily"
    )
    return scheduler


def run_all_jobs_once():
    """
    Execute all three jobs immediately (useful for smoke-testing the pipeline).
    """
    logger.info("Running all jobs once for smoke test...")
    job_live_sync()
    job_forecast_cache()
    logger.info("Smoke test complete (skipping fine-tune to save time)")


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser(description="Aerosense ML scheduler")
    ap.add_argument(
        "--run-once", action="store_true",
        help="Run all jobs once then exit (for smoke testing)"
    )
    args = ap.parse_args()

    if args.run_once:
        run_all_jobs_once()
    else:
        logger.info("Starting Aerosense ML scheduler (blocking mode)...")
        scheduler = build_scheduler(blocking=True)

        # Run an initial pass on startup before waiting for first interval
        logger.info("Running initial jobs on startup...")
        job_live_sync()
        job_forecast_cache()

        try:
            scheduler.start()
        except (KeyboardInterrupt, SystemExit):
            logger.info("Scheduler stopped.")
