import { execa } from "execa";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Define the full path to ffmpeg
const FFMPEG_PATH = "C:\\Program Files\\ffmpeg.exe";

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export type TextPosition = "top" | "center" | "bottom";
export type TextStyle = "default" | "emphasis" | "subtle";

export interface OverlayLine {
  t: number;
  text: string;
  position?: TextPosition;
  style?: TextStyle;
}

export interface RenderOpts {
  inputVideo: string | string[];
  inputAudio?: string;
  outputVideo: string;
  outputThumb: string;
  duration: number;
  videoSpeed?: number;
  overlays?: OverlayLine[];
  seed: number;
  fontFile?: string;
  musicVolume?: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// TEXT PROCESSING
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Strip emoji and escape special ffmpeg characters.
 */
function safeText(s: string): string {
  const cleaned = s
    .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{200D}\u{FE0F}]/gu, "")
    .trim();
  if (!cleaned) return "";
  return cleaned
    .replace(/\\/g, "\\\\\\\\")
    .replace(/'/g, "\u2019")
    .replace(/:/g, " -")  // Replace colons with dash to avoid filter parsing issues
    .replace(/;/g, "\\;");
}

// ═══════════════════════════════════════════════════════════════════════════
// STYLE CONFIGURATIONS
// ═══════════════════════════════════════════════════════════════════════════

interface StyleConfig {
  fontsize: number;
  boxborderw: number;
  boxcolor: string;
  shadowx: number;
  shadowy: number;
  displayDuration: number;
}

const STYLE_CONFIGS: Record<TextStyle, StyleConfig> = {
  default: {
    fontsize: 58,
    boxborderw: 16,
    boxcolor: "black@0.5",
    shadowx: 2,
    shadowy: 2,
    displayDuration: 1.8,
  },
  emphasis: {
    fontsize: 72,
    boxborderw: 20,
    boxcolor: "black@0.6",
    shadowx: 3,
    shadowy: 3,
    displayDuration: 2.2,
  },
  subtle: {
    fontsize: 48,
    boxborderw: 12,
    boxcolor: "black@0.35",
    shadowx: 1,
    shadowy: 1,
    displayDuration: 1.5,
  },
};

const POSITION_Y: Record<TextPosition, string> = {
  top: "80",
  center: "(h-text_h)/2",
  bottom: "h-text_h-120",
};

// ═══════════════════════════════════════════════════════════════════════════
// FILTER BUILDERS
// ═══════════════════════════════════════════════════════════════════════════

function buildDrawtext(line: OverlayLine, index: number, customFontPath?: string): string {
  const txt = safeText(line.text);
  if (!txt) return "";

  const style = STYLE_CONFIGS[line.style ?? "default"];
  const position = line.position ?? "top";
  const yPos = POSITION_Y[position];

  const from = line.t.toFixed(2);
  const to = (line.t + style.displayDuration).toFixed(2);

  // Use custom font from assets/fonts directory
  const fontPath = customFontPath
    ? path.resolve(process.cwd(), customFontPath)
    : path.resolve(process.cwd(), "assets/fonts/Poppins-Bold.ttf");
  const fontFile = fontPath.replace(/\\/g, "/").replace(/:/g, "\\\\:");

  const parts = [
    `drawtext=fontfile=${fontFile}`,
    `text=${txt}`,
    "x=(w-text_w)/2",
    `y=${yPos}`,
    `fontsize=${style.fontsize}`,
    "fontcolor=white",
    "box=1",
    `boxcolor=${style.boxcolor}`,
    `boxborderw=${style.boxborderw}`,
    `shadowx=${style.shadowx}`,
    `shadowy=${style.shadowy}`,
    "shadowcolor=black@0.4",
    `enable=between(t\\,${from}\\,${to})`,
  ];

  return parts.join(":");
}

/**
 * Build video filter string with visual variations based on seed.
 */
function buildVideoFilter(
  overlays: OverlayLine[] | undefined,
  seed: number,
  zoom: number,
  videoSpeed: number,
  customFontPath?: string,
): string {
  // Visual variation parameters
  const saturation = 1.0 + ((seed % 20) - 10) * 0.01; // 0.9 - 1.1
  const brightness = ((seed % 10) - 5) * 0.01; // -0.05 to +0.05
  const contrast = 1.0 + ((seed % 14) - 7) * 0.01; // 0.93 - 1.07

  const drawTexts = (overlays ?? [])
    .map((l, i) => buildDrawtext(l, i, customFontPath))
    .filter(Boolean);

  const vfParts = [
    // Scale to fit within 1080x1920 maintaining aspect ratio, then pad to exact size
    "scale=1080:1920:force_original_aspect_ratio=decrease",
    "pad=1080:1920:(ow-iw)/2:(oh-ih)/2",
    // Subtle zoom for variety
    `scale=iw*${zoom.toFixed(3)}:ih*${zoom.toFixed(3)}`,
    "crop=1080:1920",
    // Color grading for visual variety
    `eq=saturation=${saturation.toFixed(2)}:brightness=${brightness.toFixed(3)}:contrast=${contrast.toFixed(2)}`,
    // Slight vignette for cinematic feel
    "vignette=PI/5",
    // Text overlays
    ...drawTexts,
    // Playback speed: >1.0 means faster output motion.
    `setpts=(PTS/${videoSpeed.toFixed(3)})`,
  ];

  return vfParts.join(",");
}

/**
 * Write filter script to temp file.
 */
function writeFilterScript(content: string): string {
  const tmp = path.join(os.tmpdir(), `sf_vf_${Date.now()}.txt`);
  fs.writeFileSync(tmp, content, "utf-8");
  return tmp;
}

/**
 * Create concat file for multiple videos.
 */
function writeConcatFile(videos: string[]): string {
  const tmp = path.join(os.tmpdir(), `sf_concat_${Date.now()}.txt`);
  const content = videos.map(v => `file '${v.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n");
  fs.writeFileSync(tmp, content, "utf-8");
  return tmp;
}

function ensureDir(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN RENDER FUNCTION
// ═══════════════════════════════════════════════════════════════════════════

export async function renderSatisfying(opts: RenderOpts) {
  const {
    inputVideo,
    inputAudio,
    outputVideo,
    outputThumb,
    duration,
    videoSpeed,
    overlays,
    seed,
    fontFile,
    musicVolume,
  } = opts;

  ensureDir(outputVideo);
  ensureDir(outputThumb);

  // Variation parameters
  const audioSpeed = (0.985 + (seed % 7) * 0.005).toFixed(3);
  const zoom = 1.0 + (seed % 6) * 0.008;
  const audioVolume = (0.9 + (seed % 10) * 0.01).toFixed(2);
  const finalVideoSpeed = Math.min(2.5, Math.max(1, videoSpeed ?? 1));

  if (fontFile) console.log(`  Font: ${fontFile}`);
  const vf = buildVideoFilter(overlays, seed, zoom, finalVideoSpeed, fontFile);
  const vfFile = writeFilterScript(vf);

  console.log(`  Filter: ${vfFile}`);
  console.log(`  Visual: zoom=${zoom.toFixed(3)}`);
  console.log(`  Speed: ${finalVideoSpeed.toFixed(2)}x`);

  // Handle single video or multiple videos
  const isMultiVideo = Array.isArray(inputVideo);
  let concatFile: string | null = null;
  let videoInput: string;

  if (isMultiVideo) {
    // Create concat file for multiple videos
    concatFile = writeConcatFile(inputVideo);
    videoInput = concatFile;
    console.log(`  Concat: ${inputVideo.length} videos shuffled`);
  } else {
    videoInput = inputVideo;
  }

  const args = [
    "-y",
  ];

  if (isMultiVideo) {
    // Concat demuxer with looping
    args.push("-f", "concat", "-safe", "0", "-stream_loop", "-1", "-i", videoInput);
  } else {
    // Single video with looping and offset
    const startOffset = ((seed % 3000) / 1000).toFixed(3);
    args.push("-stream_loop", "-1", "-ss", String(startOffset), "-i", videoInput);
  }

  if (inputAudio) {
    args.push("-stream_loop", "-1", "-i", inputAudio);
  }

  args.push("-t", String(duration), "-filter_script:v", vfFile, "-map", "0:v:0");

  // Build atempo chain for original audio to match video speed
  // atempo only supports 0.5–2.0 per instance, so chain for higher speeds
  let origAtempo = "";
  if (finalVideoSpeed > 1) {
    const parts: string[] = [];
    let remaining = finalVideoSpeed;
    while (remaining > 2.0) {
      parts.push("atempo=2.0");
      remaining /= 2.0;
    }
    parts.push(`atempo=${remaining.toFixed(4)}`);
    origAtempo = parts.join(",") + ",";
  }

  if (inputAudio) {
    // Mix original audio (sped up to match video) + music track at specified volume
    const musicVol = Math.max(0, Math.min(100, musicVolume ?? 70)) / 100;
    const origVol = 1.0;
    args.push(
      "-filter_complex",
      `[0:a]${origAtempo}volume=${origVol.toFixed(2)},aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[orig];` +
      `[1:a]atempo=${audioSpeed},volume=${(musicVol * parseFloat(audioVolume)).toFixed(3)},aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[mus];` +
      `[orig][mus]amix=inputs=2:duration=first:dropout_transition=2[aout]`,
      "-map", "[aout]",
    );
  } else if (finalVideoSpeed > 1) {
    // Speed up original audio to match video speed
    args.push(
      "-filter_complex",
      `[0:a]${origAtempo}aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[aout]`,
      "-map", "[aout]",
    );
  } else {
    // Keep original scene audio if present; if not, render a silent video.
    args.push("-map", "0:a?");
  }

  args.push(
    "-shortest",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "20",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "192k",
    outputVideo,
  );

  console.log("  [ffmpeg] Rendering...");
  try {
    await execa(FFMPEG_PATH, args, { stdio: "inherit" });
  } catch (err: unknown) {
    try { fs.unlinkSync(vfFile); } catch { /* ignore */ }
    if (concatFile) try { fs.unlinkSync(concatFile); } catch { /* ignore */ }
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`ffmpeg render failed: ${msg}`);
  }

  try { fs.unlinkSync(vfFile); } catch { /* ignore */ }
  if (concatFile) try { fs.unlinkSync(concatFile); } catch { /* ignore */ }

  // Thumbnail at "best moment"
  const thumbTime = Math.min(duration * 0.15, 3).toFixed(1);
  const thumbArgs = [
    "-y",
    "-ss", thumbTime,
    "-i", outputVideo,
    "-vframes", "1",
    "-update", "1",
    "-q:v", "2",
    outputThumb,
  ];

  console.log("  [ffmpeg] Thumbnail...");
  try {
    await execa(FFMPEG_PATH, thumbArgs, { stdio: "inherit" });
  } catch (err: unknown) {
    console.warn("  [warn] Thumbnail failed:", err instanceof Error ? err.message : err);
  }

  console.log(`  [OK] Rendered: ${path.basename(outputVideo)}`);
}
