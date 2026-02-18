# B-Roll Index

An AI-powered tool for video creators that automatically analyzes a folder of video files, identifies B-roll-worthy moments, and builds a searchable catalog. Search for "close-up pour slow-motion" and instantly know it lives at `0:01:23–0:01:26` in a specific file — ready to drag into your editor.

![B-Roll Index UI](assets/index.png)

---

## How It Works

B-Roll Index runs a three-stage pipeline and then launches a local web UI for browsing results.

**Stage 1 — Upload:** Each video is uploaded to the Google Gemini Files API.

**Stage 2 — AI Classification (Gemini Flash):** The whole video is analyzed in a single API call. Gemini returns a JSON array of B-roll segments with timestamps, shot types, scores, equipment tags, technique tags, and plain-language descriptions.

**Stage 3 — GIF Generation:** FFmpeg extracts each segment as an animated GIF preview for quick visual scanning.

**Web UI:** A local Express server serves the clip index as a REST API, and a React single-page app provides search, filtering, inline editing, and a "Reveal in Finder" button so you can drag clips straight into your NLE.

All data is stored in a single JSON file per project — no database required. The taxonomy (shot types, equipment, techniques, products) lives in a JSON file you can edit to match your content niche, and is injected into the Gemini prompt at analysis time.

---

## Requirements

- **Node.js** 18 or later (`node --version` to check)
- **FFmpeg** — install with `brew install ffmpeg` (macOS) or your system package manager
- **Gemini API key** — free tier available at [Google AI Studio](https://aistudio.google.com/apikey)

---

## Setup

1. Clone the repo and install dependencies:

   ```bash
   git clone https://github.com/mouseykins/broll-index.git
   cd broll-index
   npm install
   ```

2. Create your `.env` file:

   ```bash
   cp .env.example .env
   ```

   Open `.env` and replace `your_api_key_here` with your Gemini API key.

---

## Analyzing Videos

### Register a project

Start the server and open the web UI to register a folder of videos as a project:

```bash
npm start
# open http://localhost:3000
```

Click **Register a Project**, paste in the path to your video folder, and give it a name. The app will copy a default taxonomy into the project folder, which you can customize from the **Taxonomy** tab in the UI.

### Run analysis from the UI

Switch to the **Import** tab inside a project and click **Analyze new videos**. A log stream shows progress in real time.

### Run analysis from the command line

```bash
# Analyze all videos in a folder
node analyze.js --project /path/to/your/videos

# Analyze only videos not yet in the index
node analyze.js --project /path/to/your/videos --new-only

# Analyze a single specific file
node analyze.js --project /path/to/your/videos --file "my-video.mp4"
```

Analysis takes roughly 2–5 minutes per video on the free Gemini tier, depending on length.

---

## Using the Web UI

```bash
npm start
# open http://localhost:3000
```

### What you can do

- **Search** — type keywords like "close-up pour" or "tripod wide" to find clips across all indexed videos
- **Filter** — narrow results by shot type, technique, or B-roll score tier
- **View source** — every clip card shows the source video filename and timecode range (e.g. `1:23–1:26`)
- **Edit** — click any clip to open a detail panel and adjust tags, description, score, and notes
- **Delete** — remove clips that aren't useful (does not delete the video)
- **Reveal in Finder** — opens Finder with the source video selected, ready to drag into Final Cut Pro, Premiere, or DaVinci Resolve

---

## Project Structure

```
broll-index/
├── analyze.js          ← AI analysis pipeline (CLI)
├── server.js           ← Express web server + REST API
├── lib/
│   ├── classify.js     ← Gemini API upload & classification
│   ├── frames.js       ← FFmpeg GIF extraction
│   ├── project.js      ← Index & taxonomy read/write helpers
│   └── slug.js         ← URL-safe project slug generation
├── public/
│   └── index.html      ← Single-page React UI (no build step)
├── taxonomy/
│   └── default.json    ← Default shot types, techniques, equipment
├── .env.example        ← API key template
└── projects.json       ← Registry of registered project folders
```

Each registered project stores its own data inside a `.broll-index/` hidden folder within the video folder:

```
your-video-folder/
└── .broll-index/
    ├── index.json      ← All clip data for this project
    ├── taxonomy.json   ← Project-specific taxonomy (editable in UI)
    └── thumbnails/     ← Animated GIF previews
```

---

## Customizing the Taxonomy

Each project has its own taxonomy you can edit in the **Taxonomy** tab of the UI, or directly in `.broll-index/taxonomy.json`. Fields include:

- **Shot Types** — e.g. `close-up`, `wide`, `overhead`, `macro`
- **Techniques** — e.g. `slow-motion`, `timelapse`, `handheld`, `rack-focus`
- **Equipment / Props** — physical objects that appear in your videos
- **Products / Brands** — specific named products to detect
- **Subject Descriptors** — domain-specific terms for your niche
- **Minimum B-Roll Score** — clips below this threshold are filtered out during analysis

Changes to the taxonomy take effect on the next analysis run.

---

## Troubleshooting

**"FFmpeg not found"** — Install it: `brew install ffmpeg` (macOS) or check your system's package manager.

**Gemini API errors** — The free tier allows ~15 requests per minute. If you hit rate limits, wait a few minutes and retry.

**"Missing GEMINI_API_KEY"** — Ensure `.env` exists and contains your key (not the placeholder).

**Port 3000 already in use** — Run on a different port: `PORT=3001 npm start`

**Stale UI after re-analysis** — Hard-refresh the browser (`Cmd+Shift+R` / `Ctrl+Shift+R`).

---

## License

MIT
