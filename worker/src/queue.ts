// Pure queue helpers. Order is a float `rank`; new items are placed round-robin.

export type Waiting = { id: string; device: string; rank: number };

/** Rank for a new item from `device`: after the last item whose turn number <= this device's next turn. */
export function rankForNew(ordered: Waiting[], device: string): number {
  if (ordered.length === 0) return 1;
  const turn = ordered.filter((w) => w.device === device).length;
  const seen = new Map<string, number>();
  let after = 0;
  ordered.forEach((w, i) => {
    const t = seen.get(w.device) ?? 0;
    seen.set(w.device, t + 1);
    if (t <= turn) after = i;
  });
  const prev = ordered[after].rank;
  const next = ordered[after + 1]?.rank;
  return next === undefined ? prev + 1 : (prev + next) / 2;
}

export function swapRanks(ordered: Waiting[], id: string, dir: -1 | 1): [string, number][] {
  const i = ordered.findIndex((w) => w.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= ordered.length) return [];
  return [[ordered[i].id, ordered[j].rank], [ordered[j].id, ordered[i].rank]];
}

function norm(text: string): string {
  return text
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\((?:[^)]*(?:remaster|version|edit|mono|stereo)[^)]*)\)/g, " ")
    .replace(/\s-\s.*(?:remaster|version|edit|mono|stereo).*$/, " ")
    .replace(/[^\p{L}\p{N} ]+/gu, " ")   // letters of any script: an all-Japanese title is not "" (was: every one collided)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);   // a key is also the studio's cache file name: keep it short
}

export function songKey(artist: string, title: string): string {
  return `${norm(artist)}|${norm(title)}`;
}

export function namesPhrase(names: string[]): string {
  if (names.length > 3) return `${names.slice(0, 3).join(", ")} and friends`;
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Guest text: control and invisible format characters (NUL, zero-width, right-to-left overrides)
 *  removed, whitespace collapsed, capped. A string that was only invisible characters comes back "". */
export function clean(text: unknown, max: number): string {
  const t = typeof text === "string" || typeof text === "number" ? String(text) : "";
  return t.replace(/[\p{Cc}\p{Cf}]/gu, "").replace(/\s+/g, " ").trim().slice(0, max);
}

const ART_HOSTS = [".mzstatic.com", ".dzcdn.net"];

/** Album art shown to every guest: only https images from the two catalogs we search. */
export function safeArtwork(url: unknown): string {
  try {
    const u = new URL(String(url ?? ""));
    const host = `.${u.hostname}`;
    return u.protocol === "https:" && ART_HOSTS.some((h) => host.endsWith(h)) ? u.href : "";
  } catch {
    return "";
  }
}

// Mirror of is_offensive() in studio/mattyfm/djline.py. Change both together.
const DENY_STEMS = ["fuck", "shit", "cunt", "bitch", "whore", "slut", "retard", "nigg", "fag", "pussy"];
const LOOKALIKE: Record<string, string> = { "!": "i", "1": "i", "|": "i", "3": "e", "0": "o", "@": "a", $: "s", "5": "s", "4": "a", "*": "u" };
// Cyrillic and Greek letters that look like Latin ones ("ѕhіt" must read as "shit")
const CONFUSABLE: Record<string, string> = {
  "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "у": "y", "х": "x", "і": "i", "ј": "j", "ѕ": "s", "к": "k", "м": "m", "т": "t", "н": "h",
  "α": "a", "ε": "e", "ι": "i", "κ": "k", "ν": "v", "ο": "o", "ρ": "p", "τ": "t", "υ": "u", "χ": "x",
};
// A rude stem counts with one of these after it, or nothing, or another word (3+ letters); and nothing
// or a real word (3+ letters) before it: "bullshit", "fucking", "shithead" are caught; "Fagan", "snigger", "Scunthorpe",
// "Matsushita" and "Pussycat" are names and words. Mirrors ENDINGS in djline.py.
const ENDINGS = new Set(["", "s", "es", "ed", "er", "ers", "ing", "in", "ins", "y", "ty", "head", "heads", "face", "faces",
  "hole", "holes", "bag", "bags", "wad", "wads", "ass", "stain", "show", "storm", "tard", "tards", "o", "z"]);

// Ordinary words that a stem-plus-word rule would catch. Mirrors SAFE_WORDS in djline.py.
const SAFE_WORDS = new Set(["pussycat", "pussycats", "pussywillow", "pussywillows", "shitake", "shitakes"]);

function rude(word: string): boolean {
  if (SAFE_WORDS.has(word)) return false;
  for (const stem of DENY_STEMS) {
    for (let i = word.indexOf(stem); i !== -1; i = word.indexOf(stem, i + 1)) {
      const before = word.slice(0, i), after = word.slice(i + stem.length);
      // stem + an ending (fucking) or + another word (fuckyou, shitfaced), with nothing or a word before it
      if ((ENDINGS.has(after) || after.length >= 3) && (before === "" || before.length >= 3)) return true;
    }
  }
  return false;
}

export function isOffensive(text: string): boolean {
  const folded = [...String(text ?? "").normalize("NFKC").toLowerCase()].map((c) => CONFUSABLE[c] ?? c).join("")
    .normalize("NFKD").replace(/[̀-ͯ]/g, "");
  const words: string[] = [];
  let run = "";
  for (const raw of folded.split(/\s+/)) {
    const token = [...raw].map((c) => LOOKALIKE[c] ?? c).join("").replace(/[^a-z.]/g, "");
    if (token.replace(/\./g, "").length === 1) {
      run += token.replace(/\./g, "");
      continue;
    }
    if (run) {
      words.push(run);
      run = "";
    }
    words.push(token.replace(/\./g, ""));
  }
  if (run) words.push(run);
  return words.some(rude);
}

/** Guest-typed text shown on every guest's phone: replaced when offensive (the owner still sees it). */
export function displayText(text: string, replacement: string): string {
  return isOffensive(text) ? replacement : text;
}
