const mongoose = require("mongoose");
const {
  getLatestForCity,
  getActiveCities,
  LocationAQI,
  aqiToCategory,
  get10DayHourlySnapshots,
} = require("../services/openaqService");
const { get48HourForecast } = require("../services/mlService");
const cache = require("../config/cache");
const logger = require("../config/logger");

const TTL = {
  current: parseInt(process.env.CACHE_TTL_CURRENT) || 600,
  forecast: parseInt(process.env.CACHE_TTL_FORECAST) || 1800,
  history: parseInt(process.env.CACHE_TTL_HISTORY) || 3600,
};

const CATEGORY_META = {
  Good: { color: "#22c55e", risk: "low" },
  Satisfactory: { color: "#84cc16", risk: "low" },
  Moderate: { color: "#eab308", risk: "moderate" },
  Poor: { color: "#f97316", risk: "high" },
  "Very Poor": { color: "#ef4444", risk: "very_high" },
  Severe: { color: "#7f1d1d", risk: "severe" },
};

const getCategory = (aqi) => {
  const label = aqiToCategory(aqi);
  return {
    label,
    ...(CATEGORY_META[label] || { color: "#6b7280", risk: "unknown" }),
  };
};

const extractLocation = (query) => {
  const { district, lat, lon } = query;

  if (district) {
    const c = district.trim();
    if (c.length < 2)
      throw { status: 400, message: "District name is too short." };
    if (c.length > 80)
      throw { status: 400, message: "District name is too long." };
    if (/[^a-zA-Z\s\-'.]/.test(c))
      throw {
        status: 400,
        message: "District name contains invalid characters.",
      };
    return { district: c, lat: null, lon: null };
  }

  if (lat !== undefined && lon !== undefined) {
    const la = parseFloat(lat);
    const lo = parseFloat(lon);
    if (isNaN(la) || isNaN(lo))
      throw { status: 400, message: "Coordinates must be valid numbers." };
    if (la < 6.5 || la > 37.5 || lo < 68 || lo > 97.5)
      throw {
        status: 400,
        message: "Coordinates are outside India's geographic boundaries.",
      };
    return { district: null, lat: la, lon: lo };
  }

  throw {
    status: 400,
    message: "Provide either ?district=Delhi or ?lat=28.6&lon=77.2",
  };
};

const coordsToCity = async (lat, lon) => {
  const stations = await LocationAQI.find({}).select("city coordinates").lean();
  if (!stations.length) return "Delhi";
  let nearest = stations[0];
  let minDist = Infinity;
  for (const s of stations) {
    if (!s.coordinates?.lat || !s.coordinates?.lon) continue;
    const d = Math.hypot(lat - s.coordinates.lat, lon - s.coordinates.lon);
    if (d < minDist) {
      minDist = d;
      nearest = s;
    }
  }
  return nearest.city || "Delhi";
};

// ── Fetch ML forecast from ml_forecasts collection ────────────────────────────
const getMLForecastMap = async (city) => {
  try {
    const doc = await mongoose.connection.db
      .collection("ml_forecasts")
      .findOne({ city: new RegExp(`^${city.trim()}$`, "i") });

    if (!doc?.forecast?.length) return {};

    // Build map: "YYYY-MM-DDTHH" → predicted AQI
    const map = {};
    for (const f of doc.forecast) {
      const ts = new Date(f.timestamp || f.time);
      if (!isNaN(ts)) {
        // Convert UTC timestamp to IST key
        const istTs = new Date(ts.getTime() + 5.5 * 60 * 60 * 1000);
        const key = istTs.toISOString().slice(0, 13); // "2026-04-30T17"
        map[key] = f.aqi;
      }
    }
    return map;
  } catch (err) {
    logger.warn(`Could not fetch ml_forecasts for ${city}: ${err.message}`);
    return {};
  }
};

// ── 10-day hourly history merged with ML predictions ─────────────────────────
const get10DayHistory = async (city) => {
  const [snapshots, predictedMap] = await Promise.all([
    get10DayHourlySnapshots(city),
    getMLForecastMap(city),
  ]);

  // Use IST-shifted 'now' to match snapshots in DB
  const now = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return snapshots
    .filter((s) => new Date(s.timestamp) <= now)
    .map((s) => {
      // Build IST key from snapshot timestamp for lookup
      const ts = new Date(s.timestamp);
      const istTs = new Date(ts.getTime() + 5.5 * 60 * 60 * 1000);
      const key = istTs.toISOString().slice(0, 13);

      // Use predicted from snapshot if already stored, else from ml_forecasts map
      const predicted = s.predicted ?? predictedMap[key] ?? null;

      return {
        timestamp: s.timestamp,
        date: s.date,
        hour: s.hour,
        label: `${s.date} ${String(s.hour).padStart(2, "0")}:00`,
        actual: s.actual,
        predicted,
        dataPoints: s.stationCount,
      };
    });
};

const getAdvisory = (categoryLabel) => {
  const map = {
    Good: {
      icon: "🟢",
      general: "Air quality is excellent. Perfect for all outdoor activities.",
      sensitive: "No precautions needed.",
      outdoor: "Ideal for outdoor exercise.",
    },
    Satisfactory: {
      icon: "🟡",
      general: "Air quality is acceptable for most people.",
      sensitive:
        "Unusually sensitive individuals may experience mild discomfort.",
      outdoor: "Suitable for moderate outdoor activity.",
    },
    Moderate: {
      icon: "🟠",
      general: "Sensitive groups may experience health effects.",
      sensitive:
        "People with heart or lung disease, elderly and children should reduce exertion.",
      outdoor: "Consider reducing intense outdoor activity.",
    },
    Poor: {
      icon: "🔴",
      general: "Everyone may begin to experience health effects.",
      sensitive:
        "Wear N95 masks outdoors. Sensitive groups should stay indoors.",
      outdoor: "Avoid prolonged outdoor exertion. Keep windows closed.",
    },
    "Very Poor": {
      icon: "🟤",
      general: "Health warnings for the entire population.",
      sensitive:
        "Stay indoors and keep activity low. Serious health effects possible.",
      outdoor: "Avoid all outdoor physical activity. Use air purifiers.",
    },
    Severe: {
      icon: "⚫",
      general: "Emergency conditions. Population at significant risk.",
      sensitive: "Do not go outside under any circumstances.",
      outdoor:
        "Stay indoors, seal windows, use air purifiers at max. Seek medical help if symptomatic.",
    },
  };
  return map[categoryLabel] || map["Moderate"];
};

// ── Controllers ───────────────────────────────────────────────────────────────

// GET /api/aqi/current
const getCurrentAQI = async (req, res) => {
  try {
    let { district, lat, lon } = extractLocation(req.query);
    if (!district) district = await coordsToCity(lat, lon);

    const cKey = `current:${district.toLowerCase()}`;
    const cached = cache.get(cKey);
    if (cached) return res.json({ success: true, data: cached, cached: true });

    const reading = await getLatestForCity(district);
    if (!reading) {
      return res.status(404).json({
        success: false,
        error: `No AQI data available for "${district}".`,
        suggestion: "Use /api/aqi/districts to browse available cities.",
      });
    }

    const category = getCategory(reading.aqi);
    const data = {
      district: reading.city || district,
      state: reading.state || "",
      stationName: reading.locationName,
      lat: reading.coordinates?.lat,
      lon: reading.coordinates?.lon,
      actualAQI: reading.aqi,
      predictedAQI: null,
      category,
      pollutants: reading.pollutants,
      advisory: getAdvisory(category.label),
      recordedAt: reading.recordedAt,
      dataAge:
        Math.round((Date.now() - new Date(reading.recordedAt)) / 60000) +
        " minutes ago",
      source: "WAQI via Aerosense",
    };

    cache.set(cKey, data, TTL.current);
    res.json({ success: true, data });
  } catch (err) {
    if (err.status)
      return res
        .status(err.status)
        .json({ success: false, error: err.message });
    logger.error("getCurrentAQI:", err);
    res.status(500).json({ success: false, error: "Server error." });
  }
};

// GET /api/aqi/forecast
const getForecast = async (req, res) => {
  try {
    let { district, lat, lon } = extractLocation(req.query);
    if (!district) district = await coordsToCity(lat, lon);

    const cKey = `forecast:${district.toLowerCase()}`;
    const cached = cache.get(cKey);
    if (cached) return res.json({ success: true, data: cached, cached: true });

    const reading = await getLatestForCity(district);
    if (!reading)
      return res
        .status(404)
        .json({ success: false, error: `No data for "${district}".` });

    const forecast = await get48HourForecast(
      district,
      reading.aqi,
      reading.pollutants,
      reading.coordinates?.lat,
      reading.coordinates?.lon,
    );

    const data = {
      district: reading.city || district,
      state: reading.state || "",
      baseAQI: reading.aqi,
      forecast: forecast.map((f) => ({ ...f, category: getCategory(f.aqi) })),
      modelType: process.env.ML_SERVICE_URL
        ? "ml_model"
        : "statistical_baseline",
      generatedAt: new Date().toISOString(),
    };

    cache.set(cKey, data, TTL.forecast);
    res.json({ success: true, data });
  } catch (err) {
    if (err.status)
      return res
        .status(err.status)
        .json({ success: false, error: err.message });
    logger.error("getForecast:", err);
    res.status(500).json({ success: false, error: "Server error." });
  }
};

// GET /api/aqi/history
const getHistoricalData = async (req, res) => {
  try {
    let district;
    try {
      const loc = extractLocation(req.query);
      if (!loc.district) {
        district = await coordsToCity(loc.lat, loc.lon);
      } else {
        district = loc.district;
      }
    } catch (e) {
      return res
        .status(e.status || 400)
        .json({ success: false, error: e.message });
    }

    const cKey = `history:${district.toLowerCase()}`;
    const cached = cache.get(cKey);
    if (cached) return res.json({ success: true, data: cached, cached: true });

    const history = await get10DayHistory(district);
    if (!history.length) {
      return res.status(404).json({
        success: false,
        error: `No historical data for "${district}" yet.`,
        hint: "Data accumulates hourly. Check back after the next sync.",
      });
    }

    const hasPredictions = history.some((h) => h.predicted != null);

    const data = {
      district,
      history,
      dataPoints: history.length,
      hasPredictions,
      source: "WAQI via Aerosense",
    };
    cache.set(cKey, data, TTL.history);
    res.json({ success: true, data });
  } catch (err) {
    logger.error("getHistoricalData:", err);
    res.status(500).json({ success: false, error: "Server error." });
  }
};

// GET /api/aqi/dashboard
const getDashboard = async (req, res) => {
  try {
    let { district, lat, lon } = extractLocation(req.query);
    if (!district) district = await coordsToCity(lat, lon);

    const cKey = `dashboard:${district.toLowerCase()}`;
    const cached = cache.get(cKey);
    const force = req.query.force === "true";

    if (cached && !force) return res.json({ success: true, data: cached, cached: true });

    const reading = await getLatestForCity(district);
    if (!reading) {
      return res.status(404).json({
        success: false,
        error: `No OpenAQ data for "${district}".`,
        suggestion: "Use /api/aqi/districts to browse available cities.",
      });
    }

    const [forecast, history] = await Promise.all([
      get48HourForecast(
        district,
        reading.aqi,
        reading.pollutants,
        reading.coordinates?.lat,
        reading.coordinates?.lon,
      ),
      get10DayHistory(district),
    ]);

    const category = getCategory(reading.aqi);
    const hasPredictions = history.some((h) => h.predicted != null);

    const data = {
      district: reading.city || district,
      state: reading.state || "",
      current: {
        district: reading.city || district,
        state: reading.state || "",
        stationName: reading.locationName,
        actualAQI: reading.aqi,
        predictedAQI: null,
        category,
        pollutants: reading.pollutants,
        advisory: getAdvisory(category.label),
        recordedAt: reading.recordedAt,
        dataAge:
          Math.round((Date.now() - new Date(reading.recordedAt)) / 60000) +
          " minutes ago",
      },
      forecast: forecast.map((f) => ({ ...f, category: getCategory(f.aqi) })),
      history: {
        history,
        dataPoints: history.length,
        hasPredictions,
        source: "WAQI via Aerosense",
      },
      meta: {
        source: "WAQI",
        generatedAt: new Date().toISOString(),
        modelStatus: process.env.ML_SERVICE_URL
          ? "ml_connected"
          : "statistical_baseline",
      },
    };

    cache.set(cKey, data, TTL.current);
    res.json({ success: true, data });
  } catch (err) {
    if (err.status)
      return res
        .status(err.status)
        .json({ success: false, error: err.message });
    logger.error("getDashboard:", err);
    res.status(500).json({ success: false, error: "Server error." });
  }
};

// GET /api/aqi/districts
const getDistricts = async (req, res) => {
  try {
    const cKey = "districts_list";
    let cities = cache.get(cKey);

    if (!cities) {
      cities = await getActiveCities();
      cache.set(cKey, cities, 3600);
    }

    if (req.query.q) {
      const q = req.query.q.toLowerCase();
      cities = cities.filter((c) => c.city.toLowerCase().includes(q));
    }

    const data = cities.map((c) => ({
      name: c.city,
      state: c.country,
      stations: c.stationCount,
      latestAQI: c.latestAQI,
    }));
    res.json({ success: true, count: data.length, data });
  } catch (err) {
    logger.error("getDistricts:", err);
    res.status(500).json({ success: false, error: "Server error." });
  }
};

// GET /api/aqi/stations
const getStations = async (req, res) => {
  try {
    const stations = await LocationAQI.find({ aqi: { $gt: 0 } })
      .select("locationName city state coordinates recordedAt aqi")
      .sort({ city: 1 })
      .lean();
    res.json({ success: true, count: stations.length, data: stations });
  } catch (err) {
    res.status(500).json({ success: false, error: "Server error." });
  }
};

// POST /api/aqi/sync
const triggerSync = async (req, res) => {
  try {
    const { runSync } = require("../jobs/syncCPCB");
    const result = await runSync();
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

module.exports = {
  getCurrentAQI,
  getForecast,
  getHistoricalData,
  getDashboard,
  getDistricts,
  getStations,
  triggerSync,
};