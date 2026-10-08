import { describe, expect, it } from "vitest";
import { clean, namesPhrase, rankForNew, songKey, swapRanks, type Waiting } from "../src/queue";

function order(items: Waiting[]) {
  return [...items].sort((a, b) => a.rank - b.rank).map((w) => w.id);
}
function add(items: Waiting[], id: string, device: string) {
  const sorted = [...items].sort((a, b) => a.rank - b.rank);
  items.push({ id, device, rank: rankForNew(sorted, device) });
}

describe("round robin", () => {
  it("interleaves devices by turn", () => {
    const q: Waiting[] = [];
    add(q, "A1", "a"); add(q, "A2", "a"); add(q, "B1", "b"); add(q, "C1", "c"); add(q, "B2", "b");
    expect(order(q)).toEqual(["A1", "B1", "C1", "A2", "B2"]);
  });
  it("empty queue gets rank 1", () => {
    expect(rankForNew([], "a")).toBe(1);
  });
});

describe("swapRanks", () => {
  const q: Waiting[] = [
    { id: "x", device: "a", rank: 1 }, { id: "y", device: "b", rank: 2 }, { id: "z", device: "c", rank: 3 },
  ];
  it("moves up by swapping with the previous item", () => {
    expect(swapRanks(q, "y", -1)).toEqual([["y", 1], ["x", 2]]);
  });
  it("does nothing at the edges", () => {
    expect(swapRanks(q, "x", -1)).toEqual([]);
    expect(swapRanks(q, "z", 1)).toEqual([]);
  });
});

describe("songKey", () => {
  it("ignores case, accents, punctuation and remaster tags", () => {
    expect(songKey("Beyoncé", "Halo (Remastered 2009)")).toBe(songKey("beyonce", "HALO"));
    expect(songKey("Earth, Wind & Fire", "September - 2004 Remaster")).toBe("earth wind fire|september");
  });
});

describe("namesPhrase / clean", () => {
  it("joins names", () => {
    expect(namesPhrase(["A", "B", "C", "D"])).toBe("A, B, C and friends");
    expect(namesPhrase(["A", "B"])).toBe("A and B");
  });
  it("collapses whitespace and caps length", () => {
    expect(clean("  hi \n  there ", 5)).toBe("hi th");
  });
});
