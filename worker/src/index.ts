// Router + auth. Guests: party code + device cookie. Admin: x-admin-token. Studio: bearer secret.
import { Party } from "./party";
import { searchAll } from "./search";

export { Party };

// Bump whenever party.ts changes. A deployed Durable Object kept running its first
// version all evening (deploys did not restart it), so each queue-code change gets a
// fresh instance. Queue state resets on a bump: never bump on party day.
const QUEUE_VERSION = 21;

const enc = new TextEncoder();

function same(given: string | null, secret: string): boolean {
  if (!given || !secret) return false;
  const a = enc.encode(given), b = enc.encode(secret);
  return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
}

function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });
}

// A phone's id is signed by the Worker (HMAC of the id), so a request can prove the id was issued
// here: an invented cookie, or one with a changed signature, counts as a new phone without one.
async function sign(id: string, env: Env): Promise<string> {
  const secret = env.DEVICE_SECRET || `device:${env.STUDIO_SECRET}`;   // its own key; the studio's only as a fallback
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" },
                                            false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(id))).slice(0, 16);
  return btoa(String.fromCharCode(...mac)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function signedDevice(req: Request, env: Env): Promise<boolean> {
  const m = /(?:^|;\s*)mfm_dev=([0-9a-f-]{36})\.([A-Za-z0-9_-]{22})(?:;|$)/.exec(req.headers.get("cookie") ?? "");
  return Boolean(m && same(m[2], await sign(m[1], env)));
}

/** The phone's id. Only the page load (`mint`) hands a new phone one: the page also fetches
 *  /api/cached at the same moment, and two ids per phone halved how many phones a house could add. */
async function device(req: Request, env: Env, mint: boolean): Promise<{ id: string; cookie?: string }> {
  const m = /(?:^|;\s*)mfm_dev=([0-9a-f-]{36})\.([A-Za-z0-9_-]{22})(?:;|$)/.exec(req.headers.get("cookie") ?? "");
  if (m && same(m[2], await sign(m[1], env))) return { id: m[1] };
  if (!mint) return { id: crypto.randomUUID() };
  // new phones are handed out at a human pace per address: a script minting hundreds of
  // identities (to dodge the 2-song cap or Mute) gets a few a minute
  const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
  if (!(await env.NEWDEV_LIMIT.limit({ key: ip })).success) return { id: crypto.randomUUID() };   // no cookie: can look, can't request
  const id = crypto.randomUUID();
  return { id, cookie: `mfm_dev=${id}.${await sign(id, env)}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax` };
}

async function cachedSearch(q: string, ctx: ExecutionContext): Promise<unknown> {
  const norm = q.toLowerCase().replace(/\s+/g, " ").trim();
  const key = new Request(`https://search.mattyfm.internal/?q=${encodeURIComponent(norm)}`);
  const cache = caches.default;
  const hit = await cache.match(key);
  if (hit) return hit.json();
  const results = await searchAll(norm);
  if (results.length) {
    ctx.waitUntil(cache.put(key, Response.json({ results }, { headers: { "cache-control": "max-age=86400" } })));
  }
  return { results };
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    if (path === "/manifest.webmanifest") {
      // Home-screen install: the party code rides in start_url (iOS gives installed
      // apps their own storage, so the code saved by the browser would be lost).
      const k = url.searchParams.get("k") ?? "";
      const start = same(k, env.PARTY_CODE) ? `/?k=${encodeURIComponent(k)}` : "/";
      return new Response(JSON.stringify({
        name: "OrrFM", short_name: "OrrFM", start_url: start, scope: "/", display: "standalone",
        background_color: "#2A1A12", theme_color: "#2A1A12",
        icons: [{ src: "/icon-192.png", sizes: "192x192", type: "image/png" },
                { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" }],
      }), { headers: { "content-type": "application/manifest+json", "cache-control": "no-store" } });
    }
    if (!path.startsWith("/api/")) return env.ASSETS.fetch(req);
    const party = env.PARTY.getByName(`orrfm-v${QUEUE_VERSION}`);
    await takeOver(env, party);
    try {
      return await route(req, env, ctx, url, path, party);
    } catch (e) {
      if (e instanceof BadRequest) return json({ ok: false, error: e.message }, 400);
      // e.g. the minutes after a deploy, when the queue still runs the previous code: say so plainly
      console.log("route failed:", String(e));
      return json({ ok: false, error: "The DJ is busy for a minute. Try again shortly." }, 503);
    }
  },
} satisfies ExportedHandler<Env>;

// A bumped queue starts by copying the previous one (songs, order, names, history, settings), so a
// bump never empties the party. Once per isolate; harmless if the old one is empty, gone, or too old
// to know exportState (then the new queue starts empty, as before).
let tookOver = false;
async function takeOver(env: Env, party: DurableObjectStub<Party>): Promise<void> {
  if (tookOver) return;
  tookOver = true;
  try {
    if (!(await party.isFresh())) return;   // in use (even if empty right now): never import into it
    const state = await env.PARTY.getByName(`orrfm-v${QUEUE_VERSION - 1}`).exportState();
    if (state.items?.length || state.settings?.length || state.jokes?.length) await party.importState(state);
  } catch (e) {
    console.log("queue take-over skipped:", String(e));
  }
}

class BadRequest extends Error {}

/** A POST body must be a JSON object of sensible size; anything else is a 400, not a crash. */
async function body(req: Request): Promise<any> {
  if (req.method !== "POST") return {};
  const text = await req.text();
  if (text.length > 64_000) throw new BadRequest("too large");
  let v: unknown;
  try {
    v = JSON.parse(text || "{}");
  } catch {
    throw new BadRequest("not JSON");
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new BadRequest("expected a JSON object");
  return v;
}

async function route(req: Request, env: Env, ctx: ExecutionContext, url: URL, path: string,
                     party: DurableObjectStub<Party>): Promise<Response> {

    if (path.startsWith("/api/studio/")) {
      if (!same(req.headers.get("authorization")?.replace(/^Bearer /, "") ?? null, env.STUDIO_SECRET))
        return json({ error: "unauthorized" }, 401);
      if (path === "/api/studio/beat") return json(await party.beat(await body(req)));
      if (path === "/api/studio/result") return json(await party.result(await body(req)));
      if (path === "/api/studio/joke") return json(await party.jokeResult(await body(req)));
      if (path === "/api/studio/tts") {
        const { text } = await body(req);
        const audio: unknown = await env.AI.run("@cf/deepgram/aura-2-en", { text: String(text).slice(0, 1000), speaker: "orion", encoding: "mp3" });
        // Docs say a stream; the generated types say string (base64). Accept either.
        const bytes = typeof audio === "string" ? Uint8Array.from(atob(audio), (c) => c.charCodeAt(0)) : (audio as ReadableStream);
        return new Response(bytes, { headers: { "content-type": "audio/mpeg" } });
      }
      return json({ error: "not found" }, 404);
    }

    if (path.startsWith("/api/admin/")) {
      if (!same(req.headers.get("x-admin-token"), env.ADMIN_TOKEN)) return json({ error: "unauthorized" }, 401);
      if (path === "/api/admin/state") return json(await party.adminState());
      if (path === "/api/admin/search") return json(await cachedSearch(url.searchParams.get("q") ?? "", ctx));
      if (path === "/api/admin/action") return json(await party.adminAction(await body(req)));
      return json({ error: "not found" }, 404);
    }

    if (!same(url.searchParams.get("k"), env.PARTY_CODE)) return json({ error: "Ask the host for the party QR code." }, 403);
    const dev = await device(req, env, path === "/api/state");
    const extra: HeadersInit = dev.cookie ? { "set-cookie": dev.cookie } : {};
    if (path === "/api/search") {
      const q = (url.searchParams.get("q") ?? "").trim();
      if (q.length < 2) return json({ results: [] }, 200, extra);
      return json(await cachedSearch(q, ctx), 200, extra);
    }
    if (path === "/api/state") return json(await party.guestState(dev.id), 200, extra);
    if (path === "/api/cached") {
      // Song keys the studio already has on disk (sent with each check-in): they play instantly.
      const h = (await party.adminState()).health as { cached?: string[] };
      return json({ keys: Array.isArray(h.cached) ? h.cached : [] }, 200, { ...extra, "cache-control": "max-age=60" });
    }
    if (path === "/api/request" && req.method === "POST") {
      // A request needs the signed phone id the page was handed when it loaded: dropping or
      // inventing a cookie no longer makes a fresh phone (that dodged the 2-song limit and Mute).
      if (!(await signedDevice(req, env))) return json({ ok: false, error: "Reload the page, then try again." }, 403, extra);
      const input = await body(req);
      // only a real request spends the allowances: junk can't use up the house's
      if (typeof input.name !== "string" || !input.name.trim() || typeof input.track?.title !== "string")
        return json({ ok: false, error: "Pick a song and add your name." }, 400, extra);
      const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
      // per phone (one person can't lock out the house, which shares one address), plus a loose house-wide ceiling
      if (!(await env.SUBMIT_LIMIT.limit({ key: `dev:${dev.id}` })).success || !(await env.IP_LIMIT.limit({ key: ip })).success)
        return json({ ok: false, error: "Whoa, slow down! Try again in a minute." }, 429, extra);
      return json(await party.submit(dev.id, input, false, ip), 200, extra);
    }
    if (path === "/api/joke" && req.method === "POST") {   // a joke for the DJ to read on air
      if (!(await signedDevice(req, env))) return json({ ok: false, error: "Reload the page, then try again." }, 403, extra);
      const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
      if (!(await env.SUBMIT_LIMIT.limit({ key: `dev:${dev.id}` })).success || !(await env.IP_LIMIT.limit({ key: ip })).success)
        return json({ ok: false, error: "Whoa, slow down! Try again in a minute." }, 429, extra);
      return json(await party.submitJoke(dev.id, await body(req), ip), 200, extra);
    }
    if (path === "/api/cancel" && req.method === "POST") {   // a guest takes back their own request
      if (!(await signedDevice(req, env))) return json({ ok: false, error: "Reload the page, then try again." }, 403, extra);
      if (!(await env.SUBMIT_LIMIT.limit({ key: `dev:${dev.id}` })).success)
        return json({ ok: false, error: "Whoa, slow down! Try again in a minute." }, 429, extra);
      const { id } = await body(req);
      return json(await party.cancel(dev.id, String(id ?? "")), 200, extra);
    }
    return json({ error: "not found" }, 404, extra);
}
