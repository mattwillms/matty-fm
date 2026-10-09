// The one Durable Object ("party"): queue, settings, studio beats, admin actions.
import { DurableObject } from "cloudflare:workers";
import { clean, displayText, isOffensive, namesPhrase, rankForNew, safeArtwork, songKey, swapRanks, visible, type Waiting } from "./queue";
import type { Track } from "./search";

const HEAVY_ROWS = 500;   // rows one query may read before it is logged
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
const MAX_ASKS_PER_SONG = 2;
const PAD_EVERY_MS = 60_000;   // a guest's preset buttons: one sound a minute per phone
const PAD_GAP_MS = 5_000;      // and one at a time for the whole party, so thirty phones can't make a wall of noise
const MYSTERY = "a mystery guest";   // who an anonymous message is from, on air and on the guest page   // a phone may ask for a song, and once more after it plays ("Request again")
const QUEUED_GRACE_MS = 15_000;

type Row = Record<string, SqlStorageValue>;
export type SubmitIn = { track: Track; name: string; message?: string; freeText?: boolean };
export type Beat = {
  source: string; current: string; remaining: number; queued: number;
  pushed: string[]; working: string[]; want: number; ack: number[]; error: string;
  wantNext?: boolean;   // the studio is ready to push a song right now
  wantJokes?: number;   // jokes the studio can write and record now
  jokesPlayed?: string[];
  aired?: { kind: string; text?: string; at: number }[];   // bumpers and back-announces played, for the admin's timeline   // jokes told on air (sent until the Worker has them; marking played twice is harmless)
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
      CREATE TABLE IF NOT EXISTS song_locks(device TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS song_release(device TEXT PRIMARY KEY, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS pad_presses(device TEXT NOT NULL, pad INTEGER NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS airlog(kind TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(kind, at));
      CREATE TABLE IF NOT EXISTS jokes(
        id TEXT PRIMARY KEY, device TEXT NOT NULL, name TEXT NOT NULL, text TEXT NOT NULL,
        status TEXT NOT NULL, created_at INTEGER NOT NULL, lease_until INTEGER DEFAULT 0,
        file TEXT, seconds REAL, script TEXT, played_at INTEGER, ip TEXT);
      CREATE TABLE IF NOT EXISTS commands(
        id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, done INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL);`);
    for (const [table, col] of [["items", "queued_at INTEGER DEFAULT 0"], ["items", "match_note TEXT"], ["items", "year TEXT"],
                                ["items", "apple_url TEXT"], ["requesters", "ip TEXT"], ["commands", "target TEXT"], ["items", "redos INTEGER DEFAULT 0"],
                                ["items", "started_at INTEGER DEFAULT 0"], ["items", "cuts INTEGER DEFAULT 0"],
                                ["jokes", "kind TEXT DEFAULT 'joke'"], ["jokes", "urgent INTEGER DEFAULT 0"],
                                ["jokes", "source TEXT DEFAULT 'guest'"],
                                ["items", "ended_at INTEGER"], ["items", "skipped INTEGER DEFAULT 0"], ["jokes", "ended_at INTEGER"],
                                ["jokes", "anon INTEGER DEFAULT 0"]]) {
      try {
        this.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${col}`);
      } catch {
        // column already exists
      }
    }
    // Cloudflare bills every row a query looks at, and the beat and the admin page poll every 3 s:
    // without these, each poll scanned whole tables (64,000 rows per admin poll on a full queue)
    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS requesters_item ON requesters(item_id);
      CREATE INDEX IF NOT EXISTS requesters_device ON requesters(device);
      CREATE INDEX IF NOT EXISTS items_status ON items(status, rank);
      CREATE INDEX IF NOT EXISTS items_key ON items(song_key);
      CREATE INDEX IF NOT EXISTS items_ended ON items(ended_at);
      CREATE INDEX IF NOT EXISTS jokes_status ON jokes(status, urgent, created_at);
      CREATE INDEX IF NOT EXISTS jokes_device ON jokes(device, created_at);
      CREATE INDEX IF NOT EXISTS jokes_ended ON jokes(ended_at);
      CREATE INDEX IF NOT EXISTS jokes_urgent ON jokes(urgent, created_at);
      CREATE INDEX IF NOT EXISTS airlog_at ON airlog(at);
      CREATE INDEX IF NOT EXISTS commands_open ON commands(done, type);
      CREATE INDEX IF NOT EXISTS pad_device ON pad_presses(device, at);
      CREATE INDEX IF NOT EXISTS pad_at ON pad_presses(at);`);
  }

  // ---------- helpers ----------
  private all(q: string, ...b: SqlStorageValue[]): Row[] {
    const c = this.sql.exec(q, ...b), rows = c.toArray() as Row[];
    // every row a query looks at is billed: a scan this big means a missing index (Workers Logs keeps it)
    if (c.rowsRead > HEAVY_ROWS) console.log(`heavy query: ${c.rowsRead} rows read: ${q.replace(/\s+/g, " ").slice(0, 120)}`);
    return rows;
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
      freePlay: this.setting("freePlay", "0") === "1",   // no per-phone limits on songs or messages
      familyMode: this.setting("familyMode", "1") === "1",   // clean songs only, a family-friendly DJ (off: PG-13)
      stationOff: this.setting("stationOff", "0") === "1",   // the Pi fades to silence and stops streaming altogether
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
    if (!asAdmin && s.track?.explicit === true && this.flags().familyMode)
      return { ok: false, error: "Family mode is on: pick the clean version." };
    if (!asAdmin && !this.flags().freePlay) {
      const lim = this.songLimit(device);
      if (lim.locked)
        return { ok: false, error: lim.active === 1 ? "Your other song plays first. Then you can pick two more!"
                                                    : "You have 2 songs coming up. Once both play, pick two more!" };
    }
    const key = songKey(artist, title);
    const now = Date.now();
    if (!asAdmin && !this.flags().freePlay && this.asks(device, key) >= MAX_ASKS_PER_SONG
        && !this.one(`SELECT 1 AS m FROM requesters r JOIN items i ON i.id=r.item_id WHERE r.device=? AND i.song_key=?
                      AND i.status IN ${WAITING}`, device, key))   // asking again for one already waiting is harmless
      return { ok: false, error: "You've asked for this one twice tonight." };
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
    if (!asAdmin && this.songLimit(device).active >= MAX_WAITING_PER_DEVICE)   // both slots used: none again until both play
      this.sql.exec("INSERT OR IGNORE INTO song_locks(device) VALUES(?)", device);
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
    return { items: table("items"), requesters: table("requesters"), settings: table("settings"), muted: table("muted"), jokes: table("jokes"), airlog: table("airlog"), song_locks: table("song_locks"), song_release: table("song_release") };
  }

  /** Takes over an old queue's state, once, and only into an empty queue (ids are kept, so the
   *  console's song on air and every phone's "Your requests" still match). */
  async importState(data: { items?: Row[]; requesters?: Row[]; settings?: Row[]; muted?: Row[]; jokes?: Row[]; airlog?: Row[]; song_locks?: Row[]; song_release?: Row[] }) {
    if (this.one("SELECT 1 AS x FROM items LIMIT 1") || this.one("SELECT 1 AS x FROM requesters LIMIT 1"))
      return { ok: false, error: "this queue isn't empty" };
    let n = 0;
    for (const t of ["items", "requesters", "settings", "muted", "jokes", "airlog", "song_locks", "song_release"] as const) {
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
  async submitJoke(device: string, j: { name?: unknown; text?: unknown; kind?: unknown; urgent?: unknown; anon?: unknown }, ip = "") {
    const kind = j?.kind === "announcement" ? "announcement" : "joke";
    const urgent = kind === "announcement" && j?.urgent === true;
    const anon = j?.anon === true;   // read on air as "a mystery guest"; the host still sees the name and phone
    if (anon && urgent) return { ok: false, error: "An urgent one can't be anonymous." };
    if (!this.flags().accepting) return { ok: false, error: "The DJ isn't taking jokes right now." };
    if (this.one("SELECT 1 AS m FROM muted WHERE device=?", device)) return { ok: false, error: "Requests are paused for this phone." };
    const name = clean(j?.name, 40), text = clean(j?.text, 400);
    if (!visible(name)) return { ok: false, error: "Add your name (letters, not just emoji)." };
    if (text.replace(/[^\p{L}\p{N}]/gu, "").length < 8) return { ok: false, error: kind === "joke" ? "Type out the joke." : "Type out the announcement." };
    if (isOffensive(text) || isOffensive(name)) return { ok: false, error: "The DJ can't read that one on air." };
    if (!this.flags().freePlay) {
      const lim = this.messageLimit(device);
      if (!urgent && lim.waiting)
        return { ok: false, error: "Yours is still waiting to be read." };
      if (urgent && lim.urgentInS)
        return { ok: false, error: `One urgent an hour: the next one in ${Math.ceil(lim.urgentInS / 60)} min.` };
      // and one urgent guest announcement per 10 minutes for the whole party: a new phone id is cheap,
      // so the per-phone limit alone would let one person keep cutting into the music
      if (urgent && lim.partyUrgentInS)
        return { ok: false, error: "An urgent one just went out. Send it as regular?" };
      if (anon && !lim.anonLeft)
        return { ok: false, error: "You've used your anonymous one tonight." };
    }
    const id = "j" + this.newId().slice(1);
    this.sql.exec("INSERT INTO jokes(id,device,name,text,status,created_at,ip,kind,urgent,source,anon) VALUES(?,?,?,?, 'pending', ?, ?, ?, ?, 'guest', ?)",
      id, device, name, text, Date.now(), ip, kind, urgent ? 1 : 0, anon ? 1 : 0);
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
    this.sql.exec(`UPDATE jokes SET status=?, file=?, seconds=?, script=?, lease_until=0, ended_at=? WHERE id=? AND status IN ('preparing','pending')`,
      status, status === "ready" ? String(r.file ?? "") : null, Number.isFinite(secs) ? secs : null, clean(r.script ?? "", 1000),
      status === "ready" ? null : Date.now(), String(r.id));
    return { ok: true };
  }

  /** A guest presses one of the radio's preset buttons: the matching sound pad plays on the PA. */
  async guestPad(device: string, pad: unknown) {
    const n = typeof pad === "number" ? pad : NaN;
    if (!Number.isInteger(n) || n < 1 || n > 5) return { ok: false, error: "No such button." };
    if (this.one("SELECT 1 AS m FROM muted WHERE device=?", device)) return { ok: false, error: "Requests are paused for this phone." };
    if (!this.flags().freePlay) {
      const lim = this.padLimit(device);
      if (lim.padInS) return { ok: false, error: `One sound a minute: the next in ${lim.padInS} s.` };
      if (lim.partyPadInS) return { ok: false, error: "Someone just pressed one. Try again." };
    }
    const now = Date.now();
    this.sql.exec("INSERT INTO pad_presses(device, pad, at) VALUES(?,?,?)", device, n, now);
    this.sql.exec("DELETE FROM pad_presses WHERE at<?", now - PAD_EVERY_MS);   // only the last minute matters
    this.command(`pad${n}`);
    return { ok: true };
  }

  private padLimit(device: string) {
    const now = Date.now(), left = (t: number, ms: number) => Math.max(0, Math.ceil((t + ms - now) / 1000));
    const mine = Number(this.one("SELECT MAX(at) AS t FROM pad_presses WHERE device=?", device)?.t ?? 0);
    const party = Number(this.one("SELECT MAX(at) AS t FROM pad_presses")?.t ?? 0);
    return { padInS: mine ? left(mine, PAD_EVERY_MS) : 0, partyPadInS: party ? left(party, PAD_GAP_MS) : 0 };
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
    this.sql.exec("DELETE FROM song_locks WHERE device=?", device);   // a cancel gives the slot back
    if (!this.one("SELECT 1 AS r FROM requesters WHERE item_id=?", id)) {
      this.sql.exec("UPDATE items SET status='deleted', ended_at=? WHERE id=?", Date.now(), id);
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
    const jokes = this.all("SELECT id, name, kind, urgent, anon FROM jokes WHERE status IN ('ready','preparing','pending') ORDER BY urgent DESC, created_at")
      .map((j) => ({ joke: true as const, id: String(j.id), artist: "",
                     names: Number(j.anon) ? MYSTERY : displayText(String(j.name), "a guest"),
                     title: j.kind === "announcement" ? (j.urgent ? "An urgent announcement" : "An announcement") : "A joke" }));
    const out: (T | (typeof jokes)[number])[] = [];
    songs.forEach((song, i) => { if (jokes[i]) out.push(jokes[i]); out.push(song); });
    return [...out, ...jokes.slice(songs.length)];
  }

  /** A phone's songs: up to 2 at a time, and once both slots are used, none until both have played. */
  private songLimit(device: string) {
    // songs asked for before the host released this phone's cooldown don't count against it
    const since = Number(this.one("SELECT at FROM song_release WHERE device=?", device)?.at ?? 0);
    const active = Number(this.one(`SELECT COUNT(*) AS n FROM requesters r JOIN items i ON i.id=r.item_id
      WHERE r.device=? AND r.created_at>? AND i.status IN ('pending','preparing','ready','queued','playing')`, device, since)?.n ?? 0);
    let locked = active >= MAX_WAITING_PER_DEVICE;
    if (this.one("SELECT 1 AS l FROM song_locks WHERE device=?", device)) {
      if (active === 0) this.sql.exec("DELETE FROM song_locks WHERE device=?", device);   // both played: free again
      else locked = true;
    }
    return { active, locked };
  }

  /** How many times this phone has asked for this song tonight (a cancelled ask doesn't count). */
  private asks(device: string, key: string): number {
    return Number(this.one(`SELECT COUNT(*) AS n FROM requesters r JOIN items i ON i.id=r.item_id
      WHERE r.device=? AND i.song_key=?`, device, key)?.n ?? 0);
  }

  /** A phone's messages: one regular joke or announcement waiting at a time; one urgent an hour
   *  (one the DJ passed on or couldn't record doesn't count); one guest urgent per 10 min party-wide;
   *  one anonymous a night (the same exceptions). */
  private messageLimit(device: string) {
    const now = Date.now();
    const waiting = Boolean(this.one(`SELECT 1 AS w FROM jokes WHERE device=? AND urgent=0
      AND status IN ('pending','preparing','ready') LIMIT 1`, device));
    const mine = Number(this.one(`SELECT MAX(created_at) AS t FROM jokes WHERE device=? AND urgent=1
      AND status NOT IN ('rejected','failed')`, device)?.t ?? 0);
    const party = Number(this.one(`SELECT MAX(created_at) AS t FROM jokes WHERE source='guest' AND urgent=1
      AND status NOT IN ('deleted','rejected','failed')`)?.t ?? 0);
    const left = (t: number, ms: number) => Math.max(0, Math.ceil((t + ms - now) / 1000));
    const anonLeft = !this.one(`SELECT 1 AS a FROM jokes WHERE device=? AND anon=1
      AND status NOT IN ('deleted','rejected','failed') LIMIT 1`, device);
    return { waiting, urgentInS: left(mine, 3_600_000), partyUrgentInS: left(party, 600_000), anonLeft };
  }

  async guestState(device: string) {
    const waiting = this.display();
    // newest of this phone's own asks first (joining an older song puts it at the top too)
    const mine = this.all(`SELECT i.*, MAX(r.created_at) AS mine_at FROM items i JOIN requesters r ON r.item_id=i.id
      WHERE r.device=? GROUP BY i.id ORDER BY mine_at DESC LIMIT 8`, device);
    // how often this phone has asked for each of its songs, in one pass over its own asks
    const asked = this.all(`SELECT i.song_key AS k, MIN(i.title) AS title, MIN(i.artist) AS artist, COUNT(*) AS n
      FROM requesters r JOIN items i ON i.id=r.item_id WHERE r.device=? GROUP BY i.song_key`, device);
    const askedN = new Map(asked.map((a) => [String(a.k), Number(a.n)]));
    return {
      nowPlaying: this.nowPlaying(),
      upNext: this.lineup(waiting.slice(0, 6).map((i) => this.pub(i))),
      waitingCount: waiting.length,
      mine: mine.map((i) => ({ ...this.pub(i), status: String(i.status), skipped: Boolean(i.skipped),
        position: waiting.findIndex((w) => w.id === i.id) + 1 || null,
        again: (askedN.get(String(i.song_key)) ?? 0) < MAX_ASKS_PER_SONG,   // "Request again" still allowed
        track: { durationMs: i.duration_ms == null ? null : Number(i.duration_ms), explicit: Boolean(i.explicit) } })),
      // songs this phone has used both asks on: shown as ⃠ in search
      spent: asked.filter((a) => Number(a.n) >= MAX_ASKS_PER_SONG).map((a) => ({ title: String(a.title), artist: String(a.artist) })),
      accepting: this.flags().accepting,
      familyMode: this.flags().familyMode,
      stationOff: this.flags().stationOff,
      myJokes: this.all("SELECT id, text, status, kind, urgent, anon FROM jokes WHERE device=? AND status<>'deleted' ORDER BY created_at DESC LIMIT 3", device)
        .map((j) => ({ id: String(j.id), text: String(j.text), status: String(j.status), kind: String(j.kind ?? "joke"),
                       urgent: Boolean(j.urgent), anon: Boolean(j.anon) })),
      djOnBreak: Date.now() - this.health().at > OFFLINE_MS,
      limits: { freePlay: this.flags().freePlay, songs: { ...this.songLimit(device), max: MAX_WAITING_PER_DEVICE },
                ...this.messageLimit(device), padInS: this.flags().freePlay ? 0 : this.padLimit(device).padInS },
    };
  }

  /** Song keys the studio already has on disk: they play instantly. */
  async cachedKeys(): Promise<string[]> {
    try {
      const keys = JSON.parse(this.setting("cached", "[]"));
      return Array.isArray(keys) ? keys.map(String) : [];
    } catch {
      return [];
    }
  }

  // ---------- studio ----------
  async beat(b: Beat) {
    const now = Date.now();
    const { cached, ...rest } = b as Beat & { cached?: unknown };
    if (Array.isArray(cached)) this.set("cached", JSON.stringify(cached.slice(0, 5000)));   // sent only when it changes
    this.set("health", JSON.stringify({ ...rest, at: now }));
    for (const c of Array.isArray(b.ack) ? b.ack : []) this.sql.exec("UPDATE commands SET done=1 WHERE id=?", Number(c));
    for (const id of b.working ?? []) {
      this.sql.exec("UPDATE items SET lease_until=? WHERE id=? AND status='preparing'", now + LEASE_MS, id);
      this.sql.exec("UPDATE jokes SET lease_until=? WHERE id=? AND status='preparing'", now + LEASE_MS, id);
    }
    this.sql.exec("UPDATE jokes SET status='pending', lease_until=0 WHERE status='preparing' AND lease_until<?", now);
    for (const id of Array.isArray(b.jokesPlayed) ? b.jokesPlayed : [])
      this.sql.exec("UPDATE jokes SET status='played', played_at=?, ended_at=? WHERE id=? AND status IN ('ready','deleted')", now, now, String(id));
    for (const a of Array.isArray(b.aired) ? b.aired.slice(0, 20) : [])   // bumpers the studio played (re-sent until acked)
      if (a && typeof a.kind === "string" && Number.isFinite(Number(a.at)))
        this.sql.exec("INSERT OR IGNORE INTO airlog(kind, text, at) VALUES(?,?,?)", a.kind.slice(0, 20), clean(a.text ?? "", 400), Number(a.at));
    // urgent announcements first (written up and told before anything else), then in the order sent
    const jokeJobs = this.all("SELECT id, name, text, kind, urgent, source, anon FROM jokes WHERE status='pending' ORDER BY urgent DESC, created_at LIMIT ?",
      Math.max(0, Math.min(2, Number(b.wantJokes) || 0))).map((j) => {
      this.sql.exec("UPDATE jokes SET status='preparing', lease_until=? WHERE id=?", now + LEASE_MS, j.id);
      return { id: String(j.id), name: Number(j.anon) ? MYSTERY : String(j.name), text: String(j.text), kind: String(j.kind ?? "joke"),
               urgent: Boolean(j.urgent), source: String(j.source ?? "guest") };
    });
    const nj = this.one("SELECT id, file, seconds, script, kind, urgent FROM jokes WHERE status='ready' ORDER BY urgent DESC, created_at LIMIT 1");
    const nextJoke = nj ? { id: String(nj.id), file: String(nj.file), seconds: Number(nj.seconds), script: String(nj.script ?? ""),
                            kind: String(nj.kind ?? "joke"), urgent: Boolean(nj.urgent) } : null;
    this.sql.exec("UPDATE items SET status='pending', lease_until=0 WHERE status='preparing' AND lease_until<?", now);
    // "silence": the studio couldn't reach the Pi, so this beat says nothing about what's playing.
    // Change no song's state and hand nothing out (that marked the on-air song played and handed a
    // second song out); preparation carries on.
    // "off": the host switched the station off; the Pi plays nothing and reports nothing either.
    const unknown = b.source === "silence" || b.source === "off";
    if (!unknown) this.followStation(b, now);
    const jobs = [];
    for (const i of this.all(`SELECT * FROM items WHERE status='pending' ORDER BY rank LIMIT ?`, Math.max(0, Number(b.want) || 0))) {
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
      settings: { somaOnly: f.somaOnly, stopAfterCurrent: f.stopAfterCurrent, breakEveryMin: f.breakEveryMin,
                  familyMode: f.familyMode, stationOff: f.stationOff },
      next: next ? this.studioItem(next) : null,
      jobs,
      jokeJobs,
      nextJoke,   // the oldest recorded joke: the studio plays it as the next break
      // every message still on its way: one attached to a queued song but deleted since comes off it
      liveJokes: this.all("SELECT id FROM jokes WHERE status IN ('pending','preparing','ready')").map((j) => String(j.id)),
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
      // a song still marked on air is left to endPlaying below (timeline, skipped mark, cut-off rule)
      this.sql.exec(`UPDATE items SET status='played', played_at=?, ended_at=? WHERE id=? AND status IN ('queued','ready')
        AND queued_at>0 AND queued_at<=?`, now, now, r.id, started);
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
    this.sql.exec("UPDATE items SET status='played', played_at=?, ended_at=?, skipped=? WHERE id=?", now, now, skipped ? 1 : 0, it.id);
  }

  async result(r: Result) {
    if (!r || (r.status !== "ready" && r.status !== "failed")) return { ok: false };
    const item = this.one("SELECT status,redo FROM items WHERE id=?", r.id);
    if (item && r.status === "failed" && (item.status === "queued" || item.status === "ready")) {
      // the studio couldn't push it (file unreadable): fail it rather than hand it out forever
      this.sql.exec("UPDATE items SET status='failed', error=?, ended_at=? WHERE id=?", clean(r.error ?? "Song file unreadable", 300), Date.now(), r.id);
      return { ok: true };
    }
    if (!item || item.status !== "preparing") return { ok: false };
    if (r.status === "ready" && item.redo) {
      this.sql.exec("UPDATE items SET status='pending', redo=0, redos=COALESCE(redos,0)+1, lease_until=0 WHERE id=?", r.id);
      return { ok: true, redo: true };
    }
    this.sql.exec(`UPDATE items SET status=?, file=?, duration_s=?, confidence=?, dj_line=?, tone=?,
      voice=?, error=?, match_note=?, lease_until=0, ended_at=? WHERE id=?`, r.status, r.file ?? null, r.durationS ?? null,
      r.confidence ?? null, r.djLine ?? null, r.tone ?? null, r.voice ?? null, r.error ?? null,
      r.matchNote ?? null, r.status === "failed" ? Date.now() : null, r.id);
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
      // the last few finished, newest first ("+status": walk the ended_at index, stop after 15 rows)
      ...this.all("SELECT * FROM items WHERE ended_at IS NOT NULL AND +status IN ('failed','played') ORDER BY ended_at DESC LIMIT 15"),
    ];
    const muted = this.all("SELECT device FROM muted ORDER BY device").map((m) => ({
      device: String(m.device),
      names: [...new Set([...this.all("SELECT name FROM requesters WHERE device=? ORDER BY id DESC LIMIT 5", m.device),
                          ...this.all("SELECT name FROM jokes WHERE device=? ORDER BY created_at DESC LIMIT 5", m.device)]   // a phone muted for its jokes
        .map((r) => String(r.name)))],
    }));
    // Played: one timeline, newest first: songs (played, skipped, failed, removed), bumpers, jokes and
    // announcements, each where it happened; nothing moves once it's there
    const song = (i: Row) => ({ type: "song" as const, at: Number(i.ended_at), ...this.adminItem(i),
                                status: Number(i.skipped) ? "skipped" : i.status === "deleted" ? "removed" : String(i.status) });
    const history = [
      ...this.all("SELECT * FROM items WHERE ended_at IS NOT NULL AND +status IN ('played','failed','deleted') ORDER BY ended_at DESC LIMIT 40").map(song),
      ...this.all("SELECT * FROM jokes WHERE ended_at IS NOT NULL ORDER BY ended_at DESC LIMIT 40").map((j) => ({ type: "joke" as const,
        at: Number(j.ended_at), ...this.adminJoke(j) })),
      ...this.all("SELECT * FROM airlog ORDER BY at DESC LIMIT 40").map((a) => ({ type: "break" as const, at: Number(a.at),
        kind: String(a.kind), text: String(a.text) })),
    ].sort((x, y) => y.at - x.at).slice(0, 100);   // each kind keeps its own last 40: bumpers can't crowd the songs out
    // phones that used both song slots and wait for them to play: the host can let them pick again
    const cooldowns = this.all("SELECT device FROM song_locks").map((l) => ({ device: String(l.device), ...this.songLimit(String(l.device)) }))
      .filter((c) => c.locked)
      .map((c) => ({ device: c.device, waiting: c.active,
        names: [...new Set(this.all("SELECT name FROM requesters WHERE device=? ORDER BY id DESC LIMIT 5", c.device).map((r) => String(r.name)))] }));
    return {
      cooldowns,
      history,
      nowPlaying: this.nowPlaying(),
      muted,
      health: { ...h, ageS: h.at ? Math.round((Date.now() - h.at) / 1000) : null },
      serverNow: Date.now(),   // "N min ago" is worked out against this, not the phone's clock
      code: "msgs-1",         // read back after a deploy: proves the queue runs this code (no bump needed)
      settings: this.flags(),
      jokes: [...this.all("SELECT * FROM jokes WHERE status IN ('pending','preparing','ready') ORDER BY urgent DESC, created_at"),
              ...this.all("SELECT * FROM jokes WHERE ended_at IS NOT NULL AND +status<>'deleted' ORDER BY ended_at DESC LIMIT 10")]
        .map((j) => this.adminJoke(j)),
      items: items.map((i) => this.adminItem(i)),
    };
  }
  private adminItem(i: Row) {
    return {
      id: String(i.id), title: String(i.title), artist: String(i.artist), status: String(i.status),
      confidence: i.confidence == null ? null : Number(i.confidence), djLine: i.dj_line, tone: i.tone,
      voice: i.voice, error: i.error, matchNote: i.match_note ?? null, freeText: Boolean(i.free_text), explicit: Boolean(i.explicit),
      requesters: this.requesters(String(i.id)),
    };
  }
  private adminJoke(j: Row) {
    return { id: String(j.id), name: String(j.name), text: String(j.text), status: String(j.status),
             script: String(j.script ?? ""), device: String(j.device), createdAt: Number(j.created_at),
             kind: String(j.kind ?? "joke"), urgent: Boolean(j.urgent), source: String(j.source ?? "guest"), anon: Boolean(j.anon) };
  }

  async adminAction(a: {
    action: string; id?: string; dir?: -1 | 1; device?: string; pad?: number; track?: Track; name?: string; text?: string;
    message?: string; settings?: Partial<Record<"accepting" | "stopAfterCurrent" | "somaOnly" | "freePlay" | "familyMode" | "stationOff", boolean>> & { breakEveryMin?: number };
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
      case "announce": {   // the host's own announcement: always urgent, read as soon as it's recorded
        const text = clean(a.text, 400);
        if (text.replace(/[^\p{L}\p{N}]/gu, "").length < 4) return { ok: false, error: "Type the announcement." };
        const id = "j" + this.newId().slice(1);
        this.sql.exec(`INSERT INTO jokes(id,device,name,text,status,created_at,kind,urgent,source)
          VALUES(?, 'host', 'the host', ?, 'pending', ?, 'announcement', 1, 'host')`, id, text, Date.now());
        return { ok: true, id };
      }
      case "deleteJoke":
        if (!this.one("SELECT 1 AS j FROM jokes WHERE id=? AND status IN ('pending','preparing','ready')", String(a.id ?? "")))
          return { ok: false, error: "no such joke waiting" };
        this.sql.exec("UPDATE jokes SET status='deleted', ended_at=? WHERE id=?", Date.now(), String(a.id));
        return { ok: true };
      case "replay":   // the DJ read of the song on air, over the PA again
        if (status !== "playing") return { ok: false, error: "Only the song on air can be replayed." };
        this.command("replay", a.id!);
        return { ok: true };
      case "delete":
        if (!status) return { ok: false, error: "no such request" };
        if (!["pending", "preparing", "ready", "queued", "playing"].includes(status)) return { ok: true };   // already gone
        if (status === "playing") this.skip();   // before the status changes: the skip names this song
        this.sql.exec("UPDATE items SET status='deleted', ended_at=? WHERE id=?", Date.now(), a.id!);
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
        const old = this.one("SELECT * FROM items WHERE id=?", a.id!);
        if (!old) return { ok: false, error: "no such request" };
        if (!["played", "failed", "deleted"].includes(String(old.status))) return { ok: false, error: "It's already in line." };
        const waitingCopy = this.one(`SELECT id FROM items WHERE song_key=? AND status IN ${WAITING} AND id<>?`, old.song_key, a.id!);
        if (waitingCopy) {
          this.sql.exec(`INSERT INTO requesters(item_id,device,name,message,created_at,ip)
            SELECT ?,device,name,message,created_at,ip FROM requesters WHERE item_id=?
              AND device NOT IN (SELECT device FROM requesters WHERE item_id=?)`, waitingCopy.id, a.id!, waitingCopy.id);
          return { ok: true, merged: String(waitingCopy.id) };
        }
        // a fresh copy at the end of the line: the earlier play (or failure) keeps its place in the timeline,
        // and the copy gets its own cut-off allowance. The song file is reused if it played.
        const last = Number(this.one(`SELECT MAX(rank) AS r FROM items WHERE status IN ${WAITING}`)?.r ?? 0);
        const id = this.newId();
        const keep = ["song_key", "title", "artist", "album", "duration_ms", "artwork", "explicit", "free_text", "year", "apple_url",
                      ...(old.status === "played" && old.file ? ["file", "duration_s", "confidence", "dj_line", "tone", "voice", "match_note"] : [])];
        this.sql.exec(`INSERT INTO items(id, status, rank, created_at, ${keep.join(",")})
          VALUES(?, ?, ?, ?, ${keep.map(() => "?").join(",")})`, id, old.status === "played" && old.file ? "ready" : "pending",
          last + 1, Date.now(), ...keep.map((k) => old[k] as SqlStorageValue));
        this.sql.exec(`INSERT INTO requesters(item_id,device,name,message,created_at,ip)
          SELECT ?,device,name,message,created_at,ip FROM requesters WHERE item_id=?`, id, a.id!);
        return { ok: true, id };
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
        this.sql.exec(`UPDATE items SET status='deleted', ended_at=? WHERE status IN ('pending','preparing','ready','queued')
          AND id IN (${solo})`, Date.now(), a.device);
        if (inConsole) this.command("clear");   // its song was already handed to the console
        this.sql.exec("UPDATE jokes SET status='deleted', ended_at=? WHERE device=? AND status IN ('pending','preparing','ready')", Date.now(), a.device);
        return { ok: true };
      }
      case "release": {   // a fresh pair of song slots for one phone (or every phone waiting)
        const devices = a.device ? [a.device] : this.all("SELECT device FROM song_locks").map((l) => String(l.device));
        for (const d of devices) {
          this.sql.exec("DELETE FROM song_locks WHERE device=?", d);
          this.sql.exec("INSERT INTO song_release(device, at) VALUES(?,?) ON CONFLICT(device) DO UPDATE SET at=excluded.at", d, Date.now());
        }
        return { ok: true, released: devices.length };
      }
      case "unmute":
        this.sql.exec("DELETE FROM muted WHERE device=?", a.device!);
        return { ok: true };
      case "settings":
        for (const [k, v] of Object.entries(a.settings ?? {})) {   // real true/false only: "false" is not true
          if (["accepting", "stopAfterCurrent", "somaOnly", "freePlay", "familyMode", "stationOff"].includes(k) && typeof v === "boolean") this.set(k, v ? "1" : "0");
        }
        const every = a.settings?.breakEveryMin;
        if (typeof every === "number" && Number.isFinite(every))
          this.set("breakEveryMin", String(Math.min(30, Math.max(5, Math.round(every / 5) * 5))));
        if (a.settings?.somaOnly === true) this.skip();   // the studio cuts the song on air: a skip, not a cut-off
        if (a.settings?.stationOff === true)   // the Pi drops what it holds when it switches off: back in line
          this.sql.exec("UPDATE items SET status='ready' WHERE status='queued'");
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
    this.sql.exec("DELETE FROM song_locks");
    this.sql.exec("DELETE FROM song_release");
    this.sql.exec("DELETE FROM pad_presses");
    this.sql.exec("UPDATE items SET dj_line=NULL");
    this.sql.exec("UPDATE jokes SET name='', text='', script=NULL, ip=NULL, device=''");
    this.sql.exec("UPDATE airlog SET text=''");
    this.sql.exec("DELETE FROM settings WHERE key='health'");
  }
}
