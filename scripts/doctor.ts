/**
 * npm run doctor — pre-flight checks for Satisfying Factory
 */
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const OK = "[OK]";
const FAIL = "[FAIL]";
let failures = 0;

function check(label: string, fn: () => string | true) {
  try {
    const result = fn();
    if (result === true) {
      console.log(`  ${OK} ${label}`);
    } else {
      console.log(`  ${OK} ${label} — ${result}`);
    }
  } catch (e: unknown) {
    failures++;
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`  ${FAIL} ${label} — ${msg}`);
  }
}

function findFiles(dir: string, exts: string[]): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => {
      const full = path.join(dir, f);
      try {
        return fs.statSync(full).isFile() && exts.includes(path.extname(f).toLowerCase());
      } catch {
        return false;
      }
    });
}

console.log("\n=== Satisfying Factory Doctor ===\n");
console.log("CWD:", process.cwd());

// 1. ffmpeg
console.log("\n1. ffmpeg");
check("ffmpeg is installed", () => {
  try {
    const out = execSync("ffmpeg -version", { encoding: "utf-8", timeout: 10_000 });
    const firstLine = out.split("\n")[0]?.trim() ?? "unknown";
    return firstLine;
  } catch {
    throw new Error(
      "ffmpeg not found in PATH. Install from https://ffmpeg.org/download.html and add to PATH.",
    );
  }
});

// 2. Template
console.log("\n2. Template");
const templatePath = path.resolve("templates/satisfying.json");
check("templates/satisfying.json exists", () => {
  if (!fs.existsSync(templatePath))
    throw new Error(`File not found: ${templatePath}\n     Create it or copy from the README.`);
  return true;
});

check("Template JSON is valid", () => {
  const raw = fs.readFileSync(templatePath, "utf-8");
  const data = JSON.parse(raw);
  const cat = data.loopCategory ?? "<missing>";
  const mus = data.musicCategory ?? "<missing>";
  return `loopCategory="${cat}", musicCategory="${mus}", duration=${data.duration ?? "?"}, variants=${data.variants ?? "?"}`;
});

// 2b. Hooks
const hooksPath = path.resolve("templates/hooks.json");
check("templates/hooks.json exists", () => {
  if (!fs.existsSync(hooksPath))
    throw new Error(`File not found: ${hooksPath}\n     Create hooks.json with phrase categories.`);
  return true;
});

check("Hooks JSON is valid", () => {
  const raw = fs.readFileSync(hooksPath, "utf-8");
  const data = JSON.parse(raw);
  // Categories are at root level: openers, buildup, peak, engagement, etc.
  const categoryKeys = ["openers", "buildup", "peak", "engagement", "retention", "loopBait", "vibes", "filler"];
  const totalPhrases = categoryKeys.reduce((sum, cat) => {
    const arr = data[cat];
    return sum + (Array.isArray(arr) ? arr.length : 0);
  }, 0);
  const peakSeqs = data.peakSequences?.length ?? 0;
  return `${categoryKeys.filter(k => Array.isArray(data[k])).length} categories, ${totalPhrases} phrases, ${peakSeqs} peak sequences`;
});

// 3. Assets
console.log("\n3. Assets");

const tpl = (() => {
  try {
    return JSON.parse(fs.readFileSync(templatePath, "utf-8"));
  } catch {
    return { loopCategory: "slime", musicCategory: "ambient" };
  }
})();

const loopCat: string = tpl.loopCategory ?? "slime";
const musicCat: string = tpl.musicCategory ?? "ambient";

const videoExts = [".mp4", ".mov", ".mkv", ".webm"];
const audioExts = [".mp3", ".wav", ".m4a", ".aac"];

// Check category dir first, then parent
const loopCatDir = path.resolve(`assets/loops/${loopCat}`);
const loopParent = path.resolve("assets/loops");
const musicCatDir = path.resolve(`assets/music/${musicCat}`);
const musicParent = path.resolve("assets/music");

check(`Video loops in assets/loops/${loopCat}/`, () => {
  const inCat = findFiles(loopCatDir, videoExts);
  if (inCat.length > 0) return `${inCat.length} file(s)`;

  const inParent = findFiles(loopParent, videoExts);
  if (inParent.length > 0) {
    return `0 in category dir, but ${inParent.length} in assets/loops/ (fallback will work)`;
  }

  throw new Error(
    `No .mp4 files found!\n` +
      `     Put at least one .mp4 in: ${loopCatDir}\n` +
      `     Or directly in: ${loopParent}`,
  );
});

check(`Music in assets/music/${musicCat}/`, () => {
  const inCat = findFiles(musicCatDir, audioExts);
  if (inCat.length > 0) return `${inCat.length} file(s)`;

  const inParent = findFiles(musicParent, audioExts);
  if (inParent.length > 0) {
    return `0 in category dir, but ${inParent.length} in assets/music/ (fallback will work)`;
  }

  throw new Error(
    `No .mp3 files found!\n` +
      `     Put at least one .mp3 in: ${musicCatDir}\n` +
      `     Or directly in: ${musicParent}`,
  );
});

// 4. Fonts (Windows)
console.log("\n4. Fonts");
check("Arial Bold font", () => {
  const arialBold = "C:\\Windows\\Fonts\\arialbd.ttf";
  if (fs.existsSync(arialBold)) return arialBold;
  const arial = "C:\\Windows\\Fonts\\Arial.ttf";
  if (fs.existsSync(arial)) return `arialbd.ttf missing, but Arial.ttf exists: ${arial}`;
  throw new Error("No Arial font found. ffmpeg drawtext may fail.");
});

// 5. Output dirs
console.log("\n5. Output directories");
check("out/renders/ exists (will be created on make)", () => {
  if (fs.existsSync(path.resolve("out/renders"))) return "exists";
  return "will be created automatically";
});

// Summary
console.log("\n" + "=".repeat(40));
if (failures === 0) {
  console.log("All checks passed! Run: npm run make");
} else {
  console.log(`${failures} check(s) failed. Fix the issues above, then re-run: npm run doctor`);
  process.exit(1);
}
