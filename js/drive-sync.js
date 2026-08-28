// js/drive-sync.js — Google Drive Zero-Backend Multi-Parent Cloud Sync Manager

import { getDriveSyncConfig } from './config.js';
import { 
  getProfiles, 
  saveProfiles, 
  getAllActivities, 
  importActivities, 
  deleteActivity, 
  deleteProfile,
  getSettings,
  saveSettings,
  getDeletedTombstones,
  recordDeletedTombstone
} from './db.js';

// Storage keys
const STORAGE_SYNC_ID = 'babylogs_sync_file_id';
const STORAGE_AUTH_TOKEN = 'babylogs_gdrive_token';
const STORAGE_AUTH_USER = 'babylogs_gdrive_user';
const STORAGE_LAST_SYNC = 'babylogs_last_sync_time';
const STORAGE_CUSTOM_CLIENT_ID = 'babylogs_gdrive_custom_client_id';

class DriveSyncManager {
  constructor() {
    this.tokenClient = null;
    this.accessToken = null;
    this.tokenExpiresAt = 0;
    this.currentUser = null;
    this.syncId = localStorage.getItem(STORAGE_SYNC_ID) || null;
    this.status = 'idle'; // 'idle' | 'syncing' | 'synced' | 'error' | 'offline'
    this.lastError = null;
    this.syncStats = null;
    this.listeners = {
      statusChange: new Set(),
      dataChanged: new Set()
    };
    this.debounceTimer = null;
    this.heartbeatTimer = null;
    this.isSyncing = false;

    this.loadPersistedAuth();
    this.initNetworkListeners();
  }

  // ==================== INITIALIZATION & AUTH ====================

  /**
   * Load token & user details saved in storage
   */
  loadPersistedAuth() {
    try {
      const savedToken = localStorage.getItem(STORAGE_AUTH_TOKEN);
      if (savedToken) {
        const parsed = JSON.parse(savedToken);
        if (parsed.token && parsed.expiresAt > Date.now()) {
          this.accessToken = parsed.token;
          this.tokenExpiresAt = parsed.expiresAt;
        } else {
          localStorage.removeItem(STORAGE_AUTH_TOKEN);
        }
      }

      const savedUser = localStorage.getItem(STORAGE_AUTH_USER);
      if (savedUser) {
        this.currentUser = JSON.parse(savedUser);
      }
    } catch (e) {
      console.warn('Failed to parse persisted auth:', e);
    }
  }

  /**
   * Get active Google Client ID (custom user override or app default)
   */
  getClientId() {
    const custom = localStorage.getItem(STORAGE_CUSTOM_CLIENT_ID);
    if (custom && custom.trim().length > 0) return custom.trim();
    const config = getDriveSyncConfig();
    return config.clientId || '';
  }

  /**
   * Set custom Google Client ID
   */
  setCustomClientId(clientId) {
    if (clientId && clientId.trim().length > 0) {
      localStorage.setItem(STORAGE_CUSTOM_CLIENT_ID, clientId.trim());
    } else {
      localStorage.removeItem(STORAGE_CUSTOM_CLIENT_ID);
    }
    // Re-initialize token client
    this.tokenClient = null;
  }

  /**
   * Check if configured Google Client ID is valid
   */
  hasValidClientId() {
    const id = this.getClientId();
    return !!(id && id.trim().length > 15 && !id.includes('example.apps.googleusercontent.com') && id.endsWith('.apps.googleusercontent.com'));
  }

  /**
   * Check if Google Identity Services library is loaded
   */
  isGisLoaded() {
    return typeof window !== 'undefined' && !!(window.google?.accounts?.oauth2);
  }

  /**
   * Initialize GIS Token Client
   */
  async ensureTokenClient() {
    if (this.tokenClient) return this.tokenClient;

    if (!this.hasValidClientId()) {
      throw new Error('Please configure a valid Google OAuth Client ID first.');
    }

    const clientId = this.getClientId();

    // Wait for GIS script if still loading
    if (!this.isGisLoaded()) {
      await new Promise((resolve, reject) => {
        let attempts = 0;
        const interval = setInterval(() => {
          attempts++;
          if (this.isGisLoaded()) {
            clearInterval(interval);
            resolve();
          } else if (attempts > 50) { // 5 seconds timeout
            clearInterval(interval);
            reject(new Error('Google Identity Services script failed to load. Please check your network connection.'));
          }
        }, 100);
      });
    }

    const config = getDriveSyncConfig();
    const scopes = config.scopes || 'https://www.googleapis.com/auth/drive.file';

    this.tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: scopes,
      callback: () => {} // Overridden dynamically per request
    });

    return this.tokenClient;
  }

  /**
   * Request Google Access Token via GIS popup / silent prompt
   * @param {boolean} promptExplicit - If true, displays the Google consent account chooser
   */
  async requestAccessToken(promptExplicit = false) {
    // Return cached token if still valid for at least 2 minutes and explicit prompt is not requested
    if (!promptExplicit && this.accessToken && this.tokenExpiresAt > Date.now() + 120000) {
      return this.accessToken;
    }

    // If in background without user interaction and token is expired/missing, fail gracefully
    if (!promptExplicit) {
      const err = new Error('Google session expired. Tap Collaborate to re-authenticate.');
      err.code = 'AUTH_REQUIRED';
      throw err;
    }

    const client = await this.ensureTokenClient();

    return new Promise((resolve, reject) => {
      client.callback = async (tokenResponse) => {
        if (tokenResponse.error) {
          console.warn('GIS token error:', tokenResponse);
          const rawErr = tokenResponse.error;
          const desc = tokenResponse.error_description || rawErr;
          const err = new Error(rawErr === 'popup_closed_by_user' ? 'Google sign-in popup was closed' : `Google Auth: ${desc}`);
          err.code = 'AUTH_ERROR';
          err.rawError = rawErr;
          reject(err);
          return;
        }

        if (!tokenResponse.access_token) {
          const err = new Error('No access token returned from Google');
          err.code = 'AUTH_ERROR';
          reject(err);
          return;
        }

        this.accessToken = tokenResponse.access_token;
        const expiresInSec = Number(tokenResponse.expires_in) || 3599;
        this.tokenExpiresAt = Date.now() + (expiresInSec * 1000);

        localStorage.setItem(STORAGE_AUTH_TOKEN, JSON.stringify({
          token: this.accessToken,
          expiresAt: this.tokenExpiresAt
        }));

        // Fetch user profile info in background
        this.fetchUserProfile().catch(e => console.debug('Profile fetch deferred:', e));

        resolve(this.accessToken);
      };

      // Trigger OAuth popup on user gesture
      try {
        client.requestAccessToken({
          prompt: 'select_account'
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Fetch current authenticated Google user profile (email, name, picture)
   */
  async fetchUserProfile() {
    if (!this.accessToken) return null;

    try {
      const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${this.accessToken}` }
      });
      if (response.ok) {
        const user = await response.json();
        this.currentUser = {
          email: user.email,
          name: user.name,
          picture: user.picture
        };
        localStorage.setItem(STORAGE_AUTH_USER, JSON.stringify(this.currentUser));
        this.notifyStatusChange();
        return this.currentUser;
      }
    } catch (e) {
      console.warn('Could not fetch user profile info:', e);
    }
    return null;
  }

  /**
   * Disconnect / Sign out from Google Drive sync
   */
  signOut(unlinkFile = false) {
    if (this.accessToken && window.google?.accounts?.oauth2?.revoke) {
      try {
        window.google.accounts.oauth2.revoke(this.accessToken, () => {});
      } catch (e) {
        console.warn('Error revoking token:', e);
      }
    }

    this.accessToken = null;
    this.tokenExpiresAt = 0;
    this.currentUser = null;
    localStorage.removeItem(STORAGE_AUTH_TOKEN);
    localStorage.removeItem(STORAGE_AUTH_USER);

    if (unlinkFile) {
      this.syncId = null;
      localStorage.removeItem(STORAGE_SYNC_ID);
    }

    this.setStatus('idle');
  }

  // ==================== SYNC ID / FILE MANAGEMENT ====================

  /**
   * Set active syncId (e.g. from invite link or manual input)
   */
  setSyncId(fileId) {
    if (!fileId) {
      this.syncId = null;
      localStorage.removeItem(STORAGE_SYNC_ID);
    } else {
      this.syncId = fileId.trim();
      localStorage.setItem(STORAGE_SYNC_ID, this.syncId);
    }
    this.notifyStatusChange();
  }

  /**
   * Get active syncId
   */
  getSyncId() {
    return this.syncId || localStorage.getItem(STORAGE_SYNC_ID);
  }

  /**
   * Check if sync is configured and active
   */
  isConnected() {
    return !!(this.syncId && this.accessToken && this.tokenExpiresAt > Date.now());
  }

  /**
   * Generate invite link with current sync ID
   */
  getInviteLink() {
    if (!this.syncId) return '';
    const config = getDriveSyncConfig();
    const base = config.appUrl || window.location.origin;
    return `${base}/?syncId=${encodeURIComponent(this.syncId)}`;
  }

  // ==================== GOOGLE DRIVE API V3 CALLS ====================

  /**
   * Create `babylogs_store.json` on Google Drive and set writer permissions
   */
  async createCloudStoreFile(promptExplicitAuth = false) {
    const token = await this.requestAccessToken(promptExplicitAuth);
    const config = getDriveSyncConfig();
    const fileName = config.fileName || 'babylogs_store.json';

    // Prepare current local data as initial cloud payload
    const initialPayload = await this.prepareLocalStatePayload();

    const metadata = {
      name: fileName,
      mimeType: 'application/json',
      description: 'Babylogs Shared Cloud State for Multi-Parent Sync'
    };

    const boundary = '-------babylogs_boundary_' + Math.random().toString(36).substring(2);
    const delimiter = `\r\n--${boundary}\r\n`;
    const closeDelimiter = `\r\n--${boundary}--`;

    const multipartRequestBody =
      delimiter +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      JSON.stringify(metadata) +
      delimiter +
      'Content-Type: application/json\r\n\r\n' +
      JSON.stringify(initialPayload, null, 2) +
      closeDelimiter;

    const createRes = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/related; boundary=${boundary}`
      },
      body: multipartRequestBody
    });

    if (!createRes.ok) {
      const errBody = await createRes.text();
      throw new Error(`Failed to create Google Drive file (${createRes.status}): ${errBody}`);
    }

    const fileData = await createRes.json();
    const fileId = fileData.id;

    // Grant public writer access ('anyone with link can edit')
    await this.setFilePermissions(fileId, token);

    // Save as current syncId
    this.setSyncId(fileId);
    this.saveLastSyncTime();
    this.setStatus('synced');

    return fileId;
  }

  /**
   * Set Google Drive file permissions to anyone with link as writer
   */
  async setFilePermissions(fileId, token) {
    const permRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/permissions?supportsAllDrives=true`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        role: 'writer',
        type: 'anyone',
        allowFileDiscovery: false
      })
    });

    if (!permRes.ok) {
      const errText = await permRes.text();
      console.warn('Could not set public writer permission automatically:', errText);
      // If error is related to domain policy, we log but continue
    }
  }

  async parseApiError(res) {
    try {
      const text = await res.text();
      try {
        const json = JSON.parse(text);
        return json?.error?.message || text;
      } catch (e) {
        return text || `HTTP ${res.status}`;
      }
    } catch (e) {
      return `HTTP ${res.status}`;
    }
  }

  /**
   * Read raw JSON state from Google Drive file
   */
  async readStoreFile(fileId, token) {
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (!res.ok) {
      const errMsg = await this.parseApiError(res);
      if (res.status === 401) {
        const err = new Error('Google authentication expired. Please sign in again.');
        err.status = 401;
        throw err;
      }
      if (res.status === 404) {
        throw new Error('Cloud sync file not found. The file ID may be invalid or deleted.');
      }
      if (res.status === 403) {
        throw new Error(`Access denied to cloud file: ${errMsg}`);
      }
      throw new Error(`Failed to read cloud file (${res.status}): ${errMsg}`);
    }

    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error('Invalid JSON format in cloud file');
    }
  }

  /**
   * Overwrite JSON state in Google Drive file
   */
  async writeStoreFile(fileId, data, token) {
    const res = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media&supportsAllDrives=true`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(data, null, 2)
    });

    if (!res.ok) {
      const errMsg = await this.parseApiError(res);
      if (res.status === 401) {
        const err = new Error('Google authentication expired. Please sign in again.');
        err.status = 401;
        throw err;
      }
      throw new Error(`Failed to update cloud file (${res.status}): ${errMsg}`);
    }

    return await res.json();
  }

  // ==================== 2-WAY OFFLINE-FIRST MERGE ENGINE ====================

  /**
   * Export all local state for sync payload
   */
  async prepareLocalStatePayload() {
    const profiles = getProfiles();
    const activities = await getAllActivities();
    const settings = getSettings();
    const tombstones = getDeletedTombstones();

    return {
      version: '1.0.0',
      app: 'Babylogs by Plotkai',
      lastSyncedAt: new Date().toISOString(),
      profiles: profiles.map(p => ({
        ...p,
        updatedAt: p.updatedAt || p.createdAt || new Date().toISOString()
      })),
      activities: activities.map(a => ({
        ...a,
        updatedAt: a.updatedAt || a.createdAt || new Date().toISOString()
      })),
      tombstones: tombstones || {},
      settings: {
        unit: settings.unit,
        defaultDurations: settings.defaultDurations
      }
    };
  }

  /**
   * Perform 2-Way Merge between local state and remote cloud state (Last-Write-Wins)
   */
  async mergeStates(remoteState) {
    const localProfiles = getProfiles();
    const localActivities = await getAllActivities();
    const localTombstones = getDeletedTombstones();
    const remoteTombstones = remoteState.tombstones || {};

    // 1. Merge Tombstones
    const mergedTombstones = { ...localTombstones };
    for (const [id, t] of Object.entries(remoteTombstones)) {
      if (!mergedTombstones[id] || new Date(t.deletedAt) > new Date(mergedTombstones[id].deletedAt)) {
        mergedTombstones[id] = t;
      }
    }
    // Save updated tombstones locally
    localStorage.setItem('babylogs_tombstones', JSON.stringify(mergedTombstones));

    let newFromRemote = 0;
    let updatedFromRemote = 0;
    let uploadedToRemote = 0;
    let localDeletedCount = 0;

    // 2. Merge Baby Profiles
    const profileMap = new Map();
    const remoteProfiles = Array.isArray(remoteState.profiles) ? remoteState.profiles : [];

    // Add local profiles
    for (const p of localProfiles) {
      if (mergedTombstones[p.id]) {
        localDeletedCount++;
        continue;
      }
      profileMap.set(p.id, { ...p });
    }

    // Merge remote profiles
    for (const rp of remoteProfiles) {
      if (mergedTombstones[rp.id]) continue;

      if (!profileMap.has(rp.id)) {
        profileMap.set(rp.id, { ...rp });
        newFromRemote++;
      } else {
        const localP = profileMap.get(rp.id);
        const localTime = new Date(localP.updatedAt || localP.createdAt || 0).getTime();
        const remoteTime = new Date(rp.updatedAt || rp.createdAt || 0).getTime();

        if (remoteTime > localTime) {
          profileMap.set(rp.id, { ...rp });
          updatedFromRemote++;
        } else if (localTime > remoteTime) {
          uploadedToRemote++;
        }
      }
    }

    const mergedProfiles = Array.from(profileMap.values());
    saveProfiles(mergedProfiles);

    // 3. Merge Activities
    const activityMap = new Map();
    const remoteActivities = Array.isArray(remoteState.activities) ? remoteState.activities : [];

    // Register local activities
    for (const a of localActivities) {
      if (mergedTombstones[a.id]) {
        // Delete local activity if marked deleted by a newer tombstone
        await deleteActivity(a.id, false);
        localDeletedCount++;
        continue;
      }
      activityMap.set(a.id, { ...a });
    }

    // Merge remote activities
    const activitiesToSaveLocally = [];

    for (const ra of remoteActivities) {
      if (mergedTombstones[ra.id]) continue;

      if (!activityMap.has(ra.id)) {
        activityMap.set(ra.id, { ...ra });
        activitiesToSaveLocally.push(ra);
        newFromRemote++;
      } else {
        const localA = activityMap.get(ra.id);
        const localTime = new Date(localA.updatedAt || localA.createdAt || 0).getTime();
        const remoteTime = new Date(ra.updatedAt || ra.createdAt || 0).getTime();

        if (remoteTime > localTime) {
          activityMap.set(ra.id, { ...ra });
          activitiesToSaveLocally.push(ra);
          updatedFromRemote++;
        } else if (localTime > remoteTime) {
          uploadedToRemote++;
        }
      }
    }

    if (activitiesToSaveLocally.length > 0) {
      await importActivities(activitiesToSaveLocally);
    }

    const mergedActivities = Array.from(activityMap.values());

    // 4. Merge Settings (keep local active baby if present, otherwise select first synced baby)
    const currentSettings = getSettings();
    if (!currentSettings.activeBabyId && mergedProfiles.length > 0) {
      currentSettings.activeBabyId = mergedProfiles[0].id;
    }
    if (remoteState.settings?.defaultDurations) {
      currentSettings.defaultDurations = {
        ...remoteState.settings.defaultDurations,
        ...currentSettings.defaultDurations
      };
    }
    saveSettings(currentSettings);

    const mergedCloudPayload = {
      version: '1.0.0',
      app: 'Babylogs by Plotkai',
      lastSyncedAt: new Date().toISOString(),
      profiles: mergedProfiles,
      activities: mergedActivities,
      tombstones: mergedTombstones,
      settings: {
        unit: currentSettings.unit,
        defaultDurations: currentSettings.defaultDurations
      }
    };

    return {
      mergedCloudPayload,
      stats: {
        newFromRemote,
        updatedFromRemote,
        uploadedToRemote,
        totalProfiles: mergedProfiles.length,
        totalActivities: mergedActivities.length
      }
    };
  }

  // ==================== SYNC EXECUTION & ORCHESTRATION ====================

  /**
   * Execute full 2-way sync with Google Drive
   */
  async sync(promptExplicitAuth = false) {
    if (!navigator.onLine) {
      this.setStatus('offline');
      return { success: false, reason: 'offline' };
    }

    const fileId = this.getSyncId();
    if (!fileId) {
      this.setStatus('idle');
      return { success: false, reason: 'no_sync_id' };
    }

    if (this.isSyncing) return { success: false, reason: 'in_progress' };

    this.isSyncing = true;
    this.setStatus('syncing');

    try {
      // 1. Get access token
      let token = await this.requestAccessToken(promptExplicitAuth);
      let remoteState;

      // 2. Read remote state from Google Drive (with auto-retry on 401)
      try {
        remoteState = await this.readStoreFile(fileId, token);
      } catch (readErr) {
        if (readErr.status === 401) {
          this.accessToken = null;
          this.tokenExpiresAt = 0;
          localStorage.removeItem(STORAGE_AUTH_TOKEN);
          token = await this.requestAccessToken(true);
          remoteState = await this.readStoreFile(fileId, token);
        } else {
          throw readErr;
        }
      }

      // 3. Perform 2-way merge
      const { mergedCloudPayload, stats } = await this.mergeStates(remoteState);

      // 4. Upload merged state back to Google Drive (with auto-retry on 401)
      try {
        await this.writeStoreFile(fileId, mergedCloudPayload, token);
      } catch (writeErr) {
        if (writeErr.status === 401) {
          this.accessToken = null;
          this.tokenExpiresAt = 0;
          localStorage.removeItem(STORAGE_AUTH_TOKEN);
          token = await this.requestAccessToken(true);
          await this.writeStoreFile(fileId, mergedCloudPayload, token);
        } else {
          throw writeErr;
        }
      }

      // 5. Update local metadata
      this.syncStats = stats;
      this.saveLastSyncTime();
      this.setStatus('synced');
      this.lastError = null;

      // 6. Notify UI to refresh data views
      this.notifyDataChanged(stats);

      return { success: true, stats };
    } catch (err) {
      console.warn('Drive Sync Status:', err.message);
      if (err.code === 'AUTH_ERROR' || err.status === 401 || err.rawError === 'access_denied') {
        this.lastError = 'Session expired — tap Sync Now to sign in';
        this.setStatus('auth_required');
      } else {
        this.lastError = err.message || 'Sync failed';
        this.setStatus('error');
      }
      return { success: false, error: err };
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Debounced background sync trigger for local user edits
   */
  queueSync(debounceMs = 3000) {
    if (!this.getSyncId()) return;

    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.sync(false).catch(err => {
        console.debug('Background queued sync deferred:', err);
      });
    }, debounceMs);
  }

  // ==================== EVENT LISTENERS & LIFECYCLE ====================

  /**
   * Initialize online/offline, visibility change, and heartbeat triggers
   */
  initNetworkListeners() {
    window.addEventListener('online', () => {
      if (this.getSyncId()) {
        this.sync(false);
      } else {
        this.setStatus('idle');
      }
    });

    window.addEventListener('offline', () => {
      this.setStatus('offline');
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.getSyncId()) {
        this.sync(false);
      }
    });

    // Periodic heartbeat sync
    const config = getDriveSyncConfig();
    const intervalMinutes = config.autoSyncIntervalMinutes || 5;
    this.heartbeatTimer = setInterval(() => {
      if (document.visibilityState === 'visible' && this.getSyncId() && navigator.onLine) {
        this.sync(false);
      }
    }, intervalMinutes * 60 * 1000);
  }

  saveLastSyncTime() {
    localStorage.setItem(STORAGE_LAST_SYNC, new Date().toISOString());
  }

  getLastSyncTime() {
    const raw = localStorage.getItem(STORAGE_LAST_SYNC);
    return raw ? new Date(raw) : null;
  }

  setStatus(status) {
    this.status = status;
    this.notifyStatusChange();
  }

  onStatusChange(callback) {
    this.listeners.statusChange.add(callback);
    return () => this.listeners.statusChange.delete(callback);
  }

  onDataChanged(callback) {
    this.listeners.dataChanged.add(callback);
    return () => this.listeners.dataChanged.delete(callback);
  }

  notifyStatusChange() {
    for (const cb of this.listeners.statusChange) {
      try { cb(this.status, this); } catch (e) { console.error(e); }
    }
  }

  notifyDataChanged(stats) {
    for (const cb of this.listeners.dataChanged) {
      try { cb(stats); } catch (e) { console.error(e); }
    }
  }
}

export const driveSync = new DriveSyncManager();
