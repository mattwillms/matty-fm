import { describe, expect, it } from "vitest";
import { mergeTracks, parseDeezer, parseItunes, searchAll } from "../src/search";

const itunes = { results: [{ trackName: "September", artistName: "Earth, Wind & Fire", collectionName: "The Best Of",
  trackTimeMillis: 215000, trackExplicitness: "notExplicit", artworkUrl100: "https://a/100x100bb.jpg" }] };
const deezer = { data: [
  { title: "September", artist: { name: "Earth, Wind & Fire" }, album: { title: "x", cover_medium: "c" }, duration: 215, explicit_lyrics: false },
  { title: "WAP", artist: { name: "Cardi B" }, album: { title: "y", cover_medium: "d" }, duration: 187, explicit_lyrics: true },
] };

describe("search", () => {
  it("parses both sources", () => {
    expect(parseItunes(itunes)[0]).toMatchObject({ title: "September", durationMs: 215000, explicit: false, source: "itunes" });
    expect(parseDeezer(deezer)[1]).toMatchObject({ artist: "Cardi B", durationMs: 187000, explicit: true, source: "deezer" });
  });
  it("merges and dedupes, keeping iTunes first and Deezer-only songs", () => {
    const merged = mergeTracks(parseItunes(itunes), parseDeezer(deezer));
    expect(merged.map((t) => `${t.source}:${t.title}`)).toEqual(["itunes:September", "deezer:WAP"]);
  });
  it("survives one source failing", async () => {
    const fetcher = async (url: string | URL | Request) =>
      String(url).includes("itunes") ? new Response("nope", { status: 404 }) : Response.json(deezer);
    const got = await searchAll("september", fetcher as typeof fetch);
    expect(got.length).toBe(2);
  });
  it("garbage input yields empty arrays", () => {
    expect(parseItunes(null)).toEqual([]);
    expect(parseDeezer({ data: "x" })).toEqual([]);
  });
});
