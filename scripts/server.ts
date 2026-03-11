/**
 * Simple local GUI server for Satisfying Factory.
 * Run: npm run gui
 * Opens http://localhost:4800
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const PORT = 4800;
const ROOT = process.cwd();

// ─── helpers ────────────────────────────────────────────────────────────

function json(res: http.ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function text(res: http.ServerResponse, body: string, status = 200) {
  res.writeHead(status, { "Content-Type": "text/plain" });
  res.end(body);
}

function parseBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => resolve(body));
  });
}

function listFilesIn(dir: string, exts: string[]): string[] {
  const abs = path.resolve(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  try {
    return fs
      .readdirSync(abs)
      .filter((f) => {
        const full = path.join(abs, f);
        try {
          return fs.statSync(full).isFile() && exts.includes(path.extname(f).toLowerCase());
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }
}

function listDirs(dir: string): string[] {
  const abs = path.resolve(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  try {
    return fs
      .readdirSync(abs)
      .filter((f) => {
        try {
          return fs.statSync(path.join(abs, f)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }
}

// ─── SSE job runner ─────────────────────────────────────────────────────

const VIDEO_EXTS = [".mp4", ".mov", ".mkv", ".webm"];
const AUDIO_EXTS = [".mp3", ".wav", ".m4a", ".aac"];
const FONT_EXTS = [".ttf", ".otf", ".woff", ".woff2"];

/** Run an npm script with args, streaming output via SSE */
function runJob(
  res: http.ServerResponse,
  script: string,
  args: string[],
) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const send = (event: string, data: string) => {
    res.write(`event: ${event}\ndata: ${data}\n\n`);
  };

  send("log", `> npm run ${script} -- ${args.join(" ")}`);

  const child = spawn("npx", ["tsx", `scripts/${script}.ts`, ...args], {
    cwd: ROOT,
    shell: true,
    env: { ...process.env },
  });

  child.stdout?.on("data", (chunk: Buffer) => {
    const lines = chunk.toString().split("\n");
    for (const line of lines) {
      if (line.trim()) send("log", line);
    }
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    const lines = chunk.toString().split("\n");
    for (const line of lines) {
      if (line.trim()) send("log", `[stderr] ${line}`);
    }
  });

  child.on("close", (code) => {
    send("done", String(code ?? 0));
    res.end();
  });

  child.on("error", (err) => {
    send("log", `[error] ${err.message}`);
    send("done", "1");
    res.end();
  });

  // If client disconnects, kill the process
  req_cleanup.set(res, () => {
    try {
      child.kill();
    } catch {}
  });
  res.on("close", () => {
    const cleanup = req_cleanup.get(res);
    if (cleanup) cleanup();
    req_cleanup.delete(res);
  });
}

const req_cleanup = new Map<http.ServerResponse, () => void>();

// ─── routes ─────────────────────────────────────────────────────────────

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const method = req.method ?? "GET";

  // CORS for local dev
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // ── GUI page ──
  if (url.pathname === "/" && method === "GET") {
    const htmlPath = path.resolve(ROOT, "src/gui.html");
    if (!fs.existsSync(htmlPath)) {
      text(res, "gui.html not found", 404);
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(fs.readFileSync(htmlPath, "utf-8"));
    return;
  }

  // ── API: list assets ──
  if (url.pathname === "/api/assets" && method === "GET") {
    const loopCategories = listDirs("assets/loops");
    const musicCategories = listDirs("assets/music");

    const loops: Record<string, string[]> = {};
    for (const cat of loopCategories) {
      loops[cat] = listFilesIn(`assets/loops/${cat}`, VIDEO_EXTS);
    }

    const music: Record<string, string[]> = {};
    for (const cat of musicCategories) {
      music[cat] = listFilesIn(`assets/music/${cat}`, AUDIO_EXTS);
    }

    json(res, { loopCategories, musicCategories, loops, music });
    return;
  }

  // ── API: list fonts ──
  if (url.pathname === "/api/fonts" && method === "GET") {
    const fonts = listFilesIn("assets/fonts", FONT_EXTS);
    json(res, { fonts });
    return;
  }

  // ── API: list rendered files ──
  if (url.pathname === "/api/renders" && method === "GET") {
    const renders = listFilesIn("out/renders", VIDEO_EXTS);
    const thumbs = listFilesIn("out/thumbs", [".jpg", ".jpeg", ".png"]);
    json(res, { renders, thumbs });
    return;
  }

  // ── API: run make ──
  if (url.pathname === "/api/make" && method === "POST") {
    const body = JSON.parse(await parseBody(req));
    const args: string[] = [];
    if (body.variants) args.push("--variants", String(body.variants));
    if (body.duration) args.push("--duration", String(body.duration));
    if (body.intensity) args.push("--intensity", body.intensity);
    if (body.loopCategory) args.push("--loopCategory", body.loopCategory);
    if (body.musicCategory) args.push("--musicCategory", body.musicCategory);
    if (body.template) args.push("--template", body.template);
    if (body.font) args.push("--font", body.font);
    args.push("--speed", String(body.speed ?? 1));
    runJob(res, "make", args);
    return;
  }

  // ── API: run concat ──
  if (url.pathname === "/api/concat" && method === "POST") {
    const body = JSON.parse(await parseBody(req));
    const args: string[] = [];
    if (body.pattern) args.push("--pattern", body.pattern);
    if (body.start) args.push("--start", String(body.start));
    if (body.end) args.push("--end", String(body.end));
    if (body.videoDir) args.push("--videoDir", body.videoDir);
    if (body.music) args.push("--music", body.music);
    if (body.musicCategory) args.push("--musicCategory", body.musicCategory);
    if (typeof body.withMusic === "boolean") args.push("--withMusic", String(body.withMusic));
    if (typeof body.withSubtitles === "boolean") args.push("--withSubtitles", String(body.withSubtitles));
    if (body.output) args.push("--output", body.output);
    if (body.duration) args.push("--duration", String(body.duration));
    args.push("--speed", String(body.speed ?? 1));
    runJob(res, "concat", args);
    return;
  }

  // ── API: run doctor ──
  if (url.pathname === "/api/doctor" && method === "POST") {
    runJob(res, "doctor", []);
    return;
  }

  // ── API: templates ──
  if (url.pathname === "/api/templates" && method === "GET") {
    const files = listFilesIn("templates", [".json"]);
    const templates: Record<string, unknown> = {};
    for (const f of files) {
      try {
        templates[f] = JSON.parse(
          fs.readFileSync(path.resolve(ROOT, "templates", f), "utf-8"),
        );
      } catch {}
    }
    json(res, templates);
    return;
  }

  // ── static: serve out/ files for preview ──
  if (url.pathname.startsWith("/out/") && method === "GET") {
    const filePath = path.resolve(ROOT, url.pathname.slice(1));
    if (!fs.existsSync(filePath)) { text(res, "not found", 404); return; }
    const ext = path.extname(filePath).toLowerCase();
    const mime: Record<string, string> = {
      ".mp4": "video/mp4",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".json": "application/json",
    };
    res.writeHead(200, { "Content-Type": mime[ext] ?? "application/octet-stream" });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  // ── static: serve font files for preview ──
  if (url.pathname.startsWith("/assets/fonts/") && method === "GET") {
    const filePath = path.resolve(ROOT, url.pathname.slice(1));
    if (!fs.existsSync(filePath)) { text(res, "not found", 404); return; }
    const ext = path.extname(filePath).toLowerCase();
    const fontMime: Record<string, string> = {
      ".ttf": "font/ttf",
      ".otf": "font/otf",
      ".woff": "font/woff",
      ".woff2": "font/woff2",
    };
    res.writeHead(200, {
      "Content-Type": fontMime[ext] ?? "application/octet-stream",
      "Access-Control-Allow-Origin": "*",
    });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  text(res, "not found", 404);
}

// ─── start ──────────────────────────────────────────────────────────────

const server = http.createServer(handleRequest);
server.listen(PORT, () => {
  console.log(`\n  ┌──────────────────────────────────────┐`);
  console.log(`  │  Satisfying Factory GUI              │`);
  console.log(`  │  http://localhost:${PORT}              │`);
  console.log(`  └──────────────────────────────────────┘\n`);
});
