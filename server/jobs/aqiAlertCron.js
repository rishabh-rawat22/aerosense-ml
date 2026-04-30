// server/jobs/aqiAlertCron.js

const cron = require("node-cron");
const User = require("../models/User");
const { HourlySnapshot } = require("../services/openaqService");
const { sendAqiAlert } = require("../services/emailService");

// AQI threshold above which an alert email is sent.
const AQI_ALERT_THRESHOLD = 200;

const SCHEDULES = {
  EVERY_3_HOURS: "0 */3 * * *",
  DAILY_8AM: "0 8 * * *",
  EVERY_MINUTE: "* * * * *",
};

// Core job logic
async function runAqiAlertJob() {
  const jobStart = Date.now();
  console.log("[AqiAlertCron] Job started at " + new Date().toISOString());

  let users;
  try {
    users = await User.find(
      {
        notificationsEnabled: true,
        lastKnownDistrict: { $exists: true, $nin: [null, ""] },
      },
      "email name lastKnownDistrict"
    ).lean();
  } catch (err) {
    console.error("[AqiAlertCron] Failed to fetch users:", err.message);
    return;
  }

  if (!users.length) {
    console.log("[AqiAlertCron] No opted-in users found. Job complete.");
    return;
  }

  console.log("[AqiAlertCron] " + users.length + " opted-in user(s) found.");

  // Group users by district
  var districtMap = new Map();
  for (var i = 0; i < users.length; i++) {
    var district = users[i].lastKnownDistrict.trim();
    if (!districtMap.has(district)) districtMap.set(district, []);
    districtMap.get(district).push({ email: users[i].email, name: users[i].name });
  }

  var uniqueDistricts = Array.from(districtMap.keys());
  console.log("[AqiAlertCron] " + uniqueDistricts.length + " unique district(s): " + uniqueDistricts.join(", "));

  var totalAlertsSent = 0;
  var totalAlertsFailed = 0;
  var districtsAboveThreshold = 0;

  for (var d = 0; d < uniqueDistricts.length; d++) {
    var dist = uniqueDistricts[d];
    var snapshot;
    try {
      snapshot = await HourlySnapshot.findOne(
        { city: dist },
        "actual timestamp"
      )
        .sort({ timestamp: -1 })
        .lean();
    } catch (err) {
      console.error("[AqiAlertCron] Snapshot query failed for " + dist + ":", err.message);
      continue;
    }

    if (!snapshot) {
      console.warn("[AqiAlertCron] No snapshot found for district " + dist + ". Skipping.");
      continue;
    }

    var aqi = snapshot.actual;
    console.log("[AqiAlertCron] " + dist + " -> AQI " + aqi);

    if (aqi <= AQI_ALERT_THRESHOLD) {
      console.log("[AqiAlertCron] AQI is acceptable. No alert needed.");
      continue;
    }

    districtsAboveThreshold++;
    var usersInDistrict = districtMap.get(dist);

    console.log("[AqiAlertCron] AQI " + aqi + " exceeds threshold (" + AQI_ALERT_THRESHOLD + "). Sending " + usersInDistrict.length + " alert(s)...");

    var results = await Promise.allSettled(
      usersInDistrict.map(function(u) {
        return sendAqiAlert({ to: u.email, name: u.name, district: dist, aqi: aqi });
      })
    );

    for (var r = 0; r < results.length; r++) {
      if (results[r].status === "fulfilled") {
        totalAlertsSent++;
        console.log("[AqiAlertCron] Alert sent -> " + usersInDistrict[r].email);
      } else {
        totalAlertsFailed++;
        console.error("[AqiAlertCron] Failed to send -> " + usersInDistrict[r].email + ":", results[r].reason && results[r].reason.message || results[r].reason);
      }
    }
  }

  var elapsed = ((Date.now() - jobStart) / 1000).toFixed(2);
  console.log("[AqiAlertCron] Job finished in " + elapsed + "s | Districts above threshold: " + districtsAboveThreshold + " | Alerts sent: " + totalAlertsSent + " | Failures: " + totalAlertsFailed);
}

// Scheduler factory
function startAqiAlertCron(options) {
  options = options || {};
  var schedule = options.schedule || (process.env.NODE_ENV === "development" ? SCHEDULES.EVERY_MINUTE : SCHEDULES.EVERY_3_HOURS);

  if (!cron.validate(schedule)) {
    throw new Error("[AqiAlertCron] Invalid cron expression: " + schedule);
  }

  console.log("[AqiAlertCron] Scheduler registered with expression: " + schedule);

  var task = cron.schedule(schedule, function() {
    runAqiAlertJob().catch(function(err) {
      console.error("[AqiAlertCron] Unhandled error in job:", err);
    });
  });

  if (options.runImmediately) {
    console.log("[AqiAlertCron] runImmediately=true, firing job now...");
    runAqiAlertJob().catch(function(err) {
      console.error("[AqiAlertCron] Immediate run failed:", err);
    });
  }

  return task;
}

module.exports = {
  startAqiAlertCron: startAqiAlertCron,
  runAqiAlertJob: runAqiAlertJob,
  SCHEDULES: SCHEDULES,
};
