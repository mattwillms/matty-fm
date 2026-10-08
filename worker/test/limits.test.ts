// Per-phone limits: 2 songs, then none until both play; one regular message waiting; one urgent
// an hour. Free play lifts all of them. The guest page shows each limit from guestState().limits.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Party } from "../src/party";

const stub = (name: string) => env.PARTY.get(env.PARTY.idFromName(name));
type P = ReturnType<typeof stub>;
const T = (title: string) => ({ track: { title, artist: "ABBA", album: "", durationMs: 200000, explicit: false, artwork: "", source: "itunes" as const }, name: "Ann" });
const sql = (p: P, q: string, ...b: SqlStorageValue[]) =>
  runInDurableObject(p, async (_i: Party, s) => { s.storage.sql.exec(q, ...b); });
const played = (p: P, id: string) => sql(p, "UPDATE items SET status='played', ended_at=? WHERE id=?", Date.now(), id);
const beat = { source: "soma", current: "", remaining: -1, queued: 0, pushed: [] as string[], working: [] as string[], want: 0, ack: [] as number[], error: "" };

describe("song limit", () => {
  it("2 songs, then none until both have played", async () => {
    const p = stub("songs-1");
    const a = await p.submit("d1", T("Waterloo"));
    const b = await p.submit("d1", T("Mamma Mia"));
    expect(a.ok && b.ok).toBe(true);
    expect((await p.submit("d1", T("SOS"))).ok).toBe(false);
    expect((await p.guestState("d1")).limits.songs).toMatchObject({ active: 2, locked: true, max: 2 });
    await played(p, a.id!);
    const r = await p.submit("d1", T("SOS"));   // one still to play: locked
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/other song plays first/);
    expect((await p.guestState("d1")).limits.songs).toMatchObject({ active: 1, locked: true });
    await played(p, b.id!);
    expect((await p.submit("d1", T("SOS"))).ok).toBe(true);   // both played: free again
    expect((await p.guestState("d1")).limits.songs).toMatchObject({ active: 1, locked: false });
  });

  it("one song waiting leaves room for a second", async () => {
    const p = stub("songs-2");
    await p.submit("d1", T("Waterloo"));
    expect((await p.guestState("d1")).limits.songs).toMatchObject({ active: 1, locked: false });
    expect((await p.submit("d1", T("Mamma Mia"))).ok).toBe(true);
  });

  it("a song on air still counts until it has played", async () => {
    const p = stub("songs-3");
    const a = await p.submit("d1", T("Waterloo"));
    await p.submit("d1", T("Mamma Mia"));
    await sql(p, "UPDATE items SET status='played', ended_at=? WHERE id<>?", Date.now(), a.id!);
    await sql(p, "UPDATE items SET status='playing' WHERE id=?", a.id!);
    expect((await p.submit("d1", T("SOS"))).ok).toBe(false);
  });

  it("cancelling one gives the slot back", async () => {
    const p = stub("songs-4");
    const a = await p.submit("d1", T("Waterloo"));
    await p.submit("d1", T("Mamma Mia"));
    expect((await p.cancel("d1", a.id!)).ok).toBe(true);
    expect((await p.submit("d1", T("SOS"))).ok).toBe(true);
    expect((await p.submit("d1", T("Fernando"))).ok).toBe(false);   // two again: locked again
  });

  it("joining a song someone else asked for uses a slot", async () => {
    const p = stub("songs-5");
    await p.submit("d2", T("Waterloo"));
    await p.submit("d1", T("Waterloo"));
    await p.submit("d1", T("Mamma Mia"));
    expect((await p.submit("d1", T("SOS"))).ok).toBe(false);
  });

  it("the host adds songs past any limit", async () => {
    const p = stub("songs-6");
    for (const t of ["A1", "A2", "A3"]) expect((await p.submit("admin", T(t), true)).ok).toBe(true);
  });
});

describe("message limits", () => {
  it("one regular joke or announcement waiting at a time", async () => {
    const p = stub("msg-1");
    const j = await p.submitJoke("d1", { name: "Ann", text: "Why did the hen cross the road twice?" });
    expect(j.ok).toBe(true);
    expect((await p.guestState("d1")).limits.waiting).toBe(true);
    const r = await p.submitJoke("d1", { name: "Ann", text: "Fish fry starts at six by the barn", kind: "announcement" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/still waiting/);
    await sql(p, "UPDATE jokes SET status='played', ended_at=? WHERE id=?", Date.now(), j.id!);
    expect((await p.guestState("d1")).limits.waiting).toBe(false);
    expect((await p.submitJoke("d1", { name: "Ann", text: "Fish fry starts at six by the barn", kind: "announcement" })).ok).toBe(true);
  });

  it("an urgent one doesn't take the regular slot, and only one an hour", async () => {
    const p = stub("msg-2");
    expect((await p.submitJoke("d1", { name: "Ann", text: "Red truck, your lights are on", kind: "announcement", urgent: true })).ok).toBe(true);
    expect((await p.submitJoke("d1", { name: "Ann", text: "Why did the hen cross the road twice?" })).ok).toBe(true);
    const lim = (await p.guestState("d1")).limits;
    expect(lim.urgentInS).toBeGreaterThan(3500);
    const r = await p.submitJoke("d1", { name: "Ann", text: "Blue truck, your lights are on too", kind: "announcement", urgent: true });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/next one in \d+ min/);
  });

  it("an urgent one the DJ passed on doesn't use up the hour", async () => {
    const p = stub("msg-3");
    const u = await p.submitJoke("d1", { name: "Ann", text: "Red truck, your lights are on", kind: "announcement", urgent: true });
    await p.jokeResult({ id: u.id!, status: "rejected" });
    expect((await p.guestState("d1")).limits.urgentInS).toBe(0);
  });
});

describe("free play", () => {
  it("lifts the song, message and urgent limits, and the admin can switch it", async () => {
    const p = stub("free-1");
    expect((await p.adminAction({ action: "settings", settings: { freePlay: true } })).ok).toBe(true);
    expect((await p.adminState()).settings.freePlay).toBe(true);
    for (const t of ["S1", "S2", "S3", "S4"]) expect((await p.submit("d1", T(t))).ok).toBe(true);
    for (const t of ["Why did the hen cross the road?", "Why did the duck cross the road?"])
      expect((await p.submitJoke("d1", { name: "Ann", text: t })).ok).toBe(true);
    for (const t of ["Red truck, your lights are on", "Blue truck, your lights are on"])
      expect((await p.submitJoke("d1", { name: "Ann", text: t, kind: "announcement", urgent: true })).ok).toBe(true);
    expect((await p.guestState("d1")).limits.freePlay).toBe(true);
    await p.adminAction({ action: "settings", settings: { freePlay: false } });
    expect((await p.submit("d1", T("S5"))).ok).toBe(false);   // limits back: 4 waiting
  });
});

describe("cached song list", () => {
  it("is kept apart from the health record, and survives beats that don't send it", async () => {
    const p = stub("cached-1");
    await p.beat({ ...beat, cached: ["abba|waterloo"] } as never);
    await p.beat({ ...beat });
    expect(await p.cachedKeys()).toEqual(["abba|waterloo"]);
    expect((await p.adminState()).health).not.toHaveProperty("cached");
  });
});

describe("request again", () => {
  it("a played song can be asked for once more, then it's spent (search too)", async () => {
    const p = stub("again-1");
    const a = await p.submit("d1", T("Waterloo"));
    await played(p, a.id!);
    let mine = (await p.guestState("d1")).mine;
    expect(mine[0]).toMatchObject({ status: "played", again: true });
    const b = await p.submit("d1", T("Waterloo"));
    expect(b.ok).toBe(true);
    await played(p, b.id!);
    const st = await p.guestState("d1");
    expect(st.mine.every((m) => m.again === false)).toBe(true);
    expect(st.spent).toEqual([{ title: "Waterloo", artist: "ABBA" }]);
    const c = await p.submit("d1", T("Waterloo"));
    expect(c.ok).toBe(false);
    expect(c.error).toMatch(/twice tonight/);
    expect((await p.submit("d2", T("Waterloo"))).ok).toBe(true);   // another phone still can
  });

  it("a cancelled ask doesn't count", async () => {
    const p = stub("again-2");
    const a = await p.submit("d1", T("Waterloo"));
    await p.cancel("d1", a.id!);
    const b = await p.submit("d1", T("Waterloo"));
    await played(p, b.id!);
    expect((await p.guestState("d1")).mine.find((m) => m.id === b.id)?.again).toBe(true);
  });
});

describe("release", () => {
  it("gives a waiting phone a fresh pair of slots, and lists who waits", async () => {
    const p = stub("release-1");
    await p.submit("d1", T("Waterloo"));
    await p.submit("d1", T("Mamma Mia"));
    const st = await p.adminState();
    expect(st.cooldowns).toMatchObject([{ device: "d1", waiting: 2, names: ["Ann"] }]);
    expect((await p.adminAction({ action: "release", device: "d1" })).ok).toBe(true);
    expect((await p.guestState("d1")).limits.songs).toMatchObject({ active: 0, locked: false });
    expect((await p.submit("d1", T("SOS"))).ok).toBe(true);
    expect((await p.submit("d1", T("Fernando"))).ok).toBe(true);
    expect((await p.submit("d1", T("Chiquitita"))).ok).toBe(false);   // the fresh pair is used: locked again
    expect((await p.adminState()).cooldowns).toHaveLength(1);
  });

  it("release all frees every waiting phone", async () => {
    const p = stub("release-2");
    for (const d of ["d1", "d2"]) { await p.submit(d, T(`${d}a`)); await p.submit(d, T(`${d}b`)); }
    expect((await p.adminState()).cooldowns).toHaveLength(2);
    expect(await p.adminAction({ action: "release" })).toMatchObject({ ok: true, released: 2 });
    expect((await p.adminState()).cooldowns).toHaveLength(0);
  });
});

describe("family mode", () => {
  it("is on by default and refuses explicit picks; off, they're allowed; the host can always add", async () => {
    const p = stub("family-1");
    const explicitTrack = { track: { ...T("WAP").track, explicit: true }, name: "Ann" };
    expect((await p.guestState("d1")).familyMode).toBe(true);
    const r = await p.submit("d1", explicitTrack);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Family mode/);
    expect((await p.submit("admin", explicitTrack, true)).ok).toBe(true);
    await p.adminAction({ action: "settings", settings: { familyMode: false } });
    expect((await p.adminState()).settings.familyMode).toBe(false);
    expect((await p.submit("d1", { track: { ...T("Other").track, explicit: true }, name: "Ann" })).ok).toBe(true);
  });
});
