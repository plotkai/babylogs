// js/export.js — Export: JSON backup, CSV, PDF & Import handling

import { exportFilteredData, importDataWithMode } from './db.js';
import { formatTime, formatDateFull, formatDuration } from './utils.js';
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
