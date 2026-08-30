// js/utils.js — Date/time formatters & helpers

/**
 * Generate a UUID v4
 */
export function generateId() {
  return crypto.randomUUID ? crypto.randomUUID() :
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}

/**
 * Format a Date or time string to "11:46 AM"
 */
export function formatTime(date) {
  const d = date instanceof Date ? date : new Date(date);
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

/**
 * Format a time range: "11:46 AM - 12:10 PM"
 */
export function formatTimeRange(start, end) {
  return `${formatTime(start)} - ${formatTime(end)}`;
}

/**
 * Format a Date to "18 August"
 */
export function formatDateDisplay(date) {
  const d = date instanceof Date ? date : new Date(date);
  return d.toLocaleDateString('en-US', { day: 'numeric', month: 'long' });
}

/**
 * Format a Date to "18 August 2026"
 */
export function formatDateFull(date) {
  const d = date instanceof Date ? date : new Date(date);
  return d.toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric' });
}

/**
 * Format a date to YYYY-MM-DD for storage keys
 */
export function formatDateKey(date) {
  const d = date instanceof Date ? date : new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Format duration in minutes to human string: "24 min" or "1h 30m"
 */
export function formatDuration(minutes) {
  if (!minutes || minutes <= 0) return '';
  const mins = Math.round(minutes);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

/**
 * Get baby's age in days from DOB
 */
export function getAgeInDays(dob) {
  const birth = new Date(dob);
  const today = new Date();
  const diff = today.getTime() - birth.getTime();
  return Math.floor(diff / (1000 * 60 * 60 * 24));
}

/**
 * Get age bracket key from config based on DOB
 */
export function getAgeBracket(dob, expectedPerformance) {
  const ageDays = getAgeInDays(dob);
  for (const [key, bracket] of Object.entries(expectedPerformance)) {
    if (ageDays >= bracket.ageMinDays && ageDays <= bracket.ageMaxDays) {
      return key;
    }
  }
  // If older than 12 months, return the last bracket
  return '6-12_months';
}

/**
 * Get human-readable age string: "1 month 5 days" or "3 weeks 2 days"
 */
export function getAgeString(dob) {
  const days = getAgeInDays(dob);
  if (days < 7) return `${days} day${days !== 1 ? 's' : ''}`;
  if (days < 30) {
    const weeks = Math.floor(days / 7);
    const remDays = days % 7;
    let s = `${weeks} week${weeks !== 1 ? 's' : ''}`;
    if (remDays > 0) s += ` ${remDays} day${remDays !== 1 ? 's' : ''}`;
    return s;
  }
  const months = Math.floor(days / 30);
  const remDays = days % 30;
  let s = `${months} month${months !== 1 ? 's' : ''}`;
  if (remDays > 0) s += ` ${remDays} day${remDays !== 1 ? 's' : ''}`;
  return s;
}

/**
 * Calculate end time from start time + duration in minutes
 */
export function calculateEndTime(startTime, durationMinutes) {
  const start = new Date(startTime);
  return new Date(start.getTime() + durationMinutes * 60 * 1000);
}

/**
 * Build display text for timeline from event type config and sub-field values
 * e.g. "Breast Feed - Right - Actively"
 */
export function buildDisplayText(eventTypeConfig, subFields, unitSettings) {
  const parts = [eventTypeConfig.label];

  if (eventTypeConfig.fields && subFields) {
    for (const field of eventTypeConfig.fields) {
      const val = subFields[field.key];
      if (val !== undefined && val !== null && val !== '') {
        if (field.type === 'multi-select' && Array.isArray(val)) {
          parts.push(val.join('/'));
        } else if (field.type === 'number' && field.unit) {
          const unit = unitSettings?.[field.unit]?.current || unitSettings?.[field.unit]?.default || '';
          const valStr = String(val).trim();
          const hasUnit = /\b(ml|oz|kg|lb|lbs|°C|°F)\b/i.test(valStr);
          parts.push(hasUnit ? valStr : `${valStr} ${unit}`.trim());
        } else if (field.type === 'checkbox') {
          if (val === true) {
            parts.push(field.label);
          }
        } else {
          parts.push(String(val));
        }
      }
    }
  }

  return parts.join(' - ');
}

/**
 * Convert value between units (e.g. ml ↔ oz)
 */
export function convertUnit(value, unitType, fromUnit, toUnit, unitsConfig) {
  if (fromUnit === toUnit) return value;
  const config = unitsConfig[unitType];
  if (!config) return value;

  if (unitType === 'temperature') {
    if (fromUnit === '°F' && toUnit === '°C') return Math.round(((value - 32) * 5 / 9) * 10) / 10;
    if (fromUnit === '°C' && toUnit === '°F') return Math.round((value * 9 / 5 + 32) * 10) / 10;
    return value;
  }

  // For volume (ml→oz) and weight (kg→lb): multiply by conversion factor
  // For reverse: divide
  const defaultUnit = config.options[0];
  if (fromUnit === defaultUnit) {
    return Math.round(value * config.conversionFactor * 100) / 100;
  } else {
    return Math.round(value / config.conversionFactor * 100) / 100;
  }
}

/**
 * Check if a date is today
 */
export function isToday(date) {
  const d = date instanceof Date ? date : new Date(date);
  const today = new Date();
  return d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
}

/**
 * Get start of day for a date
 */
export function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Get start of week (Monday) for a date
 */
export function startOfWeek(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Get start of month for a date
 */
export function startOfMonth(date) {
  const d = new Date(date);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Check if a date is in current week
 */
export function isThisWeek(date) {
  const d = date instanceof Date ? date : new Date(date);
  const now = new Date();
  const currentWeekStart = startOfWeek(now);
  const targetWeekStart = startOfWeek(d);
  return currentWeekStart.getTime() === targetWeekStart.getTime();
}

/**
 * Check if a date is in current month
 */
export function isThisMonth(date) {
  const d = date instanceof Date ? date : new Date(date);
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
}

/**
 * Format week range: e.g. "17 Aug - 23 Aug"
 */
export function formatWeekRange(startDate, endDate) {
  const s = startDate instanceof Date ? startDate : new Date(startDate);
  const e = endDate instanceof Date ? endDate : new Date(endDate);
  const sMonth = s.toLocaleDateString('en-US', { month: 'short' });
  const eMonth = e.toLocaleDateString('en-US', { month: 'short' });
  const sDay = s.getDate();
  const eDay = e.getDate();

  if (s.getFullYear() !== e.getFullYear()) {
    return `${sDay} ${sMonth} ${s.getFullYear()} - ${eDay} ${eMonth} ${e.getFullYear()}`;
  }
  if (sMonth === eMonth) {
    return `${sDay} - ${eDay} ${sMonth}`;
  }
  return `${sDay} ${sMonth} - ${eDay} ${eMonth}`;
}

/**
 * Format month display: e.g. "August 2026"
 */
export function formatMonthDisplay(date) {
  const d = date instanceof Date ? date : new Date(date);
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

/**
 * Debounce function
 */
export function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}
