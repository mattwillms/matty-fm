// Home-screen icons: the "O" (for Orr) of the wordmark, drawn by the page's own font and 70s
// offset stack on the cocoa ground. Renders in headless Chromium so the letter is the real
// Fraunces glyph, then writes worker/public/icon-{512,192,180}.png.
// Usage: NODE_PATH=<dir with playwright>/node_modules node tools/make_icons.mjs
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../worker/public");
const html = `<!doctype html><html><head>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght,SOFT,WONK@9..144,600..900,100,1&display=swap" rel="stylesheet">
<style>
  html, body { margin: 0; width: 1024px; height: 1024px; background: #2A1A12; }
  body { display: grid; place-items: center; }
  /* the wordmark's letter, sized to sit inside the maskable safe circle (inner 80%) */
  b { font-family: Fraunces; font-variation-settings: "SOFT" 100, "WONK" 1, "opsz" 144; font-weight: 900;
      font-size: 660px; line-height: .86; color: #F3E3C3;
      text-shadow: .022em .022em 0 #2A1A12, .05em .05em 0 #F0A92B, .072em .072em 0 #2A1A12,
                   .1em .1em 0 #E2621B, .122em .122em 0 #2A1A12, .15em .15em 0 #B2361F;
      transform: translate(-.075em, -.03em); }   /* centre the letter and its stack together */
</style></head><body><b>O</b></body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
await page.setContent(html, { waitUntil: "networkidle" });
await page.evaluate(() => document.fonts.ready);
const big = path.join(out, "icon-1024.tmp.png");
await page.screenshot({ path: big });
await browser.close();
for (const size of [512, 192, 180]) {
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", big, "-vf", `scale=${size}:${size}:flags=lanczos`, path.join(out, `icon-${size}.png`)]);
}
execFileSync("rm", [big]);
console.log("icons written to", out);
