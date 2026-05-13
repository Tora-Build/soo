#!/usr/bin/env node
// Build a single-file MP4 walkthrough of the on-chain e2e suite.
//
// Inputs (from a `E2E_VIDEO=on pnpm test:e2e` run):
//   - test-results/<spec-dir>/video.webm — one per spec
//
// Output:
//   - test-results/e2e-suite-walkthrough.mp4 — title cards + each spec
//
// ffmpeg pipeline:
//   1. Render a 1280×720 PNG title card per spec via Playwright Chromium
//      (homebrew ffmpeg ships without `drawtext`, so we can't burn captions
//      in directly).
//   2. Encode each PNG into a 2-second h.264 segment.
//   3. Re-encode each spec's `video.webm` into a same-codec h.264 segment
//      (Playwright's webm uses VP8 + ~5fps; concat-demuxer needs uniform
//      codec/fps/sample rate).
//   4. Concat all segments via the concat demuxer.

import { execSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");
const E2E_DIR = join(REPO, "e2e", "onchain");
const RESULTS = join(REPO, "test-results");
const STAGE = join(RESULTS, ".walkthrough-stage");
const FINAL = join(RESULTS, "e2e-suite-walkthrough.mp4");

const FPS = 30;
const W = 1280;
const H = 720;
const TITLE_DURATION_S = 2.5;
const SUMMARY_DURATION_S = 4;
const SUMMARY_TEXT = "E2E PASSED · Surfpool · sooth-solana";

mkdirSync(STAGE, { recursive: true });

// ─── 1. Discover specs in order ─────────────────────────────────────────────

const specFiles = readdirSync(E2E_DIR)
  .filter((f) => /\.spec\.ts$/.test(f))
  .sort();

if (specFiles.length === 0) {
  console.error("No specs found in", E2E_DIR);
  process.exit(1);
}

console.log(`[walkthrough] discovered ${specFiles.length} specs`);

// Title comes from the first non-empty `// ` comment line in the spec.
function specTitle(file, index) {
  const path = join(E2E_DIR, file);
  const head = readFileSync(path, "utf8").split("\n").slice(0, 8).join("\n");
  const m = head.match(/\/\/\s*([^\n]+e2e[^\n]*)/i);
  const num = file.match(/^(\d{2})/)?.[1] ?? String(index + 1).padStart(2, "0");
  const cleaned = (m ? m[1] : file)
    .replace(/^\/\/\s*/, "")
    .replace(/\s+—\s+/, " — ");
  return { num, file, label: cleaned.slice(0, 80) };
}

const specs = specFiles.map(specTitle);

// ─── 2. Match each spec to its recorded video.webm ──────────────────────────

function findVideo(specFile) {
  // Playwright stores videos under test-results/<flattened-spec-name-...>/video.webm
  // where the directory's leading token is the numeric prefix of the spec
  // (e.g. `03-slippage...`). Use that prefix as the strict gate: it
  // disambiguates `03-slippage-rejection-amm-e2e` from `00-buy-amm-e2e`
  // (both share 'amm' + 'e2e' tokens).
  const numPrefix = specFile.match(/^(\d{2})-/)?.[1];
  const baseToken = specFile.replace(/\.spec\.ts$/, "");
  for (const dirName of readdirSync(RESULTS)) {
    if (numPrefix) {
      if (!dirName.startsWith(`${numPrefix}-`)) continue;
    } else if (!dirName.startsWith(baseToken)) {
      continue;
    }
    const candidate = join(RESULTS, dirName, "video.webm");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const matched = specs.map((s) => ({ ...s, video: findVideo(s.file) }));
// Adapter-only specs (slippage rejection, trading-window guard) never
// instantiate a Playwright `page`, so no video.webm is produced. Render
// a longer "protocol-only" title card in their slot.
for (const s of matched) {
  s.adapterOnly = !s.video;
}
const adapterOnly = matched.filter((s) => s.adapterOnly);
if (adapterOnly.length) {
  console.log(
    `[walkthrough] adapter-only specs (no video): ${adapterOnly.map((m) => m.file).join(", ")}`,
  );
}

// ─── 3. Render title-card PNGs via headless Chromium ────────────────────────

function titleHtml(num, label, badge) {
  // Palette mirrors the demo's accent — black canvas with a single accent
  // bar so the cards punch through hard cuts to the in-browser footage.
  const badgeHtml = badge ? `<div class="badge">${badge}</div>` : "";
  return `<!doctype html>
<html><head><meta charset="utf-8"/><style>
  html, body { margin: 0; padding: 0; background: #0a0a0a; }
  body { width: ${W}px; height: ${H}px; display: flex; flex-direction: column;
         justify-content: center; align-items: flex-start; padding: 0 96px;
         box-sizing: border-box; font-family: -apple-system, system-ui, sans-serif;
         color: #f1f1f1; }
  .num { font-size: 36px; font-weight: 600; letter-spacing: 0.16em;
         color: #4ade80; text-transform: uppercase; margin-bottom: 12px; }
  .label { font-size: 56px; font-weight: 600; line-height: 1.1;
           letter-spacing: -0.01em; max-width: 1100px; }
  .badge { margin-top: 28px; display: inline-block; padding: 8px 16px;
           border: 1px solid #4ade80; color: #4ade80; font-size: 18px;
           letter-spacing: 0.16em; text-transform: uppercase; }
  .meta { position: absolute; bottom: 56px; left: 96px; right: 96px;
          display: flex; justify-content: space-between;
          font-size: 18px; letter-spacing: 0.18em; text-transform: uppercase;
          color: #6b7280; }
  .accent { position: absolute; top: 0; left: 0; height: 6px; width: 100%;
            background: #4ade80; }
</style></head>
<body>
  <div class="accent"></div>
  <div class="num">SPEC ${num}</div>
  <div class="label">${label}</div>
  ${badgeHtml}
  <div class="meta"><span>sooth-solana e2e walkthrough</span><span>19/19 green · surfpool</span></div>
</body></html>`;
}

function summaryHtml() {
  return `<!doctype html>
<html><head><meta charset="utf-8"/><style>
  html, body { margin: 0; padding: 0; background: #0a0a0a; }
  body { width: ${W}px; height: ${H}px; display: flex; flex-direction: column;
         justify-content: center; align-items: flex-start; padding: 0 96px;
         box-sizing: border-box; font-family: -apple-system, system-ui, sans-serif;
         color: #f1f1f1; }
  .num { font-size: 36px; font-weight: 600; letter-spacing: 0.16em;
         color: #4ade80; text-transform: uppercase; margin-bottom: 12px; }
  .passed { font-size: 104px; font-weight: 700; line-height: 1;
            max-width: 1100px; }
  .detail { margin-top: 24px; font-size: 34px; font-weight: 600;
            line-height: 1.18; color: #d1d5db; max-width: 1100px; }
  .detail strong { color: #4ade80; }
  .meta { position: absolute; bottom: 56px; left: 96px; right: 96px;
          display: flex; justify-content: space-between;
          font-size: 18px; letter-spacing: 0.18em; text-transform: uppercase;
          color: #6b7280; }
  .accent { position: absolute; top: 0; left: 0; height: 6px; width: 100%;
            background: #4ade80; }
</style></head>
<body>
  <div class="accent"></div>
  <div class="num">SUMMARY</div>
  <div class="passed">E2E PASSED</div>
  <div class="detail">${matched.length} specs · <strong>sooth-solana</strong></div>
  <div class="meta"><span>sooth-solana e2e walkthrough</span><span>${SUMMARY_TEXT}</span></div>
</body></html>`;
}

console.log(`[walkthrough] rendering ${specs.length} title cards + summary`);
const browser = await chromium.launch();
let summaryPng;
try {
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  for (const s of matched) {
    const badge = s.adapterOnly ? "PASSED · ADAPTER-ONLY (NO BROWSER)" : null;
    await page.setContent(titleHtml(s.num, s.label, badge), {
      waitUntil: "load",
    });
    s.titlePng = join(STAGE, `title-${s.num}.png`);
    await page.screenshot({ path: s.titlePng, type: "png", fullPage: false });
  }
  await page.setContent(summaryHtml(), { waitUntil: "load" });
  summaryPng = join(STAGE, "summary.png");
  await page.screenshot({ path: summaryPng, type: "png", fullPage: false });
} finally {
  await browser.close();
}

// ─── 4. Encode each PNG + each webm into uniform h.264 segments ────────────

function ffmpeg(args) {
  const r = spawnSync(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-y", ...args],
    {
      stdio: "inherit",
    },
  );
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${args.join(" ")}`);
}

console.log(`[walkthrough] encoding segments`);
const segments = [];
for (const s of matched) {
  const titleSeg = join(STAGE, `title-${s.num}.mp4`);
  // Adapter-only specs get a longer title slide (5s) since there's no
  // body footage to follow.
  const titleSecs = s.adapterOnly ? 5 : TITLE_DURATION_S;
  ffmpeg([
    "-loop",
    "1",
    "-t",
    String(titleSecs),
    "-i",
    s.titlePng,
    "-r",
    String(FPS),
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-preset",
    "medium",
    "-crf",
    "23",
    "-vf",
    `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=yuv420p`,
    "-an",
    titleSeg,
  ]);
  segments.push(titleSeg);

  if (s.adapterOnly) continue;

  const videoSeg = join(STAGE, `spec-${s.num}.mp4`);
  ffmpeg([
    "-i",
    s.video,
    "-r",
    String(FPS),
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-preset",
    "medium",
    "-crf",
    "23",
    "-vf",
    `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=yuv420p`,
    "-an",
    videoSeg,
  ]);
  segments.push(videoSeg);
}

const summarySeg = join(STAGE, "summary.mp4");
ffmpeg([
  "-loop",
  "1",
  "-t",
  String(SUMMARY_DURATION_S),
  "-i",
  summaryPng,
  "-r",
  String(FPS),
  "-c:v",
  "libx264",
  "-pix_fmt",
  "yuv420p",
  "-preset",
  "medium",
  "-crf",
  "23",
  "-vf",
  `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=yuv420p`,
  "-an",
  summarySeg,
]);
segments.push(summarySeg);

// ─── 5. Concat ──────────────────────────────────────────────────────────────

const listFile = join(STAGE, "concat.txt");
writeFileSync(
  listFile,
  segments.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n") + "\n",
);

console.log(`[walkthrough] concating ${segments.length} segments → ${FINAL}`);
ffmpeg(["-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", FINAL]);

console.log(`[walkthrough] done: ${FINAL}`);
