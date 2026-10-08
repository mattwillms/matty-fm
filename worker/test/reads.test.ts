// Rows read per poll, on a party-sized queue. Cloudflare bills every row a query looks at; the
// studio beat and the admin page each poll every 3 s, so a full-table scan here costs millions a day.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Party } from "../src/party";

const stub = (name: string) => env.PARTY.get(env.PARTY.idFromName(name));
const beat = { source: "soma", current: "", remaining: -1, queued: 0, pushed: [] as string[], working: [] as string[], want: 0, ack: [] as number[], error: "" };

/** Fills the queue like the end of a long party: hundreds of finished songs, jokes, bumpers and commands. */
async function seed(name: string) {
  const p = stub(name);
  await runInDurableObject(p, async (_i: Party, s) => {
    const q = s.storage.sql, t = Date.now() - 6 * 3_600_000;
    for (let n = 0; n < 400; n++) {
      const status = n < 380 ? "played" : n < 385 ? "ready" : "pending";
      q.exec(`INSERT INTO items(id,song_key,title,artist,status,rank,created_at,played_at,ended_at,duration_s,file)
        VALUES(?,?,?,?,?,?,?,?,?,200,?)`, `r${n}`, `k${n}`, `Song ${n}`, "Band", status, n, t + n * 1000,
        status === "played" ? t + n * 1000 : null, status === "played" ? t + n * 1000 : null, `r${n}.mp3`);
      for (const d of [`d${n % 40}`, `d${(n + 1) % 40}`])
        q.exec("INSERT INTO requesters(item_id,device,name,message,created_at) VALUES(?,?,?,?,?)", `r${n}`, d, "Kin", "", t + n * 1000);
    }
    for (let n = 0; n < 150; n++)
      q.exec(`INSERT INTO jokes(id,device,name,text,status,created_at,ended_at) VALUES(?,?,?,?,?,?,?)`,
        `j${n}`, `d${n % 40}`, "Kin", "joke", n < 145 ? "played" : "ready", t + n * 1000, n < 145 ? t + n * 1000 : null);
    for (let n = 0; n < 300; n++) q.exec("INSERT INTO airlog(kind,text,at) VALUES(?,?,?)", "goof", "line", t + n * 1000);
    for (let n = 0; n < 1500; n++) q.exec("INSERT INTO commands(type,created_at,done) VALUES('clear',?,1)", t + n * 1000);
  });
  return p;
}

/** Runs one call and counts the rows its queries read (every cursor, SELECT or UPDATE). */
async function rowsRead(p: ReturnType<typeof stub>, call: (i: Party) => Promise<unknown>) {
  return runInDurableObject(p, async (i: Party) => {
    const q = (i as unknown as { sql: SqlStorage }).sql, exec = q.exec.bind(q), cursors: SqlStorageCursor<Record<string, SqlStorageValue>>[] = [];
    (q as { exec: unknown }).exec = (...a: Parameters<SqlStorage["exec"]>) => { const c = exec(...a); cursors.push(c); return c; };
    try {
      await call(i);
    } finally {
      (q as { exec: unknown }).exec = exec;
    }
    return cursors.reduce((n, c) => n + c.rowsRead, 0);
  });
}

describe("rows read per poll", () => {
  it("stay small on a full queue", async () => {
    const p = await seed("reads");
    const counts = {
      beat: await rowsRead(p, (i) => i.beat({ ...beat })),
      guest: await rowsRead(p, (i) => i.guestState("d3")),
      admin: await rowsRead(p, (i) => i.adminState()),
    };
    console.log("rows read", counts);
    expect(counts.beat).toBeLessThan(60);
    expect(counts.guest).toBeLessThan(350);   // this phone has 20 asks: more than a guest makes all night
    expect(counts.admin).toBeLessThan(500);
  });
});
