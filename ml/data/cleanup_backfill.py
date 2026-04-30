# FILE: ml/data/cleanup_backfill.py
"""
Cleanup backfilled data from ml_history.
Removes documents with data_source = "backfill_cpcb" to free Atlas storage.

Usage:
    python data/cleanup_backfill.py
"""

import os
from pathlib import Path
from pymongo import MongoClient
from loguru import logger
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(dotenv_path=ROOT.parent / "server" / ".env")
load_dotenv(dotenv_path=ROOT / ".env", override=False)

MONGO_URI = os.environ.get("MONGO_URI", "")

if __name__ == "__main__":
    if not MONGO_URI:
        logger.error("MONGO_URI not set")
        exit(1)

    client = MongoClient(MONGO_URI)
    db = client.get_default_database()
    col = db["ml_history"]

    count = col.count_documents({"data_source": "backfill_cpcb"})
    logger.info(f"Found {count:,} backfilled documents in ml_history")

    if count > 0:
        confirm = input(f"Delete {count:,} backfilled documents? (yes/no): ")
        if confirm.strip().lower() == "yes":
            result = col.delete_many({"data_source": "backfill_cpcb"})
            logger.success(f"Deleted {result.deleted_count:,} documents")
        else:
            logger.info("Aborted.")

    client.close()
