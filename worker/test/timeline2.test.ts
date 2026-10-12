// Smoke pass 2: second angle (consequences of the fix, joke edges, limits, crowding).
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Party } from "../src/party";

const T = (title: string, artist = "ABBA") => ({ title, artist, album: "", durationMs: 200000, explicit: false, artwork: "", source: "itunes" as const });
const beat = { source: "soma", current: "", remaining: -1, queued: 0, pushed: [] as string[], working: [] as string[], want: 0, ack: [] as number[], error: "" };
const stub = (name: string) => env.PARTY.get(env.PARTY.idFromName(name));
type P = ReturnType<typeof stub>;
async function readyItem(p: P, title: string, device = "d1") {
  const { id } = await p.submit(device, { track: T(title), name: "x" });
  await p.beat({ ...beat, want: 1 });
  await p.result({ id: id!, status: "ready", file: `${id}.mp3`, durationS: 200 });
  return id!;
}
async function onAir(p: P, id: string) {
  await p.beat({ ...beat, wantNext: true });
  await p.beat({ ...beat, pushed: [id], queued: 1 });
  await p.beat({ ...beat, source: "requests", current: id, remaining: 190, recent: [{ id, agoS: 1 }] } as any);
}

describe("smoke 2", () => {
  it("SomaFM-only switched on mid-song: the cut song is not queued to play again", async () => {
    const p = stub("soma-only-mid");
    const a = await readyItem(p, "SOS");
    await onAir(p, a);
    await p.adminAction({ action: "settings", settings: { somaOnly: true } });
    // studio skips on its own (feed.decide), Pi back on SomaFM, recent lists a
    await p.beat({ ...beat, recent: [{ id: a, agoS: 0 }] } as any);
    const st = await p.adminState();
    expect(st.items.find((i) => i.id === a)?.status).not.toBe("ready");
  });

  it("a joke deleted after the studio already told it shows as told, not removed", async () => {
    const p = stub("joke-aired-after-delete");
    const j = (await p.submitJoke("d1", { name: "Ann", text: "why did the chicken cross" })).id!;
    await p.beat({ ...beat, wantJokes: 1 });
    await p.jokeResult({ id: j, status: "ready", file: "j.mp3", seconds: 5 });
    await p.beat(beat);
    await p.adminAction({ action: "deleteJoke", id: j });
    await p.beat({ ...beat, jokesPlayed: [j] });
    const h = (await p.adminState()).history.find((x: any) => x.id === j);
    expect(h?.status).toBe("played");
  });

  it("a rejected urgent announcement doesn't block the party-wide urgent slot", async () => {
    const p = stub("urgent-rejected");
    const j = (await p.submitJoke("d1", { name: "Ann", text: "the cake is in the kitchen", kind: "announcement", urgent: true })).id!;
    await p.beat({ ...beat, wantJokes: 1 });
    await p.jokeResult({ id: j, status: "rejected" });
    const r = await p.submitJoke("d2", { name: "Bo", text: "the car lights are on outside", kind: "announcement", urgent: true });
    expect(r.ok).toBe(true);
  });

  it("host announcement is accepted while requests are closed, and goes first", async () => {
    const p = stub("host-closed");
    await p.submitJoke("d1", { name: "Ann", text: "a regular joke here ok" });
    await p.adminAction({ action: "settings", settings: { accepting: false } });
    const r = await p.adminAction({ action: "announce", text: "Cake time everyone" });
    expect(r.ok).toBe(true);
    const jobs = (await p.beat({ ...beat, wantJokes: 1 })).jokeJobs;
    expect(jobs[0].id).toBe(r.id);
  });

  it("the timeline keeps the last 40 entries: busy breaks crowd songs out", async () => {
    const p = stub("crowd");
    const a = await readyItem(p, "SOS");
    await onAir(p, a);
    await runInDurableObject(p, async (_i: Party, s) => { s.storage.sql.exec("UPDATE items SET started_at=started_at-300000"); });
    await p.beat({ ...beat });
    const now = Date.now();
    await p.beat({ ...beat, aired: Array.from({ length: 20 }, (_, i) => ({ kind: "id", text: "MattyFM", at: now + i })) });
    await p.beat({ ...beat, aired: Array.from({ length: 20 }, (_, i) => ({ kind: "goof", text: "ha", at: now + 100 + i })) });
    const st = await p.adminState();
    expect(st.history.some((h: any) => h.id === a), "the one song played is gone from the timeline after 40 bumpers").toBe(true);
  });

  it("beat with want as a non-number doesn't 500 the studio's check-in", async () => {
    const p = stub("want-nan");
    await p.submit("d1", { track: T("SOS"), name: "x" });
    await expect(p.beat({ ...beat, want: "2" as any })).resolves.toBeTruthy();
    await expect(p.beat({ ...beat, want: "lots" as any })).resolves.toBeTruthy();
  });

  it("mute of a phone with only jokes shows a name in the muted list", async () => {
    const p = stub("mute-joker");
    await p.submitJoke("joker", { name: "Uncle Bob", text: "a joke long enough here" });
    await p.adminAction({ action: "mute", device: "joker" });
    expect((await p.adminState()).muted[0].names).toContain("Uncle Bob");
  });
});
