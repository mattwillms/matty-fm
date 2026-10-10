// The one Durable Object ("party"): queue, settings, studio beats, admin actions.
import { DurableObject } from "cloudflare:workers";
import { clean, displayText, isOffensive, plain, namesPhrase, rankForNew, safeArtwork, songKey, swapRanks, visible, type Waiting } from "./queue";
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
const PAD_GAPS_S = [0, 5, 20, 60];   // the whole house shares the buttons: one sound per gap (admin; 0 = buttons off)
// Orrdle (the family Wordle): the answers. Testing list; the real one comes from the host.
const ORRDLE_WORDS = ["LUCAS", "SETHY", "MARIE", "MATTY", "JULIE", "JULIA", "JAMES", "NANCY", "SHAWN", "BYRON", "AARON",
  "GRIFF", "SARAH", "RYLEE", "TYLER", "JEFFY", "LYDIA", "FLORA", "REBEL", "DAWGS", "CAJUN"];
// The scavenger hunt: a medal for each hidden animation a guest makes happen. All of them: a golden quarter.
export const MEDALS = ["eggs", "kaboom", "snap", "needle", "static", "colors", "screws", "gnat", "polish"] as const;
// Three guests have a sound of their own in place of Applause (pad 5), by the name they go by ("Ava 2" counts)
const CUSTOM_PAD = 5, CUSTOM_SOUNDS = ["ava", "hadley", "marie"];
const TALK_S = 15;            // the DJ's intro and the crossfade, per song: for the wait estimate
const JOKE_S = 25;            // a joke or announcement read between songs
const PREP_S = 90;            // a song nobody's waiting behind still has to be found and downloaded
const LONG_LINE = 20;          // more songs than this waiting: one song per phone at a time, so more guests get a turn
const JOKE_STALE_MS = 30 * 60_000;   // a joke not told by then is dropped ("the DJ ran out of time")
const MYSTERY = "a mystery guest";   // who an anonymous message is from, on air and on the guest page
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
  hold?: string;   // the studio doubts it's a real song ("%%%" found a kids' clip): why, for the host
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
  private turns: { at: number; ordered: Waiting[] } | null = null;   // the line's order for wait estimates (cached)
  private seenAt = new Map<string, number>();   // device -> last time its visit was written (at most once a minute)

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
      CREATE TABLE IF NOT EXISTS medals(device TEXT NOT NULL, medal TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(device, medal));
      CREATE TABLE IF NOT EXISTS bonus(device TEXT PRIMARY KEY, coins INTEGER NOT NULL DEFAULT 0, golden_used INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS devices(device TEXT PRIMARY KEY, first_at INTEGER NOT NULL, last_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS kicked(device TEXT PRIMARY KEY, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS names(device TEXT PRIMARY KEY, name TEXT NOT NULL, key TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS orrdle(id TEXT PRIMARY KEY, device TEXT NOT NULL, name TEXT NOT NULL, word TEXT NOT NULL,
        started INTEGER NOT NULL, ended INTEGER, won INTEGER, guesses INTEGER);
      CREATE TABLE IF NOT EXISTS parties(id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, start INTEGER NOT NULL,
        end INTEGER NOT NULL, stats TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS commands(
        id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, done INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL);`);
    for (const [table, col] of [["items", "queued_at INTEGER DEFAULT 0"], ["items", "match_note TEXT"], ["items", "year TEXT"],
                                ["items", "apple_url TEXT"], ["requesters", "ip TEXT"], ["commands", "target TEXT"], ["items", "redos INTEGER DEFAULT 0"],
                                ["items", "started_at INTEGER DEFAULT 0"], ["items", "cuts INTEGER DEFAULT 0"],
                                ["jokes", "kind TEXT DEFAULT 'joke'"], ["jokes", "urgent INTEGER DEFAULT 0"],
                                ["jokes", "source TEXT DEFAULT 'guest'"],
                                ["items", "ended_at INTEGER"], ["items", "skipped INTEGER DEFAULT 0"], ["jokes", "ended_at INTEGER"],
                                ["jokes", "anon INTEGER DEFAULT 0"], ["orrdle", "tries TEXT DEFAULT '[]'"], ["requesters", "paid TEXT"], ["kicked", "name TEXT"]]) {
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
      CREATE INDEX IF NOT EXISTS commands_type ON commands(type, created_at);
      CREATE INDEX IF NOT EXISTS pad_device ON pad_presses(device, at);
      CREATE INDEX IF NOT EXISTS pad_at ON pad_presses(at);
      CREATE INDEX IF NOT EXISTS orrdle_device ON orrdle(device, started);
      CREATE INDEX IF NOT EXISTS orrdle_started ON orrdle(started);`);
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
    this.flagsMemo = null;
  }
  private flagsMemo: ReturnType<Party["readFlags"]> | null = null;
  /** The host's settings: read once, kept until one changes (set() forgets them). Every poll used to read them ~7 times. */
  private flags() { return (this.flagsMemo ??= this.readFlags()); }
  private readFlags() {
    return {
      accepting: this.setting("accepting", "1") === "1",
      stopAfterCurrent: this.setting("stopAfterCurrent", "0") === "1",
      somaOnly: this.setting("somaOnly", "0") === "1",
      breakEveryMin: Number(this.setting("breakEveryMin", "10")),
      freePlay: this.setting("freePlay", "0") === "1",   // no per-phone limits on songs or messages
      familyMode: this.setting("familyMode", "1") === "1",   // clean songs only, a family-friendly DJ (off: PG-13)
      stationOff: this.setting("stationOff", "0") === "1",   // the Pi fades to silence and stops streaming altogether
      padGapS: Number(this.setting("padGapS", "20")),   // the guests' preset buttons, house-wide (0: off)
    };
  }
  /** Names and messages are wiped after the party: make sure the alarm is set once something personal is stored. */
  private async armPurge(now = Date.now()) {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(now < PURGE_AT ? PURGE_AT : now + PURGE_AFTER_MS);
  }
  private command(type: "skip" | "clear" | "break" | "replay" | `pad${string}`, target: string | null = null): void {
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
    return this.all("SELECT device,name,message,paid FROM requesters WHERE item_id=? ORDER BY id", id);
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
      // golden: bought with the scavenger hunt's golden quarter (the DJ makes something of it)
      requesters: this.requesters(String(i.id)).map((r) => ({ name: String(r.name), message: String(r.message), ...(r.paid === "golden" ? { golden: true } : {}) })),
    };
  }

  // ---------- guests ----------
  async submit(device: string, s: SubmitIn, asAdmin = false, ip = "") {
    if (!asAdmin && this.flags().stationOff) return { ok: false, error: "WORR is off the air. Requests open again when it's back." };
    if (!asAdmin && !this.flags().accepting) return { ok: false, error: "Requests are closed for tonight." };
    if (!asAdmin && this.one("SELECT 1 AS m FROM muted WHERE device=?", device))
      return { ok: false, error: "Requests are paused for this phone." };
    let name = clean(s.name, 40);
    if (!asAdmin) { const n = await this.ensureName(device, s.name); if ("error" in n) return { ok: false, error: n.error }; name = n.name; }
    const message = plain(s.message ?? "", 280);
    const title = plain(s.track?.title, 200), artist = plain(s.track?.artist, 200);
    if (!visible(name)) return { ok: false, error: "Add your name (letters, not just emoji)." };
    if (!title) return { ok: false, error: "Add the song title." };
    if (!artist) return { ok: false, error: "Add the artist, or your best guess." };
    if ((title + artist).replace(/[^\p{L}]/gu, "").length < 2)   // every request: "freeText" is the page's word, not proof
      return { ok: false, error: "Type the song's name in words." };
    if (!asAdmin && s.track?.explicit === true && this.flags().familyMode)
      return { ok: false, error: "Family mode is on: pick the clean version." };
    let spend: "golden" | "coin" | null = null;   // a locked phone with an extra quarter spends it on this one
    if (!asAdmin && !this.flags().freePlay) {
      const lim = this.songLimit(device);
      if (lim.locked && lim.extra.golden) spend = "golden";
      else if (lim.locked && lim.extra.coins) spend = "coin";
      else if (lim.locked)
        return { ok: false, error: lim.max === 1 ? "The line is long: one song at a time. Yours plays first!"
                                 : lim.active === 1 ? "Your other song plays first. Then you can pick two more!"
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
    this.sql.exec("INSERT INTO requesters(item_id,device,name,message,created_at,ip,paid) VALUES(?,?,?,?,?,?,?)",
      id, device, name, message, now, ip, spend);
    if (spend === "golden") this.sql.exec("INSERT INTO bonus(device, golden_used) VALUES(?,1) ON CONFLICT(device) DO UPDATE SET golden_used=1", device);
    if (spend === "coin") this.sql.exec("UPDATE bonus SET coins=coins-1 WHERE device=? AND coins>0", device);
    const after = this.songLimit(device);
    if (!asAdmin && !this.flags().freePlay && after.active >= after.max)   // every slot used: none again until all play
      this.sql.exec("INSERT OR IGNORE INTO song_locks(device) VALUES(?)", device);
    await this.armPurge(now);
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
    return { items: table("items"), requesters: table("requesters"), settings: table("settings"), muted: table("muted"), parties: table("parties"), medals: table("medals"), bonus: table("bonus"), devices: table("devices"), names: table("names"), kicked: table("kicked"), orrdle: table("orrdle"), jokes: table("jokes"), airlog: table("airlog"), song_locks: table("song_locks"), song_release: table("song_release") };
  }

  /** Takes over an old queue's state, once, and only into an empty queue (ids are kept, so the
   *  console's song on air and every phone's "Your requests" still match). */
  async importState(data: { items?: Row[]; requesters?: Row[]; settings?: Row[]; muted?: Row[]; jokes?: Row[]; airlog?: Row[]; song_locks?: Row[]; song_release?: Row[]; parties?: Row[]; medals?: Row[]; bonus?: Row[]; devices?: Row[]; names?: Row[]; kicked?: Row[]; orrdle?: Row[] }) {
    if (this.one("SELECT 1 AS x FROM items LIMIT 1") || this.one("SELECT 1 AS x FROM requesters LIMIT 1"))
      return { ok: false, error: "this queue isn't empty" };
    let n = 0;
    for (const t of ["items", "requesters", "settings", "muted", "jokes", "airlog", "song_locks", "song_release", "parties", "medals", "bonus", "devices", "names", "kicked", "orrdle"] as const) {
      const cols = new Set(this.all(`PRAGMA table_info(${t})`).map((c) => String(c.name)));
      for (const row of Array.isArray(data?.[t]) ? data[t]! : []) {
        const keys = Object.keys(row).filter((k) => cols.has(k));   // only columns this schema has
        if (!keys.length) continue;
        this.sql.exec(`INSERT OR REPLACE INTO ${t}(${keys.join(",")}) VALUES(${keys.map(() => "?").join(",")})`,
          ...keys.map((k) => row[k] as SqlStorageValue));
        n++;
      }
    }
    if (n) await this.armPurge();
    return { ok: true, rows: n };
  }

  /** A guest's joke for the DJ to read on air: written up and recorded by the studio, told as a break. */
  async submitJoke(device: string, j: { name?: unknown; text?: unknown; kind?: unknown; urgent?: unknown; anon?: unknown }, ip = "") {
    const kind = j?.kind === "announcement" ? "announcement" : "joke";
    const urgent = kind === "announcement" && j?.urgent === true;
    const anon = j?.anon === true;   // read on air as "a mystery guest"; the host still sees the name and phone
    if (anon && urgent) return { ok: false, error: "An urgent one can't be anonymous." };
    if (this.flags().stationOff) return { ok: false, error: "WORR is off the air. Requests open again when it's back." };
    if (!this.flags().accepting) return { ok: false, error: "The DJ isn't taking jokes right now." };
    if (this.one("SELECT 1 AS m FROM muted WHERE device=?", device)) return { ok: false, error: "Requests are paused for this phone." };
    const n = await this.ensureName(device, j?.name);
    if ("error" in n) return { ok: false, error: n.error };
    const name = n.name, text = plain(j?.text, 400);
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
    await this.armPurge();
    return { ok: true, id };
  }

  /** The studio's answer for a joke: recorded (ready), declined by the DJ (rejected), or failed. */
  async jokeResult(r: { id: string; status: string; file?: string; seconds?: number; script?: string; isJoke?: boolean }) {
    const status = r?.status === "ready" ? "ready" : r?.status === "rejected" ? "rejected" : r?.status === "failed" ? "failed" : "";
    if (!status) return { ok: false };
    const secs = Number(r.seconds);
    this.sql.exec(`UPDATE jokes SET status=?, file=?, seconds=?, script=?, lease_until=0, ended_at=? WHERE id=? AND status IN ('preparing','pending')`,
      status, status === "ready" ? String(r.file ?? "") : null, Number.isFinite(secs) ? secs : null, clean(r.script ?? "", 1000),
      status === "ready" ? null : Date.now(), String(r.id));
    // an "urgent announcement" the DJ found to be a joke: it waits its turn in the joke line (free play: it cuts in)
    if (r.isJoke === true && !this.flags().freePlay)
      this.sql.exec("UPDATE jokes SET kind='joke', urgent=0 WHERE id=? AND source='guest' AND urgent=1", String(r.id));
    return { ok: true };
  }

  /** The name a phone goes by tonight: one phone per name (case doesn't count), English letters and spaces only.
   *  A phone the host kicked that comes back asking for its old name gets it numbered ("Ava 2"), if that's free. */
  async claimName(device: string, raw: unknown, auto = false) {   // auto: taken, so take the next number (a new guest: "Ann 2")
    const asked = String(raw ?? "").replace(/\s+/g, " ").trim();
    if (!/^[A-Za-z]+( [A-Za-z]+)*$/.test(asked) || asked.length > 24)
      return { ok: false, error: "Letters only (A to Z), please: no numbers, emoji or symbols." };
    if (isOffensive(asked)) return { ok: false, error: "Pick a different name." };
    const mine = this.one("SELECT name FROM names WHERE device=?", device);
    if (mine && String(mine.name).toLowerCase().replace(/ \d+$/, "") === asked.toLowerCase()) return { ok: true, name: String(mine.name) };   // already yours
    const was = String(this.one("SELECT name FROM kicked WHERE device=?", device)?.name ?? "");
    let name = asked;
    if (was && was.toLowerCase().replace(/ \d+$/, "") === asked.toLowerCase())   // back after a kick, same name: numbered
      for (let n = 2; ; n++) { name = `${asked} ${n}`; if (!this.one("SELECT 1 AS t FROM names WHERE key=? AND device<>?", name.toLowerCase(), device)) break; }
    const holder = this.one("SELECT name FROM names WHERE key=? AND device<>?", name.toLowerCase(), device);
    if (holder && auto)
      for (let n = 2; ; n++) { name = `${asked} ${n}`; if (!this.one("SELECT 1 AS t FROM names WHERE key=? AND device<>?", name.toLowerCase(), device)) break; }
    else if (holder) return { ok: false, error: `Someone here is already ${holder.name}. Add a last initial or a nickname.` };
    const key = name.toLowerCase();
    this.sql.exec("INSERT INTO names(device, name, key) VALUES(?,?,?) ON CONFLICT(device) DO UPDATE SET name=excluded.name, key=excluded.key", device, name, key);
    return { ok: true, name };
  }

  /** The name to put on what a phone sends: its registered one; a page from before names were registered sends one,
   *  which is claimed now (taken or not allowed: the guest is asked to change it). */
  private async ensureName(device: string, sent: unknown): Promise<{ name: string } | { error: string }> {
    const r = this.one("SELECT name FROM names WHERE device=?", device);
    if (r) return { name: String(r.name) };
    // not registered yet (a page from before names were): what it sent, cleaned to letters; taken: a new guest, numbered
    const base = String(sent ?? "").replace(/[^A-Za-z ]/g, "").replace(/\s+/g, " ").trim().slice(0, 24);
    if (!base) return { error: "Tell us your name first: tap Change by your name." };
    const c = await this.claimName(device, base, true);
    return c.ok ? { name: c.name! } : { error: `${c.error} Tap Change by your name.` };
  }

  /** A new Orrdle game: a name from the list this phone hasn't had yet (any, once it's had them all). The answer
   *  stays here: the server scores each guess and keeps the clock, so a win and its time can't be made up. */
  async orrdleStart(device: string, name: unknown) {
    if (this.one("SELECT 1 AS m FROM muted WHERE device=?", device)) return { ok: false, error: "Games are paused for this phone." };
    const had = new Set(this.all("SELECT word FROM orrdle WHERE device=?", device).map((r) => String(r.word)));
    const fresh = ORRDLE_WORDS.filter((w) => !had.has(w));
    const pool = fresh.length ? fresh : ORRDLE_WORDS;
    const word = pool[Math.floor(Math.random() * pool.length)];
    const id = "o" + this.newId().slice(1);
    const who = await this.ensureName(device, name);
    this.sql.exec("INSERT INTO orrdle(id, device, name, word, started) VALUES(?,?,?,?,?)", id, device, "name" in who ? who.name : "a guest", word, Date.now());
    return { ok: true, id, stats: this.orrdleMine(device) };
  }

  /** One guess at this phone's unfinished game: scored as Wordle does (repeats: greens first, then golds while that
   *  letter is left over). The sixth miss or a hit ends it; the answer is only told then. */
  async orrdleGuess(device: string, g: { id?: unknown; guess?: unknown }) {
    const guess = String(g?.guess ?? "").toUpperCase();
    if (!/^[A-Z]{5}$/.test(guess)) return { ok: false, error: "Five letters" };
    const game = this.one("SELECT * FROM orrdle WHERE id=? AND device=? AND ended IS NULL", String(g?.id ?? ""), device);
    if (!game) return { ok: false, error: "That game is over. Start another!" };
    const word = String(game.word), tries: string[] = JSON.parse(String(game.tries ?? "[]"));
    tries.push(guess);
    const marks = Array<string>(5).fill("no"), left: Record<string, number> = {};
    for (let i = 0; i < 5; i++) if (guess[i] === word[i]) marks[i] = "ok"; else left[word[i]] = (left[word[i]] ?? 0) + 1;
    for (let i = 0; i < 5; i++) if (marks[i] !== "ok" && left[guess[i]]) { marks[i] = "near"; left[guess[i]]--; }
    const won = guess === word, over = won || tries.length >= 6;
    this.sql.exec("UPDATE orrdle SET tries=?, ended=?, won=?, guesses=? WHERE id=?", JSON.stringify(tries),
      over ? Date.now() : null, over ? (won ? 1 : 0) : null, over ? tries.length : null, String(game.id));
    return { ok: true, marks, over, won, ...(over ? { word, stats: this.orrdleMine(device) } : {}) };
  }

  /** A guest's own Orrdle record, as Wordle shows it: played, won, streak, best time, guesses per win. */
  private orrdleMine(device: string) {
    const games = this.all("SELECT won, guesses, started, ended FROM orrdle WHERE device=? AND ended IS NOT NULL ORDER BY started", device);
    const wins = games.filter((x) => Number(x.won));
    let streak = 0;
    for (let i = games.length - 1; i >= 0 && Number(games[i].won); i--) streak++;
    const dist = [1, 2, 3, 4, 5, 6].map((k) => wins.filter((x) => Number(x.guesses) === k).length);
    const best = wins.length ? Math.min(...wins.map((x) => Number(x.ended) - Number(x.started))) : null;
    return { played: games.length, wins: wins.length, streak, bestMs: best, dist };
  }

  /** The house's Orrdle night, for the host: since a time (the party's start). */
  private orrdleHouse(since: number) {
    const n = (q: string, ...b: SqlStorageValue[]) => Number(this.one(q, ...b)?.n ?? 0);
    const fastest = this.one(`SELECT name, word, guesses, ended - started AS ms FROM orrdle WHERE won=1 AND started>=?
      ORDER BY ms LIMIT 1`, since);
    const fewest = this.one(`SELECT name, word, guesses, ended - started AS ms FROM orrdle WHERE won=1 AND started>=?
      ORDER BY guesses, ms LIMIT 1`, since);
    const top = this.all(`SELECT name, COUNT(*) AS wins, MIN(ended - started) AS ms FROM orrdle WHERE won=1 AND started>=?
      GROUP BY device ORDER BY wins DESC, ms LIMIT 5`, since)
      .map((x) => ({ name: String(x.name), wins: Number(x.wins), bestMs: Number(x.ms) }));
    const pick = (x: Row | undefined) => x ? { name: String(x.name), word: String(x.word), guesses: Number(x.guesses), ms: Number(x.ms) } : null;
    return {
      plays: n("SELECT COUNT(*) AS n FROM orrdle WHERE started>=?", since),
      wins: n("SELECT COUNT(*) AS n FROM orrdle WHERE won=1 AND started>=?", since),
      players: n("SELECT COUNT(DISTINCT device) AS n FROM orrdle WHERE started>=?", since),
      fastest: pick(fastest), fewest: pick(fewest), top,
    };
  }

  /** A guest presses one of the radio's preset buttons: the matching sound pad plays on the PA. */
  async guestPad(device: string, pad: unknown) {
    const n = typeof pad === "number" ? pad : NaN;
    if (!Number.isInteger(n) || n < 1 || n > 8) return { ok: false, error: "No such button." };
    if (this.flags().stationOff) return { ok: false, error: "WORR is off the air. Requests open again when it's back." };
    if (this.one("SELECT 1 AS m FROM muted WHERE device=?", device)) return { ok: false, error: "Requests are paused for this phone." };
    if (!this.flags().padGapS) return { ok: false, error: "The buttons are off right now." };
    if (!this.flags().freePlay) {
      const lim = this.padLimit(device);
      if (lim.padInS) return { ok: false, error: `Your next sound in ${lim.padInS} s.`, padInS: lim.padInS };
      if (lim.partyPadInS) return { ok: false, error: `Shared buttons: next sound in ${lim.partyPadInS} s.`, shareInS: lim.partyPadInS };
    }
    const now = Date.now();
    this.sql.exec("INSERT INTO pad_presses(device, pad, at) VALUES(?,?,?)", device, n, now);
    this.sql.exec("DELETE FROM pad_presses WHERE at<?", now - PAD_EVERY_MS);   // only the last minute matters
    const who = String(this.one("SELECT name FROM names WHERE device=?", device)?.name ?? "").toLowerCase().replace(/ \d+$/, "");
    this.command(n === CUSTOM_PAD && CUSTOM_SOUNDS.includes(who) ? `pad${n}-${who}` : `pad${n}`);
    return { ok: true };
  }

  private padLimit(device: string) {
    const now = Date.now(), left = (t: number, ms: number) => Math.max(0, Math.ceil((t + ms - now) / 1000));
    const mine = Number(this.one("SELECT MAX(at) AS t FROM pad_presses WHERE device=?", device)?.t ?? 0);
    const party = Number(this.one("SELECT MAX(at) AS t FROM pad_presses")?.t ?? 0);
    return { padInS: mine ? left(mine, PAD_EVERY_MS) : 0, partyPadInS: party ? left(party, this.flags().padGapS * 1000) : 0 };
  }

  /** A guest takes back their own request before it plays. A song others asked for too keeps going
   *  without their name; one only they asked for is removed (and pulled from the console if handed out). */
  async cancel(device: string, id: string) {
    const it = this.one("SELECT status FROM items WHERE id=?", String(id ?? ""));
    if (!it || !this.one("SELECT 1 AS m FROM requesters WHERE item_id=? AND device=?", id, device))
      return { ok: false, error: "That request isn't yours to cancel." };
    if (!["pending", "preparing", "ready", "queued", "held"].includes(String(it.status)))
      return { ok: false, error: it.status === "playing" ? "It's already on air!" : "That one is done already." };
    const paid = this.one("SELECT paid FROM requesters WHERE item_id=? AND device=?", id, device)?.paid;
    this.sql.exec("DELETE FROM requesters WHERE item_id=? AND device=?", id, device);
    this.sql.exec("DELETE FROM song_locks WHERE device=?", device);   // a cancel gives the slot back
    if (paid === "golden") this.sql.exec("UPDATE bonus SET golden_used=0 WHERE device=?", device);   // and the quarter it cost
    if (paid === "coin") this.sql.exec("UPDATE bonus SET coins=coins+1 WHERE device=?", device);
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
    const jokes = this.all("SELECT id, name, kind, urgent, anon FROM jokes WHERE status IN ('ready','preparing','pending') ORDER BY urgent DESC, kind='announcement' DESC, created_at")
      .map((j) => ({ joke: true as const, id: String(j.id), artist: "",
                     names: Number(j.anon) ? MYSTERY : displayText(String(j.name), "a guest"),
                     title: j.kind === "announcement" ? (j.urgent ? "An urgent announcement" : "An announcement") : "A joke" }));
    const out: (T | (typeof jokes)[number])[] = [];
    songs.forEach((song, i) => { if (jokes[i]) out.push(jokes[i]); out.push(song); });
    return [...out, ...jokes.slice(songs.length)];
  }

  /** A phone's songs: up to 2 at a time (1 while the line is long), and once every slot is used,
   *  none until they've all played. Free play: no cap. */
  private songLimit(device: string) {
    const max = this.flags().freePlay ? MAX_WAITING_PER_DEVICE
      : Number(this.one(`SELECT COUNT(*) AS n FROM items WHERE status IN ${WAITING}`)?.n ?? 0) > LONG_LINE ? 1 : MAX_WAITING_PER_DEVICE;
    // songs asked for before the host released this phone's cooldown don't count against it
    const since = Number(this.one("SELECT at FROM song_release WHERE device=?", device)?.at ?? 0);
    const active = Number(this.one(`SELECT COUNT(*) AS n FROM requesters r JOIN items i ON i.id=r.item_id
      WHERE r.device=? AND r.created_at>? AND i.status IN ('pending','preparing','ready','queued','playing','held')`, device, since)?.n ?? 0);
    let locked = active >= max;
    if (this.one("SELECT 1 AS l FROM song_locks WHERE device=?", device)) {
      if (active === 0) this.sql.exec("DELETE FROM song_locks WHERE device=?", device);   // both played: free again
      else locked = true;
    }
    return { active, locked, max, extra: this.extra(device) };
  }

  /** Quarters beyond the usual two: the scavenger hunt's golden one (once, when every medal is in) and any the host gave. */
  private extra(device: string) {
    const b = this.one("SELECT coins, golden_used FROM bonus WHERE device=?", device);
    const complete = Number(this.one("SELECT COUNT(*) AS n FROM medals WHERE device=?", device)?.n ?? 0) >= MEDALS.length;
    return { golden: complete && !Number(b?.golden_used ?? 0), goldenUsed: Boolean(Number(b?.golden_used ?? 0)), coins: Number(b?.coins ?? 0) };
  }

  /** A medal earned: the page saw the animation happen. Once each; the last one brings the golden quarter. */
  async earnMedal(device: string, medal: unknown) {
    if (!MEDALS.includes(medal as (typeof MEDALS)[number])) return { ok: false, error: "No such medal." };
    // the page says a medal was earned (a tap can't be checked from here), so a script could claim them all at once:
    // one a phone every 3 s, and the last only once the hunt has taken 2 minutes; a refusal says when to try again
    const now = Date.now(), times = this.all("SELECT medal, at FROM medals WHERE device=? ORDER BY at", device);
    if (!times.some((m) => m.medal === medal) && times.length) {
      const wait = Math.max(Number(times[times.length - 1].at) + 3_000 - now,
        times.length === MEDALS.length - 1 ? Number(times[0].at) + 120_000 - now : 0);
      if (wait > 0) return { ok: false, error: "slow", retryIn: wait, hunt: this.hunt(device) };
    }
    this.sql.exec("INSERT OR IGNORE INTO medals(device, medal, at) VALUES(?,?,?)", device, String(medal), now);
    // the first guest to find them all is announced on air (once a party): the station's own news, read at the next break
    const total = Number(this.one("SELECT COUNT(*) AS n FROM medals WHERE device=?", device)?.n ?? 0);
    if (total >= MEDALS.length && !this.setting("huntFirst", "")) {
      const who = String(this.one("SELECT name FROM names WHERE device=?", device)?.name ?? "").replace(/ \d+$/, "") || "One of you";
      this.set("huntFirst", device);
      const id = "j" + this.newId().slice(1);
      this.sql.exec(`INSERT INTO jokes(id,device,name,text,status,created_at,kind,urgent,source)
        VALUES(?, 'host', 'the host', ?, 'pending', ?, 'announcement', 0, 'host')`, id,
        `Stop the presses: ${who} is the first tonight to find every medal in the WORR scavenger hunt, and wins the golden quarter. A round of applause for our champion!`, Date.now());
    }
    return { ok: true, hunt: this.hunt(device) };
  }

  private hunt(device: string) {
    const got = this.all("SELECT medal, at FROM medals WHERE device=? ORDER BY at", device).map((m) => ({ id: String(m.medal), at: Number(m.at) }));
    const x = this.extra(device);
    return { medals: got, total: MEDALS.length, golden: x.golden ? "ready" : x.goldenUsed ? "used" : "none", coins: x.coins };
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

  /** Seconds until each waiting song starts, and until a song this phone asked for now would start
   *  (fair turns can put it ahead of the end of the line). From what's already known: the time left on
   *  air, then each song's length plus the DJ's talk, plus the messages waiting. A ballpark: the page
   *  rounds it and only changes what it shows when it moves by minutes. */
  private waits(waiting: Row[], device: string, endsInS: number | null) {
    const msgs = Number(this.one("SELECT COUNT(*) AS n FROM jokes WHERE status IN ('pending','preparing','ready')")?.n ?? 0);
    const at = new Map<string, number>();
    let t = endsInS ?? 0;
    const spread = waiting.length ? (msgs * JOKE_S) / waiting.length : 0;   // messages go in at song changes
    for (const i of waiting) {
      at.set(String(i.id), Math.round(Math.max(t, i.status === "pending" || i.status === "preparing" ? PREP_S : 0)));
      const len = Number(i.duration_s) > 0 ? Number(i.duration_s) : Number(i.duration_ms) > 0 ? Number(i.duration_ms) / 1000 : 210;
      t += len + TALK_S + spread;
    }
    // whose song is whose, for fair turns: read at most every 20 s (every phone polls; an estimate can lag)
    if (!this.turns || Date.now() - this.turns.at > 20_000) this.turns = { at: Date.now(), ordered: this.ordered() };
    const rank = rankForNew(this.turns.ordered, device);
    const ahead = waiting.filter((i) => i.status === "queued" || Number(i.rank) < rank).length;
    const next = ahead < waiting.length ? at.get(String(waiting[ahead].id))! : t;
    return { at, newS: Math.round(Math.max(next, PREP_S)) };
  }

  async guestState(device: string, known = true) {   // known: a phone with an id we issued (only those join the guest list)
    const nowMs = Date.now();
    if (known && nowMs - (this.seenAt.get(device) ?? 0) > 60_000) {   // the host's guest list: first and last seen
      if (this.seenAt.size > 2000) this.seenAt.clear();   // a memo of recent writes, not a record: never let it grow
      this.seenAt.set(device, nowMs);
      this.sql.exec("INSERT INTO devices(device, first_at, last_at) VALUES(?,?,?) ON CONFLICT(device) DO UPDATE SET last_at=excluded.last_at",
        device, nowMs, nowMs);
    }
    const waiting = this.display();
    const np = this.nowPlaying();
    const est = this.waits(waiting, device, np && !np.soma ? (np as { endsInS: number | null }).endsInS : null);
    // newest of this phone's own asks first (joining an older song puts it at the top too)
    const mine = this.all(`SELECT i.*, MAX(r.created_at) AS mine_at FROM items i JOIN requesters r ON r.item_id=i.id
      WHERE r.device=? GROUP BY i.id ORDER BY mine_at DESC LIMIT 8`, device);
    // how often this phone has asked for each of its songs, in one pass over its own asks
    const asked = this.all(`SELECT i.song_key AS k, MIN(i.title) AS title, MIN(i.artist) AS artist, COUNT(*) AS n
      FROM requesters r JOIN items i ON i.id=r.item_id WHERE r.device=? GROUP BY i.song_key`, device);
    const askedN = new Map(asked.map((a) => [String(a.k), Number(a.n)]));
    return {
      nowPlaying: np,
      waitS: est.newS,   // a request sent now: roughly when it starts, in seconds from now
      hunt: this.hunt(device),
      kicked: Number(this.one("SELECT at FROM kicked WHERE device=?", device)?.at ?? 0) || null,   // the host sent this phone back to the start
      named: Boolean(this.one("SELECT 1 AS x FROM names WHERE device=?", device)),   // false after a reset: the page claims its name again
      upNext: this.lineup(waiting.slice(0, 6).map((i) => this.pub(i))),
      waitingCount: waiting.length,
      mine: mine.map((i) => ({ ...this.pub(i), status: String(i.status), skipped: Boolean(i.skipped),
        position: waiting.findIndex((w) => w.id === i.id) + 1 || null,
        waitS: est.at.get(String(i.id)) ?? null,
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
      limits: { freePlay: this.flags().freePlay, songs: this.songLimit(device), ...this.messageLimit(device),
                ...(() => { const p = this.padLimit(device), f = this.flags();
                            return { padsOff: !f.padGapS, padInS: f.freePlay ? 0 : p.padInS, padShareInS: f.freePlay ? 0 : p.partyPadInS }; })() },
    };
  }

  /** Family mode, for the record sleeve's lyrics (rude words starred out). */
  async familyMode() { return this.flags().familyMode; }

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
    // a joke that waited half an hour is stale: dropped, and the guest may send another (free play: none expire)
    if (!this.flags().freePlay)
      this.sql.exec(`UPDATE jokes SET status='expired', ended_at=? WHERE status IN ('pending','ready') AND urgent=0
        AND kind='joke' AND created_at<?`, now, now - JOKE_STALE_MS);
    for (const id of Array.isArray(b.jokesPlayed) ? b.jokesPlayed : [])
      this.sql.exec("UPDATE jokes SET status='played', played_at=?, ended_at=? WHERE id=? AND status IN ('ready','deleted')", now, now, String(id));
    for (const a of Array.isArray(b.aired) ? b.aired.slice(0, 20) : [])   // bumpers the studio played (re-sent until acked)
      if (a && typeof a.kind === "string" && Number.isFinite(Number(a.at)))
        this.sql.exec("INSERT OR IGNORE INTO airlog(kind, text, at) VALUES(?,?,?)", a.kind.slice(0, 20), clean(a.text ?? "", 400), Number(a.at));
    // urgent announcements first (written up and told before anything else), then in the order sent
    const jokeJobs = this.all("SELECT id, name, text, kind, urgent, source, anon FROM jokes WHERE status='pending' ORDER BY urgent DESC, kind='announcement' DESC, created_at LIMIT ?",
      Math.max(0, Math.min(2, Number(b.wantJokes) || 0))).map((j) => {
      this.sql.exec("UPDATE jokes SET status='preparing', lease_until=? WHERE id=?", now + LEASE_MS, j.id);
      return { id: String(j.id), name: Number(j.anon) ? MYSTERY : String(j.name), text: String(j.text), kind: String(j.kind ?? "joke"),
               urgent: Boolean(j.urgent), source: String(j.source ?? "guest") };
    });
    const nj = this.one("SELECT id, file, seconds, script, kind, urgent FROM jokes WHERE status='ready' ORDER BY urgent DESC, kind='announcement' DESC, created_at LIMIT 1");
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
    if (Math.random() < .02)   // now and then: done commands older than an hour go (a pad press is a row; they only grew)
      this.sql.exec("DELETE FROM commands WHERE done=1 AND created_at<?", now - 3_600_000);
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
    // the studio doubts it's a real song ("%%%" found a kids' clip): the host decides. The studio checks every
    // request, not just typed-in ones: the page says which it was, and a guest can say otherwise
    const held = r.status === "ready" && typeof r.hold === "string" && r.hold.trim() !== "";
    if (r.status === "ready" && item.redo) {
      this.sql.exec("UPDATE items SET status='pending', redo=0, redos=COALESCE(redos,0)+1, lease_until=0 WHERE id=?", r.id);
      return { ok: true, redo: true };
    }
    this.sql.exec(`UPDATE items SET status=?, file=?, duration_s=?, confidence=?, dj_line=?, tone=?,
      voice=?, error=?, match_note=?, lease_until=0, ended_at=? WHERE id=?`, held ? "held" : r.status, r.file ?? null, r.durationS ?? null,
      r.confidence ?? null, r.djLine ?? null, r.tone ?? null, r.voice ?? null, held ? clean(r.hold, 200) : r.error ?? null,
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
    const line = this.display(), waitingN = line.length;
    const items = [
      ...this.all("SELECT * FROM items WHERE status='playing'"),
      ...line,
      // the last few finished, newest first ("+status": walk the ended_at index, stop after 15 rows)
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
      code: "worr-1",
      party: { start: Number(this.setting("partyStart", "0")) || null, end: Number(this.setting("partyEnd", "0")) || null },         // read back after a deploy: proves the queue runs this code (no bump needed)
      settings: this.flags(),
      jokes: [...this.all("SELECT * FROM jokes WHERE status IN ('pending','preparing','ready') ORDER BY urgent DESC, kind='announcement' DESC, created_at"),
              ]
        .map((j) => this.adminJoke(j)),
      items: items.map((i) => this.adminItem(i)),
      held: this.all("SELECT * FROM items WHERE status='held' ORDER BY created_at").map((i) => this.adminItem(i)),
      line: { songs: waitingN, oneEach: !this.flags().freePlay && waitingN > LONG_LINE },
    };
  }
  /** The night so far, since the host pressed Start party (or since the first request). */
  private partyStats() {
    const start = Number(this.setting("partyStart", "0")) || Number(this.one("SELECT MIN(created_at) AS t FROM items")?.t ?? 0);   // no party clock yet: the whole night
    const end = Number(this.setting("partyEnd", "0")) || Date.now();
    const n = (q: string, ...b: SqlStorageValue[]) => Number(this.one(q, ...b)?.n ?? 0);
    const waits = this.all(`SELECT started_at - created_at AS w FROM items WHERE status='played' AND started_at>0 AND created_at>=?
      ORDER BY w`, start).map((r) => Number(r.w));
    return {
      start, end,
      played: n("SELECT COUNT(*) AS n FROM items WHERE status='played' AND skipped=0 AND played_at BETWEEN ? AND ?", start, end),
      skipped: n("SELECT COUNT(*) AS n FROM items WHERE status='played' AND skipped=1 AND played_at BETWEEN ? AND ?", start, end),
      requests: n("SELECT COUNT(*) AS n FROM requesters WHERE created_at BETWEEN ? AND ?", start, end),
      guests: n(`SELECT COUNT(*) AS n FROM (SELECT device FROM requesters WHERE created_at BETWEEN ?1 AND ?2 AND device<>'admin'
                 UNION SELECT device FROM jokes WHERE created_at BETWEEN ?1 AND ?2 AND source='guest')`, start, end),
      messages: n("SELECT COUNT(*) AS n FROM jokes WHERE status='played' AND played_at BETWEEN ? AND ?", start, end),
      medianWaitMin: waits.length ? Math.round(waits[Math.floor(waits.length / 2)] / 60000) : null,
      orrdle: this.orrdleHouse(start),
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
    action: string; id?: string; dir?: -1 | 1; title?: string; device?: string; pad?: number; track?: Track; name?: string; text?: string;
    message?: string; settings?: Partial<Record<"accepting" | "stopAfterCurrent" | "somaOnly" | "freePlay" | "familyMode" | "stationOff", boolean>> & { breakEveryMin?: number; padGapS?: number };
  }) {
    const status = a.id ? String(this.one("SELECT status FROM items WHERE id=?", a.id)?.status ?? "") : "";
    switch (a.action) {
      case "skip":
        this.skip();
        return { ok: true };
      case "break":
        this.command("break");
        return { ok: true };
      case "pad": {   // a sound pad, 1 to 8: played on the console's fx channel
        const n = typeof a.pad === "number" ? a.pad : NaN;
        if (!Number.isInteger(n) || n < 1 || n > 8) return { ok: false, error: "no such pad" };
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
      case "guests": {   // every phone that opened the page this party, newest visit first
        // a kicked phone drops off the list until it's seen again (a poll after the kick)
        const list = this.all(`SELECT d.* FROM devices d LEFT JOIN kicked k ON k.device=d.device
          WHERE k.at IS NULL OR d.last_at > k.at ORDER BY d.last_at DESC LIMIT 300`).map((d) => {
          const dev = String(d.device), n = (q: string) => Number(this.one(q, dev)?.n ?? 0);
          const reg = this.one("SELECT name FROM names WHERE device=?", dev)?.name;   // the name it goes by now (none after a kick)
          const names = reg ? [String(reg)] : [];
          const x = this.extra(dev);
          return { device: dev, names, firstAt: Number(d.first_at), lastAt: Number(d.last_at),
                   requests: n("SELECT COUNT(*) AS n FROM requesters WHERE device=?"),
                   played: n("SELECT COUNT(*) AS n FROM requesters r JOIN items i ON i.id=r.item_id WHERE r.device=? AND i.status='played'"),
                   waiting: n(`SELECT COUNT(*) AS n FROM requesters r JOIN items i ON i.id=r.item_id WHERE r.device=? AND i.status IN ${WAITING}`),
                   messages: n("SELECT COUNT(*) AS n FROM jokes WHERE device=?"),
                   orrdle: n("SELECT COUNT(*) AS n FROM orrdle WHERE device=?"),
                   medals: n("SELECT COUNT(*) AS n FROM medals WHERE device=?"),
                   coins: x.coins, golden: x.golden ? "ready" : x.goldenUsed ? "used" : "none",
                   muted: Boolean(this.one("SELECT 1 AS m FROM muted WHERE device=?", dev)),
                   locked: this.songLimit(dev).locked };
        });
        return { ok: true, guests: list, medals: MEDALS.length };
      }
      case "giveCoin":   // one more song for this phone, on the house
        if (!a.device) return { ok: false, error: "no such phone" };
        this.sql.exec("INSERT INTO bonus(device, coins) VALUES(?,1) ON CONFLICT(device) DO UPDATE SET coins=coins+1", a.device);
        return { ok: true };
      case "takeCoin":
        this.sql.exec("UPDATE bonus SET coins=coins-1 WHERE device=? AND coins>0", a.device ?? "");
        return { ok: true };
      case "kick": {   // this phone starts over: its waiting songs and messages go, its picks are fresh, and the page forgets its name
        const dev = String(a.device ?? "");
        if (!dev) return { ok: false, error: "no such phone" };
        const solo = `SELECT item_id FROM requesters GROUP BY item_id HAVING COUNT(*)=1 AND MAX(device)=?`;
        const inConsole = this.one(`SELECT 1 AS q FROM items WHERE status='queued' AND id IN (${solo})`, dev);
        this.sql.exec(`UPDATE items SET status='deleted', ended_at=? WHERE status IN ('pending','preparing','ready','queued','held') AND id IN (${solo})`, Date.now(), dev);
        if (inConsole) this.command("clear");
        this.sql.exec(`DELETE FROM requesters WHERE device=? AND item_id IN (SELECT id FROM items WHERE status IN ('pending','preparing','ready','queued','held'))`, dev);   // shared songs: just their name off
        this.sql.exec("UPDATE jokes SET status='deleted', ended_at=? WHERE device=? AND status IN ('pending','preparing','ready')", Date.now(), dev);
        this.sql.exec("DELETE FROM song_locks WHERE device=?", dev);
        this.sql.exec("INSERT INTO song_release(device, at) VALUES(?,?) ON CONFLICT(device) DO UPDATE SET at=excluded.at", dev, Date.now());
        const had = this.one("SELECT name FROM names WHERE device=?", dev)?.name ?? null;
        this.sql.exec("DELETE FROM names WHERE device=?", dev);
        this.sql.exec("INSERT INTO kicked(device, at, name) VALUES(?,?,?) ON CONFLICT(device) DO UPDATE SET at=excluded.at, name=excluded.name", dev, Date.now(), had);
        this.seenAt.delete(dev);   // its next poll is written at once, so it shows again as soon as it's back
        return { ok: true };
      }
      case "resetHunt":   // this phone's medals and golden quarter, from scratch
        this.sql.exec("DELETE FROM medals WHERE device=?", a.device ?? "");
        this.sql.exec("UPDATE bonus SET golden_used=0 WHERE device=?", a.device ?? "");
        return { ok: true };
      case "partyStart":   // the host's party clock: from now (a restart starts it over)
        this.set("partyStart", String(Date.now()));
        this.sql.exec("DELETE FROM settings WHERE key='partyEnd'");
        return { ok: true };
      case "partyEnd": {   // the clock stops, and the night goes in the archive under the host's title
        const start = Number(this.setting("partyStart", "0"));
        if (!start || Number(this.setting("partyEnd", "0"))) return { ok: false, error: "No party is running." };
        const end = Date.now();
        this.set("partyEnd", String(end));
        const title = clean(a.title, 80) || `Party of ${new Date(start).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}`;
        this.sql.exec("INSERT INTO parties(title, start, end, stats) VALUES(?,?,?,?)", title, start, end, JSON.stringify(this.partyStats()));
        return { ok: true };
      }
      case "deleteParty":   // one archived night, gone for good
        this.sql.exec("DELETE FROM parties WHERE id=?", Number(a.id));
        return { ok: true };
      case "archive":   // every party ended so far, oldest first (a wipe never touches these)
        return { ok: true, parties: this.all("SELECT * FROM parties ORDER BY start").map((p) => ({
          id: Number(p.id), title: String(p.title), start: Number(p.start), end: Number(p.end), stats: JSON.parse(String(p.stats)) })) };
      case "stats":   // asked for by the admin page about once a minute, not with every poll: it reads the whole night
        return { ok: true, stats: this.partyStats() };
      case "dropJokes": {   // every guest joke still waiting (announcements stay)
        this.sql.exec(`UPDATE jokes SET status='deleted', ended_at=? WHERE status IN ('pending','preparing','ready')
          AND kind='joke'`, Date.now());
        return { ok: true };
      }
      case "approve": {   // a held request: into the line, at the end, ready to play
        if (status !== "held") return { ok: false, error: "That one isn't waiting for you." };
        const last = Number(this.one(`SELECT MAX(rank) AS r FROM items WHERE status IN ${WAITING}`)?.r ?? 0);
        this.sql.exec("UPDATE items SET status='ready', rank=? WHERE id=?", last + 1, a.id!);
        return { ok: true };
      }
      case "replay":   // the DJ read of the song on air, over the PA again
        if (status !== "playing") return { ok: false, error: "Only the song on air can be replayed." };
        this.command("replay", a.id!);
        return { ok: true };
      case "reset": {   // a fresh party: every song, guest, message and limit goes; settings and the id counter stay
        this.seenAt.clear();
        this.sql.exec("DELETE FROM settings WHERE key='huntFirst'");   // the scavenger hunt's first finisher is announced again
        this.flagsMemo = null; this.turns = null;   // and the wait estimates forget the old line
        const onAir = this.one("SELECT id FROM items WHERE status='playing' LIMIT 1");
        const held = this.one("SELECT 1 AS q FROM items WHERE status='queued' LIMIT 1");
        for (const t of ["items", "requesters", "muted", "song_locks", "song_release", "pad_presses", "airlog", "jokes", "commands", "orrdle", "medals", "bonus", "devices", "kicked", "names"])
          this.sql.exec(`DELETE FROM ${t}`);
        if (onAir) this.command("skip", String(onAir.id));   // the console drops the old party's song and pushed item
        if (held) this.command("clear");
        return { ok: true };
      }
      case "delete":
        if (!status) return { ok: false, error: "no such request" };
        if (!["pending", "preparing", "ready", "queued", "playing", "held"].includes(status)) return { ok: true };   // already gone
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
      case "add":
        return this.submit("admin", { track: a.track!, name: a.name ?? "", message: a.message ?? "" }, true);
      case "mute": {
        if (typeof a.device !== "string" || !a.device) return { ok: false, error: "no such phone" };
        this.sql.exec("INSERT OR IGNORE INTO muted(device) VALUES(?)", a.device);
        const solo = `SELECT item_id FROM requesters GROUP BY item_id HAVING COUNT(*)=1 AND MAX(device)=?`;
        const inConsole = this.one(`SELECT 1 AS q FROM items WHERE status='queued' AND id IN (${solo})`, a.device);
        this.sql.exec(`UPDATE items SET status='deleted', ended_at=? WHERE status IN ('pending','preparing','ready','queued','held')
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
        if (PAD_GAPS_S.includes(a.settings?.padGapS as number)) this.set("padGapS", String(a.settings!.padGapS));
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
    this.sql.exec("UPDATE orrdle SET name='', device=''");
    this.sql.exec("DELETE FROM names"); this.sql.exec("UPDATE kicked SET name=NULL");
    // the archive keeps the numbers, not who: Orrdle's best and most-wins names go
    for (const p of this.all("SELECT id, stats FROM parties")) {
      const st = JSON.parse(String(p.stats));
      const o = st?.orrdle;
      if (o) {
        for (const k of ["fastest", "fewest"]) if (o[k]) o[k].name = "a guest";
        if (Array.isArray(o.top)) o.top = o.top.map((x: { name: string }) => ({ ...x, name: "a guest" }));
      }
      this.sql.exec("UPDATE parties SET stats=? WHERE id=?", JSON.stringify(st), p.id);
    }
    this.sql.exec("DELETE FROM settings WHERE key='health'");
  }
}
