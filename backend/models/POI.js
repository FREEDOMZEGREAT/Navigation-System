const mongoose = require('mongoose');

const poiSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    required: true
  },
  building: {
    type: String,
    required: true
  },
  category: {
    type: String,
    required: true,
    enum: ['academic', 'administrative', 'residential', 'services', 'recreational']
  },
  latitude: {
    type: Number,
    required: true
  },
  longitude: {
    type: Number,
    required: true
  },
  floor: {
    type: String,
    default: 'Ground Floor'
  },
  room: {
    type: String
  },
  opening_hours: {
    type: String
  },
  tags: [String],
  isActive: {
    type: Boolean,
    default: true
  },
  translations: {
    type: Object,
    default: {}
  },
  location: {
    type: {
      type: String,
      enum: ['Point'],
      default: 'Point'
    },
    coordinates: {
      type: [Number],
      default: [0, 0]
    }
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});

// Ensure location is populated from latitude/longitude
poiSchema.pre('save', function (next) {
  try {
    if (this.latitude != null && this.longitude != null) {
      this.location = { type: 'Point', coordinates: [this.longitude, this.latitude] };
    }
  } catch (e) { }
  next();
});

// Geospatial index for location-based queries
poiSchema.index({ location: '2dsphere' });

module.exports = mongoose.model('POI', poiSchema);