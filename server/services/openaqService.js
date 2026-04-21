/**
 * openaqService.js
 */

const axios = require("axios");
const mongoose = require("mongoose");
const logger = require("../config/logger");

// ─────────────────────────────────────────────────────────────────────────────
// MONGOOSE SCHEMA & MODEL — current station data
// ─────────────────────────────────────────────────────────────────────────────

const locationAQISchema = new mongoose.Schema(
  {
    locationName: { type: String, required: true, unique: true, trim: true },
    city: { type: String, default: "", trim: true },
    state: { type: String, default: "", trim: true },
    country: { type: String, default: "IN", trim: true },
    coordinates: {
      lat: { type: Number, default: null },
      lon: { type: Number, default: null },
    },
    aqi: { type: Number, default: null },
    category: { type: String, default: "Unknown" },
    pollutants: {
      pm25: { type: Number, default: null },
      pm10: { type: Number, default: null },
      no2: { type: Number, default: null },
      so2: { type: Number, default: null },
      co: { type: Number, default: null },
      o3: { type: Number, default: null },
      nh3: { type: Number, default: null },
    },
    recordedAt: { type: Date, default: null },
    source: { type: String, default: "WAQI" },
  },
  { timestamps: true },
);

locationAQISchema.index({ city: 1, recordedAt: -1 });
locationAQISchema.index(
  { recordedAt: 1 },
  { expireAfterSeconds: 60 * 24 * 60 * 60 },
);

const LocationAQI =
  mongoose.models.LocationAQI ||
  mongoose.model("LocationAQI", locationAQISchema);

// ─────────────────────────────────────────────────────────────────────────────
// HOURLY SNAPSHOT SCHEMA — one record per city per hour
// Powers the 10-day hourly chart (240 points)
// ─────────────────────────────────────────────────────────────────────────────

const hourlySnapshotSchema = new mongoose.Schema(
  {
    city: { type: String, required: true, trim: true },
    date: { type: String, required: true }, // "YYYY-MM-DD"
    hour: { type: Number, required: true }, // 0-23
    timestamp: { type: Date, required: true }, // exact hour datetime
    actual: { type: Number, default: null }, // avg AQI for that hour
    predicted: { type: Number, default: null }, // filled by ML later
    pollutants: {
      pm25: { type: Number, default: null },
      pm10: { type: Number, default: null },
      no2: { type: Number, default: null },
      so2: { type: Number, default: null },
      co: { type: Number, default: null },
      o3: { type: Number, default: null },
    },
    stationCount: { type: Number, default: 0 },
  },
  { timestamps: true },
);

// One record per city per hour
hourlySnapshotSchema.index({ city: 1, date: 1, hour: 1 }, { unique: true });

// Auto-delete records older than 11 days
hourlySnapshotSchema.index(
  { timestamp: 1 },
  { expireAfterSeconds: 11 * 24 * 60 * 60 },
);

const HourlySnapshot =
  mongoose.models.HourlySnapshot ||
  mongoose.model("HourlySnapshot", hourlySnapshotSchema);

// ─────────────────────────────────────────────────────────────────────────────
// AQI CATEGORY (India NAQI scale)
// ─────────────────────────────────────────────────────────────────────────────

const AQI_CATEGORIES = [
  { max: 50, label: "Good" },
  { max: 100, label: "Satisfactory" },
  { max: 200, label: "Moderate" },
  { max: 300, label: "Poor" },
  { max: 400, label: "Very Poor" },
  { max: 500, label: "Severe" },
];

const aqiToCategory = (aqi) => {
  if (aqi == null || isNaN(aqi)) return "Unknown";
  for (const { max, label } of AQI_CATEGORIES) {
    if (aqi <= max) return label;
  }
  return "Severe";
};

const PM25_BREAKPOINTS = [
  [0, 30, 0, 50],
  [30, 60, 51, 100],
  [60, 90, 101, 200],
  [90, 120, 201, 300],
  [120, 250, 301, 400],
  [250, 500, 401, 500],
];

const pm25ToAQI = (pm25) => {
  if (pm25 == null || isNaN(pm25) || pm25 < 0) return null;
  for (const [cLow, cHigh, iLow, iHigh] of PM25_BREAKPOINTS) {
    if (pm25 >= cLow && pm25 <= cHigh) {
      return Math.round(
        ((iHigh - iLow) / (cHigh - cLow)) * (pm25 - cLow) + iLow,
      );
    }
  }
  return pm25 > 500 ? 500 : null;
};

// ─────────────────────────────────────────────────────────────────────────────
// FETCH FROM WAQI
// ─────────────────────────────────────────────────────────────────────────────

const fetchWAQI = async () => {
  const token = process.env.WAQI_API_KEY;
  if (!token) throw new Error("WAQI_API_KEY not set in .env");

  const url = `https://api.waqi.info/map/bounds/`;
  const response = await axios.get(url, {
    params: { latlng: "6.5,68,37.5,97.5", token },
    timeout: 25000,
  });

  if (response.data?.status !== "ok") {
    throw new Error(
      `WAQI API error: ${response.data?.data || "Unknown error"}`,
    );
  }

  return response.data.data || [];
};

// ─────────────────────────────────────────────────────────────────────────────
// FETCH STATION DETAIL
// ─────────────────────────────────────────────────────────────────────────────

const fetchStationDetail = async (uid) => {
  const token = process.env.WAQI_API_KEY;
  try {
    const res = await axios.get(`https://api.waqi.info/feed/@${uid}/`, {
      params: { token },
      timeout: 8000,
    });
    if (res.data?.status === "ok") return res.data.data;
  } catch (_) {}
  return null;
};

// ─────────────────────────────────────────────────────────────────────────────
// TRANSFORM WAQI station → MongoDB document
// ─────────────────────────────────────────────────────────────────────────────

const transformStation = (raw, detail = null) => {
  const aqi = parseInt(raw.aqi);

  const stationName = raw.station?.name || `Station ${raw.uid}`;
  const nameParts = stationName.split(",").map((p) => p.trim());

  let city;
  if (
    nameParts.length >= 3 &&
    nameParts[nameParts.length - 1].toLowerCase() === "india"
  ) {
    city = nameParts[nameParts.length - 2];
  } else if (nameParts.length >= 2) {
    city = nameParts[nameParts.length - 1];
  } else {
    city = nameParts[0];
  }

  const iaqi = detail?.iaqi || {};
  const getIaqi = (key) =>
    iaqi[key]?.v != null ? parseFloat(iaqi[key].v) : null;

  return {
    locationName: stationName,
    city,
    state: "",
    country: "IN",
    coordinates: {
      lat: raw.lat ? parseFloat(parseFloat(raw.lat).toFixed(5)) : null,
      lon: raw.lon ? parseFloat(parseFloat(raw.lon).toFixed(5)) : null,
    },
    aqi: isNaN(aqi) ? null : aqi,
    category: aqiToCategory(isNaN(aqi) ? null : aqi),
    pollutants: {
      pm25: getIaqi("pm25"),
      pm10: getIaqi("pm10"),
      no2: getIaqi("no2"),
      so2: getIaqi("so2"),
      co: getIaqi("co"),
      o3: getIaqi("o3"),
      nh3: null,
    },
    recordedAt: raw.station?.time ? new Date(raw.station.time) : new Date(),
    source: "WAQI",
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// SAVE HOURLY SNAPSHOTS — called after every sync
// Groups stations by city, saves one averaged record per city per hour
// Uses upsert so multiple syncs in the same hour just update the same record
// ─────────────────────────────────────────────────────────────────────────────

const saveHourlySnapshots = async (documents) => {
  const now = new Date();
  const date = now.toISOString().slice(0, 10); // "YYYY-MM-DD"
  const hour = now.getUTCHours(); // 0-23

  // Round timestamp to current hour
  const timestamp = new Date(now);
  timestamp.setUTCMinutes(0, 0, 0);

  // Group by city
  const byCity = {};
  for (const doc of documents) {
    if (!doc.city || !doc.aqi) continue;
    if (!byCity[doc.city]) byCity[doc.city] = [];
    byCity[doc.city].push(doc);
  }

  const ops = Object.entries(byCity).map(([city, docs]) => {
    const avgAQI = Math.round(
      docs.reduce((s, d) => s + d.aqi, 0) / docs.length,
    );

    const avgPollutant = (key) => {
      const vals = docs
        .map((d) => d.pollutants?.[key])
        .filter((v) => v != null);
      return vals.length
        ? parseFloat((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2))
        : null;
    };

    return {
      updateOne: {
        filter: { city, date, hour },
        update: {
          $set: {
            city,
            date,
            hour,
            timestamp,
            actual: avgAQI,
            pollutants: {
              pm25: avgPollutant("pm25"),
              pm10: avgPollutant("pm10"),
              no2: avgPollutant("no2"),
              so2: avgPollutant("so2"),
              co: avgPollutant("co"),
              o3: avgPollutant("o3"),
            },
            stationCount: docs.length,
          },
        },
        upsert: true,
      },
    };
  });

  if (ops.length) {
    await HourlySnapshot.bulkWrite(ops, { ordered: false });
    logger.info(
      `📸 Hourly snapshots saved for ${ops.length} cities (${date} hour ${hour})`,
    );
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET 10-DAY HOURLY SNAPSHOTS — used by history controller
// Returns up to 240 points (10 days × 24 hours)
// ─────────────────────────────────────────────────────────────────────────────

const get10DayHourlySnapshots = async (city) => {
  const rx = new RegExp(`^${city.trim()}$`, "i");
  const cutoff = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);

  return HourlySnapshot.find({ city: rx, timestamp: { $gte: cutoff } })
    .sort({ timestamp: 1 })
    .lean();
};

// ─────────────────────────────────────────────────────────────────────────────
// MAIN EXPORT: syncOpenAQData()
// ─────────────────────────────────────────────────────────────────────────────

const syncOpenAQData = async () => {
  const t0 = Date.now();
  logger.info("▶ WAQI sync started");

  const stations = await fetchWAQI();
  logger.info(`WAQI returned ${stations.length} stations across India`);

  if (!stations.length) {
    return { synced: 0, elapsed: "0s" };
  }

  const withAQI = stations.filter((s) => parseInt(s.aqi) > 0);
  const top200 = withAQI.slice(0, 200);

  logger.info(`Fetching pollutant detail for top ${top200.length} stations...`);

  const CONCURRENCY = 10;
  const detailMap = {};

  for (let i = 0; i < top200.length; i += CONCURRENCY) {
    const batch = top200.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map((s) =>
        fetchStationDetail(s.uid).then((d) => ({ uid: s.uid, detail: d })),
      ),
    );
    for (const r of results) {
      if (r.status === "fulfilled" && r.value.detail) {
        detailMap[r.value.uid] = r.value.detail;
      }
    }
  }

  logger.info(
    `Got pollutant details for ${Object.keys(detailMap).length} stations`,
  );

  const documents = withAQI
    .map((s) => transformStation(s, detailMap[s.uid] || null))
    .filter((d) => d.locationName && d.aqi != null);

  if (!documents.length) {
    return { synced: 0, elapsed: `${((Date.now() - t0) / 1000).toFixed(1)}s` };
  }

  const BATCH_SIZE = 500;
  let totalSynced = 0;

  for (let i = 0; i < documents.length; i += BATCH_SIZE) {
    const batch = documents.slice(i, i + BATCH_SIZE).map((doc) => ({
      updateOne: {
        filter: { locationName: doc.locationName },
        update: { $set: doc },
        upsert: true,
      },
    }));
    const result = await LocationAQI.bulkWrite(batch, { ordered: false });
    totalSynced += result.upsertedCount + result.modifiedCount;
  }

  // Save hourly snapshot for the 10-day chart
  await saveHourlySnapshots(documents);

  const elapsed = `${((Date.now() - t0) / 1000).toFixed(1)}s`;
  logger.info(`✅ WAQI sync complete — ${totalSynced} records in ${elapsed}`);
  return { synced: totalSynced, elapsed };
};

// ─────────────────────────────────────────────────────────────────────────────
// QUERY HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const getLatestForCity = async (cityName) => {
  const rx = new RegExp(cityName.trim(), "i");

  let doc = await LocationAQI.findOne({
    city: rx,
    recordedAt: { $gte: new Date(Date.now() - 3 * 60 * 60 * 1000) },
    aqi: { $gt: 0 },
  })
    .sort({ recordedAt: -1 })
    .lean();

  if (!doc) {
    doc = await LocationAQI.findOne({ city: rx, aqi: { $gt: 0 } })
      .sort({ recordedAt: -1 })
      .lean();
  }

  if (!doc) {
    doc = await LocationAQI.findOne({ locationName: rx, aqi: { $gt: 0 } })
      .sort({ recordedAt: -1 })
      .lean();
  }

  return doc;
};

const getActiveCities = async () => {
  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
  return LocationAQI.aggregate([
    {
      $match: {
        recordedAt: { $gte: cutoff },
        city: { $ne: "" },
        aqi: { $gt: 0 },
      },
    },
    {
      $group: {
        _id: "$city",
        country: { $first: "$country" },
        stationCount: { $sum: 1 },
        latestAQI: { $avg: "$aqi" },
      },
    },
    { $sort: { _id: 1 } },
    {
      $project: {
        _id: 0,
        city: "$_id",
        country: 1,
        stationCount: 1,
        latestAQI: { $round: ["$latestAQI", 0] },
      },
    },
  ]);
};

module.exports = {
  syncOpenAQData,
  getLatestForCity,
  getActiveCities,
  LocationAQI,
  HourlySnapshot,
  pm25ToAQI,
  aqiToCategory,
  saveHourlySnapshots,
  get10DayHourlySnapshots,
};
