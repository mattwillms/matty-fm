// The one Durable Object ("party"): queue, settings, studio beats, admin actions.
import { DurableObject } from "cloudflare:workers";
import { clean, displayText, namesPhrase, rankForNew, safeArtwork, songKey, swapRanks, type Waiting } from "./queue";
import type { Track } from "./search";

const WAITING = "('pending','preparing','ready','queued')";
const LEASE_MS = 120_000;
const OFFLINE_MS = 60_000;
const PURGE_AFTER_MS = 3 * 24 * 3600_000;
const MAX_WAITING_PER_DEVICE = 2;
const QUEUED_GRACE_MS = 15_000;

type Row = Record<string, SqlStorageValue>;
export type SubmitIn = { track: Track; name: string; message?: string; freeText?: boolean };
export type Beat = {
  source: string; current: string; remaining: number; queued: number;
  pushed: string[]; working: string[]; want: number; ack: number[]; error: string;
  wantNext?: boolean;   // the studio is ready to push a song right now
  soma?: { artist: string; title: string; since: number; artwork?: string } | null;   // SomaFM's current song (its public feed)
};
export type Result = {
  id: string; status: "ready" | "failed"; file?: string; durationS?: number; confidence?: number;
  djLine?: string; tone?: string; voice?: string; error?: string;
};

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
        error TEXT, played_at INTEGER, queued_at INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS requesters(
        id INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT NOT NULL, device TEXT NOT NULL,
        name TEXT NOT NULL, message TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS muted(device TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS commands(
        id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, done INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL);`);
    try {
      this.sql.exec("ALTER TABLE items ADD COLUMN queued_at INTEGER DEFAULT 0");
    } catch {
      // column already exists
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
    };
  }
  private command(type: "skip" | "clear" | "break"): void {
    this.sql.exec("INSERT INTO commands(type,created_at) VALUES(?,?)", type, Date.now());
  }
  private newId(): string {
    const n = Number(this.setting("seq", "0")) + 1;
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
             artist: hidden ? "" : String(i.artist), artwork: String(i.artwork ?? ""), names: namesPhrase(names) };
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
  async submit(device: string, s: SubmitIn, asAdmin = false) {
    if (!asAdmin && !this.flags().accepting) return { ok: false, error: "Requests are closed for tonight." };
    if (!asAdmin && this.one("SELECT 1 AS m FROM muted WHERE device=?", device))
      return { ok: false, error: "Requests are paused for this phone." };
    const name = clean(s.name, 40), message = clean(s.message ?? "", 280);
    const title = clean(s.track?.title, 200), artist = clean(s.track?.artist, 200);
    if (!name || !title || !artist) return { ok: false, error: "Pick a song and add your name." };
    if (!asAdmin) {
      const n = Number(this.one(`SELECT COUNT(*) AS n FROM requesters r JOIN items i ON i.id=r.item_id
        WHERE r.device=? AND i.status IN ${WAITING}`, device)?.n ?? 0);
      if (n >= MAX_WAITING_PER_DEVICE)
        return { ok: false, error: "You have 2 songs waiting. Once one plays, add another!" };
    }
    const key = songKey(artist, title);
    const now = Date.now();
    const dup = this.one(`SELECT id,status FROM items WHERE song_key=? AND status IN ${WAITING} ORDER BY rank LIMIT 1`, key);
    let id: string;
    if (dup) {
      id = String(dup.id);
      if (dup.status === "ready") this.sql.exec("UPDATE items SET status='pending' WHERE id=?", id);
      if (dup.status === "preparing") this.sql.exec("UPDATE items SET redo=1 WHERE id=?", id);
    } else {
      id = this.newId();
      const t = s.track;
      this.sql.exec(`INSERT INTO items(id,song_key,title,artist,album,duration_ms,artwork,explicit,free_text,status,rank,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,'pending',?,?)`, id, key, title, artist, clean(t.album ?? "", 200),
        Number(t.durationMs) || null, safeArtwork(t.artwork), t.explicit ? 1 : 0, s.freeText ? 1 : 0,
        rankForNew(this.ordered(), device), now);
    }
    this.sql.exec("INSERT INTO requesters(item_id,device,name,message,created_at) VALUES(?,?,?,?,?)",
      id, device, name, message, now);
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(now + PURGE_AFTER_MS);
    return { ok: true, id, position: this.display().findIndex((i) => i.id === id) + 1 };
  }

  private nowPlaying() {
    const playing = this.one("SELECT * FROM items WHERE status='playing' LIMIT 1");
    const h = this.health() as unknown as Beat & { at: number };
    if (playing) return this.pub(playing);
    if (h.soma && h.source !== "requests")
      return { id: "soma", title: String(h.soma.title), artist: String(h.soma.artist),
               artwork: safeArtwork((h.soma as { artwork?: string }).artwork), names: "", soma: true };
    return null;
  }

  async guestState(device: string) {
    const waiting = this.display();
    const mine = this.all(`SELECT DISTINCT i.* FROM items i JOIN requesters r ON r.item_id=i.id
      WHERE r.device=? ORDER BY i.created_at DESC LIMIT 6`, device);
    return {
      nowPlaying: this.nowPlaying(),
      upNext: waiting.slice(0, 6).map((i) => this.pub(i)),
      mine: mine.map((i) => ({ ...this.pub(i), status: String(i.status),
        position: waiting.findIndex((w) => w.id === i.id) + 1 || null })),
      accepting: this.flags().accepting,
      djOnBreak: Date.now() - this.health().at > OFFLINE_MS,
    };
  }

  // ---------- studio ----------
  async beat(b: Beat) {
    const now = Date.now();
    this.set("health", JSON.stringify({ ...b, at: now }));
    for (const c of b.ack ?? []) this.sql.exec("UPDATE commands SET done=1 WHERE id=?", c);
    for (const id of b.pushed ?? [])
      this.sql.exec("UPDATE items SET status='queued', queued_at=? WHERE id=? AND status IN ('ready','queued')", now, id);
    for (const id of b.working ?? []) this.sql.exec("UPDATE items SET lease_until=? WHERE id=? AND status='preparing'", now + LEASE_MS, id);

    if (b.source === "requests" && b.current) {
      this.sql.exec("UPDATE items SET status='played', played_at=? WHERE status='playing' AND id<>?", now, b.current);
      this.sql.exec("UPDATE items SET status='playing' WHERE id=? AND status IN ('queued','ready')", b.current);
    } else {
      this.sql.exec("UPDATE items SET status='played', played_at=? WHERE status='playing'", now);
    }
    this.sql.exec("UPDATE items SET status='pending', lease_until=0 WHERE status='preparing' AND lease_until<?", now);

    // The station holds nothing, yet an item is marked queued and was not just pushed:
    // the station restarted, a push failed, or a clear dropped it. Put it back in line.
    if ((b.queued ?? 0) === 0) {
      for (const q of this.all("SELECT id FROM items WHERE status='queued' AND queued_at<?", now - QUEUED_GRACE_MS)) {
        if (q.id !== b.current && !(b.pushed ?? []).includes(String(q.id)))
          this.sql.exec("UPDATE items SET status='ready' WHERE id=?", q.id);
      }
    }

    const jobs = [];
    for (const i of this.all(`SELECT * FROM items WHERE status='pending' ORDER BY rank LIMIT ?`, Math.max(0, b.want ?? 0))) {
      this.sql.exec("UPDATE items SET status='preparing', lease_until=?, redo=0 WHERE id=?", now + LEASE_MS, i.id);
      jobs.push(this.studioItem(i));
    }
    const f = this.flags();
    // Hand out the next song only when the studio will push it now, and mark it queued
    // immediately so a delete, move or duplicate in the next few seconds sees it as "in the station".
    const next = !b.wantNext || f.somaOnly || f.stopAfterCurrent
      ? undefined
      : this.one("SELECT * FROM items WHERE status='ready' ORDER BY rank LIMIT 1");
    if (next) this.sql.exec("UPDATE items SET status='queued', queued_at=? WHERE id=?", now, next.id);
    return {
      commands: this.all("SELECT id,type FROM commands WHERE done=0 ORDER BY id")
        .map((c) => ({ id: Number(c.id), type: String(c.type) })),
      settings: { somaOnly: f.somaOnly, stopAfterCurrent: f.stopAfterCurrent },
      next: next ? this.studioItem(next) : null,
      jobs,
    };
  }

  async result(r: Result) {
    const item = this.one("SELECT status,redo FROM items WHERE id=?", r.id);
    if (!item || item.status !== "preparing") return { ok: false };
    if (r.status === "ready" && item.redo) {
      this.sql.exec("UPDATE items SET status='pending', redo=0, lease_until=0 WHERE id=?", r.id);
      return { ok: true, redo: true };
    }
    this.sql.exec(`UPDATE items SET status=?, file=?, duration_s=?, confidence=?, dj_line=?, tone=?,
      voice=?, error=?, lease_until=0 WHERE id=?`, r.status, r.file ?? null, r.durationS ?? null,
      r.confidence ?? null, r.djLine ?? null, r.tone ?? null, r.voice ?? null, r.error ?? null, r.id);
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
      settings: this.flags(),
      items: items.map((i) => ({
        id: String(i.id), title: String(i.title), artist: String(i.artist), status: String(i.status),
        confidence: i.confidence == null ? null : Number(i.confidence), djLine: i.dj_line, tone: i.tone,
        voice: i.voice, error: i.error, freeText: Boolean(i.free_text), explicit: Boolean(i.explicit),
        requesters: this.requesters(String(i.id)),
      })),
    };
  }

  async adminAction(a: {
    action: string; id?: string; dir?: -1 | 1; device?: string; track?: Track; name?: string;
    message?: string; settings?: Partial<Record<"accepting" | "stopAfterCurrent" | "somaOnly", boolean>>;
  }) {
    const status = a.id ? String(this.one("SELECT status FROM items WHERE id=?", a.id)?.status ?? "") : "";
    switch (a.action) {
      case "skip":
        this.command("skip");
        return { ok: true };
      case "break":
        this.command("break");
        return { ok: true };
      case "delete":
        this.sql.exec("UPDATE items SET status='deleted' WHERE id=?", a.id!);
        if (status === "queued") this.command("clear");
        if (status === "playing") this.command("skip");
        return { ok: true };
      case "move": {
        const pairs = swapRanks(this.ordered(), a.id!, a.dir === -1 ? -1 : 1);
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
        const last = Number(this.one(`SELECT MAX(rank) AS r FROM items WHERE status IN ${WAITING}`)?.r ?? 0);
        this.sql.exec(`UPDATE items SET status=CASE WHEN file IS NOT NULL AND status='played' THEN 'ready' ELSE 'pending' END,
          rank=?, played_at=NULL, error=NULL WHERE id=? AND status IN ('played','failed','deleted')`, last + 1, a.id!);
        return { ok: true };
      }
      case "retry":
        this.sql.exec("UPDATE items SET status='pending', error=NULL WHERE id=? AND status='failed'", a.id!);
        return { ok: true };
      case "add":
        return this.submit("admin", { track: a.track!, name: a.name ?? "", message: a.message ?? "" }, true);
      case "mute":
        this.sql.exec("INSERT OR IGNORE INTO muted(device) VALUES(?)", a.device!);
        this.sql.exec(`UPDATE items SET status='deleted' WHERE status IN ('pending','preparing','ready')
          AND id IN (SELECT item_id FROM requesters GROUP BY item_id HAVING COUNT(*)=1 AND MAX(device)=?)`, a.device!);
        return { ok: true };
      case "unmute":
        this.sql.exec("DELETE FROM muted WHERE device=?", a.device!);
        return { ok: true };
      case "settings":
        for (const [k, v] of Object.entries(a.settings ?? {})) {
          if (["accepting", "stopAfterCurrent", "somaOnly"].includes(k)) this.set(k, v ? "1" : "0");
        }
        if (a.settings?.somaOnly || a.settings?.stopAfterCurrent) {
          this.command("clear");
          this.sql.exec("UPDATE items SET status='ready' WHERE status='queued'");
        }
        return { ok: true };
    }
    return { ok: false, error: "unknown action" };
  }

  // Names and messages are personal data: wipe them three days after the first request.
  async alarm() {
    this.sql.exec("DELETE FROM requesters");
    this.sql.exec("UPDATE items SET dj_line=NULL");
  }
}
