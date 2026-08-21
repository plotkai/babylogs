// js/analytics.js — Google Analytics 4 (GA4) integration & custom event tracking

export const GA_MEASUREMENT_ID = 'G-0Z45Q5363P';

/**
 * Get or create persistent anonymous user id for cross-session unique user identification
 */
export function getAnonymousUserId() {
  try {
    const key = 'babylogs_analytics_uid';
    let uid = localStorage.getItem(key);
    if (!uid) {
      uid = 'u_' + Math.random().toString(36).substring(2, 11) + '_' + Date.now().toString(36);
      localStorage.setItem(key, uid);
    }
    return uid;
  } catch {
    return null;
  }
}

/**
 * Generic GA4 Event Dispatcher
 */
export function trackEvent(eventName, eventParams = {}) {
  try {
    if (typeof window.gtag === 'function') {
      window.gtag('event', eventName, {
        ...eventParams,
        user_id: getAnonymousUserId(),
        app_name: 'Babylogs by Plotkai',
        send_to: GA_MEASUREMENT_ID
      });
    }
  } catch (err) {
    console.debug('Analytics event failed:', err);
  }
}

/**
 * Track virtual page views (SPA view navigation)
 */
export function trackPageView(viewName, title = '') {
  trackEvent('page_view', {
    page_title: title || `Babylogs - ${viewName}`,
    page_location: `${window.location.origin}/#${viewName}`,
    page_path: `/#${viewName}`
  });
}

/**
 * Track when an activity is logged or updated
 */
export function trackActivityLogged(eventType, isEdit = false) {
  trackEvent(isEdit ? 'activity_updated' : 'activity_logged', {
    event_category: 'Activity',
    activity_type: eventType
  });
}

/**
 * Track export actions
 */
export function trackDataExport(format, rangeType) {
  trackEvent('data_exported', {
    event_category: 'Data Management',
    export_format: format,
    date_range: rangeType
  });
}

/**
 * Track import actions
 */
export function trackDataImport(mode, profileCount, activityCount) {
  trackEvent('data_imported', {
    event_category: 'Data Management',
    import_mode: mode,
    profiles_count: profileCount,
    activities_count: activityCount
  });
}

/**
 * Track PWA install interactions
 */
export function trackPWAInstall(action, outcome = null) {
  trackEvent('pwa_interaction', {
    event_category: 'PWA',
    pwa_action: action,
    pwa_outcome: outcome
  });
}
