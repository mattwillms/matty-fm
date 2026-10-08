import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Party } from "../src/party";

const T = (title: string, artwork = "") => ({ title, artist: "ABBA", album: "", durationMs: 200000, explicit: false, artwork, source: "itunes" as const });
const beat = { source: "soma", current: "", remaining: -1, queued: 0, pushed: [], working: [], want: 0, ack: [], error: "" };

function stub(name: string) {
  return env.PARTY.get(env.PARTY.idFromName(name));
}

describe("party", () => {
  it("merges duplicate requests into one item", async () => {
    const p = stub("dup");
    const a = await p.submit("d1", { track: T("Waterloo"), name: "Ann", message: "hi" });
    const b = await p.submit("d2", { track: T("waterloo (Remastered)"), name: "Bo", message: "" });
    expect(b.id).toBe(a.id);
    const st = await p.adminState();
    expect(st.items.filter((i) => i.status === "pending")).toHaveLength(1);
    expect(st.items[0].requesters.map((r) => r.name)).toEqual(["Ann", "Bo"]);
  });

  it("caps a device at two waiting requests", async () => {
    const p = stub("cap");
    await p.submit("d1", { track: T("A"), name: "x" });
    await p.submit("d1", { track: T("B"), name: "x" });
    const third = await p.submit("d1", { track: T("C"), name: "x" });
    expect(third.ok).toBe(false);
  });

  it("expired lease returns to pending", async () => {
    const p = stub("lease");
    await p.submit("d1", { track: T("Fernando"), name: "x" });
    const r = await p.beat({ ...beat, want: 1 });
    expect(r.jobs).toHaveLength(1);
    await runInDurableObject(p, async (_i: Party, state) => {
      state.storage.sql.exec("UPDATE items SET lease_until=1");
    });
    const again = await p.beat({ ...beat, want: 1 });
    expect(again.jobs.map((j) => j.id)).toEqual([r.jobs[0].id]);
  });

  it("delete of a queued item emits clear", async () => {
    const p = stub("del");
    const { id } = await p.submit("d1", { track: T("SOS"), name: "x" });
    await p.beat({ ...beat, want: 1 });
    await p.result({ id: id!, status: "ready", file: `${id}.mp3`, durationS: 200 });
    const r1 = await p.beat({ ...beat, wantNext: true });
    expect(r1.next?.id).toBe(id);
    await p.beat({ ...beat, pushed: [id!], queued: 1 });
    await p.adminAction({ action: "delete", id });
    const r2 = await p.beat(beat);
    expect(r2.commands.map((c) => c.type)).toContain("clear");
    expect(r2.next).toBeNull();
  });

  it("playing and played follow the station's current id", async () => {
    const p = stub("play");
    const { id } = await p.submit("d1", { track: T("Mamma Mia"), name: "x" });
    await p.beat({ ...beat, want: 1 });
    await p.result({ id: id!, status: "ready", file: `${id}.mp3`, durationS: 200 });
    await p.beat({ ...beat, pushed: [id!] });
    await p.beat({ ...beat, source: "requests", current: id! });
    expect((await p.guestState("d1")).nowPlaying?.title).toBe("Mamma Mia");
    await p.beat(beat);
    expect((await p.guestState("d1")).nowPlaying).toBeNull();
  });

  it("drops artwork from hosts other than the catalogs", async () => {
    const p = stub("art");
    await p.submit("d1", { track: T("Chiquitita", "https://evil.example/pixel.png"), name: "x" });
    expect((await p.guestState("d1")).upNext[0].artwork).toBe("");
  });

  it("next is only handed out when the studio asks, and is marked queued at once", async () => {
    const p = stub("offer");
    const { id } = await p.submit("d1", { track: T("Voulez-Vous"), name: "x" });
    await p.beat({ ...beat, want: 1 });
    await p.result({ id: id!, status: "ready", file: `${id}.mp3`, durationS: 200 });
    expect((await p.beat({ ...beat, wantNext: false })).next).toBeNull();
    const r = await p.beat({ ...beat, wantNext: true });
    expect(r.next?.id).toBe(id);
    // Deleting it before the studio acks the push must still stop it.
    await p.adminAction({ action: "delete", id });
    expect((await p.beat(beat)).commands.map((c) => c.type)).toContain("clear");
  });

  it("a duplicate request for a handed-out song does not make it play twice", async () => {
    const p = stub("dup2");
    const { id } = await p.submit("d1", { track: T("Gimme Gimme"), name: "x" });
    await p.beat({ ...beat, want: 1 });
    await p.result({ id: id!, status: "ready", file: `${id}.mp3`, durationS: 200 });
    await p.beat({ ...beat, wantNext: true });
    await p.submit("d2", { track: T("Gimme Gimme"), name: "y" });
    const st = await p.adminState();
    expect(st.items.find((i) => i.id === id)?.status).toBe("queued");
  });

  it("a queued item the station lost goes back to ready", async () => {
    const p = stub("lost");
    const { id } = await p.submit("d1", { track: T("Money Money Money"), name: "x" });
    await p.beat({ ...beat, want: 1 });
    await p.result({ id: id!, status: "ready", file: `${id}.mp3`, durationS: 200 });
    await p.beat({ ...beat, wantNext: true });
    await runInDurableObject(p, async (_i: Party, state) => {
      state.storage.sql.exec("UPDATE items SET queued_at=1");
    });
    // Station restarted: nothing queued, nothing playing, item not just pushed.
    const r = await p.beat({ ...beat, queued: 0, wantNext: true });
    expect(r.next?.id).toBe(id);
  });

  it("panic and stop-after-current clear what the station holds", async () => {
    const p = stub("panic");
    const { id } = await p.submit("d1", { track: T("Take a Chance"), name: "x" });
    await p.beat({ ...beat, want: 1 });
    await p.result({ id: id!, status: "ready", file: `${id}.mp3`, durationS: 200 });
    await p.beat({ ...beat, wantNext: true });
    await p.adminAction({ action: "settings", settings: { stopAfterCurrent: true } });
    const r = await p.beat(beat);
    expect(r.commands.map((c) => c.type)).toContain("clear");
    expect((await p.adminState()).items.find((i) => i.id === id)?.status).toBe("ready");
  });

  it("shows SomaFM's song as now playing when no request is on air", async () => {
    const p = stub("soma");
    await p.beat({ ...beat, source: "backup", soma: { artist: "Dane Donohue", title: "Woman", since: 1 } });
    const np = (await p.guestState("d1")).nowPlaying;
    expect(np).toMatchObject({ title: "Woman", artist: "Dane Donohue", soma: true });
  });

  it("resend puts a played request back at the end of the line, ready to play", async () => {
    const p = stub("resend");
    const a = await p.submit("d1", { track: T("Ring Ring"), name: "x" });
    const b = await p.submit("d2", { track: T("Honey Honey"), name: "y" });
    await p.beat({ ...beat, want: 2 });
    await p.result({ id: a.id!, status: "ready", file: `${a.id}.mp3`, durationS: 200 });
    await runInDurableObject(p, async (_i: Party, state) => {
      state.storage.sql.exec("UPDATE items SET status='played' WHERE id=?", a.id!);
    });
    await p.adminAction({ action: "resend", id: a.id });
    const st = await p.adminState();
    const waiting = st.items.filter((i) => ["pending", "preparing", "ready", "queued"].includes(i.status));
    expect(waiting.map((i) => i.id)).toEqual([b.id, a.id]);
    expect(st.items.find((i) => i.id === a.id)?.status).toBe("ready");
  });

  it("the bumper button sends a break command to the studio", async () => {
    const p = stub("bumper");
    await p.adminAction({ action: "break" });
    expect((await p.beat(beat)).commands.map((c) => c.type)).toContain("break");
  });

  it("admin now playing matches the guest page", async () => {
    const p = stub("adminnp");
    await p.beat({ ...beat, source: "soma", soma: { artist: "America", title: "Ventura Highway", since: 1 } });
    const st = await p.adminState();
    expect(st.nowPlaying).toMatchObject({ title: "Ventura Highway", artist: "America", soma: true });
  });

  it("muted phones are listed by name and can be unmuted", async () => {
    const p = stub("unmute");
    await p.submit("phone1", { track: T("Lay All Your Love On Me"), name: "Cousin Ray" });
    await p.adminAction({ action: "mute", device: "phone1" });
    expect((await p.submit("phone1", { track: T("Eagle"), name: "Cousin Ray" })).ok).toBe(false);
    const st = await p.adminState();
    expect(st.muted).toEqual([{ device: "phone1", names: ["Cousin Ray"] }]);
    await p.adminAction({ action: "unmute", device: "phone1" });
    expect((await p.adminState()).muted).toEqual([]);
    expect((await p.submit("phone1", { track: T("Eagle"), name: "Cousin Ray" })).ok).toBe(true);
  });
});
