/**
 * ML Prediction Service
 * ─────────────────────
 * Currently: statistical baseline using real diurnal AQI patterns.
 *
 * TO PLUG IN YOUR ML MODEL:
 *   1. Deploy your Python model (FastAPI recommended)
 *   2. Set ML_SERVICE_URL=http://your-service:8000 in .env
 *   Done — nothing else changes.
 *
 * Expected ML service contract:
 *   POST /predict  { district, currentAQI, pollutants, lat, lon, hour, month }
 *   → { forecast: [{ hour: 0, aqi: 145 }, ...48 items] }
 */

const axios = require("axios");
const logger = require("../config/logger");

// Real hourly AQI multipliers based on Indian city pollution patterns
// Rush hours (7–10am, 5–9pm) drive higher pollution; night is lower
const HOURLY_PATTERN = [
  0.8,
  0.78,
  0.76,
  0.77,
  0.8,
  0.9, // 0–5 AM  (quiet night)
  1.05,
  1.2,
  1.25,
  1.15,
  1.05,
  0.98, // 6–11 AM (morning rush)
  0.95,
  0.92,
  0.9,
  0.93,
  0.98,
  1.15, // 12–17 PM
  1.25,
  1.2,
  1.1,
  1.0,
  0.92,
  0.85, // 18–23 PM (evening rush → night)
];

const generateBaselineForecast = (currentAQI) => {
  const forecast = [];
  const now = new Date();
  let aqi = currentAQI;

  for (let i = 0; i < 48; i++) {
    const ft = new Date(now.getTime() + i * 3600000);
    // ML-ADDITION: compute IST hour for consistent hour field with LSTM output
    const istHour = ((ft.getUTCHours() + 5) * 60 + 30) / 60;
    const hour = Math.floor(((ft.getUTCHours() * 60 + 330) % 1440) / 60); // IST 0-23
    const mult = HOURLY_PATTERN[ft.getHours()];
    const noise = (Math.random() - 0.48) * (currentAQI * 0.08);
    const revert = (currentAQI - aqi) * 0.1;
    aqi = Math.max(10, Math.round(currentAQI * mult + noise + revert));
    // ML-ADDITION: emit lower/upper bands so ForecastChart can render confidence interval
    const band = Math.round(currentAQI * 0.12);
    forecast.push({
      time: ft.toISOString(),
      hour,
      aqi,
      lower: Math.max(0, aqi - band),
      upper: Math.min(500, aqi + band),
      modelType: "statistical_baseline",
    });
  }
  return forecast;
};

const get48HourForecast = async (
  district,
  currentAQI,
  pollutants,
  lat,
  lon,
) => {
  if (process.env.ML_SERVICE_URL) {
    try {
      logger.info(`Calling ML service for: ${district}`);
      const res = await axios.post(
        `${process.env.ML_SERVICE_URL}/predict`,
        {
          district,
          currentAQI,
          pollutants,
          lat,
          lon,
          hour: new Date().getHours(),
          month: new Date().getMonth() + 1,
        },
        { timeout: 8000 },
      );
      // ML-ADDITION: pass through lower/upper confidence bands from LSTM response
      return (res.data.forecast || []).map((f) => ({
        time: f.time,
        hour: f.hour,
        aqi: f.aqi,
        lower: f.lower ?? null,
        upper: f.upper ?? null,
        modelType: f.modelType || "ml_model",
      }));
    } catch (err) {
      logger.warn(
        `ML service unreachable (${err.message}), falling back to baseline`,
      );
    }
  }
  return generateBaselineForecast(currentAQI);
};

module.exports = { get48HourForecast };
