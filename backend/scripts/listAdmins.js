const mongoose = require('mongoose');
const User = require('../models/User');
require('dotenv').config();

const MONGO = process.env.MONGODB_URI || 'mongodb://localhost:27017/dtu_navigation';

async function main() {
  try {
    await mongoose.connect(MONGO, { useNewUrlParser: true, useUnifiedTopology: true });
    const admins = await User.find({ role: 'admin' }).select('username email createdAt');
    if (!admins || admins.length === 0) {
      console.log('No admin users found.');
    } else {
      console.log('Admin users:');
      admins.forEach(a => console.log(`- ${a.username} <${a.email}> (created: ${a.createdAt})`));
    }
    process.exit(0);
  } catch (err) {
    console.error('Error listing admins:', err);
    process.exit(1);
  }
}

main();
