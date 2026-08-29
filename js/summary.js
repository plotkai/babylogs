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

  // Calculate exact number of days in range
  const dayCount = Math.max(1, Math.round((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)));

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
    healthCare: {
      bathCount: 0,
      massageCount: 0,
      massageMinutes: 0,
      medicineCount: 0,
      medicines: [],
      weightChecks: [],
      dailyCareMap: {}
    },
    activities // raw data for export
  };

  // Feed interval tracking
  const feedTimes = [];

  for (const a of activities) {
    const duration = a.duration || 0;
    const dateKey = a.date || formatDateKey(new Date(a.startTime));
    if (!summary.healthCare.dailyCareMap[dateKey]) {
      summary.healthCare.dailyCareMap[dateKey] = { baths: 0, massages: 0, medicines: [], weights: [] };
    }

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
        if (a.subFields?.diaperChange === true) {
          summary.output.diaperChangeCount++;
        }
        break;
      case 'wet':
        summary.output.wetCount++;
        if (a.subFields?.diaperChange === true) {
          summary.output.diaperChangeCount++;
        }
        break;
      case 'diaper_change':
        summary.output.diaperChangeCount++;
        const dt = a.subFields?.diaperType || a.diaperType;
        if (dt) {
          const list = Array.isArray(dt) ? dt : [dt];
          list.forEach(t => {
            const lower = String(t).toLowerCase();
            if (lower.includes('wet')) {
              summary.output.wetCount++;
            }
            if (lower.includes('soiled') || lower.includes('poop') || lower.includes('dirty') || lower.includes('bm')) {
              summary.output.poopCount++;
            }
          });
        }
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
        summary.healthCare.bathCount++;
        summary.healthCare.dailyCareMap[dateKey].baths++;
        break;
      case 'medicine':
        summary.other.medicineCount++;
        summary.healthCare.medicineCount++;
        {
          const med = {
            id: a.id,
            time: a.startTime,
            date: dateKey,
            name: a.subFields?.name || 'Medicine',
            dose: a.subFields?.dose || '',
            notes: a.notes || ''
          };
          summary.healthCare.medicines.push(med);
          summary.healthCare.dailyCareMap[dateKey].medicines.push(med);
        }
        break;
      case 'massage':
        summary.other.massageCount++;
        summary.other.massageMinutes += duration;
        summary.healthCare.massageCount++;
        summary.healthCare.massageMinutes += duration;
        summary.healthCare.dailyCareMap[dateKey].massages++;
        break;
      case 'weight_check':
        {
          const val = parseFloat(a.subFields?.value) || 0;
          if (val > 0) {
            const weightItem = {
              id: a.id,
              time: a.startTime,
              date: dateKey,
              value: val
            };
            summary.healthCare.weightChecks.push(weightItem);
            summary.healthCare.dailyCareMap[dateKey].weights.push(weightItem);
          }
        }
        break;
    }
  }

  // Sort weight checks chronologically
  summary.healthCare.weightChecks.sort((a, b) => new Date(a.time) - new Date(b.time));

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
export function comparePerformance(summary, dob, period = 'day', isCurrent = false) {
  const expectedPerf = getExpectedPerformance();
  const bracket = getAgeBracket(dob, expectedPerf);
  const expected = expectedPerf[bracket];

  if (!expected) return null;

  const perDay = summary.dayCount;
  const isDayView = period === 'day';

  const metrics = [
    {
      key: 'feeds',
      label: isDayView ? 'Feeds' : 'Feeds',
      actual: isDayView ? summary.feeds.totalFeedCount : Math.round(summary.feeds.totalFeedCount / perDay * 10) / 10,
      total: summary.feeds.totalFeedCount,
      min: expected.feeds_per_day.min,
      max: expected.feeds_per_day.max,
      unit: isDayView ? '' : ' / day'
    },
    {
      key: 'wet',
      label: isDayView ? 'Wet diapers' : 'Wet diapers',
      actual: isDayView ? summary.output.wetCount : Math.round(summary.output.wetCount / perDay * 10) / 10,
      total: summary.output.wetCount,
      min: expected.wet_diapers_per_day.min,
      max: expected.wet_diapers_per_day.max,
      unit: isDayView ? '' : ' / day'
    },
    {
      key: 'poop',
      label: isDayView ? 'Poops' : 'Poops',
      actual: isDayView ? summary.output.poopCount : Math.round(summary.output.poopCount / perDay * 10) / 10,
      total: summary.output.poopCount,
      min: expected.poop_per_day.min,
      max: expected.poop_per_day.max,
      unit: isDayView ? '' : ' / day'
    },
    {
      key: 'sleep',
      label: isDayView ? 'Sleep hours' : 'Sleep hours',
      actual: isDayView ? Math.round(summary.sleep.totalMinutes / 60 * 10) / 10 : Math.round(summary.sleep.totalMinutes / perDay / 60 * 10) / 10,
      totalMinutes: summary.sleep.totalMinutes,
      min: expected.sleep_hours_per_day.min,
      max: expected.sleep_hours_per_day.max,
      unit: isDayView ? 'h' : 'h / day'
    }
  ];

  // Determine status and descriptive badges
  for (const m of metrics) {
    m.progressPct = Math.min(Math.round((m.actual / m.max) * 100), 100);

    if (m.actual >= m.min && m.actual <= m.max) {
      m.status = 'ok';
      m.badge = '✓ On Target';
    } else if (m.actual > m.max) {
      m.status = 'above';
      m.badge = 'Above Target';
    } else {
      if (isDayView && isCurrent) {
        m.status = 'progress';
        m.badge = `${m.actual} of ${m.min}–${m.max}`;
      } else {
        m.status = 'below';
        m.badge = `${m.actual} of ${m.min}–${m.max}`;
      }
    }
  }

  return {
    bracketLabel: expected.label,
    notes: expected.notes,
    isDayView,
    metrics
  };
}

/**
 * Build timeline dataset for Feeds & Outputs combined across time
 */
export function buildFeedsOutputsTimelineData(activities = [], period = 'day', referenceDate = new Date()) {
  if (period === 'day') {
    const labels = ['12a', '2a', '4a', '6a', '8a', '10a', '12p', '2p', '4p', '6p', '8p', '10p'];
    const feeds = new Array(12).fill(0);
    const wet = new Array(12).fill(0);
    const poop = new Array(12).fill(0);

    activities.forEach(a => {
      const d = new Date(a.startTime);
      if (isNaN(d.getTime())) return;
      const h = d.getHours();
      const bin = Math.min(11, Math.floor(h / 2));

      if (a.eventType === 'breast_feed' || a.eventType === 'formula_feed' || a.eventType === 'express_feed') {
        feeds[bin]++;
      } else if (a.eventType === 'wet') {
        wet[bin]++;
      } else if (a.eventType === 'poop') {
        poop[bin]++;
      } else if (a.eventType === 'diaper_change') {
        const dt = a.subFields?.diaperType || a.diaperType;
        const list = Array.isArray(dt) ? dt : (dt ? [dt] : []);
        let hasType = false;
        list.forEach(t => {
          const l = String(t).toLowerCase();
          if (l.includes('wet')) { wet[bin]++; hasType = true; }
          if (l.includes('soiled') || l.includes('poop') || l.includes('dirty') || l.includes('bm')) { poop[bin]++; hasType = true; }
        });
        if (!hasType) {
          wet[bin]++;
        }
      }
    });

    return {
      labels,
      series: [
        { name: 'Feeds', color: '#7C5CFC', values: feeds },
        { name: 'Wet', color: '#4A90D9', values: wet },
        { name: 'Poop', color: '#A0522D', values: poop }
      ]
    };
  }

  // Week / Month view: Group by day
  const { start, end } = getDateRange(period, referenceDate);
  const days = [];
  const curr = new Date(start);
  while (curr <= end) {
    days.push(new Date(curr));
    curr.setDate(curr.getDate() + 1);
  }

  const dayLabels = days.map(d => period === 'week' ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()] : `${d.getDate()}`);
  const feeds = new Array(days.length).fill(0);
  const wet = new Array(days.length).fill(0);
  const poop = new Array(days.length).fill(0);

  const dayKeyMap = {};
  days.forEach((d, idx) => {
    dayKeyMap[formatDateKey(d)] = idx;
  });

  activities.forEach(a => {
    const key = a.date || formatDateKey(new Date(a.startTime));
    const idx = dayKeyMap[key];
    if (idx === undefined) return;

    if (a.eventType === 'breast_feed' || a.eventType === 'formula_feed' || a.eventType === 'express_feed') {
      feeds[idx]++;
    } else if (a.eventType === 'wet') {
      wet[idx]++;
    } else if (a.eventType === 'poop') {
      poop[idx]++;
    } else if (a.eventType === 'diaper_change') {
      const dt = a.subFields?.diaperType || a.diaperType;
      const list = Array.isArray(dt) ? dt : (dt ? [dt] : []);
      let hasType = false;
      list.forEach(t => {
        const l = String(t).toLowerCase();
        if (l.includes('wet')) { wet[idx]++; hasType = true; }
        if (l.includes('soiled') || l.includes('poop') || l.includes('dirty') || l.includes('bm')) { poop[idx]++; hasType = true; }
      });
      if (!hasType) {
        wet[idx]++;
      }
    }
  });

  return {
    labels: dayLabels,
    series: [
      { name: 'Feeds', color: '#7C5CFC', values: feeds },
      { name: 'Wet', color: '#4A90D9', values: wet },
      { name: 'Poop', color: '#A0522D', values: poop }
    ]
  };
}

/**
 * Build timeline dataset for Sleep, Playtime & Crying combined across time (in Hours)
 */
export function buildSleepActivityTimelineData(activities = [], period = 'day', referenceDate = new Date()) {
  if (period === 'day') {
    const labels = ['12a', '2a', '4a', '6a', '8a', '10a', '12p', '2p', '4p', '6p', '8p', '10p'];
    const sleepMins = new Array(12).fill(0);
    const playMins = new Array(12).fill(0);
    const cryingMins = new Array(12).fill(0);

    activities.forEach(a => {
      const d = new Date(a.startTime);
      if (isNaN(d.getTime())) return;
      const h = d.getHours();
      const bin = Math.min(11, Math.floor(h / 2));
      const dur = a.duration || 0;

      if (a.eventType === 'sleep') {
        sleepMins[bin] += dur > 0 ? dur : 30;
      } else if (a.eventType === 'playtime' || a.eventType === 'tummy_time') {
        playMins[bin] += dur > 0 ? dur : 15;
      } else if (a.eventType === 'crying' || a.subFields?.mood === 'fussy' || (a.notes && a.notes.toLowerCase().includes('cry'))) {
        cryingMins[bin] += dur > 0 ? dur : 10;
      }
    });

    return {
      labels,
      unitSuffix: 'h',
      series: [
        { name: 'Sleep', color: '#6C63FF', values: sleepMins.map(m => Math.round((m / 60) * 10) / 10) },
        { name: 'Play', color: '#4ECDC4', values: playMins.map(m => Math.round((m / 60) * 10) / 10) },
        { name: 'Crying', color: '#FF6B6B', values: cryingMins.map(m => Math.round((m / 60) * 10) / 10) }
      ]
    };
  }

  // Week / Month view: Group by day in Hours
  const { start, end } = getDateRange(period, referenceDate);
  const days = [];
  const curr = new Date(start);
  while (curr <= end) {
    days.push(new Date(curr));
    curr.setDate(curr.getDate() + 1);
  }

  const dayLabels = days.map(d => period === 'week' ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()] : `${d.getDate()}`);
  const sleepMins = new Array(days.length).fill(0);
  const playMins = new Array(days.length).fill(0);
  const cryingMins = new Array(days.length).fill(0);

  const dayKeyMap = {};
  days.forEach((d, idx) => {
    dayKeyMap[formatDateKey(d)] = idx;
  });

  activities.forEach(a => {
    const key = a.date || formatDateKey(new Date(a.startTime));
    const idx = dayKeyMap[key];
    if (idx === undefined) return;
    const dur = a.duration || 0;

    if (a.eventType === 'sleep') {
      sleepMins[idx] += dur > 0 ? dur : 60;
    } else if (a.eventType === 'playtime' || a.eventType === 'tummy_time') {
      playMins[idx] += dur > 0 ? dur : 15;
    } else if (a.eventType === 'crying' || a.subFields?.mood === 'fussy' || (a.notes && a.notes.toLowerCase().includes('cry'))) {
      cryingMins[idx] += dur > 0 ? dur : 10;
    }
  });

  return {
    labels: dayLabels,
    unitSuffix: 'h',
    series: [
      { name: 'Sleep', color: '#6C63FF', values: sleepMins.map(m => Math.round((m / 60) * 10) / 10) },
      { name: 'Play', color: '#4ECDC4', values: playMins.map(m => Math.round((m / 60) * 10) / 10) },
      { name: 'Crying', color: '#FF6B6B', values: cryingMins.map(m => Math.round((m / 60) * 10) / 10) }
    ]
  };
}

/**
 * Render multi-series line timeline chart on canvas
 */
export function renderMultiLineTimelineChart(canvas, chartData, options = {}) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);

  const unitSuffix = options.unitSuffix || chartData.unitSuffix || '';
  const width = rect.width;
  const height = rect.height;
  const padding = { top: 16, right: 16, bottom: 28, left: unitSuffix ? 36 : 30 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  ctx.clearRect(0, 0, width, height);

  const labels = chartData.labels || [];
  const series = chartData.series || [];

  if (labels.length === 0 || series.length === 0) {
    ctx.fillStyle = '#888';
    ctx.font = '13px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No data logged for this period', width / 2, height / 2);
    return;
  }

  // Find max value across all series
  let rawMax = 0;
  series.forEach(s => {
    s.values.forEach(v => {
      if (v > rawMax) rawMax = v;
    });
  });

  // Ensure Y-axis is always whole numbers (integers)
  let maxVal = Math.max(Math.ceil(rawMax), 1);
  let gridLines = 3;
  if (maxVal <= 3) {
    gridLines = maxVal;
  } else {
    const step = Math.ceil(maxVal / 3);
    gridLines = 3;
    maxVal = step * gridLines;
  }

  // Grid lines
  const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  ctx.strokeStyle = isDark ? 'rgba(255, 255, 255, 0.08)' : '#eee';
  ctx.lineWidth = 1;
  for (let i = 0; i <= gridLines; i++) {
    const y = padding.top + chartHeight - (chartHeight / gridLines * i);
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();

    ctx.fillStyle = isDark ? '#777' : '#999';
    ctx.font = '10px Inter, sans-serif';
    ctx.textAlign = 'right';
    const yVal = Math.round((maxVal / gridLines) * i);
    const labelText = yVal === 0 ? '0' : `${yVal}${unitSuffix}`;
    ctx.fillText(labelText, padding.left - 5, y + 3);
  }

  const gap = labels.length > 1 ? chartWidth / (labels.length - 1) : chartWidth;

  // Draw lines for each series
  series.forEach(s => {
    if (!s.values || s.values.length === 0) return;

    ctx.strokeStyle = s.color;
    ctx.lineWidth = 2.2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();

    const points = [];
    labels.forEach((_, i) => {
      const val = s.values[i] || 0;
      const x = padding.left + gap * i;
      const y = padding.top + chartHeight - (val / maxVal) * chartHeight;
      points.push({ x, y, val });
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Subtle area fill under line
    if (points.length > 1) {
      ctx.lineTo(points[points.length - 1].x, padding.top + chartHeight);
      ctx.lineTo(points[0].x, padding.top + chartHeight);
      ctx.closePath();
      ctx.fillStyle = s.color + '18';
      ctx.fill();
    }

    // Points / Dots
    points.forEach(p => {
      if (p.val > 0 || labels.length <= 14) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.val > 0 ? 3.5 : 2, 0, Math.PI * 2);
        ctx.fillStyle = p.val > 0 ? s.color : (isDark ? '#444' : '#ccc');
        ctx.fill();
        if (p.val > 0) {
          ctx.strokeStyle = isDark ? '#1a102f' : '#fff';
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      }
    });
  });

  // X-axis labels with decimation for large counts (e.g. Month view)
  const isMonth = labels.length > 20;
  labels.forEach((label, i) => {
    let shouldShow = true;
    if (isMonth) {
      const dayNum = parseInt(label) || (i + 1);
      shouldShow = dayNum === 1 || dayNum % 5 === 0 || i === labels.length - 1;
    }

    if (shouldShow) {
      ctx.fillStyle = isDark ? '#888' : '#666';
      ctx.font = '10px Inter, sans-serif';
      ctx.textAlign = 'center';
      const x = padding.left + gap * i;
      ctx.fillText(label, x, height - 8);
    }
  });
}

/**
 * Render multi-series grouped bar timeline chart on canvas
 */
export function renderGroupedTimelineChart(canvas, chartData) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);

  const width = rect.width;
  const height = rect.height;
  const padding = { top: 16, right: 12, bottom: 28, left: 32 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  ctx.clearRect(0, 0, width, height);

  const labels = chartData.labels || [];
  const series = chartData.series || [];

  if (labels.length === 0 || series.length === 0) {
    ctx.fillStyle = '#888';
    ctx.font = '13px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No data logged for this period', width / 2, height / 2);
    return;
  }

  // Find max value across all series and bins
  let rawMax = 0;
  series.forEach(s => {
    s.values.forEach(v => {
      if (v > rawMax) rawMax = v;
    });
  });

  // Ensure Y-axis is always whole numbers
  let maxVal = Math.max(Math.ceil(rawMax), 1);
  let gridLines = 3;
  if (maxVal <= 3) {
    gridLines = maxVal;
  } else {
    const step = Math.ceil(maxVal / 3);
    gridLines = 3;
    maxVal = step * gridLines;
  }

  // Grid lines
  const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  ctx.strokeStyle = isDark ? 'rgba(255, 255, 255, 0.08)' : '#eee';
  ctx.lineWidth = 1;
  for (let i = 0; i <= gridLines; i++) {
    const y = padding.top + chartHeight - (chartHeight / gridLines * i);
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();

    ctx.fillStyle = isDark ? '#777' : '#999';
    ctx.font = '10px Inter, sans-serif';
    ctx.textAlign = 'right';
    const val = Math.round((maxVal / gridLines) * i);
    ctx.fillText(val, padding.left - 4, y + 3);
  }

  const groupWidth = chartWidth / labels.length;
  const numSeries = series.length;
  const barWidth = Math.max(2, Math.min((groupWidth * 0.75) / numSeries, 10));
  const totalBarsWidth = barWidth * numSeries;

  const isMonth = labels.length > 20;

  labels.forEach((label, binIdx) => {
    const groupCenterX = padding.left + groupWidth * binIdx + groupWidth / 2;
    const startX = groupCenterX - totalBarsWidth / 2;

    series.forEach((s, sIdx) => {
      const val = s.values[binIdx] || 0;
      if (val > 0) {
        const barH = (val / maxVal) * chartHeight;
        const x = startX + sIdx * barWidth;
        const y = padding.top + chartHeight - barH;

        ctx.fillStyle = s.color;
        ctx.beginPath();
        const r = Math.min(barWidth / 2, 3);
        ctx.moveTo(x, y + r);
        ctx.quadraticCurveTo(x, y, x + r, y);
        ctx.lineTo(x + barWidth - r, y);
        ctx.quadraticCurveTo(x + barWidth, y, x + barWidth, y + r);
        ctx.lineTo(x + barWidth, padding.top + chartHeight);
        ctx.lineTo(x, padding.top + chartHeight);
        ctx.closePath();
        ctx.fill();
      }
    });

    // X-axis label with decimation for month view
    let shouldShow = true;
    if (isMonth) {
      const dayNum = parseInt(label) || (binIdx + 1);
      shouldShow = dayNum === 1 || dayNum % 5 === 0 || binIdx === labels.length - 1;
    }

    if (shouldShow) {
      ctx.fillStyle = isDark ? '#888' : '#666';
      ctx.font = '10px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(label, groupCenterX, height - 8);
    }
  });
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

/**
 * Render Week Care Calendar HTML
 */
export function renderWeekCareCalendar(startDate, endDate, dailyCareMap = {}) {
  const days = [];
  const curr = new Date(startDate);
  const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  while (curr <= endDate) {
    days.push(new Date(curr));
    curr.setDate(curr.getDate() + 1);
  }

  const todayKey = formatDateKey(new Date());

  return `
    <div class="care-week-calendar">
      ${days.map(d => {
        const key = formatDateKey(d);
        const dayInfo = dailyCareMap[key] || { baths: 0, massages: 0, medicines: [], weights: [] };
        const dayName = dayNames[(d.getDay() + 6) % 7];
        const isTodayDay = key === todayKey;
        const hasCare = dayInfo.baths > 0 || dayInfo.massages > 0 || dayInfo.medicines.length > 0 || dayInfo.weights.length > 0;

        return `
          <div class="care-week-col ${isTodayDay ? 'care-week-col--today' : ''} ${hasCare ? 'care-week-col--has-data' : ''}">
            <div class="care-week-col__header">
              <span class="care-week-col__day">${dayName}</span>
              <span class="care-week-col__num">${d.getDate()}</span>
            </div>
            <div class="care-week-col__items">
              ${dayInfo.baths > 0 ? `<div class="care-badge care-badge--bath" title="Bath (${dayInfo.baths}x)">🛁 ${dayInfo.baths > 1 ? dayInfo.baths : ''}</div>` : ''}
              ${dayInfo.massages > 0 ? `<div class="care-badge care-badge--massage" title="Massage (${dayInfo.massages}x)">💆 ${dayInfo.massages > 1 ? dayInfo.massages : ''}</div>` : ''}
              ${dayInfo.medicines.length > 0 ? `<div class="care-badge care-badge--medicine" title="${dayInfo.medicines.map(m => m.name).join(', ')}">💊 ${dayInfo.medicines.length > 1 ? dayInfo.medicines.length : ''}</div>` : ''}
              ${dayInfo.weights.length > 0 ? `<div class="care-badge care-badge--weight" title="Weight check">⚖️</div>` : ''}
              ${!hasCare ? `<span class="care-badge--empty">·</span>` : ''}
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

/**
 * Render Month Care Calendar HTML
 */
export function renderMonthCareCalendar(startDate, endDate, dailyCareMap = {}) {
  const dayNames = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
  const start = new Date(startDate);
  const end = new Date(endDate);
  const todayKey = formatDateKey(new Date());

  // Weekday offset (0 = Monday, ..., 6 = Sunday)
  const startDay = (start.getDay() + 6) % 7;
  const daysInMonth = end.getDate();

  const cells = [];
  // Empty leading cells
  for (let i = 0; i < startDay; i++) {
    cells.push('<div class="care-month-cell care-month-cell--empty"></div>');
  }

  // Days of month
  for (let day = 1; day <= daysInMonth; day++) {
    const d = new Date(start.getFullYear(), start.getMonth(), day, 12, 0, 0);
    const key = formatDateKey(d);
    const dayInfo = dailyCareMap[key] || { baths: 0, massages: 0, medicines: [], weights: [] };
    const isTodayDay = key === todayKey;
    const hasBath = dayInfo.baths > 0;
    const hasMassage = dayInfo.massages > 0;
    const hasMed = dayInfo.medicines.length > 0;
    const hasWeight = dayInfo.weights.length > 0;
    const hasAny = hasBath || hasMassage || hasMed || hasWeight;

    cells.push(`
      <div class="care-month-cell ${isTodayDay ? 'care-month-cell--today' : ''} ${hasAny ? 'care-month-cell--active' : ''}">
        <span class="care-month-cell__num">${day}</span>
        <div class="care-month-cell__dots">
          ${hasBath ? `<span class="care-dot care-dot--bath" title="Bath"></span>` : ''}
          ${hasMassage ? `<span class="care-dot care-dot--massage" title="Massage"></span>` : ''}
          ${hasMed ? `<span class="care-dot care-dot--medicine" title="Medicine"></span>` : ''}
          ${hasWeight ? `<span class="care-dot care-dot--weight" title="Weight Check"></span>` : ''}
        </div>
      </div>
    `);
  }

  return `
    <div class="care-month-calendar">
      <div class="care-month-header">
        ${dayNames.map(name => `<span class="care-month-header__day">${name}</span>`).join('')}
      </div>
      <div class="care-month-grid">
        ${cells.join('')}
      </div>
    </div>
  `;
}
