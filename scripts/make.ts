import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import { renderSatisfying, type OverlayLine, type TextPosition } from "./render.ts";

// ═══════════════════════════════════════════════════════════════════════════
// CLI PARSING
// ═══════════════════════════════════════════════════════════════════════════

function parseArgs() {
  const args = process.argv.slice(2);
  const opts: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--") && i + 1 < args.length) {
      opts[a.slice(2)] = args[++i]!;
    }
  }
  return {
    template: opts["template"] ?? "templates/satisfying.json",
    hooks: opts["hooks"] ?? "templates/hooks.json",
    loopCategory: opts["loopCategory"],
    musicCategory: opts["musicCategory"],
    variants: opts["variants"] ? Number(opts["variants"]) : undefined,
    duration: opts["duration"] ? Number(opts["duration"]) : undefined,
    intensity: opts["intensity"] as "low" | "medium" | "high" | undefined,
    font: opts["font"],
    speed: opts["speed"] ? Number(opts["speed"]) : undefined,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// SCHEMAS
// ═══════════════════════════════════════════════════════════════════════════

const TemplateSchema = z.object({
  duration: z.number().min(10).max(180),
  loopCategory: z.string().min(1),
  musicCategory: z.string().min(1),
  variants: z.number().min(1).max(50),
  intensity: z.enum(["low", "medium", "high"]).default("medium"),
  overlays: z
    .array(z.object({ t: z.number().min(0), text: z.string().min(1) }))
    .optional(),
});

const HooksSchema = z.object({
  openers: z.array(z.string()),
  buildup: z.array(z.string()),
  peak: z.array(z.string()),
  engagement: z.array(z.string()),
  retention: z.array(z.string()),
  loopBait: z.array(z.string()),
  vibes: z.array(z.string()),
  filler: z.array(z.string()),
  emotional: z.array(z.string()).optional(),
  trending: z.array(z.string()).optional(),
  questions: z.array(z.string()).optional(),
  peakSequences: z.array(z.array(z.string())),
  textPositions: z.array(z.string()),
  config: z.object({
    minInterval: z.number(),
    maxInterval: z.number(),
    peakMoments: z.number(),
    peakTimingPercent: z.array(z.number()),
    engagementTimingPercent: z.array(z.number()),
    retentionTimingPercent: z.array(z.number()),
    emotionalTimingPercent: z.array(z.number()).optional(),
    trendingTimingPercent: z.array(z.number()).optional(),
    questionTimingPercent: z.array(z.number()).optional(),
  }),
});

type Template = z.infer<typeof TemplateSchema>;
type Hooks = z.infer<typeof HooksSchema>;

// ═══════════════════════════════════════════════════════════════════════════
// RANDOM UTILITIES (seeded for reproducibility)
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

  shuffle<T>(arr: readonly T[]): T[] {
    const copy = [...arr];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [copy[i], copy[j]] = [copy[j]!, copy[i]!];
    }
    return copy;
  }

  pickN<T>(arr: readonly T[], n: number): T[] {
    const copy = [...arr];
    const result: T[] = [];
    for (let i = 0; i < Math.min(n, copy.length); i++) {
      const idx = this.int(0, copy.length - 1);
      result.push(copy.splice(idx, 1)[0]!);
    }
    return result;
  }

  shuffle<T>(arr: T[]): T[] {
    const copy = [...arr];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [copy[i], copy[j]] = [copy[j]!, copy[i]!];
    }
    return copy;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// FILE HELPERS
// ═══════════════════════════════════════════════════════════════════════════

const VIDEO_EXTS = [".mp4", ".mov", ".mkv", ".webm"];
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

function findAssets(baseDir: string, category: string, exts: string[], label: string): string[] {
  const categoryDir = path.resolve(baseDir, category);
  let files = listFiles(categoryDir, exts);

  if (files.length > 0) {
    console.log(`  [${label}] ${files.length} file(s) in ${categoryDir}`);
    return files;
  }

  const parentDir = path.resolve(baseDir);
  files = listFiles(parentDir, exts);
  if (files.length > 0) {
    console.log(`  [${label}] Fallback: ${files.length} file(s) in ${parentDir}`);
    return files;
  }

  return [];
}

function nowStamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function ensureDirs() {
  fs.mkdirSync(path.resolve("out/renders"), { recursive: true });
  fs.mkdirSync(path.resolve("out/thumbs"), { recursive: true });
}

function loadJSON<T>(filePath: string, schema: z.ZodType<T>, label: string): T {
  const p = path.resolve(filePath);
  if (!fs.existsSync(p)) throw new Error(`${label} not found: ${p}`);
  const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
  return schema.parse(raw);
}

// ═══════════════════════════════════════════════════════════════════════════
// OVERLAY GENERATION (core retention logic)
// ═══════════════════════════════════════════════════════════════════════════

interface IntensityConfig {
  minInterval: number;
  maxInterval: number;
  peakCount: number;
  engagementCount: number;
  fillerDensity: number;
}

const INTENSITY_CONFIGS: Record<string, IntensityConfig> = {
  low: { minInterval: 2.5, maxInterval: 4.0, peakCount: 2, engagementCount: 1, fillerDensity: 0.3 },
  medium: { minInterval: 1.8, maxInterval: 2.8, peakCount: 3, engagementCount: 2, fillerDensity: 0.5 },
  high: { minInterval: 1.3, maxInterval: 2.2, peakCount: 4, engagementCount: 3, fillerDensity: 0.7 },
};

function generateOverlays(
  duration: number,
  hooks: Hooks,
  rng: SeededRandom,
  intensity: "low" | "medium" | "high",
): OverlayLine[] {
  const cfg = INTENSITY_CONFIGS[intensity]!;
  const overlays: OverlayLine[] = [];
  const positions: TextPosition[] = ["top", "center", "bottom"];

  // 1. Pick a peak sequence for this variant
  const peakSeq = rng.pick(hooks.peakSequences);
  const peakTimings = hooks.config.peakTimingPercent.slice(0, cfg.peakCount);

  // 2. Place peak moments at strategic times
  peakTimings.forEach((pct, i) => {
    const t = Math.max(1, duration * pct);
    const text = peakSeq[i % peakSeq.length] ?? rng.pick(hooks.peak);
    overlays.push({
      t: Math.round(t * 100) / 100,
      text,
      position: i === peakTimings.length - 1 ? "center" : rng.pick(positions),
      style: i === peakTimings.length - 1 ? "emphasis" : "default",
    });
  });

  // 3. Place engagement hooks
  const engagementTimings = rng.pickN(hooks.config.engagementTimingPercent, cfg.engagementCount);
  engagementTimings.forEach((pct) => {
    const t = duration * pct;
    overlays.push({
      t: Math.round(t * 100) / 100,
      text: rng.pick(hooks.engagement),
      position: "bottom",
      style: "subtle",
    });
  });

  // 4. Place retention hooks in second half
  hooks.config.retentionTimingPercent.forEach((pct) => {
    if (rng.next() < 0.6) {
      const t = duration * pct;
      overlays.push({
        t: Math.round(t * 100) / 100,
        text: rng.pick(hooks.retention),
        position: rng.pick(positions),
        style: "default",
      });
    }
  });

  // 5. Always start with an opener
  overlays.push({
    t: rng.float(0.2, 0.5),
    text: rng.pick(hooks.openers),
    position: "top",
    style: "default",
  });

  // 6. Sprinkle new categories (emotional, trending, questions) if available
  if (hooks.emotional && hooks.emotional.length > 0 && hooks.config.emotionalTimingPercent) {
    for (const pct of hooks.config.emotionalTimingPercent) {
      if (rng.next() < 0.5) {
        overlays.push({
          t: Math.round(duration * pct * 100) / 100,
          text: rng.pick(hooks.emotional),
          position: rng.pick(positions),
          style: "subtle",
        });
      }
    }
  }

  if (hooks.trending && hooks.trending.length > 0 && hooks.config.trendingTimingPercent) {
    for (const pct of hooks.config.trendingTimingPercent) {
      if (rng.next() < 0.35) {
        overlays.push({
          t: Math.round(duration * pct * 100) / 100,
          text: rng.pick(hooks.trending),
          position: rng.pick(positions),
          style: "default",
        });
      }
    }
  }

  if (hooks.questions && hooks.questions.length > 0 && hooks.config.questionTimingPercent) {
    for (const pct of hooks.config.questionTimingPercent) {
      if (rng.next() < 0.4) {
        overlays.push({
          t: Math.round(duration * pct * 100) / 100,
          text: rng.pick(hooks.questions),
          position: "bottom",
          style: "subtle",
        });
      }
    }
  }

  // 7. Fill gaps with vibes/filler based on intensity
  overlays.sort((a, b) => a.t - b.t);

  const filledOverlays: OverlayLine[] = [];
  let lastT = 0;

  for (const overlay of overlays) {
    const gap = overlay.t - lastT;

    if (gap > cfg.maxInterval * 1.5 && rng.next() < cfg.fillerDensity) {
      const fillCount = Math.floor(gap / cfg.maxInterval) - 1;
      for (let i = 0; i < fillCount && i < 3; i++) {
        const fillT = lastT + cfg.minInterval + rng.float(0, gap / (fillCount + 2));
        if (fillT < overlay.t - cfg.minInterval) {
          filledOverlays.push({
            t: Math.round(fillT * 100) / 100,
            text: rng.next() < 0.6 ? rng.pick(hooks.vibes) : rng.pick(hooks.filler),
            position: rng.pick(positions),
            style: "subtle",
          });
        }
      }
    }

    filledOverlays.push(overlay);
    lastT = overlay.t + 1.6;
  }

  // 7. End with loop bait (last 3-5 seconds)
  if (rng.next() < 0.7) {
    filledOverlays.push({
      t: Math.max(duration - 4, duration * 0.92),
      text: rng.pick(hooks.loopBait),
      position: "center",
      style: "emphasis",
    });
  }

  // Sort and dedupe
  filledOverlays.sort((a, b) => a.t - b.t);
  const final: OverlayLine[] = [];
  let prevT = -999;

  for (const o of filledOverlays) {
    if (o.t - prevT >= cfg.minInterval * 0.8) {
      final.push(o);
      prevT = o.t;
    }
  }

  return final;
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  const cli = parseArgs();

  console.log("\n╔══════════════════════════════════════╗");
  console.log("║     SATISFYING FACTORY v2.0          ║");
  console.log("║     Retention-Optimized Pipeline     ║");
  console.log("╚══════════════════════════════════════╝\n");

  console.log("CWD:", process.cwd());
  console.log("Template:", cli.template);
  console.log("Hooks:", cli.hooks);

  ensureDirs();

  const tpl = loadJSON(cli.template, TemplateSchema, "Template");
  const hooks = loadJSON(cli.hooks, HooksSchema, "Hooks");

  const loopCategory = cli.loopCategory ?? tpl.loopCategory;
  const musicCategory = cli.musicCategory ?? tpl.musicCategory;
  const variants = cli.variants ?? tpl.variants;
  const duration = cli.duration ?? tpl.duration;
  const intensity = cli.intensity ?? tpl.intensity;
  const fontFile = cli.font ? `assets/fonts/${cli.font}` : undefined;
  const videoSpeed = Math.min(2.5, Math.max(1, cli.speed ?? 1));

  console.log(`\nLoop category: ${loopCategory}`);
  console.log(`Music category: ${musicCategory}`);
  if (fontFile) console.log(`Font: ${fontFile}`);

  const loopFiles = findAssets("assets/loops", loopCategory, VIDEO_EXTS, "loops");
  const musicFiles = findAssets("assets/music", musicCategory, AUDIO_EXTS, "music");

  if (loopFiles.length === 0) {
    console.error(`\n[X] No loop videos found in assets/loops/${loopCategory}/ or assets/loops/`);
    process.exit(1);
  }
  if (musicFiles.length === 0) {
    console.error(`\n[X] No music files found in assets/music/${musicCategory}/ or assets/music/`);
    process.exit(1);
  }

  console.log(`\nDuration: ${duration}s | Variants: ${variants} | Intensity: ${intensity}`);
  console.log(`Video speed: ${videoSpeed.toFixed(2)}x`);
  console.log(`Hooks loaded: ${Object.keys(hooks).filter((k) => Array.isArray(hooks[k as keyof Hooks])).length} categories`);

  const runId = nowStamp();
  console.log(`Run ID: ${runId}\n`);

  for (let i = 0; i < variants; i++) {
    const seed = crypto.randomInt(1, 1_000_000_000);
    const rng = new SeededRandom(seed);

    const shuffledLoops = rng.shuffle(loopFiles);
    const music = rng.pick(musicFiles);

    const overlays = generateOverlays(duration, hooks, rng, intensity);

    const tag = `${runId}_v${String(i + 1).padStart(2, "0")}`;
    const outVideo = path.resolve(`out/renders/${tag}.mp4`);
    const outThumb = path.resolve(`out/thumbs/${tag}.jpg`);

    console.log(`[Variant ${i + 1}/${variants}]`);
    console.log(`  Seed: ${seed}`);
    console.log(`  Loops: ${shuffledLoops.length} videos in unique order`);
    console.log(`  Music: ${path.basename(music)}`);
    console.log(`  Speed: ${videoSpeed.toFixed(2)}x`);
    console.log(`  Hooks: ${overlays.length} text overlays`);
    console.log(`  Output: ${tag}.mp4`);

    await renderSatisfying({
      inputVideo: shuffledLoops,
      inputAudio: music,
      outputVideo: outVideo,
      outputThumb: outThumb,
      duration,
      videoSpeed,
      overlays,
      seed,
      fontFile,
    });

    const meta = {
      version: 2,
      runId,
      variant: i + 1,
      seed,
      duration,
      videoSpeed: Number(videoSpeed.toFixed(3)),
      intensity,
      loops: shuffledLoops.map(l => path.basename(l)),
      music: path.basename(music),
      overlays,
      generatedAt: new Date().toISOString(),
    };
    const metaPath = outVideo.replace(/\.mp4$/i, ".meta.json");
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf-8");
    console.log(`  [OK] Done\n`);
  }

  console.log("═══════════════════════════════════════");
  console.log(`[+] ${variants} variant(s) rendered successfully!`);
  console.log(`    Videos: out/renders/`);
  console.log(`    Thumbs: out/thumbs/`);
  console.log("═══════════════════════════════════════\n");
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error("\n[X] FAILED:", msg);
  process.exit(1);
});
