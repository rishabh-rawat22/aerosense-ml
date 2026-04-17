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

const axios  = require('axios');
const logger = require('../config/logger');

// Real hourly AQI multipliers based on Indian city pollution patterns
// Rush hours (7–10am, 5–9pm) drive higher pollution; night is lower
const HOURLY_PATTERN = [
  0.80, 0.78, 0.76, 0.77, 0.80, 0.90,   // 0–5 AM  (quiet night)
  1.05, 1.20, 1.25, 1.15, 1.05, 0.98,   // 6–11 AM (morning rush)
  0.95, 0.92, 0.90, 0.93, 0.98, 1.15,   // 12–17 PM
  1.25, 1.20, 1.10, 1.00, 0.92, 0.85,   // 18–23 PM (evening rush → night)
];

const generateBaselineForecast = (currentAQI) => {
  const forecast = [];
  const now = new Date();
  let aqi = currentAQI;

  for (let i = 0; i < 48; i++) {
    const ft   = new Date(now.getTime() + i * 3600000);
    const hour = ft.getHours();
    const mult = HOURLY_PATTERN[hour];
    const noise = (Math.random() - 0.48) * (currentAQI * 0.08);
    const revert = (currentAQI - aqi) * 0.1;
    aqi = Math.max(10, Math.round(currentAQI * mult + noise + revert));
    forecast.push({ time: ft.toISOString(), hour, aqi, modelType: 'statistical_baseline' });
  }
  return forecast;
};

const get48HourForecast = async (district, currentAQI, pollutants, lat, lon) => {
  if (process.env.ML_SERVICE_URL) {
    try {
      logger.info(`Calling ML service for: ${district}`);
      const res = await axios.post(
        `${process.env.ML_SERVICE_URL}/predict`,
        { district, currentAQI, pollutants, lat, lon, hour: new Date().getHours(), month: new Date().getMonth() + 1 },
        { timeout: 8000 }
      );
      return res.data.forecast;
    } catch (err) {
      logger.warn(`ML service unreachable (${err.message}), falling back to baseline`);
    }
  }
  return generateBaselineForecast(currentAQI);
};

module.exports = { get48HourForecast };
