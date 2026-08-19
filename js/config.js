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
          breast_feed: { label: 'Breast Feed', color: '#7C5CFC', emoji: '🤱', fields: [] },
          formula_feed: { label: 'Formula Feed', color: '#FF8FA3', emoji: '🍼', fields: [] },
          express_feed: { label: 'Express Feed', color: '#FF9F43', emoji: '🥛', fields: [] }
        }
      },
      output: {
        label: 'Output',
        icon: '🧷',
        types: {
          poop: { label: 'Poop', color: '#A0522D', emoji: '💩', fields: [] },
          wet: { label: 'Wet', color: '#4A90D9', emoji: '💧', fields: [] },
          diaper_change: { label: 'Diaper Change', color: '#6BBFA0', emoji: '🧷', fields: [] }
        }
      },
      activity: {
        label: 'Activity',
        icon: '🎈',
        types: {
          sleep: { label: 'Sleep', color: '#6C63FF', emoji: '😴', fields: [] },
          tummy_time: { label: 'Tummy Time', color: '#4ECDC4', emoji: '🐣', fields: [] },
          playtime: { label: 'Playtime', color: '#FFD93D', emoji: '🎈', fields: [] },
          bath: { label: 'Bath', color: '#74B9FF', emoji: '🛁', fields: [] }
        }
      },
      health: {
        label: 'Health',
        icon: '🏥',
        types: {
          medicine: { label: 'Medicine', color: '#E17055', emoji: '💊', fields: [] },
          temperature: { label: 'Temperature', color: '#FDCB6E', emoji: '🌡️', fields: [] },
          weight_check: { label: 'Weight Check', color: '#A29BFE', emoji: '⚖️', fields: [] }
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
