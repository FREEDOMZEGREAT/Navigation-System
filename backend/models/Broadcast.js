const mongoose = require('mongoose');

const broadcastSchema = new mongoose.Schema({
  title: { type: String, required: true },
  message: { type: String, required: true },
  type: { type: String, default: 'system' },
  priority: { type: String, enum: ['low','medium','high'], default: 'low' },
  expiresAt: { type: Date, default: null },
  duration: { type: Number, default: null }, // Duration in seconds
  adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
}, { timestamps: true });

module.exports = mongoose.model('Broadcast', broadcastSchema);
