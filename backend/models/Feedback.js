const mongoose = require('mongoose');

const feedbackSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  type: {
    type: String,
    enum: ['general', 'bug', 'suggestion', 'complaint', 'praise'],
    required: true
  },
  title: {
    type: String,
    required: true,
    trim: true
  },
  message: {
    type: String,
    required: true
  },
  rating: {
    type: Number,
    min: 1,
    max: 5
  },
  relatedPOI: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'POI'
  },
  isPublic: {
    type: Boolean,
    default: false
  },
  // Optional sender info for anonymous feedback
  senderName: {
    type: String
  },
  senderEmail: {
    type: String
  },
  status: {
    type: String,
    enum: ['pending', 'reviewed', 'resolved', 'rejected'],
    default: 'pending'
  },
  adminResponse: {
    message: String,
    respondedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    respondedAt: Date
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('Feedback', feedbackSchema);