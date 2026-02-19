#!/usr/bin/env node
/**
 * B-Roll Index — Analysis Pipeline
 *
 * Uploads each video to the Gemini Files API, asks for B-roll segments
 * with timestamps, then generates animated GIF previews with FFmpeg.
 *
 * Usage:
 *   node analyze.js --project /path/to/video/folder
 *   node analyze.js --project /path/to/video/folder --new-only
 *   node analyze.js --project /path/to/video/folder --file "specific-video.mp4"
 *
 * --input is accepted as a deprecated alias for --project.
 */

import "dotenv/config";

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import minimist from "minimist";
import { checkFfmpeg, getVideoDuration, extractClipGif } from "./lib/frames.js";
import { uploadVideo, classifyVideo, deleteUploadedFile, parseTimestamp } from "./lib/classify.js";
import {
  loadIndex, saveIndex, loadTaxonomy, saveTaxonomy,
  getThumbnailsDir, ensureProjectDirs,
} from "./lib/project.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Config ──────────────────────────────────────────────────────────────────

const DEFAULT_TAXONOMY_PATH = path.join(__dirname, "taxonomy", "default.json");
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".webm", ".avi"]);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toLocaleTimeString();
  console.log(`[${ts}] ${msg}`);
}

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function generateVideoId(existingIds) {
  const nums = Object.keys(existingIds)
    .map((k) => parseInt(k.replace("vid_", ""), 10))
    .filter((n) => !isNaN(n));
  const next = nums.length > 0 ? Math.max(...nums) + 1 : 1;
  return `vid_${String(next).padStart(3, "0")}`;
}

function toArray(val) {
  if (Array.isArray(val)) return val;
  if (val && typeof val === "string") return [val];
  return [];
}

function generateClipId(existingClips) {
  const nums = existingClips
    .map((c) => parseInt(c.id.replace("clip_", ""), 10))
    .filter((n) => !isNaN(n));
  const next = nums.length > 0 ? Math.max(...nums) + 1 : 1;
  return next;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = minimist(process.argv.slice(2));

  // --project is canonical; --input is a deprecated alias
  const projectFolder = args.project || args.input || args.i;
  if (!projectFolder) {
    console.error("Usage: node analyze.js --project /path/to/video/folder [--new-only] [--file video.mp4]");
    process.exit(1);
  }

  const resolvedProject = path.resolve(projectFolder);
  if (!fs.existsSync(resolvedProject)) {
    console.error(`Project folder not found: ${resolvedProject}`);
    process.exit(1);
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === "your_api_key_here") {
    console.error("Missing GEMINI_API_KEY. Add it to .env (see .env.example)");
    process.exit(1);
  }

  // Check FFmpeg
  try {
    const version = await checkFfmpeg();
    log(`FFmpeg found: ${version}`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  // Ensure project .broll-index/ dirs exist
  ensureProjectDirs(resolvedProject);
  const THUMBNAILS_DIR = getThumbnailsDir(resolvedProject);

  // Load taxonomy: project-local first, then fall back to generic default
  let taxonomy = loadTaxonomy(resolvedProject);
  if (!taxonomy) {
    taxonomy = JSON.parse(fs.readFileSync(DEFAULT_TAXONOMY_PATH, "utf-8"));
    saveTaxonomy(resolvedProject, taxonomy);
    log("No project taxonomy found — copied generic default into project");
  }
  log(`Taxonomy loaded: ${taxonomy.equipment.length} equipment, ${taxonomy.products.length} products`);

  // Load or create index
  const index = loadIndex(resolvedProject);

  // Find video files in the project folder
  let videoFiles = fs
    .readdirSync(resolvedProject)
    .filter((f) => VIDEO_EXTENSIONS.has(path.extname(f).toLowerCase()));

  // Filter to specific file if requested
  if (args.file) {
    videoFiles = videoFiles.filter((f) => f === args.file);
    if (videoFiles.length === 0) {
      console.error(`File not found: ${args.file}`);
      process.exit(1);
    }
  }

  // Filter to new-only if requested
  if (args["new-only"]) {
    const indexedFiles = new Set(
      Object.values(index.videos).map((v) => v.filename)
    );
    const before = videoFiles.length;
    videoFiles = videoFiles.filter((f) => !indexedFiles.has(f));
    log(`--new-only: ${before} total videos, ${videoFiles.length} not yet indexed`);
  }

  if (videoFiles.length === 0) {
    log("No videos to process. Done!");
    return;
  }

  log(`Found ${videoFiles.length} video(s) to process`);
  log("");

  let totalClipsFound = 0;
  let clipIdCounter = generateClipId(index.clips);

  // Process each video
  for (let v = 0; v < videoFiles.length; v++) {
    const filename = videoFiles[v];
    const videoPath = path.join(resolvedProject, filename);
    let uploadedFileName = null;

    log(`━━━ [${v + 1}/${videoFiles.length}] ${filename} ━━━`);

    try {
      // If this filename already exists in the index, replace its prior clips on re-analyze.
      const existingVideoIds = Object.entries(index.videos)
        .filter(([, meta]) => meta.filename === filename)
        .map(([id]) => id);
      if (existingVideoIds.length) {
        const existingSet = new Set(existingVideoIds);
        const clipsToRemove = index.clips.filter((c) => existingSet.has(c.videoId));
        for (const c of clipsToRemove) {
          if (!c.thumbnail) continue;
          try { fs.unlinkSync(path.join(THUMBNAILS_DIR, c.thumbnail)); } catch {}
        }
        index.clips = index.clips.filter((c) => !existingSet.has(c.videoId));
        for (const vid of existingVideoIds) delete index.videos[vid];
        log(`  Re-analyze mode: replaced ${clipsToRemove.length} prior clip(s) for this video`);
      }

      const videoId = generateVideoId(index.videos);

      // Step 1: Get video duration
      const duration = await getVideoDuration(videoPath);
      log(`  Duration: ${formatDuration(duration)}`);

      // Step 2: Upload video to Gemini Files API
      log("  Uploading video to Gemini...");
      const { fileUri, mimeType, fileName } = await uploadVideo(apiKey, videoPath);
      uploadedFileName = fileName;
      log(`  Upload complete. Processing...`);

      // Step 3: Classify the whole video in one API call
      log("  Classifying video via Gemini Flash...");
      const segments = await classifyVideo(apiKey, fileUri, mimeType, taxonomy);
      log(`  Found ${segments.length} candidate segments`);

      // Step 4: Filter by minimum score
      const minScore = taxonomy.minimumBrollScore || 0.5;
      const goodSegments = segments.filter((s) => s.brollScore >= minScore);
      log(`  ${goodSegments.length} clips above score threshold (>= ${minScore})`);

      // Step 5: Generate animated GIF previews (tidy window extraction)
      log("  Generating clip previews (tidied)...");
      const clips = [];
      for (const seg of goodSegments) {
        const startSec = parseTimestamp(seg.startTime);
        const endSec = parseTimestamp(seg.endTime);

        const clipId = `clip_${String(clipIdCounter++).padStart(4, "0")}`;
        const gifFilename = `${clipId}.gif`;
        const gifPath = path.join(THUMBNAILS_DIR, gifFilename);

        let thumbnail = null;
        try {
          await extractClipGif(videoPath, startSec, endSec, gifPath);
          thumbnail = gifFilename; // filename only — server constructs full URL
          process.stdout.write(`\r  Generated ${clipId}`);
        } catch (err) {
          console.error(`\n  Warning: couldn't generate GIF for ${clipId}: ${err.message}`);
        }

        clips.push({
          id: clipId,
          videoId,
          startTime: formatTime(startSec),
          endTime: formatTime(endSec),
          startSeconds: startSec,
          endSeconds: endSec,
          thumbnail,
          tags: {
            shotType: seg.shotType,
            equipment: toArray(seg.equipment),
            technique: toArray(seg.technique),
            subjectDescriptors: toArray(seg.subjectDescriptors || seg.beans),
            products: toArray(seg.products),
            other: toArray(seg.other),
          },
          description: seg.description || "",
          brollScore: seg.brollScore,
          presenterVisible: seg.presenterVisible || false,
          userVerified: false,
          userEdited: false,
          userNotes: "",
          excluded: false,
        });
      }
      console.log("");

      // Add to index
      index.videos[videoId] = {
        filename,
        title: path.basename(filename, path.extname(filename)),
        duration: formatDuration(duration),
        dateAnalyzed: new Date().toISOString().split("T")[0],
        sourcePath: resolvedProject,
      };

      index.clips.push(...clips);
      totalClipsFound += clips.length;

      // Merge newly discovered terms back into the project taxonomy
      const allSegments = [...goodSegments];
      function mergeTerms(existing, discovered) {
        const set = new Set(existing.map(t => t.toLowerCase()));
        for (const term of discovered) {
          if (term && !set.has(term.toLowerCase())) {
            existing.push(term);
            set.add(term.toLowerCase());
          }
        }
      }
      for (const seg of allSegments) {
        mergeTerms(taxonomy.equipment, toArray(seg.equipment));
        mergeTerms(taxonomy.products, toArray(seg.products));
        mergeTerms(taxonomy.techniques, toArray(seg.technique));
        mergeTerms(taxonomy.subjectDescriptors, toArray(seg.subjectDescriptors));
      }
      saveTaxonomy(resolvedProject, taxonomy);
      log(`  Taxonomy updated: ${taxonomy.equipment.length} equipment, ${taxonomy.products.length} products, ${taxonomy.techniques.length} techniques`);

      // Save after each video (resilient to interruption)
      saveIndex(resolvedProject, index);
      log(`  Saved to index. Running total: ${index.clips.length} clips`);

    } catch (err) {
      console.error(`  ERROR: ${err.message}`);
    } finally {
      if (uploadedFileName) {
        await deleteUploadedFile(apiKey, uploadedFileName);
      }
    }

    log("");
  }

  // ─── Summary ─────────────────────────────────────────────────────────────
  log("═══════════════════════════════════════════════");
  log("  Analysis Complete!");
  log(`  Videos processed: ${videoFiles.length}`);
  log(`  New clips found:  ${totalClipsFound}`);
  log(`  Total clips in index: ${index.clips.length}`);
  log("═══════════════════════════════════════════════");

  const equipmentCounts = {};
  const techniqueCounts = {};
  index.clips.forEach((c) => {
    (c.tags.equipment || []).forEach((e) => {
      equipmentCounts[e] = (equipmentCounts[e] || 0) + 1;
    });
    (c.tags.technique || []).forEach((t) => {
      techniqueCounts[t] = (techniqueCounts[t] || 0) + 1;
    });
  });

  const topEquipment = Object.entries(equipmentCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const topTechniques = Object.entries(techniqueCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);

  if (topEquipment.length > 0) {
    log("\n  Top equipment:");
    topEquipment.forEach(([name, count]) => log(`    ${name}: ${count} clips`));
  }
  if (topTechniques.length > 0) {
    log("\n  Top techniques:");
    topTechniques.forEach(([name, count]) => log(`    ${name}: ${count} clips`));
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
