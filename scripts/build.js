// scripts/build.js - Bundles web assets into www/ for Capacitor Android
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const outDir = path.resolve(rootDir, 'www');

// Ensure output directory exists and is clean
if (fs.existsSync(outDir)) {
  fs.rmSync(outDir, { recursive: true, force: true });
}
fs.mkdirSync(outDir, { recursive: true });

const copyItems = [
  'index.html',
  'styles.css',
  'favicon.svg',
  'manifest.json',
  'robots.txt',
  'sitemap.xml',
  'sw.js',
  'babylog-ui.png',
  'config',
  'icons',
  'js'
];

for (const item of copyItems) {
  const src = path.resolve(rootDir, item);
  const dest = path.resolve(outDir, item);
  if (fs.existsSync(src)) {
    fs.cpSync(src, dest, { recursive: true });
  }
}

console.log('✓ Successfully prepared web assets in www/ directory for Capacitor.');
