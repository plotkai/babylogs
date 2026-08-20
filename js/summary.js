// js/summary.js — Summary analytics computation & chart rendering

import { getActivitiesByRange } from './db.js';
import { getExpectedPerformance, getUnitsConfig } from './config.js';
import { formatDateKey, getAgeBracket, startOfWeek, startOfMonth } from './utils.js';
import { getSettings } from './db.js';

/**
 * Compute summary statistics for a baby over a date range
 */
export async function computeSummary(babyId, startDate, endDate) {
  const startKey = formatDateKey(startDate);
  const endKey = formatDateKey(endDate);
  const activities = await getActivitiesByRange(babyId, startKey, endKey);

  // Calculate number of days in range
  const dayCount = Math.max(1, Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24)) + 1);

  const summary = {
    totalActivities: activities.length,
    dayCount,
    feeds: {
      breastFeedCount: 0,
      breastFeedMinutes: 0,
      formulaCount: 0,
      formulaTotalQty: 0,
      expressCount: 0,
      expressTotalQty: 0,
      totalFeedCount: 0,
      avgIntervalMinutes: 0
    },
    output: {
      poopCount: 0,
      wetCount: 0,
      diaperChangeCount: 0,
      poopColors: {},
      poopConsistencies: {}
    },
    sleep: {
      totalMinutes: 0,
      napCount: 0,
      avgNapMinutes: 0,
      longestNapMinutes: 0
    },
    other: {
      tummyTimeCount: 0,
      tummyTimeMinutes: 0,
      playtimeCount: 0,
      playtimeMinutes: 0,
      bathCount: 0,
      medicineCount: 0,
      massageCount: 0,
      massageMinutes: 0
    },
    activities // raw data for export
  };

  // Feed interval tracking
  const feedTimes = [];

  for (const a of activities) {
    const duration = a.duration || 0;

    switch (a.eventType) {
      case 'breast_feed':
        summary.feeds.breastFeedCount++;
        summary.feeds.breastFeedMinutes += duration;
        summary.feeds.totalFeedCount++;
        feedTimes.push(new Date(a.startTime));
        break;
      case 'formula_feed':
        summary.feeds.formulaCount++;
        summary.feeds.formulaTotalQty += parseFloat(a.subFields?.quantity) || 0;
        summary.feeds.totalFeedCount++;
        feedTimes.push(new Date(a.startTime));
        break;
      case 'express_feed':
        summary.feeds.expressCount++;
        summary.feeds.expressTotalQty += parseFloat(a.subFields?.quantity) || 0;
        summary.feeds.totalFeedCount++;
        feedTimes.push(new Date(a.startTime));
        break;
      case 'poop':
        summary.output.poopCount++;
        if (a.subFields?.color) {
          summary.output.poopColors[a.subFields.color] = (summary.output.poopColors[a.subFields.color] || 0) + 1;
        }
        if (a.subFields?.consistency) {
          summary.output.poopConsistencies[a.subFields.consistency] = (summary.output.poopConsistencies[a.subFields.consistency] || 0) + 1;
        }
        break;
      case 'wet':
        summary.output.wetCount++;
        break;
      case 'diaper_change':
        summary.output.diaperChangeCount++;
        break;
      case 'sleep':
        summary.sleep.totalMinutes += duration;
        summary.sleep.napCount++;
        if (duration > summary.sleep.longestNapMinutes) {
          summary.sleep.longestNapMinutes = duration;
        }
        break;
      case 'tummy_time':
        summary.other.tummyTimeCount++;
        summary.other.tummyTimeMinutes += duration;
        break;
      case 'playtime':
        summary.other.playtimeCount++;
        summary.other.playtimeMinutes += duration;
        break;
      case 'bath':
        summary.other.bathCount++;
        break;
      case 'medicine':
        summary.other.medicineCount++;
        break;
      case 'massage':
        summary.other.massageCount++;
        summary.other.massageMinutes += duration;
        break;
    }
  }

  // Calculate average feed interval
  if (feedTimes.length > 1) {
    feedTimes.sort((a, b) => a - b);
    let totalInterval = 0;
    for (let i = 1; i < feedTimes.length; i++) {
      totalInterval += (feedTimes[i] - feedTimes[i - 1]) / (1000 * 60);
    }
    summary.feeds.avgIntervalMinutes = Math.round(totalInterval / (feedTimes.length - 1));
  }

  // Average nap duration
  if (summary.sleep.napCount > 0) {
    summary.sleep.avgNapMinutes = Math.round(summary.sleep.totalMinutes / summary.sleep.napCount);
  }

  return summary;
}

/**
 * Get date range for a period type
 */
export function getDateRange(periodType, referenceDate) {
  const ref = referenceDate || new Date();
  let start, end;

  switch (periodType) {
    case 'day':
      start = new Date(ref);
      start.setHours(0, 0, 0, 0);
      end = new Date(ref);
      end.setHours(23, 59, 59, 999);
      break;
    case 'week':
      start = startOfWeek(ref);
      end = new Date(start);
      end.setDate(end.getDate() + 6);
      end.setHours(23, 59, 59, 999);
      break;
    case 'month':
      start = startOfMonth(ref);
      end = new Date(start);
      end.setMonth(end.getMonth() + 1);
      end.setDate(0);
      end.setHours(23, 59, 59, 999);
      break;
    default:
      start = new Date(ref);
      start.setHours(0, 0, 0, 0);
      end = new Date(ref);
      end.setHours(23, 59, 59, 999);
  }

  return { start, end };
}

/**
 * Compare actual performance against expected for a baby's age
 */
export function comparePerformance(summary, dob) {
  const expectedPerf = getExpectedPerformance();
  const bracket = getAgeBracket(dob, expectedPerf);
  const expected = expectedPerf[bracket];

  if (!expected) return null;

  const perDay = summary.dayCount;

  const metrics = [
    {
      label: 'Feeds per day',
      actual: Math.round(summary.feeds.totalFeedCount / perDay * 10) / 10,
      min: expected.feeds_per_day.min,
      max: expected.feeds_per_day.max,
      unit: ''
    },
    {
      label: 'Wet diapers per day',
      actual: Math.round((summary.output.wetCount + summary.output.diaperChangeCount) / perDay * 10) / 10,
      min: expected.wet_diapers_per_day.min,
      max: expected.wet_diapers_per_day.max,
      unit: ''
    },
    {
      label: 'Poops per day',
      actual: Math.round(summary.output.poopCount / perDay * 10) / 10,
      min: expected.poop_per_day.min,
      max: expected.poop_per_day.max,
      unit: ''
    },
    {
      label: 'Sleep hours per day',
      actual: Math.round(summary.sleep.totalMinutes / perDay / 60 * 10) / 10,
      min: expected.sleep_hours_per_day.min,
      max: expected.sleep_hours_per_day.max,
      unit: 'h'
    }
  ];

  // Determine status for each metric
  for (const m of metrics) {
    if (m.actual >= m.min && m.actual <= m.max) {
      m.status = 'ok';
    } else if (m.actual >= m.min * 0.8 && m.actual <= m.max * 1.2) {
      m.status = 'warn';
    } else {
      m.status = 'alert';
    }
  }

  return {
    bracketLabel: expected.label,
    notes: expected.notes,
    metrics
  };
}

/**
 * Render a simple bar chart on a canvas element
 */
export function renderBarChart(canvas, data, options = {}) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);

  const width = rect.width;
  const height = rect.height;
  const padding = { top: 20, right: 15, bottom: 40, left: 40 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  // Clear
  ctx.clearRect(0, 0, width, height);

  if (!data.labels || data.labels.length === 0) {
    ctx.fillStyle = '#999';
    ctx.font = '14px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No data', width / 2, height / 2);
    return;
  }

  const maxVal = Math.max(...data.values, 1);
  const barWidth = Math.min(chartWidth / data.labels.length * 0.6, 40);
  const gap = chartWidth / data.labels.length;

  // Grid lines
  ctx.strokeStyle = '#eee';
  ctx.lineWidth = 1;
  const gridLines = 4;
  for (let i = 0; i <= gridLines; i++) {
    const y = padding.top + chartHeight - (chartHeight / gridLines * i);
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();

    // Y-axis labels
    ctx.fillStyle = '#999';
    ctx.font = '11px Inter, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(Math.round(maxVal / gridLines * i), padding.left - 5, y + 4);
  }

  // Bars
  const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  data.labels.forEach((label, i) => {
    const barHeight = (data.values[i] / maxVal) * chartHeight;
    const x = padding.left + gap * i + (gap - barWidth) / 2;
    const y = padding.top + chartHeight - barHeight;

    // Bar with rounded top
    ctx.fillStyle = data.colors?.[i] || options.barColor || '#FF8000';
    ctx.beginPath();
    const radius = Math.min(barWidth / 2, 6);
    ctx.moveTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.lineTo(x + barWidth - radius, y);
    ctx.quadraticCurveTo(x + barWidth, y, x + barWidth, y + radius);
    ctx.lineTo(x + barWidth, padding.top + chartHeight);
    ctx.lineTo(x, padding.top + chartHeight);
    ctx.closePath();
    ctx.fill();

    // X-axis labels
    ctx.fillStyle = isDark ? '#aaa' : '#666';
    ctx.font = '11px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(label, padding.left + gap * i + gap / 2, height - 10);
  });
}

/**
 * Render a line chart on a canvas element
 */
export function renderLineChart(canvas, data, options = {}) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);

  const width = rect.width;
  const height = rect.height;
  const padding = { top: 20, right: 15, bottom: 40, left: 40 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  ctx.clearRect(0, 0, width, height);

  if (!data.labels || data.labels.length === 0) {
    ctx.fillStyle = '#999';
    ctx.font = '14px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No data', width / 2, height / 2);
    return;
  }

  const maxVal = Math.max(...data.values, 1);
  const gap = chartWidth / Math.max(data.labels.length - 1, 1);

  // Grid lines
  ctx.strokeStyle = '#eee';
  ctx.lineWidth = 1;
  const gridLines = 4;
  for (let i = 0; i <= gridLines; i++) {
    const y = padding.top + chartHeight - (chartHeight / gridLines * i);
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();

    ctx.fillStyle = '#999';
    ctx.font = '11px Inter, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(Math.round(maxVal / gridLines * i * 10) / 10, padding.left - 5, y + 4);
  }

  // Line
  const lineColor = options.lineColor || '#219B9D';
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();

  const points = [];
  data.labels.forEach((label, i) => {
    const x = padding.left + gap * i;
    const y = padding.top + chartHeight - (data.values[i] / maxVal) * chartHeight;
    points.push({ x, y });
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // Fill area under line
  ctx.lineTo(points[points.length - 1].x, padding.top + chartHeight);
  ctx.lineTo(points[0].x, padding.top + chartHeight);
  ctx.closePath();
  ctx.fillStyle = lineColor + '20';
  ctx.fill();

  // Dots
  points.forEach((p, i) => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
    ctx.fillStyle = lineColor;
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();
  });

  // X-axis labels
  const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  data.labels.forEach((label, i) => {
    ctx.fillStyle = isDark ? '#aaa' : '#666';
    ctx.font = '11px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(label, padding.left + gap * i, height - 10);
  });
}
