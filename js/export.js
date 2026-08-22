// js/export.js — Export: JSON backup, CSV, PDF & One-Tap WhatsApp/App Sharing & Import handling

import { exportFilteredData, importDataWithMode, analyzeImportData } from './db.js';
import { formatTime, formatDateFull, formatDateDisplay, formatDuration } from './utils.js';
import { getActivityType } from './config.js';

/**
 * Export data as JSON file download with optional filtering
 */
export async function exportJSON(options = {}) {
  const { babyId = null, babyName = 'all-babies', startDate = null, endDate = null, dateRangeLabel = 'all-time' } = options;
  try {
    const data = await exportFilteredData({ babyId, startDate, endDate });
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const dateStr = new Date().toISOString().split('T')[0];
    const safeBaby = (babyName || 'all-babies').replace(/[^a-zA-Z0-9]/g, '_');
    const safeRange = (dateRangeLabel || 'all-time').replace(/[^a-zA-Z0-9]/g, '_');
    downloadBlob(blob, `babylogs-backup-${safeBaby}-${safeRange}-${dateStr}.json`);
    return data;
  } catch (err) {
    console.error('JSON Export failed:', err);
    throw err;
  }
}

/**
 * One-Tap Share JSON Backup via Web Share API (WhatsApp, Messages, AirDrop, etc.)
 */
export async function shareBackup(options = {}) {
  const { babyId = null, babyName = 'all-babies', startDate = null, endDate = null, dateRangeLabel = 'all-time' } = options;
  try {
    const data = await exportFilteredData({ babyId, startDate, endDate });
    const json = JSON.stringify(data, null, 2);
    const dateStr = new Date().toISOString().split('T')[0];
    const safeBaby = (babyName || 'all-babies').replace(/[^a-zA-Z0-9]/g, '_');
    const safeRange = (dateRangeLabel || 'all-time').replace(/[^a-zA-Z0-9]/g, '_');
    const filename = `babylogs-backup-${safeBaby}-${safeRange}-${dateStr}.json`;
    const blob = new Blob([json], { type: 'application/json' });

    const file = new File([blob], filename, { type: 'application/json' });
    const displayBaby = babyName === 'all-babies' ? 'All Babies' : babyName;
    const shareTitle = `Babylogs Backup — ${displayBaby}`;
    const shareText = `👶 Babylogs Backup for ${displayBaby} (${dateRangeLabel})\n📝 ${data.activities.length} activity logs.\nOpen or import directly into Babylogs: https://babylogs.plotkai.in`;

    // 1. Try file sharing via Web Share Level 2
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({
        title: shareTitle,
        text: shareText,
        files: [file]
      });
      return { shared: true, method: 'files' };
    }

    // 2. Try text/url sharing via Web Share
    if (navigator.share) {
      await navigator.share({
        title: shareTitle,
        text: shareText,
        url: 'https://babylogs.plotkai.in'
      });
      // Also download the backup file so user can attach it
      downloadBlob(blob, filename);
      return { shared: true, method: 'text_with_download' };
    }

    // 3. Fallback: WhatsApp direct link + file download
    const waUrl = `https://api.whatsapp.com/send?text=${encodeURIComponent(shareText)}`;
    window.open(waUrl, '_blank');
    downloadBlob(blob, filename);
    return { shared: true, method: 'whatsapp_web' };
  } catch (err) {
    if (err.name === 'AbortError') {
      // User dismissed share dialog
      return { shared: false, aborted: true };
    }
    console.error('Share backup failed:', err);
    throw err;
  }
}

/**
 * One-Tap Share Summary Stats via WhatsApp / Messages / Native Share
 */
export async function shareSummaryText(summary, baby, period = 'day') {
  try {
    const babyName = baby?.name || 'Baby';
    const periodLabel = period === 'day' ? 'Today' : period === 'week' ? 'This Week' : 'This Month';
    const lines = [
      `👶 *Babylogs ${periodLabel} Summary for ${babyName}*`,
      `📅 ${formatDateDisplay(new Date())}`,
      ''
    ];

    if (summary.feeds) {
      const totalFeeds = summary.feeds.totalCount || 0;
      const parts = [];
      if (summary.feeds.breastFeedCount > 0) parts.push(`${summary.feeds.breastFeedCount} breast`);
      if (summary.feeds.formulaCount > 0) parts.push(`${summary.feeds.formulaCount} formula (${summary.feeds.formulaVolume || 0}ml)`);
      if (summary.feeds.expressCount > 0) parts.push(`${summary.feeds.expressCount} expressed (${summary.feeds.expressVolume || 0}ml)`);
      lines.push(`🍼 *Feeds:* ${totalFeeds} feeds ${parts.length > 0 ? `(${parts.join(', ')})` : ''}`);
    }

    if (summary.diapers) {
      const totalDiapers = summary.diapers.totalCount || 0;
      lines.push(`🚼 *Diapers:* ${totalDiapers} changes (${summary.diapers.wetCount || 0} wet, ${summary.diapers.poopCount || 0} poop)`);
    }

    if (summary.sleep) {
      const sleepHours = Math.round((summary.sleep.totalMinutes || 0) / 60 * 10) / 10;
      lines.push(`😴 *Sleep:* ${sleepHours}h total (${summary.sleep.napCount || 0} naps, longest: ${summary.sleep.longestNapMinutes || 0}m)`);
    }

    if (summary.activity) {
      lines.push(`🧸 *Play & Tummy:* ${summary.activity.tummyTimeTotalMinutes || 0}m tummy time, ${summary.activity.playTotalMinutes || 0}m play`);
    }

    lines.push('');
    lines.push('🌟 *Tracked with Babylogs* — Free & Private Baby Tracker');
    lines.push('📱 https://babylogs.plotkai.in');

    const message = lines.join('\n');
    const shareTitle = `Babylogs ${periodLabel} Summary — ${babyName}`;

    if (navigator.share) {
      await navigator.share({
        title: shareTitle,
        text: message
      });
      return { shared: true };
    }

    // WhatsApp fallback
    const waUrl = `https://api.whatsapp.com/send?text=${encodeURIComponent(message)}`;
    window.open(waUrl, '_blank');
    return { shared: true, fallback: 'whatsapp' };
  } catch (err) {
    if (err.name === 'AbortError') {
      return { shared: false, aborted: true };
    }
    console.error('Share summary failed:', err);
    throw err;
  }
}

/**
 * Parse and validate JSON backup file
 */
export async function parseBackupFile(file) {
  if (!file) throw new Error('No file selected');
  const text = await file.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Invalid JSON file format');
  }

  if (!data || !Array.isArray(data.profiles) || !Array.isArray(data.activities)) {
    throw new Error('Invalid backup file: missing profiles or activities array');
  }

  return data;
}

/**
 * Import data from parsed backup object with mode ('merge' | 'replace')
 */
export async function executeImport(data, mode = 'merge') {
  return await importDataWithMode(data, mode);
}

/**
 * Inspect and analyze backup for preview
 */
export async function inspectBackup(data) {
  return await analyzeImportData(data);
}

/**
 * Export activities as CSV file
 */
export function exportCSV(activities, babyName = 'all-babies', periodLabel = 'all-time') {
  const headers = ['Date', 'Start Time', 'End Time', 'Duration', 'Event Type', 'Details', 'Notes'];
  const rows = activities.map(a => {
    const typeConfig = getActivityType(a.eventType);
    const details = [];
    if (a.subFields && typeConfig) {
      for (const field of (typeConfig.fields || [])) {
        const val = a.subFields[field.key];
        if (val !== undefined && val !== null && val !== '') {
          if (Array.isArray(val)) {
            details.push(`${field.label}: ${val.join('/')}`);
          } else {
            details.push(`${field.label}: ${val}`);
          }
        }
      }
    }

    return [
      a.date,
      formatTime(a.startTime),
      a.endTime ? formatTime(a.endTime) : '',
      a.duration ? formatDuration(a.duration) : '',
      typeConfig ? typeConfig.label : a.eventType,
      details.join('; '),
      a.notes || ''
    ];
  });

  const csv = [
    headers.join(','),
    ...rows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
  ].join('\n');

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const dateStr = new Date().toISOString().split('T')[0];
  const safeName = (babyName || 'all-babies').replace(/[^a-zA-Z0-9]/g, '_');
  const safePeriod = (periodLabel || 'all-time').replace(/[^a-zA-Z0-9]/g, '_');
  downloadBlob(blob, `babylogs-${safeName}-${safePeriod}-${dateStr}.csv`);
}

/**
 * Export summary as printable PDF (via print dialog)
 */
export function exportPDF() {
  document.body.classList.add('print-mode');
  window.print();
  setTimeout(() => {
    document.body.classList.remove('print-mode');
  }, 1000);
}

/**
 * Helper: trigger file download from a Blob
 */
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();

  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 100);
}
