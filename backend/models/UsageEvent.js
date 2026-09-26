const mongoose = require('mongoose');

const usageEventSchema = new mongoose.Schema({
  eventType: { type: String, required: true }, // e.g., page_view, api_call, calculate_route
  path: { type: String },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  ip: { type: String },
  userAgent: { type: String },
  meta: { type: mongoose.Schema.Types.Mixed },
}, { timestamps: true });

module.exports = mongoose.model('UsageEvent', usageEventSchema);
