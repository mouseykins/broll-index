#!/usr/bin/env node
/**
 * One-time migration: moves existing Keen On Coffee data from the app root
 * into the new per-project .broll-index/ folder structure.
 *
 * What it does:
 *   1. Reads broll-index.json from the app root
 *   2. Detects the video folder from the first video's sourcePath
 *   3. Creates <videoFolder>/.broll-index/thumbnails/
 *   4. Rewrites thumbnail paths: "thumbnails/clip_0001.gif" → "clip_0001.gif"
 *   5. Writes the updated index to <videoFolder>/.broll-index/index.json
 *   6. Copies all GIFs to <videoFolder>/.broll-index/thumbnails/
 *   7. Copies taxonomy/keen-on-coffee.json to <videoFolder>/.broll-index/taxonomy.json
 *      (also renames beanDescriptors → subjectDescriptors)
 *   8. Registers the project in projects.json
 *   9. Deletes broll-index.json and thumbnails/ from the app root
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_ROOT = path.join(__dirname, '..');

// ─── Load existing app-root index ────────────────────────────────────────────

const rootIndexPath = path.join(APP_ROOT, 'broll-index.json');
if (!fs.existsSync(rootIndexPath)) {
  console.error('No broll-index.json found at app root. Nothing to migrate.');
  process.exit(1);
}

const index = JSON.parse(fs.readFileSync(rootIndexPath, 'utf-8'));
const videos = Object.values(index.videos);

if (videos.length === 0) {
  console.error('No videos found in broll-index.json. Nothing to migrate.');
  process.exit(1);
}

const videoFolder = videos[0].sourcePath;
console.log(`Detected video folder: ${videoFolder}`);

if (!fs.existsSync(videoFolder)) {
  console.error(`Video folder not found: ${videoFolder}`);
  process.exit(1);
}

// ─── Create .broll-index/ structure ──────────────────────────────────────────

const brollDir = path.join(videoFolder, '.broll-index');
const thumbDest = path.join(brollDir, 'thumbnails');
fs.mkdirSync(thumbDest, { recursive: true });
console.log(`Created: ${brollDir}`);

// ─── Rewrite thumbnail paths ──────────────────────────────────────────────────

let rewritten = 0;
index.clips = index.clips.map(clip => {
  if (clip.thumbnail) {
    clip.thumbnail = path.basename(clip.thumbnail); // "thumbnails/clip_0001.gif" → "clip_0001.gif"
    rewritten++;
  }
  return clip;
});
console.log(`Rewrote ${rewritten} thumbnail paths`);

// ─── Write new index ──────────────────────────────────────────────────────────

const newIndexPath = path.join(brollDir, 'index.json');
fs.writeFileSync(newIndexPath, JSON.stringify(index, null, 2));
console.log(`Wrote index: ${newIndexPath}`);

// ─── Copy GIFs ────────────────────────────────────────────────────────────────

const srcThumbDir = path.join(APP_ROOT, 'thumbnails');
if (fs.existsSync(srcThumbDir)) {
  const gifs = fs.readdirSync(srcThumbDir);
  for (const f of gifs) {
    fs.copyFileSync(path.join(srcThumbDir, f), path.join(thumbDest, f));
  }
  console.log(`Copied ${gifs.length} GIFs to ${thumbDest}`);
} else {
  console.warn('No thumbnails/ folder found at app root — skipping GIF copy');
}

// ─── Copy + update taxonomy ───────────────────────────────────────────────────

const srcTaxonomy = path.join(APP_ROOT, 'taxonomy', 'keen-on-coffee.json');
const destTaxonomy = path.join(brollDir, 'taxonomy.json');

const taxonomy = JSON.parse(fs.readFileSync(srcTaxonomy, 'utf-8'));
// Rename beanDescriptors → subjectDescriptors if still using old field name
if (taxonomy.beanDescriptors && !taxonomy.subjectDescriptors) {
  taxonomy.subjectDescriptors = taxonomy.beanDescriptors;
  delete taxonomy.beanDescriptors;
  console.log('Renamed beanDescriptors → subjectDescriptors in taxonomy');
}
fs.writeFileSync(destTaxonomy, JSON.stringify(taxonomy, null, 2));
console.log(`Wrote taxonomy: ${destTaxonomy}`);

// ─── Register project in projects.json ───────────────────────────────────────

const projectsPath = path.join(APP_ROOT, 'projects.json');
const registry = {
  version: '1.0',
  projects: [{
    slug: 'keen-on-coffee',
    name: 'Keen On Coffee',
    folderPath: videoFolder,
    registeredAt: new Date().toISOString(),
    lastAnalyzed: index.lastUpdated || null,
  }],
};
fs.writeFileSync(projectsPath, JSON.stringify(registry, null, 2));
console.log(`Registered project in: ${projectsPath}`);

// ─── Delete old app-root files ────────────────────────────────────────────────

fs.rmSync(rootIndexPath);
console.log(`Deleted: ${rootIndexPath}`);

if (fs.existsSync(srcThumbDir)) {
  fs.rmSync(srcThumbDir, { recursive: true });
  console.log(`Deleted: ${srcThumbDir}`);
}

// ─── Done ─────────────────────────────────────────────────────────────────────

console.log('\nMigration complete!');
console.log('Run "npm start" and visit http://localhost:3000 to verify.');
