// Per-phone limits: 2 songs, then none until both play; one regular message waiting; one urgent
// an hour. Free play lifts all of them. The guest page shows each limit from guestState().limits.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Party } from "../src/party";

const stub = (name: string) => env.PARTY.get(env.PARTY.idFromName(name));
type P = ReturnType<typeof stub>;
const T = (title: string) => ({ track: { title, artist: "ABBA", album: "", durationMs: 200000, explicit: false, artwork: "", source: "itunes" as const }, name: "Ann" });
// medals come one a phone every 3 s, the last after 2 minutes: tests age the earlier ones to earn the next
const earnAll = async (p: P, d: string, list: string[]) => { for (const m of list) { await sql(p, "UPDATE medals SET at=at-130000 WHERE device=?", d); await p.earnMedal(d, m); } };
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

describe("anonymous message", () => {
  const studioBeat = { ...beat, wantJokes: 2 };
  it("one a night per phone: the DJ hears a mystery guest, the line shows no name, the host sees who", async () => {
    const p = stub("anon-1");
    const j = await p.submitJoke("d1", { name: "Ann", text: "Why did the hen cross the road twice?", anon: true });
    expect(j.ok).toBe(true);
    expect((await p.guestState("d1")).limits.anonLeft).toBe(false);
    expect((await p.guestState("d1")).myJokes[0].anon).toBe(true);
    expect((await p.guestState("d2")).upNext.find((x) => "joke" in x)).toMatchObject({ names: "a mystery guest" });
    const jobs = (await p.beat(studioBeat as never)).jokeJobs;
    expect(jobs[0]).toMatchObject({ name: "a mystery guest" });
    expect(JSON.stringify(jobs)).not.toContain("Ann");
    expect((await p.adminState()).jokes[0]).toMatchObject({ name: "Ann", anon: true, device: "d1" });
    await sql(p, "UPDATE jokes SET status='played', ended_at=? WHERE id=?", Date.now(), j.id!);
    const r = await p.submitJoke("d1", { name: "Ann", text: "Why did the duck cross the road twice?", anon: true });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/anonymous/i);
    expect((await p.submitJoke("d1", { name: "Ann", text: "Why did the duck cross the road twice?" })).ok).toBe(true);
  });

  it("never urgent; one the DJ passed on doesn't use it up; free play lifts it", async () => {
    const p = stub("anon-2");
    const u = await p.submitJoke("d1", { name: "Ann", text: "Red truck, your lights are on", kind: "announcement", urgent: true, anon: true });
    expect(u.ok).toBe(false);
    expect(u.error).toMatch(/urgent/i);
    const j = await p.submitJoke("d1", { name: "Ann", text: "Fish fry starts at six by the barn", kind: "announcement", anon: true });
    expect(j.ok).toBe(true);
    await p.jokeResult({ id: j.id!, status: "rejected" });
    expect((await p.guestState("d1")).limits.anonLeft).toBe(true);
    await p.submitJoke("d1", { name: "Ann", text: "Fish fry starts at six by the barn", kind: "announcement", anon: true });
    await sql(p, "UPDATE jokes SET status='played', ended_at=? WHERE device='d1'", Date.now());
    await p.adminAction({ action: "settings", settings: { freePlay: true } });
    expect((await p.submitJoke("d1", { name: "Ann", text: "Why did the duck cross the road twice?", anon: true })).ok).toBe(true);
  });
});

describe("preset sound buttons", () => {
  const padCmds = (p: P) => runInDurableObject(p, async (_i: Party, s) =>
    s.storage.sql.exec("SELECT type FROM commands WHERE type LIKE 'pad%'").toArray().map((r) => String(r.type)));
  it("one sound a minute per phone, and a 20 s gap for the whole house", async () => {
    const p = stub("pad-1");
    expect((await p.guestPad("d1", 3)).ok).toBe(true);
    expect(await padCmds(p)).toEqual(["pad3"]);
    const again = await p.guestPad("d1", 2);
    expect(again.ok).toBe(false);
    expect(again.error).toMatch(/Your next sound in \d+ s/);
    expect((await p.guestState("d1")).limits.padInS).toBeGreaterThan(50);
    const other = await p.guestPad("d2", 1);   // someone else, right away: the house gap
    expect(other).toMatchObject({ ok: false, error: expect.stringMatching(/Shared buttons: next sound in \d+ s/) });
    expect((await p.guestState("d2")).limits.padShareInS).toBeGreaterThan(15);   // the dimmed buttons count this down
    await sql(p, "UPDATE pad_presses SET at=at-6000");
    expect((await p.guestPad("d2", 1)).ok).toBe(false);   // 6 s: still inside 20
    await sql(p, "UPDATE pad_presses SET at=at-15000");
    expect((await p.guestPad("d2", 1)).ok).toBe(true);
    expect((await p.guestPad("d1", 9)).ok).toBe(false);   // no such button
  });

  it("the host sets the gap, or turns the buttons off", async () => {
    const p = stub("pad-3");
    await p.adminAction({ action: "settings", settings: { padGapS: 5 } });
    expect((await p.guestPad("d1", 1)).ok).toBe(true);
    await sql(p, "UPDATE pad_presses SET at=at-6000");
    expect((await p.guestPad("d2", 1)).ok).toBe(true);
    await p.adminAction({ action: "settings", settings: { padGapS: 7 } });   // not an option: ignored
    expect((await p.adminState()).settings.padGapS).toBe(5);
    await p.adminAction({ action: "settings", settings: { padGapS: 0, freePlay: true } });
    expect(await p.guestPad("d3", 1)).toMatchObject({ ok: false, error: "The buttons are off right now." });
    expect((await p.guestState("d3")).limits.padsOff).toBe(true);
  });

  it("free play lifts both limits; a muted phone can't press", async () => {
    const p = stub("pad-2");
    await p.adminAction({ action: "settings", settings: { freePlay: true } });
    for (const n of [1, 2, 3]) expect((await p.guestPad("d1", n)).ok).toBe(true);
    expect((await p.guestState("d1")).limits.padInS).toBe(0);
    await sql(p, "INSERT INTO muted(device) VALUES('d9')");
    expect((await p.guestPad("d9", 1)).ok).toBe(false);
  });
});

describe("station off", () => {
  it("is a setting the studio hears on every beat (with family mode, which it never got before)", async () => {
    const p = stub("off-1");
    expect((await p.beat({ ...beat } as never)).settings).toMatchObject({ stationOff: false, familyMode: true });
    await p.adminAction({ action: "settings", settings: { stationOff: true, familyMode: false } });
    expect((await p.adminState()).settings.stationOff).toBe(true);
    expect((await p.beat({ ...beat } as never)).settings).toMatchObject({ stationOff: true, familyMode: false });
    expect((await p.guestState("d1")).stationOff).toBe(true);
  });

  it("while the Pi is off nothing changes state and nothing is handed out; a queued song goes back in line", async () => {
    const p = stub("off-2");
    const a = await p.submit("d1", T("Waterloo"));
    const b = await p.submit("d2", T("Mamma Mia"));
    await sql(p, "UPDATE items SET status='playing', started_at=? WHERE id=?", Date.now(), a.id!);
    await sql(p, "UPDATE items SET status='queued' WHERE id=?", b.id!);
    await p.adminAction({ action: "settings", settings: { stationOff: true } });
    const st = async (id: string) => runInDurableObject(p, async (_i: Party, s) =>
      String(s.storage.sql.exec("SELECT status FROM items WHERE id=?", id).one().status));
    expect(await st(b.id!)).toBe("ready");   // off the console: back in line
    const r = await p.beat({ ...beat, source: "off", wantNext: true } as never);
    expect(r.next).toBeNull();
    expect(r.commands).toEqual([]);
    expect(await st(a.id!)).toBe("playing");   // the Pi's "off" says nothing about it: left as it was
  });
});

describe("station off closes the door", () => {
  it("refuses guests' songs, messages and sounds while off; the host can still add; back on, they're welcome", async () => {
    const p = stub("off-3");
    await p.adminAction({ action: "settings", settings: { stationOff: true } });
    const s = await p.submit("d1", T("Waterloo"));
    expect(s.ok).toBe(false); expect(s.error).toMatch(/off the air/);
    expect((await p.submitJoke("d1", { name: "Ann", text: "Why did the hen cross the road twice?" })).ok).toBe(false);
    expect((await p.guestPad("d1", 1)).ok).toBe(false);
    expect((await p.submit("admin", T("SOS"), true)).ok).toBe(true);
    await p.adminAction({ action: "settings", settings: { stationOff: false } });
    expect((await p.submit("d1", T("Waterloo"))).ok).toBe(true);
  });
});

describe("fresh party", () => {
  it("wipes songs, guests, messages, mutes and limits but keeps settings and the id counter; the console is told to drop what it holds", async () => {
    const p = stub("reset-1");
    await p.adminAction({ action: "settings", settings: { breakEveryMin: 15 } });
    const a = await p.submit("d1", { ...T("Waterloo"), message: "for Bob" });
    const b = await p.submit("d2", T("Mamma Mia"));
    await p.submitJoke("d1", { name: "Ann", text: "Why did the hen cross the road twice?" });
    await p.adminAction({ action: "mute", device: "d2" });
    await sql(p, "UPDATE items SET status='playing', started_at=? WHERE id=?", Date.now(), a.id!);
    await sql(p, "UPDATE items SET status='queued' WHERE id=?", b.id!);
    expect((await p.adminAction({ action: "reset" })).ok).toBe(true);
    const st = await p.adminState();
    expect(st.items).toEqual([]); expect(st.jokes).toEqual([]); expect(st.muted).toEqual([]);
    expect(st.settings.breakEveryMin).toBe(15);
    const r = await p.beat({ ...beat, source: "requests", current: a.id! } as never);   // the Pi is still playing the old song
    expect(r.commands.map((c: { type: string }) => c.type).sort()).toEqual(["clear", "skip"]);
    const c = await p.submit("d1", T("SOS"));
    expect(c.ok).toBe(true);
    expect(Number(c.id!.slice(1))).toBeGreaterThan(Number(b.id!.slice(1)));   // ids never repeat: the Pi still remembers the old ones
  });
});

describe("party test fixes", () => {
  const fill = async (p: P, n: number) => { for (let i = 0; i < n; i++) await p.submit(`f${i}`, T(`Filler ${i}`)); };
  it("a long line: one song per phone at a time; free play lifts it", async () => {
    const p = stub("long-1");
    await fill(p, 21);
    expect((await p.guestState("d1")).limits.songs).toMatchObject({ active: 0, locked: false, max: 1 });
    expect((await p.submit("d1", T("Waterloo"))).ok).toBe(true);
    const r = await p.submit("d1", T("SOS"));
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/line is long/) });
    expect((await p.adminState()).line).toEqual({ songs: 22, oneEach: true });
    await p.adminAction({ action: "settings", settings: { freePlay: true } });
    expect((await p.submit("d1", T("SOS"))).ok).toBe(true);
  });

  it("a request needs letters, and one the studio doubts waits for the host", async () => {
    const p = stub("held-1");
    const junk = { ...T("%%%"), track: { ...T("%%%").track, artist: "%%" }, freeText: true };
    expect(await p.submit("d1", junk)).toMatchObject({ ok: false, error: "Type the song's name in words." });
    const a = await p.submit("d1", { ...T("lol"), freeText: true });
    await p.beat({ ...beat, want: 1 });
    await p.result({ id: a.id!, status: "ready", file: "x.mp3", durationS: 20, confidence: 90, hold: "a single common word" });
    expect((await p.guestState("d1")).mine[0].status).toBe("held");
    expect((await p.guestState("d1")).limits.songs.active).toBe(1);   // a held one uses a slot: junk can't pile up downloads
    expect((await p.adminState()).held.map((h) => [h.id, h.error])).toEqual([[a.id, "a single common word"]]);
    await p.adminAction({ action: "approve", id: a.id });
    expect((await p.adminState()).held).toEqual([]);
    expect((await p.guestState("d1")).mine[0].status).toBe("ready");
    const b = await p.submit("d2", { ...T("Dancing Queen"), freeText: false });   // "picked from search" is the page's word: held too
    await p.beat({ ...beat, want: 1 });
    await p.result({ id: b.id!, status: "ready", file: "y.mp3", durationS: 200, confidence: 10, hold: "a reading, not a song" });
    expect((await p.guestState("d2")).mine[0].status).toBe("held");
    expect((await p.submit("d3", { ...junk, freeText: false })).ok).toBe(false);   // letters checked on every request
    await p.adminAction({ action: "mute", device: "d2" });
    expect((await p.adminState()).held).toEqual([]);   // a muted phone's held songs go too
  });

  it("a joke not told in 45 minutes expires; announcements don't; free play keeps them", async () => {
    const p = stub("stale-1");
    const j = await p.submitJoke("d1", { name: "Ray", text: "Why did the chicken cross the road? Worms." });
    const a = await p.submitJoke("d2", { name: "Ann", text: "Cake is on the back table at 3 o'clock.", kind: "announcement" });
    await sql(p, "UPDATE jokes SET created_at=created_at-40*60000");   // 40 minutes: still waiting its turn
    await p.beat(beat);
    expect((await p.guestState("d1")).myJokes[0].status).toBe("pending");
    await sql(p, "UPDATE jokes SET created_at=created_at-6*60000");
    await p.beat(beat);
    expect((await p.guestState("d1")).myJokes[0].status).toBe("expired");
    expect((await p.guestState("d2")).myJokes[0].status).toBe("pending");
    expect((await p.submitJoke("d1", { name: "Ray", text: "Another joke about a chicken and a road." })).ok).toBe(true);
    void a; void j;
    await p.adminAction({ action: "settings", settings: { freePlay: true } });
    await sql(p, "UPDATE jokes SET created_at=created_at-31*60000 WHERE status='pending'");
    await p.beat(beat);
    expect((await p.guestState("d1")).myJokes[0].status).toBe("pending");
  });

  it("an urgent stays urgent even when the DJ calls it a joke; the host can drop every joke", async () => {
    const p = stub("demote-1");
    const u = await p.submitJoke("d1", { name: "Pop", text: "URGENT knock knock who is there banana", kind: "announcement", urgent: true });
    await p.beat({ ...beat, wantJokes: 1 });
    await p.jokeResult({ id: u.id!, status: "ready", file: "u.mp3", seconds: 5, script: "x", isJoke: true });
    expect((await p.beat(beat)).nextJoke).toMatchObject({ id: u.id, urgent: true, kind: "announcement" });
    await p.submitJoke("d2", { name: "Ann", text: "Cake is on the back table at 3 o'clock.", kind: "announcement" });
    await p.adminAction({ action: "dropJokes" });
    const left = (await p.adminState()).jokes.filter((x) => ["pending", "preparing", "ready"].includes(x.status));
    expect(left.map((x) => x.kind)).toEqual(["announcement", "announcement"]);
  });
});

describe("wait estimate", () => {
  it("adds up song lengths and the DJ's talk; a new phone's fair turn comes earlier than the end", async () => {
    const p = stub("wait-1");
    for (const [d, t] of [["d1", "Waterloo"], ["d1", "SOS"], ["d2", "Mamma Mia"]]) await p.submit(d, T(t));
    await sql(p, "UPDATE items SET status='ready', duration_s=200");
    const s1 = await p.guestState("d1");
    // fair turns: Waterloo (d1), Mamma Mia (d2), SOS (d1)
    expect(s1.mine.map((m) => [m.title, m.waitS])).toEqual([["SOS", 430], ["Waterloo", 0]]);
    expect(s1.waitS).toBe(645);                        // d1 has had its turns: the end of the line
    expect((await p.guestState("d9")).waitS).toBe(430);   // a new phone goes after everyone's first song
  });
});

describe("party clock", () => {
  it("starts, ends, and counts the night since the start", async () => {
    const p = stub("clock-1");
    const old = await p.submit("d0", T("Fernando"));   // before the party: not counted
    await sql(p, "UPDATE requesters SET created_at=created_at-3600000");
    await p.adminAction({ action: "partyStart" });
    const a = await p.submit("d1", T("Waterloo"));
    await p.submit("d2", T("Waterloo"));
    await p.submitJoke("d3", { name: "Ray", text: "Why did the chicken cross the road? Worms." });
    await sql(p, "UPDATE items SET status='played', played_at=?, started_at=created_at+600000 WHERE id=?", Date.now(), a.id!);
    const { stats } = (await p.adminAction({ action: "stats" })) as { stats: Record<string, number> };
    expect(stats).toMatchObject({ played: 1, skipped: 0, requests: 2, guests: 3, messages: 0, medianWaitMin: 10 });
    void old;
    expect((await p.adminState()).party.end).toBeNull();
    await p.adminAction({ action: "partyEnd", title: "Family reunion 2026" });
    expect((await p.adminState()).party.end).toBeGreaterThan(0);
    expect((await p.adminAction({ action: "partyEnd" })).ok).toBe(false);   // ended once: not archived twice
    const { state } = (await p.adminAction({ action: "export" })) as unknown as { state: { items: unknown[]; requesters: unknown[]; jokes: unknown[] } };
    expect([state.items.length, state.requesters.length, state.jokes.length]).toEqual([2, 3, 1]);   // the host's copy of the whole night
    await p.adminAction({ action: "reset" });   // a wipe keeps the archive
    const { parties } = (await p.adminAction({ action: "archive" })) as { parties: { title: string; stats: { requests: number } }[] };
    expect(parties.map((x) => [x.title, x.stats.requests])).toEqual([["Family reunion 2026", 2]]);
    await p.adminAction({ action: "deleteParty", id: String((parties[0] as unknown as { id: number }).id) });
    expect(((await p.adminAction({ action: "archive" })) as { parties: unknown[] }).parties).toEqual([]);
  });
});

describe("orrdle", () => {
  const answer = (p: P, id: string) => runInDurableObject(p, async (_i: Party, st) =>
    String(st.storage.sql.exec("SELECT word FROM orrdle WHERE id=?", id).one().word));
  it("the server keeps the answer, scores each guess, and keeps each guest's record", async () => {
    const p = stub("orrdle-1");
    const seen = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const g = await p.orrdleStart("d1", "Ann");
      expect(g).not.toHaveProperty("word");   // never sent to the phone before the game is over
      const word = await answer(p, g.id!);
      expect(seen.has(word)).toBe(false);
      seen.add(word);
      const wrong = word === "AAAAA" ? "BBBBB" : "AAAAA";
      if (i < 2) {
        for (let k = 0; k < i + 1; k++) await p.orrdleGuess("d1", { id: g.id, guess: wrong });
        expect(await p.orrdleGuess("d1", { id: g.id, guess: word.toLowerCase() })).toMatchObject({ ok: true, over: true, won: true, marks: ["ok", "ok", "ok", "ok", "ok"] });
      } else {
        for (let k = 0; k < 5; k++) expect((await p.orrdleGuess("d1", { id: g.id, guess: wrong })).over).toBe(false);
        expect(await p.orrdleGuess("d1", { id: g.id, guess: wrong })).toMatchObject({ over: true, won: false, word });
      }
    }
    const g = await p.orrdleStart("d1", "Ann");
    expect(g.stats).toMatchObject({ played: 3, wins: 2, streak: 0, dist: [0, 1, 1, 0, 0, 0] });
    expect((await p.orrdleGuess("d2", { id: g.id, guess: "LUCAS" })).ok).toBe(false);   // not your game
    expect((await p.orrdleGuess("d1", { id: g.id, guess: "LUC" })).ok).toBe(false);
    await p.orrdleGuess("d1", { id: g.id, guess: await answer(p, g.id!) });
    const { stats } = (await p.adminAction({ action: "stats" })) as { stats: { orrdle: { plays: number; wins: number; players: number; fewest: { name: string; guesses: number } } } };
    expect(stats.orrdle).toMatchObject({ plays: 4, wins: 3, players: 1, fewest: { name: "Ann", guesses: 1 } });
  });

  it("scores repeats like Wordle", async () => {
    const p = stub("orrdle-2");
    const g = await p.orrdleStart("d1", "Ann");
    await sql(p, "UPDATE orrdle SET word='CARAT' WHERE id=?", g.id!);
    expect((await p.orrdleGuess("d1", { id: g.id, guess: "AARON" })).marks).toEqual(["near", "ok", "ok", "no", "no"]);   // first A: the other A of CARAT; second A and R: right place
  });

  it("the privacy wipe takes Orrdle names out of the archive too", async () => {
    const p = stub("orrdle-3");
    await p.adminAction({ action: "partyStart" });
    const g = await p.orrdleStart("d1", "Ann");
    await p.orrdleGuess("d1", { id: g.id, guess: await answer(p, g.id!) });
    await p.adminAction({ action: "partyEnd", title: "Night" });
    await runInDurableObject(p, async (i: Party) => { await i.alarm(); });
    const { parties } = (await p.adminAction({ action: "archive" })) as { parties: { stats: { orrdle: { fastest: { name: string }; top: { name: string }[] } } }[] };
    expect(JSON.stringify(parties)).not.toContain("Ann");
  });
});

describe("scavenger hunt", () => {
  const ALL = ["eggs", "kaboom", "snap", "needle", "static", "colors", "screws", "gnat", "polish"];
  it("medals once each; all of them bring a golden quarter for one more song; cancelling it gives it back", async () => {
    const p = stub("hunt-1");
    expect((await p.earnMedal("d1", "nope")).ok).toBe(false);
    await earnAll(p, "d1", ALL.slice(0, 8));
    await p.earnMedal("d1", "eggs");   // twice: still one
    expect((await p.guestState("d1")).hunt).toMatchObject({ total: 9, golden: "none" });
    expect((await p.guestState("d1")).hunt.medals).toHaveLength(8);
    await p.submit("d1", T("Waterloo")); await p.submit("d1", T("SOS"));
    expect((await p.submit("d1", T("Fernando"))).ok).toBe(false);   // locked, no golden yet
    await sql(p, "UPDATE medals SET at=at-130000 WHERE device='d1'");
    expect((await p.earnMedal("d1", "polish")).hunt.golden).toBe("ready");
    const g = await p.submit("d1", T("Fernando"));                  // the golden quarter
    expect(g.ok).toBe(true);
    expect((await p.guestState("d1")).hunt.golden).toBe("used");
    expect((await p.submit("d1", T("Chiquitita"))).ok).toBe(false);  // spent
    await p.cancel("d1", g.id!);
    expect((await p.guestState("d1")).hunt.golden).toBe("ready");   // cancelled: the quarter comes back
  });

  it("the host's guest list, and a quarter on the house", async () => {
    const p = stub("hunt-2");
    await p.guestState("d1");
    await p.submit("d1", T("Waterloo")); await p.submit("d1", T("SOS"));
    const { guests } = (await p.adminAction({ action: "guests" })) as { guests: { device: string; names: string[]; requests: number; locked: boolean; coins: number }[] };
    expect(guests[0]).toMatchObject({ device: "d1", names: ["Ann"], requests: 2, locked: true, coins: 0 });
    await p.adminAction({ action: "giveCoin", device: "d1" });
    expect((await p.submit("d1", T("Fernando"))).ok).toBe(true);
    expect((await p.submit("d1", T("Chiquitita"))).ok).toBe(false);
  });
});

describe("kick and the golden quarter on air", () => {
  it("a kick clears the phone's waiting songs and messages and tells its page; the golden pick reaches the DJ", async () => {
    const p = stub("kick-1");
    const a = await p.submit("d1", T("Waterloo"));
    await p.submit("d2", T("SOS")); await p.submit("d1", T("SOS"));   // shared: d1's name comes off, the song stays
    await p.submitJoke("d1", { name: "Ann", text: "Why did the chicken cross the road? Worms." });
    await p.adminAction({ action: "kick", device: "d1" });
    const s = await p.guestState("d1");
    expect(s.kicked).toBeGreaterThan(0);
    expect(s.limits.songs).toMatchObject({ active: 0, locked: false });
    expect((await p.adminState()).items.find((i: { id: string }) => i.id === a.id)?.status ?? "deleted").not.toBe("pending");
    expect((await p.guestState("d2")).mine).toHaveLength(1);
    await earnAll(p, "d3", ["eggs", "kaboom", "snap", "needle", "static", "colors", "screws", "gnat", "polish"]);
    await p.submit("d3", T("Fernando")); await p.submit("d3", T("Chiquitita"));
    await p.submit("d3", T("Dancing Queen"));
    const jobs = (await p.beat({ ...beat, want: 10 })).jobs as { title: string; requesters: { golden?: boolean }[] }[];
    expect(jobs.find((j) => j.title === "Dancing Queen")!.requesters[0].golden).toBe(true);
    expect(jobs.find((j) => j.title === "Fernando")!.requesters[0].golden).toBeUndefined();
  });
});

describe("names", () => {
  it("the poll says whether the queue holds this phone's name: false after a reset, so the page claims it again", async () => {
    const p = stub("names-reset");
    expect((await p.guestState("d1")).named).toBe(false);
    await p.claimName("d1", "Mo");
    expect((await p.guestState("d1")).named).toBe(true);
    await p.adminAction({ action: "reset" });
    expect((await p.guestState("d1")).named).toBe(false);
    expect(await p.claimName("d1", "Mo")).toEqual({ ok: true, name: "Mo" });
  });
  it("one phone per name (any case), letters only; a kicked phone coming back with its name gets it numbered", async () => {
    const p = stub("names-1");
    expect(await p.claimName("d1", "Lena")).toEqual({ ok: true, name: "Lena" });
    expect((await p.claimName("d2", "lena")).ok).toBe(false);                 // taken, whatever the case
    expect((await p.claimName("d2", "Lena 😀")).ok).toBe(false);              // letters only
    expect((await p.claimName("d2", "Lena2")).ok).toBe(false);
    expect(await p.claimName("d2", "Mary  Ann")).toEqual({ ok: true, name: "Mary Ann" });
    await p.adminAction({ action: "kick", device: "d1" });
    const g = (await p.adminAction({ action: "guests" })) as { guests: { device: string; names: string[] }[] };
    expect(g.guests.find((x) => x.device === "d1")).toBeUndefined();   // the kicked phone is off the list...
    await new Promise((r) => setTimeout(r, 5)); await p.guestState("d1");
    const g2 = (await p.adminAction({ action: "guests" })) as { guests: { device: string; names: string[] }[] };
    expect(g2.guests.find((x) => x.device === "d1")?.names).toEqual([]);   // ...until it's back, unnamed
    expect(await p.claimName("d1", "LENA")).toEqual({ ok: true, name: "LENA 2" });   // back, same name: numbered
    expect(await p.claimName("d3", "Lena")).toEqual({ ok: true, name: "Lena" });     // the plain name was free again
    const r = await p.submit("d3", { ...T("SOS"), name: "Somebody" });          // sends something else: its own name wins
    expect((await p.adminState()).items.find((i: { id: string }) => i.id === r.id)?.requesters[0].name).toBe("Lena");
  });

  it("typed text loses emoji and symbols; accents stay", async () => {
    const p = stub("names-2");
    await p.claimName("d1", "Ann");
    const r = await p.submit("d1", { track: { ...T("Beyoncé 🔥 Halo").track, artist: "Beyoncé" }, name: "Ann", message: "love you 😘❤️ mom" });
    const it = (await p.adminState()).items.find((i: { id: string }) => i.id === r.id)!;
    expect([it.title, it.requesters[0].message]).toEqual(["Beyoncé Halo", "love you mom"]);
  });
});

describe("names, coming back", () => {
  it("a phone whose kept name is taken now is a new guest, numbered; the form itself still says it's taken", async () => {
    const p = stub("names-3");
    await p.claimName("d1", "Ann");
    expect((await p.claimName("d2", "ann")).error).toMatch(/already Ann\./);   // named as its holder spelled it
    expect(await p.claimName("d2", "ann", true)).toEqual({ ok: true, name: "ann 2" });
    expect(await p.claimName("d3", "Ann", true)).toEqual({ ok: true, name: "Ann 3" });
  });
});

describe("custom sounds", () => {
  it("a guest with a sound of their own hears it on Applause (any case, numbered names too)", async () => {
    const { customPad } = await import("../src/party");
    const names = ["sam"];
    expect([customPad(5, "sam", names), customPad(5, "bob", names), customPad(2, "sam", names)]).toEqual(["pad5-sam", "pad5", "pad2"]);
    expect(customPad(5, "sam")).toBe("pad5");   // none set up: plain Applause for everyone
    const p = stub("custom-1");
    await p.adminAction({ action: "settings", settings: { freePlay: true } });
    await p.claimName("d1", "Sam 2"); await p.guestPad("d1", 5);
    const cmds = await runInDurableObject(p, async (_i: Party, s) =>
      s.storage.sql.exec("SELECT type FROM commands WHERE type LIKE 'pad%' ORDER BY id").toArray().map((r) => String(r.type)));
    expect(cmds).toEqual(["pad5"]);
  });
});

describe("first to finish the hunt", () => {
  it("is announced once, by the name they go by", async () => {
    const p = stub("hunt-first-1");
    const ALL = ["eggs", "kaboom", "snap", "needle", "static", "colors", "screws", "gnat", "polish"];
    await p.claimName("d1", "Lena"); await p.claimName("d2", "Bo");
    await earnAll(p, "d1", ALL);
    await earnAll(p, "d2", ALL);
    const msgs = (await p.adminState()).jokes.filter((j: { source: string }) => j.source === "host");
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ kind: "announcement", urgent: false });
    expect(msgs[0].text).toMatch(/Lena is the first tonight to find every medal/);
  });
});

describe("medal pace", () => {
  it("refuses medals faster than one per 3 s, and a finish inside 2 minutes, saying when to try again", async () => {
    const p = stub("pace-1");
    expect((await p.earnMedal("d1", "eggs")).ok).toBe(true);
    const r = await p.earnMedal("d1", "kaboom");   // 3 s haven't passed
    expect(r.ok).toBe(false);
    expect(r.retryIn).toBeGreaterThan(2000);
    expect(r.retryIn).toBeLessThanOrEqual(3000);
    await sql(p, "UPDATE medals SET at=at-3100");
    expect((await p.earnMedal("d1", "kaboom")).ok).toBe(true);
    for (const m of ["snap", "needle", "static", "colors", "screws", "gnat"]) { await sql(p, "UPDATE medals SET at=at-3100"); await p.earnMedal("d1", m); }
    await sql(p, "UPDATE medals SET at=at-3100");
    const last = await p.earnMedal("d1", "polish");   // all nine in under 2 minutes: not yet
    expect(last.ok).toBe(false);
    expect(last.retryIn).toBeGreaterThan(90_000);
  });
});

describe("free play for one phone", () => {
  it("the host can lift one phone's limits without lifting everyone's", async () => {
    const p = stub("free-one-1");
    for (const t of ["A1", "A2"]) expect((await p.submit("d1", T(t))).ok).toBe(true);
    for (const t of ["B1", "B2"]) expect((await p.submit("d2", T(t))).ok).toBe(true);
    expect((await p.submit("d1", T("A3"))).ok).toBe(false);   // both quarters in
    expect((await p.adminAction({ action: "freePlay", device: "d1", on: true })).ok).toBe(true);
    expect((await p.guestState("d1")).limits.freePlay).toBe(true);
    expect((await p.guestState("d2")).limits.freePlay).toBe(false);
    for (const t of ["A3", "A4", "A5"]) expect((await p.submit("d1", T(t))).ok).toBe(true);
    expect((await p.submit("d2", T("B3"))).ok).toBe(false);   // everyone else still has two
    const g = (await p.adminAction({ action: "guests" })) as { guests: { device: string; freePlay: boolean }[] };
    expect(g.guests.find((x) => x.device === "d1")?.freePlay).toBe(true);
    expect(g.guests.find((x) => x.device === "d2")?.freePlay).toBe(false);
    // its jokes never expire, like free play for everyone
    await p.submitJoke("d1", { name: "Ray", text: "Why did the chicken cross the road? Worms." });
    await sql(p, "UPDATE jokes SET created_at=created_at-50*60000");
    await p.beat(beat);
    expect((await p.guestState("d1")).myJokes[0].status).toBe("pending");
    await p.adminAction({ action: "freePlay", device: "d1", on: false });
    expect((await p.submit("d1", T("A6"))).ok).toBe(false);
  });
});
