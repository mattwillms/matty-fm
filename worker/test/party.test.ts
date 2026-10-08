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
    const r1 = await p.beat(beat);
    expect(r1.next?.id).toBe(id);
    await p.beat({ ...beat, pushed: [id!] });
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
});
