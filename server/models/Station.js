const mongoose = require('mongoose');

const stationSchema = new mongoose.Schema(
  {
    stationId:   { type: String, required: true, unique: true, index: true },
    stationName: { type: String, required: true },
    district:    { type: String, required: true, index: true },
    city:        { type: String, default: '' },
    state:       { type: String, required: true, index: true },
    country:     { type: String, default: 'India' },

    coordinates: {
      lat: { type: Number, required: true },
      lon: { type: Number, required: true },
    },

    stationType: {
      type: String,
      enum: ['CAAQMS', 'AAQMS', 'OTHER'],
      default: 'CAAQMS',
    },

    isActive:            { type: Boolean, default: true, index: true },
    measuredPollutants:  [{ type: String }],
    lastReportedAt:      { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Station', stationSchema);
