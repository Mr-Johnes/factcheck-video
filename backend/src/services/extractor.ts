import ffmpeg from "fluent-ffmpeg";
import path from "path";
import fs from "fs";

/**
 * Extracts audio from an MP4 file and saves it as MP3.
 * Returns the path to the output MP3 file.
 */
export async function extractAudio(
  mp4Path: string,
  outputDir: string
): Promise<string> {
  const baseName = path.basename(mp4Path, path.extname(mp4Path));
  const mp3Path = path.join(outputDir, `${baseName}.mp3`);

  // Ensure output directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  return new Promise((resolve, reject) => {
    ffmpeg(mp4Path)
      .noVideo()
      .audioCodec("libmp3lame")
      .audioBitrate("128k")
      .audioFrequency(16000) // Whisper works best at 16kHz
      .audioChannels(1) // Mono for speech recognition
      .output(mp3Path)
      .on("start", (cmd) => {
        console.log("[FFmpeg] Starting extraction:", cmd);
      })
      .on("progress", (progress) => {
        console.log(`[FFmpeg] Progress: ${progress.percent?.toFixed(1)}%`);
      })
      .on("end", () => {
        console.log("[FFmpeg] Audio extraction complete:", mp3Path);
        resolve(mp3Path);
      })
      .on("error", (err) => {
        console.error("[FFmpeg] Error:", err.message);
        reject(new Error(`FFmpeg extraction failed: ${err.message}`));
      })
      .run();
  });
}

/**
 * Gets the duration of a video file in seconds.
 */
export async function getVideoDuration(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        reject(new Error(`ffprobe failed: ${err.message}`));
        return;
      }
      const duration = metadata.format.duration ?? 0;
      resolve(duration);
    });
  });
}