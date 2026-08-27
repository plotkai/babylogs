// js/config.js — Loads and provides backend configuration

let configData = null;

/**
 * Load configuration from baby-config.json
 */
export async function loadConfig() {
  if (configData) return configData;

  try {
    const response = await fetch('./config/baby-config.json');
    if (!response.ok) throw new Error(`Config load failed: ${response.status}`);
    configData = await response.json();
    return configData;
  } catch (err) {
    console.error('Failed to load config, using defaults:', err);
    configData = getDefaultConfig();
    return configData;
  }
}

/**
 * Get already-loaded config (synchronous, must call loadConfig first)
 */
export function getConfig() {
  if (!configData) {
    console.warn('Config not loaded yet. Call loadConfig() first.');
    return getDefaultConfig();
  }
  return configData;
}

/**
 * Get all activity types flattened into a single map
 * Returns: { "breast_feed": { label, color, emoji, fields, category }, ... }
 */
export function getAllActivityTypes() {
  const config = getConfig();
  const types = {};
  for (const [catKey, category] of Object.entries(config.activityCategories)) {
    for (const [typeKey, typeData] of Object.entries(category.types)) {
      types[typeKey] = {
        ...typeData,
        category: catKey,
        categoryLabel: category.label,
        categoryIcon: category.icon
      };
    }
  }
  return types;
}

/**
 * Get a specific activity type config by key
 */
export function getActivityType(typeKey) {
  return getAllActivityTypes()[typeKey] || null;
}

/**
 * Get default duration for an activity type, factoring in user overrides
 */
export function getActivityDefaultDuration(typeKey, userSettings = null) {
  if (userSettings?.defaultDurations && userSettings.defaultDurations[typeKey] !== undefined && userSettings.defaultDurations[typeKey] !== null && userSettings.defaultDurations[typeKey] !== '') {
    return Number(userSettings.defaultDurations[typeKey]);
  }
  const type = getActivityType(typeKey);
  return type?.defaultDuration ?? 15;
}

/**
 * Get activity categories for grouped dropdown
 */
export function getActivityCategories() {
  return getConfig().activityCategories;
}

/**
 * Get expected performance data
 */
export function getExpectedPerformance() {
  return getConfig().expectedPerformance;
}

/**
 * Get unit configuration
 */
export function getUnitsConfig() {
  return getConfig().units;
}

/**
 * Get ad banner configuration
 */
export function getAdBannerConfig() {
  return getConfig().adBanner;
}

/**
 * Get notification configuration
 */
export function getNotificationConfig() {
  return getConfig().notifications;
}

/**
 * Get app metadata
 */
export function getAppConfig() {
  return getConfig().app;
}

/**
 * Minimal fallback config if JSON fails to load
 */
function getDefaultConfig() {
  return {
    activityCategories: {
      feeding: {
        label: 'Feeding',
        icon: '🍼',
        types: {
          breast_feed: { label: 'Breast Feed', color: '#7C5CFC', emoji: '🤱', defaultDuration: 15, fields: [] },
          formula_feed: { label: 'Formula Feed', color: '#FF8FA3', emoji: '🍼', defaultDuration: 15, fields: [] },
          express_feed: { label: 'Express Feed', color: '#FF9F43', emoji: '🥛', defaultDuration: 15, fields: [] }
        }
      },
      output: {
        label: 'Output',
        icon: '🧷',
        types: {
          poop: {
            label: 'Poop',
            color: '#A0522D',
            emoji: '💩',
            defaultDuration: 5,
            fields: [
              { key: 'color', label: 'Color', type: 'select', options: ["Yellow", "Green", "Brown", "Black", "Red"], required: false },
              { key: 'consistency', label: 'Consistency', type: 'select', options: ["Watery", "Soft", "Formed", "Hard"], required: false },
              { key: 'diaperChange', label: 'Diaper Changed', type: 'checkbox', default: true, required: false }
            ]
          },
          wet: {
            label: 'Wet',
            color: '#4A90D9',
            emoji: '💧',
            defaultDuration: 5,
            fields: [
              { key: 'diaperChange', label: 'Diaper Changed', type: 'checkbox', default: true, required: false }
            ]
          },
          diaper_change: { label: 'Diaper Change', color: '#6BBFA0', emoji: '🧷', defaultDuration: 5, fields: [] }
        }
      },
      activity: {
        label: 'Activity',
        icon: '🎈',
        types: {
          sleep: { label: 'Sleep', color: '#6C63FF', emoji: '😴', defaultDuration: 60, fields: [] },
          tummy_time: { label: 'Tummy Time', color: '#4ECDC4', emoji: '🐣', defaultDuration: 10, fields: [] },
          playtime: {
            label: 'Playtime',
            color: '#FFD93D',
            emoji: '🎈',
            defaultDuration: 20,
            fields: [
              { key: 'mood', label: 'Mood', type: 'select', options: ["Happy", "Calm", "Curious", "Playful", "Fussy", "Energetic", "Sleepy"], required: false }
            ]
          },
          crying: {
            label: 'Crying',
            color: '#FF7675',
            emoji: '😭',
            defaultDuration: 10,
            fields: [
              { key: 'reason', label: 'Reason / Cause', type: 'select', options: ["Hunger", "Colic / Gas", "Tired / Sleepy", "Wet Diaper", "Discomfort", "Teething", "Overstimulated", "Unknown"], required: false }
            ]
          },
          bath: { label: 'Bath', color: '#74B9FF', emoji: '🛁', defaultDuration: 15, fields: [] }
        }
      },
      health: {
        label: 'Health',
        icon: '🏥',
        types: {
          medicine: { label: 'Medicine', color: '#E17055', emoji: '💊', defaultDuration: 2, fields: [] },
          temperature: { label: 'Temperature', color: '#FDCB6E', emoji: '🌡️', defaultDuration: 2, fields: [] },
          weight_check: { label: 'Weight Check', color: '#A29BFE', emoji: '⚖️', defaultDuration: 2, fields: [] },
          massage: { label: 'Massage', color: '#FFC8DD', emoji: '💆', defaultDuration: 15, fields: [] }
        }
      }
    },
    expectedPerformance: {},
    units: {
      volume: { default: 'ml', options: ['ml', 'oz'], conversionFactor: 0.033814 },
      weight: { default: 'kg', options: ['kg', 'lb'], conversionFactor: 2.20462 },
      temperature: { default: '°F', options: ['°F', '°C'] }
    },
    notifications: { feedReminderDefault: 180, reminderOptions: [120, 180, 240] },
    adBanner: { enabled: true, height: '60px', adSlotId: '', adClient: '', placeholder: 'Ad Space' },
    app: { title: 'Babylogs by Plotkai', version: '1.0.0' }
  };
}
