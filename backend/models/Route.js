const mongoose = require('mongoose');

const routeSchema = new mongoose.Schema({
  startPOI: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'POI',
    required: true
  },
  endPOI: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'POI',
    required: true
  },
  distance: {
    type: Number, // in meters
    required: true
  },
  estimated_time: {
    type: Number, // in minutes
    required: true
  },
  route_type: {
    type: String,
    enum: ['walking', 'wheelchair', 'shortest', 'scenic'],
    default: 'walking'
  },
  path_data: {
    coordinates: [[Number]], // [[lng, lat], [lng, lat], ...]
    type: {
      type: String,
      default: 'LineString'
    }
  },
  indoor_instructions: [{
    step: Number,
    instruction: String,
    distance: Number,
    duration: Number
  }],
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  isPublic: {
    type: Boolean,
    default: false
  },
  saveCount: {
    type: Number,
    default: 0
  }
}, {
  timestamps: true
});

// Geospatial index for route queries
routeSchema.index({ 'path_data': '2dsphere' });

module.exports = mongoose.model('Route', routeSchema);