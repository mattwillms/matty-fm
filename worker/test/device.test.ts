import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";

// Requests need a phone id the Worker itself issued: an invented cookie is a new, unsigned phone.
describe("device cookie", () => {
  it("only a signed id the Worker issued can request", async () => {
    const forged = await SELF.fetch("https://fm.test/api/request?k=dev", {
      method: "POST", headers: { cookie: "mfm_dev=00000000-0000-4000-8000-000000000000", "content-type": "application/json" },
      body: JSON.stringify({ track: { title: "Waterloo", artist: "ABBA" }, name: "x" }),
    });
    expect(forged.status).toBe(403);
    const state = await SELF.fetch("https://fm.test/api/state?k=dev&load=1");
    const cookie = (state.headers.get("set-cookie") ?? "").split(";")[0];
    expect(cookie).toMatch(/^mfm_dev=[0-9a-f-]{36}\.[A-Za-z0-9_-]{22}$/);
    const ok = await SELF.fetch("https://fm.test/api/request?k=dev", {
      method: "POST", headers: { cookie, "content-type": "application/json", "cf-connecting-ip": "10.0.0.1" },
      body: JSON.stringify({ track: { title: "Waterloo", artist: "ABBA" }, name: "x" }),
    });
    expect(((await ok.json()) as { ok: boolean }).ok).toBe(true);
    const tampered = cookie.slice(0, -2) + (cookie.endsWith("AA") ? "BB" : "AA");
    const bad = await SELF.fetch("https://fm.test/api/request?k=dev", {
      method: "POST", headers: { cookie: tampered, "content-type": "application/json" },
      body: JSON.stringify({ track: { title: "SOS", artist: "ABBA" }, name: "x" }),
    });
    expect(bad.status).toBe(403);
  });

  it("new phone ids are handed out at a human pace per address", async () => {
    let issued = 0;
    for (let i = 0; i < 40; i++) {
      const r = await SELF.fetch("https://fm.test/api/state?k=dev&load=1", { headers: { "cf-connecting-ip": "198.51.100.7" } });
      if (r.headers.get("set-cookie")) issued++;
    }
    expect(issued).toBeLessThanOrEqual(30);
    expect(issued).toBeGreaterThan(0);
  });

  it("junk posts don't use up the house's request allowance", async () => {
    const state = await SELF.fetch("https://fm.test/api/state?k=dev&load=1", { headers: { "cf-connecting-ip": "198.51.100.8" } });
    const junkCookie = (state.headers.get("set-cookie") ?? "").split(";")[0];
    for (let i = 0; i < 130; i++)
      await SELF.fetch("https://fm.test/api/request?k=dev", { method: "POST", headers: { cookie: junkCookie, "cf-connecting-ip": "198.51.100.8" }, body: "{}" });
    const fresh = await SELF.fetch("https://fm.test/api/state?k=dev&load=1", { headers: { "cf-connecting-ip": "198.51.100.8" } });
    const cookie = (fresh.headers.get("set-cookie") ?? "").split(";")[0];
    const ok = await SELF.fetch("https://fm.test/api/request?k=dev", {
      method: "POST", headers: { cookie, "content-type": "application/json", "cf-connecting-ip": "198.51.100.8" },
      body: JSON.stringify({ track: { title: "Ring Ring", artist: "ABBA" }, name: "Grandma" }),
    });
    expect(ok.status).toBe(200);
  });
  it("only the page load hands out a phone id, so each phone costs the house one", async () => {
    const ip = { "cf-connecting-ip": "198.51.100.9" };
    const cached = await SELF.fetch("https://fm.test/api/cached?k=dev", { headers: ip });
    const search = await SELF.fetch("https://fm.test/api/search?k=dev&q=abba", { headers: ip });
    expect(cached.headers.get("set-cookie")).toBeNull();
    expect(search.headers.get("set-cookie")).toBeNull();
    let issued = 0;
    for (let i = 0; i < 30; i++) {
      await SELF.fetch("https://fm.test/api/cached?k=dev", { headers: ip });
      if ((await SELF.fetch("https://fm.test/api/state?k=dev&load=1", { headers: ip })).headers.get("set-cookie")) issued++;
    }
    expect(issued).toBe(30);
  });
  it("cancel works only from the phone that asked", async () => {
    const ip = { "cf-connecting-ip": "198.51.100.20" };
    const cookieOf = async () => ((await SELF.fetch("https://fm.test/api/state?k=dev&load=1", { headers: ip })).headers.get("set-cookie") ?? "").split(";")[0];
    const mine = await cookieOf(), other = await cookieOf();
    const sent = await (await SELF.fetch("https://fm.test/api/request?k=dev", {
      method: "POST", headers: { ...ip, cookie: mine, "content-type": "application/json" },
      body: JSON.stringify({ track: { title: "Eagle", artist: "ABBA" }, name: "Me" }) })).json() as { id: string };
    const cancel = (cookie: string) => SELF.fetch("https://fm.test/api/cancel?k=dev", {
      method: "POST", headers: { ...ip, cookie, "content-type": "application/json" }, body: JSON.stringify({ id: sent.id }) });
    expect((await cancel("mfm_dev=00000000-0000-4000-8000-000000000000")).status).toBe(403);
    expect(((await (await cancel(other)).json()) as { ok: boolean }).ok).toBe(false);
    expect(((await (await cancel(mine)).json()) as { ok: boolean }).ok).toBe(true);
  });
  it("a joke needs the phone's signed id; the studio reports it back", async () => {
    const ip = { "cf-connecting-ip": "198.51.100.30" };
    const joke = (cookie: string) => SELF.fetch("https://fm.test/api/joke?k=dev", {
      method: "POST", headers: { ...ip, cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Ray", text: "I used to hate facial hair, but then it grew on me." }) });
    expect((await joke("mfm_dev=00000000-0000-4000-8000-000000000000")).status).toBe(403);
    const cookie = ((await SELF.fetch("https://fm.test/api/state?k=dev&load=1", { headers: ip })).headers.get("set-cookie") ?? "").split(";")[0];
    const r = await (await joke(cookie)).json() as { ok: boolean; id: string };
    expect(r.ok).toBe(true);
    const res = await SELF.fetch("https://fm.test/api/studio/joke", { method: "POST",
      headers: { authorization: "Bearer devstudio", "content-type": "application/json" }, body: JSON.stringify({ id: r.id, status: "rejected" }) });
    expect(res.status).toBe(200);
  });
});
