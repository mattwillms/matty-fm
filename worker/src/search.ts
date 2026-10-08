// Song search: iTunes (no explicit tracks since 2025) merged with Deezer (has them).
import { songKey } from "./queue";

export type Track = {
  title: string; artist: string; album: string; durationMs: number | null;
  explicit: boolean; artwork: string; source: "itunes" | "deezer";
};

type Any = Record<string, any>;

export function parseItunes(json: unknown): Track[] {
  const rows = (json as Any)?.results;
  if (!Array.isArray(rows)) return [];
  return rows.filter((r: Any) => r?.trackName && r?.artistName).map((r: Any) => ({
    title: String(r.trackName), artist: String(r.artistName), album: String(r.collectionName ?? ""),
    durationMs: Number(r.trackTimeMillis) || null, explicit: r.trackExplicitness === "explicit",
    artwork: String(r.artworkUrl100 ?? "").replace("100x100", "200x200"), source: "itunes" as const,
  }));
}

export function parseDeezer(json: unknown): Track[] {
  const rows = (json as Any)?.data;
  if (!Array.isArray(rows)) return [];
  return rows.filter((r: Any) => r?.title && r?.artist?.name).map((r: Any) => ({
    title: String(r.title), artist: String(r.artist.name), album: String(r.album?.title ?? ""),
    durationMs: Number(r.duration) ? Number(r.duration) * 1000 : null, explicit: Boolean(r.explicit_lyrics),
    artwork: String(r.album?.cover_medium ?? ""), source: "deezer" as const,
  }));
}

export function mergeTracks(a: Track[], b: Track[], limit = 12): Track[] {
  const seen = new Set<string>();
  const out: Track[] = [];
  for (const t of [...a, ...b]) {
    const k = songKey(t.artist, t.title);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out.slice(0, limit);
}

async function getJson(fetcher: typeof fetch, url: string): Promise<unknown> {
  try {
    const r = await fetcher(url, { signal: AbortSignal.timeout(4000) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

export async function searchAll(q: string, fetcher: typeof fetch = fetch): Promise<Track[]> {
  const term = encodeURIComponent(q);
  const [it, dz] = await Promise.all([
    getJson(fetcher, `https://itunes.apple.com/search?term=${term}&media=music&entity=song&limit=10&country=US`),
    getJson(fetcher, `https://api.deezer.com/search?q=${term}&limit=10`),
  ]);
  return mergeTracks(parseItunes(it), parseDeezer(dz));
}
