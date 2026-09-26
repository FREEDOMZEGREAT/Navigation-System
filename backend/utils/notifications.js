const Notification = require('../models/Notification');

class NotificationService {
  constructor(io) {
    this.io = io;
  }

  async createSystemNotification(userId, title, message, priority = 'low') {
    try {
      const notification = new Notification({
        user: userId,
        title,
        message,
        type: 'system',
        priority
      });

      await notification.save();

      // Send real-time notification
      this.io.to(`user-${userId}`).emit('new-notification', {
        notification: notification
      });

      return notification;
    } catch (error) {
      console.error('Create system notification error:', error);
      throw error;
    }
  }

  async createRouteNotification(userId, route, message) {
    try {
      const notification = new Notification({
        user: userId,
        title: 'Route Update',
        message,
        type: 'route',
        relatedEntity: route._id,
        entityModel: 'Route'
      });

      await notification.save();

      this.io.to(`user-${userId}`).emit('new-notification', {
        notification: notification
      });

      return notification;
    } catch (error) {
      console.error('Create route notification error:', error);
      throw error;
    }
  }

  async notifyAdmins(title, message) {
    try {
      // This would send notifications to all admin users
      // Implementation depends on your user management
      console.log(`Admin notification: ${title} - ${message}`);
    } catch (error) {
      console.error('Notify admins error:', error);
      throw error;
    }
  }
}

module.exports = NotificationService;