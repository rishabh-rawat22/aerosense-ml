/**
 * openaqService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Fetches real AQI data for India from WAQI (World Air Quality Index).
 * API: https://aqicn.org/api/
 * Free token: https://aqicn.org/data-platform/token/
 *
 * Strategy: fetch all stations inside India's geographic bounding box.
 * India bounds: lat 6.5–37.5, lon 68–97.5
 * The /map/bounds endpoint returns every station in that rectangle.
 */

const axios = require("axios");
const mongoose = require("mongoose");
const logger = require("../config/logger");

// ─────────────────────────────────────────────────────────────────────────────
// MONGOOSE SCHEMA & MODEL
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

// Compound index for dashboard queries
locationAQISchema.index({ city: 1, recordedAt: -1 });

// TTL — auto-delete records older than 60 days
locationAQISchema.index(
  { recordedAt: 1 },
  { expireAfterSeconds: 60 * 24 * 60 * 60 },
);

const LocationAQI =
  mongoose.models.LocationAQI ||
  mongoose.model("LocationAQI", locationAQISchema);

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

// PM2.5 → AQI using India NAQI breakpoints (used as fallback)
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
// /map/bounds returns all stations inside a lat/lon bounding box.
// India bounding box: lat 6.5,68 to 37.5,97.5
// ─────────────────────────────────────────────────────────────────────────────

const fetchWAQI = async () => {
  const token = process.env.WAQI_API_KEY;
  if (!token) throw new Error("WAQI_API_KEY not set in .env");

  const url = `https://api.waqi.info/map/bounds/`;
  const response = await axios.get(url, {
    params: {
      latlng: "6.5,68,37.5,97.5",
      token,
    },
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
// FETCH STATION DETAIL (pollutant breakdown)
// The /map/bounds endpoint only gives AQI. To get PM2.5, PM10 etc.
// we call /feed/@{uid}/ for each station. We do this for the top 200
// stations only (to avoid rate limits) — the rest get AQI only.
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
    city = nameParts[nameParts.length - 2]; // e.g. "Delhi"
  } else if (nameParts.length >= 2) {
    city = nameParts[nameParts.length - 1]; // fallback
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
// MAIN EXPORT: syncOpenAQData()
// Named syncOpenAQData so the cron job doesn't need renaming.
// ─────────────────────────────────────────────────────────────────────────────

const syncOpenAQData = async () => {
  const t0 = Date.now();
  logger.info("▶ WAQI sync started");

  const stations = await fetchWAQI();
  logger.info(`WAQI returned ${stations.length} stations across India`);

  if (!stations.length) {
    return { synced: 0, elapsed: "0s" };
  }

  // Fetch detail for top 200 stations sorted by AQI descending
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
  pm25ToAQI,
  aqiToCategory,
};
