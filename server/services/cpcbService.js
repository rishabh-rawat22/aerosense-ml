/**
 * CPCB / OpenAQ Data Service
 * ──────────────────────────
 * Tries multiple CPCB endpoints first.
 * Falls back to OpenAQ API (free, no key needed, covers all of India).
 * OpenAQ: https://docs.openaq.org
 */

const axios      = require('axios');
const AQIReading = require('../models/AQIReading');
const Station    = require('../models/Station');
const logger     = require('../config/logger');
const cache      = require('../config/cache');

// ── AQI Category (India NAQI scale) ──────────────────────────────────────────
const CATEGORIES = [
  { label: 'Good',         min: 0,   max: 50,  color: '#22c55e', risk: 'low' },
  { label: 'Satisfactory', min: 51,  max: 100, color: '#84cc16', risk: 'low' },
  { label: 'Moderate',     min: 101, max: 200, color: '#eab308', risk: 'moderate' },
  { label: 'Poor',         min: 201, max: 300, color: '#f97316', risk: 'high' },
  { label: 'Very Poor',    min: 301, max: 400, color: '#ef4444', risk: 'very_high' },
  { label: 'Severe',       min: 401, max: 500, color: '#7f1d1d', risk: 'severe' },
];

const getCategory = (aqi) => {
  if (!aqi || isNaN(aqi)) return { label: 'Unknown', color: '#6b7280', risk: 'unknown' };
  for (const c of CATEGORIES) {
    if (aqi >= c.min && aqi <= c.max) return { label: c.label, color: c.color, risk: c.risk };
  }
  return { label: 'Severe', color: '#7f1d1d', risk: 'severe' };
};

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-IN,en;q=0.9',
  'Referer': 'https://airquality.cpcb.gov.in/',
};

// ── CPCB endpoint candidates (they change frequently) ────────────────────────
const CPCB_ENDPOINTS = [
  'https://airquality.cpcb.gov.in/caaqms/getMapData',
  'https://airquality.cpcb.gov.in/AQI_India_Iframe/aqi_India_iframe.php',
  'https://airquality.cpcb.gov.in/ccr#',
];

// ── PM2.5 → AQI conversion using India NAQI breakpoints ──────────────────────
// Source: CPCB NAQI Technical Document
const pm25ToAQI = (pm25) => {
  if (pm25 == null) return null;
  const bp = [
    [0, 30,   0,   50],
    [30, 60,  51,  100],
    [60, 90,  101, 200],
    [90, 120, 201, 300],
    [120,250, 301, 400],
    [250,500, 401, 500],
  ];
  for (const [cLow, cHigh, iLow, iHigh] of bp) {
    if (pm25 >= cLow && pm25 <= cHigh) {
      return Math.round(((iHigh - iLow) / (cHigh - cLow)) * (pm25 - cLow) + iLow);
    }
  }
  return pm25 > 500 ? 500 : null;
};

// ── Try CPCB endpoints ────────────────────────────────────────────────────────
const tryFetchCPCB = async () => {
  for (const url of CPCB_ENDPOINTS) {
    try {
      logger.info(`Trying CPCB endpoint: ${url}`);
      const res = await axios.get(url, { headers: HEADERS, timeout: 15000 });

      let stations = [];
      const d = res.data;
      if (Array.isArray(d))                              stations = d;
      else if (d?.stations && Array.isArray(d.stations)) stations = d.stations;
      else if (d?.data && Array.isArray(d.data))         stations = d.data;
      else {
        for (const k of Object.keys(d || {})) {
          if (Array.isArray(d[k]) && d[k].length > 0) { stations = d[k]; break; }
        }
      }

      if (stations.length > 0) {
        logger.info(`CPCB OK — ${stations.length} stations from ${url}`);
        return { stations, source: 'CPCB' };
      }
    } catch (err) {
      logger.warn(`CPCB endpoint failed (${url}): ${err.message}`);
    }
  }
  return null;
};

// ── OpenAQ fallback ───────────────────────────────────────────────────────────
// OpenAQ v3 is free, no API key, real measured data, covers 200+ Indian cities
const fetchFromOpenAQ = async () => {
  logger.info('Falling back to OpenAQ API...');

  // Fetch latest measurements for India — PM2.5 parameter
  const url = 'https://api.openaq.org/v2/latest?country=IN&parameter=pm25&limit=1000&page=1';
  const res = await axios.get(url, {
    headers: { 'Accept': 'application/json' },
    timeout: 20000,
  });

  const results = res.data?.results || [];
  logger.info(`OpenAQ returned ${results.length} station records`);
  return { stations: results, source: 'OpenAQ' };
};

// ── Normalize OpenAQ record ───────────────────────────────────────────────────
const normalizeOpenAQ = (raw) => {
  const pm25Measurement = raw.measurements?.find((m) => m.parameter === 'pm25');
  const pm10Measurement = raw.measurements?.find((m) => m.parameter === 'pm10');
  const no2Measurement  = raw.measurements?.find((m) => m.parameter === 'no2');
  const so2Measurement  = raw.measurements?.find((m) => m.parameter === 'so2');
  const coMeasurement   = raw.measurements?.find((m) => m.parameter === 'co');
  const o3Measurement   = raw.measurements?.find((m) => m.parameter === 'o3');

  const pm25 = pm25Measurement?.value > 0 ? parseFloat(pm25Measurement.value.toFixed(1)) : null;
  const aqi  = pm25ToAQI(pm25) || 0;

  // OpenAQ location names for India often include city
  const locationName = raw.name || raw.location || 'Unknown Station';
  const city         = raw.city || '';
  const country      = raw.country || 'IN';

  // Extract district from location name (OpenAQ uses "Station Name, City" format)
  const parts    = locationName.split(',').map((p) => p.trim());
  const district = parts.length > 1 ? parts[parts.length - 1] : parts[0];

  return {
    stationId:   String(raw.location || raw.id || locationName),
    stationName: locationName,
    district:    district || city || locationName,
    city,
    state:       raw.country === 'IN' ? 'India' : raw.country || 'India',
    coordinates: {
      lat: raw.coordinates?.latitude  || 0,
      lon: raw.coordinates?.longitude || 0,
    },
    actualAQI:   aqi,
    predictedAQI: null,
    pollutants: {
      pm25,
      pm10: pm10Measurement?.value > 0 ? parseFloat(pm10Measurement.value.toFixed(1)) : null,
      no2:  no2Measurement?.value  > 0 ? parseFloat(no2Measurement.value.toFixed(1))  : null,
      so2:  so2Measurement?.value  > 0 ? parseFloat(so2Measurement.value.toFixed(1))  : null,
      co:   coMeasurement?.value   > 0 ? parseFloat(coMeasurement.value.toFixed(2))   : null,
      o3:   o3Measurement?.value   > 0 ? parseFloat(o3Measurement.value.toFixed(1))   : null,
      nh3:  null,
    },
    category:   getCategory(aqi).label,
    recordedAt: pm25Measurement?.lastUpdated
      ? new Date(pm25Measurement.lastUpdated)
      : new Date(),
    source: 'OPENAQ',
  };
};

// ── Normalize CPCB record ─────────────────────────────────────────────────────
const normalizeCPCB = (raw) => {
  const aqi       = parseInt(raw.aqi || raw.AQI || raw.aqiValue || raw.aqi_value || 0);
  const stationId = String(raw.stationId || raw.station_id || raw.id || `${raw.stationName}_${raw.state}`);
  const city      = raw.city || raw.cityName || '';
  const district  = raw.district || raw.District || city || 'Unknown';

  const p    = raw.pollutants || raw.parameters || raw;
  const pick = (keys) => { for (const k of keys) { const v = parseFloat(p[k]); if (!isNaN(v) && v > 0) return v; } return null; };

  return {
    stationId,
    stationName: raw.stationName || raw.name || 'Unknown',
    district:    district.trim(),
    city:        city.trim(),
    state:       (raw.state || raw.State || 'Unknown').trim(),
    coordinates: {
      lat: parseFloat(raw.latitude  || raw.lat  || 0),
      lon: parseFloat(raw.longitude || raw.lng  || 0),
    },
    actualAQI:    aqi,
    predictedAQI: null,
    pollutants: {
      pm25: pick(['PM2.5', 'pm25', 'pm2_5']),
      pm10: pick(['PM10',  'pm10']),
      no2:  pick(['NO2',   'no2']),
      so2:  pick(['SO2',   'so2']),
      co:   pick(['CO',    'co']),
      o3:   pick(['Ozone', 'O3', 'o3']),
      nh3:  pick(['NH3',   'nh3']),
    },
    category:  getCategory(aqi).label,
    recordedAt: raw.lastUpdate ? new Date(raw.lastUpdate) : new Date(),
    source: 'CPCB',
  };
};

// ── Main sync function ────────────────────────────────────────────────────────
const syncCPCBData = async () => {
  const t0 = Date.now();
  logger.info('Starting data sync...');

  // Try CPCB first, then OpenAQ
  let result = await tryFetchCPCB();
  let records;

  if (result) {
    records = result.stations.map(normalizeCPCB).filter((r) => r.actualAQI > 0 && r.stationId);
  } else {
    logger.info('All CPCB endpoints failed. Using OpenAQ...');
    try {
      result  = await fetchFromOpenAQ();
      records = result.stations.map(normalizeOpenAQ).filter((r) => r.actualAQI > 0 && r.stationId);
    } catch (err) {
      logger.error(`OpenAQ also failed: ${err.message}`);
      return { synced: 0, error: 'All data sources failed' };
    }
  }

  if (!records.length) {
    logger.warn('No valid records after normalization.');
    return { synced: 0 };
  }

  logger.info(`Saving ${records.length} records from ${result.source}...`);

  const aqiOps = records.map((r) => ({
    updateOne: {
      filter: { stationId: r.stationId, recordedAt: r.recordedAt },
      update: { $set: r },
      upsert: true,
    },
  }));

  const stationOps = records.map((r) => ({
    updateOne: {
      filter: { stationId: r.stationId },
      update: {
        $set: {
          stationId:      r.stationId,
          stationName:    r.stationName,
          district:       r.district,
          city:           r.city,
          state:          r.state,
          coordinates:    r.coordinates,
          isActive:       true,
          lastReportedAt: r.recordedAt,
        },
      },
      upsert: true,
    },
  }));

  const [aqiResult, stationResult] = await Promise.all([
    AQIReading.bulkWrite(aqiOps,     { ordered: false }),
    Station.bulkWrite(stationOps,    { ordered: false }),
  ]);

  cache.flush();

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const summary = {
    synced:          aqiResult.upsertedCount + aqiResult.modifiedCount,
    stationsUpdated: stationResult.upsertedCount + stationResult.modifiedCount,
    source:          result.source,
    elapsed:         `${elapsed}s`,
  };

  logger.info(`Sync complete: ${JSON.stringify(summary)}`);
  return summary;
};

// ── Query helpers ─────────────────────────────────────────────────────────────
const getLatestForDistrict = async (district) => {
  const rx = new RegExp(district.trim(), 'i');
  let reading = await AQIReading.findOne({
    district:   rx,
    recordedAt: { $gte: new Date(Date.now() - 3 * 60 * 60 * 1000) }, // last 3 hours
  }).sort({ recordedAt: -1 });

  if (!reading) {
    reading = await AQIReading.findOne({ district: rx }).sort({ recordedAt: -1 });
  }
  return reading;
};

const get30DayHistory = async (district) => {
  const rx       = new RegExp(district.trim(), 'i');
  const thirtyAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const rows = await AQIReading.aggregate([
    { $match: { district: rx, recordedAt: { $gte: thirtyAgo }, actualAQI: { $gt: 0 } } },
    {
      $group: {
        _id:       { $dateToString: { format: '%Y-%m-%d', date: '$recordedAt' } },
        actual:    { $avg: '$actualAQI' },
        predicted: { $avg: '$predictedAQI' },
        count:     { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  return rows.map((r) => ({
    date:       r._id,
    actual:     Math.round(r.actual),
    predicted:  r.predicted ? Math.round(r.predicted) : null,
    dataPoints: r.count,
  }));
};

const getAvailableDistricts = async () => {
  const rows = await Station.aggregate([
    { $match: { isActive: true } },
    { $group: { _id: '$district', state: { $first: '$state' }, stationCount: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ]);
  return rows.map((r) => ({ name: r._id, state: r.state, stations: r.stationCount }));
};

module.exports = { syncCPCBData, getLatestForDistrict, get30DayHistory, getAvailableDistricts, getCategory };
