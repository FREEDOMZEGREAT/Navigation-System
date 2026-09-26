/**
 * Notification System
 * Handles loading, displaying, and managing notifications
 */

class NotificationSystem {
    constructor(app) {
        this.app = app;
        this.notifications = [];
        this.unreadCount = 0;
        this.readNotificationIds = this.loadReadNotifications();
        
        // Wait for DOM to be ready before initializing
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => this.init());
        } else {
            this.init();
        }
    }

    init() {
        this.setupEventListeners();
        this.loadNotifications();
    }

    loadReadNotifications() {
        try {
            const stored = localStorage.getItem('readNotificationIds');
            return stored ? JSON.parse(stored) : [];
        } catch (e) {
            console.warn('[NotificationSystem] Error loading read notifications:', e.message);
            return [];
        }
    }

    saveReadNotifications() {
        try {
            localStorage.setItem('readNotificationIds', JSON.stringify(this.readNotificationIds));
            console.log('[NotificationSystem] Saved read notification IDs:', this.readNotificationIds);
        } catch (e) {
            console.warn('[NotificationSystem] Error saving read notifications:', e.message);
        }
    }

    setupEventListeners() {
        // Close notification detail modal
        const closeBtn = document.getElementById('close-user-notification-detail');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => this.closeDetail());
        }

        const closeBtnAlt = document.getElementById('close-user-notification-detail-btn');
        if (closeBtnAlt) {
            closeBtnAlt.addEventListener('click', () => this.closeDetail());
        }
    }

    async loadNotifications() {
        try {
            const url = `${this.app.apiBase}/notifications/public/broadcasts?limit=50`;
            console.log('[NotificationSystem] Fetching from:', url);

            const res = await fetch(url);
            console.log('[NotificationSystem] Response status:', res.status);

            if (!res.ok) {
                throw new Error(`API returned status ${res.status}`);
            }

            const data = await res.json();
            console.log('[NotificationSystem] Received', data.length, 'notifications');

            if (Array.isArray(data) && data.length > 0) {
                this.notifications = data.map(b => ({
                    id: b.id,
                    _id: b.id,
                    title: b.title || 'Notification',
                    message: b.message || '',
                    createdAt: b.createdAt
                }));

                // Calculate unread count: total notifications minus those already read
                this.unreadCount = this.notifications.filter(n => !this.readNotificationIds.includes(n.id)).length;
                console.log('[NotificationSystem] Loaded', this.notifications.length, 'notifications, unread:', this.unreadCount);

                this.updateBadge();
                this.renderDropdown();
            } else {
                console.warn('[NotificationSystem] No notifications received');
                this.notifications = [];
                this.unreadCount = 0;
                this.updateBadge();
                this.renderDropdown();
            }
        } catch (e) {
            console.error('[NotificationSystem] Error:', e.message);
            this.notifications = [];
            this.unreadCount = 0;
            this.updateBadge();
            this.renderDropdown();
        }
    }

    updateBadge() {
        const badge = document.getElementById('notification-count');
        if (!badge) {
            console.warn('[NotificationSystem] Badge element not found');
            return;
        }

        const count = this.unreadCount || this.notifications.length || 0;
        console.log('[NotificationSystem] Updating badge with count:', count);

        if (count > 0) {
            badge.textContent = String(count);
            badge.style.display = 'inline-flex';
            badge.style.backgroundColor = '#dc3545';
            badge.style.color = '#fff';
            badge.style.borderRadius = '999px';
            badge.style.padding = '0 6px';
            badge.style.fontSize = '0.75rem';
            badge.style.fontWeight = 'bold';
            badge.style.position = 'absolute';
            badge.style.top = '-8px';
            badge.style.right = '-8px';
            badge.style.minWidth = '24px';
            badge.style.height = '24px';
            badge.style.alignItems = 'center';
            badge.style.justifyContent = 'center';
            console.log('[NotificationSystem] Badge displayed:', badge.textContent);
        } else {
            badge.style.display = 'none';
            console.log('[NotificationSystem] Badge hidden');
        }
    }

    renderDropdown() {
        const dropdown = document.getElementById('notifications-dropdown');
        if (!dropdown) {
            console.warn('[NotificationSystem] Dropdown element not found');
            return;
        }

        console.log('[NotificationSystem] Rendering dropdown with', this.notifications.length, 'items');

        // Remove old items
        Array.from(dropdown.querySelectorAll('.notif-item')).forEach(el => el.remove());
        Array.from(dropdown.querySelectorAll('.no-notifications')).forEach(el => el.remove());

        if (this.notifications.length === 0) {
            const noNotif = document.createElement('li');
            noNotif.className = 'no-notifications';
            noNotif.innerHTML = '<a class="dropdown-item" href="#" style="color: #999; cursor: default;">No notifications</a>';
            dropdown.appendChild(noNotif);
            console.log('[NotificationSystem] Showing "No notifications" message');
        } else {
            this.notifications.forEach((notif) => {
                const li = document.createElement('li');
                li.className = 'notif-item';
                const notifId = notif.id || notif._id || 'unknown';
                const notifTitle = notif.title || 'Notification';
                const notifDate = notif.createdAt ? new Date(notif.createdAt).toLocaleString() : new Date().toLocaleString();

                li.innerHTML = `<a class="dropdown-item" href="#" data-id="${notifId}" style="cursor: pointer;"><div style="font-weight:600">${this.escapeHtml(notifTitle)}</div><div style="font-size:0.85rem;color:#666">${notifDate}</div></a>`;

                li.addEventListener('click', (e) => {
                    e.preventDefault();
                    this.showDetail(notif);
                });

                dropdown.appendChild(li);
            });
            console.log('[NotificationSystem] Rendered', this.notifications.length, 'notification items');
        }
    }

    showDetail(notification) {
        const modal = document.getElementById('user-notification-detail-modal');
        if (!modal) {
            console.warn('[NotificationSystem] Detail modal not found');
            return;
        }

        const titleEl = document.getElementById('user-notif-detail-title');
        const messageEl = document.getElementById('user-notif-detail-message');
        const dateEl = document.getElementById('user-notif-detail-date');

        if (titleEl) titleEl.textContent = this.escapeHtml(notification.title || 'Notification');
        if (messageEl) messageEl.textContent = this.escapeHtml(notification.message || '');
        if (dateEl) dateEl.textContent = new Date(notification.createdAt).toLocaleString();

        modal.style.display = 'block';

        // Mark notification as read if not already marked
        const notifId = notification.id || notification._id;
        if (!this.readNotificationIds.includes(notifId)) {
            this.readNotificationIds.push(notifId);
            this.saveReadNotifications();
            
            // Decrease unread count by 1
            if (this.unreadCount > 0) {
                this.unreadCount--;
                this.updateBadge();
                console.log('[NotificationSystem] Notification read. Unread count decreased to:', this.unreadCount);
            }
        }

        console.log('[NotificationSystem] Showing detail for:', notification.title);
    }

    closeDetail() {
        const modal = document.getElementById('user-notification-detail-modal');
        if (modal) {
            modal.style.display = 'none';
            console.log('[NotificationSystem] Closed detail modal');
        }
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}

// Export for use
if (typeof module !== 'undefined' && module.exports) {
    module.exports = NotificationSystem;
}
