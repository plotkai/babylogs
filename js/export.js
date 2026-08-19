// js/export.js — Export: JSON backup, CSV, PDF

import { exportAllData, importAllData } from './db.js';
import { formatTime, formatDateFull, formatDuration } from './utils.js';
import { getActivityType } from './config.js';

/**
 * Export all data as JSON file download
 */
export async function exportJSON() {
  try {
    const data = await exportAllData();
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const dateStr = new Date().toISOString().split('T')[0];
    downloadBlob(blob, `babylog-backup-${dateStr}.json`);
    return true;
  } catch (err) {
    console.error('Export failed:', err);
    throw err;
  }
}

/**
 * Import data from JSON file
 * Returns a promise that resolves when user selects a file and import completes
 */
export function importJSON() {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';

    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) { resolve(false); return; }

      try {
        const text = await file.text();
        const data = JSON.parse(text);

        // Validate structure
        if (!data.profiles || !data.activities) {
          throw new Error('Invalid backup file: missing profiles or activities data');
        }
        if (data.app !== 'Babylog by Plotkai') {
          console.warn('Backup file may not be from Babylog');
        }

        await importAllData(data);
        resolve(true);
      } catch (err) {
        console.error('Import failed:', err);
        reject(err);
      }
    };

    input.click();
  });
}

/**
 * Export activities as CSV file
 */
export function exportCSV(activities, babyName, periodLabel) {
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
  const safeName = (babyName || 'baby').replace(/[^a-zA-Z0-9]/g, '_');
  downloadBlob(blob, `babylog-${safeName}-${periodLabel}-${dateStr}.csv`);
}

/**
 * Export summary as printable PDF (via print dialog)
 */
export function exportPDF() {
  // Add print-specific class to body
  document.body.classList.add('print-mode');

  // Trigger print dialog — user can "Save as PDF"
  window.print();

  // Remove print class after a delay
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
