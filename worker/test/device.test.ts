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
    const state = await SELF.fetch("https://fm.test/api/state?k=dev");
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
});
