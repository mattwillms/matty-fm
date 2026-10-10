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
    await runInDurableObject(p, async (_i: Party, state) => {   // it played to the end (not cut off)
      state.storage.sql.exec("UPDATE items SET started_at=? WHERE id=?", Date.now() - 200_000, id);
    });
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
  it("a clear waits for the studio however long it is gone", async () => {
    const p = stub("clear-late");
    const id = await readyItem(p, "Voulez-Vous");
    await p.beat({ ...beat, wantNext: true });
    await p.beat({ ...beat, pushed: [id], queued: 1 });   // in the Pi's queue
    await p.adminAction({ action: "delete", id });
    await runInDurableObject(p, async (_i: Party, state) => {
      state.storage.sql.exec("UPDATE commands SET created_at=?", Date.now() - 120_000);   // studio away 2 min
    });
    expect((await p.beat({ ...beat, queued: 1 })).commands.map((c) => c.type)).toContain("clear");
  });

  it("a deleted song that starts anyway is skipped, once", async () => {
    const p = stub("deleted-plays");
    const id = await readyItem(p, "Gimme Gimme");
    await p.beat({ ...beat, wantNext: true });
    await p.adminAction({ action: "delete", id });
    await p.beat({ ...beat, queued: 1 });                 // the clear goes out, too late: the song started
    const on = { ...beat, source: "requests", current: id, remaining: 150 };
    const r1 = await p.beat(on);
    expect(r1.commands.filter((c) => c.type === "skip")).toHaveLength(1);
    const r2 = await p.beat({ ...on, ack: r1.commands.map((c) => c.id) });
    expect(r2.commands.filter((c) => c.type === "skip")).toHaveLength(0);   // still fading out: no second skip
  });
  it("replaying the DJ read names the song on air, and only that song", async () => {
    const p = stub("replay");
    const id = await readyItem(p, "Super Trouper");
    expect((await p.adminAction({ action: "replay", id })).ok).toBe(false);   // not on air yet
    await p.beat({ ...beat, source: "requests", current: id, remaining: 150 });
    expect((await p.adminAction({ action: "replay", id })).ok).toBe(true);
    const r = await p.beat({ ...beat, source: "requests", current: id, remaining: 140 });
    expect(r.commands.filter((c) => c.type === "replay")).toEqual([expect.objectContaining({ target: id })]);
  });
  it("tells the guest which field is missing", async () => {
    const p = stub("which-field");
    expect((await p.submit("d1", { track: T("SOS", ""), name: "Ann" })).error).toMatch(/artist/i);
    expect((await p.submit("d1", { track: T("", "ABBA"), name: "Ann" })).error).toMatch(/title/i);
    expect((await p.submit("d1", { track: T("SOS"), name: "🎉🎉" })).error).toMatch(/name/i);
  });

  it("a guest who joins a song that's already lined up is told the DJ may not read their message", async () => {
    const p = stub("late-join");
    const id = await readyItem(p, "Chiquitita");
    const r = await p.submit("d2", { track: T("Chiquitita"), name: "Bev", message: "Happy anniversary!" });
    expect(r.ok && r.late).toBe(true);
    const { id: fresh } = await p.submit("d3", { track: T("Andante, Andante"), name: "Cy" });
    expect(fresh).not.toBe(id);
    expect((await p.submit("d4", { track: T("Andante, Andante"), name: "Di" })).late).toBeFalsy();   // still pending: it's re-done
  });

  it("Your requests lists the songs this phone asked for most recently", async () => {
    const p = stub("mine-order");
    const { id: old } = await p.submit("other", { track: T("Waterloo"), name: "x" });
    for (const t of ["A1", "A2", "A3", "A4", "A5", "A6"]) {
      const { id } = await p.submit("me", { track: T(t), name: "Me" });
      await runInDurableObject(p, async (_i: Party, state) => { state.storage.sql.exec("UPDATE items SET status='played' WHERE id=?", id!); });
    }
    await p.submit("me", { track: T("Waterloo"), name: "Me" });   // joins an older song
    expect((await p.guestState("me")).mine[0].id).toBe(old);
  });

  it("& and \"and\" are the same song", () => {
    expect(songKey("Kool & The Gang", "Celebration")).toBe(songKey("Kool and the Gang", "Celebration"));
    expect(songKey("Simon & Garfunkel", "Cecilia")).toBe("simon garfunkel|cecilia");
    expect(songKey("Band", "Sandman")).toBe("band|sandman");   // only the whole word
  });
  it("a new queue doesn't reuse the old queue's request ids (the Pi may still be playing one)", async () => {
    const p = stub("fresh-ids");
    const { id: a } = await p.submit("d1", { track: T("Lay All Your Love On Me"), name: "x" });
    const { id: b } = await p.submit("d2", { track: T("The Name of the Game"), name: "y" });
    expect(a).toMatch(/^r\d{6,}$/);
    expect(Number(b!.slice(1))).toBe(Number(a!.slice(1)) + 1);
  });
  it("a guest can cancel their own waiting request; a shared song just loses their name", async () => {
    const p = stub("cancel");
    const { id: solo } = await p.submit("me", { track: T("Fernando"), name: "Me" });
    const { id: shared } = await p.submit("me", { track: T("Honey, Honey"), name: "Me" });
    await p.submit("them", { track: T("Honey, Honey"), name: "Them" });
    expect((await p.cancel("them", solo!)).ok).toBe(false);          // not theirs
    expect((await p.cancel("me", solo!)).ok).toBe(true);
    expect((await p.cancel("me", shared!)).ok).toBe(true);
    const st = await p.adminState();
    expect(st.items.find((i) => i.id === solo)?.status ?? "deleted").toBe("deleted");
    expect(st.items.find((i) => i.id === shared)!.requesters.map((r) => r.name)).toEqual(["Them"]);
    expect((await p.submit("me", { track: T("Mamma Mia"), name: "Me" })).ok).toBe(true);   // slots freed
    expect((await p.submit("me", { track: T("Dancing Queen"), name: "Me" })).ok).toBe(true);
  });

  it("cancelling a song already handed to the Pi pulls it back; one on air can't be cancelled", async () => {
    const p = stub("cancel-queued");
    const id = await readyItem(p, "Knowing Me, Knowing You", "me");
    await p.beat({ ...beat, wantNext: true });                      // handed out: queued
    expect((await p.cancel("me", id)).ok).toBe(true);
    expect((await p.beat(beat)).commands.map((c) => c.type)).toContain("clear");
    const id2 = await readyItem(p, "Take a Chance on Me", "me");
    await p.beat({ ...beat, source: "requests", current: id2, remaining: 100 });
    expect((await p.cancel("me", id2)).ok).toBe(false);
  });

  it("now playing carries the time left and the song's length for the countdown", async () => {
    const p = stub("countdown");
    const id = await readyItem(p, "Summer Night City");
    await p.beat({ ...beat, source: "requests", current: id, remaining: 150 });
    const np = (await p.guestState("x")).nowPlaying as { endsInS?: number; durationS?: number };
    expect(np.durationS).toBe(200);
    expect(np.endsInS).toBeGreaterThan(148);
    expect(np.endsInS).toBeLessThanOrEqual(150);
  });
  it("a new queue takes over everything from the old one: songs, order, names, history, settings", async () => {
    const old = stub("migrate-old"), fresh = stub("migrate-new");
    const id = await readyItem(old, "Waterloo", "me");
    await old.submit("me", { track: T("SOS"), name: "Me", message: "for Bob" });
    await old.submit("you", { track: T("Fernando"), name: "You" });
    await old.beat({ ...beat, source: "requests", current: id, remaining: 100 });
    await old.adminAction({ action: "mute", device: "troll" });
    await old.adminAction({ action: "settings", settings: { breakEveryMin: 20 } });
    const before = await old.adminState();
    expect((await fresh.importState(await old.exportState())).ok).toBe(true);
    const after = await fresh.adminState();
    expect(after.items.map((i) => [i.id, i.status, i.requesters.map((r) => r.name + ":" + r.message)]))
      .toEqual(before.items.map((i) => [i.id, i.status, i.requesters.map((r) => r.name + ":" + r.message)]));
    expect(after.settings.breakEveryMin).toBe(20);
    expect(after.muted.map((m) => m.device)).toEqual(["troll"]);
    expect((await fresh.guestState("me")).mine.length).toBe(2);
    const { id: next } = await fresh.submit("d9", { track: T("Ring Ring"), name: "x" });
    expect(Number(next!.slice(1))).toBeGreaterThan(Math.max(...before.items.map((i) => Number(i.id.slice(1)))));
    expect((await fresh.importState(await old.exportState())).ok).toBe(false);   // only ever into an empty queue
  });
  it("only a never-used queue counts as fresh (an empty one in use never takes over old songs)", async () => {
    const p = stub("fresh-check");
    expect(await p.isFresh()).toBe(true);
    await p.beat(beat);                      // the studio checked in: in use, though empty
    expect(await p.isFresh()).toBe(false);
  });
  it("a song cut off by a Pi restart (no skip) goes back to the front and plays again", async () => {
    const p = stub("cut-off");
    const id = await readyItem(p, "Gimme! Gimme! Gimme!");
    const other = await readyItem(p, "Money, Money, Money", "d2");
    await p.beat({ ...beat, source: "requests", current: id, remaining: 150 });
    await p.beat({ ...beat, source: "soma" });                      // the Pi restarted: back on SomaFM
    const st = await p.adminState();
    expect(st.items.find((i) => i.id === id)!.status).toBe("ready");
    const r = await p.beat({ ...beat, wantNext: true });
    expect(r.next?.id).toBe(id);                                    // first in line, before the other
    expect(other).not.toBe(id);
  });

  it("a skipped song, or one that played nearly to the end, is done", async () => {
    const p = stub("cut-vs-skip");
    const a = await readyItem(p, "Lovers (Live a Little Longer)");
    await p.beat({ ...beat, source: "requests", current: a, remaining: 150 });
    await p.adminAction({ action: "skip" });
    await p.beat({ ...beat, source: "soma" });
    const b = await readyItem(p, "Hasta Mañana", "d2");
    await p.beat({ ...beat, source: "requests", current: b, remaining: 10 });
    await runInDurableObject(p, async (_i: Party, state) => {
      state.storage.sql.exec("UPDATE items SET started_at=? WHERE id=?", Date.now() - 190_000, b);   // 190 of 200 s
    });
    await p.beat({ ...beat, source: "soma" });
    const st = await p.adminState();
    expect(st.items.find((i) => i.id === a)!.status).toBe("played");
    expect(st.items.find((i) => i.id === b)!.status).toBe("played");
  });

  it("a song cut off twice is let go (a file that keeps failing can't loop)", async () => {
    const p = stub("cut-twice");
    const id = await readyItem(p, "So Long");
    for (let i = 0; i < 2; i++) {
      await p.beat({ ...beat, source: "requests", current: id, remaining: 150 });
      await p.beat({ ...beat, source: "soma" });
    }
    expect((await p.adminState()).items.find((i) => i.id === id)!.status).toBe("played");
  });
  it("a guest's joke goes to the studio, comes back recorded, is offered until played, then is done", async () => {
    const p = stub("jokes");
    const sent = await p.submitJoke("me", { name: "Uncle Ray", text: "Why did the scarecrow win an award? He was outstanding in his field." });
    expect(sent.ok).toBe(true);
    const r1 = await p.beat({ ...beat, wantJokes: 1 });
    expect(r1.jokeJobs.map((j) => j.text)).toEqual(["Why did the scarecrow win an award? He was outstanding in his field."]);
    expect((await p.guestState("me")).myJokes[0].status).toBe("preparing");
    await p.jokeResult({ id: sent.id!, status: "ready", file: `joke-${sent.id}.mp3`, seconds: 12.5, script: "Uncle Ray sent this one in." });
    const r2 = await p.beat(beat);
    expect(r2.nextJoke).toEqual(expect.objectContaining({ id: sent.id, file: `joke-${sent.id}.mp3`, seconds: 12.5 }));
    const r3 = await p.beat({ ...beat, jokesPlayed: [sent.id!] });
    expect(r3.nextJoke).toBeNull();
    expect((await p.guestState("me")).myJokes[0].status).toBe("played");
    expect((await p.adminState()).jokes[0]).toEqual(expect.objectContaining({ name: "Uncle Ray", status: "played" }));
  });

  it("jokes: a declined one tells the guest; slurs, empty text, muted phones and a second waiting joke are refused", async () => {
    const p = stub("jokes-refused");
    const { id } = await p.submitJoke("me", { name: "Ann", text: "Knock knock. Who's there? Lettuce." });
    await p.beat({ ...beat, wantJokes: 1 });
    await p.jokeResult({ id: id!, status: "rejected" });
    expect((await p.guestState("me")).myJokes[0].status).toBe("rejected");
    expect((await p.submitJoke("me", { name: "Ann", text: "  " })).ok).toBe(false);
    expect((await p.submitJoke("me", { name: "", text: "A real joke here" })).ok).toBe(false);
    expect((await p.submitJoke("me", { name: "Ann", text: "you fucking idiot" })).ok).toBe(false);
    expect((await p.submitJoke("me", { name: "Ann", text: "Joke one, a long enough one." })).ok).toBe(true);
    expect((await p.submitJoke("me", { name: "Ann", text: "Joke two, a long enough one." })).ok).toBe(false);   // one regular waiting at a time
    expect((await p.submitJoke("me", { name: "Ann", text: "Joke three, a long enough one." })).ok).toBe(false);
    await p.adminAction({ action: "mute", device: "troll" });
    expect((await p.submitJoke("troll", { name: "T", text: "A real joke here" })).ok).toBe(false);
  });

  it("the admin can remove a joke before it's told; a lapsed lease hands it out again", async () => {
    const p = stub("jokes-admin");
    const { id } = await p.submitJoke("me", { name: "Ann", text: "What do you call a fish with no eyes? A fsh." });
    await p.beat({ ...beat, wantJokes: 1 });
    await runInDurableObject(p, async (_i: Party, state) => { state.storage.sql.exec("UPDATE jokes SET lease_until=1"); });
    expect((await p.beat({ ...beat, wantJokes: 1 })).jokeJobs.length).toBe(1);   // the studio lost it: again
    expect((await p.adminAction({ action: "deleteJoke", id })).ok).toBe(true);
    await p.jokeResult({ id: id!, status: "ready", file: "j.mp3", seconds: 9, script: "x" });
    expect((await p.beat(beat)).nextJoke).toBeNull();
  });
  it("waiting jokes show in Up next, one in front of each song, in the order they'll be told", async () => {
    const p = stub("jokes-upnext");
    await p.submit("a", { track: T("Voulez-Vous"), name: "A" });
    await p.submit("b", { track: T("Eagle"), name: "B" });
    await p.submitJoke("m", { name: "Matt", text: "Why did the chicken cross the road? Worms." });
    await p.submitJoke("n", { name: "Nan", text: "What do you call a sleeping bull? A bulldozer." });
    const up = (await p.guestState("x")).upNext as { joke?: boolean; title: string; names: string }[];
    expect(up.map((u) => (u.joke ? `joke:${u.names}` : u.title))).toEqual(["joke:Matt", "Voulez-Vous", "joke:Nan", "Eagle"]);
    expect((await p.guestState("x")).waitingCount).toBe(2);   // songs only
  });
  it("announcements: urgent ones go first, then regular announcements, then jokes; one urgent per phone per hour", async () => {
    const p = stub("announce");
    const j = await p.submitJoke("me", { name: "Ray", text: "Why did the chicken cross the road? Worms." });
    const a = await p.submitJoke("you", { name: "Ann", text: "Cake is on the back table at 3 o'clock.", kind: "announcement" });
    const u = await p.submitJoke("you", { name: "Ann", text: "Whoever owns the red truck, your lights are on.", kind: "announcement", urgent: true });
    expect([j.ok, a.ok, u.ok]).toEqual([true, true, true]);
    const r = await p.beat({ ...beat, wantJokes: 2 });
    expect(r.jokeJobs[0]).toEqual(expect.objectContaining({ id: u.id, kind: "announcement", urgent: true }));
    expect((await p.submitJoke("you", { name: "Ann", text: "Another urgent thing to say here.", kind: "announcement", urgent: true })).ok).toBe(false);
    for (const x of [j, a, u]) await p.jokeResult({ id: x.id!, status: "ready", file: `${x.id}.mp3`, seconds: 8, script: "x" });
    expect((await p.beat(beat)).nextJoke).toEqual(expect.objectContaining({ id: u.id, urgent: true, kind: "announcement" }));
    const up = (await p.guestState("x")).upNext as { joke?: boolean; title: string }[];
    expect(up.map((x) => x.title)).toEqual(["An urgent announcement", "An announcement", "A joke"]);
  });

  it("the host's announcements are always urgent and need no phone", async () => {
    const p = stub("announce-host");
    expect((await p.adminAction({ action: "announce", text: "Fish is ready! Come and get it." })).ok).toBe(true);
    expect((await p.adminAction({ action: "announce", text: "" })).ok).toBe(false);
    const r = await p.beat({ ...beat, wantJokes: 1 });
    expect(r.jokeJobs[0]).toEqual(expect.objectContaining({ kind: "announcement", urgent: true, source: "host" }));
  });
  it("one urgent guest announcement per 10 minutes for the whole party (cheap phone ids can't spam it)", async () => {
    const p = stub("urgent-global");
    expect((await p.submitJoke("a", { name: "A", text: "Red truck lights are on outside.", kind: "announcement", urgent: true })).ok).toBe(true);
    expect((await p.submitJoke("b", { name: "B", text: "Blue truck lights are on outside.", kind: "announcement", urgent: true })).ok).toBe(false);
    expect((await p.submitJoke("b", { name: "B", text: "Blue truck lights are on outside.", kind: "announcement" })).ok).toBe(true);
    expect((await p.adminAction({ action: "announce", text: "The host can always announce." })).ok).toBe(true);
  });
  it("Played is one timeline in the order things happened: songs, bumpers, jokes, failures included", async () => {
    const p = stub("timeline");
    const t0 = Date.now();
    const a = await readyItem(p, "Waterloo");
    await p.beat({ ...beat, source: "requests", current: a, remaining: 150 });
    await runInDurableObject(p, async (_i: Party, state) => { state.storage.sql.exec("UPDATE items SET started_at=? WHERE id=?", t0 - 300_000, a); });
    await p.beat({ ...beat, source: "soma" });                    // the song ends...
    await new Promise((r) => setTimeout(r, 5));
    const ident = { kind: "id", text: "You're tuned to OrrFM.", at: Date.now() };
    await p.beat({ ...beat, source: "soma", aired: [ident] });   // ...then a station ID plays
    await new Promise((r) => setTimeout(r, 5));
    const { id: j } = await p.submitJoke("m", { name: "Matt", text: "This is two tents, a pun." });
    await p.beat({ ...beat, wantJokes: 1 });
    await p.jokeResult({ id: j!, status: "rejected" });
    await new Promise((r) => setTimeout(r, 5));
    const { id: b } = await p.submit("d2", { track: T("SOS"), name: "x" });
    await p.beat({ ...beat, want: 1 });
    await p.result({ id: b!, status: "failed", error: "nope" });
    await p.beat({ ...beat, aired: [ident] });   // the studio re-sends until acked: counted once
    const h = (await p.adminState()).history.map((e) => `${e.type}:${e.status ?? e.kind}`);
    expect(h).toEqual(["song:failed", "joke:rejected", "break:id", "song:played"]);   // newest first
  });
  it("the beat lists the messages still alive, so the studio can take a deleted one off a queued song", async () => {
    const p = stub("live-jokes");
    const { id } = await p.submitJoke("m", { name: "Matt", text: "Why did the chicken cross the road? Worms." });
    expect((await p.beat({ ...beat, wantJokes: 1 })).liveJokes).toEqual([id]);
    await p.adminAction({ action: "deleteJoke", id });
    expect((await p.beat(beat)).liveJokes).toEqual([]);
  });
});
