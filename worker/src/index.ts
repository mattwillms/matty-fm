// Router + auth. Guests: party code + device cookie. Admin: x-admin-token. Studio: bearer secret.
import { Party } from "./party";
import { searchAll } from "./search";

export { Party };

// Bump whenever party.ts changes. A deployed Durable Object kept running its first
// version all evening (deploys did not restart it), so each queue-code change gets a
// fresh instance. Queue state resets on a bump: never bump on party day.
const QUEUE_VERSION = 7;

const enc = new TextEncoder();

function same(given: string | null, secret: string): boolean {
  if (!given || !secret) return false;
  const a = enc.encode(given), b = enc.encode(secret);
  return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
}

function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });
}

function device(req: Request): { id: string; cookie?: string } {
  const m = /(?:^|;\s*)mfm_dev=([A-Za-z0-9-]{36})/.exec(req.headers.get("cookie") ?? "");
  if (m) return { id: m[1] };
  const id = crypto.randomUUID();
  return { id, cookie: `mfm_dev=${id}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax` };
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
    const body = async () => (req.method === "POST" ? await req.json<any>() : {});

    if (path.startsWith("/api/studio/")) {
      if (!same(req.headers.get("authorization")?.replace(/^Bearer /, "") ?? null, env.STUDIO_SECRET))
        return json({ error: "unauthorized" }, 401);
      if (path === "/api/studio/beat") return json(await party.beat(await body()));
      if (path === "/api/studio/result") return json(await party.result(await body()));
      if (path === "/api/studio/tts") {
        const { text } = await body();
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
      if (path === "/api/admin/action") return json(await party.adminAction(await body()));
      return json({ error: "not found" }, 404);
    }

    if (!same(url.searchParams.get("k"), env.PARTY_CODE)) return json({ error: "Ask the host for the party QR code." }, 403);
    const dev = device(req);
    const extra: HeadersInit = dev.cookie ? { "set-cookie": dev.cookie } : {};
    if (path === "/api/search") {
      const q = (url.searchParams.get("q") ?? "").trim();
      if (q.length < 3) return json({ results: [] }, 200, extra);
      return json(await cachedSearch(q, ctx), 200, extra);
    }
    if (path === "/api/state") return json(await party.guestState(dev.id), 200, extra);
    if (path === "/api/cached") {
      // Song keys the studio already has on disk (sent with each check-in): they play instantly.
      const h = (await party.adminState()).health as { cached?: string[] };
      return json({ keys: Array.isArray(h.cached) ? h.cached : [] }, 200, { ...extra, "cache-control": "max-age=60" });
    }
    if (path === "/api/request" && req.method === "POST") {
      const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
      if (!(await env.SUBMIT_LIMIT.limit({ key: ip })).success)
        return json({ ok: false, error: "Whoa, slow down! Try again in a minute." }, 429, extra);
      return json(await party.submit(dev.id, await body()), 200, extra);
    }
    return json({ error: "not found" }, 404, extra);
  },
} satisfies ExportedHandler<Env>;
