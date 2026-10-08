// The one Durable Object ("party"): queue, settings, studio beats, admin actions.
import { DurableObject } from "cloudflare:workers";
import { clean, displayText, isOffensive, namesPhrase, rankForNew, safeArtwork, songKey, swapRanks, visible, type Waiting } from "./queue";
import type { Track } from "./search";

const WAITING = "('pending','preparing','ready','queued')";
const LEASE_MS = 120_000;
const OFFLINE_MS = 60_000;
// Names and messages are wiped after the party: Tuesday 2026-10-13 noon UTC, a fixed date, so
// the wipe can't land mid-party (it used to be "3 days after the first request", i.e. Sunday).
const PURGE_AT = Date.UTC(2026, 9, 13, 12);
const PURGE_AFTER_MS = 3 * 24 * 3600_000;   // only once that date has passed (code reused for another party)
const COMMAND_TTL_MS = 20_000;   // a command the studio didn't pick up by then is dropped, not fired late
const APPLE_HOSTS = ["music.apple.com"];
const MAX_WAITING_PER_DEVICE = 2;
const QUEUED_GRACE_MS = 15_000;

type Row = Record<string, SqlStorageValue>;
export type SubmitIn = { track: Track; name: string; message?: string; freeText?: boolean };
export type Beat = {
  source: string; current: string; remaining: number; queued: number;
  pushed: string[]; working: string[]; want: number; ack: number[]; error: string;
  wantNext?: boolean;   // the studio is ready to push a song right now
  wantJokes?: number;   // jokes the studio can write and record now
  jokesPlayed?: string[];   // jokes told on air (sent until the Worker has them; marking played twice is harmless)
  recent?: { id: string; agoS: number }[];   // requests the Pi actually started, and how long ago (it may have played them while the studio was offline)
  // SomaFM's current song (its public feed), with the studio's Apple lookup for the guests' record sleeve
  soma?: { artist: string; title: string; since: number; artwork?: string; year?: string; album?: string; apple?: string } | null;
};
export type Result = {
  id: string; status: "ready" | "failed"; file?: string; durationS?: number; confidence?: number;
  djLine?: string; tone?: string; voice?: string; error?: string; matchNote?: string;
  year?: string; albumName?: string; appleUrl?: string; artworkUrl?: string;   // release info looked up by the studio
};

/** Only Apple's own https links go on guests' phones. */
function appleLink(url: unknown): string {
  try {
    const u = new URL(String(url ?? ""));
    return u.protocol === "https:" && APPLE_HOSTS.includes(u.hostname) && !u.username && !u.password && !u.port ? u.href : "";
  } catch {
    return "";
  }
}
const year = (y: unknown) => (/^(19|20)\d\d$/.test(String(y ?? "")) ? String(y) : "");

export class Party extends DurableObject<Env> {
  sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS items(
        id TEXT PRIMARY KEY, song_key TEXT NOT NULL, title TEXT NOT NULL, artist TEXT NOT NULL,
        album TEXT, duration_ms INTEGER, artwork TEXT, explicit INTEGER DEFAULT 0,
        free_text INTEGER DEFAULT 0, status TEXT NOT NULL, rank REAL NOT NULL,
        created_at INTEGER NOT NULL, lease_until INTEGER DEFAULT 0, redo INTEGER DEFAULT 0,
        file TEXT, duration_s REAL, confidence REAL, dj_line TEXT, tone TEXT, voice TEXT,
        error TEXT, played_at INTEGER, queued_at INTEGER DEFAULT 0, match_note TEXT);
      CREATE TABLE IF NOT EXISTS requesters(
        id INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT NOT NULL, device TEXT NOT NULL,
        name TEXT NOT NULL, message TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS muted(device TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS jokes(
        id TEXT PRIMARY KEY, device TEXT NOT NULL, name TEXT NOT NULL, text TEXT NOT NULL,
        status TEXT NOT NULL, created_at INTEGER NOT NULL, lease_until INTEGER DEFAULT 0,
        file TEXT, seconds REAL, script TEXT, played_at INTEGER, ip TEXT);
      CREATE TABLE IF NOT EXISTS commands(
        id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, done INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL);`);
    for (const [table, col] of [["items", "queued_at INTEGER DEFAULT 0"], ["items", "match_note TEXT"], ["items", "year TEXT"],
                                ["items", "apple_url TEXT"], ["requesters", "ip TEXT"], ["commands", "target TEXT"], ["items", "redos INTEGER DEFAULT 0"],
                                ["items", "started_at INTEGER DEFAULT 0"], ["items", "cuts INTEGER DEFAULT 0"]]) {
      try {
        this.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${col}`);
      } catch {
        // column already exists
      }
    }
  }

  // ---------- helpers ----------
  private all(q: string, ...b: SqlStorageValue[]): Row[] {
    return this.sql.exec(q, ...b).toArray() as Row[];
  }
  private one(q: string, ...b: SqlStorageValue[]): Row | undefined {
    return this.all(q, ...b)[0];
  }
  private setting(key: string, dflt: string): string {
    return String(this.one("SELECT value FROM settings WHERE key=?", key)?.value ?? dflt);
  }
  private set(key: string, value: string): void {
    this.sql.exec("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, value);
  }
  private flags() {
    return {
      accepting: this.setting("accepting", "1") === "1",
      stopAfterCurrent: this.setting("stopAfterCurrent", "0") === "1",
      somaOnly: this.setting("somaOnly", "0") === "1",
      breakEveryMin: Number(this.setting("breakEveryMin", "10")),
    };
  }
  private command(type: "skip" | "clear" | "break" | "replay" | `pad${number}`, target: string | null = null): void {
    this.sql.exec("INSERT INTO commands(type,created_at,target) VALUES(?,?,?)", type, Date.now(), target);
  }
  /** A skip names the song it was meant for: by the time the studio sees it, that song may be gone. */
  private skip(): void {
    const playing = this.one("SELECT id FROM items WHERE status='playing' LIMIT 1");
    const target = playing ? String(playing.id) : null;
    // two admin phones skipping the same song: one skip
    if (target && this.one("SELECT 1 AS s FROM commands WHERE type='skip' AND done=0 AND target=?", target)) return;
    this.command("skip", target);
  }
  /** Ranks 1, 2, 3… in the current order: run when a gap between neighbours gets too small to halve. */
  private renumber(): void {
    this.ordered().forEach((w, i) => this.sql.exec("UPDATE items SET rank=? WHERE id=?", i + 1, w.id));
  }
  private newId(): string {
    // A new queue (QUEUE_VERSION bump) starts from the clock, not 1: the Pi may still be playing
    // the old queue's r1, and a new r1 would share its files and be marked played when it ends.
    const n = Number(this.setting("seq", String(100_000 + (Math.floor(Date.now() / 1000) % 800_000) * 1000))) + 1;
    this.set("seq", String(n));
    return `r${n}`;
  }
  private health(): Row & { at: number } {
    return JSON.parse(this.setting("health", '{"at":0}'));
  }
  private ordered(): Waiting[] {
    return this.all(`SELECT i.id, i.rank,
        (SELECT device FROM requesters r WHERE r.item_id=i.id ORDER BY r.id LIMIT 1) AS device
      FROM items i WHERE i.status IN ${WAITING} ORDER BY i.rank`)
      .map((r) => ({ id: String(r.id), rank: Number(r.rank), device: String(r.device) }));
  }
  private display(): Row[] {
    return this.all(`SELECT * FROM items WHERE status IN ${WAITING}
      ORDER BY CASE status WHEN 'queued' THEN 0 ELSE 1 END, rank`);
  }
  private requesters(id: string): Row[] {
    return this.all("SELECT device,name,message FROM requesters WHERE item_id=? ORDER BY id", id);
  }
  private pub(i: Row) {
    const names = [...new Set(this.requesters(String(i.id)).map((r) => displayText(String(r.name), "a guest")))];
    const hidden = displayText(`${i.title} ${i.artist}`, "") === "";
    return { id: String(i.id), title: hidden ? "A request" : String(i.title),
             artist: hidden ? "" : String(i.artist), artwork: hidden ? "" : String(i.artwork ?? ""), names: namesPhrase(names),
             // the album can be guest-typed: filtered like titles before every phone sees it
             year: hidden ? "" : year(i.year), album: hidden ? "" : displayText(String(i.album ?? ""), ""),
             apple: hidden ? "" : appleLink(i.apple_url) };
  }
  private studioItem(i: Row) {
    return {
      id: String(i.id), songKey: String(i.song_key), title: String(i.title), artist: String(i.artist),
      album: String(i.album ?? ""), durationMs: i.duration_ms == null ? null : Number(i.duration_ms),
      freeText: Boolean(i.free_text),
      requesters: this.requesters(String(i.id)).map((r) => ({ name: String(r.name), message: String(r.message) })),
    };
  }

  // ---------- guests ----------
  async submit(device: string, s: SubmitIn, asAdmin = false, ip = "") {
    if (!asAdmin && !this.flags().accepting) return { ok: false, error: "Requests are closed for tonight." };
    if (!asAdmin && this.one("SELECT 1 AS m FROM muted WHERE device=?", device))
      return { ok: false, error: "Requests are paused for this phone." };
    const name = clean(s.name, 40), message = clean(s.message ?? "", 280);
    const title = clean(s.track?.title, 200), artist = clean(s.track?.artist, 200);
    if (!visible(name)) return { ok: false, error: "Add your name (letters, not just emoji)." };
    if (!title) return { ok: false, error: "Add the song title." };
    if (!artist) return { ok: false, error: "Add the artist, or your best guess." };
    if (!asAdmin) {
      const n = Number(this.one(`SELECT COUNT(*) AS n FROM requesters r JOIN items i ON i.id=r.item_id
        WHERE r.device=? AND i.status IN ${WAITING}`, device)?.n ?? 0);
      if (n >= MAX_WAITING_PER_DEVICE)
        return { ok: false, error: "You have 2 songs waiting. Once one plays, add another!" };
    }
    const key = songKey(artist, title);
    const now = Date.now();
    if (this.one("SELECT 1 AS p FROM items WHERE song_key=? AND status='playing'", key))
      return { ok: false, error: "That one is playing right now! Pick another?" };
    const dup = this.one(`SELECT id,status FROM items WHERE song_key=? AND status IN ${WAITING} ORDER BY rank LIMIT 1`, key);
    let id: string, late = false;
    if (dup) {
      id = String(dup.id);
      if (this.one("SELECT 1 AS m FROM requesters WHERE item_id=? AND device=?", id, device))   // asked twice: one slot
        return { ok: true, id, position: this.display().findIndex((i) => i.id === id) + 1 };
      // still being prepared: once more, so the DJ names everyone. Already ready: just join it
      // (re-preparing a ready song on every join kept popular songs off the air).
      // at most once per song: a join every cycle could otherwise keep it from ever finishing
      if (dup.status === "preparing") this.sql.exec("UPDATE items SET redo=1 WHERE id=? AND COALESCE(redos,0)<1", id);
      // its DJ line is already recorded: say so, rather than let them wait for a shout-out that won't come
      late = dup.status === "ready" || dup.status === "queued";
    } else {
      id = this.newId();
      const t = s.track;
      let rank = rankForNew(this.ordered(), device);
      if (this.one("SELECT 1 AS x FROM items WHERE rank=? AND status IN " + WAITING, rank)) {   // the gap ran out
        this.renumber();
        rank = rankForNew(this.ordered(), device);
      }
      const ms = Number(t?.durationMs);
      this.sql.exec(`INSERT INTO items(id,song_key,title,artist,album,duration_ms,artwork,explicit,free_text,status,rank,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,'pending',?,?)`, id, key, title, artist, clean(t?.album ?? "", 200),
        Number.isFinite(ms) && ms > 0 && ms < 3_600_000 ? Math.round(ms) : null, safeArtwork(t?.artwork),
        t?.explicit === true ? 1 : 0, s.freeText === true ? 1 : 0, rank, now);
    }
    this.sql.exec("INSERT INTO requesters(item_id,device,name,message,created_at,ip) VALUES(?,?,?,?,?,?)",
      id, device, name, message, now, ip);
    if ((await this.ctx.storage.getAlarm()) === null)
      await this.ctx.storage.setAlarm(now < PURGE_AT ? PURGE_AT : now + PURGE_AFTER_MS);
    return { ok: true, id, position: this.display().findIndex((i) => i.id === id) + 1, ...(late ? { late } : {}) };
  }

  /** Never used: no songs, no names, not even a setting (the studio's first check-in writes one). */
  async isFresh() {
    return !this.one("SELECT 1 AS x FROM settings LIMIT 1") && !this.one("SELECT 1 AS x FROM items LIMIT 1")
      && !this.one("SELECT 1 AS x FROM requesters LIMIT 1");
  }

  /** Everything a successor queue needs (a QUEUE_VERSION bump): songs, their order and files,
   *  requesters and messages, play history, muted phones, settings. Commands are left behind (stale). */
  async exportState() {
    const table = (t: string) => this.all(`SELECT * FROM ${t}`);
    return { items: table("items"), requesters: table("requesters"), settings: table("settings"), muted: table("muted"), jokes: table("jokes") };
  }

  /** Takes over an old queue's state, once, and only into an empty queue (ids are kept, so the
   *  console's song on air and every phone's "Your requests" still match). */
  async importState(data: { items?: Row[]; requesters?: Row[]; settings?: Row[]; muted?: Row[]; jokes?: Row[] }) {
    if (this.one("SELECT 1 AS x FROM items LIMIT 1") || this.one("SELECT 1 AS x FROM requesters LIMIT 1"))
      return { ok: false, error: "this queue isn't empty" };
    let n = 0;
    for (const t of ["items", "requesters", "settings", "muted", "jokes"] as const) {
      const cols = new Set(this.all(`PRAGMA table_info(${t})`).map((c) => String(c.name)));
      for (const row of Array.isArray(data?.[t]) ? data[t]! : []) {
        const keys = Object.keys(row).filter((k) => cols.has(k));   // only columns this schema has
        if (!keys.length) continue;
        this.sql.exec(`INSERT OR REPLACE INTO ${t}(${keys.join(",")}) VALUES(${keys.map(() => "?").join(",")})`,
          ...keys.map((k) => row[k] as SqlStorageValue));
        n++;
      }
    }
    if (n && (await this.ctx.storage.getAlarm()) === null) {
      const now = Date.now();
      await this.ctx.storage.setAlarm(now < PURGE_AT ? PURGE_AT : now + PURGE_AFTER_MS);
    }
    return { ok: true, rows: n };
  }

  /** A guest's joke for the DJ to read on air: written up and recorded by the studio, told as a break. */
  async submitJoke(device: string, j: { name?: unknown; text?: unknown }, ip = "") {
    if (!this.flags().accepting) return { ok: false, error: "The DJ isn't taking jokes right now." };
    if (this.one("SELECT 1 AS m FROM muted WHERE device=?", device)) return { ok: false, error: "Requests are paused for this phone." };
    const name = clean(j?.name, 40), text = clean(j?.text, 400);
    if (!visible(name)) return { ok: false, error: "Add your name (letters, not just emoji)." };
    if (text.replace(/[^\p{L}\p{N}]/gu, "").length < 8) return { ok: false, error: "Type out the joke." };
    if (isOffensive(text) || isOffensive(name)) return { ok: false, error: "The DJ can't read that one on air." };
    const waiting = Number(this.one("SELECT COUNT(*) AS n FROM jokes WHERE device=? AND status IN ('pending','preparing','ready')", device)?.n ?? 0);
    if (waiting >= 2) return { ok: false, error: "You have 2 jokes waiting. Once one is told, send another!" };
    const id = "j" + this.newId().slice(1);
    this.sql.exec("INSERT INTO jokes(id,device,name,text,status,created_at,ip) VALUES(?,?,?,?, 'pending', ?, ?)", id, device, name, text, Date.now(), ip);
    if ((await this.ctx.storage.getAlarm()) === null) {
      const now = Date.now();
      await this.ctx.storage.setAlarm(now < PURGE_AT ? PURGE_AT : now + PURGE_AFTER_MS);
    }
    return { ok: true, id };
  }

  /** The studio's answer for a joke: recorded (ready), declined by the DJ (rejected), or failed. */
  async jokeResult(r: { id: string; status: string; file?: string; seconds?: number; script?: string }) {
    const status = r?.status === "ready" ? "ready" : r?.status === "rejected" ? "rejected" : r?.status === "failed" ? "failed" : "";
    if (!status) return { ok: false };
    const secs = Number(r.seconds);
    this.sql.exec(`UPDATE jokes SET status=?, file=?, seconds=?, script=?, lease_until=0 WHERE id=? AND status IN ('preparing','pending')`,
      status, status === "ready" ? String(r.file ?? "") : null, Number.isFinite(secs) ? secs : null, clean(r.script ?? "", 1000), String(r.id));
    return { ok: true };
  }

  /** A guest takes back their own request before it plays. A song others asked for too keeps going
   *  without their name; one only they asked for is removed (and pulled from the console if handed out). */
  async cancel(device: string, id: string) {
    const it = this.one("SELECT status FROM items WHERE id=?", String(id ?? ""));
    if (!it || !this.one("SELECT 1 AS m FROM requesters WHERE item_id=? AND device=?", id, device))
      return { ok: false, error: "That request isn't yours to cancel." };
    if (!["pending", "preparing", "ready", "queued"].includes(String(it.status)))
      return { ok: false, error: it.status === "playing" ? "It's already on air!" : "That one is done already." };
    this.sql.exec("DELETE FROM requesters WHERE item_id=? AND device=?", id, device);
    if (!this.one("SELECT 1 AS r FROM requesters WHERE item_id=?", id)) {
      this.sql.exec("UPDATE items SET status='deleted' WHERE id=?", id);
      if (it.status === "queued") this.command("clear");
    }
    return { ok: true };
  }

  private nowPlaying() {
    const playing = this.one("SELECT * FROM items WHERE status='playing' LIMIT 1");
    const h = this.health() as unknown as Beat & { at: number };
    if (playing) {
      // the countdown: what the console last reported, aged by the time since that beat
      const timed = h.source === "requests" && h.current === playing.id && typeof h.remaining === "number" && h.remaining >= 0;
      const durationS = Number(playing.duration_s) > 0 ? Math.round(Number(playing.duration_s)) : null;
      return { ...this.pub(playing), djLine: String(playing.dj_line ?? ""), durationS,
               endsInS: timed ? Math.max(0, Math.round((h.remaining - (Date.now() - h.at) / 1000) * 10) / 10) : null };
    }
    if (h.soma && h.source !== "requests")
      return { id: "soma", title: String(h.soma.title), artist: String(h.soma.artist),
               artwork: safeArtwork(h.soma.artwork), names: "", soma: true,
               year: year(h.soma.year), album: clean(h.soma.album ?? "", 200), apple: appleLink(h.soma.apple) };
    return null;
  }

  /** Songs with the waiting jokes worked in, one in front of each song, in the order they'll be told
   *  (a joke goes at a song change, so the next one is told before the next song). */
  private lineup<T>(songs: T[]): (T | { joke: true; id: string; title: string; artist: string; names: string })[] {
    const jokes = this.all("SELECT id, name FROM jokes WHERE status IN ('ready','preparing','pending') ORDER BY created_at")
      .map((j) => ({ joke: true as const, id: String(j.id), title: "A joke", artist: "",
                     names: displayText(String(j.name), "a guest") }));
    const out: (T | (typeof jokes)[number])[] = [];
    songs.forEach((song, i) => { if (jokes[i]) out.push(jokes[i]); out.push(song); });
    return [...out, ...jokes.slice(songs.length)];
  }

  async guestState(device: string) {
    const waiting = this.display();
    // newest of this phone's own asks first (joining an older song puts it at the top too)
    const mine = this.all(`SELECT i.*, MAX(r.created_at) AS mine_at FROM items i JOIN requesters r ON r.item_id=i.id
      WHERE r.device=? GROUP BY i.id ORDER BY mine_at DESC LIMIT 6`, device);
    return {
      nowPlaying: this.nowPlaying(),
      upNext: this.lineup(waiting.slice(0, 6).map((i) => this.pub(i))),
      waitingCount: waiting.length,
      mine: mine.map((i) => ({ ...this.pub(i), status: String(i.status),
        position: waiting.findIndex((w) => w.id === i.id) + 1 || null })),
      accepting: this.flags().accepting,
      myJokes: this.all("SELECT id, text, status FROM jokes WHERE device=? AND status<>'deleted' ORDER BY created_at DESC LIMIT 3", device)
        .map((j) => ({ id: String(j.id), text: String(j.text), status: String(j.status) })),
      djOnBreak: Date.now() - this.health().at > OFFLINE_MS,
    };
  }

  // ---------- studio ----------
  async beat(b: Beat) {
    const now = Date.now();
    this.set("health", JSON.stringify({ ...b, at: now }));
    for (const c of b.ack ?? []) this.sql.exec("UPDATE commands SET done=1 WHERE id=?", c);
    for (const id of b.working ?? []) {
      this.sql.exec("UPDATE items SET lease_until=? WHERE id=? AND status='preparing'", now + LEASE_MS, id);
      this.sql.exec("UPDATE jokes SET lease_until=? WHERE id=? AND status='preparing'", now + LEASE_MS, id);
    }
    this.sql.exec("UPDATE jokes SET status='pending', lease_until=0 WHERE status='preparing' AND lease_until<?", now);
    for (const id of Array.isArray(b.jokesPlayed) ? b.jokesPlayed : [])
      this.sql.exec("UPDATE jokes SET status='played', played_at=? WHERE id=? AND status='ready'", now, String(id));
    const jokeJobs = this.all("SELECT id, name, text FROM jokes WHERE status='pending' ORDER BY created_at LIMIT ?",
      Math.max(0, Math.min(2, Number(b.wantJokes) || 0))).map((j) => {
      this.sql.exec("UPDATE jokes SET status='preparing', lease_until=? WHERE id=?", now + LEASE_MS, j.id);
      return { id: String(j.id), name: String(j.name), text: String(j.text) };
    });
    const nj = this.one("SELECT id, file, seconds, script FROM jokes WHERE status='ready' ORDER BY created_at LIMIT 1");
    const nextJoke = nj ? { id: String(nj.id), file: String(nj.file), seconds: Number(nj.seconds), script: String(nj.script ?? "") } : null;
    this.sql.exec("UPDATE items SET status='pending', lease_until=0 WHERE status='preparing' AND lease_until<?", now);
    // "silence": the studio couldn't reach the Pi, so this beat says nothing about what's playing.
    // Change no song's state and hand nothing out (that marked the on-air song played and handed a
    // second song out); preparation carries on.
    const unknown = b.source === "silence";
    if (!unknown) this.followStation(b, now);
    const jobs = [];
    for (const i of this.all(`SELECT * FROM items WHERE status='pending' ORDER BY rank LIMIT ?`, Math.max(0, b.want ?? 0))) {
      this.sql.exec("UPDATE items SET status='preparing', lease_until=?, redo=0 WHERE id=?", now + LEASE_MS, i.id);
      jobs.push(this.studioItem(i));
    }
    const f = this.flags();
    // Commands the studio missed while offline are dropped, not fired all at once on its return;
    // a skip meant for a song that's no longer on air is dropped too.
    // A clear is exempt: emptying the console late is always safe, and losing it plays a deleted song.
    this.sql.exec("UPDATE commands SET done=1 WHERE done=0 AND type<>'clear' AND created_at<?", now - COMMAND_TTL_MS);
    if (!unknown)
      for (const c of this.all("SELECT id, target FROM commands WHERE done=0 AND type='skip' AND target IS NOT NULL"))
        if (!(b.source === "requests" && b.current === c.target)) this.sql.exec("UPDATE commands SET done=1 WHERE id=?", c.id);
    const commands = unknown ? [] : this.all("SELECT id,type,target FROM commands WHERE done=0 ORDER BY id")
      .map((c) => ({ id: Number(c.id), type: String(c.type), ...(c.target ? { target: String(c.target) } : {}) }));
    // Hand out the next song only when the studio will push it now, never alongside a clear (the
    // studio clears and pushes nothing that beat), and mark it queued at once so a delete, move or
    // duplicate in the next few seconds sees it as "in the console". Asking again while one is
    // already handed out gets that same one (the push didn't land), never a second.
    let next: Row | undefined;
    if (b.wantNext && !unknown && !f.somaOnly && !f.stopAfterCurrent && !commands.some((c) => c.type === "clear")) {
      next = this.one("SELECT * FROM items WHERE status='queued' AND id<>? ORDER BY rank LIMIT 1", b.current ?? "");
      if (!next) {
        next = this.one("SELECT * FROM items WHERE status='ready' ORDER BY rank LIMIT 1");
        if (next) {   // first in line by rank too, so ▲▼ act on the order the screen shows
          const first = Number(this.one(`SELECT MIN(rank) AS r FROM items WHERE status IN ${WAITING}`)?.r ?? 1);
          this.sql.exec("UPDATE items SET status='queued', queued_at=?, rank=MIN(rank, ?) WHERE id=?", now, first - 1, next.id);
        }
      }
    }
    return {
      commands,
      settings: { somaOnly: f.somaOnly, stopAfterCurrent: f.stopAfterCurrent, breakEveryMin: f.breakEveryMin },
      next: next ? this.studioItem(next) : null,
      jobs,
      jokeJobs,
      nextJoke,   // the oldest recorded joke: the studio plays it as the next break
    };
  }

  /** Bring song states in line with what the console reports it is doing. */
  private followStation(b: Beat, now: number): void {
    // Songs the Pi started since they were handed out are played, even if the studio never saw them
    // (it was offline): otherwise the grace rule below would hand them out and they'd play twice.
    for (const r of Array.isArray(b.recent) ? b.recent : []) {
      if (typeof r?.agoS !== "number" || !Number.isFinite(r.agoS) || r.agoS < 0) continue;   // only a real age counts
      const started = now - r.agoS * 1000;
      if (typeof r?.id !== "string" || r.id === b.current) continue;
      this.sql.exec(`UPDATE items SET status='played', played_at=? WHERE id=? AND status IN ('queued','ready','playing')
        AND queued_at>0 AND queued_at<=?`, now, r.id, started);
    }
    for (const id of b.pushed ?? []) {
      // a song the admin moved or cleared out of the console after it was handed out stays out,
      // even if the studio pushed it in the meantime (the clear empties the console anyway)
      const it = this.one("SELECT status, queued_at FROM items WHERE id=?", id);
      if (it?.status === "ready" && this.one("SELECT 1 AS c FROM commands WHERE type='clear' AND created_at>=?", Number(it.queued_at ?? 0)))
        continue;
      this.sql.exec("UPDATE items SET status='queued', queued_at=? WHERE id=? AND status IN ('ready','queued')", now, id);
    }
    // the song that was on air and isn't any more: done, unless it was cut off (endPlaying)
    for (const it of this.all("SELECT id, started_at, duration_s, cuts FROM items WHERE status='playing' AND id<>?",
                              b.source === "requests" ? (b.current ?? "") : ""))
      this.endPlaying(it, now);
    if (b.source === "requests" && b.current) {
      this.sql.exec("UPDATE items SET status='playing', started_at=? WHERE id=? AND status IN ('queued','ready')", now, b.current);
      // a song deleted after it was handed out started anyway (the clear came too late): skip it, once
      if (this.one("SELECT 1 AS d FROM items WHERE id=? AND status='deleted'", b.current)
          && !this.one("SELECT 1 AS s FROM commands WHERE type='skip' AND target=?", b.current))
        this.command("skip", b.current);
    }

    // The station holds nothing, yet an item is marked queued and was not just pushed:
    // the station restarted, a push failed, or a clear dropped it. Put it back in line.
    if ((b.queued ?? 0) === 0) {
      for (const q of this.all("SELECT id FROM items WHERE status='queued' AND queued_at<?", now - QUEUED_GRACE_MS)) {
        if (q.id !== b.current && !(b.pushed ?? []).includes(String(q.id)))
          this.sql.exec("UPDATE items SET status='ready' WHERE id=?", q.id);
      }
    }
  }

  /** A song leaves the air. Cut off early with no skip (the Pi restarted, or lost its file): back to
   *  the front of the line to play again from the start, once. Otherwise it's played. */
  private endPlaying(it: Row, now: number): void {
    const started = Number(it.started_at ?? 0), length = Number(it.duration_s ?? 0);
    const skipped = this.one("SELECT 1 AS s FROM commands WHERE type='skip' AND (target=? OR target IS NULL) AND created_at>=?",
      it.id, started - 5000);
    const early = started > 0 && length > 0 && now - started < length * 1000 * 0.8;
    if (early && !skipped && Number(it.cuts ?? 0) < 1) {
      const first = Number(this.one(`SELECT MIN(rank) AS r FROM items WHERE status IN ${WAITING}`)?.r ?? 1);
      this.sql.exec("UPDATE items SET status='ready', rank=?, queued_at=0, started_at=0, cuts=COALESCE(cuts,0)+1 WHERE id=?",
        first - 1, it.id);
      return;
    }
    this.sql.exec("UPDATE items SET status='played', played_at=? WHERE id=?", now, it.id);
  }

  async result(r: Result) {
    if (!r || (r.status !== "ready" && r.status !== "failed")) return { ok: false };
    const item = this.one("SELECT status,redo FROM items WHERE id=?", r.id);
    if (item && r.status === "failed" && (item.status === "queued" || item.status === "ready")) {
      // the studio couldn't push it (file unreadable): fail it rather than hand it out forever
      this.sql.exec("UPDATE items SET status='failed', error=? WHERE id=?", clean(r.error ?? "Song file unreadable", 300), r.id);
      return { ok: true };
    }
    if (!item || item.status !== "preparing") return { ok: false };
    if (r.status === "ready" && item.redo) {
      this.sql.exec("UPDATE items SET status='pending', redo=0, redos=COALESCE(redos,0)+1, lease_until=0 WHERE id=?", r.id);
      return { ok: true, redo: true };
    }
    this.sql.exec(`UPDATE items SET status=?, file=?, duration_s=?, confidence=?, dj_line=?, tone=?,
      voice=?, error=?, match_note=?, lease_until=0 WHERE id=?`, r.status, r.file ?? null, r.durationS ?? null,
      r.confidence ?? null, r.djLine ?? null, r.tone ?? null, r.voice ?? null, r.error ?? null,
      r.matchNote ?? null, r.id);
    if (r.status === "ready") {   // the studio's Apple lookup: for every phone's record sleeve
      this.sql.exec(`UPDATE items SET year=?, apple_url=?, album=CASE WHEN COALESCE(album,'')='' THEN ? ELSE album END,
        artwork=CASE WHEN COALESCE(artwork,'')='' THEN ? ELSE artwork END WHERE id=?`,
        year(r.year), appleLink(r.appleUrl), clean(r.albumName ?? "", 200), safeArtwork(r.artworkUrl), r.id);
    }
    return { ok: true };
  }

  // ---------- admin ----------
  async adminState() {
    const h = this.health();
    const items = [
      ...this.all("SELECT * FROM items WHERE status='playing'"),
      ...this.display(),
      ...this.all("SELECT * FROM items WHERE status IN ('failed','played') ORDER BY COALESCE(played_at,created_at) DESC LIMIT 15"),
    ];
    const muted = this.all("SELECT device FROM muted ORDER BY device").map((m) => ({
      device: String(m.device),
      names: [...new Set(this.all("SELECT name FROM requesters WHERE device=? ORDER BY id DESC LIMIT 5", m.device)
        .map((r) => String(r.name)))],
    }));
    return {
      nowPlaying: this.nowPlaying(),
      muted,
      health: { ...h, ageS: h.at ? Math.round((Date.now() - h.at) / 1000) : null },
      serverNow: Date.now(),   // "N min ago" is worked out against this, not the phone's clock
      code: "jokes-2",          // read back after a deploy: proves the queue runs this code (no bump needed)
      settings: this.flags(),
      jokes: this.all("SELECT * FROM jokes WHERE status<>'deleted' ORDER BY CASE WHEN status IN ('pending','preparing','ready') THEN 0 ELSE 1 END, created_at DESC LIMIT 20")
        .map((j) => ({ id: String(j.id), name: String(j.name), text: String(j.text), status: String(j.status),
                       script: String(j.script ?? ""), device: String(j.device), createdAt: Number(j.created_at) })),
      items: items.map((i) => ({
        id: String(i.id), title: String(i.title), artist: String(i.artist), status: String(i.status),
        confidence: i.confidence == null ? null : Number(i.confidence), djLine: i.dj_line, tone: i.tone,
        voice: i.voice, error: i.error, matchNote: i.match_note ?? null, freeText: Boolean(i.free_text), explicit: Boolean(i.explicit),
        requesters: this.requesters(String(i.id)),
      })),
    };
  }

  async adminAction(a: {
    action: string; id?: string; dir?: -1 | 1; device?: string; pad?: number; track?: Track; name?: string;
    message?: string; settings?: Partial<Record<"accepting" | "stopAfterCurrent" | "somaOnly", boolean>> & { breakEveryMin?: number };
  }) {
    const status = a.id ? String(this.one("SELECT status FROM items WHERE id=?", a.id)?.status ?? "") : "";
    switch (a.action) {
      case "skip":
        this.skip();
        return { ok: true };
      case "break":
        this.command("break");
        return { ok: true };
      case "pad": {   // a sound pad, 1 to 5: played on the console's fx channel
        const n = typeof a.pad === "number" ? a.pad : NaN;
        if (!Number.isInteger(n) || n < 1 || n > 5) return { ok: false, error: "no such pad" };
        this.command(`pad${n}`);
        return { ok: true };
      }
      case "deleteJoke":
        if (!this.one("SELECT 1 AS j FROM jokes WHERE id=? AND status IN ('pending','preparing','ready')", String(a.id ?? "")))
          return { ok: false, error: "no such joke waiting" };
        this.sql.exec("UPDATE jokes SET status='deleted' WHERE id=?", String(a.id));
        return { ok: true };
      case "replay":   // the DJ read of the song on air, over the PA again
        if (status !== "playing") return { ok: false, error: "Only the song on air can be replayed." };
        this.command("replay", a.id!);
        return { ok: true };
      case "delete":
        if (!status) return { ok: false, error: "no such request" };
        if (status === "playing") this.skip();   // before the status changes: the skip names this song
        this.sql.exec("UPDATE items SET status='deleted' WHERE id=?", a.id!);
        if (status === "queued") this.command("clear");
        return { ok: true };
      case "move": {
        const pairs = swapRanks(this.ordered(), a.id!, a.dir === -1 ? -1 : 1);
        if (!pairs.length) return { ok: false, error: "can't move that one" };
        for (const [id, rank] of pairs) {
          this.sql.exec("UPDATE items SET rank=? WHERE id=?", rank, id);
          if (this.one("SELECT 1 AS q FROM items WHERE id=? AND status='queued'", id)) {
            this.sql.exec("UPDATE items SET status='ready' WHERE id=?", id);
            this.command("clear");
          }
        }
        return { ok: true };
      }
      case "resend": {
        // A played song's files still exist: back to ready at the end of the line.
        // A failed one goes back to pending so the studio tries again.
        // If the song is already waiting (a guest asked again), its requesters join that copy.
        const old = this.one("SELECT song_key FROM items WHERE id=?", a.id!);
        if (!old) return { ok: false, error: "no such request" };
        const waitingCopy = this.one(`SELECT id FROM items WHERE song_key=? AND status IN ${WAITING} AND id<>?`, old.song_key, a.id!);
        if (waitingCopy) {
          this.sql.exec(`INSERT INTO requesters(item_id,device,name,message,created_at,ip)
            SELECT ?,device,name,message,created_at,ip FROM requesters WHERE item_id=?
              AND device NOT IN (SELECT device FROM requesters WHERE item_id=?)`, waitingCopy.id, a.id!, waitingCopy.id);
          return { ok: true, merged: String(waitingCopy.id) };
        }
        const last = Number(this.one(`SELECT MAX(rank) AS r FROM items WHERE status IN ${WAITING}`)?.r ?? 0);
        this.sql.exec(`UPDATE items SET status=CASE WHEN file IS NOT NULL AND status='played' THEN 'ready' ELSE 'pending' END,
          rank=?, played_at=NULL, error=NULL, queued_at=0 WHERE id=? AND status IN ('played','failed','deleted')`, last + 1, a.id!);
        return { ok: true };
      }
      case "retry":
        this.sql.exec("UPDATE items SET status='pending', error=NULL WHERE id=? AND status='failed'", a.id!);
        return { ok: true };
      case "add":
        return this.submit("admin", { track: a.track!, name: a.name ?? "", message: a.message ?? "" }, true);
      case "mute": {
        if (typeof a.device !== "string" || !a.device) return { ok: false, error: "no such phone" };
        this.sql.exec("INSERT OR IGNORE INTO muted(device) VALUES(?)", a.device);
        const solo = `SELECT item_id FROM requesters GROUP BY item_id HAVING COUNT(*)=1 AND MAX(device)=?`;
        const inConsole = this.one(`SELECT 1 AS q FROM items WHERE status='queued' AND id IN (${solo})`, a.device);
        this.sql.exec(`UPDATE items SET status='deleted' WHERE status IN ('pending','preparing','ready','queued')
          AND id IN (${solo})`, a.device);
        if (inConsole) this.command("clear");   // its song was already handed to the console
        this.sql.exec("UPDATE jokes SET status='deleted' WHERE device=? AND status IN ('pending','preparing','ready')", a.device);
        return { ok: true };
      }
      case "unmute":
        this.sql.exec("DELETE FROM muted WHERE device=?", a.device!);
        return { ok: true };
      case "settings":
        for (const [k, v] of Object.entries(a.settings ?? {})) {   // real true/false only: "false" is not true
          if (["accepting", "stopAfterCurrent", "somaOnly"].includes(k) && typeof v === "boolean") this.set(k, v ? "1" : "0");
        }
        const every = a.settings?.breakEveryMin;
        if (typeof every === "number" && Number.isFinite(every))
          this.set("breakEveryMin", String(Math.min(30, Math.max(5, Math.round(every / 5) * 5))));
        if (a.settings?.somaOnly === true || a.settings?.stopAfterCurrent === true) {
          this.command("clear");
          this.sql.exec("UPDATE items SET status='ready' WHERE status='queued'");
        }
        return { ok: true };
    }
    return { ok: false, error: "unknown action" };
  }

  // Names and messages are personal data: wiped after the party (PURGE_AT).
  async alarm() {
    this.sql.exec("DELETE FROM requesters");
    this.sql.exec("UPDATE items SET dj_line=NULL");
  }
}
