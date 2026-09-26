const mongoose = require('mongoose');
const User = require('../models/User');
require('dotenv').config();

const MONGO = process.env.MONGODB_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017/dtu_navigation';

async function main() {
  try {
    await mongoose.connect(MONGO, { useNewUrlParser: true, useUnifiedTopology: true });
    console.log('Connected to DB');

    const adminCount = await User.countDocuments({ role: 'admin' });
    if (adminCount > 0) {
      console.log('Admin already exists. Exiting.');
      process.exit(0);
    }

    const username = process.env.ADMIN_USERNAME || process.argv[2];
    const email = process.env.ADMIN_EMAIL || process.argv[3];
    const password = process.env.ADMIN_PASSWORD || process.argv[4];

    if (!username || !email || !password) {
      console.error('Provide ADMIN_USERNAME, ADMIN_EMAIL, ADMIN_PASSWORD either as env vars or CLI args: node createAdmin.js <username> <email> <password>');
      process.exit(1);
    }

    const user = new User({ username, email, password, role: 'admin' });
    await user.save();

    console.log('Admin user created successfully:', { username, email });
    process.exit(0);
  } catch (err) {
    console.error('Error creating admin:', err);
    process.exit(1);
  }
}

main();
