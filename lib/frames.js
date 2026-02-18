/**
 * Frame extraction module — uses FFmpeg to extract 1 frame per second from video files.
 */

import { execFile } from "child_process";
import path from "path";
import fs from "fs";

/**
 * Check that FFmpeg is installed and accessible.
 * @returns {Promise<string>} FFmpeg version string
 */
export function checkFfmpeg() {
  return new Promise((resolve, reject) => {
    execFile("ffmpeg", ["-version"], (err, stdout) => {
      if (err) {
        reject(
          new Error(
            "FFmpeg not found. Install it with: brew install ffmpeg"
          )
        );
      } else {
        const versionLine = stdout.split("\n")[0];
        resolve(versionLine);
      }
    });
  });
}

/**
 * Get video duration in seconds using ffprobe.
 * @param {string} videoPath
 * @returns {Promise<number>}
 */
export function getVideoDuration(videoPath) {
  return new Promise((resolve, reject) => {
    execFile(
      "ffprobe",
      [
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        videoPath,
      ],
      (err, stdout) => {
        if (err) return reject(err);
        resolve(parseFloat(stdout.trim()));
      }
    );
  });
}

/**
 * Extract 1 frame per second from a video file.
 * @param {string} videoPath  — absolute path to video
 * @param {string} outputDir  — directory to write frames into
 * @param {string} prefix     — filename prefix for extracted frames
 * @returns {Promise<{framePaths: string[], duration: number}>}
 */
export function extractFrames(videoPath, outputDir, prefix) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(outputDir, { recursive: true });

    const pattern = path.join(outputDir, `${prefix}_%04d.jpg`);

    execFile(
      "ffmpeg",
      [
        "-i", videoPath,
        "-vf", "fps=1",
        "-q:v", "2",
        "-y",            // overwrite existing
        pattern,
      ],
      { maxBuffer: 10 * 1024 * 1024 },
      async (err) => {
        if (err) return reject(err);

        // Collect generated frame files, sorted numerically
        const files = fs
          .readdirSync(outputDir)
          .filter((f) => f.startsWith(prefix) && f.endsWith(".jpg"))
          .sort();

        const framePaths = files.map((f) => path.join(outputDir, f));

        let duration;
        try {
          duration = await getVideoDuration(videoPath);
        } catch {
          duration = framePaths.length; // fallback: 1 fps → count = seconds
        }

        resolve({ framePaths, duration });
      }
    );
  });
}

/**
 * Extract a single frame at a specific timestamp for use as a thumbnail.
 * @param {string} videoPath
 * @param {number} timestampSeconds
 * @param {string} outputPath — full path for the output jpg
 * @returns {Promise<string>} outputPath on success
 */
export function extractSingleFrame(videoPath, timestampSeconds, outputPath) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    execFile(
      "ffmpeg",
      [
        "-ss", String(timestampSeconds),
        "-i", videoPath,
        "-frames:v", "1",
        "-q:v", "2",
        "-y",
        outputPath,
      ],
      (err) => {
        if (err) return reject(err);
        resolve(outputPath);
      }
    );
  });
}

/**
 * Extract a clip as an animated GIF.
 * @param {string} videoPath
 * @param {number} startSeconds
 * @param {number} endSeconds
 * @param {string} outputPath — full path for the output .gif
 * @param {object} opts — optional: width (default 320)
 * @returns {Promise<string>} outputPath on success
 */
export function extractClipGif(videoPath, startSeconds, endSeconds, outputPath, opts = {}) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    const duration = Math.max(endSeconds - startSeconds, 1);
    const width = opts.width || 320;

    // Two-pass approach: generate palette first for better quality
    // Single pass with reasonable settings for speed
    execFile(
      "ffmpeg",
      [
        "-ss", String(startSeconds),
        "-t", String(duration),
        "-i", videoPath,
        "-vf", `fps=8,scale=${width}:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer`,
        "-loop", "0",
        "-y",
        outputPath,
      ],
      { maxBuffer: 50 * 1024 * 1024 },
      (err) => {
        if (err) return reject(err);
        resolve(outputPath);
      }
    );
  });
}
