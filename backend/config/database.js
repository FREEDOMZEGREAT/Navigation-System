const mongoose = require('mongoose');

const connectDB = async () => {
  try {
    const mongoUri = process.env.MONGODB_URI;
    
    if (!mongoUri) {
      throw new Error('MONGODB_URI is not defined in .env file');
    }
    
    console.log('🔄 Connecting to MongoDB...');
    console.log(`📍 URI: ${mongoUri.substring(0, 50)}...`);
    
    const conn = await mongoose.connect(mongoUri, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 45000,
    });
    
    console.log(`✅ MongoDB Connected: ${conn.connection.host}`);
    console.log(`📊 Database: ${conn.connection.name}`);
    return conn;
  } catch (error) {
    console.error('❌ MongoDB connection error:', error.message);
    console.error('\n💡 TROUBLESHOOTING STEPS:');
    console.error('   1. Verify MongoDB Atlas credentials:');
    console.error('      - Username: dtu_admin');
    console.error('      - Check password in MongoDB Atlas');
    console.error('   2. Whitelist your IP address:');
    console.error('      - Go to MongoDB Atlas > Network Access');
    console.error('      - Add your current IP or 0.0.0.0/0 (for development)');
    console.error('   3. Verify database user exists:');
    console.error('      - Go to MongoDB Atlas > Database Access');
    console.error('      - Ensure dtu_admin user has proper permissions');
    console.error('   4. Check connection string format:');
    console.error('      - Should be: mongodb+srv://username:password@cluster.mongodb.net/database');
    console.error('   5. Test connection manually:');
    console.error('      - Use MongoDB Compass with the connection string');
    throw error;
  }
};

module.exports = connectDB;