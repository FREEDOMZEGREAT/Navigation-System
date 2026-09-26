const mongoose = require('mongoose');
const User = require('../models/User');
require('dotenv').config();

const MONGO = process.env.MONGODB_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017/dtu_navigation';

async function main() {
  try {
    await mongoose.connect(MONGO, { useNewUrlParser: true, useUnifiedTopology: true });
    console.log('Connected to DB');

    const identifier = process.argv[2] || process.env.TGT_ADMIN; // username or email
    const newPassword = process.argv[3] || process.env.NEW_ADMIN_PASSWORD;

    if (!identifier || !newPassword) {
      console.error('Usage: node changeAdminPassword.js <username|email> <newPassword>');
      process.exit(1);
    }

    const user = await User.findOne({
      $or: [{ username: identifier }, { email: identifier }],
      role: 'admin'
    });

    if (!user) {
      console.error('Admin user not found with identifier:', identifier);
      process.exit(1);
    }

    user.password = newPassword; // will be hashed by User pre-save hook
    await user.save();

    console.log('Password updated for admin user:', user.username);
    process.exit(0);
  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  }
}

main();
