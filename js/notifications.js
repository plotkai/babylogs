// js/notifications.js — Offline Alarm-Based Native Notifications & Browser Fallback

import { getLastActivityOfType } from './db.js';
import { getSettings, updateSetting, getProfileById } from './db.js';

let reminderInterval = null;
const FEED_TYPES = ['breast_feed', 'formula_feed', 'express_feed'];
const FEED_REMINDER_NOTIFICATION_ID = 1001;
const FEED_CHANNEL_ID = 'babylogs_feed_reminders';
let channelInitialized = false;

/**
 * Check if running inside Capacitor native container (Android / iOS)
 */
export function isNativeApp() {
  return typeof window !== 'undefined' && !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform());
}

/**
 * Safely get LocalNotifications plugin
 */
function getLocalNotificationsPlugin() {
  if (isNativeApp() && window.Capacitor?.Plugins?.LocalNotifications) {
    return window.Capacitor.Plugins.LocalNotifications;
  }
  return null;
}

/**
 * Initialize Android notification channels
 */
async function ensureAndroidChannel() {
  const plugin = getLocalNotificationsPlugin();
  if (!plugin || channelInitialized) return;

  try {
    if (typeof plugin.createChannel === 'function') {
      await plugin.createChannel({
        id: FEED_CHANNEL_ID,
        name: 'Feeding Reminders',
        description: 'Alarms when it is time for baby feeds',
        importance: 5, // High importance (Heads-up alert)
        visibility: 1, // Public on lock screen
        vibration: true,
        sound: 'beep.wav',
        lights: true,
        lightColor: '#7C5CFC'
      });
      channelInitialized = true;
    }
  } catch (err) {
    console.warn('Channel creation warning:', err);
  }
}

/**
 * Request notification permission (Native Android or Browser)
 */
export async function requestPermission() {
  const nativePlugin = getLocalNotificationsPlugin();
  if (nativePlugin) {
    try {
      await ensureAndroidChannel();
      const status = await nativePlugin.requestPermissions();
      return status.display === 'granted';
    } catch (err) {
      console.warn('Native notification permission error:', err);
      return false;
    }
  }

  // Web Browser Fallback
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
 * Check if notifications are supported
 */
export function isNotificationSupported() {
  if (isNativeApp()) return true;
  return 'Notification' in window;
}

/**
 * Check if notification permission is currently granted
 */
export async function isNotificationGranted() {
  const nativePlugin = getLocalNotificationsPlugin();
  if (nativePlugin) {
    try {
      const check = await nativePlugin.checkPermissions();
      return check.display === 'granted';
    } catch {
      return false;
    }
  }
  return 'Notification' in window && Notification.permission === 'granted';
}

/**
 * Start / schedule feed reminder alarms
 * On Android: Schedules exact offline AlarmManager alarm via LocalNotifications.
 * On Web: Maintains interval check.
 */
export async function startReminders(babyId) {
  stopReminders(); // Clear existing interval if any

  const settings = getSettings();
  if (!settings.notificationsEnabled) {
    await cancelNativeAlarms();
    return;
  }

  const hasPermission = await requestPermission();
  if (!hasPermission) {
    updateSetting('notificationsEnabled', false);
    await cancelNativeAlarms();
    return;
  }

  const intervalMinutes = Number(settings.feedReminderInterval) || 180;
  const nativePlugin = getLocalNotificationsPlugin();

  if (nativePlugin) {
    // Android Native: Schedule exact offline alarm
    await scheduleNativeFeedAlarm(babyId, intervalMinutes);
  } else {
    // Web Browser: Check periodically in session
    reminderInterval = setInterval(async () => {
      await checkAndNotifyWeb(babyId, intervalMinutes);
    }, 60 * 1000);

    // Immediate check
    await checkAndNotifyWeb(babyId, intervalMinutes);
  }
}

/**
 * Stop / cancel feed reminder monitoring and pending alarms
 */
export async function stopReminders() {
  if (reminderInterval) {
    clearInterval(reminderInterval);
    reminderInterval = null;
  }
  await cancelNativeAlarms();
}

/**
 * Schedule exact offline native alarm on Android
 */
async function scheduleNativeFeedAlarm(babyId, intervalMinutes) {
  const nativePlugin = getLocalNotificationsPlugin();
  if (!nativePlugin) return;

  try {
    await ensureAndroidChannel();

    // Cancel any previously scheduled reminder
    await cancelNativeAlarms();

    const lastFeed = await getLastActivityOfType(babyId, FEED_TYPES);
    const lastFeedTime = lastFeed ? new Date(lastFeed.endTime || lastFeed.startTime) : new Date();
    const triggerTime = new Date(lastFeedTime.getTime() + intervalMinutes * 60 * 1000);
    const now = new Date();

    const baby = getProfileById(babyId);
    const babyName = baby?.name || 'baby';

    let scheduleAt = triggerTime;
    let bodyText = `It's been ${Math.round(intervalMinutes / 60)} hours since ${babyName}'s last feed.`;

    if (triggerTime <= now) {
      // Overdue feed: schedule 2 seconds from now to trigger heads-up
      scheduleAt = new Date(now.getTime() + 2000);
      const elapsedMins = Math.floor((now - lastFeedTime) / (1000 * 60));
      const hours = Math.floor(elapsedMins / 60);
      const mins = elapsedMins % 60;
      const timeStr = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
      bodyText = `Last feed was ${timeStr} ago. Time for ${babyName}'s next feed!`;
    }

    await nativePlugin.schedule({
      notifications: [
        {
          id: FEED_REMINDER_NOTIFICATION_ID,
          title: '🍼 Feed Reminder',
          body: bodyText,
          schedule: {
            at: scheduleAt,
            allowWhileIdle: true // Uses AlarmManager setExactAndAllowWhileIdle offline
          },
          channelId: FEED_CHANNEL_ID,
          sound: 'beep.wav',
          smallIcon: 'ic_stat_icon_config_sample',
          iconColor: '#7C5CFC',
          extra: {
            babyId,
            type: 'feed_reminder'
          }
        }
      ]
    });
    console.log(`[Babylogs Alarms] Scheduled offline feed alarm at: ${scheduleAt.toLocaleTimeString()}`);
  } catch (err) {
    console.error('Failed to schedule native alarm:', err);
  }
}

/**
 * Cancel pending native alarms
 */
async function cancelNativeAlarms() {
  const nativePlugin = getLocalNotificationsPlugin();
  if (!nativePlugin) return;

  try {
    await nativePlugin.cancel({
      notifications: [{ id: FEED_REMINDER_NOTIFICATION_ID }]
    });
  } catch (err) {
    console.debug('Error cancelling native alarms:', err);
  }
}

/**
 * Web check & notification
 */
async function checkAndNotifyWeb(babyId, thresholdMinutes) {
  try {
    const lastFeed = await getLastActivityOfType(babyId, FEED_TYPES);
    if (!lastFeed) return;

    const lastFeedTime = new Date(lastFeed.endTime || lastFeed.startTime);
    const now = new Date();
    const elapsedMinutes = (now - lastFeedTime) / (1000 * 60);

    if (elapsedMinutes >= thresholdMinutes) {
      const notifyKey = `babylog_notified_${lastFeed.id}`;
      if (localStorage.getItem(notifyKey)) return;

      const hours = Math.floor(elapsedMinutes / 60);
      const mins = Math.round(elapsedMinutes % 60);
      const timeStr = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;

      showWebNotification(
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
 * Show a browser notification (Web only)
 */
function showWebNotification(title, body) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;

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

    setTimeout(() => notification.close(), 10000);
  } catch (err) {
    console.error('Failed to show web notification:', err);
  }
}

/**
 * Get elapsed time since last feed (for UI display)
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
