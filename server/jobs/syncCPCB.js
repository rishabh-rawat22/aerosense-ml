/**
 * OpenAQ Data Sync Job
 * ─────────────────────
 * Runs every hour at :05 IST to pull fresh OpenAQ data into MongoDB.
 * Also fires once immediately on server startup.
 *
 * Manual run: node jobs/syncCPCB.js
 */

require("dotenv").config({ path: require("path").join(__dirname, "../.env") });

const cron = require("node-cron");
const connectDB = require("../config/db");
const { syncOpenAQData } = require("../services/openaqService");
const logger = require("../config/logger");

const isManualRun = require.main === module;

const runSync = async () => {
  logger.info("⏰ OpenAQ sync triggered");
  try {
    const result = await syncOpenAQData();
    logger.info(`✅ Sync done: ${result.synced} records in ${result.elapsed}`);
    return result;
  } catch (err) {
    logger.error(`❌ Sync failed: ${err.message}`);
    // Don't crash the process — next hourly run will retry
  }
};

if (isManualRun) {
  (async () => {
    await connectDB();
    await runSync();
    logger.info("Manual sync complete. Exiting.");
    process.exit(0);
  })();
} else {
  const startCronJob = () => {
    cron.schedule("*/15 * * * *", runSync, { timezone: "Asia/Kolkata" });
    logger.info("📡 OpenAQ sync cron registered — runs hourly at :05 IST");
    runSync(); // Run immediately on startup
  };

  module.exports = { startCronJob, runSync };
}
