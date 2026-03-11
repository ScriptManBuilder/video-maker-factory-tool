import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { execa } from "execa";
import { z } from "zod";
import { renderSatisfying, type OverlayLine } from "./render.ts";

const FFMPEG_PATH = "C:\\Program Files\\ffmpeg.exe";

// ═══════════════════════════════════════════════════════════════════════════
// CLI PARSING
// ═══════════════════════════════════════════════════════════════════════════

function parseArgs() {
  const args = process.argv.slice(2);
  const opts: Record<string, string> = {};
  const flags = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith("--")) continue;

    const key = a.slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith("--")) {
      opts[key] = next;
      i++;
    } else {
      flags.add(key);
    }
  }

  const withMusic = opts["withMusic"]
    ? opts["withMusic"] !== "false"
    : !flags.has("noMusic");
  const withSubtitles = opts["withSubtitles"]
    ? opts["withSubtitles"] !== "false"
    : !flags.has("noSubtitles");

  return {
    pattern: opts["pattern"] ?? "mat2_scene_",
    start: opts["start"] ? Number(opts["start"]) : 1,
    end: opts["end"] ? Number(opts["end"]) : 6,
    videoDir: opts["videoDir"] ?? "out/renders",
    music: opts["music"],
    musicCategory: opts["musicCategory"] ?? "ambient",
    hooks: opts["hooks"] ?? "templates/hooks.json",
    output: opts["output"] ?? `out/renders/concat_${Date.now()}.mp4`,
    duration: opts["duration"] ? Number(opts["duration"]) : null,
    speed: opts["speed"] ? Number(opts["speed"]) : undefined,
    withMusic,
    withSubtitles,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// SCHEMAS
// ═══════════════════════════════════════════════════════════════════════════

const HooksSchema = z.object({
  openers: z.array(z.string()),
  buildup: z.array(z.string()),
  peak: z.array(z.string()),
  engagement: z.array(z.string()),
  retention: z.array(z.string()),
  loopBait: z.array(z.string()),
  vibes: z.array(z.string()),
  filler: z.array(z.string()),
  peakSequences: z.array(z.array(z.string())),
  textPositions: z.array(z.string()),
  config: z.object({
    minInterval: z.number(),
    maxInterval: z.number(),
    peakMoments: z.number(),
    peakTimingPercent: z.array(z.number()),
    engagementTimingPercent: z.array(z.number()),
    retentionTimingPercent: z.array(z.number()),
  }),
});

type Hooks = z.infer<typeof HooksSchema>;

// ═══════════════════════════════════════════════════════════════════════════
// RANDOM UTILITIES
// ═══════════════════════════════════════════════════════════════════════════

class SeededRandom {
  private seed: number;

  constructor(seed: number) {
    this.seed = seed;
  }

  next(): number {
    this.seed = (this.seed * 1103515245 + 12345) & 0x7fffffff;
    return this.seed / 0x7fffffff;
  }

  int(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  float(min: number, max: number): number {
    return this.next() * (max - min) + min;
  }

  pick<T>(arr: readonly T[]): T {
    if (arr.length === 0) throw new Error("Empty array");
    return arr[this.int(0, arr.length - 1)]!;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// FILE HELPERS
// ═══════════════════════════════════════════════════════════════════════════

const AUDIO_EXTS = [".mp3", ".wav", ".m4a", ".aac"];

function listFiles(dir: string, exts: string[]): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .map((f) => path.join(dir, f))
    .filter((p) => {
      try {
        return fs.statSync(p).isFile() && exts.includes(path.extname(p).toLowerCase());
      } catch {
        return false;
      }
    });
}

function loadJSON<T>(filePath: string, schema: z.ZodType<T>, label: string): T {
  const p = path.resolve(filePath);
  if (!fs.existsSync(p)) throw new Error(`${label} not found: ${p}`);
  const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
  return schema.parse(raw);
}

function writeConcatFile(videos: string[]): string {
  const tmp = path.join(os.tmpdir(), `sf_plain_concat_${Date.now()}.txt`);
  const content = videos
    .map((v) => `file '${v.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`)
    .join("\n");
  fs.writeFileSync(tmp, content, "utf-8");
  return tmp;
}

async function createThumbnail(videoPath: string, outputThumb: string) {
  const args = [
    "-y",
    "-ss", "1.0",
    "-i", videoPath,
    "-vframes", "1",
    "-update", "1",
    "-q:v", "2",
    outputThumb,
  ];

  try {
    await execa(FFMPEG_PATH, args, { stdio: "inherit" });
  } catch (err: unknown) {
    console.warn("  [warn] Thumbnail failed:", err instanceof Error ? err.message : err);
  }
}

async function concatPlain(videos: string[], outputFile: string) {
  const concatFile = writeConcatFile(videos);

  try {
    try {
      // Fast path: stream copy (no re-encode)
      await execa(
        FFMPEG_PATH,
        ["-y", "-f", "concat", "-safe", "0", "-i", concatFile, "-c", "copy", outputFile],
        { stdio: "inherit" },
      );
      return;
    } catch {
      console.log("  [warn] Stream copy concat failed, retrying with re-encode...");
    }

    // Fallback for mixed codecs/container parameters
    await execa(
      FFMPEG_PATH,
      [
        "-y",
        "-f", "concat",
        "-safe", "0",
        "-i", concatFile,
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "20",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "192k",
        outputFile,
      ],
      { stdio: "inherit" },
    );
  } finally {
    try {
      fs.unlinkSync(concatFile);
    } catch {
      // ignore cleanup errors
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// OVERLAY GENERATION
// ═══════════════════════════════════════════════════════════════════════════

function generateOverlaysForConcat(
  duration: number,
  hooks: Hooks,
  rng: SeededRandom,
  sceneCount: number,
): OverlayLine[] {
  const overlays: OverlayLine[] = [];
  const positions: ("top" | "center" | "bottom")[] = ["top", "center", "bottom"];
  
  // Assuming 10 seconds per video, calculate scene transition times
  const sceneDuration = duration / sceneCount;

  // 1. Opening text (appears in the first second)
  overlays.push({
    t: 0.5,
    text: rng.pick(hooks.openers),
    position: "top",
    style: "default",
  });

  // 2. Add text for each scene
  for (let i = 0; i < sceneCount; i++) {
    const sceneStart = i * sceneDuration;
    const sceneMid = sceneStart + sceneDuration / 2;
    
    // Add text in the middle of the scene
    if (i < sceneCount - 1) {
      overlays.push({
        t: Math.round((sceneMid) * 100) / 100,
        text: rng.pick([...hooks.vibes, ...hooks.engagement]),
        position: rng.pick(positions),
        style: "default",
      });
    }
  }

  // 3. Add peak moment (at 60% position)
  const peakSeq = rng.pick(hooks.peakSequences);
  overlays.push({
    t: Math.round((duration * 0.6) * 100) / 100,
    text: peakSeq[0] ?? rng.pick(hooks.peak),
    position: "center",
    style: "emphasis",
  });

  // 4. Add retention text (at 80% position)
  overlays.push({
    t: Math.round((duration * 0.8) * 100) / 100,
    text: rng.pick(hooks.retention),
    position: rng.pick(positions),
    style: "default",
  });

  // 5. Ending loop bait
  overlays.push({
    t: Math.max(duration - 4, duration * 0.92),
    text: rng.pick(hooks.loopBait),
    position: "center",
    style: "emphasis",
  });

  // Sort and deduplicate
  overlays.sort((a, b) => a.t - b.t);
  
  return overlays;
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  const cli = parseArgs();

  console.log("\n╔══════════════════════════════════════╗");
  console.log("║     VIDEO CONCATENATOR               ║");
  console.log("║     Sequential Video Stitcher        ║");
  console.log("╚══════════════════════════════════════╝\n");

  const videoSpeed = Math.min(2.5, Math.max(1, cli.speed ?? 1));

  const hooks = cli.withSubtitles ? loadJSON(cli.hooks, HooksSchema, "Hooks") : null;

  // 查找符合模式的视频文件
  const videoFiles: string[] = [];
  for (let i = cli.start; i <= cli.end; i++) {
    const filename = `${cli.pattern}${i}.mp4`;
    const filepath = path.resolve(cli.videoDir, filename);
    
    if (!fs.existsSync(filepath)) {
      console.error(`[!] File not found: ${filepath}`);
      console.log(`    Trying other formats...`);
      
      // Try alternative file formats
      const altFormats = [
        `${cli.pattern}${i}.mov`,
        `${cli.pattern}${i}.mkv`,
        `${cli.pattern}${i}.webm`,
      ];
      
      let found = false;
      for (const alt of altFormats) {
        const altPath = path.resolve(cli.videoDir, alt);
        if (fs.existsSync(altPath)) {
          videoFiles.push(altPath);
          found = true;
          console.log(`    ✓ Found: ${alt}`);
          break;
        }
      }
      
      if (!found) {
        console.error(`[X] Cannot find video file for scene ${i}`);
        process.exit(1);
      }
    } else {
      videoFiles.push(filepath);
      console.log(`  ✓ Found: ${filename}`);
    }
  }

  console.log(`\nFound ${videoFiles.length} video files`);

  // 选择音乐文件（可选）
  let musicFile: string | undefined;
  if (cli.withMusic) {
    if (cli.music) {
      musicFile = path.resolve(cli.music);
      if (!fs.existsSync(musicFile)) {
        console.error(`[X] Music file not found: ${musicFile}`);
        process.exit(1);
      }
    } else {
      // 从音乐目录随机选择
      const musicDir = path.resolve("assets/music", cli.musicCategory);
      const musicFiles = listFiles(musicDir, AUDIO_EXTS);

      if (musicFiles.length === 0) {
        console.error(`[X] No music files found in ${musicDir}`);
        process.exit(1);
      }

      const rng = new SeededRandom(Date.now());
      musicFile = rng.pick(musicFiles);
    }

    if (!musicFile) {
      console.error("[X] Failed to resolve music file");
      process.exit(1);
    }
    console.log(`Music: ${path.basename(musicFile)}`);
  } else {
    console.log("Music: disabled (keeping source audio if present)");
  }

  // Calculate total duration
  const defaultDuration = videoFiles.length * 10;
  const totalDuration = cli.duration ?? defaultDuration;
  
  console.log(`Estimated duration: ${totalDuration}s`);

  // Generate text overlays (optional)
  const seed = crypto.randomInt(1, 1_000_000_000);
  const rng = new SeededRandom(seed);
  const overlays = cli.withSubtitles && hooks
    ? generateOverlaysForConcat(totalDuration, hooks, rng, videoFiles.length)
    : [];

  console.log(
    cli.withSubtitles
      ? `Generated ${overlays.length} text overlays`
      : "Subtitles: disabled",
  );
  console.log(`Video speed: ${videoSpeed.toFixed(2)}x`);
  console.log(`Output file: ${cli.output}\n`);

  // 确保输出目录存在
  fs.mkdirSync(path.dirname(cli.output), { recursive: true });

  const outputThumb = cli.output.replace(/\.mp4$/i, ".jpg");

  const plainConcatOnly = !cli.withMusic && !cli.withSubtitles && videoSpeed === 1;

  if (plainConcatOnly) {
    console.log("Mode: plain concat (no added music, no subtitles)");
    await concatPlain(videoFiles, cli.output);
    await createThumbnail(cli.output, outputThumb);

    const meta = {
      type: "concatenated",
      mode: "plain",
      sceneCount: videoFiles.length,
      scenes: videoFiles.map(v => path.basename(v)),
      music: null,
      withMusic: false,
      withSubtitles: false,
      duration: totalDuration,
      videoSpeed: 1,
      overlays: [],
      seed: null,
      generatedAt: new Date().toISOString(),
    };

    const metaPath = cli.output.replace(/\.mp4$/i, ".meta.json");
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf-8");

    console.log("\n═══════════════════════════════════════");
    console.log("[+] Plain video concatenation complete!");
    console.log(`    Output: ${cli.output}`);
    console.log(`    Thumbnail: ${outputThumb}`);
    console.log(`    Metadata: ${metaPath}`);
    console.log("═══════════════════════════════════════\n");
    return;
  }

  // Render video
  const renderOpts: Parameters<typeof renderSatisfying>[0] = {
    inputVideo: videoFiles, // Pass video array in order
    outputVideo: cli.output,
    outputThumb: outputThumb,
    duration: totalDuration,
    videoSpeed,
    overlays: overlays,
    seed: seed,
  };

  if (musicFile) {
    renderOpts.inputAudio = musicFile;
  }

  await renderSatisfying(renderOpts);

  // Save metadata
  const meta = {
    type: "concatenated",
    sceneCount: videoFiles.length,
    scenes: videoFiles.map(v => path.basename(v)),
    music: musicFile ? path.basename(musicFile) : null,
    withMusic: cli.withMusic,
    withSubtitles: cli.withSubtitles,
    duration: totalDuration,
    videoSpeed: Number(videoSpeed.toFixed(3)),
    overlays: overlays,
    seed: seed,
    generatedAt: new Date().toISOString(),
  };
  
  const metaPath = cli.output.replace(/\.mp4$/i, ".meta.json");
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf-8");

  console.log("\n═══════════════════════════════════════");
  console.log(`[+] Video concatenation complete!`);
  console.log(`    Output: ${cli.output}`);
  console.log(`    Thumbnail: ${outputThumb}`);
  console.log(`    Metadata: ${metaPath}`);
  console.log("═══════════════════════════════════════\n");
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error("\n[X] Failed:", msg);
  if (e instanceof Error && e.stack) {
    console.error(e.stack);
  }
  process.exit(1);
});
