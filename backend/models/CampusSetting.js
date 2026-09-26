const mongoose = require('mongoose');

const campusSettingSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, default: 'campus' },
  bounds: {
    north: { type: Number, required: true },
    south: { type: Number, required: true },
    east: { type: Number, required: true },
    west: { type: Number, required: true }
  },
  center: {
    lat: { type: Number },
    lng: { type: Number }
  }
}, { timestamps: true });

module.exports = mongoose.model('CampusSetting', campusSettingSchema);
