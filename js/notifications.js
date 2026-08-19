// js/notifications.js — Browser notification reminders

import { getLastActivityOfType } from './db.js';
import { getSettings, updateSetting } from './db.js';

let reminderInterval = null;
const FEED_TYPES = ['breast_feed', 'formula_feed', 'express_feed'];

/**
 * Request notification permission
 */
export async function requestPermission() {
  if (!('Notification' in window)) {
    console.warn('Notifications not supported in this browser');
    return false;
  }

  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;

  const permission = await Notification.requestPermission();
  return permission === 'granted';
}

/**
 * Check if notifications are supported and permitted
 */
export function isNotificationSupported() {
  return 'Notification' in window;
}

export function isNotificationGranted() {
  return 'Notification' in window && Notification.permission === 'granted';
}

/**
 * Start feed reminder monitoring
 */
export async function startReminders(babyId) {
  stopReminders(); // Clear any existing interval

  const settings = getSettings();
  if (!settings.notificationsEnabled) return;

  const hasPermission = await requestPermission();
  if (!hasPermission) {
    updateSetting('notificationsEnabled', false);
    return;
  }

  const intervalMinutes = settings.feedReminderInterval || 180;

  // Check every minute
  reminderInterval = setInterval(async () => {
    await checkAndNotify(babyId, intervalMinutes);
  }, 60 * 1000);

  // Also check immediately
  await checkAndNotify(babyId, intervalMinutes);
}

/**
 * Stop feed reminder monitoring
 */
export function stopReminders() {
  if (reminderInterval) {
    clearInterval(reminderInterval);
    reminderInterval = null;
  }
}

/**
 * Check elapsed time since last feed and notify if needed
 */
async function checkAndNotify(babyId, thresholdMinutes) {
  try {
    const lastFeed = await getLastActivityOfType(babyId, FEED_TYPES);
    if (!lastFeed) return;

    const lastFeedTime = new Date(lastFeed.endTime || lastFeed.startTime);
    const now = new Date();
    const elapsedMinutes = (now - lastFeedTime) / (1000 * 60);

    if (elapsedMinutes >= thresholdMinutes) {
      // Only notify once per threshold crossing (use a flag)
      const notifyKey = `babylog_notified_${lastFeed.id}`;
      if (localStorage.getItem(notifyKey)) return;

      const hours = Math.floor(elapsedMinutes / 60);
      const mins = Math.round(elapsedMinutes % 60);
      const timeStr = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;

      showNotification(
        '🍼 Time for a feed?',
        `Last feed was ${timeStr} ago`
      );

      localStorage.setItem(notifyKey, 'true');
    }
  } catch (err) {
    console.error('Notification check error:', err);
  }
}

/**
 * Show a browser notification
 */
function showNotification(title, body) {
  if (!isNotificationGranted()) return;

  try {
    const notification = new Notification(title, {
      body,
      icon: './icons/icon-192.png',
      badge: './icons/icon-192.png',
      tag: 'babylog-feed-reminder',
      renotify: true,
      vibrate: [200, 100, 200]
    });

    notification.onclick = () => {
      window.focus();
      notification.close();
    };

    // Auto-close after 10 seconds
    setTimeout(() => notification.close(), 10000);
  } catch (err) {
    console.error('Failed to show notification:', err);
  }
}

/**
 * Get elapsed time since last feed (for display in UI)
 * Returns { minutes, text, level } where level is 'ok', 'warn', or 'alert'
 */
export async function getLastFeedElapsed(babyId) {
  try {
    const lastFeed = await getLastActivityOfType(babyId, FEED_TYPES);
    if (!lastFeed) return null;

    const lastFeedTime = new Date(lastFeed.endTime || lastFeed.startTime);
    const now = new Date();
    const elapsedMinutes = Math.floor((now - lastFeedTime) / (1000 * 60));

    const hours = Math.floor(elapsedMinutes / 60);
    const mins = elapsedMinutes % 60;
    const text = hours > 0 ? `${hours}h ${mins}m ago` : `${mins}m ago`;

    let level = 'ok';
    if (elapsedMinutes >= 180) level = 'alert';
    else if (elapsedMinutes >= 120) level = 'warn';

    return { minutes: elapsedMinutes, text, level, lastFeed };
  } catch {
    return null;
  }
}
