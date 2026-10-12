// Smoke pass 1: state machines driven like the real studio + Pi (recent list included).
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Party } from "../src/party";

const T = (title: string, artist = "ABBA") => ({ title, artist, album: "", durationMs: 200000, explicit: false, artwork: "", source: "itunes" as const });
const beat = { source: "soma", current: "", remaining: -1, queued: 0, pushed: [] as string[], working: [] as string[], want: 0, ack: [] as number[], error: "" };
// finished songs and messages left the admin poll (the page reads them from history): ask the queue directly
const statusOf = (p: { fetch: unknown }, id: string, table = "items") => runInDurableObject(p as never, async (_i: Party, st) =>
  String(st.storage.sql.exec(`SELECT status FROM ${table} WHERE id=?`, id).toArray()[0]?.status ?? "deleted"));
const stub = (name: string) => env.PARTY.get(env.PARTY.idFromName(name));
type P = ReturnType<typeof stub>;

async function readyItem(p: P, title: string, device = "d1", durationS = 200) {
  const { id } = await p.submit(device, { track: T(title), name: "x" });
  await p.beat({ ...beat, want: 1 });
  await p.result({ id: id!, status: "ready", file: `${id}.mp3`, durationS });
  return id!;
}
const age = (p: P, sqlText: string, ...b: unknown[]) =>
  runInDurableObject(p, async (_i: Party, s) => { s.storage.sql.exec(sqlText, ...(b as SqlStorageValue[])); });

// A Pi that reports like pi/console.py: recent = last 8 starts (id, start time), newest last.
class Pi {
  recent: [string, number][] = [];
  current = ""; queued = "";
  constructor(public p: P) {}
  st(extra: object = {}) {
    const now = Date.now();
    return { ...beat, source: this.current ? "requests" : "soma", current: this.current, remaining: this.current ? 100 : -1,
             queued: this.queued ? 1 : 0, recent: this.recent.map(([id, t]) => ({ id, agoS: (now - t) / 1000 })), ...extra };
  }
  async handOutAndPush() {
    const r = await this.p.beat({ ...this.st(), wantNext: true } as any);
    const id = r.next?.id;
    if (id) { this.queued = id; await this.p.beat(this.st({ pushed: [id] }) as any); }
    return id;
  }
  start(id = this.queued) { this.current = id; this.queued = ""; this.recent = [...this.recent, [id, Date.now()] as [string, number]].slice(-8); }
}

describe("smoke 1: timeline + end paths", () => {
  it("a song that ends normally (Pi moves on to the next) shows in the history timeline", async () => {
    const p = stub("hist-normal");
    const a = await readyItem(p, "SOS", "d1");
    const b = await readyItem(p, "Waterloo", "d2");
    const pi = new Pi(p);
    await pi.handOutAndPush(); pi.start(); await p.beat(pi.st() as any);
    await age(p, "UPDATE items SET started_at=started_at-300000, queued_at=queued_at-300000 WHERE id=?", a);   // A played its full length
    pi.recent = pi.recent.map(([i, t]) => [i, t - 300000]);
    await pi.handOutAndPush(); pi.start(); await p.beat(pi.st() as any);   // B on air; A in recent
    const st = await p.adminState();
    const hA = st.history.find((h: any) => h.type === "song" && h.id === a);
    console.log("A status", st.items.find((i) => i.id === a)?.status, "history entry", JSON.stringify(hA));
    expect(hA, "A missing from the timeline").toBeTruthy();
  });

  it("a skipped song is marked skipped in the timeline (real Pi beat with recent)", async () => {
    const p = stub("hist-skip");
    const a = await readyItem(p, "SOS", "d1");
    const b = await readyItem(p, "Waterloo", "d2");
    const pi = new Pi(p);
    await pi.handOutAndPush(); pi.start(); await p.beat(pi.st() as any);
    await p.adminAction({ action: "skip" });
    await pi.handOutAndPush(); pi.start(); await p.beat(pi.st() as any);
    const st = await p.adminState();
    const hA = st.history.find((h: any) => h.type === "song" && h.id === a);
    console.log("skip:", JSON.stringify(hA));
    expect(hA?.status).toBe("skipped");
  });

  it("a song cut off early (lost file) with the Pi's recent list goes back to the front once", async () => {
    const p = stub("cutoff-recent");
    const a = await readyItem(p, "SOS", "d1");
    const pi = new Pi(p);
    await pi.handOutAndPush(); pi.start(); await p.beat(pi.st() as any);
    pi.current = "";   // Pi dropped it after a few seconds, back to SomaFM; recent still lists it
    await p.beat(pi.st() as any);
    const it = (await p.adminState()).items.find((i) => i.id === a);
    console.log("cut-off status", it?.status);
    expect(it?.status).toBe("ready");
  });

  it("cut-off without recent (Pi restarted) requeues; second cut is played", async () => {
    const p = stub("cutoff-norecent");
    const a = await readyItem(p, "SOS", "d1");
    await p.beat({ ...beat, wantNext: true });
    await p.beat({ ...beat, pushed: [a], queued: 1 });
    await p.beat({ ...beat, source: "requests", current: a, remaining: 190 });
    await p.beat({ ...beat });
    let st = await p.adminState();
    expect(st.items.find((i) => i.id === a)?.status).toBe("ready");
    expect(st.history.find((h: any) => h.id === a)).toBeFalsy();
    await p.beat({ ...beat, wantNext: true });
    await p.beat({ ...beat, pushed: [a], queued: 1 });
    await p.beat({ ...beat, source: "requests", current: a, remaining: 190 });
    await p.beat({ ...beat });
    st = await p.adminState();
    expect(await statusOf(p, a)).toBe("played");
  });

  it("guest cancel, mute removal and recent-path plays all set ended_at (show in timeline)", async () => {
    const p = stub("ended-paths");
    const c = (await p.submit("d1", { track: T("Cancelled"), name: "x" })).id!;
    await p.cancel("d1", c);
    const m = (await p.submit("bad", { track: T("Muted song"), name: "x" })).id!;
    const j = (await p.submitJoke("bad", { name: "Bad", text: "a joke that is long enough" })).id!;
    await p.adminAction({ action: "mute", device: "bad" });
    const st = await p.adminState();
    const ids = st.history.map((h: any) => h.id);
    console.log("timeline ids", ids);
    expect(ids, "cancelled song").toContain(c);
    expect(ids, "muted song").toContain(m);
    expect(ids, "muted joke").toContain(j);
  });

  it("deleting a played song from history doesn't rewrite it as removed / reorder", async () => {
    const p = stub("delete-played");
    const a = await readyItem(p, "SOS", "d1");
    const b = await readyItem(p, "Waterloo", "d2");
    for (const id of [a, b]) {
      await p.beat({ ...beat, wantNext: true });
      await p.beat({ ...beat, pushed: [id], queued: 1 });
      await p.beat({ ...beat, source: "requests", current: id, remaining: 100 });
      await age(p, "UPDATE items SET started_at=started_at-300000 WHERE id=?", id);
    }
    await p.beat({ ...beat });
    let st = await p.adminState();
    const before = st.history.filter((h: any) => h.type === "song").map((h: any) => `${h.id}:${h.status}`);
    const r = await p.adminAction({ action: "delete", id: a });
    st = await p.adminState();
    const after = st.history.filter((h: any) => h.type === "song").map((h: any) => `${h.id}:${h.status}`);
    console.log("delete played:", r, before, after);
    expect(after).toEqual(before);
  });

  it("deleting twice (two admins) doesn't move the entry in the timeline", async () => {
    const p = stub("delete-twice");
    const a = (await p.submit("d1", { track: T("SOS"), name: "x" })).id!;
    const b = (await p.submit("d2", { track: T("Waterloo"), name: "x" })).id!;
    await p.adminAction({ action: "delete", id: a });
    await new Promise((r) => setTimeout(r, 5));
    await p.adminAction({ action: "delete", id: b });
    await new Promise((r) => setTimeout(r, 5));
    await p.adminAction({ action: "delete", id: a });
    const st = await p.adminState();
    console.log("order", st.history.map((h: any) => h.id));
    expect(st.history.map((h: any) => h.id)).toEqual([b, a]);
  });

  it("resend of a played song keeps its earlier play in the timeline", async () => {
    const p = stub("resend-history");
    const a = await readyItem(p, "SOS", "d1");
    await p.beat({ ...beat, wantNext: true });
    await p.beat({ ...beat, pushed: [a], queued: 1 });
    await p.beat({ ...beat, source: "requests", current: a, remaining: 100 });
    await age(p, "UPDATE items SET started_at=started_at-300000 WHERE id=?", a);
    await p.beat({ ...beat });
    expect((await p.adminState()).history.map((h: any) => h.id)).toContain(a);
    await p.adminAction({ action: "resend", id: a });
    expect((await p.adminState()).history.map((h: any) => h.id), "earlier play vanished").toContain(a);
  });
});

describe("smoke 1: jokes", () => {
  it("a joke deleted after it was handed out as nextJoke stops being handed out", async () => {
    const p = stub("joke-del-ready");
    const j = (await p.submitJoke("d1", { name: "Ann", text: "why did the chicken cross" })).id!;
    await p.beat({ ...beat, wantJokes: 1 });
    await p.jokeResult({ id: j, status: "ready", file: "j.mp3", seconds: 5 });
    expect((await p.beat(beat)).nextJoke?.id).toBe(j);
    await p.adminAction({ action: "deleteJoke", id: j });
    expect((await p.beat(beat)).nextJoke).toBeNull();
    // studio had already told it: jokesPlayed for a deleted joke
    await p.beat({ ...beat, jokesPlayed: [j] });
    const st = await p.adminState();
    console.log("deleted-then-aired joke in timeline:", JSON.stringify(st.history.filter((h: any) => h.id === j).map((h: any) => h.status)));
  });

  it("jokeResult for a deleted joke does not resurrect it", async () => {
    const p = stub("joke-del-prep");
    const j = (await p.submitJoke("d1", { name: "Ann", text: "why did the chicken cross" })).id!;
    await p.beat({ ...beat, wantJokes: 1 });
    await p.adminAction({ action: "deleteJoke", id: j });
    await p.jokeResult({ id: j, status: "ready", file: "j.mp3", seconds: 5 });
    expect((await p.beat(beat)).nextJoke).toBeNull();
  });

  it("urgent guest announcement limits: 1/phone/hour, 1 per 10 min party-wide; host bypasses", async () => {
    const p = stub("urgent");
    const u = (d: string) => p.submitJoke(d, { name: "Ann", text: "the cake is in the kitchen now", kind: "announcement", urgent: true });
    expect((await u("d1")).ok).toBe(true);
    expect((await u("d2")).ok).toBe(false);
    expect((await p.adminAction({ action: "announce", text: "dinner is served" })).ok).toBe(true);
    await age(p, "UPDATE jokes SET created_at=created_at-700000");
    expect((await u("d1")).ok, "same phone within the hour").toBe(false);
    expect((await u("d2")).ok).toBe(true);
  });

  it("urgent as a string 'true' is not urgent; joke kind with urgent:true is not urgent", async () => {
    const p = stub("urgent-types");
    const a = await p.submitJoke("d1", { name: "Ann", text: "the cake is in the kitchen", kind: "announcement", urgent: "true" });
    const b = await p.submitJoke("d2", { name: "Bo", text: "the cake is in the kitchen", kind: "joke", urgent: true });
    const st = await p.adminState();
    expect(st.jokes.find((j: any) => j.id === a.id)!.urgent).toBe(false);
    expect(st.jokes.find((j: any) => j.id === b.id)!.urgent).toBe(false);
  });

  it("lineup: jokes interleaved, beyond 6 songs and with 0 songs", async () => {
    const p = stub("lineup");
    for (let i = 0; i < 3; i++) await p.submitJoke(`j${i}`, { name: `J${i}`, text: `joke number ${i} is funny` });
    let g = await p.guestState("x");
    console.log("0 songs:", g.upNext.map((u: any) => u.title), g.waitingCount);
    for (let i = 0; i < 9; i++) await p.submit(`d${i}`, { track: T(`Song ${i}`), name: "x" });
    g = await p.guestState("x");
    console.log("9 songs:", g.upNext.map((u: any) => u.title).join(" | "), "waitingCount", g.waitingCount);
  });

  it("a muted phone's jokes vanish and it can't send more", async () => {
    const p = stub("mute-jokes");
    await p.submitJoke("bad", { name: "B", text: "a joke long enough here" });
    await p.adminAction({ action: "mute", device: "bad" });
    expect((await p.guestState("x")).upNext).toEqual([]);
    expect((await p.submitJoke("bad", { name: "B", text: "another joke long enough" })).ok).toBe(false);
  });

  it("a stale preparing joke goes back to pending after its lease, and is re-handed", async () => {
    const p = stub("joke-lease");
    const j = (await p.submitJoke("d1", { name: "Ann", text: "why did the chicken cross" })).id!;
    await p.beat({ ...beat, wantJokes: 1 });
    await age(p, "UPDATE jokes SET lease_until=1");
    const r = await p.beat({ ...beat, wantJokes: 1 });
    expect(r.jokeJobs.map((x: any) => x.id)).toEqual([j]);
  });
});

describe("smoke 1: items", () => {
  it("cancel on queued issues one clear; on playing refuses; on played refuses", async () => {
    const p = stub("cancel");
    const a = await readyItem(p, "SOS", "d1");
    await p.beat({ ...beat, wantNext: true });
    expect((await p.cancel("d1", a)).ok).toBe(true);
    const r = await p.beat({ ...beat, wantNext: true });
    expect(r.commands.filter((c: any) => c.type === "clear")).toHaveLength(1);
    expect((await p.cancel("d2", a)).ok).toBe(false);
  });

  it("cancelled song that starts anyway gets one targeted skip", async () => {
    const p = stub("cancel-starts");
    const a = await readyItem(p, "SOS", "d1");
    await p.beat({ ...beat, wantNext: true });
    await p.beat({ ...beat, pushed: [a], queued: 1 });
    await p.cancel("d1", a);
    const r1 = await p.beat({ ...beat, source: "requests", current: a, remaining: 100 });
    const r2 = await p.beat({ ...beat, source: "requests", current: a, remaining: 98 });
    const skips = [...r1.commands, ...r2.commands].filter((c: any) => c.type === "skip");
    console.log("skips", JSON.stringify(r1.commands), JSON.stringify(r2.commands));
    expect(new Set(skips.map((s: any) => s.id)).size).toBe(1);
    expect(skips[0].target).toBe(a);
  });

  it("replay targets the playing song; refused when not playing", async () => {
    const p = stub("replay");
    const a = await readyItem(p, "SOS", "d1");
    expect((await p.adminAction({ action: "replay", id: a })).ok).toBe(false);
    await p.beat({ ...beat, wantNext: true });
    await p.beat({ ...beat, pushed: [a], queued: 1 });
    await p.beat({ ...beat, source: "requests", current: a, remaining: 100 });
    expect((await p.adminAction({ action: "replay", id: a })).ok).toBe(true);
    const r = await p.beat({ ...beat, source: "requests", current: a, remaining: 100 });
    expect(r.commands.find((c: any) => c.type === "replay")?.target).toBe(a);
  });

  it("clear never expires; skip and break do", async () => {
    const p = stub("clear-ttl");
    const a = await readyItem(p, "SOS", "d1");
    await p.beat({ ...beat, wantNext: true });
    await p.adminAction({ action: "delete", id: a });
    await p.adminAction({ action: "break" });
    await age(p, "UPDATE commands SET created_at=created_at-3600000");
    const r = await p.beat(beat);
    expect(r.commands.map((c: any) => c.type)).toEqual(["clear"]);
  });

  it("silence beat doesn't change songs or hand out", async () => {
    const p = stub("silence");
    const a = await readyItem(p, "SOS", "d1");
    await p.beat({ ...beat, wantNext: true });
    await p.beat({ ...beat, pushed: [a], queued: 1 });
    await p.beat({ ...beat, source: "requests", current: a, remaining: 100 });
    const r = await p.beat({ ...beat, source: "silence", wantNext: true });
    expect(r.next).toBeNull();
    expect((await p.adminState()).items.find((i) => i.id === a)?.status).toBe("playing");
  });

  it("resend of a waiting/playing song reports failure instead of ok", async () => {
    const p = stub("resend-waiting");
    const a = (await p.submit("d1", { track: T("SOS"), name: "x" })).id!;
    const r = await p.adminAction({ action: "resend", id: a });
    console.log("resend waiting:", r);
    expect(r.ok).toBe(false);
  });

  it("endsInS / durationS on the playing song", async () => {
    const p = stub("endsin");
    const a = await readyItem(p, "SOS", "d1", 187.6);
    await p.beat({ ...beat, wantNext: true });
    await p.beat({ ...beat, pushed: [a], queued: 1 });
    await p.beat({ ...beat, source: "requests", current: a, remaining: 150 });
    const g = await p.guestState("x");
    expect(g.nowPlaying?.durationS).toBe(188);
    expect(g.nowPlaying?.endsInS).toBeGreaterThan(149);
    expect(g.nowPlaying?.endsInS).toBeLessThanOrEqual(150);
  });
});

describe("smoke 1: export/import + purge", () => {
  it("export/import keeps jokes, airlog, timeline", async () => {
    const old = stub("exp-old");
    const a = await readyItem(old, "SOS", "d1");
    await old.submitJoke("d1", { name: "Ann", text: "why did the chicken cross" });
    await old.beat({ ...beat, aired: [{ kind: "bumper", text: "MattyFM", at: Date.now() - 1000 }] });
    await old.adminAction({ action: "mute", device: "zz" });
    const s = await old.exportState();
    const fresh = stub("exp-new");
    expect(await fresh.isFresh()).toBe(true);
    await fresh.importState(s as any);
    const o = await old.adminState(), n = await fresh.adminState();
    expect(n.jokes.length).toBe(o.jokes.length);
    expect(n.muted.length).toBe(1);
    expect(n.history.filter((h: any) => h.type === "break").length, "airlog lost").toBe(o.history.filter((h: any) => h.type === "break").length);
  });

  it("a jokes-only old queue is still taken over (index.ts condition)", async () => {
    const old = stub("exp-jokes-only");
    await old.submitJoke("d1", { name: "Ann", text: "why did the chicken cross" });
    const s = await old.exportState();
    console.log("items", s.items.length, "settings", s.settings.length, "jokes", s.jokes.length,
      "-> takeOver imports?", Boolean(s.items?.length || s.settings?.length));
  });

  it("purge wipes guest names and texts everywhere", async () => {
    const p = stub("purge");
    await p.submit("d1", { track: T("SOS"), name: "Grandma June", message: "for my love" });
    await p.submitJoke("d1", { name: "Grandma June", text: "secret family joke here" });
    await p.beat({ ...beat, aired: [{ kind: "backannounce", text: "That was for Grandma June", at: Date.now() }] });
    await runInDurableObject(p, async (i: Party) => { await i.alarm(); });
    const dump = JSON.stringify(await p.exportState()) + JSON.stringify(await p.adminState());
    console.log("after purge contains name?", dump.includes("Grandma"));
    expect(dump.includes("Grandma")).toBe(false);
  });
});
