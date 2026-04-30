// server/jobs/aqiAlertCron.js

const cron = require("node-cron");
const User = require("../models/User");
const { HourlySnapshot } = require("../services/openaqService");
const { sendAqiAlert } = require("../services/emailService");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** AQI threshold above which an alert email is sent. */
const AQI_ALERT_THRESHOLD = 200;

/**
 * Cron schedule strings.
 *
 * Every 3 hours:   "0 */3 * * *"   → runs at 00:00, 03:00, 06:00 … 21:00
 * Daily at 8 AM:   "0 8 * * *"
 * Every minute:    "* * * * *"      ← useful during local development/testing
 */
const SCHEDULES = {
  EVERY_3_HOURS: "0 */3 * * *",
  DAILY_8AM:     "0 8 * * *",
  EVERY_MINUTE:  "* * * * *", // dev only
};

// ---------------------------------------------------------------------------
// Core job logic (exported separately so you can unit-test it without cron)
// ---------------------------------------------------------------------------

/**
 * Runs the full AQI check-and-notify pipeline.
 *
 * Pipeline:
 *  1. Fetch all opted-in users that have a known district.
 *  2. Group them by district (O(n) — one pass over the user array).
 *  3. For each unique district, fetch only the LATEST snapshot (one DB query).
 *  4. If AQI > threshold, fire alert emails concurrently (Promise.allSettled).
 *  5. Log a concise summary; individual failures don't abort the batch.
 *
 * @returns {Promise<void>}
 */
async function runAqiAlertJob() {
  const jobStart = Date.now();
  console.log(`\n[AqiAlertCron] ▶  Job started at ${new Date().toISOString()}`);

  // ------------------------------------------------------------------
  // Step 1 – Fetch opted-in users with a known district
  // ------------------------------------------------------------------
  let users;
  try {
    users = await User.find(
      {
        notificationsEnabled: true,
        lastKnownDistrict: { $exists: true, $nin: [null, ""] },
      },
      "email name lastKnownDistrict" // project only the fields we need
    ).lean();
  } catch (err) {
    console.error("[AqiAlertCron] ✖  Failed to fetch users:", err.message);
    return;
  }

  if (!users.length) {
    console.log("[AqiAlertCron] ℹ  No opted-in users found. Job complete.");
    return;
  }

  console.log(`[AqiAlertCron] ℹ  ${users.length} opted-in user(s) found.`);

  // ------------------------------------------------------------------
  // Step 2 – Group users by district  →  { "Delhi": [user1, user2], … }
  // ------------------------------------------------------------------
  /** @type {Map<string, Array<{email:string, name:string}>>} */
  const districtMap = new Map();

  for (const user of users) {
    const district = user.lastKnownDistrict.trim();
    if (!districtMap.has(district)) districtMap.set(district, []);
    districtMap.get(district).push({ email: user.email, name: user.name });
  }

  const uniqueDistricts = [...districtMap.keys()];
  console.log(
    `[AqiAlertCron] ℹ  ${uniqueDistricts.length} unique district(s): ${uniqueDistricts.join(", ")}`
  );

  // ------------------------------------------------------------------
  // Step 3 & 4 – Per-district: fetch latest AQI → decide → send emails
  // ------------------------------------------------------------------
  let totalAlertsSent = 0;
  let totalAlertsFailed = 0;
  let districtsAboveThreshold = 0;

  for (const district of uniqueDistricts) {
    // One DB query per district (not per user) — this is the key optimisation.
    let snapshot;
    try {
      snapshot = await HourlySnapshot.findOne(
        { city: district },
        "actual timestamp"
      )
        .sort({ timestamp: -1 }) // most recent first
        .lean();
    } catch (err) {
      console.error(
        `[AqiAlertCron] ✖  Snapshot query failed for "${district}":`,
        err.message
      );
      continue; // skip this district, move on
    }

    if (!snapshot) {
      console.warn(`[AqiAlertCron] ⚠  No snapshot found for district "${district}". Skipping.`);
      continue;
    }

    const aqi = snapshot.actual;
    console.log(`[AqiAlertCron] ℹ  ${district} → AQI ${aqi}`);

    if (aqi <= AQI_ALERT_THRESHOLD) {
      console.log(`[AqiAlertCron]    ✔  AQI is acceptable. No alert needed.`);
      continue;
    }

    // AQI is above threshold — send alerts to all users in this district.
    districtsAboveThreshold++;
    const usersInDistrict = districtMap.get(district);

    console.log(
      `[AqiAlertCron]    ⚠  AQI ${aqi} exceeds threshold (${AQI_ALERT_THRESHOLD}). ` +
      `Sending ${usersInDistrict.length} alert(s)…`
    );

    // Fire all emails concurrently; Promise.allSettled never rejects.
    const results = await Promise.allSettled(
      usersInDistrict.map(({ email, name }) =>
        sendAqiAlert({ to: email, name, district, aqi })
      )
    );

    // Tally outcomes
    for (let i = 0; i < results.length; i++) {
      const { status, reason } = results[i];
      const { email } = usersInDistrict[i];

      if (status === "fulfilled") {
        totalAlertsSent++;
        console.log(`[AqiAlertCron]       ✉  Alert sent → ${email}`);
      } else {
        totalAlertsFailed++;
        console.error(
          `[AqiAlertCron]       ✖  Failed to send → ${email}:`,
          reason?.message ?? reason
        );
      }
    }
  }

  // ------------------------------------------------------------------
  // Step 5 – Summary log
  // ------------------------------------------------------------------
  const elapsed = ((Date.now() - jobStart) / 1000).toFixed(2);
  console.log(
    `[AqiAlertCron] ■  Job finished in ${elapsed}s | ` +
    `Districts above threshold: ${districtsAboveThreshold} | ` +
    `Alerts sent: ${totalAlertsSent} | ` +
    `Failures: ${totalAlertsFailed}\n`
  );
}

// ---------------------------------------------------------------------------
// Scheduler factory
// ---------------------------------------------------------------------------

/**
 * Registers and starts the AQI alert cron job.
 *
 * @param {object} [options]
 * @param {string} [options.schedule] - A valid cron expression.
 *   Defaults to every 3 hours in production, every minute in development.
 * @param {boolean} [options.runImmediately] - If true, also fires once right
 *   now so you don't have to wait for the first scheduled tick.
 * @returns {cron.ScheduledTask} The cron task instance (call .stop() to halt).
 */
function startAqiAlertCron({ schedule, runImmediately = false } = {}) {
  const resolvedSchedule =
    schedule ??
    (process.env.NODE_ENV === "development"
      ? SCHEDULES.EVERY_MINUTE   // tight feedback loop while developing
      : SCHEDULES.EVERY_3_HOURS);

  if (!cron.validate(resolvedSchedule)) {
    throw new Error(
      `[AqiAlertCron] Invalid cron expression: "${resolvedSchedule}"`
    );
  }

  console.log(
    `[AqiAlertCron] Scheduler registered with expression: "${resolvedSchedule}"`
  );

  const task = cron.schedule(resolvedSchedule, async () => {
    try {
      await runAqiAlertJob();
    } catch (err) {
      // Top-level safety net — ensures an unexpected throw doesn't crash the
      // process and silently kills future ticks.
      console.error("[AqiAlertCron] ✖  Unhandled error in job:", err);
    }
  });

  if (runImmediately) {
    console.log("[AqiAlertCron] runImmediately=true → firing job now…");
    runAqiAlertJob().catch((err) =>
      console.error("[AqiAlertCron] ✖  Immediate run failed:", err)
    );
  }

  return task;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  startAqiAlertCron,
  runAqiAlertJob, // export for unit testing / manual trigger
  SCHEDULES,
};
