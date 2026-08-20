// js/app.js — Main app logic, routing, UI rendering

import { loadConfig, getConfig, getAllActivityTypes, getActivityType, getActivityCategories, getAdBannerConfig, getAppConfig } from './config.js';
import { getProfiles, addProfile, updateProfile, deleteProfile, getSettings, updateSetting, saveSettings, getActivitiesByDate, addActivity, updateActivity, deleteActivity, clearAllData, getSettings as getAppSettings } from './db.js';
import { generateId, formatTime, formatTimeRange, formatDateDisplay, formatDateFull, formatDateKey, formatDuration, calculateEndTime, buildDisplayText, getAgeString, isToday, isThisWeek, isThisMonth, formatWeekRange, formatMonthDisplay } from './utils.js';
import { startReminders, stopReminders, getLastFeedElapsed, requestPermission, isNotificationSupported } from './notifications.js';
import { exportJSON, importJSON, exportCSV, exportPDF } from './export.js';
import { computeSummary, getDateRange, comparePerformance, renderBarChart, renderLineChart } from './summary.js';

// ==================== STATE ====================
let currentView = 'welcome'; // 'welcome' | 'main' | 'summary' | 'settings'
let currentDate = new Date();
let summaryDate = new Date();
let summaryPeriod = 'day';
let currentActivities = [];
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
}

// ==================== WELCOME SCREEN ====================

function renderWelcome() {
  currentView = 'welcome';
  const app = document.getElementById('app');
  const appConfig = getAppConfig();

  app.innerHTML = `
    <div class="welcome" id="welcome-screen">
      <div class="welcome__logo">👶</div>
      <h1 class="welcome__title">
        <span class="welcome__title-main">Babylogs</span>
        <span class="welcome__title-sub">by Plotkai</span>
      </h1>
      <p class="welcome__subtitle">${appConfig.description || 'Track your baby\'s feeds, diapers, sleep and more'}</p>

      <form class="welcome__form" id="welcome-form">
        <div class="form-group">
          <label class="form-group__label">Baby's Name</label>
          <input type="text" class="form-group__input" id="welcome-name" placeholder="Enter baby's name" required autocomplete="off">
        </div>
        <div class="form-group">
          <label class="form-group__label">Date of Birth</label>
          <input type="date" class="form-group__input" id="welcome-dob" required max="${formatDateKey(new Date())}">
        </div>
        <div class="welcome__cta">
          <button type="submit" class="btn btn--primary btn--full">Get Started 🚀</button>
        </div>
        <button type="button" class="btn welcome__install-btn btn--full ${deferredInstallPrompt ? '' : 'hidden'}" id="welcome-install-btn">
          📲 Install App
        </button>
      </form>
    </div>
  `;

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
  const app = document.getElementById('app');
  const appConfig = getAppConfig();
  const adConfig = getAdBannerConfig();
  const profiles = getProfiles();
  const settings = getSettings();
  const activeBaby = profiles.find(p => p.id === settings.activeBabyId);

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
      <span class="header__right"></span>
    </header>

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
    ` : '<div style="margin-top: var(--header-height)"></div>'}

    <!-- Baby Switcher -->
    <div class="baby-switcher" id="baby-switcher" style="margin-top: ${adConfig.enabled ? '0' : 'var(--header-height)'}">
      <div class="baby-switcher__current" id="baby-switcher-toggle">
        <div class="baby-switcher__avatar">${activeBaby.name.charAt(0).toUpperCase()}</div>
        <div>
          <div class="baby-switcher__name">${activeBaby.name}</div>
          <div class="baby-switcher__age">${getAgeString(activeBaby.dob)} old</div>
        </div>
        <span class="baby-switcher__dropdown-icon" id="switcher-arrow">▼</span>
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

    <!-- Last Feed Timer -->
    <div class="last-feed-timer" id="last-feed-timer">
      <span class="last-feed-timer__icon">🍼</span>
      <span class="last-feed-timer__text">Last feed: </span>
      <span class="last-feed-timer__time" id="feed-timer-value">loading...</span>
    </div>

    <!-- Timeline -->
    <div class="timeline" id="timeline"></div>

    <!-- FAB -->
    <button class="fab" id="fab" aria-label="Add activity">＋</button>

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

  // FAB
  document.getElementById('fab').addEventListener('click', () => openActivityModal());

  // Modal close
  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('modal-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'modal-overlay') closeModal();
  });

  // Baby switcher
  document.getElementById('baby-switcher-toggle').addEventListener('click', toggleBabySwitcher);

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

// ==================== TIMELINE ====================

async function loadTimeline() {
  const settings = getSettings();
  const dateKey = formatDateKey(currentDate);
  currentActivities = await getActivitiesByDate(settings.activeBabyId, dateKey);

  const timeline = document.getElementById('timeline');
  if (!timeline) return;

  if (currentActivities.length === 0) {
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

  const allTypes = getAllActivityTypes();

  timeline.innerHTML = currentActivities.map((activity, i) => {
    const typeConfig = allTypes[activity.eventType] || {};
    const timeStr = activity.endTime
      ? formatTimeRange(activity.startTime, activity.endTime)
      : formatTime(activity.startTime);
    const durationStr = activity.duration ? formatDuration(activity.duration) : '';

    return `
      <div class="activity-card" data-id="${activity.id}" style="border-left-color: ${typeConfig.color || '#ccc'}; animation-delay: ${i * 0.05}s;">
        <span class="activity-card__emoji">${typeConfig.emoji || '📋'}</span>
        <div class="activity-card__content">
          <div class="activity-card__time">${timeStr}</div>
          <div class="activity-card__description">${activity.displayText || typeConfig.label || activity.eventType}</div>
          ${activity.notes ? `<div class="activity-card__notes">${activity.notes}</div>` : ''}
        </div>
        ${durationStr ? `<span class="activity-card__duration">${durationStr}</span>` : ''}
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

function openActivityModal(activity = null, presetType = null) {
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
    : `${formatDateKey(currentDate)}T${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  const selectedType = activity ? activity.eventType : (presetType || '');

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
      <select class="form-group__select" id="modal-event-type">
        <option value="">Select event type...</option>
        ${Object.entries(categories).map(([catKey, cat]) => `
          <optgroup label="${cat.icon} ${cat.label}">
            ${Object.entries(cat.types).map(([typeKey, type]) => `
              <option value="${typeKey}" ${typeKey === selectedType ? 'selected' : ''}>${type.emoji || ''} ${type.label}</option>
            `).join('')}
          </optgroup>
        `).join('')}
      </select>
    </div>

    <div class="form-group">
      <label class="form-group__label">Duration (minutes)</label>
      <input type="number" class="form-group__input" id="modal-duration" placeholder="e.g. 15" min="0" value="${activity ? (activity.duration ?? '') : (selectedType ? (getActivityType(selectedType)?.defaultDuration ?? '') : '')}">
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

  // Render dynamic fields for pre-selected type
  if (selectedType) {
    renderDynamicFields(selectedType, activity?.subFields);
  }

  // Event type change → render dynamic fields & auto-populate default duration
  document.getElementById('modal-event-type').addEventListener('change', (e) => {
    const val = e.target.value;
    renderDynamicFields(val);
    if (!activity && val) {
      const typeConfig = getActivityType(val);
      const durationInput = document.getElementById('modal-duration');
      if (durationInput && typeConfig && typeConfig.defaultDuration !== undefined) {
        durationInput.value = typeConfig.defaultDuration;
      }
    }
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
    } else {
      await addActivity(entry);
      showToast('Activity added ✓');
    }

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
      <input type="date" class="form-group__input" id="add-baby-dob" required max="${formatDateKey(new Date())}">
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
    closeModal();
    renderMain();
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
    <button class="sidebar__item" id="nav-edit-profile">
      <span class="sidebar__item-icon">✏️</span> Edit Baby Profile
    </button>
    <button class="sidebar__item" id="nav-add-baby">
      <span class="sidebar__item-icon">👶</span> Add Baby
    </button>
    <button class="sidebar__item" id="nav-settings">
      <span class="sidebar__item-icon">⚙️</span> Settings
    </button>
    <div class="sidebar__divider"></div>
    <button class="sidebar__item" id="nav-export">
      <span class="sidebar__item-icon">📤</span> Export Data
    </button>
    <button class="sidebar__item" id="nav-import">
      <span class="sidebar__item-icon">📥</span> Import Data
    </button>
    ${isInstallable && !isPWA ? `
    <div class="sidebar__divider"></div>
    <button class="sidebar__item" id="nav-install">
      <span class="sidebar__item-icon">📲</span> Install App
    </button>
    ` : ''}
    <div class="sidebar__divider"></div>
    <button class="sidebar__item sidebar__item--danger" id="nav-clear">
      <span class="sidebar__item-icon">🗑️</span> Clear All Data
    </button>
    <button class="sidebar__item" id="nav-about">
      <span class="sidebar__item-icon">ℹ️</span> About
    </button>
  `;

  // Bind sidebar actions
  document.getElementById('nav-summary')?.addEventListener('click', () => { closeSidebar(); renderSummary(); });
  document.getElementById('nav-edit-profile')?.addEventListener('click', () => { closeSidebar(); openEditProfileModal(); });
  document.getElementById('nav-add-baby')?.addEventListener('click', () => { closeSidebar(); openAddBabyModal(); });
  document.getElementById('nav-settings')?.addEventListener('click', () => { closeSidebar(); renderSettings(); });
  document.getElementById('nav-export')?.addEventListener('click', async () => {
    closeSidebar();
    try { await exportJSON(); showToast('Data exported ✓'); } catch { showToast('Export failed'); }
  });
  document.getElementById('nav-import')?.addEventListener('click', async () => {
    closeSidebar();
    try {
      const result = await importJSON();
      if (result) { showToast('Data imported ✓'); renderMain(); }
    } catch { showToast('Import failed'); }
  });
  document.getElementById('nav-install')?.addEventListener('click', () => { closeSidebar(); triggerInstall(); });
  document.getElementById('nav-clear')?.addEventListener('click', () => {
    closeSidebar();
    showConfirm('Clear All Data', 'This will permanently delete ALL baby profiles and activity logs. This cannot be undone!', () => {
      showConfirm('Are you absolutely sure?', 'All data will be lost forever. Consider exporting first.', async () => {
        await clearAllData();
        showToast('All data cleared');
        renderWelcome();
      });
    });
  });
  document.getElementById('nav-about')?.addEventListener('click', () => {
    closeSidebar();
    const appConfig = getAppConfig();
    showConfirm(appConfig.title, `Version ${appConfig.version}\n\nA baby activity tracker built with ❤️ by Plotkai.\n\nAll data is stored locally in your browser.`, null, 'Got it');
  });
}

function openSidebar() {
  document.getElementById('sidebar-overlay')?.classList.add('active');
}

function closeSidebar() {
  document.getElementById('sidebar-overlay')?.classList.remove('active');
}

// ==================== EDIT PROFILE ====================

function openEditProfileModal() {
  const settings = getSettings();
  const profiles = getProfiles();
  const baby = profiles.find(p => p.id === settings.activeBabyId);
  if (!baby) return;

  const overlay = document.getElementById('modal-overlay');
  const title = document.getElementById('modal-title');
  const body = document.getElementById('modal-body');
  const footer = document.getElementById('modal-footer');

  title.textContent = 'Edit Baby Profile';
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

  const canDelete = profiles.length > 1;
  footer.innerHTML = `
    ${canDelete ? '<button class="btn btn--danger btn--sm" id="delete-profile-btn">Delete Baby</button>' : ''}
    <button class="btn btn--secondary" id="modal-cancel">Cancel</button>
    <button class="btn btn--primary" id="save-profile-btn">Save</button>
  `;

  overlay.classList.add('active');

  document.getElementById('modal-cancel').addEventListener('click', closeModal);
  document.getElementById('save-profile-btn').addEventListener('click', () => {
    const name = document.getElementById('edit-name').value.trim();
    const dob = document.getElementById('edit-dob').value;
    if (!name || !dob) { showToast('Please fill all fields'); return; }

    updateProfile(baby.id, { name, dob });
    closeModal();
    renderMain();
    showToast('Profile updated ✓');
  });

  document.getElementById('delete-profile-btn')?.addEventListener('click', () => {
    closeModal();
    showConfirm('Delete Baby', `Are you sure you want to delete ${baby.name} and all their data?`, async () => {
      deleteProfile(baby.id);
      const remaining = getProfiles();
      if (remaining.length > 0) {
        updateSetting('activeBabyId', remaining[0].id);
        renderMain();
      } else {
        renderWelcome();
      }
      showToast(`${baby.name} deleted`);
    });
  });
}

// ==================== SUMMARY SCREEN ====================

async function renderSummary() {
  currentView = 'summary';
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
    ` : '<div style="margin-top: var(--header-height)"></div>'}

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
  const performance = comparePerformance(summary, baby.dob);

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

    <!-- Expected Performance -->
    ${performance ? `
    <div class="summary__card">
      <div class="summary__card-title">📈 Expected Performance — ${performance.bracketLabel}</div>
      ${performance.metrics.map(m => `
        <div class="perf-metric perf-metric--${m.status}">
          <div class="perf-metric__label">
            <span>${m.label}</span>
            <span class="perf-metric__actual">${m.actual}${m.unit} ${m.status === 'ok' ? '✓' : m.status === 'warn' ? '⚠' : '✗'}</span>
          </div>
          <div class="perf-metric__bar">
            <div class="perf-metric__bar-fill" style="width: ${Math.min((m.actual / m.max) * 100, 100)}%"></div>
          </div>
          <div class="perf-metric__expected">Expected: ${m.min} – ${m.max} per day</div>
        </div>
      `).join('')}
      <p style="font-size: 13px; color: var(--color-text-secondary); margin-top: 8px; line-height: 1.5;">
        💡 ${performance.notes}
      </p>
    </div>
    ` : ''}

    <!-- Export -->
    <div class="summary__export-btns">
      <button class="btn btn--secondary btn--sm" id="export-csv">📄 CSV</button>
      <button class="btn btn--secondary btn--sm" id="export-pdf">📋 PDF</button>
    </div>
  `;

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
  }, 100);

  // Export buttons
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
  const app = document.getElementById('app');
  const settings = getSettings();
  const config = getConfig();

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
      </div>
    </div>

    <div class="toast" id="toast"></div>
  `;

  document.getElementById('back-btn').addEventListener('click', renderMain);

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

async function triggerInstall() {
  if (!deferredInstallPrompt) {
    showToast('Install not available — try from your browser menu');
    return;
  }

  deferredInstallPrompt.prompt();
  const { outcome } = await deferredInstallPrompt.userChoice;
  if (outcome === 'accepted') {
    showToast('Installing app...');
  }
  deferredInstallPrompt = null;
  updateInstallButtons();
}

function updateInstallButtons() {
  const welcomeBtn = document.getElementById('welcome-install-btn');
  const navBtn = document.getElementById('nav-install');

  if (deferredInstallPrompt) {
    welcomeBtn?.classList.remove('hidden');
    navBtn?.classList.remove('hidden');
  } else {
    welcomeBtn?.classList.add('hidden');
    navBtn?.classList.add('hidden');
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
