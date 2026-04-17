const express = require('express');
const router  = express.Router();
const { getCurrentAQI, getForecast, getHistoricalData, getDashboard, getDistricts, getStations, triggerSync } = require('../controllers/aqiController');
const { protect }   = require('../middleware/auth');
const { aqiLimiter } = require('../middleware/rateLimiter');

// Public
router.get('/districts', getDistricts);
router.get('/stations',  getStations);

// Protected + rate-limited
router.get('/current',   protect, aqiLimiter, getCurrentAQI);
router.get('/forecast',  protect, aqiLimiter, getForecast);
router.get('/history',   protect, aqiLimiter, getHistoricalData);
router.get('/dashboard', protect, aqiLimiter, getDashboard);

// Admin — manual CPCB sync
router.post('/sync', protect, triggerSync);

module.exports = router;
