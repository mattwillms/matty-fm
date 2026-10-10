// UI soak: a few real browsers on the live guest page for hours, tapping everything a guest can tap (tubes, dial,
// hen, screws, plug, coins, preset buttons, the sound switch, the sleeve, Orrdle, the medal case, Made by), fast and
// in odd orders, and checking after every few actions for the things a person would notice:
//   page script errors; more than one overlay open at once; the page scroll-lock stuck on with nothing open;
//   anything wider than the screen; NaN or runaway transforms; leftover effect elements piling up; a toast stuck.
// Each finding is logged with a screenshot. Run: node tools/ui_soak.mjs OUT_DIR hours [browsers]
// (needs playwright; uses Firefox and Chromium, iPhone-sized)
import { chromium, firefox } from "playwright";
import { appendFileSync, mkdirSync } from "node:fs";
import { readFileSync } from "node:fs";

const [out = "ui-soak", hours = "1", count = "3"] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const env = Object.fromEntries(readFileSync(`${process.env.HOME}/.config/mattyfm/env`, "utf8").split("\n")
  .filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i).replace(/^export\s+/, ""), l.slice(i + 1).replace(/^["']|["']$/g, "")]; }));
const URL = process.env.SOAK_URL || `https://fm.willms.co/?k=${encodeURIComponent(env.PARTY_CODE)}`;   // SOAK_URL: a dev server
const end = Date.now() + Number(hours) * 3600_000;
const log = (row) => appendFileSync(`${out}/ui.jsonl`, JSON.stringify({ t: Date.now() / 1000, ...row }) + "\n");
const pause = (lo, hi) => new Promise((r) => setTimeout(r, lo + Math.random() * (hi - lo)));
const pick = (a) => a[Math.floor(Math.random() * a.length)];

// what a guest can do: [name, how]; each how runs in the page
const ACTIONS = [
  ["tube", () => document.querySelectorAll(".tube")[Math.random() < .5 ? 0 : 1]?.click()],
  ["tube x5", async () => { for (let i = 0; i < 5; i++) { document.querySelector(".tube")?.click(); await new Promise((r) => setTimeout(r, 120)); } }],
  ["dial x4", async () => { for (let i = 0; i < 4; i++) { document.querySelector(".dial")?.click(); await new Promise((r) => setTimeout(r, 200)); } }],
  ["hen x5", async () => { for (let i = 0; i < 5; i++) { document.querySelector(".hen")?.click(); await new Promise((r) => setTimeout(r, 150)); } }],
  ["logo x3", async () => { for (let i = 0; i < 3; i++) { document.querySelector(".mark h1")?.click(); await new Promise((r) => setTimeout(r, 200)); } }],
  ["screws", () => document.querySelectorAll(".screw").forEach((s) => s.click())],
  ["plug", () => document.querySelector(".cables .plug")?.dispatchEvent(new MouseEvent("click", { bubbles: true }))],
  ["coin", () => document.querySelector("#slots i")?.click()],
  ["empty slot", () => document.querySelector("#slots i.used")?.click()],
  ["dotted coin", () => document.querySelector("#slots .ghost")?.click()],
  ["preset", () => { const a = [...document.querySelectorAll("#presets .preset")]; a[Math.floor(Math.random() * a.length)]?.click(); }],
  ["sound switch", () => document.getElementById("padMode")?.click()],
  ["requested lamp", () => document.querySelector(".brand .req")?.click()],
  ["sleeve", () => document.getElementById("glass")?.click()],
  ["orrdle", () => document.getElementById("orrdlePlay")?.click()],
  ["orrdle type", async () => { for (const k of "MATTY") { document.querySelector(`.od-k[data-k="${k}"]`)?.click(); } document.querySelector('.od-k[data-k="Enter"]')?.click(); }],
  ["orrdle stats", () => document.getElementById("odMine")?.click()],
  ["medal", () => document.querySelector("#medals .mslot.got")?.click()],
  ["about", () => document.getElementById("aboutBtn")?.click()],
  ["close all", () => document.querySelectorAll(".sleeve-close").forEach((b) => b.offsetParent && b.click())],
  ["escape", () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))],
  ["scroll", () => scrollTo({ top: Math.random() * document.documentElement.scrollHeight, behavior: "instant" })],
  ["rub sign", () => { const w = document.querySelector(".plank-word"); if (!w) return; const r = w.getBoundingClientRect();
    const ev = (t, x) => w.dispatchEvent(new PointerEvent(t, { clientX: x, clientY: r.top + r.height / 2, bubbles: true, pointerType: "touch", buttons: 1 }));
    ev("pointerdown", r.left); for (let i = 0; i < 20; i++) ev("pointermove", i % 2 ? r.right : r.left); ev("pointerup", r.left); }],
  ["search", async () => { const q = document.getElementById("q"); if (!q || q.disabled || q.offsetParent === null) return;
    const w = ["abba", "queen", "september", "dancing", "hello"]; q.value = w[Math.floor(Math.random() * w.length)]; q.dispatchEvent(new Event("input", { bubbles: true })); }],
  ["pick + back", async () => { const b = document.querySelector("#results button:not([disabled])"); if (!b) return; b.click();
    await new Promise((r) => setTimeout(r, 600)); document.querySelector("#chosen .again")?.click(); }],
  ["rotate", null],   // done from outside: the phone turned sideways and back
];

// the checks, run in the page
const CHECK = () => {
  const out = [];
  const open = [...document.querySelectorAll("dialog[open]")].map((d) => d.id || d.className);
  const views = document.querySelectorAll(".mview").length;
  if (open.length + views > 1) out.push(`overlays stacked: ${[...open, ...(views ? [`medal viewer x${views}`] : [])].join(" + ")}`);
  if (document.documentElement.classList.contains("od-open") && !open.length && !views) out.push("page scroll-lock on with nothing open");
  if (document.documentElement.scrollWidth > innerWidth + 1) out.push(`page wider than the screen: ${document.documentElement.scrollWidth} > ${innerWidth}`);
  for (const el of document.querySelectorAll("body *")) {
    const t = el.style.transform;
    if (t && /NaN|Infinity/.test(t)) { out.push(`bad transform on ${el.className || el.tagName}: ${t}`); break; }
  }
  const fx = document.querySelectorAll(".fx, .dust, .gnat, .spk, .snapflash").length;
  if (fx > 120) out.push(`effect elements piling up: ${fx}`);
  const t = document.getElementById("toast");
  if (t && t.className.includes("show")) { window.__toastSince ??= Date.now(); if (Date.now() - window.__toastSince > 12000) out.push("toast stuck on screen"); }
  else window.__toastSince = null;
  const coin = document.querySelector(".cq");
  if (coin && coin.style.visibility === "hidden" && !document.getElementById("send")?.disabled && document.getElementById("form")?.hidden) out.push("coin left hidden");
  return out;
};

async function bot(n, engine) {
  const browser = await engine.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: engine === chromium });
  const page = await ctx.newPage();
  const who = `bot${n}-${engine === chromium ? "chromium" : "firefox"}`;
  let actions = 0, findings = 0;
  page.on("pageerror", (e) => { findings++; log({ who, kind: "page-error", err: e.message }); });
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|lrclib|net::/.test(m.text())) log({ who, kind: "console-error", err: m.text().slice(0, 300) }); });
  await page.addInitScript((name) => { try { localStorage.setItem("mfm_name", name); } catch {} }, `Bot ${"ABCDEFGH"[n]}`);
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await pause(4000, 6000);
  log({ who, kind: "start" });
  const seen = new Set();
  while (Date.now() < end) {
    const [name, how] = pick(ACTIONS);
    try {
      if (name === "rotate") { await page.setViewportSize({ width: 844, height: 390 }); await pause(800, 1500); await page.setViewportSize({ width: 390, height: 844 }); }
      else await page.evaluate(how);
      actions++;
    } catch (e) { log({ who, kind: "action-error", action: name, err: String(e).slice(0, 200) }); }
    await pause(300, 2500);
    if (actions % 3 === 0) {
      const issues = await page.evaluate(CHECK).catch((e) => [`check failed: ${e}`]);
      for (const i of issues) {
        findings++;
        const key = i.replace(/\d+/g, "#");
        const shot = !seen.has(key) ? `${out}/${who}-${actions}.png` : null;
        if (shot) { seen.add(key); await page.screenshot({ path: shot }).catch(() => {}); }
        log({ who, kind: "finding", issue: i, after: name, actions, shot });
      }
    }
    if (actions % 400 === 0) log({ who, kind: "progress", actions, findings });
    if (Math.random() < .002) { await page.reload({ waitUntil: "domcontentloaded" }); await pause(3000, 5000); log({ who, kind: "reload" }); }
  }
  log({ who, kind: "end", actions, findings });
  await browser.close();
}

const engines = [firefox, chromium, firefox, chromium];
await Promise.all(Array.from({ length: Number(count) }, (_, i) => bot(i, engines[i % engines.length]).catch((e) => log({ kind: "bot-crash", err: String(e) }))));
