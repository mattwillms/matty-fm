// Findings from the 2026-10-08 QA round, each pinned by a test.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Party } from "../src/party";
import { clean, isOffensive, songKey } from "../src/queue";

const T = (title: string, artist = "ABBA") => ({ title, artist, album: "", durationMs: 200000, explicit: false, artwork: "", source: "itunes" as const });
const beat = { source: "soma", current: "", remaining: -1, queued: 0, pushed: [], working: [], want: 0, ack: [], error: "" };
const stub = (name: string) => env.PARTY.get(env.PARTY.idFromName(name));

async function readyItem(p: ReturnType<typeof stub>, title: string, device = "d1") {
  const { id } = await p.submit(device, { track: T(title), name: "x" });
  await p.beat({ ...beat, want: 1 });
  await p.result({ id: id!, status: "ready", file: `${id}.mp3`, durationS: 200 });
  return id!;
}

describe("QA round", () => {
  it("wipes names after the party, never during it", async () => {
    const p = stub("alarm");
    await p.submit("d1", { track: T("Waterloo"), name: "Ann" });
    const at = await runInDurableObject(p, async (_i: Party, state) => state.storage.getAlarm());
    expect(at).toBe(Date.UTC(2026, 9, 13, 12));
  });

  it("joining a ready song adds the guest without preparing it again", async () => {
    const p = stub("join-ready");
    const id = await readyItem(p, "SOS");
    await p.submit("d2", { track: T("SOS"), name: "Bo" });
    const st = await p.adminState();
    const it = st.items.find((i) => i.id === id)!;
    expect(it.status).toBe("ready");
    expect(it.requesters.map((r) => r.name)).toEqual(["x", "Bo"]);
  });

  it("songs in other scripts keep their own key", () => {
    expect(songKey("Кино", "Группа крови")).not.toBe(songKey("坂本九", "上を向いて歩こう"));
    expect(songKey("Кино", "Группа крови")).not.toBe("|");
    expect(songKey("Q".repeat(300), "B".repeat(300)).length).toBeLessThanOrEqual(161);
  });

  it("forgets commands the studio never picked up within 20 s", async () => {
    const p = stub("stale-cmd");
    await p.adminAction({ action: "break" });
    await runInDurableObject(p, async (_i: Party, state) => {
      state.storage.sql.exec("UPDATE commands SET created_at=?", Date.now() - 25_000);
    });
    expect((await p.beat(beat)).commands).toEqual([]);
  });

  it("a skip only skips the song it was sent for", async () => {
    const p = stub("skip-target");
    const id = await readyItem(p, "Mamma Mia");
    await p.beat({ ...beat, source: "requests", current: id, remaining: 100 });
    await p.adminAction({ action: "skip" });
    const r = await p.beat({ ...beat, source: "requests", current: "r99", remaining: 100 });   // already moved on
    expect(r.commands.map((c) => c.type)).not.toContain("skip");
  });

  it("muting a phone also removes its song that is up next", async () => {
    const p = stub("mute-queued");
    const id = await readyItem(p, "Fernando", "teen");
    await p.beat({ ...beat, wantNext: true });
    await p.adminAction({ action: "mute", device: "teen" });
    const st = await p.adminState();
    expect(st.items.find((i) => i.id === id)?.status ?? "deleted").toBe("deleted");
    expect((await p.beat(beat)).commands.map((c) => c.type)).toContain("clear");
  });

  it("the handed-out song is first in line by rank too, so ▲▼ match the screen", async () => {
    const p = stub("move-order");
    const { id: a } = await p.submit("d1", { track: T("Dancing Queen"), name: "x" });
    const { id: b } = await p.submit("d2", { track: T("Chiquitita"), name: "y" });
    await p.beat({ ...beat, want: 2 });                          // both being prepared
    await p.result({ id: b!, status: "ready", file: `${b}.mp3`, durationS: 200 });   // b finishes first; a is slow
    await p.beat({ ...beat, wantNext: true });                   // so b is handed out ahead of a
    const st = await p.adminState();
    const waiting = st.items.filter((i) => ["pending", "preparing", "ready", "queued"].includes(i.status)).map((i) => i.id);
    expect(waiting).toEqual([b, a]);
    expect((await p.adminAction({ action: "move", id: b, dir: 1 })).ok).toBe(true);
    const after = (await p.adminState()).items.filter((i) => ["pending", "preparing", "ready", "queued"].includes(i.status)).map((i) => i.id);
    expect(after).toEqual([a, b]);
  });

  it("a song moved out of the console stays out even if the console reports it pushed", async () => {
    const p = stub("move-race");
    const a = await readyItem(p, "Super Trouper");
    await readyItem(p, "Knowing Me, Knowing You", "d2");
    expect((await p.beat({ ...beat, wantNext: true })).next?.id).toBe(a);
    await p.adminAction({ action: "move", id: a, dir: 1 });   // admin moves it before the studio's next beat
    await p.beat({ ...beat, pushed: [a], queued: 1 });         // the studio had already pushed it
    const queued = (await p.adminState()).items.filter((i) => i.status === "queued");
    expect(queued.length).toBeLessThanOrEqual(1);
    expect(queued.map((i) => i.id)).not.toContain(a);
  });

  it("the studio can fail a song it could not push, and nothing else", async () => {
    const p = stub("result-rules");
    const id = await readyItem(p, "Ring Ring");
    await p.beat({ ...beat, wantNext: true });
    expect((await p.result({ id, status: "failed", error: "Song file unreadable" })).ok).toBe(true);
    const id2 = await readyItem(p, "Honey Honey", "d2");
    expect((await p.result({ id: id2, status: "playing" as "ready" })).ok).toBe(false);
  });

  it("settings take real true/false and numbers only", async () => {
    const p = stub("strict-settings");
    await p.adminAction({ action: "settings", settings: { somaOnly: "false" as unknown as boolean, breakEveryMin: null as unknown as number } });
    const s = (await p.adminState()).settings;
    expect(s.somaOnly).toBe(false);
    expect(s.breakEveryMin).toBe(10);
  });

  it("tells guests how many songs are waiting in all", async () => {
    const p = stub("waiting-count");
    for (let i = 0; i < 7; i++) await p.submit(`d${i}`, { track: T(`Song ${i}`), name: "x" });
    expect((await p.guestState("d0")).waitingCount).toBe(7);
  });

  it("carries the studio's year, album and Apple link to every phone", async () => {
    const p = stub("release-info");
    const { id } = await p.submit("d1", { track: T("Dreams", "Fleetwood Mac"), name: "x" });
    await p.beat({ ...beat, want: 1 });
    await p.result({ id: id!, status: "ready", file: `${id}.mp3`, durationS: 200, year: "1977", albumName: "Rumours",
                     appleUrl: "https://music.apple.com/us/album/dreams/1?i=7&app=music" });
    await p.beat({ ...beat, source: "requests", current: id!, remaining: 100 });
    const np = (await p.guestState("d9")).nowPlaying!;
    expect([np.year, np.album, np.apple]).toEqual(["1977", "Rumours", "https://music.apple.com/us/album/dreams/1?i=7&app=music"]);
    await p.beat({ ...beat, soma: { artist: "Ambrosia", title: "Holdin' On", since: 1, year: "1975", album: "Ambrosia",
                                    apple: "https://evil.example/x" } });
    const soma = (await p.guestState("d9")).nowPlaying!;
    expect(soma.year).toBe("1975");
    expect(soma.apple).toBe("");   // only Apple's own links
  });

  it("names with no visible characters are refused, and control characters stripped", async () => {
    expect(clean("​‍‮", 40)).toBe("");
    expect(clean("Ann\u0000‮ie", 40)).toBe("Annie");
    const p = stub("clean");
    expect((await p.submit("d1", { track: T("Voulez-Vous"), name: "​​" })).ok).toBe(false);
  });

  it("the rude-word check knows names from insults, and Cyrillic look-alikes", () => {
    for (const ok of ["Fagan", "Scunthorpe", "Matsushita", "What's New Pussycat", "snigger"]) expect(isOffensive(ok), ok).toBe(false);
    for (const bad of ["ѕhіthead", "bullshit", "f u c k", "Shithead Steve"]) expect(isOffensive(bad), bad).toBe(true);
  });

  it("queue positions never tie, however many first requests squeeze into one gap", async () => {
    const p = stub("rank-ties");
    await p.submit("a", { track: T("First A"), name: "a" });
    await p.submit("a", { track: T("Second A"), name: "a" });
    for (let i = 0; i < 60; i++) await p.submit(`n${i}`, { track: T(`New ${i}`), name: "n" });   // each lands between a's two
    const ranks = await runInDurableObject(p, async (_i: Party, state) =>
      state.storage.sql.exec("SELECT title, rank FROM items ORDER BY rank").toArray() as { title: string; rank: number }[]);
    expect(new Set(ranks.map((r) => r.rank)).size).toBe(62);
    expect(ranks[0].title).toBe("First A");
    expect(ranks[61].title).toBe("Second A");   // round robin intact: a's second song after everyone's first
  });

  it("resend joins the waiting copy instead of adding the song twice", async () => {
    const p = stub("resend-dupe");
    const id = await readyItem(p, "Hasta Mañana");
    await p.beat({ ...beat, source: "requests", current: id, remaining: 100 });
    await p.beat({ ...beat, source: "soma" });   // played
    await p.submit("d2", { track: T("Hasta Mañana"), name: "Bo" });   // a guest asks again
    await p.adminAction({ action: "resend", id });
    const st = await p.adminState();
    expect(st.items.filter((i) => i.title === "Hasta Mañana" && ["pending", "preparing", "ready"].includes(i.status))).toHaveLength(1);
  });

  it("admin state says the server's time, so 'minutes ago' ignores a wrong phone clock", async () => {
    const st = await stub("server-now").adminState();
    expect(Math.abs(st.serverNow - Date.now())).toBeLessThan(5000);
  });

  // ---- from the end-to-end simulation ----
  it("a beat that can't see the Pi ('silence') changes nothing and hands nothing out", async () => {
    const p = stub("silence");
    const a = await readyItem(p, "Waterloo");
    await readyItem(p, "SOS", "d2");
    await p.beat({ ...beat, source: "requests", current: a, remaining: 100 });   // a is on air
    const r = await p.beat({ ...beat, source: "silence", wantNext: true });
    expect(r.next).toBeNull();
    const st = await p.adminState();
    expect(st.items.find((i) => i.id === a)?.status).toBe("playing");
  });

  it("asking again while a song is handed out gets the same song, never a second one", async () => {
    const p = stub("repeat-handout");
    const a = await readyItem(p, "Fernando");
    await readyItem(p, "Chiquitita", "d2");
    const r1 = await p.beat({ ...beat, wantNext: true });
    const r2 = await p.beat({ ...beat, wantNext: true });   // the push didn't land: the studio asks again
    expect(r1.next?.id).toBe(a);
    expect(r2.next?.id).toBe(a);
    expect((await p.adminState()).items.filter((i) => i.status === "queued")).toHaveLength(1);
  });

  it("a song the Pi played while the studio was offline is marked played, not handed out again", async () => {
    const p = stub("played-offline");
    const x = await readyItem(p, "Mamma Mia");
    await p.beat({ ...beat, wantNext: true });
    await p.beat({ ...beat, pushed: [x], queued: 1 });
    await runInDurableObject(p, async (_i: Party, state) => {   // the outage: well past the 15 s grace
      state.storage.sql.exec("UPDATE items SET queued_at=?", Date.now() - 300_000);
    });
    const r = await p.beat({ ...beat, wantNext: true, recent: [{ id: x, agoS: 200 }] } as typeof beat);   // back on SomaFM; the Pi says x played
    expect(r.next?.id ?? null).not.toBe(x);
    expect((await p.adminState()).items.find((i) => i.id === x)?.status).toBe("played");
  });

  it("a resent song is not marked played by the Pi's memory of its first play", async () => {
    const p = stub("resent-not-played");
    const x = await readyItem(p, "Hasta Mañana");
    await p.beat({ ...beat, source: "requests", current: x, remaining: 100, recent: [{ id: x, agoS: 1 }] } as typeof beat);
    await p.beat({ ...beat, recent: [{ id: x, agoS: 200 }] } as typeof beat);   // it played and ended
    await p.adminAction({ action: "resend", id: x });
    const r = await p.beat({ ...beat, wantNext: true, recent: [{ id: x, agoS: 210 }] } as typeof beat);
    expect(r.next?.id).toBe(x);   // handed out again: the Pi's memory is from before
    await p.beat({ ...beat, wantNext: false, queued: 1, pushed: [x], recent: [{ id: x, agoS: 213 }] } as typeof beat);
    expect((await p.adminState()).items.find((i) => i.id === x)?.status).toBe("queued");
  });

  it("no song is handed out in the same reply as a clear", async () => {
    const p = stub("clear-then-next");
    const a = await readyItem(p, "Super Trouper");
    await readyItem(p, "Lay All Your Love On Me", "d2");
    await p.beat({ ...beat, wantNext: true });
    await p.adminAction({ action: "delete", id: a });   // queued -> clear
    const r = await p.beat({ ...beat, wantNext: true });
    expect(r.commands.map((c) => c.type)).toContain("clear");
    expect(r.next).toBeNull();
  });

  it("the same phone asking for the same song twice uses one slot", async () => {
    const p = stub("self-dupe");
    await p.submit("d1", { track: T("Dancing Queen"), name: "Ann" });
    const again = await p.submit("d1", { track: T("Dancing Queen"), name: "Ann" });
    expect(again.ok).toBe(true);
    expect((await p.submit("d1", { track: T("Waterloo"), name: "Ann" })).ok).toBe(true);   // second slot still free
    const st = await p.adminState();
    expect(st.items.find((i) => i.title === "Dancing Queen")!.requesters).toHaveLength(1);
  });

  it("asking for the song that is on air right now says so instead of queueing it again", async () => {
    const p = stub("on-air-dupe");
    const x = await readyItem(p, "Take a Chance on Me");
    await p.beat({ ...beat, source: "requests", current: x, remaining: 120 });
    const r = await p.submit("d2", { track: T("Take a Chance on Me"), name: "Bo" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/playing right now/i);
  });

  // ---- from the security review of the round-1 fixes ----
  it("compounds that start or carry a rude stem are still caught", () => {
    for (const bad of ["fuckyou", "bullshitter", "shitfaced", "fuckwit", "cuntface"]) expect(isOffensive(bad), bad).toBe(true);
    for (const ok of ["Pussycat", "What's New Pussycat", "Shitake Sam", "Fagan", "Scunthorpe", "Matsushita", "snigger", "niggle"]) expect(isOffensive(ok), ok).toBe(false);
  });

  it("a guest's album name goes through the same filter as titles before every phone sees it", async () => {
    const p = stub("album-filter");
    const { id } = await p.submit("d1", { track: { ...T("Waterloo"), album: "Shithead Hits" }, name: "Ann" });
    const st = await p.guestState("d9");
    expect(st.upNext.find((i) => i.id === id)!.album).toBe("");
  });

  it("slurs count anywhere in a word, with a few innocent exceptions (round 2)", () => {
    for (const bad of ["nigga", "niggas", "n1gga", "fagot", "pussies"]) expect(isOffensive(bad), bad).toBe(true);
    for (const ok of ["snigger", "niggle", "niggling", "Fagan", "Scunthorpe", "Pussycat"]) expect(isOffensive(ok), ok).toBe(false);
  });

  // ---- API round 2 ----
  it("there is no per-address waiting cap: a big family on one Wi-Fi can all queue", async () => {
    const p = stub("no-ip-cap");
    for (let i = 0; i < 45; i++)
      expect((await p.submit(`ph${i}`, { track: T(`Song ${i}`), name: "x" }, false, "203.0.113.9")).ok, `phone ${i}`).toBe(true);
  });

  it("stretched letters, split words and small-caps look-alikes are caught", () => {
    for (const bad of ["fuuuck", "shitt", "fu ck", "sh it", "ꜱʜɪᴛ"]) expect(isOffensive(bad), bad).toBe(true);
    for (const ok of ["As it is", "Fu Manchu", "Sheila", "Bossa Nova", "Ramblin' Man"]) expect(isOffensive(ok), ok).toBe(false);
  });

  it("joining while a song is being prepared re-prepares it at most once", async () => {
    const p = stub("one-redo");
    const { id } = await p.submit("d1", { track: T("Fernando"), name: "a" });
    for (let round = 0; round < 3; round++) {
      await p.beat({ ...beat, want: 1 });
      await p.submit(`j${round}`, { track: T("Fernando"), name: `j${round}` });   // someone joins mid-preparation
      await p.result({ id: id!, status: "ready", file: `${id}.mp3`, durationS: 200 });
    }
    expect((await p.adminState()).items.find((i) => i.id === id)?.status).toBe("ready");
  });

  it("names made of invisible filler characters are refused", async () => {
    const p = stub("filler-names");
    for (const name of ["\u3164\u3164", "\u2800\u2800", "\u0301\u0301", "\ufe0f"])
      expect((await p.submit("d1", { track: T("SOS"), name }, true)).ok, JSON.stringify(name)).toBe(false);
  });

  it("emoji-only and punctuation-only titles are different songs", () => {
    expect(songKey("ABBA", "🎉🎉")).not.toBe(songKey("ABBA", "💃💃"));
    expect(songKey("ABBA", "!!!")).not.toBe(songKey("ABBA", "???"));
  });

  it("odd ages from the Pi never mark a song played", async () => {
    const p = stub("odd-ago");
    const x = await readyItem(p, "Chiquitita");
    await p.beat({ ...beat, wantNext: true });
    for (const agoS of [null, "", [], -50] as unknown[])
      await p.beat({ ...beat, queued: 1, recent: [{ id: x, agoS }] } as typeof beat);
    expect((await p.adminState()).items.find((i) => i.id === x)?.status).toBe("queued");
  });

  it("Apple links with a login or a port are not passed on", async () => {
    const p = stub("apple-strict");
    const { id } = await p.submit("d1", { track: T("Dreams", "Fleetwood Mac"), name: "x" });
    await p.beat({ ...beat, want: 1 });
    await p.result({ id: id!, status: "ready", file: "x.mp3", durationS: 200, year: "1977", appleUrl: "https://u:p@music.apple.com/x" });
    expect((await p.guestState("d1")).mine[0].apple).toBe("");
    await p.beat({ ...beat, soma: { artist: "A", title: "B", since: 1, apple: "https://music.apple.com:444/x" } });
    expect((await p.guestState("d1")).nowPlaying!.apple).toBe("");
  });

  // ---- admin round 2 ----
  it("tapping Resend twice doesn't add the same people again", async () => {
    const p = stub("resend-twice");
    const id = await readyItem(p, "Hasta Mañana");
    await p.beat({ ...beat, source: "requests", current: id, remaining: 100 });
    await p.beat({ ...beat, source: "soma" });
    await p.submit("d2", { track: T("Hasta Mañana"), name: "Two" });
    for (let i = 0; i < 3; i++) await p.adminAction({ action: "resend", id });
    const waiting = (await p.adminState()).items.find((i) => i.title === "Hasta Mañana" && i.status === "pending")!;
    expect(waiting.requesters.map((r) => r.name).sort()).toEqual(["Two", "x"]);
  });

  it("two admin phones skipping the same song send one skip", async () => {
    const p = stub("two-admins");
    const id = await readyItem(p, "Mamma Mia");
    await p.beat({ ...beat, source: "requests", current: id, remaining: 100 });
    await p.adminAction({ action: "skip" });
    await p.adminAction({ action: "skip" });
    const r = await p.beat({ ...beat, source: "requests", current: id, remaining: 100 });
    expect(r.commands.filter((c) => c.type === "skip")).toHaveLength(1);
  });
});
