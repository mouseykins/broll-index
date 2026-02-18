/**
 * B-Roll Index — Local web server.
 * Manages multiple projects and serves the UI + REST API.
 */

import "dotenv/config";

import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawn, execFile } from "child_process";
import { slugify, uniqueSlug } from "./lib/slug.js";
import {
  loadIndex, saveIndex, loadTaxonomy, saveTaxonomy,
  getIndexPath, getThumbnailsDir,
} from "./lib/project.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

const PROJECTS_PATH = path.join(__dirname, "projects.json");
const DEFAULT_TAXONOMY_PATH = path.join(__dirname, "taxonomy", "default.json");
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".webm", ".avi"]);

// ─── Project registry ────────────────────────────────────────────────────────

function loadProjects() {
  if (fs.existsSync(PROJECTS_PATH)) {
    return JSON.parse(fs.readFileSync(PROJECTS_PATH, "utf-8"));
  }
  return { version: "1.0", projects: [] };
}

function saveProjects(registry) {
  fs.writeFileSync(PROJECTS_PATH, JSON.stringify(registry, null, 2));
}

function findProject(slug) {
  return loadProjects().projects.find((p) => p.slug === slug) || null;
}

function toTitleCase(str) {
  return str.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// ─── Analysis jobs (one per project) ────────────────────────────────────────
const analysisJobs = new Map(); // slug → job object

// ─── Middleware ──────────────────────────────────────────────────────────────

app.use(express.json());
app.use(express.static(path.join(__dirname, "public"), {
  setHeaders(res, filePath) {
    if (filePath.endsWith(".html")) {
      res.setHeader("Cache-Control", "no-store");
    }
  },
}));

// ─── Project registry routes ─────────────────────────────────────────────────

// GET /api/projects
app.get("/api/projects", (req, res) => {
  const registry = loadProjects();
  const projects = registry.projects.map((p) => {
    let clipCount = 0, videoCount = 0, lastUpdated = null;
    try {
      const idx = loadIndex(p.folderPath);
      clipCount = idx.clips.length;
      videoCount = Object.keys(idx.videos).length;
      lastUpdated = idx.lastUpdated;
    } catch {}
    return { ...p, clipCount, videoCount, lastUpdated };
  });
  res.json({ projects });
});

// POST /api/projects — register a new project
app.post("/api/projects", (req, res) => {
  const { folderPath, name, logoUrl } = req.body;
  if (!folderPath) return res.status(400).json({ error: "folderPath is required" });

  const resolved = path.resolve(folderPath);
  if (!fs.existsSync(resolved)) {
    return res.status(400).json({ error: `Folder not found: ${resolved}` });
  }

  const registry = loadProjects();
  const existingSlugs = new Set(registry.projects.map((p) => p.slug));
  const existingPaths = new Set(registry.projects.map((p) => p.folderPath));

  if (existingPaths.has(resolved)) {
    return res.status(409).json({ error: "This folder is already registered as a project" });
  }

  const folderName = path.basename(resolved);
  const slug = uniqueSlug(name || folderName, existingSlugs);
  const projectName = name || toTitleCase(folderName);

  // Copy generic default taxonomy into project if none exists
  if (!loadTaxonomy(resolved)) {
    const defaultTaxonomy = JSON.parse(fs.readFileSync(DEFAULT_TAXONOMY_PATH, "utf-8"));
    saveTaxonomy(resolved, defaultTaxonomy);
  }

  const project = {
    slug,
    name: projectName,
    folderPath: resolved,
    logoUrl: logoUrl || null,
    registeredAt: new Date().toISOString(),
    lastAnalyzed: null,
  };

  registry.projects.push(project);
  saveProjects(registry);
  res.json({ project });
});

// PATCH /api/projects/:slug — update project metadata (name, logoUrl)
app.patch("/api/projects/:slug", (req, res) => {
  const { name, logoUrl } = req.body;

  const registry = loadProjects();
  const project = registry.projects.find((p) => p.slug === req.params.slug);
  if (!project) return res.status(404).json({ error: "Project not found" });

  if (name !== undefined) project.name = name;
  if (logoUrl !== undefined) project.logoUrl = logoUrl || null;
  saveProjects(registry);
  res.json({ project });
});

// DELETE /api/projects/:slug — unregister (does NOT delete files)
app.delete("/api/projects/:slug", (req, res) => {
  const registry = loadProjects();
  const before = registry.projects.length;
  registry.projects = registry.projects.filter((p) => p.slug !== req.params.slug);
  if (registry.projects.length === before) {
    return res.status(404).json({ error: "Project not found" });
  }
  saveProjects(registry);
  res.json({ success: true });
});

// ─── Per-project data routes ─────────────────────────────────────────────────

// GET /api/projects/:slug/thumbnails/:filename — serve a GIF
app.get("/api/projects/:slug/thumbnails/:filename", (req, res) => {
  const project = findProject(req.params.slug);
  if (!project) return res.status(404).send("Project not found");
  const filePath = path.join(getThumbnailsDir(project.folderPath), req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).send("Not found");
  res.sendFile(filePath);
});

// GET /api/projects/:slug/index
app.get("/api/projects/:slug/index", (req, res) => {
  const project = findProject(req.params.slug);
  if (!project) return res.status(404).json({ error: "Project not found" });

  const index = loadIndex(project.folderPath);
  const slug = req.params.slug;

  // Rewrite thumbnail filename → full API URL, normalise nested tags, and denormalize video filename
  index.clips = index.clips.map((clip) => {
    const videoInfo = clip.videoId ? index.videos[clip.videoId] : null;
    // Flatten legacy clips that stored metadata inside a `tags` sub-object
    const tags = clip.tags || {};
    return {
      ...clip,
      shotType: clip.shotType ?? tags.shotType ?? null,
      technique: clip.technique ?? (Array.isArray(tags.technique) ? tags.technique[0] : tags.technique) ?? null,
      equipment: clip.equipment ?? tags.equipment ?? [],
      products: clip.products ?? tags.products ?? [],
      subjectDescriptors: clip.subjectDescriptors ?? tags.subjectDescriptors ?? [],
      thumbnail: clip.thumbnail
        ? `/api/projects/${slug}/thumbnails/${clip.thumbnail}`
        : null,
      sourceFilename: videoInfo?.filename || null,
      sourceFilePath: videoInfo ? path.join(videoInfo.sourcePath, videoInfo.filename) : null,
    };
  });

  res.json(index);
});

// GET /api/projects/:slug/taxonomy
app.get("/api/projects/:slug/taxonomy", (req, res) => {
  const project = findProject(req.params.slug);
  if (!project) return res.status(404).json({ error: "Project not found" });
  const taxonomy = loadTaxonomy(project.folderPath);
  if (!taxonomy) return res.status(404).json({ error: "No taxonomy found for this project" });
  res.json(taxonomy);
});

// PUT /api/projects/:slug/taxonomy — replace entire taxonomy
app.put("/api/projects/:slug/taxonomy", (req, res) => {
  const project = findProject(req.params.slug);
  if (!project) return res.status(404).json({ error: "Project not found" });
  saveTaxonomy(project.folderPath, req.body);
  res.json(req.body);
});

// PATCH /api/projects/:slug/clips/:id — edit a clip
app.patch("/api/projects/:slug/clips/:id", (req, res) => {
  const project = findProject(req.params.slug);
  if (!project) return res.status(404).json({ error: "Project not found" });

  const index = loadIndex(project.folderPath);
  const clip = index.clips.find((c) => c.id === req.params.id);
  if (!clip) return res.status(404).json({ error: "Clip not found" });

  Object.assign(clip, req.body);
  clip.userEdited = true;
  saveIndex(project.folderPath, index);
  res.json(clip);
});

// DELETE /api/projects/:slug/clips/:id
app.delete("/api/projects/:slug/clips/:id", (req, res) => {
  const project = findProject(req.params.slug);
  if (!project) return res.status(404).json({ error: "Project not found" });

  const index = loadIndex(project.folderPath);
  const before = index.clips.length;
  index.clips = index.clips.filter((c) => c.id !== req.params.id);
  if (index.clips.length === before) {
    return res.status(404).json({ error: "Clip not found" });
  }

  saveIndex(project.folderPath, index);
  res.json({ success: true });
});

// GET /api/projects/:slug/videos
app.get("/api/projects/:slug/videos", (req, res) => {
  const project = findProject(req.params.slug);
  if (!project) return res.status(404).json({ error: "Project not found" });

  const sourceDir = project.folderPath;
  if (!fs.existsSync(sourceDir)) {
    return res.json({ sourceDir: null, videos: [] });
  }

  const index = loadIndex(project.folderPath);
  const indexedMap = {};
  for (const [vid, info] of Object.entries(index.videos)) {
    indexedMap[info.filename] = {
      videoId: vid,
      ...info,
      clipCount: index.clips.filter((c) => c.videoId === vid).length,
    };
  }

  const filesOnDisk = fs
    .readdirSync(sourceDir)
    .filter((f) => VIDEO_EXTENSIONS.has(path.extname(f).toLowerCase()))
    .sort();

  const videos = filesOnDisk.map((filename) => {
    const indexed = indexedMap[filename] || null;
    let sizeBytes = 0;
    try { sizeBytes = fs.statSync(path.join(sourceDir, filename)).size; } catch {}
    return {
      filename,
      sizeBytes,
      sizeMB: (sizeBytes / (1024 * 1024)).toFixed(1),
      indexed: !!indexed,
      videoId: indexed?.videoId || null,
      dateAnalyzed: indexed?.dateAnalyzed || null,
      clipCount: indexed?.clipCount || 0,
      duration: indexed?.duration || null,
    };
  });

  res.json({ sourceDir, videos });
});

// POST /api/projects/:slug/analyze — trigger analysis
app.post("/api/projects/:slug/analyze", (req, res) => {
  const project = findProject(req.params.slug);
  if (!project) return res.status(404).json({ error: "Project not found" });

  const existing = analysisJobs.get(req.params.slug);
  if (existing && existing.status === "running") {
    return res.status(409).json({ error: "Analysis already running", job: existing });
  }

  const { filename } = req.body;
  const args = ["analyze.js", "--project", project.folderPath];
  if (filename) args.push("--file", filename);
  else args.push("--new-only");

  const job = {
    status: "running",
    filename: filename || "(all new videos)",
    log: [],
    startedAt: new Date().toISOString(),
  };
  analysisJobs.set(req.params.slug, job);

  const child = spawn("node", args, {
    cwd: __dirname,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (data) => {
    const lines = data.toString().split("\n").filter(Boolean);
    job.log.push(...lines);
    if (job.log.length > 500) job.log = job.log.slice(-300);
  });

  child.stderr.on("data", (data) => {
    const lines = data.toString().split("\n").filter(Boolean);
    job.log.push(...lines.map((l) => `[ERROR] ${l}`));
  });

  child.on("close", (code) => {
    job.status = code === 0 ? "completed" : "failed";
    job.exitCode = code;
    job.finishedAt = new Date().toISOString();
  });

  res.json({ success: true, job });
});

// GET /api/projects/:slug/analyze/status
app.get("/api/projects/:slug/analyze/status", (req, res) => {
  const job = analysisJobs.get(req.params.slug);
  if (!job) return res.json({ status: "idle" });
  res.json(job);
});

// POST /api/pick — open a native macOS file/folder picker dialog
app.post("/api/pick", (req, res) => {
  const { type } = req.body; // "folder" or "file"
  const script = type === "file"
    ? `tell application "Finder"\nactivate\nset f to choose file with prompt "Choose a logo image"\nPOSIX path of f\nend tell`
    : `tell application "Finder"\nactivate\nset f to choose folder with prompt "Choose a video folder"\nPOSIX path of f\nend tell`;

  execFile("osascript", ["-e", script], (err, stdout) => {
    if (err) {
      // User cancelled — err.code 1, not a real error
      return res.json({ cancelled: true });
    }
    res.json({ path: stdout.trim() });
  });
});

// POST /api/reveal — open a new Finder window and select the file (macOS)
app.post("/api/reveal", (req, res) => {
  const { filePath } = req.body;
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: "File not found" });
  }
  const script = `tell application "Finder"
  activate
  set f to POSIX file "${filePath.replace(/"/g, '\\"')}" as alias
  make new Finder window
  set target of front Finder window to (container of f)
  select f
end tell`;
  execFile("osascript", ["-e", script], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// POST /api/projects/:slug/reveal — reveal file in Finder (macOS)
app.post("/api/projects/:slug/reveal", (req, res) => {
  const { filePath } = req.body;
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: "File not found" });
  }
  execFile("open", ["-R", filePath], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// GET /api/projects/:slug/export — download index backup
app.get("/api/projects/:slug/export", (req, res) => {
  const project = findProject(req.params.slug);
  if (!project) return res.status(404).json({ error: "Project not found" });
  const indexPath = getIndexPath(project.folderPath);
  if (!fs.existsSync(indexPath)) return res.status(404).json({ error: "No index found" });
  res.download(indexPath, `${req.params.slug}-index-backup.json`);
});

// ─── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`B-Roll Index running at http://localhost:${PORT}`);
  console.log(`Press Ctrl+C to stop\n`);
});
