/**
 * AQIReading model is no longer used.
 * Data is now stored in LocationAQI (defined inside services/openaqService.js).
 * This file is kept so any stale imports don't crash the server.
 */
const mongoose = require('mongoose');

const aqiReadingSchema = new mongoose.Schema(
  {
    stationId:   { type: String },
    stationName: { type: String },
    district:    { type: String },
    state:       { type: String },
    actualAQI:   { type: Number },
    recordedAt:  { type: Date },
  },
  { timestamps: true }
);

// Single compound index — no duplicates that caused the Mongoose warning
aqiReadingSchema.index({ stationId: 1, recordedAt: -1 }, { unique: true });

module.exports = mongoose.models.AQIReading || mongoose.model('AQIReading', aqiReadingSchema);
