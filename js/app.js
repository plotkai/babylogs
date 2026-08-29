// js/app.js — Main app logic, routing, UI rendering

import { loadConfig, getConfig, getAllActivityTypes, getActivityType, getActivityCategories, getAdBannerConfig, getAppConfig, getActivityDefaultDuration } from './config.js';
import { getProfiles, addProfile, updateProfile, deleteProfile, getSettings, updateSetting, saveSettings, getActivitiesByDate, addActivity, updateActivity, deleteActivity, clearAllData, exportFilteredData, getSettings as getAppSettings, updateActivityDefaultDuration, resetDefaultDurations } from './db.js';
import { generateId, formatTime, formatTimeRange, formatDateDisplay, formatDateFull, formatDateKey, formatDuration, calculateEndTime, buildDisplayText, getAgeString, isToday, isThisWeek, isThisMonth, formatWeekRange, formatMonthDisplay } from './utils.js';
import { startReminders, stopReminders, getLastFeedElapsed, requestPermission, isNotificationSupported } from './notifications.js';
import { exportJSON, exportCSV, exportPDF, parseBackupFile, executeImport, shareBackup, shareSummaryText, inspectBackup } from './export.js';
import { computeSummary, getDateRange, comparePerformance, renderBarChart, renderLineChart, renderWeekCareCalendar, renderMonthCareCalendar } from './summary.js';
import { trackPageView, trackActivityLogged, trackDataExport, trackDataImport, trackPWAInstall } from './analytics.js';
import { driveSync } from './drive-sync.js';
import { generateQRCodeSVG } from './qrcode.js';

// ==================== STATE ====================
let currentView = 'welcome'; // 'welcome' | 'main' | 'summary' | 'settings'
let currentDate = new Date();
let summaryDate = new Date();
let summaryPeriod = 'day';
let currentActivities = [];
let currentEventFilter = '';
let editingActivity = null;
let deferredInstallPrompt = null;
let feedTimerInterval = null;
let babySwitcherOpen = false;

// ==================== INITIALIZATION ====================

async function init() {
  // Capture PWA install prompt
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    updateInstallButtons();
  });

  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    updateInstallButtons();
    showToast('App installed successfully! 🎉');
  });

  // Load config
  await loadConfig();

  // Initialize Drive Sync Hooks & Auto-Sync
  initDriveSyncHooks();

  // Initialize Screen Wake & App Resume Listeners (refreshes timeline gaps & timers live)
  initAppResumeListeners();

  // Register service worker
  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('./sw.js');
    } catch (err) {
      console.warn('SW registration failed:', err);
    }
  }

  // Determine initial view
  const profiles = getProfiles();
  if (profiles.length === 0) {
    renderWelcome();
  } else {
    // Ensure active baby is set
    const settings = getSettings();
    if (!settings.activeBabyId || !profiles.find(p => p.id === settings.activeBabyId)) {
      updateSetting('activeBabyId', profiles[0].id);
    }
    renderMain();
  }

  // Check incoming Web Share Target or File Handling API ("Open With Babylogs")
  checkIncomingSharedBackup();

  // Check incoming deep link with ?syncId=...
  checkIncomingSyncId();
}

/**
 * Initialize Drive Sync status listeners and reactive data reload
 */
function initDriveSyncHooks() {
  driveSync.onDataChanged((stats) => {
    const profiles = getProfiles();
    const settings = getSettings();
    if (!settings.activeBabyId && profiles.length > 0) {
      updateSetting('activeBabyId', profiles[0].id);
    }

    const modalOverlay = document.getElementById('modal-overlay');
    const isModalOpen = modalOverlay && modalOverlay.classList.contains('active');

    // Reactive UI refresh when new changes sync in from partner
    if (currentView === 'welcome' && profiles.length > 0) {
      renderMain();
    } else if (currentView === 'main') {
      // If modal is open, NEVER wipe DOM or close active logging modal!
      loadTimeline();
      updateFeedTimer();
      updateHeaderSyncIndicator();
    } else if (currentView === 'summary') {
      if (!isModalOpen) renderSummary();
    } else if (currentView === 'manage-babies') {
      if (!isModalOpen) renderManageBabies();
    }

    if (stats && (stats.newFromRemote > 0 || stats.updatedFromRemote > 0)) {
      showToast(`Cloud Synced: +${stats.newFromRemote + stats.updatedFromRemote} updates from partner ✓`);
    }
  });

  // Update title bar sync indicator on status changes
  driveSync.onStatusChange(() => {
    updateHeaderSyncIndicator();
  });

  // Periodically refresh relative time indicator in header (every 60s)
  setInterval(() => {
    updateHeaderSyncIndicator();
  }, 60000);

  // If already connected with a syncId, run initial background sync
  if (driveSync.getSyncId() && navigator.onLine) {
    setTimeout(() => {
      driveSync.sync(false).then(() => {
        const profiles = getProfiles();
        if (profiles.length > 0 && !getSettings().activeBabyId) {
          updateSetting('activeBabyId', profiles[0].id);
          if (currentView === 'welcome') renderMain();
        }
      }).catch(err => console.debug('Initial sync deferred:', err));
    }, 1000);
  }
}

/**
 * Automatically refresh timeline gaps, feed timer, and relative timestamps on app resume, focus, or screen wake
 */
function initAppResumeListeners() {
  const onAppResume = () => {
    if (document.visibilityState === 'visible') {
      const modalOverlay = document.getElementById('modal-overlay');
      const isModalOpen = modalOverlay && modalOverlay.classList.contains('active');

      if (currentView === 'main') {
        // Recalculate ongoing gap and refresh feed timer up to the exact current minute
        if (isToday(currentDate) && !isModalOpen) {
          loadTimeline();
        }
        updateFeedTimer();
        updateHeaderSyncIndicator();
      } else if (currentView === 'summary') {
        if (!isModalOpen) renderSummary();
      }
    }
  };

  document.addEventListener('visibilitychange', onAppResume);
  window.addEventListener('focus', onAppResume);
  window.addEventListener('pageshow', onAppResume);

  // Live periodic update: every 60s while app is on screen,
  // update the ongoing activity gap and feed timer live
  setInterval(() => {
    if (document.visibilityState === 'visible') {
      const modalOverlay = document.getElementById('modal-overlay');
      const isModalOpen = modalOverlay && modalOverlay.classList.contains('active');

      if (currentView === 'main' && isToday(currentDate) && !isModalOpen) {
        loadTimeline();
        updateFeedTimer();
      }
    }
  }, 60000);
}

/**
 * Update the title bar Cloud Sync status icon (before analytics button)
 */
function updateHeaderSyncIndicator() {
  const syncBtn = document.getElementById('header-sync-btn');
  if (!syncBtn) return;

  const info = driveSync.getEffectiveSyncState();
  if (!info.hasSyncId) {
    syncBtn.innerHTML = `
      <div class="header__sync-icon-box" title="Collaborate & Sync (Connect Partner)">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity: 0.65;">
          <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"></path>
        </svg>
      </div>
    `;
    syncBtn.title = 'Collaborate & Sync (Connect Partner)';
    syncBtn.className = 'header__action-btn header__sync-btn header__sync-btn--unlinked';
    return;
  }

  if (info.state === 'syncing') {
    syncBtn.innerHTML = `
      <div class="header__sync-icon-box" title="Syncing with Google Drive...">
        <svg class="header__sync-spin" width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/>
        </svg>
      </div>
    `;
    syncBtn.title = 'Syncing with Google Drive...';
    syncBtn.className = 'header__action-btn header__sync-btn header__sync-btn--syncing';
  } else if (info.state === 'synced') {
    syncBtn.innerHTML = `
      <div class="header__sync-icon-box" title="Synced ${info.timeAgoText} • Cloud active">
        <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"></path>
        </svg>
        <span class="header__sync-dot header__sync-dot--green"></span>
      </div>
    `;
    syncBtn.title = `Synced ${info.timeAgoText} • Cloud active`;
    syncBtn.className = 'header__action-btn header__sync-btn header__sync-btn--synced';
  } else {
    // Out of Sync (Session expired >60m, offline, or sync error) -> Solid RED dot
    syncBtn.innerHTML = `
      <div class="header__sync-icon-box" title="Out of sync (${info.timeAgoText}) • Tap to sign in & sync">
        <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"></path>
        </svg>
        <span class="header__sync-dot header__sync-dot--red"></span>
      </div>
    `;
    syncBtn.title = info.error ? `Sync paused (${info.error}) • Tap to retry` : `Out of sync (${info.timeAgoText}) • Tap to sign in & sync`;
    syncBtn.className = 'header__action-btn header__sync-btn header__sync-btn--warning';
  }
}

/**
 * Check for incoming deep link ?syncId=<FILE_ID> in URL
 */
function checkIncomingSyncId() {
  try {
    const urlParams = new URLSearchParams(window.location.search);
    const incomingSyncId = urlParams.get('syncId');
    if (incomingSyncId && incomingSyncId.trim().length > 0) {
      driveSync.setSyncId(incomingSyncId.trim());
      // Clean URL without reloading page
      window.history.replaceState({}, document.title, window.location.pathname);
      showToast('🔗 Shared baby log detected!');
      setTimeout(() => {
        openCollabModal('join');
      }, 500);
    }
  } catch (err) {
    console.debug('No incoming syncId in URL:', err);
  }
}

/**
 * Handle incoming shared backup files from Web Share Target or File Handling API
 */
async function checkIncomingSharedBackup() {
  // 1. File Handling API (Desktop / Android "Open with Babylogs")
  if ('launchQueue' in window && 'files' in LaunchParams.prototype) {
    launchQueue.setConsumer(async (launchParams) => {
      if (launchParams.files && launchParams.files.length > 0) {
        try {
          const file = await launchParams.files[0].getFile();
          const parsedData = await parseBackupFile(file);
          openImportModal(parsedData, file.name);
        } catch (err) {
          showToast(`Could not open shared file: ${err.message}`);
        }
      }
    });
  }

  // 2. Web Share Target POST cache or URL param
  try {
    if ('caches' in window) {
      const shareCache = await caches.open('babylogs-share-target');
      const match = await shareCache.match('./incoming-backup.json');
      if (match) {
        const text = await match.text();
        await shareCache.delete('./incoming-backup.json');
        if (window.location.search.includes('shared_target')) {
          window.history.replaceState({}, document.title, window.location.pathname);
        }
        const parsedData = JSON.parse(text);
        setTimeout(() => openImportModal(parsedData, 'Shared Backup from WhatsApp / App'), 300);
      }
    }
  } catch (err) {
    console.debug('No incoming share target data:', err);
  }
}

// ==================== WELCOME SCREEN ====================

function renderWelcome() {
  currentView = 'welcome';
  trackPageView('welcome', 'Babylogs - Welcome');
  const app = document.getElementById('app');
  const appConfig = getAppConfig();

  app.innerHTML = `
    <div class="welcome" id="welcome-screen">
      <div class="welcome__logo">
        <img src="./icons/icon-192.png" alt="Babylogs" class="welcome__icon-img" width="88" height="88">
      </div>
      <h1 class="welcome__title">
        <span class="welcome__title-main">Babylogs</span>
        <span class="welcome__title-sub">by Plotkai</span>
      </h1>
      <p class="welcome__subtitle">${appConfig.description || 'Track your baby\'s feeds, diapers, sleep and more'}</p>

      ${!window.matchMedia('(display-mode: standalone)').matches ? `
      <button type="button" class="welcome__install-btn" id="welcome-install-btn">
        📲 Install App
      </button>
      ` : ''}

      <form class="welcome__form" id="welcome-form">
        <div class="form-group">
          <label class="form-group__label">Baby's Name</label>
          <input type="text" class="form-group__input" id="welcome-name" placeholder="Enter baby's name" required autocomplete="off">
        </div>
        <div class="form-group">
          <label class="form-group__label">Date of Birth</label>
          <input type="date" class="form-group__input" id="welcome-dob" required max="${formatDateKey(new Date())}" value="${formatDateKey(new Date())}">
        </div>
        <div class="welcome__cta">
          <button type="submit" class="btn btn--primary btn--full">Get Started 🚀</button>
        </div>

        <div class="welcome__divider">
          <span>or join existing log</span>
        </div>

        <div class="welcome__alt-actions">
          <button type="button" class="btn welcome__collab-btn btn--full" id="welcome-collab-btn">
            🤝 Collaborate / Join Partner
          </button>
          <button type="button" class="welcome__import-btn btn--full" id="welcome-import-btn">
            📥 Restore from Backup File
          </button>
        </div>
      </form>
    </div>

    <!-- Modal Overlay -->
    <div class="modal-overlay" id="modal-overlay">
      <div class="modal" id="modal">
        <div class="modal__drag-handle"></div>
        <div class="modal__header">
          <h2 class="modal__title" id="modal-title"></h2>
          <button class="modal__close-btn" id="modal-close">✕</button>
        </div>
        <div class="modal__body" id="modal-body"></div>
        <div class="modal__footer" id="modal-footer"></div>
      </div>
    </div>

    <!-- Confirm Dialog Overlay -->
    <div class="confirm-overlay" id="confirm-overlay">
      <div class="confirm-dialog" id="confirm-dialog"></div>
    </div>

    <div class="toast" id="toast"></div>
  `;

  document.getElementById('modal-close')?.addEventListener('click', closeModal);
  document.getElementById('modal-overlay')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeModal();
  });

  document.getElementById('welcome-collab-btn')?.addEventListener('click', () => {
    openCollabModal('join');
  });

  document.getElementById('welcome-import-btn')?.addEventListener('click', () => {
    openImportModal();
  });

  document.getElementById('welcome-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = document.getElementById('welcome-name').value.trim();
    const dob = document.getElementById('welcome-dob').value;
    if (!name || !dob) return;

    const profile = {
      id: generateId(),
      name,
      dob,
      createdAt: new Date().toISOString()
    };

    addProfile(profile);
    updateSetting('activeBabyId', profile.id);
    driveSync.queueSync();
    renderMain();
  });

  const installBtn = document.getElementById('welcome-install-btn');
  if (installBtn) {
    installBtn.addEventListener('click', triggerInstall);
  }
}

// ==================== MAIN SCREEN ====================

async function renderMain() {
  currentView = 'main';
  trackPageView('main', 'Babylogs - Timeline');
  const app = document.getElementById('app');
  const appConfig = getAppConfig();
  const adConfig = getAdBannerConfig();
  const categories = getActivityCategories();
  const profiles = getProfiles();
  let settings = getSettings();
  let activeBaby = profiles.find(p => p.id === settings.activeBabyId);

  // If activeBaby is not found, but profiles exist, select the first one
  if (!activeBaby && profiles.length > 0) {
    updateSetting('activeBabyId', profiles[0].id);
    settings = getSettings();
    activeBaby = profiles[0];
  }

  if (!activeBaby) {
    renderWelcome();
    return;
  }

  app.innerHTML = `
    <!-- Header -->
    <header class="header" id="header">
      <button class="header__menu-btn" id="menu-btn" aria-label="Menu">☰</button>
      <span class="header__title">
        <span class="header__title-main">Babylogs</span>
        <span class="header__title-sub">by Plotkai</span>
      </span>
      <div class="header__actions">
        <button class="header__action-btn header__sync-btn" id="header-sync-btn" aria-label="Cloud Sync Status" title="Cloud Sync">
        </button>
        <button class="header__action-btn" id="analytics-btn" aria-label="Summary & Analytics" title="Summary & Analytics">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="20" x2="18" y2="10"></line>
            <line x1="12" y1="20" x2="12" y2="4"></line>
            <line x1="6" y1="20" x2="6" y2="14"></line>
          </svg>
        </button>
      </div>
    </header>

    <div class="main-content">
      <!-- Ad Banner -->
      ${adConfig.enabled ? `
      <div class="ad-banner" id="ad-banner-slot">
        ${adConfig.adClient && adConfig.adSlotId ? `
          <ins class="adsbygoogle"
               style="display:block;height:50px;"
               data-ad-client="${adConfig.adClient}"
               data-ad-slot="${adConfig.adSlotId}"
               data-ad-format="horizontal"
               data-full-width-responsive="false"></ins>
        ` : (adConfig.placeholder || '')}
      </div>
      ` : ''}

      <!-- Baby Switcher with Inline Right Last Feed Timer -->
      <div class="baby-switcher" id="baby-switcher">
        <div class="baby-switcher__current" id="baby-switcher-toggle">
          <div class="baby-switcher__avatar">${activeBaby.name.charAt(0).toUpperCase()}</div>
          <div>
            <div class="baby-switcher__name">${activeBaby.name}</div>
            <div class="baby-switcher__age">${getAgeString(activeBaby.dob)} old</div>
          </div>
          <span class="baby-switcher__dropdown-icon" id="switcher-arrow">▼</span>
        </div>

        <!-- Last Feed Timer floating right -->
        <div class="last-feed-timer" id="last-feed-timer" title="Tap to log feed">
          <span class="last-feed-timer__icon">🍼</span>
          <span class="last-feed-timer__text">Last feed: </span>
          <span class="last-feed-timer__time" id="feed-timer-value">loading...</span>
        </div>
      </div>

      <!-- Date Navigator -->
      <div class="date-nav" id="date-nav">
        <button class="date-nav__btn" id="date-prev" aria-label="Previous day">◀</button>
        <span class="date-nav__label" id="date-label">
          ${formatDateDisplay(currentDate)}
          ${isToday(currentDate) ? '<span class="date-nav__today-badge">Today</span>' : ''}
          <input type="date" class="date-nav__hidden-input" id="date-picker" value="${formatDateKey(currentDate)}">
        </span>
        <button class="date-nav__btn" id="date-next" aria-label="Next day">▶</button>
      </div>

      <!-- Timeline Event Type Filter Bar -->
      <div class="timeline-filter-bar" id="timeline-filter-bar">
        <div class="timeline-filter-bar__wrap">
          <span class="timeline-filter-bar__icon">⚡</span>
          <select class="timeline-filter-bar__select" id="timeline-event-filter" aria-label="Filter activities by type">
            <option value="">All Activities</option>
            ${Object.entries(categories).map(([catKey, cat]) => `
              <optgroup label="${cat.icon} ${cat.label}">
                ${Object.entries(cat.types).map(([typeKey, type]) => `
                  <option value="${typeKey}" ${typeKey === currentEventFilter ? 'selected' : ''}>${type.emoji || ''} ${type.label}</option>
                `).join('')}
              </optgroup>
            `).join('')}
          </select>
        </div>
        <button class="timeline-filter-bar__clear ${currentEventFilter ? '' : 'hidden'}" id="timeline-filter-clear" aria-label="Clear filter" title="Clear filter">✕</button>
      </div>

      <!-- Timeline Filter Summary Card Slot -->
      <div id="timeline-filter-summary-slot"></div>

      <!-- Timeline -->
      <div class="timeline" id="timeline"></div>

      <!-- FAB -->
      <button class="fab" id="fab" aria-label="Add activity">＋</button>
    </div>

    <!-- Modal Overlay -->
    <div class="modal-overlay" id="modal-overlay">
      <div class="modal" id="modal">
        <div class="modal__drag-handle"></div>
        <div class="modal__header">
          <h2 class="modal__title" id="modal-title">Add Activity</h2>
          <button class="modal__close-btn" id="modal-close">✕</button>
        </div>
        <div class="modal__body" id="modal-body"></div>
        <div class="modal__footer" id="modal-footer"></div>
      </div>
    </div>

    <!-- Sidebar Overlay -->
    <div class="sidebar-overlay" id="sidebar-overlay">
      <nav class="sidebar" id="sidebar">
        <div class="sidebar__header">
          <div class="sidebar__app-name">
            <span class="sidebar__app-name-main">Babylogs</span>
            <span class="sidebar__app-name-sub">by Plotkai</span>
          </div>
          <div class="sidebar__app-version">v${appConfig.version}</div>
        </div>
        <div class="sidebar__nav" id="sidebar-nav"></div>
      </nav>
    </div>

    <!-- Confirm Dialog -->
    <div class="confirm-overlay" id="confirm-overlay">
      <div class="confirm-dialog" id="confirm-dialog"></div>
    </div>

    <!-- Toast -->
    <div class="toast" id="toast"></div>
  `;

  // Bind events
  bindMainEvents();

  // Load timeline
  await loadTimeline();

  // Start feed timer
  updateFeedTimer();
  feedTimerInterval = setInterval(updateFeedTimer, 30000); // every 30s

  // Start notifications
  const notifSettings = getSettings();
  if (notifSettings.notificationsEnabled) {
    startReminders(settings.activeBabyId);
  }

  // Render sidebar menu
  renderSidebar();

  // Initialize Google AdSense
  initAdBanner();
}

function initAdBanner() {
  try {
    const adEl = document.querySelector('#ad-banner-slot .adsbygoogle');
    if (adEl && !adEl.getAttribute('data-adsbygoogle-status')) {
      (window.adsbygoogle = window.adsbygoogle || []).push({});
    }
  } catch (err) {
    // Graceful fallback if blocked by adblocker / offline
    console.log('AdSense init info:', err);
  }
}

function bindMainEvents() {
  // Menu
  document.getElementById('menu-btn').addEventListener('click', openSidebar);
  document.getElementById('sidebar-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'sidebar-overlay') closeSidebar();
  });

  // Date navigation
  document.getElementById('date-prev').addEventListener('click', () => changeDate(-1));
  document.getElementById('date-next').addEventListener('click', () => changeDate(1));

  const dateLabel = document.getElementById('date-label');
  const datePicker = document.getElementById('date-picker');
  dateLabel.addEventListener('click', () => datePicker.showPicker?.() || datePicker.focus());
  datePicker.addEventListener('change', (e) => {
    currentDate = new Date(e.target.value + 'T12:00:00');
    loadTimeline();
    updateDateLabel();
  });

  // Timeline Event Filter
  const filterSelect = document.getElementById('timeline-event-filter');
  const filterClear = document.getElementById('timeline-filter-clear');
  if (filterSelect) {
    filterSelect.addEventListener('change', (e) => {
      currentEventFilter = e.target.value;
      if (filterClear) {
        if (currentEventFilter) {
          filterClear.classList.remove('hidden');
        } else {
          filterClear.classList.add('hidden');
        }
      }
      loadTimeline();
    });
  }
  if (filterClear) {
    filterClear.addEventListener('click', () => {
      currentEventFilter = '';
      if (filterSelect) filterSelect.value = '';
      filterClear.classList.add('hidden');
      loadTimeline();
    });
  }

  // FAB
  document.getElementById('fab').addEventListener('click', () => openActivityModal());

  // Modal close
  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('modal-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'modal-overlay') closeModal();
  });

  // Baby switcher
  document.getElementById('baby-switcher-toggle').addEventListener('click', toggleBabySwitcher);

  // Cloud Sync Status button
  document.getElementById('header-sync-btn')?.addEventListener('click', () => {
    openCollabModal();
  });
  updateHeaderSyncIndicator();

  // Analytics / Summary button
  document.getElementById('analytics-btn')?.addEventListener('click', renderSummary);

  // Last feed timer — tap to add feed
  document.getElementById('last-feed-timer').addEventListener('click', () => {
    openActivityModal(null, 'breast_feed');
  });
}

// ==================== DATE NAVIGATION ====================

function changeDate(delta) {
  currentDate.setDate(currentDate.getDate() + delta);
  loadTimeline();
  updateDateLabel();
}

function updateDateLabel() {
  const label = document.getElementById('date-label');
  if (!label) return;
  const picker = document.getElementById('date-picker');
  picker.value = formatDateKey(currentDate);
  label.innerHTML = `
    ${formatDateDisplay(currentDate)}
    ${isToday(currentDate) ? '<span class="date-nav__today-badge">Today</span>' : ''}
    <input type="date" class="date-nav__hidden-input" id="date-picker" value="${formatDateKey(currentDate)}">
  `;
  // Rebind picker
  const newPicker = document.getElementById('date-picker');
  label.addEventListener('click', () => newPicker.showPicker?.() || newPicker.focus());
  newPicker.addEventListener('change', (e) => {
    currentDate = new Date(e.target.value + 'T12:00:00');
    loadTimeline();
    updateDateLabel();
  });
}

// ==================== TIMELINE FILTER SUMMARY ====================

/**
 * Render a compact summary card when an activity filter is active on timeline
 */
function renderTimelineFilterSummary(activities, eventType) {
  const container = document.getElementById('timeline-filter-summary-slot');
  if (!container) return;

  if (!eventType || activities.length === 0) {
    container.innerHTML = '';
    return;
  }

  const typeConfig = getActivityType(eventType) || {};
  const settings = getSettings();
  const count = activities.length;

  let totalDurationMins = 0;
  let durations = [];
  let totalVolume = 0;
  let volumeUnit = settings.unit === 'imperial' ? 'oz' : 'ml';
  let hasVolume = false;

  // Diaper counts
  let wetCount = 0;
  let poopCount = 0;
  let dryCount = 0;

  // Breast feed counts
  let leftCount = 0;
  let rightCount = 0;
  let bothCount = 0;

  activities.forEach(act => {
    // Duration
    let dur = 0;
    if (act.duration !== undefined && act.duration !== null) {
      dur = Number(act.duration) || 0;
    } else if (act.startTime && act.endTime) {
      dur = Math.max(0, Math.round((new Date(act.endTime) - new Date(act.startTime)) / 60000));
    }
    if (dur > 0) {
      totalDurationMins += dur;
      durations.push(dur);
    }

    // Volume / Amount
    if (act.amount !== undefined && act.amount !== null && !isNaN(Number(act.amount))) {
      totalVolume += Number(act.amount);
      hasVolume = true;
    } else if (act.volume !== undefined && act.volume !== null && !isNaN(Number(act.volume))) {
      totalVolume += Number(act.volume);
      hasVolume = true;
    }

    // Breast feed sides
    if (act.side) {
      const s = String(act.side).toLowerCase();
      if (s === 'left') leftCount++;
      else if (s === 'right') rightCount++;
      else if (s === 'both') bothCount++;
    }

    // Diaper types
    if (act.diaperType) {
      const dt = Array.isArray(act.diaperType) ? act.diaperType : [act.diaperType];
      dt.forEach(t => {
        const lower = String(t).toLowerCase();
        if (lower.includes('wet')) wetCount++;
        if (lower.includes('soiled') || lower.includes('poop') || lower.includes('dirty') || lower.includes('bm')) poopCount++;
        if (lower.includes('dry')) dryCount++;
      });
    }
  });

  const avgDurationMins = durations.length > 0 ? Math.round(totalDurationMins / durations.length) : 0;
  const maxDurationMins = durations.length > 0 ? Math.max(...durations) : 0;

  let itemsHtml = '';
  let subHtml = '';

  if (eventType === 'sleep') {
    itemsHtml = `
      <div class="timeline-filter-summary__item">
        <div class="timeline-filter-summary__value">${count}</div>
        <div class="timeline-filter-summary__label">${count === 1 ? 'Nap' : 'Naps'}</div>
      </div>
      <div class="timeline-filter-summary__item">
        <div class="timeline-filter-summary__value">${formatDuration(totalDurationMins) || '0m'}</div>
        <div class="timeline-filter-summary__label">Total Sleep</div>
      </div>
      <div class="timeline-filter-summary__item">
        <div class="timeline-filter-summary__value">${formatDuration(avgDurationMins) || '0m'}</div>
        <div class="timeline-filter-summary__label">Avg / Nap</div>
      </div>
    `;
    if (maxDurationMins > 0) {
      subHtml = `
        <span>Longest nap: <strong>${formatDuration(maxDurationMins)}</strong></span>
        <span>Latest: <strong>${formatTime(activities[0].startTime)}</strong></span>
      `;
    }
  } else if (eventType === 'diaper') {
    itemsHtml = `
      <div class="timeline-filter-summary__item">
        <div class="timeline-filter-summary__value">${count}</div>
        <div class="timeline-filter-summary__label">Total Changes</div>
      </div>
      <div class="timeline-filter-summary__item">
        <div class="timeline-filter-summary__value" style="color: var(--color-secondary);">${wetCount}</div>
        <div class="timeline-filter-summary__label">💧 Wet</div>
      </div>
      <div class="timeline-filter-summary__item">
        <div class="timeline-filter-summary__value" style="color: var(--color-accent);">${poopCount}</div>
        <div class="timeline-filter-summary__label">💩 Poop</div>
      </div>
    `;
    if (dryCount > 0) {
      subHtml = `<span>Dry checks: <strong>${dryCount}</strong></span>`;
    }
  } else if (eventType === 'breast_feed') {
    itemsHtml = `
      <div class="timeline-filter-summary__item">
        <div class="timeline-filter-summary__value">${count}</div>
        <div class="timeline-filter-summary__label">${count === 1 ? 'Feed' : 'Feeds'}</div>
      </div>
      <div class="timeline-filter-summary__item">
        <div class="timeline-filter-summary__value">${formatDuration(totalDurationMins) || '0m'}</div>
        <div class="timeline-filter-summary__label">Total Nursing</div>
      </div>
      <div class="timeline-filter-summary__item">
        <div class="timeline-filter-summary__value">${formatDuration(avgDurationMins) || '0m'}</div>
        <div class="timeline-filter-summary__label">Avg / Feed</div>
      </div>
    `;
    if (leftCount > 0 || rightCount > 0 || bothCount > 0) {
      subHtml = `
        <span>Sides: <strong>L: ${leftCount}</strong> • <strong>R: ${rightCount}</strong>${bothCount ? ` • <strong>Both: ${bothCount}</strong>` : ''}</span>
      `;
    }
  } else if (eventType === 'bottle_feed') {
    const avgVol = count > 0 && hasVolume ? Math.round(totalVolume / count) : 0;
    itemsHtml = `
      <div class="timeline-filter-summary__item">
        <div class="timeline-filter-summary__value">${count}</div>
        <div class="timeline-filter-summary__label">${count === 1 ? 'Bottle' : 'Bottles'}</div>
      </div>
      <div class="timeline-filter-summary__item">
        <div class="timeline-filter-summary__value">${hasVolume ? `${totalVolume} <span style="font-size:11px;">${volumeUnit}</span>` : formatDuration(totalDurationMins)}</div>
        <div class="timeline-filter-summary__label">${hasVolume ? 'Total Volume' : 'Total Time'}</div>
      </div>
      <div class="timeline-filter-summary__item">
        <div class="timeline-filter-summary__value">${hasVolume ? `${avgVol} <span style="font-size:11px;">${volumeUnit}</span>` : formatDuration(avgDurationMins)}</div>
        <div class="timeline-filter-summary__label">${hasVolume ? 'Avg / Bottle' : 'Avg Time'}</div>
      </div>
    `;
  } else if (eventType === 'pumping') {
    itemsHtml = `
      <div class="timeline-filter-summary__item">
        <div class="timeline-filter-summary__value">${count}</div>
        <div class="timeline-filter-summary__label">Sessions</div>
      </div>
      <div class="timeline-filter-summary__item">
        <div class="timeline-filter-summary__value">${hasVolume ? `${totalVolume} <span style="font-size:11px;">${volumeUnit}</span>` : formatDuration(totalDurationMins)}</div>
        <div class="timeline-filter-summary__label">${hasVolume ? 'Total Pumped' : 'Total Time'}</div>
      </div>
      <div class="timeline-filter-summary__item">
        <div class="timeline-filter-summary__value">${formatDuration(totalDurationMins) || '0m'}</div>
        <div class="timeline-filter-summary__label">Duration</div>
      </div>
    `;
  } else if (totalDurationMins > 0) {
    itemsHtml = `
      <div class="timeline-filter-summary__item">
        <div class="timeline-filter-summary__value">${count}</div>
        <div class="timeline-filter-summary__label">Sessions</div>
      </div>
      <div class="timeline-filter-summary__item">
        <div class="timeline-filter-summary__value">${formatDuration(totalDurationMins)}</div>
        <div class="timeline-filter-summary__label">Total Time</div>
      </div>
      <div class="timeline-filter-summary__item">
        <div class="timeline-filter-summary__value">${formatDuration(avgDurationMins)}</div>
        <div class="timeline-filter-summary__label">Avg / Session</div>
      </div>
    `;
  } else {
    itemsHtml = `
      <div class="timeline-filter-summary__item">
        <div class="timeline-filter-summary__value">${count}</div>
        <div class="timeline-filter-summary__label">Total Entries</div>
      </div>
      <div class="timeline-filter-summary__item">
        <div class="timeline-filter-summary__value">${formatTime(activities[0].startTime)}</div>
        <div class="timeline-filter-summary__label">Latest Entry</div>
      </div>
    `;
  }

  container.innerHTML = `
    <div class="timeline-filter-summary">
      <div class="timeline-filter-summary__header">
        <span class="timeline-filter-summary__title">
          <span>${typeConfig.emoji || '⚡'}</span>
          <span>${typeConfig.label || 'Activity'} Daily Summary</span>
        </span>
        <span class="timeline-filter-summary__badge">${count} logged</span>
      </div>
      <div class="timeline-filter-summary__grid">
        ${itemsHtml}
      </div>
      ${subHtml ? `<div class="timeline-filter-summary__sub">${subHtml}</div>` : ''}
    </div>
  `;
}

// ==================== TIMELINE ====================

async function loadTimeline() {
  const settings = getSettings();
  const dateKey = formatDateKey(currentDate);
  currentActivities = await getActivitiesByDate(settings.activeBabyId, dateKey);

  const timeline = document.getElementById('timeline');
  if (!timeline) return;

  if (currentActivities.length === 0) {
    renderTimelineFilterSummary([], '');
    timeline.innerHTML = `
      <div class="timeline__empty">
        <div class="timeline__empty-icon">📝</div>
        <div class="timeline__empty-text">No activities logged</div>
        <div class="timeline__empty-hint">Tap the + button to add your first entry</div>
      </div>
    `;
    const fab = document.getElementById('fab');
    if (fab) fab.classList.add('fab--pulse');
    return;
  }

  const fab = document.getElementById('fab');
  if (fab) fab.classList.remove('fab--pulse');

  // Sort activities based on timelineSortOrder setting ('asc' or 'desc', defaults to 'desc')
  const sortOrder = settings.timelineSortOrder || 'desc';
  currentActivities.sort((a, b) => {
    const timeA = new Date(a.startTime).getTime();
    const timeB = new Date(b.startTime).getTime();
    return sortOrder === 'asc' ? (timeA - timeB) : (timeB - timeA);
  });

  // Filter activities if an event filter is active
  const displayActivities = currentEventFilter
    ? currentActivities.filter(a => a.eventType === currentEventFilter)
    : currentActivities;

  // Render or clear the filter summary card
  renderTimelineFilterSummary(displayActivities, currentEventFilter);

  if (displayActivities.length === 0) {
    const typeConfig = getActivityType(currentEventFilter) || {};
    timeline.innerHTML = `
      <div class="timeline__empty">
        <div class="timeline__empty-icon">${typeConfig.emoji || '🔍'}</div>
        <div class="timeline__empty-text">No ${typeConfig.label || 'matching'} activities</div>
        <div class="timeline__empty-hint">No ${typeConfig.label || ''} entries logged for this date</div>
        <button class="btn btn--secondary btn--sm" id="timeline-empty-clear-btn" style="margin-top: 14px;">Show All Activities</button>
      </div>
    `;
    document.getElementById('timeline-empty-clear-btn')?.addEventListener('click', () => {
      currentEventFilter = '';
      const filterSelect = document.getElementById('timeline-event-filter');
      if (filterSelect) filterSelect.value = '';
      document.getElementById('timeline-filter-clear')?.classList.add('hidden');
      loadTimeline();
    });
    return;
  }

  const allTypes = getAllActivityTypes();
  const gapThreshold = Number(settings.timelineGapThreshold !== undefined ? settings.timelineGapThreshold : 15);

  // Chronological sort for calculating gaps
  const chronological = [...displayActivities].sort((a, b) => {
    return new Date(a.startTime).getTime() - new Date(b.startTime).getTime();
  });

  const now = new Date();
  const viewingToday = isToday(currentDate);
  const timelineItems = [];

  if (gapThreshold > 0 && !currentEventFilter) {
    for (let i = 0; i < chronological.length; i++) {
      const act = chronological[i];
      timelineItems.push({ type: 'activity', data: act });

      const actEndTime = act.endTime
        ? new Date(act.endTime).getTime()
        : (act.duration > 0
          ? calculateEndTime(act.startTime, act.duration).getTime()
          : new Date(act.startTime).getTime());

      if (i < chronological.length - 1) {
        const nextAct = chronological[i + 1];
        const nextStartTime = new Date(nextAct.startTime).getTime();

        const gapMs = nextStartTime - actEndTime;
        const gapMinutes = Math.floor(gapMs / (60 * 1000));

        if (gapMinutes >= gapThreshold) {
          timelineItems.push({
            type: 'gap',
            start: new Date(actEndTime),
            end: new Date(nextStartTime),
            duration: gapMinutes,
            isOngoing: false
          });
        }
      } else if (viewingToday && i === chronological.length - 1) {
        // Gap from last activity today up to NOW (current time) — never beyond current time
        const nowTime = now.getTime();
        const gapMs = nowTime - actEndTime;
        const gapMinutes = Math.floor(gapMs / (60 * 1000));

        if (gapMinutes >= gapThreshold) {
          timelineItems.push({
            type: 'gap',
            start: new Date(actEndTime),
            end: now,
            duration: gapMinutes,
            isOngoing: true
          });
        }
      }
    }
  } else {
    chronological.forEach(act => {
      timelineItems.push({ type: 'activity', data: act });
    });
  }

  // Reverse if descending
  if (sortOrder === 'desc') {
    timelineItems.reverse();
  }

  function formatActivityTags(activity) {
    if (!activity.subFields) return '';
    const tags = [];
    for (const [k, v] of Object.entries(activity.subFields)) {
      if (v === true) {
        tags.push(k === 'diaperChange' ? 'Diaper Changed' : k);
      } else if (typeof v === 'string' && v.trim()) {
        tags.push(v);
      } else if (typeof v === 'number') {
        tags.push(`${v}`);
      } else if (Array.isArray(v) && v.length > 0) {
        tags.push(...v);
      }
    }
    if (tags.length === 0) return '';
    return `
      <div class="activity-card__tags">
        ${tags.map(t => `<span class="activity-card__tag">${t}</span>`).join('')}
      </div>
    `;
  }

  function formatTimeColumn(activity, sortOrder) {
    const startDate = new Date(activity.startTime);
    const startTimeStr = !isNaN(startDate.getTime()) ? formatTime(startDate) : '';
    const endDate = activity.endTime
      ? new Date(activity.endTime)
      : (activity.duration > 0 ? calculateEndTime(activity.startTime, activity.duration) : null);
    const endTimeStr = endDate && !isNaN(endDate.getTime()) ? formatTime(endDate) : '';
    const durationMins = activity.duration || 0;
    const durationStr = durationMins > 0 ? (formatDuration(durationMins) || `${durationMins}m`) : '';

    if (durationMins > 0 && endTimeStr && endTimeStr !== startTimeStr) {
      const topTime = sortOrder === 'desc' ? endTimeStr : startTimeStr;
      const bottomTime = sortOrder === 'desc' ? startTimeStr : endTimeStr;

      return `
        <div class="activity-card__right" title="${startTimeStr} – ${endTimeStr} (${durationStr})">
          <span class="activity-card__duration">${durationStr}</span>
          <div class="activity-card__times">
            <span class="activity-card__time-slot">${topTime}</span>
            <span class="activity-card__time-colon">:</span>
            <span class="activity-card__time-slot">${bottomTime}</span>
          </div>
        </div>
      `;
    }

    // Single point-in-time / instant event
    return `
      <div class="activity-card__right">
        <div class="activity-card__times activity-card__times--single">
          <span class="activity-card__time-slot activity-card__time-slot--single">${startTimeStr}</span>
        </div>
      </div>
    `;
  }

  timeline.innerHTML = timelineItems.map((item, i) => {
    if (item.type === 'gap') {
      const gapStartIso = `${formatDateKey(item.start)}T${String(item.start.getHours()).padStart(2, '0')}:${String(item.start.getMinutes()).padStart(2, '0')}`;
      return `
        <div class="timeline-gap" style="animation-delay: ${i * 0.03}s;">
          <div class="timeline-gap__stem">
            <div class="timeline-gap__line"></div>
            <div class="timeline-gap__dot">⏳</div>
            <div class="timeline-gap__line"></div>
          </div>
          <div class="timeline-gap__card ${item.isOngoing ? 'timeline-gap__card--ongoing' : ''}">
            <div class="timeline-gap__info">
              <div class="timeline-gap__title">
                <span class="timeline-gap__badge ${item.isOngoing ? 'timeline-gap__badge--ongoing' : ''}">
                  ${item.isOngoing ? 'Active Gap' : 'Gap'}
                </span>
                <span>${formatDuration(item.duration)} inactive</span>
              </div>
              <div class="timeline-gap__times">
                ${formatTime(item.start)} – ${item.isOngoing ? 'Now' : formatTime(item.end)}
              </div>
            </div>
            <button class="timeline-gap__btn btn-log-gap" data-time="${gapStartIso}" title="Add activity during this gap">
              ＋ Log Activity
            </button>
          </div>
        </div>
      `;
    }

    const activity = item.data;
    const typeConfig = allTypes[activity.eventType] || {};
    const titleText = typeConfig.label || activity.eventType;

    return `
      <div class="activity-card" data-id="${activity.id}" style="border-left-color: ${typeConfig.color || 'var(--color-primary)'}; animation-delay: ${i * 0.04}s;">
        <div class="activity-card__avatar">${typeConfig.emoji || '📋'}</div>
        <div class="activity-card__body">
          <div class="activity-card__title">${titleText}</div>
          ${formatActivityTags(activity)}
          ${activity.notes ? `<div class="activity-card__notes">💬 ${activity.notes}</div>` : ''}
        </div>
        ${formatTimeColumn(activity, sortOrder)}
      </div>
    `;
  }).join('');

  // Bind card tap events
  timeline.querySelectorAll('.activity-card').forEach(card => {
    card.addEventListener('click', () => {
      const id = card.dataset.id;
      const activity = currentActivities.find(a => a.id === id);
      if (activity) openActivityModal(activity);
    });

    // Long press for delete
    let pressTimer;
    card.addEventListener('touchstart', (e) => {
      pressTimer = setTimeout(() => {
        const id = card.dataset.id;
        const activity = currentActivities.find(a => a.id === id);
        if (activity) confirmDeleteActivity(activity);
      }, 600);
    }, { passive: true });
    card.addEventListener('touchend', () => clearTimeout(pressTimer));
    card.addEventListener('touchmove', () => clearTimeout(pressTimer));
  });

  // Bind gap button clicks
  timeline.querySelectorAll('.btn-log-gap').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const presetTime = btn.dataset.time;
      openActivityModal(null, '', presetTime);
    });
  });
}

// ==================== FEED TIMER ====================

async function updateFeedTimer() {
  const settings = getSettings();
  const timerEl = document.getElementById('feed-timer-value');
  const timerContainer = document.getElementById('last-feed-timer');
  if (!timerEl || !timerContainer) return;

  const elapsed = await getLastFeedElapsed(settings.activeBabyId);
  if (!elapsed) {
    timerEl.textContent = 'No feeds yet';
    timerContainer.className = 'last-feed-timer';
    return;
  }

  timerEl.textContent = elapsed.text;
  timerContainer.className = `last-feed-timer last-feed-timer--${elapsed.level}`;
}

// ==================== ACTIVITY MODAL ====================

function openActivityModal(activity = null, presetType = '', presetStartTime = '') {
  editingActivity = activity;
  const overlay = document.getElementById('modal-overlay');
  const title = document.getElementById('modal-title');
  const body = document.getElementById('modal-body');
  const footer = document.getElementById('modal-footer');

  title.textContent = activity ? 'Edit Activity' : 'Add Activity';

  const categories = getActivityCategories();
  const settings = getSettings();
  const now = new Date();
  const currentTimeStr = activity
    ? activity.startTime.slice(0, 16)
    : (presetStartTime || `${formatDateKey(currentDate)}T${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`);

  let selectedType = activity ? activity.eventType : (presetType || 'breast_feed');

  // Find which category contains selectedType (default to 'feeding')
  let selectedCategory = 'feeding';
  for (const [catKey, cat] of Object.entries(categories)) {
    if (cat.types && cat.types[selectedType]) {
      selectedCategory = catKey;
      break;
    }
  }

  const initialDuration = activity
    ? (activity.duration ?? 0)
    : (selectedType ? (getActivityDefaultDuration(selectedType, settings) ?? 15) : 15);

  body.innerHTML = `
    <div class="form-group__row">
      <div class="form-group">
        <label class="form-group__label">Date</label>
        <input type="date" class="form-group__input" id="modal-date" value="${activity ? activity.date : formatDateKey(currentDate)}">
      </div>
      <div class="form-group">
        <label class="form-group__label">Time</label>
        <input type="time" class="form-group__input" id="modal-time" value="${currentTimeStr.split('T')[1] || ''}">
      </div>
    </div>

    <div class="form-group">
      <label class="form-group__label">Event Type</label>
      <input type="hidden" id="modal-event-type" value="${selectedType}">
      
      <!-- 4 Category inline buttons -->
      <div class="event-category-tabs" id="event-category-tabs">
        ${Object.entries(categories).map(([catKey, cat]) => `
          <button type="button" class="event-category-tab ${catKey === selectedCategory ? 'active' : ''}" data-category="${catKey}">
            <span class="event-category-tab__icon">${cat.icon}</span>
            <span class="event-category-tab__label">
              ${cat.label} <span class="event-category-tab__arrow">▾</span>
            </span>
          </button>
        `).join('')}
      </div>

      <!-- Dropdown Selector Menu (anchored directly below category buttons) -->
      <div class="event-dropdown-menu hidden" id="event-dropdown-menu">
        <div class="event-dropdown-header">
          <span id="dropdown-category-title">Options</span>
          <span style="font-size: 11px; cursor: pointer; color: var(--color-text-muted);" id="btn-close-dropdown">✕ Close</span>
        </div>
        <div id="event-dropdown-items"></div>
      </div>

      <!-- Selected Event Card Trigger -->
      <div class="selected-event-display" id="selected-event-display">
        <div class="selected-event-info">
          <span class="selected-event-emoji" id="selected-event-emoji"></span>
          <div>
            <div class="selected-event-name" id="selected-event-name"></div>
            <div style="font-size: 11px; color: var(--color-text-secondary);" id="selected-event-category"></div>
          </div>
        </div>
        <button type="button" class="selected-event-badge" id="selected-event-badge">Change ▾</button>
      </div>
    </div>

    <!-- Duration Slider & Controls -->
    <div class="form-group">
      <div class="duration-control-card">
        <div class="duration-control-header">
          <label class="form-group__label" style="margin-bottom: 0;">Duration</label>
          <div class="duration-input-wrap">
            <input type="number" class="duration-number-input" id="modal-duration-number" min="0" max="720" value="${initialDuration}" placeholder="0">
            <span class="duration-input-unit">min</span>
          </div>
        </div>
        <div class="duration-slider-row">
          <button type="button" class="duration-step-btn" id="btn-duration-minus" title="Decrease 5 min">− 5m</button>
          <div class="duration-slider-container">
            <input type="range" class="duration-slider" id="modal-duration-slider" min="0" max="360" step="1" value="${initialDuration}">
            <input type="hidden" id="modal-duration" value="${initialDuration}">
          </div>
          <button type="button" class="duration-step-btn" id="btn-duration-plus" title="Increase 5 min">＋ 5m</button>
        </div>
        <div class="duration-time-subtext" id="duration-time-subtext"></div>
      </div>
    </div>

    <div id="dynamic-fields"></div>

    <div class="form-group">
      <label class="form-group__label">Notes</label>
      <textarea class="form-group__textarea" id="modal-notes" placeholder="Optional notes...">${activity?.notes || ''}</textarea>
    </div>
  `;

  // Footer buttons
  footer.innerHTML = `
    ${activity ? '<button class="btn btn--danger btn--sm" id="modal-delete">🗑 Delete</button>' : ''}
    <button class="btn btn--secondary" id="modal-cancel">Cancel</button>
    <button class="btn btn--primary" id="modal-save">${activity ? 'Update' : 'Add'}</button>
  `;

  // Show modal
  overlay.classList.add('active');

  let activeDropdownCategory = null;

  function updateSelectedEventCard(typeKey) {
    const typeConfig = getActivityType(typeKey);
    if (!typeConfig) return;

    document.getElementById('selected-event-emoji').textContent = typeConfig.emoji || '📝';
    document.getElementById('selected-event-name').textContent = typeConfig.label;
    document.getElementById('selected-event-category').textContent = `${typeConfig.categoryIcon || ''} ${typeConfig.categoryLabel || ''} Category`;

    // Update active category tab
    selectedCategory = typeConfig.category || 'feeding';
    document.querySelectorAll('.event-category-tab').forEach(t => {
      t.classList.toggle('active', t.dataset.category === selectedCategory);
    });
  }

  function openCategoryDropdown(catKey) {
    const dropdown = document.getElementById('event-dropdown-menu');
    const itemsContainer = document.getElementById('event-dropdown-items');
    const headerTitle = document.getElementById('dropdown-category-title');
    if (!dropdown || !itemsContainer || !categories[catKey]) return;

    activeDropdownCategory = catKey;
    headerTitle.textContent = `${categories[catKey].icon} ${categories[catKey].label} Activities`;

    // Mark tab open
    document.querySelectorAll('.event-category-tab').forEach(t => {
      t.classList.toggle('open', t.dataset.category === catKey);
    });

    const types = categories[catKey].types || {};
    itemsContainer.innerHTML = Object.entries(types).map(([typeKey, type]) => {
      const isSelected = typeKey === selectedType;
      const defDur = getActivityDefaultDuration(typeKey, settings);
      return `
        <div class="event-dropdown-item ${isSelected ? 'selected' : ''}" data-type="${typeKey}">
          <div class="event-dropdown-item__main">
            <span class="event-dropdown-item__emoji">${type.emoji || '📝'}</span>
            <span class="event-dropdown-item__label">${type.label}</span>
          </div>
          <div class="event-dropdown-item__meta">
            <span style="font-size: 11px;">⏱ ${defDur}m</span>
            ${isSelected ? '<span class="event-dropdown-item__check">✓</span>' : ''}
          </div>
        </div>
      `;
    }).join('');

    dropdown.classList.remove('hidden');

    // Bind dropdown item clicks
    itemsContainer.querySelectorAll('.event-dropdown-item').forEach(item => {
      item.addEventListener('click', () => {
        const typeKey = item.dataset.type;
        selectedType = typeKey;
        document.getElementById('modal-event-type').value = typeKey;
        updateSelectedEventCard(typeKey);
        closeCategoryDropdown();

        renderDynamicFields(typeKey);

        if (!activity) {
          const defDur = getActivityDefaultDuration(typeKey, getSettings());
          updateDurationDisplay(defDur);
        }
      });
    });
  }

  function closeCategoryDropdown() {
    activeDropdownCategory = null;
    const dropdown = document.getElementById('event-dropdown-menu');
    if (dropdown) dropdown.classList.add('hidden');
    document.querySelectorAll('.event-category-tab').forEach(t => t.classList.remove('open'));
  }

  // Helper to update duration & end time
  function updateDurationDisplay(mins, syncNumberInput = true) {
    const clampedMins = Math.max(0, parseInt(mins) || 0);
    const durationInput = document.getElementById('modal-duration');
    const slider = document.getElementById('modal-duration-slider');
    const numberInput = document.getElementById('modal-duration-number');
    const subtext = document.getElementById('duration-time-subtext');

    if (durationInput) durationInput.value = clampedMins;
    if (slider) slider.value = Math.min(360, clampedMins);
    if (numberInput && syncNumberInput) {
      numberInput.value = clampedMins;
    }

    if (subtext) {
      const dateVal = document.getElementById('modal-date')?.value || formatDateKey(new Date());
      const timeVal = document.getElementById('modal-time')?.value || '00:00';
      const startIso = `${dateVal}T${timeVal}`;
      const startDate = new Date(startIso);
      const startFormatted = !isNaN(startDate.getTime()) ? formatTime(startDate) : timeVal;

      if (clampedMins > 0 && !isNaN(startDate.getTime())) {
        const endDate = calculateEndTime(startIso, clampedMins);
        const endFormatted = formatTime(endDate);
        subtext.innerHTML = `<span>Starts <strong>${startFormatted}</strong></span> <span>→</span> <span>Ends <strong>${endFormatted}</strong> (${formatDuration(clampedMins)})</span>`;
      } else {
        subtext.innerHTML = `<span>Time <strong>${startFormatted}</strong></span> <span>•</span> <span><em>Point in time log</em></span>`;
      }
    }
  }

  // Category tab clicks
  document.querySelectorAll('.event-category-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const catKey = tab.dataset.category;
      if (activeDropdownCategory === catKey) {
        closeCategoryDropdown();
      } else {
        openCategoryDropdown(catKey);
      }
    });
  });

  // Selected event display card click
  document.getElementById('selected-event-display')?.addEventListener('click', () => {
    if (activeDropdownCategory === selectedCategory) {
      closeCategoryDropdown();
    } else {
      openCategoryDropdown(selectedCategory);
    }
  });

  // Close dropdown button
  document.getElementById('btn-close-dropdown')?.addEventListener('click', closeCategoryDropdown);

  // Initial setup
  updateSelectedEventCard(selectedType);
  if (selectedType) {
    renderDynamicFields(selectedType, activity?.subFields);
  }
  updateDurationDisplay(initialDuration, true);

  // Duration direct number input
  document.getElementById('modal-duration-number')?.addEventListener('input', (e) => {
    const val = parseInt(e.target.value) || 0;
    updateDurationDisplay(val, false);
  });
  document.getElementById('modal-duration-number')?.addEventListener('blur', (e) => {
    const val = Math.max(0, parseInt(e.target.value) || 0);
    updateDurationDisplay(val, true);
  });

  // Duration Slider & +/- 5m buttons
  document.getElementById('modal-duration-slider')?.addEventListener('input', (e) => {
    updateDurationDisplay(parseInt(e.target.value) || 0, true);
  });

  document.getElementById('btn-duration-minus')?.addEventListener('click', () => {
    const current = parseInt(document.getElementById('modal-duration')?.value) || 0;
    updateDurationDisplay(Math.max(0, current - 5), true);
  });

  document.getElementById('btn-duration-plus')?.addEventListener('click', () => {
    const current = parseInt(document.getElementById('modal-duration')?.value) || 0;
    updateDurationDisplay(current + 5, true);
  });

  // Recalculate end time when date or time changes
  document.getElementById('modal-date')?.addEventListener('change', () => {
    const current = parseInt(document.getElementById('modal-duration')?.value) || 0;
    updateDurationDisplay(current, true);
  });
  document.getElementById('modal-time')?.addEventListener('change', () => {
    const current = parseInt(document.getElementById('modal-duration')?.value) || 0;
    updateDurationDisplay(current, true);
  });

  // Save
  document.getElementById('modal-save').addEventListener('click', saveActivity);

  // Cancel
  document.getElementById('modal-cancel').addEventListener('click', closeModal);

  // Delete
  const deleteBtn = document.getElementById('modal-delete');
  if (deleteBtn) {
    deleteBtn.addEventListener('click', () => {
      closeModal();
      confirmDeleteActivity(activity);
    });
  }
}

function renderDynamicFields(eventType, existingValues = {}) {
  const container = document.getElementById('dynamic-fields');
  if (!container) return;

  if (!eventType) {
    container.innerHTML = '';
    return;
  }

  const typeConfig = getActivityType(eventType);
  if (!typeConfig || !typeConfig.fields || typeConfig.fields.length === 0) {
    container.innerHTML = '';
    return;
  }

  const settings = getSettings();

  container.innerHTML = typeConfig.fields.map(field => {
    const value = existingValues?.[field.key] || '';

    if (field.type === 'select') {
      return `
        <div class="form-group">
          <label class="form-group__label">${field.label}${field.required ? ' *' : ''}</label>
          <select class="form-group__select dynamic-field" data-key="${field.key}" ${field.required ? 'required' : ''}>
            <option value="">Select...</option>
            ${field.options.map(opt => `<option value="${opt}" ${opt === value ? 'selected' : ''}>${opt}</option>`).join('')}
          </select>
        </div>
      `;
    }

    if (field.type === 'multi-select') {
      const selectedValues = Array.isArray(value) ? value : (value ? [value] : []);
      return `
        <div class="form-group">
          <label class="form-group__label">${field.label}${field.required ? ' *' : ''}</label>
          <div class="multi-select" data-key="${field.key}">
            ${field.options.map(opt => `
              <span class="multi-select__chip ${selectedValues.includes(opt) ? 'selected' : ''}" data-value="${opt}">${opt}</span>
            `).join('')}
          </div>
        </div>
      `;
    }

    if (field.type === 'number') {
      const unitLabel = field.unit ? ` (${settings.unit?.[field.unit] || ''})` : '';
      return `
        <div class="form-group">
          <label class="form-group__label">${field.label}${unitLabel}${field.required ? ' *' : ''}</label>
          <input type="number" class="form-group__input dynamic-field" data-key="${field.key}" placeholder="Enter value" min="0" step="any" value="${value}" ${field.required ? 'required' : ''}>
        </div>
      `;
    }

    if (field.type === 'checkbox') {
      const isChecked = (value !== undefined && value !== '')
        ? Boolean(value)
        : (field.default !== undefined ? Boolean(field.default) : false);
      return `
        <div class="form-group form-group--checkbox">
          <label class="checkbox-container">
            <input type="checkbox" class="dynamic-checkbox" data-key="${field.key}" ${isChecked ? 'checked' : ''}>
            <span class="checkbox-custom"></span>
            <span class="checkbox-text">${field.label}</span>
          </label>
        </div>
      `;
    }

    // Default: text input
    return `
      <div class="form-group">
        <label class="form-group__label">${field.label}${field.required ? ' *' : ''}</label>
        <input type="text" class="form-group__input dynamic-field" data-key="${field.key}" placeholder="Enter ${field.label.toLowerCase()}" value="${value}" ${field.required ? 'required' : ''}>
      </div>
    `;
  }).join('');

  // Bind multi-select chip clicks
  container.querySelectorAll('.multi-select__chip').forEach(chip => {
    chip.addEventListener('click', () => {
      chip.classList.toggle('selected');
    });
  });
}

async function saveActivity() {
  const eventType = document.getElementById('modal-event-type').value;
  if (!eventType) {
    showToast('Please select an event type');
    return;
  }

  const date = document.getElementById('modal-date').value;
  const time = document.getElementById('modal-time').value;
  const duration = parseInt(document.getElementById('modal-duration').value) || 0;
  const notes = document.getElementById('modal-notes').value.trim();

  const startTime = `${date}T${time}`;
  const endTime = duration > 0 ? calculateEndTime(startTime, duration).toISOString() : '';

  // Collect dynamic sub-fields
  const subFields = {};
  document.querySelectorAll('.dynamic-field').forEach(el => {
    const key = el.dataset.key;
    subFields[key] = el.value;
  });
  document.querySelectorAll('.dynamic-checkbox').forEach(el => {
    const key = el.dataset.key;
    subFields[key] = el.checked;
  });
  document.querySelectorAll('.multi-select').forEach(el => {
    const key = el.dataset.key;
    const selected = [...el.querySelectorAll('.multi-select__chip.selected')].map(c => c.dataset.value);
    subFields[key] = selected;
  });

  // Check required fields
  const typeConfig = getActivityType(eventType);
  if (typeConfig?.fields) {
    for (const field of typeConfig.fields) {
      if (field.required) {
        const val = subFields[field.key];
        if (!val || (Array.isArray(val) && val.length === 0)) {
          showToast(`${field.label} is required`);
          return;
        }
      }
    }
  }

  const settings = getSettings();
  const displayText = buildDisplayText(typeConfig, subFields, {
    volume: { current: settings.unit?.volume, default: 'ml' },
    weight: { current: settings.unit?.weight, default: 'kg' },
    temperature: { current: settings.unit?.temperature, default: '°F' }
  });

  const entry = {
    id: editingActivity?.id || generateId(),
    babyId: settings.activeBabyId,
    date,
    startTime,
    duration,
    endTime,
    eventType,
    subFields,
    notes,
    displayText,
    createdAt: editingActivity?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  try {
    if (editingActivity) {
      await updateActivity(entry);
      showToast('Activity updated ✓');
      trackActivityLogged(eventType, true);
    } else {
      await addActivity(entry);
      showToast('Activity added ✓');
      trackActivityLogged(eventType, false);
    }

    // Auto-sync in background to Google Drive
    driveSync.queueSync();

    closeModal();
    await loadTimeline();
    updateFeedTimer();
  } catch (err) {
    console.error('Save error:', err);
    showToast('Failed to save activity');
  }
}

function confirmDeleteActivity(activity) {
  showConfirm(
    'Delete Activity',
    `Are you sure you want to delete this ${activity.displayText || 'activity'}?`,
    async () => {
      try {
        await deleteActivity(activity.id);
        driveSync.queueSync();
        showToast('Activity deleted');
        await loadTimeline();
        updateFeedTimer();
      } catch (err) {
        showToast('Failed to delete');
      }
    }
  );
}

function closeModal() {
  const overlay = document.getElementById('modal-overlay');
  if (overlay) overlay.classList.remove('active');
  editingActivity = null;
}

// ==================== BABY SWITCHER ====================

function toggleBabySwitcher() {
  babySwitcherOpen = !babySwitcherOpen;
  const arrow = document.getElementById('switcher-arrow');
  const existingDropdown = document.querySelector('.baby-switcher__dropdown');

  if (existingDropdown) {
    existingDropdown.remove();
    if (arrow) arrow.classList.remove('open');
    babySwitcherOpen = false;
    return;
  }

  if (arrow) arrow.classList.add('open');

  const profiles = getProfiles();
  const settings = getSettings();
  const switcher = document.getElementById('baby-switcher');

  const dropdown = document.createElement('div');
  dropdown.className = 'baby-switcher__dropdown';
  dropdown.innerHTML = `
    ${profiles.map(p => `
      <div class="baby-switcher__dropdown-item ${p.id === settings.activeBabyId ? 'active' : ''}" data-id="${p.id}">
        <div class="baby-switcher__avatar" style="width:28px;height:28px;font-size:14px;">${p.name.charAt(0).toUpperCase()}</div>
        <span>${p.name}</span>
      </div>
    `).join('')}
    <div class="baby-switcher__dropdown-item add-baby" id="add-baby-btn">
      <span style="font-size:18px;">＋</span>
      <span>Add Baby</span>
    </div>
  `;

  switcher.appendChild(dropdown);

  // Bind switch actions
  dropdown.querySelectorAll('[data-id]').forEach(item => {
    item.addEventListener('click', () => {
      updateSetting('activeBabyId', item.dataset.id);
      babySwitcherOpen = false;
      renderMain();
    });
  });

  document.getElementById('add-baby-btn')?.addEventListener('click', () => {
    babySwitcherOpen = false;
    dropdown.remove();
    openAddBabyModal();
  });

  // Close on outside click
  setTimeout(() => {
    const closeHandler = (e) => {
      if (!dropdown.contains(e.target) && e.target.id !== 'baby-switcher-toggle') {
        dropdown.remove();
        if (arrow) arrow.classList.remove('open');
        babySwitcherOpen = false;
        document.removeEventListener('click', closeHandler);
      }
    };
    document.addEventListener('click', closeHandler);
  }, 10);
}

function openAddBabyModal() {
  const overlay = document.getElementById('modal-overlay');
  const title = document.getElementById('modal-title');
  const body = document.getElementById('modal-body');
  const footer = document.getElementById('modal-footer');

  title.textContent = 'Add Baby';
  body.innerHTML = `
    <div class="form-group">
      <label class="form-group__label">Baby's Name</label>
      <input type="text" class="form-group__input" id="add-baby-name" placeholder="Enter name" required>
    </div>
    <div class="form-group">
      <label class="form-group__label">Date of Birth</label>
      <input type="date" class="form-group__input" id="add-baby-dob" required max="${formatDateKey(new Date())}" value="${formatDateKey(new Date())}">
    </div>
  `;

  footer.innerHTML = `
    <button class="btn btn--secondary" id="modal-cancel">Cancel</button>
    <button class="btn btn--primary" id="add-baby-save">Add Baby</button>
  `;

  overlay.classList.add('active');

  document.getElementById('modal-cancel').addEventListener('click', closeModal);
  document.getElementById('add-baby-save').addEventListener('click', () => {
    const name = document.getElementById('add-baby-name').value.trim();
    const dob = document.getElementById('add-baby-dob').value;
    if (!name || !dob) { showToast('Please fill all fields'); return; }

    const profile = { id: generateId(), name, dob, createdAt: new Date().toISOString() };
    addProfile(profile);
    updateSetting('activeBabyId', profile.id);
    driveSync.queueSync();
    closeModal();
    if (currentView === 'manage-babies') {
      renderManageBabies();
    } else {
      renderMain();
    }
    showToast(`${name} added! 👶`);
  });
}

// ==================== SIDEBAR ====================

function renderSidebar() {
  const nav = document.getElementById('sidebar-nav');
  if (!nav) return;

  const isInstallable = !!deferredInstallPrompt;
  const isPWA = window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true;

  nav.innerHTML = `
    <button class="sidebar__item" id="nav-summary">
      <span class="sidebar__item-icon">📊</span> Summary
    </button>
    <button class="sidebar__item" id="nav-manage-babies">
      <span class="sidebar__item-icon">👶</span> Manage Babies
    </button>
    <button class="sidebar__item" id="nav-settings">
      <span class="sidebar__item-icon">⚙️</span> Settings
    </button>
    <div class="sidebar__divider"></div>
    <button class="sidebar__item" id="nav-collab" style="color: var(--color-primary); font-weight: 600;">
      <span class="sidebar__item-icon">👥</span> Collaborate
    </button>
    <button class="sidebar__item" id="nav-export">
      <span class="sidebar__item-icon">📤</span> Export Data
    </button>
    <button class="sidebar__item" id="nav-import">
      <span class="sidebar__item-icon">📥</span> Import Data
    </button>
    ${!isPWA ? `
    <div class="sidebar__divider"></div>
    <button class="sidebar__item" id="nav-install">
      <span class="sidebar__item-icon">📲</span> Install App
    </button>
    ` : ''}
    <div class="sidebar__divider"></div>
    <button class="sidebar__item" id="nav-about">
      <span class="sidebar__item-icon">ℹ️</span> About
    </button>
  `;

  // Bind sidebar actions
  document.getElementById('nav-summary')?.addEventListener('click', () => { closeSidebar(); renderSummary(); });
  document.getElementById('nav-manage-babies')?.addEventListener('click', () => { closeSidebar(); renderManageBabies(); });
  document.getElementById('nav-settings')?.addEventListener('click', () => { closeSidebar(); renderSettings(); });
  document.getElementById('nav-collab')?.addEventListener('click', () => {
    closeSidebar();
    openCollabModal();
  });
  document.getElementById('nav-export')?.addEventListener('click', () => {
    closeSidebar();
    openExportModal();
  });
  document.getElementById('nav-import')?.addEventListener('click', () => {
    closeSidebar();
    openImportModal();
  });
  document.getElementById('nav-install')?.addEventListener('click', () => { closeSidebar(); triggerInstall(); });
  document.getElementById('nav-about')?.addEventListener('click', () => {
    closeSidebar();
    showAboutModal();
  });
}

function openSidebar() {
  document.getElementById('sidebar-overlay')?.classList.add('active');
}

function closeSidebar() {
  document.getElementById('sidebar-overlay')?.classList.remove('active');
}

function showAboutModal() {
  const appConfig = getAppConfig();
  const overlay = document.getElementById('confirm-overlay');
  const dialog = document.getElementById('confirm-dialog');
  if (!overlay || !dialog) return;

  dialog.innerHTML = `
    <div class="confirm-dialog__title">👶 ${appConfig.title || 'Babylogs by Plotkai'}</div>
    <div class="confirm-dialog__message" style="line-height: 1.5; font-size: 13px;">
      <div style="font-weight: 600; margin-bottom: 6px; color: var(--color-text);">Version ${appConfig.version || '1.0.0'}</div>
      <div style="color: var(--color-text-secondary); margin-bottom: 12px;">
        A private, simple baby activity tracker built with ❤️ by Plotkai.<br>
        All your baby's logs are stored 100% locally on your device with zero cloud servers.
      </div>
      <div style="padding: 10px 12px; background: var(--color-surface-alt); border-radius: var(--radius-sm); border: 1px solid var(--color-border); text-align: left;">
        💌 For any feedback, queries or feature requests, <a href="mailto:support@plotkai.in?subject=Babylogs%20Query" style="color: var(--color-accent); font-weight: 600; text-decoration: underline;">contact us</a> at <strong style="color: var(--color-text);">support@plotkai.in</strong>
      </div>
    </div>
    <div class="confirm-dialog__actions" style="margin-top: 16px;">
      <button class="btn btn--primary" id="confirm-ok">Got it</button>
    </div>
  `;

  overlay.classList.add('active');

  document.getElementById('confirm-ok').addEventListener('click', () => {
    overlay.classList.remove('active');
  });
}

// ==================== COLLAB / CLOUD SYNC MODAL ====================

function openCollabModal(initialTab = 'auto') {
  const overlay = document.getElementById('modal-overlay');
  const title = document.getElementById('modal-title');
  const body = document.getElementById('modal-body');
  const footer = document.getElementById('modal-footer');

  title.textContent = '👥 Multi-Parent Collaboration';

  const isConnected = driveSync.isConnected();
  const currentSyncId = driveSync.getSyncId();

  // Determine active initial tab: 'start' | 'join' | 'connected'
  let activeTab = initialTab;
  if (activeTab === 'auto') {
    activeTab = currentSyncId ? 'connected' : 'start';
  }

  function renderModalContent() {
    const hasSyncId = !!driveSync.getSyncId();
    const syncInfo = driveSync.getEffectiveSyncState();
    const isAuth = syncInfo.isTokenValid;
    const inviteLink = driveSync.getInviteLink();
    const profiles = getProfiles();
    const settings = getSettings();
    const activeBaby = profiles.find(p => p.id === settings.activeBabyId) || profiles[0];

    let statusBadgeHtml = '';
    if (driveSync.status === 'syncing') {
      statusBadgeHtml = `<span class="collab-status-badge collab-status-badge--syncing">🔄 Syncing...</span>`;
    } else if (hasSyncId && syncInfo.state === 'auth_required') {
      statusBadgeHtml = `<span class="collab-status-badge collab-status-badge--warning">⚠️ Out of Sync</span>`;
    } else if (hasSyncId && driveSync.status === 'synced') {
      statusBadgeHtml = `<span class="collab-status-badge collab-status-badge--synced">✓ Synced</span>`;
    } else if (hasSyncId && driveSync.status === 'error') {
      statusBadgeHtml = `<span class="collab-status-badge collab-status-badge--error">⚠️ Sync Error</span>`;
    } else if (hasSyncId && driveSync.status === 'offline') {
      statusBadgeHtml = `<span class="collab-status-badge collab-status-badge--offline">📵 Offline</span>`;
    }

    body.innerHTML = `
      <div class="collab-modal">
        <!-- Account / Cloud Status Banner -->
        <div class="collab-status-card">
          <div class="collab-user-info">
            <div class="collab-avatar">
              ${driveSync.currentUser?.picture ? `<img src="${driveSync.currentUser.picture}" alt="Avatar">` : (driveSync.currentUser?.name ? driveSync.currentUser.name.charAt(0).toUpperCase() : '☁️')}
            </div>
            <div class="collab-user-details">
              <div class="collab-user-name">${driveSync.currentUser?.name || (isAuth ? 'Google Account Connected' : 'Google Drive Cloud Sync')}</div>
              <div class="collab-user-email">${driveSync.currentUser?.email || (isAuth ? 'Connected' : 'Zero-backend private sync')}</div>
            </div>
          </div>
          ${statusBadgeHtml}
        </div>

        ${hasSyncId ? `
          <!-- ACTIVE COLLABORATION VIEW (FOR BOTH CREATOR & JOINER) -->
          <div class="collab-card">
            <div class="collab-card__title">
              <span>🔗 Active Shared Baby Log</span>
            </div>
            <p class="collab-card__desc">
              All logs (feeds, diapers, sleep) sync automatically between you and your partner with offline support.
            </p>

            ${syncInfo.isOutOfSync && syncInfo.state === 'auth_required' ? `
              <div class="collab-alert-box collab-alert-box--warning">
                <div style="font-size: 18px; margin-top: 1px;">⚠️</div>
                <div>
                  <strong>Session Expired (${syncInfo.tokenStatusText || 'Needs Sync'})</strong>
                  <span>Google security expires client tokens after 60 minutes. Tap <strong>Sync Now</strong> below to catch up with your partner.</span>
                </div>
              </div>
            ` : (syncInfo.tokenStatusText ? `
              <div class="collab-session-pill collab-session-pill--active">
                <span>🟢</span>
                <span>Session Active • Token <strong>${syncInfo.tokenStatusText}</strong></span>
              </div>
            ` : '')}

            <!-- Big Centered Prominent Sync Now Button -->
            <div class="collab-sync-now-wrap">
              <button class="btn btn--primary collab-sync-now-btn" id="btn-collab-sync-now">
                <span style="font-size: 18px;">🔄</span>
                <span>Sync Now</span>
              </button>
            </div>

            <div class="collab-tip-box" style="margin-bottom: 8px; font-size: 12px; line-height: 1.5;">
              👶 <strong>Active Baby:</strong> ${activeBaby ? activeBaby.name : 'None selected'}<br>
              📊 <strong>Synced Profiles:</strong> ${profiles.length} baby profile(s)
            </div>

            <div class="form-group" style="margin-bottom: 0;">
              <label class="form-group__label" style="font-size: 11px;">Partner Invite Link</label>
              <div class="collab-link-box">
                <input type="text" class="collab-link-text" id="collab-invite-input" value="${inviteLink}" readonly>
                <button class="btn-copy" id="btn-collab-copy">📋 Copy</button>
              </div>
            </div>

            <button class="btn btn--secondary btn--sm btn--full" id="btn-collab-share-native" style="margin-top: 4px;">📲 Share Link</button>

            <div class="collab-meta-row">
              <span>Last Synced: <strong>${syncInfo.timeAgoText}</strong></span>
              <button class="btn-text" id="btn-collab-unlink" style="color: var(--color-danger); font-size: 12px; cursor: pointer; background: none; border: none; font-weight: 600;">Disconnect</button>
            </div>
          </div>
        ` : `
          <!-- FRESH SETUP VIEW (START vs JOIN TABS) -->
          <div class="collab-tabs">
            <button class="collab-tab ${activeTab === 'start' ? 'collab-tab--active' : ''}" id="tab-collab-start">
              ✨ Start New Log
            </button>
            <button class="collab-tab ${activeTab === 'join' ? 'collab-tab--active' : ''}" id="tab-collab-join">
              🤝 Join Partner's Log
            </button>
          </div>

          ${activeTab === 'start' ? `
            <!-- CREATOR FLOW -->
            <div class="collab-card">
              <div class="collab-card__title">
                <span>👶</span>
                <span>Sync & Share Baby Log</span>
              </div>
              <p class="collab-card__desc">
                Keep feeds, diapers, and sleep seamlessly in sync between both parents in real-time.
              </p>

              <div class="collab-security-banner">
                <div class="collab-security-icon">🛡️</div>
                <div class="collab-security-text">
                  <strong>100% Private & In Your Control</strong>
                  <span>Your data stays in your personal Google Drive with zero intermediate servers. Only you and your partner have access.</span>
                </div>
              </div>

              <button class="btn btn-google btn--full" id="btn-collab-create-drive" style="margin-top: 6px; padding: 13px 18px;">
                <svg viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/></svg>
                <span>Connect Google & Start Sync</span>
              </button>
            </div>
          ` : `
            <!-- JOINER FLOW -->
            <div class="collab-card">
              <div class="collab-card__title">
                <span>🤝</span>
                <span>Join Partner's Baby Log</span>
              </div>
              <p class="collab-card__desc">
                Paste the invite link or Sync ID shared by your partner to connect and sync your logs.
              </p>

              <div class="form-group" style="margin-top: 4px;">
                <label class="form-group__label">Sync ID or Invite Link</label>
                <input type="text" class="form-group__input" id="collab-join-input" placeholder="Paste link or Sync ID..." value="${driveSync.getSyncId() || ''}">
              </div>

              <button class="btn btn-google btn--full" id="btn-collab-join-submit" style="margin-top: 6px; padding: 13px 18px;">
                <svg viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/></svg>
                <span>Connect & Sync with Partner</span>
              </button>
            </div>
          `}
        `}
      </div>
    `;

    footer.innerHTML = `
      <button class="btn btn--secondary btn--full" id="modal-cancel">Done</button>
    `;

    bindCollabEvents();
  }

  function bindCollabEvents() {
    document.getElementById('modal-cancel')?.addEventListener('click', closeModal);

    // Tab switching
    document.getElementById('tab-collab-start')?.addEventListener('click', () => {
      activeTab = 'start';
      renderModalContent();
    });
    document.getElementById('tab-collab-join')?.addEventListener('click', () => {
      activeTab = 'join';
      renderModalContent();
    });

    // Copy Invite Link
    document.getElementById('btn-collab-copy')?.addEventListener('click', async () => {
      const input = document.getElementById('collab-invite-input');
      const copyBtn = document.getElementById('btn-collab-copy');
      if (input) {
        input.select();
        try {
          await navigator.clipboard.writeText(input.value);
          if (copyBtn) {
            copyBtn.textContent = 'Copied! ✓';
            setTimeout(() => { copyBtn.textContent = '📋 Copy'; }, 2000);
          }
          showToast('Invite link copied to clipboard! 📋');
        } catch (e) {
          document.execCommand('copy');
          showToast('Invite link copied! 📋');
        }
      }
    });

    // Native Share
    document.getElementById('btn-collab-share-native')?.addEventListener('click', async () => {
      const inviteLink = driveSync.getInviteLink();
      if (navigator.share) {
        try {
          await navigator.share({
            title: 'Babylogs Collaboration Invite',
            text: 'Join my baby activity tracker on Babylogs so we can log feeds, diapers, and sleep together in real time:',
            url: inviteLink
          });
        } catch (e) {
          console.debug('Native share dismissed:', e);
        }
      } else {
        navigator.clipboard.writeText(inviteLink);
        showToast('Invite link copied to clipboard! 📋');
      }
    });

    // Sync Now
    document.getElementById('btn-collab-sync-now')?.addEventListener('click', async () => {
      const syncBtn = document.getElementById('btn-collab-sync-now');
      if (syncBtn) {
        syncBtn.textContent = '🔄 Syncing...';
        syncBtn.disabled = true;
      }
      try {
        const res = await driveSync.sync(true);
        if (res.success) {
          const profiles = getProfiles();
          if (profiles.length > 0 && !getSettings().activeBabyId) {
            updateSetting('activeBabyId', profiles[0].id);
          }
          if (res.stats) {
            showToast(`Synced ✓ (+${res.stats.newFromRemote || 0} from cloud, ${res.stats.totalActivities || 0} total)`);
          } else {
            showToast('Google Drive synced successfully! ✓');
          }
          if (currentView === 'welcome' || currentView === 'main') {
            renderMain();
          }
        } else {
          showToast(`Sync failed: ${driveSync.lastError || 'Unknown error'}`);
        }
      } catch (err) {
        showToast(`Sync failed: ${err.message}`);
      } finally {
        renderModalContent();
      }
    });

    // Unlink File
    document.getElementById('btn-collab-unlink')?.addEventListener('click', () => {
      showConfirm(
        'Disconnect Collaboration',
        'Are you sure you want to disconnect from this shared cloud file? Your local baby logs will remain safely stored on this device.',
        () => {
          driveSync.signOut(true);
          showToast('Disconnected from cloud sync');
          renderModalContent();
        }
      );
    });

    // Creator Flow: Create Cloud File
    document.getElementById('btn-collab-create-drive')?.addEventListener('click', async () => {
      const btn = document.getElementById('btn-collab-create-drive');
      if (btn) {
        btn.innerHTML = '<span>Creating Cloud File...</span>';
        btn.disabled = true;
      }
      try {
        const fileId = await driveSync.createCloudStoreFile(true);
        showToast('Shared cloud file created! 🎉');
        renderModalContent();
      } catch (err) {
        console.error('Create store error:', err);
        showToast(`Could not create cloud file: ${err.message}`);
        if (btn) {
          btn.innerHTML = `<svg viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/></svg><span>Connect Google & Create Cloud Log</span>`;
          btn.disabled = false;
        }
      }
    });

    // Joiner Flow: Join Existing File
    document.getElementById('btn-collab-join-submit')?.addEventListener('click', async () => {
      const input = document.getElementById('collab-join-input');
      const btn = document.getElementById('btn-collab-join-submit');
      let rawVal = input?.value?.trim() || '';

      if (!rawVal) {
        showToast('Please enter a Sync ID or Invite Link');
        return;
      }

      // Extract syncId if a full URL was pasted
      if (rawVal.includes('syncId=')) {
        try {
          const url = new URL(rawVal);
          rawVal = url.searchParams.get('syncId') || rawVal;
        } catch (e) {
          const match = rawVal.match(/syncId=([^&]+)/);
          if (match) rawVal = match[1];
        }
      }

      driveSync.setSyncId(rawVal);

      if (btn) {
        btn.innerHTML = '<span>Connecting & Syncing...</span>';
        btn.disabled = true;
      }

      try {
        const res = await driveSync.sync(true);
        if (res.success) {
          showToast('Connected and synced with partner! 🎉');
          const profiles = getProfiles();
          if (profiles.length > 0) {
            updateSetting('activeBabyId', profiles[0].id);
          }
          renderModalContent();
          if (currentView === 'welcome' || currentView === 'main') {
            renderMain();
          }
        } else {
          showToast(`Connection failed: ${driveSync.lastError || 'Unknown error'}`);
          if (btn) {
            btn.innerHTML = `<svg viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/></svg><span>Connect & Sync with Partner</span>`;
            btn.disabled = false;
          }
        }
      } catch (err) {
        showToast(`Connection failed: ${err.message}`);
        if (btn) {
          btn.innerHTML = `<svg viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/></svg><span>Connect & Sync with Partner</span>`;
          btn.disabled = false;
        }
      }
    });
  }

  renderModalContent();
  overlay.classList.add('active');
}

// ==================== EXPORT & IMPORT MODALS ====================

function openExportModal() {
  const overlay = document.getElementById('modal-overlay');
  const title = document.getElementById('modal-title');
  const body = document.getElementById('modal-body');
  const footer = document.getElementById('modal-footer');

  title.textContent = 'Export & Share Data';

  const profiles = getProfiles();
  const settings = getSettings();
  const todayKey = formatDateKey(new Date());

  body.innerHTML = `
    <div class="form-group">
      <label class="form-group__label">Select Baby</label>
      <select class="form-group__select" id="export-baby-select">
        <option value="all">👶 All Babies (${profiles.length})</option>
        ${profiles.map(p => `
          <option value="${p.id}" ${p.id === settings.activeBabyId ? 'selected' : ''}>👶 ${p.name}</option>
        `).join('')}
      </select>
    </div>

    <div class="form-group">
      <label class="form-group__label">Date Range</label>
      <select class="form-group__select" id="export-range-select">
        <option value="all" selected>📅 All Time (Entire History)</option>
        <option value="today">📅 Today</option>
        <option value="week">📅 This Week</option>
        <option value="month">📅 This Month</option>
        <option value="custom">📅 Custom Date Range...</option>
      </select>
    </div>

    <div class="form-group__row hidden" id="export-custom-range-row">
      <div class="form-group">
        <label class="form-group__label">From Date</label>
        <input type="date" class="form-group__input" id="export-date-from" value="${todayKey}" max="${todayKey}">
      </div>
      <div class="form-group">
        <label class="form-group__label">To Date</label>
        <input type="date" class="form-group__input" id="export-date-to" value="${todayKey}" max="${todayKey}">
      </div>
    </div>

    <div class="form-group" style="margin-top: 18px;">
      <label class="form-group__label">1. One-Tap Share to WhatsApp / Apps</label>
      <button class="btn btn--whatsapp btn--full" id="btn-do-share-whatsapp" style="padding: 13px; font-size: 14px;">
        📲 Share Backup via WhatsApp / Apps
      </button>
      <div style="font-size: 11px; color: var(--color-text-muted); margin-top: 4px; text-align: center;">
        Directly send backup file to partner or caregiver to open in Babylogs
      </div>
    </div>

    <div class="form-group" style="margin-top: 14px;">
      <label class="form-group__label">2. Or Download File Locally</label>
      <div class="export-format-grid">
        <button class="btn btn--primary" id="btn-do-export-json">
          💾 JSON Backup (Full Data)
        </button>
        <button class="btn btn--secondary" id="btn-do-export-csv">
          📊 CSV Spreadsheet (Excel)
        </button>
        <button class="btn btn--secondary" id="btn-do-export-pdf">
          🖨️ Print / Save as PDF
        </button>
      </div>
    </div>
  `;

  footer.innerHTML = `
    <button class="btn btn--secondary btn--full" id="modal-cancel">Close</button>
  `;

  overlay.classList.add('active');

  const rangeSelect = document.getElementById('export-range-select');
  const customRow = document.getElementById('export-custom-range-row');
  rangeSelect?.addEventListener('change', () => {
    if (rangeSelect.value === 'custom') {
      customRow.classList.remove('hidden');
    } else {
      customRow.classList.add('hidden');
    }
  });

  document.getElementById('modal-cancel').addEventListener('click', closeModal);

  // Helper to extract date bounds
  function getSelectedExportBounds() {
    const babyVal = document.getElementById('export-baby-select').value;
    const babyId = babyVal === 'all' ? null : babyVal;
    const babyName = babyId ? (profiles.find(p => p.id === babyId)?.name || 'baby') : 'all-babies';

    const rangeVal = rangeSelect.value;
    let startDate = null;
    let endDate = null;
    let rangeLabel = rangeVal;

    const now = new Date();
    if (rangeVal === 'today') {
      startDate = todayKey;
      endDate = todayKey;
    } else if (rangeVal === 'week') {
      const { start, end } = getDateRange('week', now);
      startDate = formatDateKey(start);
      endDate = formatDateKey(end);
    } else if (rangeVal === 'month') {
      const { start, end } = getDateRange('month', now);
      startDate = formatDateKey(start);
      endDate = formatDateKey(end);
    } else if (rangeVal === 'custom') {
      startDate = document.getElementById('export-date-from').value;
      endDate = document.getElementById('export-date-to').value;
      rangeLabel = `${startDate}_to_${endDate}`;
    }

    return { babyId, babyName, startDate, endDate, dateRangeLabel: rangeLabel };
  }

  // One-Tap WhatsApp / App Share
  document.getElementById('btn-do-share-whatsapp')?.addEventListener('click', async () => {
    try {
      const bounds = getSelectedExportBounds();
      const res = await shareBackup(bounds);
      if (res && res.shared) {
        trackDataExport('share_whatsapp', bounds.dateRangeLabel);
        closeModal();
        showToast('Backup shared successfully ✓');
      }
    } catch (err) {
      showToast('Sharing failed');
    }
  });

  // JSON Export
  document.getElementById('btn-do-export-json').addEventListener('click', async () => {
    try {
      const bounds = getSelectedExportBounds();
      await exportJSON(bounds);
      trackDataExport('json', bounds.dateRangeLabel);
      closeModal();
      showToast('JSON Backup downloaded ✓');
    } catch (err) {
      showToast('Export failed');
    }
  });

  // CSV Export
  document.getElementById('btn-do-export-csv').addEventListener('click', async () => {
    try {
      const bounds = getSelectedExportBounds();
      const exportData = await exportFilteredData(bounds);
      exportCSV(exportData.activities, bounds.babyName, bounds.dateRangeLabel);
      trackDataExport('csv', bounds.dateRangeLabel);
      closeModal();
      showToast('CSV Spreadsheet downloaded ✓');
    } catch (err) {
      showToast('CSV Export failed');
    }
  });

  // PDF Export
  document.getElementById('btn-do-export-pdf').addEventListener('click', () => {
    const bounds = getSelectedExportBounds();
    trackDataExport('pdf', bounds.dateRangeLabel);
    closeModal();
    exportPDF();
  });
}

function openImportModal(preloadedData = null, preloadedTitle = '') {
  const overlay = document.getElementById('modal-overlay');
  const title = document.getElementById('modal-title');
  const body = document.getElementById('modal-body');
  const footer = document.getElementById('modal-footer');

  title.textContent = preloadedData ? '📥 Import Shared Backup' : 'Import Data';

  let selectedFile = null;
  let parsedData = preloadedData || null;

  body.innerHTML = `
    <div class="form-group">
      <label class="form-group__label">1. Choose Import Method</label>
      <div class="import-mode-selector">
        <label class="import-mode-card selected" id="import-mode-merge-label">
          <input type="radio" name="import-mode" value="merge" checked>
          <div class="import-mode-card__content">
            <div class="import-mode-card__title">⚡ Smart Merge <span style="font-size: 10px; color: var(--color-success); font-weight: bold; background: rgba(0, 184, 148, 0.1); padding: 1px 6px; border-radius: 10px;">Recommended</span></div>
            <div class="import-mode-card__desc">Intelligently matches babies by name, adds new activities, and automatically skips duplicates. No data is lost!</div>
          </div>
        </label>

        <label class="import-mode-card" id="import-mode-replace-label">
          <input type="radio" name="import-mode" value="replace">
          <div class="import-mode-card__content">
            <div class="import-mode-card__title" style="color: var(--color-danger);">⚠️ Full Overwrite (Replace All)</div>
            <div class="import-mode-card__desc">Wipes all current local records and restores the exact state from this backup file.</div>
          </div>
        </label>
      </div>
    </div>

    <div class="form-group">
      <label class="form-group__label">2. ${preloadedData ? 'Shared Backup File' : 'Select Backup File (.json)'}</label>
      <div class="import-file-box" id="import-file-box">
        <div class="import-file-box__icon">📁</div>
        <div class="import-file-box__text" id="import-file-text">${preloadedData ? `📄 ${preloadedTitle || 'Shared Backup Ready'}` : 'Click or drag & drop Babylogs JSON backup file'}</div>
        <div class="import-file-box__subtext">${preloadedData ? 'Tap to change file' : 'Supported format: .json'}</div>
        <input type="file" id="import-file-input" accept=".json" style="display: none;">
      </div>
    </div>

    <div id="import-preview-area"></div>
  `;

  footer.innerHTML = `
    <button class="btn btn--secondary" id="modal-cancel">Cancel</button>
    <button class="btn btn--primary" id="btn-do-import" ${preloadedData ? '' : 'disabled'}>⚡ Smart Merge Now</button>
  `;

  overlay.classList.add('active');

  // Radio toggle highlighting
  document.querySelectorAll('input[name="import-mode"]').forEach(radio => {
    radio.addEventListener('change', () => {
      document.querySelectorAll('.import-mode-card').forEach(card => card.classList.remove('selected'));
      radio.closest('.import-mode-card')?.classList.add('selected');
      const importBtn = document.getElementById('btn-do-import');
      if (importBtn) {
        importBtn.textContent = radio.value === 'merge' ? '⚡ Smart Merge Now' : '⚠️ Replace All Data';
      }
    });
  });

  const fileBox = document.getElementById('import-file-box');
  const fileInput = document.getElementById('import-file-input');
  const fileText = document.getElementById('import-file-text');
  const previewArea = document.getElementById('import-preview-area');
  const importBtn = document.getElementById('btn-do-import');

  fileBox.addEventListener('click', () => fileInput.click());

  // Drag & drop
  fileBox.addEventListener('dragover', (e) => { e.preventDefault(); fileBox.classList.add('dragover'); });
  fileBox.addEventListener('dragleave', () => fileBox.classList.remove('dragover'));
  fileBox.addEventListener('drop', async (e) => {
    e.preventDefault();
    fileBox.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) {
      await handleFile(e.dataTransfer.files[0]);
    }
  });

  fileInput.addEventListener('change', async (e) => {
    if (e.target.files.length > 0) {
      await handleFile(e.target.files[0]);
    }
  });

  async function renderAnalysisPreview(data) {
    try {
      const analysis = await inspectBackup(data);
      const babyNames = data.profiles.map(p => p.name).join(', ') || 'None';
      previewArea.innerHTML = `
        <div class="import-preview-box">
          <div class="import-preview-box__title">✓ Valid Babylogs Backup</div>
          <div class="import-preview-box__stat">
            👶 <strong>${analysis.totalProfiles} Baby Profile${analysis.totalProfiles > 1 ? 's' : ''}</strong> (${babyNames})
            <div>
              ${analysis.matchedBabies.length > 0 ? `<span class="smart-stat-pill smart-stat-pill--matched">🔗 ${analysis.matchedBabies.length} matched</span>` : ''}
              ${analysis.newBabies.length > 0 ? `<span class="smart-stat-pill smart-stat-pill--new">＋ ${analysis.newBabies.length} new</span>` : ''}
            </div>
          </div>
          <div class="import-preview-box__stat" style="margin-top: 6px;">
            📝 <strong>${analysis.totalActivities} Total Activities</strong>
            <div>
              <span class="smart-stat-pill smart-stat-pill--new">✨ ${analysis.newActivitiesCount} new to add</span>
              ${analysis.duplicateActivitiesCount > 0 ? `<span class="smart-stat-pill smart-stat-pill--duplicate">✓ ${analysis.duplicateActivitiesCount} duplicates will be skipped</span>` : ''}
            </div>
          </div>
          ${analysis.exportDate ? `<div class="import-preview-box__stat" style="margin-top: 6px; font-size: 11px;">📅 Backup Created: ${formatDateDisplay(new Date(analysis.exportDate))}</div>` : ''}
        </div>
      `;
      importBtn.disabled = false;
    } catch (err) {
      parsedData = null;
      previewArea.innerHTML = `
        <div class="import-preview-box" style="border-color: var(--color-danger); color: var(--color-danger);">
          ✕ ${err.message || 'Invalid backup file'}
        </div>
      `;
      importBtn.disabled = true;
    }
  }

  if (preloadedData) {
    renderAnalysisPreview(preloadedData);
  }

  async function handleFile(file) {
    selectedFile = file;
    fileText.textContent = `📄 ${file.name}`;
    try {
      parsedData = await parseBackupFile(file);
      await renderAnalysisPreview(parsedData);
    } catch (err) {
      parsedData = null;
      previewArea.innerHTML = `
        <div class="import-preview-box" style="border-color: var(--color-danger); color: var(--color-danger);">
          ✕ ${err.message || 'Invalid backup file'}
        </div>
      `;
      importBtn.disabled = true;
    }
  }

  document.getElementById('modal-cancel').addEventListener('click', closeModal);

  importBtn.addEventListener('click', async () => {
    if (!parsedData) return;
    const mode = document.querySelector('input[name="import-mode"]:checked')?.value || 'merge';

    if (mode === 'replace') {
      showConfirm(
        'Replace all data?',
        'This will permanently wipe all existing baby logs on this device and restore the exact backup. Are you sure?',
        async () => {
          try {
            const res = await executeImport(parsedData, 'replace');
            trackDataImport('replace', res.profilesCount, res.activitiesCount);
            closeModal();
            showToast(`Restored ${res.profilesCount} babies & ${res.activitiesCount} logs ✓`);
            renderMain();
          } catch (err) {
            showToast('Import failed');
          }
        }
      );
    } else {
      try {
        const res = await executeImport(parsedData, 'merge');
        trackDataImport('merge', res.profilesCount, res.activitiesCount);
        closeModal();
        showToast(`Smart Merge: +${res.newActivitiesAdded} activities added, ${res.duplicateActivitiesSkipped} duplicates skipped ✓`);
        renderMain();
      } catch (err) {
        showToast('Import failed');
      }
    }
  });
}

// ==================== MANAGE BABIES SCREEN ====================

function renderManageBabies() {
  currentView = 'manage-babies';
  trackPageView('manage-babies', 'Babylogs - Manage Babies');
  const app = document.getElementById('app');
  const profiles = getProfiles();
  const settings = getSettings();

  app.innerHTML = `
    <header class="header" id="header">
      <button class="header__menu-btn" id="back-btn" aria-label="Back">←</button>
      <span class="header__title">Manage Babies</span>
      <button class="header__action-btn" id="header-add-baby-btn" aria-label="Add Baby" title="Add Baby">＋</button>
    </header>

    <div class="manage-babies">
      <div class="manage-babies__header-cta">
        <button class="btn btn--primary btn--full" id="btn-add-baby-page">＋ Add New Baby</button>
      </div>

      <div class="manage-babies__list">
        ${profiles.map(baby => {
    const isActive = baby.id === settings.activeBabyId;
    const dobFormatted = formatDateDisplay(new Date(baby.dob + 'T12:00:00'));
    return `
            <div class="baby-card ${isActive ? 'baby-card--active' : ''}">
              <div class="baby-card__top">
                <div class="baby-card__avatar">${baby.name.charAt(0).toUpperCase()}</div>
                <div class="baby-card__info">
                  <div class="baby-card__name-row">
                    <span class="baby-card__name">${baby.name}</span>
                    ${isActive ? '<span class="baby-card__badge">Active</span>' : ''}
                  </div>
                  <div class="baby-card__meta">${getAgeString(baby.dob)} old • Born ${dobFormatted}</div>
                </div>
              </div>
              <div class="baby-card__actions">
                ${!isActive ? `<button class="btn btn--secondary btn--sm btn-select-baby" data-id="${baby.id}">Select</button>` : ''}
                <button class="btn btn--secondary btn--sm btn-edit-baby" data-id="${baby.id}">✏️ Edit</button>
                <button class="btn btn--danger btn--sm btn-delete-baby" data-id="${baby.id}">🗑️ Delete</button>
              </div>
            </div>
          `;
  }).join('')}
      </div>
    </div>

    <!-- Modal Overlay -->
    <div class="modal-overlay" id="modal-overlay">
      <div class="modal" id="modal">
        <div class="modal__drag-handle"></div>
        <div class="modal__header">
          <h2 class="modal__title" id="modal-title"></h2>
          <button class="modal__close-btn" id="modal-close">✕</button>
        </div>
        <div class="modal__body" id="modal-body"></div>
        <div class="modal__footer" id="modal-footer"></div>
      </div>
    </div>

    <!-- Confirm Dialog -->
    <div class="confirm-overlay" id="confirm-overlay">
      <div class="confirm-dialog" id="confirm-dialog"></div>
    </div>

    <!-- Toast -->
    <div class="toast" id="toast"></div>
  `;

  // Back button
  document.getElementById('back-btn').addEventListener('click', renderMain);

  // Add baby buttons
  document.getElementById('header-add-baby-btn')?.addEventListener('click', openAddBabyModal);
  document.getElementById('btn-add-baby-page')?.addEventListener('click', openAddBabyModal);

  // Modal close handlers
  document.getElementById('modal-close')?.addEventListener('click', closeModal);
  document.getElementById('modal-overlay')?.addEventListener('click', (e) => {
    if (e.target.id === 'modal-overlay') closeModal();
  });

  // Select baby
  app.querySelectorAll('.btn-select-baby').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      updateSetting('activeBabyId', id);
      renderManageBabies();
      showToast('Active baby switched ✓');
    });
  });

  // Edit baby
  app.querySelectorAll('.btn-edit-baby').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      openEditProfileModal(id);
    });
  });

  // Delete baby
  app.querySelectorAll('.btn-delete-baby').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      const baby = profiles.find(p => p.id === id);
      if (baby) confirmDeleteBaby(baby);
    });
  });
}

// ==================== EDIT PROFILE ====================

function openEditProfileModal(targetBabyId) {
  const settings = getSettings();
  const profiles = getProfiles();
  const babyId = targetBabyId || settings.activeBabyId;
  const baby = profiles.find(p => p.id === babyId);
  if (!baby) return;

  const overlay = document.getElementById('modal-overlay');
  const title = document.getElementById('modal-title');
  const body = document.getElementById('modal-body');
  const footer = document.getElementById('modal-footer');

  title.textContent = `Edit ${baby.name}`;
  body.innerHTML = `
    <div class="form-group">
      <label class="form-group__label">Baby's Name</label>
      <input type="text" class="form-group__input" id="edit-name" value="${baby.name}">
    </div>
    <div class="form-group">
      <label class="form-group__label">Date of Birth</label>
      <input type="date" class="form-group__input" id="edit-dob" value="${baby.dob}" max="${formatDateKey(new Date())}">
    </div>
  `;

  footer.innerHTML = `
    <button class="btn btn--secondary" id="modal-cancel">Cancel</button>
    <button class="btn btn--primary" id="save-profile-btn">Save Changes</button>
  `;

  overlay.classList.add('active');

  document.getElementById('modal-cancel').addEventListener('click', closeModal);
  document.getElementById('save-profile-btn').addEventListener('click', () => {
    const name = document.getElementById('edit-name').value.trim();
    const dob = document.getElementById('edit-dob').value;
    if (!name || !dob) { showToast('Please fill all fields'); return; }

    updateProfile(baby.id, { name, dob });
    driveSync.queueSync();
    closeModal();
    if (currentView === 'manage-babies') {
      renderManageBabies();
    } else {
      renderMain();
    }
    showToast('Profile updated ✓');
  });
}

function confirmDeleteBaby(baby) {
  showConfirm('Delete Baby', `Are you sure you want to delete ${baby.name} and all their logged activities? This cannot be undone!`, async () => {
    deleteProfile(baby.id);
    driveSync.queueSync();
    const remaining = getProfiles();
    if (remaining.length > 0) {
      const settings = getSettings();
      if (settings.activeBabyId === baby.id) {
        updateSetting('activeBabyId', remaining[0].id);
      }
      if (currentView === 'manage-babies') {
        renderManageBabies();
      } else {
        renderMain();
      }
    } else {
      renderWelcome();
    }
    showToast(`${baby.name} deleted`);
  });
}

// ==================== SUMMARY SCREEN ====================

async function renderSummary() {
  currentView = 'summary';
  trackPageView('summary', 'Babylogs - Summary');
  summaryPeriod = 'day';
  summaryDate = new Date(currentDate);
  const app = document.getElementById('app');
  const appConfig = getAppConfig();
  const adConfig = getAdBannerConfig();
  const settings = getSettings();
  const profiles = getProfiles();
  const baby = profiles.find(p => p.id === settings.activeBabyId);

  if (!baby) return;

  app.innerHTML = `
    <header class="header" id="header">
      <button class="header__menu-btn" id="back-btn" aria-label="Back">←</button>
      <span class="header__title">Summary</span>
      <span class="header__right"></span>
    </header>

    <div class="summary-wrapper">
      <!-- Ad Banner -->
      ${adConfig.enabled ? `
      <div class="ad-banner" id="ad-banner-slot">
        ${adConfig.adClient && adConfig.adSlotId ? `
          <ins class="adsbygoogle"
               style="display:block;height:50px;"
               data-ad-client="${adConfig.adClient}"
               data-ad-slot="${adConfig.adSlotId}"
               data-ad-format="horizontal"
               data-full-width-responsive="false"></ins>
        ` : (adConfig.placeholder || '')}
      </div>
      ` : ''}

      <div class="summary" id="summary-content">
        <div class="summary__period-tabs" id="period-tabs">
          <button class="summary__period-tab active" data-period="day">Day</button>
          <button class="summary__period-tab" data-period="week">Week</button>
          <button class="summary__period-tab" data-period="month">Month</button>
        </div>

        <!-- Period / Date Navigator -->
        <div class="date-nav summary__date-nav" id="summary-date-nav">
          <button class="date-nav__btn" id="summary-date-prev" aria-label="Previous period">◀</button>
          <span class="date-nav__label" id="summary-date-label"></span>
          <button class="date-nav__btn" id="summary-date-next" aria-label="Next period">▶</button>
        </div>

        <div id="summary-data"></div>
      </div>
    </div>

    <div class="toast" id="toast"></div>
  `;

  document.getElementById('back-btn').addEventListener('click', renderMain);

  // Period tabs
  document.querySelectorAll('.summary__period-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.summary__period-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      summaryPeriod = tab.dataset.period;
      updateSummaryDateNav();
      loadSummaryData(summaryPeriod);
    });
  });

  // Navigator prev / next
  document.getElementById('summary-date-prev').addEventListener('click', () => changeSummaryDate(-1));
  document.getElementById('summary-date-next').addEventListener('click', () => changeSummaryDate(1));

  updateSummaryDateNav();
  await loadSummaryData(summaryPeriod);

  // Initialize Google AdSense
  initAdBanner();
}

function changeSummaryDate(delta) {
  if (summaryPeriod === 'day') {
    summaryDate.setDate(summaryDate.getDate() + delta);
  } else if (summaryPeriod === 'week') {
    summaryDate.setDate(summaryDate.getDate() + delta * 7);
  } else if (summaryPeriod === 'month') {
    summaryDate.setMonth(summaryDate.getMonth() + delta);
  }
  updateSummaryDateNav();
  loadSummaryData(summaryPeriod);
}

function updateSummaryDateNav() {
  const label = document.getElementById('summary-date-label');
  if (!label) return;

  if (summaryPeriod === 'day') {
    label.innerHTML = `
      ${formatDateDisplay(summaryDate)}
      ${isToday(summaryDate) ? '<span class="date-nav__today-badge">Today</span>' : ''}
      <input type="date" class="date-nav__hidden-input" id="summary-date-picker" value="${formatDateKey(summaryDate)}">
    `;
    const picker = document.getElementById('summary-date-picker');
    label.onclick = () => picker.showPicker?.() || picker.focus();
    picker.onchange = (e) => {
      summaryDate = new Date(e.target.value + 'T12:00:00');
      updateSummaryDateNav();
      loadSummaryData(summaryPeriod);
    };
  } else if (summaryPeriod === 'week') {
    const { start, end } = getDateRange('week', summaryDate);
    label.innerHTML = `
      ${formatWeekRange(start, end)}
      ${isThisWeek(summaryDate) ? '<span class="date-nav__today-badge">This Week</span>' : ''}
    `;
    label.onclick = null;
  } else if (summaryPeriod === 'month') {
    label.innerHTML = `
      ${formatMonthDisplay(summaryDate)}
      ${isThisMonth(summaryDate) ? '<span class="date-nav__today-badge">This Month</span>' : ''}
    `;
    label.onclick = null;
  }
}

async function loadSummaryData(period) {
  const settings = getSettings();
  const profiles = getProfiles();
  const baby = profiles.find(p => p.id === settings.activeBabyId);
  if (!baby) return;

  const { start, end } = getDateRange(period, summaryDate);
  const summary = await computeSummary(settings.activeBabyId, start, end);
  const isCurrent = period === 'day' ? isToday(summaryDate) : period === 'week' ? isThisWeek(summaryDate) : isThisMonth(summaryDate);
  const performance = comparePerformance(summary, baby.dob, period, isCurrent);

  const container = document.getElementById('summary-data');
  if (!container) return;

  const feedInterval = summary.feeds.avgIntervalMinutes > 0
    ? formatDuration(summary.feeds.avgIntervalMinutes)
    : 'N/A';

  const unitLabel = settings.unit?.volume || 'ml';

  container.innerHTML = `
    <!-- Feed Summary -->
    <div class="summary__card">
      <div class="summary__card-title">🍼 Feeding</div>
      <div class="summary__stat-grid">
        <div class="summary__stat">
          <div class="summary__stat-value">${summary.feeds.breastFeedCount}</div>
          <div class="summary__stat-label">Breast Feeds</div>
        </div>
        <div class="summary__stat">
          <div class="summary__stat-value">${formatDuration(summary.feeds.breastFeedMinutes) || '0'}</div>
          <div class="summary__stat-label">Total Time</div>
        </div>
        <div class="summary__stat">
          <div class="summary__stat-value">${summary.feeds.formulaTotalQty}${unitLabel}</div>
          <div class="summary__stat-label">Formula (${summary.feeds.formulaCount}x)</div>
        </div>
        <div class="summary__stat">
          <div class="summary__stat-value">${summary.feeds.expressTotalQty}${unitLabel}</div>
          <div class="summary__stat-label">Expressed (${summary.feeds.expressCount}x)</div>
        </div>
      </div>
      <div style="margin-top: 12px; text-align: center; font-size: 13px; color: var(--color-text-secondary);">
        Avg interval: <strong>${feedInterval}</strong>
      </div>
      <canvas class="summary__chart" id="chart-feeds"></canvas>
    </div>

    <!-- Output Summary -->
    <div class="summary__card">
      <div class="summary__card-title">🧷 Output</div>
      <div class="summary__stat-grid">
        <div class="summary__stat">
          <div class="summary__stat-value">${summary.output.poopCount}</div>
          <div class="summary__stat-label">Poops</div>
        </div>
        <div class="summary__stat">
          <div class="summary__stat-value">${summary.output.wetCount}</div>
          <div class="summary__stat-label">Wet Diapers</div>
        </div>
        <div class="summary__stat">
          <div class="summary__stat-value">${summary.output.diaperChangeCount}</div>
          <div class="summary__stat-label">Diaper Changes</div>
        </div>
        <div class="summary__stat">
          <div class="summary__stat-value">${summary.totalActivities}</div>
          <div class="summary__stat-label">Total Activities</div>
        </div>
      </div>
    </div>

    <!-- Sleep Summary -->
    <div class="summary__card">
      <div class="summary__card-title">😴 Sleep</div>
      <div class="summary__stat-grid">
        <div class="summary__stat">
          <div class="summary__stat-value">${formatDuration(summary.sleep.totalMinutes) || '0'}</div>
          <div class="summary__stat-label">Total Sleep</div>
        </div>
        <div class="summary__stat">
          <div class="summary__stat-value">${summary.sleep.napCount}</div>
          <div class="summary__stat-label">Naps</div>
        </div>
        <div class="summary__stat">
          <div class="summary__stat-value">${formatDuration(summary.sleep.avgNapMinutes) || 'N/A'}</div>
          <div class="summary__stat-label">Avg Nap</div>
        </div>
        <div class="summary__stat">
          <div class="summary__stat-value">${formatDuration(summary.sleep.longestNapMinutes) || 'N/A'}</div>
          <div class="summary__stat-label">Longest Stretch</div>
        </div>
      </div>
      <canvas class="summary__chart" id="chart-sleep"></canvas>
    </div>

    <!-- Expected Performance Targets -->
    ${performance ? `
    <div class="summary__card">
      <div class="summary__card-title">📈 Milestone Targets — ${performance.bracketLabel}</div>
      <p style="font-size: 12px; color: var(--color-text-secondary); margin-top: -6px; margin-bottom: 12px;">
        ${period === 'day' ? (isCurrent ? 'Milestone targets for today:' : 'Milestone targets for this day:') : 'Daily averages vs recommended milestone targets:'}
      </p>
      ${performance.metrics.map(m => `
        <div class="perf-metric perf-metric--${m.status}">
          <div class="perf-metric__label">
            <span class="perf-metric__name">${m.label}</span>
            <span class="perf-metric__badge perf-metric__badge--${m.status}">${m.badge}</span>
          </div>
          <div class="perf-metric__bar">
            <div class="perf-metric__bar-fill" style="width: ${m.progressPct}%"></div>
          </div>
          <div class="perf-metric__footer">
            <span class="perf-metric__count">Logged: <strong>${m.actual}${m.unit}</strong></span>
            <span class="perf-metric__target">Target: ${m.min} – ${m.max} ${period === 'day' ? 'today' : '/ day'}</span>
          </div>
        </div>
      `).join('')}
      <div class="perf-metric__note">
        💡 ${performance.notes}
      </div>
    </div>
    ` : ''}

    <!-- Care & Health Routine Calendar (Week & Month views) -->
    ${period !== 'day' ? `
    <div class="summary__card">
      <div class="summary__card-title">
        🗓️ Care & Routine Tracker
        <span style="font-size: 11px; font-weight: normal; color: var(--color-text-secondary); margin-left: auto;">${period === 'week' ? 'Weekly Matrix' : 'Monthly Matrix'}</span>
      </div>

      <!-- Care Counters -->
      <div class="summary__stat-grid" style="grid-template-columns: repeat(3, 1fr); margin-bottom: 14px;">
        <div class="summary__stat">
          <div class="summary__stat-value">🛁 ${summary.healthCare.bathCount}</div>
          <div class="summary__stat-label">Baths</div>
        </div>
        <div class="summary__stat">
          <div class="summary__stat-value">💆 ${summary.healthCare.massageCount}</div>
          <div class="summary__stat-label">Massages</div>
        </div>
        <div class="summary__stat">
          <div class="summary__stat-value">💊 ${summary.healthCare.medicineCount}</div>
          <div class="summary__stat-label">Medicines</div>
        </div>
      </div>

      <!-- Legend -->
      <div class="care-calendar__legend">
        <span class="care-legend-item"><span class="care-dot care-dot--bath"></span> Bath</span>
        <span class="care-legend-item"><span class="care-dot care-dot--massage"></span> Massage</span>
        <span class="care-legend-item"><span class="care-dot care-dot--medicine"></span> Medicine</span>
        <span class="care-legend-item"><span class="care-dot care-dot--weight"></span> Weight</span>
      </div>

      <!-- Calendar View -->
      ${period === 'week'
        ? renderWeekCareCalendar(start, end, summary.healthCare.dailyCareMap)
        : renderMonthCareCalendar(start, end, summary.healthCare.dailyCareMap)}

      <!-- Medicine Details -->
      ${summary.healthCare.medicines.length > 0 ? `
        <div class="care-medicine-log">
          <div class="care-medicine-log__title">💊 Administered Medicines:</div>
          ${summary.healthCare.medicines.map(m => `
            <div class="care-medicine-item">
              <span class="care-medicine-item__name">${m.name}${m.dose ? ` (${m.dose})` : ''}</span>
              <span class="care-medicine-item__time">${formatDateDisplay(new Date(m.time))} ${formatTime(m.time)}</span>
            </div>
          `).join('')}
        </div>
      ` : ''}
    </div>

    <!-- Weight Trajectory Tracker (Week & Month views) -->
    <div class="summary__card">
      <div class="summary__card-title">⚖️ Weight Trajectory</div>
      ${summary.healthCare.weightChecks.length > 0 ? `
        <div class="summary__stat-grid" style="grid-template-columns: repeat(3, 1fr); margin-bottom: 12px;">
          <div class="summary__stat">
            <div class="summary__stat-value">${summary.healthCare.weightChecks[summary.healthCare.weightChecks.length - 1].value} <span style="font-size: 13px; font-weight: normal;">${settings.unit?.weight || 'kg'}</span></div>
            <div class="summary__stat-label">Latest Weight</div>
          </div>
          <div class="summary__stat">
            <div class="summary__stat-value" style="color: ${summary.healthCare.weightChecks.length > 1
          ? (summary.healthCare.weightChecks[summary.healthCare.weightChecks.length - 1].value - summary.healthCare.weightChecks[0].value >= 0
            ? 'var(--color-success)'
            : 'var(--color-danger)')
          : 'var(--color-text)'
        };">
              ${summary.healthCare.weightChecks.length > 1
          ? (summary.healthCare.weightChecks[summary.healthCare.weightChecks.length - 1].value - summary.healthCare.weightChecks[0].value >= 0 ? '+' : '') +
          (Math.round((summary.healthCare.weightChecks[summary.healthCare.weightChecks.length - 1].value - summary.healthCare.weightChecks[0].value) * 100) / 100) + ' ' + (settings.unit?.weight || 'kg')
          : '—'
        }
            </div>
            <div class="summary__stat-label">Trajectory Change</div>
          </div>
          <div class="summary__stat">
            <div class="summary__stat-value">${summary.healthCare.weightChecks.length}</div>
            <div class="summary__stat-label">Weight Checks</div>
          </div>
        </div>

        <canvas class="summary__chart" id="chart-weight" style="height: 180px;"></canvas>

        <div class="weight-log-list">
          ${summary.healthCare.weightChecks.slice(-5).reverse().map(w => `
            <div class="weight-log-item">
              <span class="weight-log-item__date">${formatDateDisplay(new Date(w.time))} ${formatTime(w.time)}</span>
              <span class="weight-log-item__val"><strong>${w.value} ${settings.unit?.weight || 'kg'}</strong></span>
            </div>
          `).join('')}
        </div>
      ` : `
        <div style="text-align: center; padding: 18px 10px; color: var(--color-text-secondary); font-size: 13px;">
          No weight checks logged for this ${period}.<br>
          <span style="font-size: 11px; opacity: 0.8; display: inline-block; margin-top: 4px;">Log a Weight Check from the <strong>＋</strong> menu to visualize growth trajectory.</span>
        </div>
      `}
    </div>
    ` : ''}

    <!-- Export -->
    <div class="summary__export-btns">
      <button class="btn btn--whatsapp btn--sm" id="btn-summary-share">💬 Share WhatsApp</button>
      <button class="btn btn--secondary btn--sm" id="export-csv">📄 CSV</button>
      <button class="btn btn--secondary btn--sm" id="export-pdf">📋 PDF</button>
    </div>

    <!-- Modal Overlay -->
    <div class="modal-overlay" id="modal-overlay">
      <div class="modal" id="modal">
        <div class="modal__drag-handle"></div>
        <div class="modal__header">
          <h2 class="modal__title" id="modal-title"></h2>
          <button class="modal__close-btn" id="modal-close">✕</button>
        </div>
        <div class="modal__body" id="modal-body"></div>
        <div class="modal__footer" id="modal-footer"></div>
      </div>
    </div>

    <!-- Confirm Dialog Overlay -->
    <div class="confirm-overlay" id="confirm-overlay">
      <div class="confirm-dialog" id="confirm-dialog"></div>
    </div>

    <div class="toast" id="toast"></div>
  `;

  document.getElementById('modal-close')?.addEventListener('click', closeModal);
  document.getElementById('modal-overlay')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeModal();
  });

  // Render charts
  setTimeout(() => {
    const feedCanvas = document.getElementById('chart-feeds');
    if (feedCanvas) {
      renderBarChart(feedCanvas, {
        labels: ['Breast', 'Formula', 'Express'],
        values: [summary.feeds.breastFeedCount, summary.feeds.formulaCount, summary.feeds.expressCount],
        colors: ['#7C5CFC', '#FF8FA3', '#FF9F43']
      });
    }

    const sleepCanvas = document.getElementById('chart-sleep');
    if (sleepCanvas && summary.sleep.napCount > 0) {
      renderBarChart(sleepCanvas, {
        labels: ['Total (h)', 'Avg Nap (m)', 'Longest (m)'],
        values: [
          Math.round(summary.sleep.totalMinutes / 60 * 10) / 10,
          summary.sleep.avgNapMinutes,
          summary.sleep.longestNapMinutes
        ],
        colors: ['#6C63FF', '#4ECDC4', '#219B9D']
      });
    }

    const weightCanvas = document.getElementById('chart-weight');
    if (weightCanvas && summary.healthCare?.weightChecks?.length > 0) {
      const wChecks = summary.healthCare.weightChecks;
      renderLineChart(weightCanvas, {
        labels: wChecks.map(w => {
          const d = new Date(w.time);
          return `${d.getDate()}/${d.getMonth() + 1}`;
        }),
        values: wChecks.map(w => w.value)
      }, {
        lineColor: '#A29BFE'
      });
    }
  }, 100);

  // Share & Export buttons
  document.getElementById('btn-summary-share')?.addEventListener('click', async () => {
    const baby = profiles.find(p => p.id === settings.activeBabyId);
    try {
      await shareSummaryText(summary, baby, period);
    } catch (err) {
      showToast('Sharing failed');
    }
  });

  document.getElementById('export-csv')?.addEventListener('click', () => {
    const baby = profiles.find(p => p.id === settings.activeBabyId);
    exportCSV(summary.activities, baby?.name, period);
    showToast('CSV exported ✓');
  });

  document.getElementById('export-pdf')?.addEventListener('click', () => {
    exportPDF();
  });
}

// ==================== SETTINGS SCREEN ====================

function renderSettings() {
  currentView = 'settings';
  trackPageView('settings', 'Babylogs - Settings');
  const app = document.getElementById('app');
  const settings = getSettings();
  const config = getConfig();
  const categories = getActivityCategories();

  app.innerHTML = `
    <header class="header" id="header">
      <button class="header__menu-btn" id="back-btn" aria-label="Back">←</button>
      <span class="header__title">Settings</span>
      <span class="header__right"></span>
    </header>

    <div class="settings">
      <div class="settings__group">
        <div class="settings__group-title">Units</div>
        <div class="settings__row">
          <span class="settings__row-label">Volume</span>
          <select class="form-group__select" id="setting-volume" style="width: auto; padding: 6px 30px 6px 10px; font-size: 14px;">
            ${config.units.volume.options.map(o => `<option value="${o}" ${settings.unit?.volume === o ? 'selected' : ''}>${o}</option>`).join('')}
          </select>
        </div>
        <div class="settings__row">
          <span class="settings__row-label">Weight</span>
          <select class="form-group__select" id="setting-weight" style="width: auto; padding: 6px 30px 6px 10px; font-size: 14px;">
            ${config.units.weight.options.map(o => `<option value="${o}" ${settings.unit?.weight === o ? 'selected' : ''}>${o}</option>`).join('')}
          </select>
        </div>
        <div class="settings__row">
          <span class="settings__row-label">Temperature</span>
          <select class="form-group__select" id="setting-temp" style="width: auto; padding: 6px 30px 6px 10px; font-size: 14px;">
            ${config.units.temperature.options.map(o => `<option value="${o}" ${settings.unit?.temperature === o ? 'selected' : ''}>${o}</option>`).join('')}
          </select>
        </div>
      </div>

      <div class="settings__group">
        <div class="settings__group-title">Timeline</div>
        <div class="settings__row">
          <span class="settings__row-label">Sort Order</span>
          <select class="form-group__select" id="setting-timeline-sort" style="width: auto; padding: 6px 30px 6px 10px; font-size: 14px;">
            <option value="desc" ${(settings.timelineSortOrder || 'desc') === 'desc' ? 'selected' : ''}>Newest First (Descending)</option>
            <option value="asc" ${settings.timelineSortOrder === 'asc' ? 'selected' : ''}>Oldest First (Ascending)</option>
          </select>
        </div>
        <div class="settings__row">
          <div>
            <span class="settings__row-label">Inactive Gap Alerts</span>
            <div style="font-size: 11px; color: var(--color-text-secondary); margin-top: 2px;">Show timeline gap when no activity is logged</div>
          </div>
          <select class="form-group__select" id="setting-timeline-gap" style="width: auto; padding: 6px 30px 6px 10px; font-size: 14px;">
            <option value="15" ${Number(settings.timelineGapThreshold) === 15 ? 'selected' : ''}>After 15 mins</option>
            <option value="30" ${Number(settings.timelineGapThreshold) === 30 ? 'selected' : ''}>After 30 mins</option>
            <option value="45" ${Number(settings.timelineGapThreshold) === 45 ? 'selected' : ''}>After 45 mins</option>
            <option value="60" ${Number(settings.timelineGapThreshold) === 60 ? 'selected' : ''}>After 1 hour</option>
            <option value="90" ${Number(settings.timelineGapThreshold) === 90 ? 'selected' : ''}>After 1.5 hours</option>
            <option value="120" ${Number(settings.timelineGapThreshold) === 120 ? 'selected' : ''}>After 2 hours</option>
            <option value="180" ${Number(settings.timelineGapThreshold) === 180 ? 'selected' : ''}>After 3 hours</option>
            <option value="0" ${Number(settings.timelineGapThreshold) === 0 ? 'selected' : ''}>Off (Hidden)</option>
          </select>
        </div>
      </div>

      <div class="settings__group">
        <div class="settings__header-row">
          <div class="settings__group-title" style="margin-bottom: 0;">Default Duration</div>
          <button type="button" class="settings__reset-btn" id="btn-reset-durations" title="Reset all default durations">
            ↺ Reset Defaults
          </button>
        </div>
        <div style="font-size: 12px; color: var(--color-text-secondary); margin-bottom: 12px; line-height: 1.4;">
          Set default duration (in minutes) pre-filled when adding activities on the timeline:
        </div>

        ${Object.entries(categories).map(([catKey, cat]) => `
          <div style="font-size: 11px; font-weight: 700; color: var(--color-primary); margin: 14px 0 4px; text-transform: uppercase; letter-spacing: 0.5px; opacity: 0.9;">
            ${cat.icon} ${cat.label}
          </div>
          ${Object.entries(cat.types).map(([typeKey, type]) => {
    const currentDur = getActivityDefaultDuration(typeKey, settings);
    return `
              <div class="settings__row">
                <span class="settings__row-label" style="display: flex; align-items: center; gap: 8px;">
                  <span style="font-size: 16px;">${type.emoji || '📝'}</span>
                  <span>${type.label}</span>
                </span>
                <div style="display: flex; align-items: center; gap: 6px;">
                  <input type="number" 
                    class="form-group__input setting-duration-input" 
                    data-type="${typeKey}" 
                    data-label="${type.label}"
                    value="${currentDur}" 
                    min="0" 
                    max="1440" 
                    step="1" 
                    style="width: 70px; padding: 6px 8px; text-align: center; font-weight: 600; font-size: 13px;">
                  <span style="font-size: 12px; color: var(--color-text-muted); width: 24px;">min</span>
                </div>
              </div>
            `;
  }).join('')}
        `).join('')}
      </div>

      <div class="settings__group">
        <div class="settings__group-title">Notifications</div>
        <div class="settings__row">
          <span class="settings__row-label">Feed Reminders</span>
          <div class="toggle ${settings.notificationsEnabled ? 'active' : ''}" id="toggle-notifications">
            <div class="toggle__knob"></div>
          </div>
        </div>
        <div class="settings__row ${settings.notificationsEnabled ? '' : 'hidden'}" id="reminder-interval-row">
          <span class="settings__row-label">Remind after</span>
          <select class="form-group__select" id="setting-reminder" style="width: auto; padding: 6px 30px 6px 10px; font-size: 14px;">
            ${config.notifications.reminderOptions.map(m => `<option value="${m}" ${settings.feedReminderInterval === m ? 'selected' : ''}>${formatDuration(m)}</option>`).join('')}
          </select>
        </div>
        <div class="settings__subtext">
          ℹ️ <strong>Note:</strong> These are in-app notifications only and can only be received while the app is open. Since Babylogs runs 100% privately on your device without a cloud server, background alerts when the app is closed are not supported.
        </div>
      </div>

      <div class="settings__group">
        <div class="settings__group-title">Data Management</div>
        <div class="settings__row">
          <div>
            <div class="settings__row-label" style="color: var(--color-danger);">Clear All Data</div>
            <div style="font-size: 11px; color: var(--color-text-secondary); margin-top: 2px;">Permanently delete all profiles and activity logs</div>
          </div>
          <button class="btn btn--danger btn--sm" id="btn-clear-data" style="margin-left: 12px; white-space: nowrap;">
            🗑️ Clear All
          </button>
        </div>
      </div>
    </div>

    <!-- Modal Overlay -->
    <div class="modal-overlay" id="modal-overlay">
      <div class="modal" id="modal">
        <div class="modal__drag-handle"></div>
        <div class="modal__header">
          <h2 class="modal__title" id="modal-title"></h2>
          <button class="modal__close-btn" id="modal-close">✕</button>
        </div>
        <div class="modal__body" id="modal-body"></div>
        <div class="modal__footer" id="modal-footer"></div>
      </div>
    </div>

    <!-- Confirm Dialog Overlay -->
    <div class="confirm-overlay" id="confirm-overlay">
      <div class="confirm-dialog" id="confirm-dialog"></div>
    </div>

    <div class="toast" id="toast"></div>
  `;

  document.getElementById('back-btn').addEventListener('click', renderMain);
  document.getElementById('modal-close')?.addEventListener('click', closeModal);
  document.getElementById('modal-overlay')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeModal();
  });

  // Default duration change listeners
  document.querySelectorAll('.setting-duration-input').forEach(input => {
    input.addEventListener('change', (e) => {
      const typeKey = e.target.dataset.type;
      const typeLabel = e.target.dataset.label;
      const val = Math.max(0, parseInt(e.target.value) || 0);
      e.target.value = val;
      updateActivityDefaultDuration(typeKey, val);
      showToast(`${typeLabel} default: ${val} min ✓`);
    });
  });

  // Reset default durations
  document.getElementById('btn-reset-durations')?.addEventListener('click', () => {
    resetDefaultDurations();
    showToast('Default durations reset ✓');
    renderSettings();
  });

  // Clear all data
  document.getElementById('btn-clear-data')?.addEventListener('click', () => {
    showConfirm('Clear All Data', 'This will permanently delete ALL baby profiles and activity logs. This cannot be undone!', () => {
      showConfirm('Are you absolutely sure?', 'All data will be lost forever. Consider exporting first.', async () => {
        await clearAllData();
        showToast('All data cleared');
        renderWelcome();
      });
    });
  });

  // Timeline Sort Order change
  document.getElementById('setting-timeline-sort')?.addEventListener('change', (e) => {
    updateSetting('timelineSortOrder', e.target.value);
    showToast(`Timeline: ${e.target.value === 'desc' ? 'Newest first (Descending)' : 'Oldest first (Ascending)'}`);
  });

  // Timeline Gap Threshold change
  document.getElementById('setting-timeline-gap')?.addEventListener('change', (e) => {
    const val = parseInt(e.target.value) || 0;
    updateSetting('timelineGapThreshold', val);
    showToast(val === 0 ? 'Gap alerts turned off' : `Gap alert threshold: ${val} mins ✓`);
  });

  // Unit changes
  document.getElementById('setting-volume').addEventListener('change', (e) => {
    const unit = { ...settings.unit, volume: e.target.value };
    updateSetting('unit', unit);
    showToast(`Volume unit: ${e.target.value}`);
  });

  document.getElementById('setting-weight').addEventListener('change', (e) => {
    const unit = { ...settings.unit, weight: e.target.value };
    updateSetting('unit', unit);
    showToast(`Weight unit: ${e.target.value}`);
  });

  document.getElementById('setting-temp').addEventListener('change', (e) => {
    const unit = { ...settings.unit, temperature: e.target.value };
    updateSetting('unit', unit);
    showToast(`Temperature unit: ${e.target.value}`);
  });

  // Notification toggle
  document.getElementById('toggle-notifications').addEventListener('click', async (e) => {
    const toggle = e.currentTarget;
    const isActive = toggle.classList.contains('active');

    if (!isActive) {
      // Turning on
      if (isNotificationSupported()) {
        const permission = await requestPermission();
        if (permission) {
          toggle.classList.add('active');
          updateSetting('notificationsEnabled', true);
          document.getElementById('reminder-interval-row')?.classList.remove('hidden');
          startReminders(settings.activeBabyId);
          showToast('Notifications enabled 🔔');
        } else {
          showToast('Notification permission denied');
        }
      } else {
        showToast('Notifications not supported in this browser');
      }
    } else {
      // Turning off
      toggle.classList.remove('active');
      updateSetting('notificationsEnabled', false);
      document.getElementById('reminder-interval-row')?.classList.add('hidden');
      stopReminders();
      showToast('Notifications disabled');
    }
  });

  // Reminder interval change
  document.getElementById('setting-reminder')?.addEventListener('change', (e) => {
    const interval = parseInt(e.target.value);
    updateSetting('feedReminderInterval', interval);
    stopReminders();
    startReminders(settings.activeBabyId);
    showToast(`Reminder: every ${formatDuration(interval)}`);
  });
}

// ==================== PWA INSTALL ====================

function detectOS() {
  const ua = navigator.userAgent || navigator.vendor || window.opera || '';
  if (/iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) {
    return 'ios';
  }
  if (/android/i.test(ua)) {
    return 'android';
  }
  return 'desktop';
}

function triggerInstall() {
  showInstallGuideModal();
}

function showInstallGuideModal(requestedTab = null) {
  const detected = requestedTab || detectOS();
  trackPWAInstall('view_guide', detected);
  const overlay = document.getElementById('modal-overlay');
  const title = document.getElementById('modal-title');
  const body = document.getElementById('modal-body');
  const footer = document.getElementById('modal-footer');

  if (!overlay || !title || !body || !footer) return;

  title.textContent = 'Install Babylogs App';

  function renderTabContent(tab) {
    if (tab === 'ios') {
      return `
        <div class="install-guide-content">
          <div style="font-size: 13px; color: var(--color-text-secondary); margin-bottom: 4px;">
            Install Babylogs on your <strong>iPhone or iPad</strong>:
          </div>
          <div class="install-steps-list">
            <div class="install-step-item">
              <div class="install-step-num">1</div>
              <div class="install-step-text">Open <strong>babylogs.plotkai.in</strong> in <strong>Safari</strong> browser</div>
            </div>
            <div class="install-step-item">
              <div class="install-step-num">2</div>
              <div class="install-step-text">Tap the <strong>Share button</strong> <span style="font-size: 15px;">⎋</span> (the square icon with arrow pointing up in bottom bar)</div>
            </div>
            <div class="install-step-item">
              <div class="install-step-num">3</div>
              <div class="install-step-text">Scroll down and tap <strong>"Add to Home Screen"</strong> <span style="font-size: 15px;">⊞</span></div>
            </div>
            <div class="install-step-item">
              <div class="install-step-num">4</div>
              <div class="install-step-text">Tap <strong>"Add"</strong> in the top right corner</div>
            </div>
          </div>
        </div>
      `;
    }

    if (tab === 'android') {
      return `
        <div class="install-guide-content">
          ${deferredInstallPrompt ? `
            <div style="margin-bottom: 12px; text-align: center;">
              <button class="btn btn--primary btn--full" id="btn-native-pwa-install" style="padding: 12px; font-size: 14px;">
                ⚡ Install App Directly
              </button>
            </div>
            <div style="text-align: center; font-size: 11px; color: var(--color-text-muted); margin-bottom: 10px;">— or install via browser menu —</div>
          ` : ''}
          <div style="font-size: 13px; color: var(--color-text-secondary); margin-bottom: 4px;">
            Install on <strong>Android</strong> (Chrome / Samsung Internet):
          </div>
          <div class="install-steps-list">
            <div class="install-step-item">
              <div class="install-step-num">1</div>
              <div class="install-step-text">Tap the <strong>Menu button</strong> (<strong>⋮</strong> three dots in top-right or bottom)</div>
            </div>
            <div class="install-step-item">
              <div class="install-step-num">2</div>
              <div class="install-step-text">Select <strong>"Install app"</strong> or <strong>"Add to Home screen"</strong></div>
            </div>
            <div class="install-step-item">
              <div class="install-step-num">3</div>
              <div class="install-step-text">Tap <strong>"Install"</strong> in the confirmation popup</div>
            </div>
          </div>
        </div>
      `;
    }

    // desktop / other
    return `
      <div class="install-guide-content">
        ${deferredInstallPrompt ? `
          <div style="margin-bottom: 12px; text-align: center;">
            <button class="btn btn--primary btn--full" id="btn-native-pwa-install" style="padding: 12px; font-size: 14px;">
              ⚡ Install App on Desktop
            </button>
          </div>
          <div style="text-align: center; font-size: 11px; color: var(--color-text-muted); margin-bottom: 10px;">— or install via browser menu —</div>
        ` : ''}
        <div style="font-size: 13px; color: var(--color-text-secondary); margin-bottom: 4px;">
          Install on <strong>Chrome, Edge, Safari or Brave</strong>:
        </div>
        <div class="install-steps-list">
          <div class="install-step-item">
            <div class="install-step-num">1</div>
            <div class="install-step-text">Click the <strong>Install icon</strong> (<strong>⊕</strong> or computer icon) in the right side of the address bar</div>
          </div>
          <div class="install-step-item">
            <div class="install-step-num">2</div>
            <div class="install-step-text">Click <strong>"Install"</strong> to add Babylogs as a desktop app</div>
          </div>
        </div>
      </div>
    `;
  }

  body.innerHTML = `
    <div class="install-guide-tabs">
      <button class="install-guide-tab ${detected === 'ios' ? 'active' : ''}" data-tab="ios">🍎 iOS / iPhone</button>
      <button class="install-guide-tab ${detected === 'android' ? 'active' : ''}" data-tab="android">🤖 Android</button>
      <button class="install-guide-tab ${detected === 'desktop' ? 'active' : ''}" data-tab="desktop">💻 Desktop</button>
    </div>

    <div id="install-guide-body">
      ${renderTabContent(detected)}
    </div>

    <div class="install-guide-benefits">
      <span>⚡ 100% Offline</span>
      <span>🔒 Zero Cloud Privacy</span>
      <span>📱 Full Screen</span>
    </div>
  `;

  footer.innerHTML = `
    <button class="btn btn--primary btn--full" id="modal-cancel">Got it</button>
  `;

  overlay.classList.add('active');

  // Tab switching
  document.querySelectorAll('.install-guide-tab').forEach(tabBtn => {
    tabBtn.addEventListener('click', () => {
      document.querySelectorAll('.install-guide-tab').forEach(t => t.classList.remove('active'));
      tabBtn.classList.add('active');
      const guideBody = document.getElementById('install-guide-body');
      if (guideBody) {
        guideBody.innerHTML = renderTabContent(tabBtn.dataset.tab);
        bindNativeInstall();
      }
    });
  });

  function bindNativeInstall() {
    const nativeBtn = document.getElementById('btn-native-pwa-install');
    nativeBtn?.addEventListener('click', async () => {
      if (deferredInstallPrompt) {
        deferredInstallPrompt.prompt();
        const { outcome } = await deferredInstallPrompt.userChoice;
        trackPWAInstall('prompt_click', outcome);
        if (outcome === 'accepted') {
          showToast('Installing Babylogs app...');
        }
        deferredInstallPrompt = null;
        closeModal();
      }
    });
  }

  bindNativeInstall();
  document.getElementById('modal-cancel')?.addEventListener('click', closeModal);
}

function updateInstallButtons() {
  const welcomeBtn = document.getElementById('welcome-install-btn');
  const navBtn = document.getElementById('nav-install');
  const isPWA = window.matchMedia('(display-mode: standalone)').matches;

  if (isPWA) {
    welcomeBtn?.classList.add('hidden');
    navBtn?.classList.add('hidden');
  } else {
    welcomeBtn?.classList.remove('hidden');
    navBtn?.classList.remove('hidden');
  }
}

// ==================== CONFIRM DIALOG ====================

function showConfirm(title, message, onConfirm, confirmLabel = 'Confirm') {
  const overlay = document.getElementById('confirm-overlay');
  const dialog = document.getElementById('confirm-dialog');
  if (!overlay || !dialog) return;

  dialog.innerHTML = `
    <div class="confirm-dialog__title">${title}</div>
    <div class="confirm-dialog__message">${message.replace(/\n/g, '<br>')}</div>
    <div class="confirm-dialog__actions">
      ${onConfirm ? '<button class="btn btn--secondary" id="confirm-cancel">Cancel</button>' : ''}
      <button class="btn btn--primary" id="confirm-ok">${onConfirm ? confirmLabel : confirmLabel}</button>
    </div>
  `;

  overlay.classList.add('active');

  document.getElementById('confirm-cancel')?.addEventListener('click', () => {
    overlay.classList.remove('active');
  });

  document.getElementById('confirm-ok').addEventListener('click', () => {
    overlay.classList.remove('active');
    if (onConfirm) onConfirm();
  });
}

// ==================== TOAST ====================

let toastTimer;
function showToast(message) {
  const toast = document.getElementById('toast');
  if (!toast) return;

  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add('show');

  toastTimer = setTimeout(() => {
    toast.classList.remove('show');
  }, 2500);
}

// ==================== BOOT ====================

document.addEventListener('DOMContentLoaded', init);
