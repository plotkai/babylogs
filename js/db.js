// js/db.js — IndexedDB + localStorage abstraction layer

const DB_NAME = 'babylog';
const DB_VERSION = 1;
const STORE_NAME = 'activities';
const PROFILES_KEY = 'babylog_profiles';
const SETTINGS_KEY = 'babylog_settings';

let dbInstance = null;

/**
 * Open (or get cached) IndexedDB connection
 */
function openDB() {
  if (dbInstance) return Promise.resolve(dbInstance);

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('babyId_date', ['babyId', 'date'], { unique: false });
        store.createIndex('babyId_eventType', ['babyId', 'eventType'], { unique: false });
        store.createIndex('startTime', 'startTime', { unique: false });
        store.createIndex('babyId', 'babyId', { unique: false });
      }
    };

    request.onsuccess = (event) => {
      dbInstance = event.target.result;
      resolve(dbInstance);
    };

    request.onerror = (event) => {
      console.error('IndexedDB open error:', event.target.error);
      reject(event.target.error);
    };
  });
}

/**
 * Run a transaction on the activities store
 */
async function withStore(mode, callback) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    const store = tx.objectStore(STORE_NAME);
    const result = callback(store);

    tx.oncomplete = () => resolve(result._value);
    tx.onerror = (event) => reject(event.target.error);

    // If callback returned a request, capture its result
    if (result instanceof IDBRequest) {
      result.onsuccess = () => resolve(result.result);
      result.onerror = (event) => reject(event.target.error);
    }
  });
}

// ==================== ACTIVITY OPERATIONS ====================

/**
 * Add a new activity entry
 */
export async function addActivity(entry) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.add(entry);
    request.onsuccess = () => resolve(entry);
    request.onerror = (event) => reject(event.target.error);
  });
}

/**
 * Update an existing activity
 */
export async function updateActivity(entry) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.put(entry);
    request.onsuccess = () => resolve(entry);
    request.onerror = (event) => reject(event.target.error);
  });
}

/**
 * Delete an activity by ID
 */
export async function deleteActivity(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.delete(id);
    request.onsuccess = () => resolve(true);
    request.onerror = (event) => reject(event.target.error);
  });
}

/**
 * Get a single activity by ID
 */
export async function getActivity(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(id);
    request.onsuccess = () => resolve(request.result);
    request.onerror = (event) => reject(event.target.error);
  });
}

/**
 * Get all activities for a baby on a specific date
 */
export async function getActivitiesByDate(babyId, dateKey) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const index = store.index('babyId_date');
    const request = index.getAll([babyId, dateKey]);
    request.onsuccess = () => {
      const results = request.result || [];
      results.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
      resolve(results);
    };
    request.onerror = (event) => reject(event.target.error);
  });
}

/**
 * Get all activities for a baby within a date range
 */
export async function getActivitiesByRange(babyId, startDate, endDate) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const index = store.index('babyId');
    const request = index.getAll(babyId);
    request.onsuccess = () => {
      const results = (request.result || []).filter(entry => {
        return entry.date >= startDate && entry.date <= endDate;
      });
      results.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
      resolve(results);
    };
    request.onerror = (event) => reject(event.target.error);
  });
}

/**
 * Get the most recent activity of a given type for a baby
 */
export async function getLastActivityOfType(babyId, eventTypes) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const index = store.index('babyId');
    const request = index.getAll(babyId);
    request.onsuccess = () => {
      const results = (request.result || [])
        .filter(entry => eventTypes.includes(entry.eventType))
        .sort((a, b) => new Date(b.startTime) - new Date(a.startTime));
      resolve(results[0] || null);
    };
    request.onerror = (event) => reject(event.target.error);
  });
}

/**
 * Get all activities for a baby (for export)
 */
export async function getAllActivities(babyId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    if (babyId) {
      const index = store.index('babyId');
      const request = index.getAll(babyId);
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = (event) => reject(event.target.error);
    } else {
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = (event) => reject(event.target.error);
    }
  });
}

/**
 * Clear all activities (for a baby or all)
 */
export async function clearAllActivities(babyId) {
  if (babyId) {
    const activities = await getAllActivities(babyId);
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      for (const activity of activities) {
        store.delete(activity.id);
      }
      tx.oncomplete = () => resolve(true);
      tx.onerror = (event) => reject(event.target.error);
    });
  } else {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.clear();
      request.onsuccess = () => resolve(true);
      request.onerror = (event) => reject(event.target.error);
    });
  }
}

/**
 * Import activities (bulk add)
 */
export async function importActivities(activities) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    for (const activity of activities) {
      store.put(activity);
    }
    tx.oncomplete = () => resolve(true);
    tx.onerror = (event) => reject(event.target.error);
  });
}

// ==================== PROFILE OPERATIONS (localStorage) ====================

/**
 * Get all baby profiles
 */
export function getProfiles() {
  try {
    const data = localStorage.getItem(PROFILES_KEY);
    return data ? JSON.parse(data) : [];
  } catch {
    return [];
  }
}

/**
 * Save all baby profiles
 */
export function saveProfiles(profiles) {
  localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles));
}

/**
 * Add a new baby profile
 */
export function addProfile(profile) {
  const profiles = getProfiles();
  profiles.push(profile);
  saveProfiles(profiles);
  return profile;
}

/**
 * Update a baby profile
 */
export function updateProfile(id, updates) {
  const profiles = getProfiles();
  const index = profiles.findIndex(p => p.id === id);
  if (index !== -1) {
    profiles[index] = { ...profiles[index], ...updates };
    saveProfiles(profiles);
    return profiles[index];
  }
  return null;
}

/**
 * Delete a baby profile
 */
export function deleteProfile(id) {
  const profiles = getProfiles().filter(p => p.id !== id);
  saveProfiles(profiles);
}

/**
 * Get a profile by ID
 */
export function getProfile(id) {
  return getProfiles().find(p => p.id === id) || null;
}

// ==================== SETTINGS OPERATIONS (localStorage) ====================

const DEFAULT_SETTINGS = {
  activeBabyId: null,
  unit: {
    volume: 'ml',
    weight: 'kg',
    temperature: '°F'
  },
  timelineSortOrder: 'asc',
  notificationsEnabled: false,
  feedReminderInterval: 180
};

/**
 * Get app settings
 */
export function getSettings() {
  try {
    const data = localStorage.getItem(SETTINGS_KEY);
    return data ? { ...DEFAULT_SETTINGS, ...JSON.parse(data) } : { ...DEFAULT_SETTINGS };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * Save app settings
 */
export function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

/**
 * Update a specific setting
 */
export function updateSetting(key, value) {
  const settings = getSettings();
  settings[key] = value;
  saveSettings(settings);
  return settings;
}

// ==================== EXPORT / IMPORT ALL DATA ====================

/**
 * Export all data as JSON object
 */
export async function exportAllData() {
  return exportFilteredData();
}

/**
 * Export filtered data as JSON object
 */
export async function exportFilteredData({ babyId = null, startDate = null, endDate = null } = {}) {
  let profiles = getProfiles();
  if (babyId) {
    profiles = profiles.filter(p => p.id === babyId);
  }
  const settings = getSettings();
  let activities = await getAllActivities();

  if (babyId) {
    activities = activities.filter(a => a.babyId === babyId);
  }

  if (startDate) {
    activities = activities.filter(a => a.date >= startDate);
  }
  if (endDate) {
    activities = activities.filter(a => a.date <= endDate);
  }

  // Sort activities chronologically
  activities.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));

  return {
    version: '1.0.0',
    exportDate: new Date().toISOString(),
    app: 'Babylogs by Plotkai',
    filter: {
      babyId: babyId || 'all',
      startDate: startDate || null,
      endDate: endDate || null
    },
    profiles,
    settings,
    activities
  };
}

/**
 * Import data with chosen strategy: 'merge' (default) or 'replace'
 */
export async function importDataWithMode(data, mode = 'merge') {
  if (!data || !data.profiles || !data.activities) {
    throw new Error('Invalid backup file: missing profiles or activities data');
  }

  if (mode === 'replace') {
    // 1. Wipe everything
    await clearAllData();
    // 2. Restore profiles & settings
    saveProfiles(data.profiles);
    if (data.settings) {
      saveSettings(data.settings);
    }
    // 3. Restore activities
    await importActivities(data.activities);

    return {
      mode: 'replace',
      profilesCount: data.profiles.length,
      activitiesCount: data.activities.length
    };
  }

  // mode === 'merge' (Keep old & merge)
  const existingProfiles = getProfiles();
  const existingProfileMap = new Map(existingProfiles.map(p => [p.id, p]));

  for (const importedProfile of data.profiles) {
    if (!existingProfileMap.has(importedProfile.id)) {
      // Check if a profile with exact same name already exists to map IDs
      const duplicateName = existingProfiles.find(p => p.name.trim().toLowerCase() === importedProfile.name.trim().toLowerCase());
      if (duplicateName) {
        for (const a of data.activities) {
          if (a.babyId === importedProfile.id) {
            a.babyId = duplicateName.id;
          }
        }
      } else {
        existingProfiles.push(importedProfile);
      }
    }
  }
  saveProfiles(existingProfiles);

  // If no active baby is set, set the first profile
  const settings = getSettings();
  if (!settings.activeBabyId && existingProfiles.length > 0) {
    settings.activeBabyId = existingProfiles[0].id;
    saveSettings(settings);
  }

  // Merge activities into IndexedDB (put overwrites matches by key 'id', and adds new ones)
  await importActivities(data.activities);

  return {
    mode: 'merge',
    profilesCount: data.profiles.length,
    activitiesCount: data.activities.length,
    totalProfiles: existingProfiles.length
  };
}

/**
 * Import all data from JSON object (legacy backward compatibility)
 */
export async function importAllData(data) {
  return importDataWithMode(data, 'replace');
}

/**
 * Clear everything
 */
export async function clearAllData() {
  localStorage.removeItem(PROFILES_KEY);
  localStorage.removeItem(SETTINGS_KEY);
  await clearAllActivities();
}

// Initialize DB on module load
openDB().catch(err => console.error('Failed to initialize DB:', err));
