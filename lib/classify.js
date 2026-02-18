/**
 * Gemini Flash classification module — V2 (whole-video analysis).
 * Uploads the video to Gemini Files API, then asks for B-roll segments
 * with timestamps. No frame extraction needed.
 */

import fs from "fs";
import https from "https";
import http from "http";

const GEMINI_MODEL = "gemini-3-flash-preview";
const API_BASE = "https://generativelanguage.googleapis.com";

// ─── Prompt ──────────────────────────────────────────────────────────────────

function buildPrompt(taxonomy) {
  const domainContext = taxonomy.promptContext
    ? `\nContent context: ${taxonomy.promptContext}\n`
    : '';
  return `You are a strict B-roll classifier.${domainContext} You are watching a complete video. Your job is to identify SEGMENTS of the video that work as STANDALONE B-roll inserts — meaning they could be dropped into any related video as a cutaway without context.

Watch the ENTIRE video and identify every continuous segment that qualifies as B-roll.

CRITICAL RULES FOR SEGMENTS:
- A segment is a CONTINUOUS shot between camera cuts. Do NOT split a single continuous shot into multiple 1-second entries.
- Each segment MUST be at least 2 seconds long. If a shot lasts only 1 second, include it in the adjacent segment or skip it.
- If consecutive seconds show the same subject from the same camera angle, they are ONE segment, not separate entries.
- startTime and endTime must be DIFFERENT. A segment of "0:03" to "0:03" is invalid.

CRITICAL RULES FOR SCORING:
- B-roll must work WITHOUT the presenter. If a person is visible AT ALL (hands holding something toward camera, sitting at a table, talking, gesturing, body visible), this is NOT good B-roll.
- Only hands performing a technique where the TECHNIQUE is the focus and the person is not otherwise visible count as B-roll.
- A "top-down" shot means the camera is directly ABOVE looking straight down. If you can see the horizon, a wall, or a person's face/torso, it is NOT top-down.
- Wide shots that show a room, table setting, or scene with a person present are "wide" or "talking-head", NOT B-roll.
- Text overlays, title cards, subscribe buttons, and captions make a segment NOT B-roll (score 0.1 or below).
- Be HARSH with scoring. Most of a video is NOT good B-roll. A typical 60-second video might have only 5-15 seconds of genuinely usable B-roll.
- Each segment should be a continuous shot. When the camera cuts, start a new segment.

For EACH B-roll segment you find, return:

1. startTime — MM:SS timestamp where the segment begins
2. endTime — MM:SS timestamp where the segment ends
3. shotType — one of: ${taxonomy.shotTypes.join(", ")}
   - "talking-head": presenter's face/upper body is visible
   - "wide": broad scene, room visible, person may be in frame
   - "close-up": tight on the primary subject, fills most of the frame, NO person visible
   - "top-down": camera pointing straight down from above
   - "macro": extreme close-up of texture or detail
   - "product-shot": equipment or product cleanly framed as the subject, studio-style
   - "action-shot": hands performing a technique, person's face NOT visible
   - "beauty-shot": styled final subject presentation, no person
   - "pour-shot": liquid being poured, tight framing on the pour
4. brollScore — 0.0 to 1.0. Be STRICT:
   - 0.85–1.0: PERFECT — close-up/macro/top-down of subject. Zero people. Clean framing. No text.
   - 0.65–0.85: GOOD — clear subject, maybe a hand doing a technique, no face/body. Minor imperfections OK.
   - 0.5–0.65: BORDERLINE — subject clear but person's arm/body partially visible, or framing is loose.
   - 0.25–0.5: NOT USABLE — person clearly visible, wide framing, or subject secondary to presenter.
   - 0.0–0.25: NOT B-roll — talking head, full scene with presenter, title cards, text overlays.
   KEY: Person's face/torso visible → score BELOW 0.3. Hands doing technique (technique is focus) → 0.5–0.8.
5. equipment — array from: ${taxonomy.equipment.join(", ")}
6. products — array of specific brand/model names if recognizable. Known products: ${taxonomy.products.join(", ")}
7. technique — array from: ${taxonomy.techniques.join(", ")}
8. subjectDescriptors — array from: ${(taxonomy.subjectDescriptors || []).join(", ")} (or empty array if none apply)
9. description — one ACCURATE sentence describing the segment: what's in frame, camera angle, action happening.
10. presenterVisible — boolean. TRUE if any part of a person is visible. FALSE only if the frame shows ONLY the subject/equipment, or just disembodied hands doing a technique.
11. other — array of notable visual elements (e.g. "steam", "text-overlay", "motion-blur", "reflection")
12. bestMoment — MM:SS timestamp of the single most visually representative moment of this segment (the frame that best shows what you described). This should be the clearest, most recognizable instant.

IMPORTANT: Only return segments that score 0.3 or above. Skip segments that are clearly not B-roll (talking head, title cards, etc.) — we only want candidates worth considering.

Respond with a JSON array of segment objects. Each object must have these exact keys:
{ "startTime", "endTime", "bestMoment", "shotType", "brollScore", "equipment", "products", "technique", "subjectDescriptors", "description", "presenterVisible", "other" }

If the video has NO usable B-roll segments at all, return an empty array: []

Respond ONLY with the JSON array, no markdown fencing, no extra text.`;
}

// ─── HTTP helpers ────────────────────────────────────────────────────────────

/**
 * Generic HTTPS request. Returns { statusCode, headers, body }.
 */
function rawRequest(url, options, bodyData) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const reqOptions = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: options.method || "POST",
      headers: options.headers || {},
    };

    const req = https.request(reqOptions, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString(),
        });
      });
    });

    req.on("error", reject);
    if (bodyData) req.write(bodyData);
    req.end();
  });
}

function postJSON(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const parsed = new URL(url);

    const req = https.request(
      {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        let chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString();
          try {
            const json = JSON.parse(body);
            if (res.statusCode >= 400) {
              const errMsg = json.error?.message || `HTTP ${res.statusCode}`;
              reject(new Error(errMsg));
            } else {
              resolve(json);
            }
          } catch {
            reject(new Error(`Invalid JSON (HTTP ${res.statusCode}): ${body.slice(0, 300)}`));
          }
        });
      }
    );

    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

// ─── Gemini Files API ────────────────────────────────────────────────────────

/**
 * Upload a video file to the Gemini Files API using resumable upload.
 * Returns the file_uri for use in generateContent.
 * Retries up to 3 times on transient failures.
 */
export async function uploadVideo(apiKey, videoPath) {
  const stat = fs.statSync(videoPath);
  const fileSize = stat.size;
  const mimeType = getMimeType(videoPath);
  const displayName = videoPath.split("/").pop();
  const sizeMB = (fileSize / (1024 * 1024)).toFixed(1);

  console.log(`  File: ${displayName} (${sizeMB} MB, ${mimeType})`);

  const MAX_RETRIES = 3;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      // Step 1: Initiate resumable upload
      const initUrl = `${API_BASE}/upload/v1beta/files?key=${apiKey}`;
      const initRes = await rawRequest(initUrl, {
        method: "POST",
        headers: {
          "X-Goog-Upload-Protocol": "resumable",
          "X-Goog-Upload-Command": "start",
          "X-Goog-Upload-Header-Content-Length": String(fileSize),
          "X-Goog-Upload-Header-Content-Type": mimeType,
          "Content-Type": "application/json",
        },
      }, JSON.stringify({ file: { displayName } }));

      const uploadUrl = initRes.headers["x-goog-upload-url"];
      if (!uploadUrl) {
        throw new Error(`Failed to initiate upload (HTTP ${initRes.statusCode}): ${initRes.body.slice(0, 300)}`);
      }

      // Step 2: Upload the actual bytes
      const fileData = fs.readFileSync(videoPath);
      const uploadRes = await rawRequest(uploadUrl, {
        method: "POST",
        headers: {
          "Content-Length": String(fileSize),
          "X-Goog-Upload-Offset": "0",
          "X-Goog-Upload-Command": "upload, finalize",
        },
      }, fileData);

      let fileInfo;
      try {
        fileInfo = JSON.parse(uploadRes.body);
      } catch {
        throw new Error(`Invalid response from upload (HTTP ${uploadRes.statusCode}): ${uploadRes.body.slice(0, 300)}`);
      }

      // Check for API error in response
      if (fileInfo.error) {
        const errCode = fileInfo.error.code || "unknown";
        const errMsg = fileInfo.error.message || "unknown error";
        throw new Error(`Gemini API error (${errCode}): ${errMsg}`);
      }

      const fileUri = fileInfo.file?.uri;
      const fileName = fileInfo.file?.name;
      if (!fileUri) {
        throw new Error(`No file_uri in upload response: ${JSON.stringify(fileInfo).slice(0, 300)}`);
      }

      // Step 3: Wait for file to be processed (state === ACTIVE)
      await waitForFileActive(apiKey, fileName);

      return { fileUri, mimeType, fileName };

    } catch (err) {
      if (attempt < MAX_RETRIES) {
        const backoff = 5000 * attempt;
        console.warn(`  Upload attempt ${attempt}/${MAX_RETRIES} failed: ${err.message}`);
        console.warn(`  Retrying in ${backoff / 1000}s...`);
        await sleep(backoff);
      } else {
        throw new Error(`Upload failed after ${MAX_RETRIES} attempts: ${err.message}`);
      }
    }
  }
}

/**
 * Poll the file status until it's ACTIVE (processed and ready).
 */
async function waitForFileActive(apiKey, fileName) {
  const maxWait = 120_000; // 2 minutes
  const pollInterval = 3_000;
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    const url = `${API_BASE}/v1beta/${fileName}?key=${apiKey}`;
    const res = await rawRequest(url, { method: "GET", headers: {} });
    const info = JSON.parse(res.body);

    if (info.state === "ACTIVE") return;
    if (info.state === "FAILED") {
      throw new Error(`File processing failed: ${JSON.stringify(info.error || {})}`);
    }

    // Still PROCESSING — wait and retry
    process.stdout.write(".");
    await sleep(pollInterval);
  }

  throw new Error("Timed out waiting for video file to be processed");
}

/**
 * Delete a file from the Files API to clean up.
 */
export async function deleteUploadedFile(apiKey, fileName) {
  try {
    const url = `${API_BASE}/v1beta/${fileName}?key=${apiKey}`;
    await rawRequest(url, { method: "DELETE", headers: {} });
  } catch (err) {
    // Non-fatal — files auto-delete after 48 hours anyway
    console.warn(`  Warning: couldn't delete uploaded file: ${err.message}`);
  }
}

function getMimeType(filePath) {
  const ext = filePath.split(".").pop().toLowerCase();
  const types = {
    mp4: "video/mp4",
    mov: "video/quicktime",
    mkv: "video/x-matroska",
    webm: "video/webm",
    avi: "video/x-msvideo",
  };
  return types[ext] || "video/mp4";
}

// ─── Classification ──────────────────────────────────────────────────────────

/**
 * Classify a video by sending the whole file to Gemini.
 * Returns an array of B-roll segment objects with timestamps.
 */
export async function classifyVideo(apiKey, fileUri, mimeType, taxonomy) {
  const prompt = buildPrompt(taxonomy);

  const url = `${API_BASE}/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  let retries = 0;
  while (retries < 3) {
    try {
      const response = await postJSON(url, {
        contents: [{
          parts: [
            { fileData: { fileUri, mimeType } },
            { text: prompt },
          ],
        }],
      });

      const text = response.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (!text) {
        throw new Error("No text in Gemini response");
      }

      // Parse JSON — handle possible markdown fencing
      const cleaned = text.replace(/^```json?\n?/, "").replace(/\n?```$/, "");
      const parsed = JSON.parse(cleaned);

      return Array.isArray(parsed) ? parsed : [parsed];
    } catch (err) {
      retries++;
      if (retries >= 3) {
        throw new Error(`Classification failed after 3 retries: ${err.message}`);
      }
      const backoff = 5000 * (retries + 1);
      console.warn(`  Retry ${retries}/3, waiting ${backoff}ms... (${err.message})`);
      await sleep(backoff);
    }
  }
}

// ─── Verification ────────────────────────────────────────────────────────────

/**
 * Verify thumbnail images against their descriptions.
 * For each clip, sends the thumbnail + description to Gemini asking if they match.
 * If they don't match, extracts candidate frames at nearby timestamps and asks
 * Gemini to pick the best one. The DESCRIPTION stays unchanged — we find the
 * right frame to match it, not the other way around.
 */
export async function verifyClips(apiKey, clips, extractFrameFn) {
  const url = `${API_BASE}/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  // Step 1: Send all thumbnails for a quick match check
  const parts = [];
  const clipRefs = [];

  for (const clip of clips) {
    if (!clip.thumbPath || !fs.existsSync(clip.thumbPath)) continue;
    parts.push({
      inlineData: {
        mimeType: "image/jpeg",
        data: fs.readFileSync(clip.thumbPath).toString("base64"),
      },
    });
    clipRefs.push(clip);
  }

  if (clipRefs.length === 0) return clips;

  const descriptions = clipRefs.map((c, i) =>
    `Image ${i + 1} (${c.seg.startTime}–${c.seg.endTime}): "${c.seg.description}"`
  ).join("\n");

  parts.push({
    text: `I extracted thumbnail frames from a video. For each image below, I have a description. Check if the thumbnail ACTUALLY shows what the description says.

Be strict: the image must clearly depict the action/subject described. If the description says "pouring coffee beans" but the image shows a grinder with no pouring, that does NOT match.

${descriptions}

For EACH image, respond with a JSON array (one object per image, in order):
- "index": image number (1-based)
- "matches": boolean — does the thumbnail show what the description says?

Respond ONLY with the JSON array, no markdown fencing.`
  });

  let mismatches = [];

  try {
    const response = await postJSON(url, {
      contents: [{ parts }],
    });

    const text = response.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!text) return clips;

    const cleaned = text.replace(/^```json?\n?/, "").replace(/\n?```$/, "");
    const results = JSON.parse(cleaned);

    for (const result of results) {
      const idx = result.index - 1;
      if (idx < 0 || idx >= clipRefs.length) continue;
      if (result.matches) {
        clipRefs[idx].verified = true;
        clipRefs[idx].mismatch = false;
      } else {
        clipRefs[idx].verified = false;
        clipRefs[idx].mismatch = true;
        mismatches.push(clipRefs[idx]);
      }
    }
  } catch (err) {
    console.warn(`  Verification check warning: ${err.message}`);
    return clips;
  }

  // Step 2: For each mismatch, extract candidate frames and ask Gemini to pick the best
  if (mismatches.length > 0 && extractFrameFn) {
    for (const clip of mismatches) {
      try {
        // Generate candidate frames at offsets around the bestMoment/midpoint
        const offsets = [-2, -1, 0, 1, 2, 3];
        const candidateParts = [];
        const candidateTimes = [];

        for (const offset of offsets) {
          const candidateTime = clip.thumbTime + offset;
          if (candidateTime < 0) continue;
          const candidatePath = clip.thumbPath.replace(".jpg", `_candidate_${offset}.jpg`);
          try {
            await extractFrameFn(candidateTime, candidatePath);
            candidateParts.push({
              inlineData: {
                mimeType: "image/jpeg",
                data: fs.readFileSync(candidatePath).toString("base64"),
              },
            });
            candidateTimes.push({ offset, path: candidatePath, time: candidateTime });
          } catch { /* skip frames that can't be extracted */ }
        }

        if (candidateParts.length === 0) continue;

        candidateParts.push({
          text: `I need to find the frame that best matches this description: "${clip.seg.description}"

Above are ${candidateParts.length} candidate frames extracted from nearby timestamps. Which image number (1-based) best matches the description?

Respond with ONLY a JSON object: { "bestImage": <number> }
No markdown fencing.`
        });

        const pickResponse = await postJSON(url, {
          contents: [{ parts: candidateParts }],
        });

        const pickText = pickResponse.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        if (pickText) {
          const pickCleaned = pickText.replace(/^```json?\n?/, "").replace(/\n?```$/, "");
          const pick = JSON.parse(pickCleaned);
          const bestIdx = (pick.bestImage || 1) - 1;
          if (bestIdx >= 0 && bestIdx < candidateTimes.length) {
            // Copy the winning candidate to the actual thumbnail path
            const winner = candidateTimes[bestIdx];
            fs.copyFileSync(winner.path, clip.thumbPath);
            clip.mismatch = false;
            clip.verified = true;
          }
        }

        // Clean up candidate files
        for (const c of candidateTimes) {
          try { fs.unlinkSync(c.path); } catch { /* ignore */ }
        }

        // Rate limit between verification calls
        await sleep(2000);
      } catch (err) {
        console.warn(`  Could not verify ${clip.clipId}: ${err.message}`);
      }
    }
  }

  return clips;
}

// ─── Utilities ───────────────────────────────────────────────────────────────

/**
 * Parse MM:SS timestamp to seconds.
 */
export function parseTimestamp(ts) {
  if (typeof ts === "number") return ts;
  const parts = String(ts).split(":");
  if (parts.length === 2) {
    return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
  }
  return parseInt(ts, 10) || 0;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
