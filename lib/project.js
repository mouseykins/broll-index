/**
 * Project data-access layer.
 * All reads and writes to a project's .broll-index/ folder go through here.
 */

import fs from 'fs';
import path from 'path';

const BROLL_DIR = '.broll-index';

export function getBrollDir(folderPath) {
  return path.join(folderPath, BROLL_DIR);
}

export function getIndexPath(folderPath) {
  return path.join(getBrollDir(folderPath), 'index.json');
}

export function getTaxonomyPath(folderPath) {
  return path.join(getBrollDir(folderPath), 'taxonomy.json');
}

export function getThumbnailsDir(folderPath) {
  return path.join(getBrollDir(folderPath), 'thumbnails');
}

export function ensureProjectDirs(folderPath) {
  fs.mkdirSync(getThumbnailsDir(folderPath), { recursive: true });
}

export function loadIndex(folderPath) {
  const p = getIndexPath(folderPath);
  if (fs.existsSync(p)) {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  }
  return { version: '2.0', lastUpdated: new Date().toISOString(), videos: {}, clips: [] };
}

export function saveIndex(folderPath, index) {
  ensureProjectDirs(folderPath);
  index.lastUpdated = new Date().toISOString();
  fs.writeFileSync(getIndexPath(folderPath), JSON.stringify(index, null, 2));
}

export function loadTaxonomy(folderPath) {
  const p = getTaxonomyPath(folderPath);
  if (fs.existsSync(p)) {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  }
  return null;
}

export function saveTaxonomy(folderPath, taxonomy) {
  ensureProjectDirs(folderPath);
  fs.writeFileSync(getTaxonomyPath(folderPath), JSON.stringify(taxonomy, null, 2));
}
