const connectDB = require('../config/database');
const mongoose = require('mongoose');
const User = require('../models/User');
const Notification = require('../models/Notification');

async function run() {
  await connectDB();

  try {
    const usernames = ['dagmawi', 'netsanet'];
    console.log('Looking for users to delete:', usernames);

    const users = await User.find({ username: { $in: usernames } });
    if (!users || users.length === 0) {
      console.log('No matching users found.');
    } else {
      const ids = users.map(u => u._id);
      const res = await User.deleteMany({ _id: { $in: ids } });
      console.log(`Deleted ${res.deletedCount} user(s):`, usernames);

      // Also remove any notifications that reference these user ids
      const notifRes = await Notification.deleteMany({ user: { $in: ids } });
      console.log(`Also deleted ${notifRes.deletedCount} notification(s) linked to those users.`);
    }

    // Delete demo notifications (title/message contains 'demo' or 'maintenance' case-insensitive)
    const demoRegex = /demo|maintenance|site maintenance/i;
    const demoNotifs = await Notification.find({ $or: [ { title: demoRegex }, { message: demoRegex } ] });
    if (!demoNotifs || demoNotifs.length === 0) {
      console.log('No demo/maintenance notifications found.');
    } else {
      const ids = demoNotifs.map(n => n._id);
      const res2 = await Notification.deleteMany({ _id: { $in: ids } });
      console.log(`Deleted ${res2.deletedCount} demo/maintenance notification(s).`);
    }

    console.log('Cleanup completed.');
  } catch (err) {
    console.error('Error during cleanup:', err);
  } finally {
    try { await mongoose.disconnect(); } catch (e) {}
    process.exit(0);
  }
}

run();
