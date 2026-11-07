// Reads species, move, item and ability data from a GBA ROM by finding its tables.
// Works without knowing the hack: tables are located by the names and base stats of entries that
// every Gen III engine keeps (Bulbasaur, Pound, Master Ball, Stench...), and struct field offsets are
// learned by matching values that never changed across engines. The ROM is only read, never modified.
import { u32 } from "./binary";
import { encodeBytes, decodeStrict, decodeMessage } from "./text";
import { GameData, SpeciesInfo, titleCase, TYPE_NAMES, VANILLA, GROWTH_NAMES, standardExp } from "./data";
import { findLearnsets } from "./learnsets";

export interface RomHeader { title: string; code: string; maker: string; size: number; isGba: boolean }

export function readRomHeader(rom: Uint8Array): RomHeader {
  const ascii = (o: number, n: number) => String.fromCharCode(...rom.subarray(o, o + n)).replace(/\0+$/, "");
  const isGba = rom.length > 0xc0 && rom[0xb2] === 0x96;
  return { title: ascii(0xa0, 12), code: ascii(0xac, 4), maker: ascii(0xb0, 2), size: rom.length, isGba };
}

type Table = { kind: "inline" | "pointer"; at: number; stride: number; maxLen: number };

const norm = (s: string) => s.toUpperCase().replace(/[\s.\-']/g, "");

function findAll(rom: Uint8Array, pat: Uint8Array, limit = 4000): number[] {
  const out: number[] = [];
  const first = pat[0], n = pat.length, end = rom.length - n;
  for (let i = 0; i <= end; i++) {
    if (rom[i] !== first) continue;
    let k = 1;
    while (k < n && rom[i + k] === pat[k]) k++;
    if (k === n) { out.push(i); if (out.length >= limit) break; }
  }
  return out;
}

const ptrTo = (rom: Uint8Array, at: number): number | null => {
  if (at < 0 || at + 4 > rom.length) return null;
  const v = u32(rom, at);
  const off = v - 0x08000000;
  return off >= 0 && off < rom.length ? off : null;
};

function entry(rom: Uint8Array, t: Table, i: number): string | null {
  const at = t.at + (i - 1) * t.stride;
  if (t.kind === "inline") return decodeStrict(rom, at, t.maxLen);
  const p = ptrTo(rom, at);
  return p === null ? null : decodeStrict(rom, p, t.maxLen);
}

/** Locates a name table from the names of entries 1, 2 and 3 (upper and mixed case are both tried). */
function findNameTable(rom: Uint8Array, names: [string, string, string], maxLen: number): Table | null {
  const want = names.map(norm);
  // 0x00 is a space in the game's charset, so reject leading spaces (they mean a misaligned read)
  const matches = (s: string | null, k: number) => s !== null && s[0] !== " " && norm(s) === want[k];
  const starts: number[] = [];
  for (const v of [names[0].toUpperCase(), names[0]]) {
    const enc = encodeBytes(v);
    if (enc) starts.push(...findAll(rom, enc));
  }
  // Inline tables: fixed-size records with the name inside
  for (const a of starts) {
    for (let s = names[0].length + 1; s <= 1024; s++) {
      if (matches(decodeStrict(rom, a + s, maxLen), 1) && matches(decodeStrict(rom, a + 2 * s, maxLen), 2))
        return { kind: "inline", at: a, stride: s, maxLen };
    }
  }
  // Pointer tables: records holding a pointer to the name
  const targets = new Set(starts.map(a => (a + 0x08000000) >>> 0));
  for (let at = 0; at + 4 <= rom.length; at += 4) {
    if (!targets.has(u32(rom, at))) continue;
    for (let s = 4; s <= 512; s += 4) {
      const t: Table = { kind: "pointer", at, stride: s, maxLen };
      if (matches(entry(rom, t, 2), 1) && matches(entry(rom, t, 3), 2)) return t;
    }
  }
  return null;
}

function readNames(rom: Uint8Array, t: Table, cap: number): string[] {
  const out = [""];
  let misses = 0;
  for (let i = 1; i <= cap; i++) {
    const s = entry(rom, t, i);
    if (s === null) {
      // tolerate a few unreadable entries (odd control codes); a longer run is the end of the table
      if (++misses > 3) break;
      out.push("");
      continue;
    }
    misses = 0;
    // every real name starts with a capital, digit or symbol; a lowercase start means we've slid
    // into another table at a different alignment
    if (i > 10 && /^[a-z]/.test(s.trim())) break;
    out.push(titleCase(s.trim()));
  }
  while (out.length > 1 && out[out.length - 1] === "") out.pop();
  // entry 0 (the "none" entry) sits one stride before entry 1
  const zero = entry(rom, t, 0);
  out[0] = zero === null ? "" : titleCase(zero.trim());
  return out;
}

/** Other copies of an inline name table. Expanding hacks copy a table elsewhere and grow it, and
 *  the GF header can keep pointing at the old, shorter one; the longest copy is the live table. */
function longestCopy(rom: Uint8Array, t: Table, names: string[], cap: number): string[] {
  let best = names;
  if (t.kind !== "inline" || names.length < 4 || !names[1] || !names[2] || !names[3]) return best;
  const tries = [names[1], names[1].toUpperCase()].map(n => encodeBytes(n)).filter((x): x is Uint8Array => !!x);
  const seen = new Set<number>();
  for (const enc of tries) {
    const pat = new Uint8Array([...enc, 0xff]);
    for (const a of findAll(rom, pat, 200)) {
      if (seen.has(a) || a === t.at) continue;
      seen.add(a);
      const cand: Table = { ...t, at: a };
      const e2 = entry(rom, cand, 2), e3 = entry(rom, cand, 3);
      if (e2 === null || e3 === null || norm(e2) !== norm(names[2]) || norm(e3) !== norm(names[3])) continue;
      const got = readNames(rom, cand, cap);
      if (got.length > best.length) best = got;
    }
  }
  return best;
}

// Moves whose type is the same in every Gen III game and engine, one or more per type
const MOVE_TYPES: [number, string][] = [
  [1, "Normal"], [10, "Normal"], [33, "Normal"], [2, "Fighting"], [16, "Flying"], [40, "Poison"], [28, "Ground"],
  [88, "Rock"], [81, "Bug"], [122, "Ghost"], [232, "Steel"], [52, "Fire"], [55, "Water"], [22, "Grass"],
  [84, "Electric"], [94, "Psychic"], [58, "Ice"], [82, "Dragon"], [44, "Dark"], [585, "Fairy"],
];

/** Learns which byte of a move record holds its type, and what each value means, from moves whose
 *  type never changed. `byteAt(move, k)` reads byte k of that move's record. */
function learnMoveTypes(count: number, size: number, byteAt: (move: number, k: number) => number, fallback: (v: number) => string): string[] | null {
  let best: { k: number; map: Map<number, string>; score: number } | null = null;
  for (let k = 0; k < size; k++) {
    const map = new Map<number, string>(), back = new Map<string, number>();
    let score = 0, bad = 0;
    for (const [mv, t] of MOVE_TYPES) {
      if (mv >= count) continue;
      const v = byteAt(mv, k);
      if ((map.has(v) && map.get(v) !== t) || (back.has(t) && back.get(t) !== v)) { bad++; continue; }
      map.set(v, t); back.set(t, v); score++;
    }
    if (bad <= 3 && score >= 13 && (!best || score - bad > best.score)) best = { k, map, score: score - bad };
  }
  if (!best) return null;
  return Array.from({ length: count }, (_, i) => i === 0 ? "" : best!.map.get(byteAt(i, best!.k)) ?? fallback(byteAt(i, best!.k)));
}

/** Vanilla-layout battle move tables (12-byte records, PP at +4). Picks the longest copy. */
function findBattleMoves(rom: Uint8Array): { at: number; count: number } | null {
  let best: { at: number; count: number } | null = null;
  for (let a = 4 + 12; a + 12 * 12 <= rom.length; a++) {
    if (rom[a + 12] !== PP10[1] || rom[a + 24] !== PP10[2]) continue;
    let hits = 0;
    for (let i = 0; i < 10; i++) if (rom[a + i * 12] === PP10[i]) hits++;
    if (hits < 8) continue; // hacks sometimes edit a move or two
    const at = a - 4 - 12; // entry 0
    let count = 1, misses = 0;
    for (let i = 1; i < 2048; i++) {
      const o = at + i * 12;
      if (o + 12 > rom.length) break;
      const plausible = rom[o + 4] > 0 && rom[o + 4] <= 64 && rom[o + 3] <= 101 && rom[o + 2] < 32;
      if (plausible) { count = i + 1; misses = 0; } else if (++misses > 2) break;
    }
    if (!best || count > best.count) best = { at, count };
  }
  return best;
}


// ---- Move details: category, power, accuracy, description ----

export type MoveCategory = "Physical" | "Special" | "Status";
const SPECIAL_TYPES = new Set(["Fire", "Water", "Grass", "Electric", "Psychic", "Ice", "Dragon", "Dark"]);

/** Battle stats from a vanilla-layout 12-byte table. Hacks with the physical/special split keep it at +10. */
function battleDetails(rom: Uint8Array, at: number, count: number, types: string[] | null) {
  const power: number[] = [], acc: number[] = [];
  for (let i = 0; i < count; i++) { power.push(rom[at + i * 12 + 1] ?? 0); acc.push(rom[at + i * 12 + 3] ?? 0); }
  // split byte: only 0/1/2, and moves without power are status (2)
  let splitOk = true, status0 = 0, n0 = 0, varied = new Set<number>();
  for (let i = 1; i < count && splitOk; i++) {
    const v = rom[at + i * 12 + 10];
    if (v > 2) splitOk = false;
    varied.add(v);
    if (power[i] === 0) { n0++; if (v === 2) status0++; }
  }
  const split = splitOk && varied.size >= 2 && n0 > 0 && status0 >= n0 * 0.9;
  const cat: MoveCategory[] = power.map((pw, i) => {
    if (split) { const v = rom[at + i * 12 + 10]; return v === 0 ? "Physical" : v === 1 ? "Special" : "Status"; }
    if (pw === 0) return "Status";
    return types && SPECIAL_TYPES.has(types[i]) ? "Special" : "Physical";
  });
  return { power, acc, cat, split };
}

const isDesc = (s: string | null) => s !== null && s.length >= 4 && s.length <= 220 && /[a-z]/i.test(s);

/** Move descriptions: a pointer table indexed from move 1 (vanilla, CFRU). Picks the run the code points to. */
function findMoveDescriptions(rom: Uint8Array, moveCount: number): string[] | null {
  const textAt = (a: number) => { const p = ptrTo(rom, a); return p === null ? null : decodeMessage(rom, p, 300); };
  const runs: { at: number; len: number }[] = [];
  for (let a = 0; a + 16 <= rom.length; a += 4) {
    if (!isDesc(textAt(a)) || !isDesc(textAt(a + 4)) || !isDesc(textAt(a + 8))) continue;
    let len = 0, misses = 0;
    for (let i = 0; a + i * 4 + 4 <= rom.length && i < 2100; i++) {
      if (isDesc(textAt(a + i * 4))) { len = i + 1; misses = 0; } else if (++misses > 1) break;
    }
    if (len >= Math.max(150, (moveCount - 1) * 0.7)) runs.push({ at: a, len });
    a += Math.max(0, len - 1) * 4;
  }
  if (!runs.length) return null;
  const refs = (t: number) => { const v = 0x08000000 + t; let n = 0; for (let a = 0; a + 4 <= rom.length; a += 4) if (u32(rom, a) === v) n++; return n; };
  // the table may start a word or two into a run (an unrelated text pointer just before it)
  let best: { at: number; len: number; refs: number } | null = null;
  for (const r of runs) for (let k = 0; k < 3; k++) {
    const at = r.at + k * 4, n = refs(at);
    const score = n * 10000 - Math.abs(r.len - k - (moveCount - 1));
    if (!best || score > best.refs * 10000 - Math.abs(best.len - (moveCount - 1))) best = { at, len: r.len - k, refs: n };
  }
  if (!best) return null;
  const out = [""];
  for (let i = 0; i < Math.min(best.len, moveCount - 1 + 50); i++) out.push(textAt(best.at + i * 4) ?? "");
  return out;
}

/** Any battle-move table: records of some stride with PP and power bytes for moves 1-10 that mostly
 *  match the originals (hacks rebalance a few). Returns the address of move 0's record and field offsets. */
const POWER10 = [40, 50, 15, 18, 80, 40, 75, 75, 75, 40];
function findMoveRecords(rom: Uint8Array): { at: number; stride: number; pp: number; power: number } | null {
  const near = (a: number, s: number, want: number[]) => { let n = 0; for (let i = 0; i < 10; i++) if (rom[a + i * s] === want[i]) n++; return n; };
  for (let a = 8; a + 10 * 64 < rom.length; a++) {
    if (rom[a] !== 35) continue;
    for (let s = 8; s <= 64; s++) {
      if (rom[a + s] !== 25) continue;                           // Pound 35 PP, Karate Chop 25
      if (near(a, s, PP10) < 7) continue;
      // power: another byte of the same records
      for (let k = -Math.min(s - 1, a % s + s); k < s; k++) {
        if (k === 0) continue;
        if (near(a + k, s, POWER10) >= 7) {
          const rec0 = a - s;                                    // PP byte of move 0
          return { at: rec0, stride: s, pp: 0, power: k };
        }
      }
    }
  }
  return null;
}

/** Learns a byte offset in move records that holds the physical/special/status split, from moves whose
 *  category never changed. Returns per-move categories, or null when the records have no such field. */
function learnCategories(count: number, size: number, byteAt: (mv: number, k: number) => number): ("Physical" | "Special" | "Status")[] | null {
  const PHYS = [1, 10, 33, 2, 7], SPEC = [52, 55, 94, 85, 58], STAT = [45, 39, 14, 43, 28];
  for (let k = 0; k < size; k++) {
    const vals = (l: number[]) => new Set(l.filter(m => m < count).map(m => byteAt(m, k)));
    const p = vals(PHYS), sp = vals(SPEC), st = vals(STAT);
    if (p.size !== 1 || sp.size !== 1 || st.size !== 1) continue;
    const [vp] = p, [vs] = sp, [vt] = st;
    if (vp === vs || vp === vt || vs === vt || vp > 3 || vs > 3 || vt > 3) continue;
    return Array.from({ length: count }, (_, i) => { const v = byteAt(i, k); return v === vp ? "Physical" : v === vs ? "Special" : "Status"; });
  }
  return null;
}

// ---- Hacks with their own species order (regional dex, fakemon) ----
// Nothing sits at a fixed national number, so tables are found from entry 0 (which vanilla code keeps)
// and from the real Pokémon the hack still has, matched by name.

/** Longest inline name table whose entry 0 is `zero` ("??????????" for species, "-------" for abilities). */
function findTableByEntryZero(rom: Uint8Array, zero: string, strides: number[], min: number): Table | null {
  const enc = encodeBytes(zero);
  if (!enc) return null;
  let best: Table | null = null, bestN = 0;
  for (const a of findAll(rom, enc, 4000)) {
    for (const st of strides) {
      if (decodeStrict(rom, a, st) !== zero) continue;
      let n = 0, misses = 0;
      for (let i = 1; i <= 2047 && misses <= 3; i++) {
        const t = decodeStrict(rom, a + i * st, st);
        if (t === null || t === "" || t[0] === " " || /^[a-z]/.test(t)) { misses++; continue; }
        misses = 0; n++;
      }
      if (n > bestN) { bestN = n; best = { kind: "inline", at: a + st, stride: st, maxLen: st }; }
    }
  }
  return bestN >= min ? best : null;
}

/** Built-in Gen III species data keyed by normalized name. */
function referenceByName(): Map<string, SpeciesInfo> {
  const m = new Map<string, SpeciesInfo>();
  VANILLA.species.forEach((n, i) => { const inf = VANILLA.info[i]; if (n && inf) m.set(norm(n), inf); });
  return m;
}

/** Base stats located from the real Pokémon in the hack's own species list: every record whose six
 *  stats match the Gen III values votes for a table start and stride. Hacks rebalance some; most survive. */
function findBaseStatsByName(rom: Uint8Array, species: string[]): { at: number; stride: number } | null {
  const ref = referenceByName();
  const known: { i: number; bs: number[] }[] = [];
  species.forEach((n, i) => { const r = i > 0 && n ? ref.get(norm(n)) : undefined; if (r && r.bs.some(v => v)) known.push({ i, bs: r.bs }); });
  if (known.length < 8) return null;
  // one pass over the ROM: 3-byte prefix filter, then the full six bytes
  const byPrefix = new Map<number, { i: number; bs: number[] }[]>();
  for (const k of known) {
    const key = k.bs[0] | (k.bs[1] << 8) | (k.bs[2] << 16);
    (byPrefix.get(key) ?? byPrefix.set(key, []).get(key)!).push(k);
  }
  const seen = new Uint8Array(1 << 21); // bitmap of 24-bit prefixes
  for (const key of byPrefix.keys()) seen[key >>> 3] |= 1 << (key & 7);
  const hits: { at: number; i: number }[] = [];
  for (let o = 0; o + 6 <= rom.length && hits.length < 20000; o++) {
    const key = rom[o] | (rom[o + 1] << 8) | (rom[o + 2] << 16);
    if (!(seen[key >>> 3] & (1 << (key & 7)))) continue;
    const list = byPrefix.get(key);
    if (!list) continue;
    for (const k of list) if (rom[o + 3] === k.bs[3] && rom[o + 4] === k.bs[4] && rom[o + 5] === k.bs[5]) hits.push({ at: o, i: k.i });
  }
  // pairs of hits imply a stride and table start; the most common pair wins
  const votes = new Map<string, number>();
  hits.sort((a, b) => a.at - b.at);
  for (let x = 0; x < hits.length; x++) {
    for (let y = x + 1; y < hits.length && hits[y].at - hits[x].at <= 256 * 2048; y++) {
      const di = hits[y].i - hits[x].i, da = hits[y].at - hits[x].at;
      if (di <= 0 || da % di) continue;
      const st = da / di;
      if (st < 6 || st > 256) continue;
      const key = `${hits[x].at - (hits[x].i - 1) * st}:${st}`;
      votes.set(key, (votes.get(key) ?? 0) + 1);
    }
  }
  let best: string | null = null, bv = 0;
  for (const [k, v] of votes) if (v > bv) { best = k; bv = v; }
  if (!best || bv < 10) return null;
  const [at, stride] = best.split(":").map(Number);
  return at >= 0 ? { at, stride } : null;
}

// Exp curves: gExperienceTables[rate][0..100] as u32. Hacks may reorder or retune them.
const EXP_ROW = 101 * 4;
interface ExpCurves { rows: number[][]; std: (number | null)[]; exact: boolean[] }
function findExpTables(rom: Uint8Array): ExpCurves | null {
  const pat = new Uint8Array(24);
  [0, 1, 8, 27, 64, 125].forEach((v, k) => { pat[k * 4] = v; });
  const isRow = (o: number) => {
    if (o < 0 || o + EXP_ROW > rom.length || u32(rom, o) !== 0 || u32(rom, o + 4) !== 1) return false;
    for (let n = 2; n <= 100; n++) if (u32(rom, o + n * 4) < u32(rom, o + (n - 1) * 4) || u32(rom, o + n * 4) > 2e7) return false;
    return true;
  };
  for (const a of findAll(rom, pat, 50)) {
    if (!isRow(a)) continue;
    let start = a;
    while (isRow(start - EXP_ROW)) start -= EXP_ROW;
    const rows: number[][] = [];
    for (let o = start; isRow(o) && rows.length < 16; o += EXP_ROW) rows.push(Array.from({ length: 101 }, (_, n) => u32(rom, o + n * 4)));
    if (rows.length < 4) continue;
    // name each row after the standard curve it follows up to level 50 (hacks retune the late levels)
    const std = rows.map(r => {
      let best: number | null = null, bn = 0;
      for (let g = 0; g < 6; g++) {
        let n = 0; for (let l = 1; l <= 50; l++) if (r[l] === standardExp(g, l)) n++;
        if (n > bn) { bn = n; best = g; }
      }
      return bn >= 45 ? best : null;
    });
    const exact = rows.map((r, i) => std[i] !== null && r.every((v, l) => v === standardExp(std[i]!, l)));
    return { rows, std, exact };
  }
  return null;
}
// Species that are Fairy-type in every game that has the type; their unmapped type id is Fairy.
const FAIRY_NAMES = new Set(["CLEFAIRY", "CLEFABLE", "CLEFFA", "SNUBBULL", "GRANBULL", "TOGEPI", "SWIRLIX", "SLURPUFF",
  "SPRITZEE", "AROMATISSE", "SYLVEON", "FLABEBE", "FLOETTE", "FLORGES", "COMFEY", "XERNEAS"]);

/** Field offsets of a base-stats table learned from the real Pokémon a hack kept, by name. Values only need
 *  to agree for most of them, since hacks retune some species. */
function learnByName(rom: Uint8Array, bs: { at: number; stride: number }, sp: string[], abilities: string[], curves: ExpCurves | null) {
  const ref = referenceByName();
  const rec = (i: number) => bs.at + (i - 1) * bs.stride;
  const known = sp.map((n, i) => (i > 0 && n ? ref.get(norm(n)) : undefined));
  const idx = known.flatMap((k, i) => (k && rec(i) + bs.stride <= rom.length ? [i] : []));
  const missing: string[] = [];
  const val = (o: number, w: number) => (w === 1 ? rom[o] : rom[o] | (rom[o + 1] << 8));
  const learn = (want: (i: number) => number | null, opts: { width?: number; share?: number; skip?: number[]; same?: (v: number, w: number) => boolean } = {}) => {
    const w = opts.width ?? 1, same = opts.same ?? ((v, x) => v === x);
    let best: number | null = null, bn = 0, bt = 0;
    for (let k = 6; k + w <= bs.stride; k++) {
      if (opts.skip?.includes(k)) continue;
      let n = 0, t = 0;
      for (const i of idx) { const x = want(i); if (x === null) continue; t++; if (same(val(rec(i) + k, w), x)) n++; }
      if (n > bn) { bn = n; bt = t; best = k; }
    }
    return best !== null && bt >= 5 && bn >= bt * (opts.share ?? 0.7) ? best : null;
  };
  const g = learn(i => known[i]!.g);
  // growth ids follow this ROM's EXP curves, which a hack may reorder
  const toRom = new Map<number, number>();
  curves?.std.forEach((s, r) => { if (s !== null && !toRom.has(s)) toRom.set(s, r); });
  const gr = learn(i => { const v = known[i]!.gr; return v === null ? null : curves ? toRom.get(v) ?? null : v; }, { skip: g === null ? [] : [g] });
  const abName = (id: number) => norm(abilities[id] ?? "");
  const wantAb = (i: number) => { const id = known[i]!.ab[0]; return id ? id : null; };
  const sameAb = (v: number, id: number) => abName(v) !== "" && abName(v) === norm(VANILLA.abilities[id] ?? "?");
  let abW = 1, ab = learn(wantAb, { share: 0.5, same: sameAb });
  if (ab === null) { abW = 2; ab = learn(wantAb, { width: 2, share: 0.5, same: sameAb }); }
  let hid: number | null = null;
  if (ab !== null && ab + 3 * abW <= bs.stride) {
    let ok = 0, n = 0;
    for (let i = 1; i < sp.length && rec(i) + bs.stride <= rom.length; i++) { n++; if (val(rec(i) + ab + 2 * abW, abW) < abilities.length) ok++; }
    if (n && ok === n) hid = ab + 2 * abW;
  }
  // type ids: majority vote over the kept Pokémon (one byte each at +6/+7, as everywhere else)
  const votes = new Map<number, Map<string, number>>();
  const vote = (b: number, t: string) => { const m = votes.get(b) ?? votes.set(b, new Map()).get(b)!; m.set(t, (m.get(t) ?? 0) + 1); };
  for (const i of idx) { const t = known[i]!.t; vote(rom[rec(i) + 6], t[0]); vote(rom[rec(i) + 7], t[t.length - 1]); }
  const typeMap = new Map<number, string>();
  for (const [b, m] of votes) { let bt = "", bn = 0; for (const [t, n] of m) if (n > bn) { bn = n; bt = t; } typeMap.set(b, bt); }
  // the game's own type names (gTypeNames), when present, settle every id
  const tt = findNameTable(rom, ["Normal", "Fighting", "Flying"], 9);
  if (tt) for (let id = 0; id < 32; id++) {
    const n = entry(rom, tt, id + 1);
    const name = n === null ? null : titleCase(n.trim());
    if (name && (TYPE_NAMES as readonly string[]).includes(name)) typeMap.set(id, name);
    else if (name === null || !/^[?A-Z]/.test(name)) break;
  }
  // Gen III data has no Fairy type: species that are Fairy everywhere else tell its id
  sp.forEach((n, i) => {
    if (!i || !FAIRY_NAMES.has(norm(n).replace("É", "E")) || rec(i) + 8 > rom.length) return;
    for (const k of [6, 7]) { const b = rom[rec(i) + k]; const cur = typeMap.get(b); if (!cur || cur === "Normal") { if (!cur || (votes.get(b)?.get("Normal") ?? 0) < 3) typeMap.set(b, "Fairy"); } }
  });
  if (g === null) missing.push("gender ratio");
  if (gr === null) missing.push("growth rate");
  if (ab === null) missing.push("abilities");
  const info: (SpeciesInfo | null)[] = sp.map((_, i) => {
    const o = rec(i);
    if (!i || o + bs.stride > rom.length) return null;
    const a1 = ab === null ? 0 : val(o + ab, abW), a2 = ab === null ? 0 : val(o + ab + abW, abW);
    return {
      bs: Array.from(rom.subarray(o, o + 6)),
      t: [...new Set([typeMap.get(rom[o + 6]) ?? "Mystery", typeMap.get(rom[o + 7]) ?? "Mystery"])],
      g: g === null ? 255 : rom[o + g],
      gr: gr === null ? null : rom[o + gr] < (curves?.rows.length ?? 6) ? rom[o + gr] : null,
      ab: [a1, a2 === a1 ? 0 : a2, hid === null ? 0 : val(o + hid, abW)],
    };
  });
  return { info, missing };
}

const standardCurves = (c: ExpCurves) => c.rows.length >= 6 && c.std.slice(0, 6).every((g, i) => g === i) && c.exact.slice(0, 6).every(Boolean);

// ---- Species base stats ----

const BASE: Record<number, number[]> = {
  1: [45, 49, 49, 45, 65, 65], 2: [60, 62, 63, 60, 80, 80], 3: [80, 82, 83, 80, 100, 100], 4: [39, 52, 43, 65, 60, 50],
};

function findBaseStats(rom: Uint8Array): { at: number; stride: number } | null {
  for (const a of findAll(rom, new Uint8Array(BASE[1]), 20000)) {
    for (let s = 6; s <= 1024; s++) {
      const ok = [2, 3, 4].every(sp => BASE[sp].every((v, k) => rom[a + (sp - 1) * s + k] === v));
      if (ok) return { at: a, stride: s };
    }
  }
  return null;
}

/** Finds a byte offset (or u16 when width 2) inside the record where every known value matches. */
function learnField(rom: Uint8Array, at: number, stride: number, known: [number, number][], width = 1, from = 6): number | null {
  const read = (sp: number, k: number) => {
    const o = at + (sp - 1) * stride + k;
    return width === 1 ? rom[o] : rom[o] | (rom[o + 1] << 8);
  };
  for (let k = from; k + width <= stride; k++) if (known.every(([sp, v]) => read(sp, k) === v)) return k;
  return null;
}

// Values identical in vanilla, CFRU and pokeemerald-expansion for these species
const GENDER: [number, number][] = [[1, 31], [4, 31], [7, 31], [10, 127], [29, 254], [32, 0], [81, 255], [128, 0], [113, 254]];
const GROWTH: [number, number][] = [[1, 3], [10, 0], [35, 4], [129, 5], [16, 3], [19, 0], [39, 4], [43, 3]];
const ABILITY1: [number, number][] = [[1, 65], [4, 66], [7, 67], [25, 9], [63, 28]];
const HIDDEN: [number, number][] = [[1, 34], [7, 44], [25, 31]];
// [species, type1, type2] for building the type id map
const TYPES: [number, string, string][] = [
  [1, "Grass", "Poison"], [4, "Fire", "Fire"], [7, "Water", "Water"], [10, "Bug", "Bug"], [16, "Normal", "Flying"],
  [25, "Electric", "Electric"], [27, "Ground", "Ground"], [56, "Fighting", "Fighting"], [63, "Psychic", "Psychic"],
  [74, "Rock", "Ground"], [92, "Ghost", "Poison"], [147, "Dragon", "Dragon"], [124, "Ice", "Psychic"],
  [81, "Electric", "Steel"], [197, "Dark", "Dark"], [23, "Poison", "Poison"], [19, "Normal", "Normal"],
];
const FAIRY_CANDIDATES = [35, 173, 175, 209];

// PP of moves 1-10 (Pound ... Scratch), unchanged in every engine
const PP10 = [35, 25, 10, 15, 20, 20, 15, 15, 15, 35];

function findPP(rom: Uint8Array, moveTable: Table | null, count: number): number[] | null {
  const read = (at: number, s: number) => Array.from({ length: count }, (_, i) => rom[at + i * s] ?? 0);
  // 1) PP stored in the same record as the move name (expansion MoveInfo)
  if (moveTable) {
    const s = moveTable.stride, L1 = moveTable.at;
    for (let d = -s; d < s; d++) {
      if (PP10.every((v, i) => rom[L1 + i * s + d] === v)) return read(L1 + d - s, s); // index 0 = no move
    }
  }
  // 2) A separate battle-move table (vanilla, CFRU)
  const first: number[] = [];
  for (let i = 0; i < rom.length; i++) if (rom[i] === 35) first.push(i);
  for (let s = 8; s <= 64; s++) {
    for (const a of first) {
      let ok = true;
      for (let i = 1; i < 10 && ok; i++) ok = rom[a + i * s] === PP10[i];
      if (ok) return read(a - s, s);
    }
  }
  return null;
}

/** Game Freak's ROM header at 0x08000100 (src/rom_header_gf.c): table pointers and save layout. */
export interface GfHeader {
  gameName: string;
  frontPics: number | null; normalPalettes: number | null; shinyPalettes: number | null;
  speciesNames: number | null; moveNames: number | null;
  speciesInfo: number | null; abilityNames: number | null; items: number | null; moves: number | null;
  pokemonNameLength: number;
  saveBlock2Size: number; saveBlock1Size: number; partyCountOffset: number; partyOffset: number;
  trainerIdOffset: number; playerNameOffset: number;
}

export function readGfHeader(rom: Uint8Array): GfHeader | null {
  if (rom.length < 0x200) return null;
  const name = String.fromCharCode(...rom.subarray(0x108, 0x128)).replace(/\0.*$/s, "");
  if (!/^pokemon /.test(name)) return null;
  const P = (o: number) => ptrTo(rom, o);
  const S = (o: number) => { const v = u32(rom, o); return v < 0x10000 ? v : 0; };
  return {
    gameName: name,
    frontPics: P(0x128), normalPalettes: P(0x130), shinyPalettes: P(0x134),
    speciesNames: P(0x144), moveNames: P(0x148),
    speciesInfo: P(0x1bc), abilityNames: P(0x1c0), items: P(0x1c8), moves: P(0x1cc),
    pokemonNameLength: rom[0x176],
    // some hacks overwrite this part of the header with code; 0 marks a value that can't be a save offset
    saveBlock2Size: S(0x188), saveBlock1Size: S(0x18c), partyCountOffset: S(0x190), partyOffset: S(0x194),
    trainerIdOffset: S(0x19c), playerNameOffset: S(0x1a0),
  };
}

// Vanilla Gen III type ids (CFRU adds Fairy at 0x17; binary hacks usually reuse 9)
const VANILLA_TYPES = ["Normal","Fighting","Flying","Poison","Ground","Rock","Bug","Ghost","Steel","Fairy","Fire","Water","Grass","Electric","Psychic","Ice","Dragon","Dark"];
const vanillaType = (v: number) => VANILLA_TYPES[v] ?? (v === 0x17 ? "Fairy" : "Mystery");

/**
 * Reads a vanilla-layout ROM (the original games, binary hacks, CFRU) through its GF header:
 * fixed-size name tables and 28-byte base stats, so renamed "fakemon" hacks work too.
 */
function loadFromGfHeader(rom: Uint8Array, gf: GfHeader, report: string[]) {
  if (gf.speciesNames === null || gf.speciesInfo === null) return null;
  const nameLen = gf.pokemonNameLength >= 10 && gf.pokemonNameLength <= 12 ? gf.pokemonNameLength + 1 : 11;
  // Tables often sit back to back, so a name table ends where the next known table starts.
  const starts = [gf.frontPics, gf.normalPalettes, gf.shinyPalettes, gf.speciesNames, gf.moveNames, gf.speciesInfo, gf.abilityNames, gf.items, gf.moves]
    .filter((x): x is number => x !== null);
  const capFor = (at: number, stride: number, max: number) => {
    const next = starts.filter(x => x > at).reduce((a, b) => Math.min(a, b), Infinity);
    return Math.min(max, Number.isFinite(next) ? Math.floor((next - at) / stride) - 1 : max);
  };
  const spT: Table = { kind: "inline", at: gf.speciesNames + nameLen, stride: nameLen, maxLen: nameLen };
  const sp = readNames(rom, spT, capFor(gf.speciesNames, nameLen, 2047));
  if (sp.length < 100) return null;
  // the header table may be shorter than the expanded base stats in some hacks; trust names
  const mvT: Table | null = gf.moveNames !== null ? { kind: "inline", at: gf.moveNames + 13, stride: 13, maxLen: 13 } : null;
  const moves = mvT ? readNames(rom, mvT, capFor(gf.moveNames!, 13, 2047)) : [""];
  const abT: Table | null = gf.abilityNames !== null ? { kind: "inline", at: gf.abilityNames + 13, stride: 13, maxLen: 13 } : null;
  const abilities = abT ? readNames(rom, abT, capFor(gf.abilityNames!, 13, 1000)) : [""];
  const itT: Table | null = gf.items !== null ? { kind: "inline", at: gf.items + 44, stride: 44, maxLen: 14 } : null;
  const items = itT ? readNames(rom, itT, capFor(gf.items!, 44, 1500)) : [""];
  // CFRU and binary hacks that add moves, abilities or items may leave the header on the old tables
  let movesAll = mvT ? longestCopy(rom, mvT, moves, 2047) : moves;
  const abilitiesAll = abT ? longestCopy(rom, abT, abilities, 1000) : abilities;
  const itemsAll = itT ? longestCopy(rom, itT, items, 1500) : items;
  const bm = findBattleMoves(rom) ?? (gf.moves !== null ? { at: gf.moves, count: movesAll.length } : null);
  if (bm && bm.count > movesAll.length) movesAll = [...movesAll, ...Array(bm.count - movesAll.length).fill("")];
  const movePP = movesAll.map((_, i) => (bm ? rom[bm.at + i * 12 + 4] ?? 0 : 0));
  // vanilla-layout battle moves keep the type at +2, with vanilla type ids
  const moveTypes = bm ? movesAll.map((_, i) => (i === 0 ? "" : vanillaType(rom[bm.at + i * 12 + 2] ?? 0))) : null;
  const details = bm ? battleDetails(rom, bm.at, movesAll.length, moveTypes) : null;
  const moveDesc = findMoveDescriptions(rom, movesAll.length);
  const info: (SpeciesInfo | null)[] = sp.map(() => null);
  const bs = { at: gf.speciesInfo + 28, stride: 28 };
  for (let i = 1; i < sp.length; i++) {
    const o = gf.speciesInfo + i * 28;
    if (o + 28 > rom.length) break;
    const t1 = vanillaType(rom[o + 6]), t2 = vanillaType(rom[o + 7]);
    info[i] = {
      bs: Array.from(rom.subarray(o, o + 6)), t: [...new Set([t1, t2])],
      g: rom[o + 16], gr: rom[o + 19] <= 5 ? rom[o + 19] : null,
      ab: [rom[o + 22], rom[o + 23] === rom[o + 22] ? 0 : rom[o + 23], rom[o + 26] || 0],
    };
  }
  report.push(`${sp.length - 1} species`, `${movesAll.length - 1} moves`, `${itemsAll.length - 1} items`, `${abilitiesAll.length - 1} abilities`, "read via the ROM's GF header");
  return { sp, moves: movesAll, movePP, moveTypes, details, moveDesc, items: itemsAll, abilities: abilitiesAll, info, bs };
}

export interface RomLoadResult {
  data: GameData; header: RomHeader; report: string[];
  record: { at: number; stride: number } | null;
  gf: GfHeader | null;
}

/** Whether the header's species table uses vanilla 28-byte base stats. Older pokeemerald-expansion
 *  releases fill in the same header pointers but with their own, larger records. */
function vanillaSpeciesLayout(rom: Uint8Array, gf: GfHeader): boolean {
  if (gf.speciesInfo === null) return false;
  let ok = 0, n = 0;
  for (let s = 1; s <= 150; s++) {
    const o = gf.speciesInfo + s * 28;
    if (o + 28 > rom.length) break;
    n++;
    const stats = rom.subarray(o, o + 6);
    const good = [...stats].every(v => v > 0) && rom[o + 6] < 32 && rom[o + 7] < 32 && rom[o + 19] <= 5
      && [0, 31, 63, 127, 191, 225, 254, 255].includes(rom[o + 16]);
    if (good) ok++;
  }
  return n > 0 && ok >= n * 0.9;
}

export function loadRomData(rom: Uint8Array): RomLoadResult {
  const res = loadTables(rom);
  try {
    const d = res.data;
    // expansion keeps learnset pointers in its species records; vanilla layouts use separate tables
    const rec = res.gf && res.gf.speciesNames !== null ? null : res.record;
    d.learn = findLearnsets(rom, d.species.length, d.moves.length, res.header.code, rec);
    res.report.push(...d.learn.report);
  } catch { res.report.push("learnsets not found"); }
  return res;
}

function loadTables(rom: Uint8Array): RomLoadResult {
  const header = readRomHeader(rom);
  const report: string[] = [];
  if (!header.isGba) throw new Error("This file isn't a GBA ROM (its header check byte is missing).");
  const gf = readGfHeader(rom);
  // Vanilla-layout ROMs keep species names in their own table; expansion leaves that pointer empty.
  const viaHeader = gf && gf.speciesNames !== null && vanillaSpeciesLayout(rom, gf) ? loadFromGfHeader(rom, gf, report) : null;
  if (viaHeader) {
    const { sp, moves, movePP, moveTypes, details, moveDesc, items, abilities, info, bs } = viaHeader;
    const shedinja = sp.findIndex(n => norm(n) === "SHEDINJA");
    return {
      data: {
        id: `rom-${header.code}-${header.title}`, label: `From ROM: ${header.title || header.code}`, source: "rom",
        species: sp, nat: sp.map(() => 0), info, moves, movePP, moveTypes: moveTypes ?? undefined,
        movePower: details?.power, moveAcc: details?.acc, moveCat: details?.cat, moveDesc: moveDesc ?? undefined,
        items, abilities, shedinja: shedinja > 0 ? shedinja : 303,
        notes: [],
      },
      header, report, record: bs, gf,
    };
  }
  const res = scanRomData(rom, header, report);
  return { ...res, gf };
}

function scanRomData(rom: Uint8Array, header: RomHeader, report: string[]): Omit<RomLoadResult, "gf"> {
  const bulbasaur = findNameTable(rom, ["Bulbasaur", "Ivysaur", "Venusaur"], 13);
  // no Bulbasaur at #1: a hack with its own species order (regional dex, fakemon)
  const regional = !bulbasaur;
  const spTable = bulbasaur ?? findTableByEntryZero(rom, "??????????", [11, 12, 13], 100);
  if (!spTable) throw new Error("Couldn't find this ROM's Pokémon tables. It may be a hack whose engine this editor doesn't know yet.");
  const mvTable = findNameTable(rom, ["Pound", "Karate Chop", "Double Slap"], 17);
  // inline name tables often sit back to back; species names end where the move names begin
  let spCap = 2047;
  if (mvTable && spTable.kind === "inline" && mvTable.kind === "inline" && mvTable.at > spTable.at)
    spCap = Math.min(spCap, Math.floor((mvTable.at - mvTable.stride - spTable.at) / spTable.stride));
  const sp = readNames(rom, spTable, spCap);
  report.push(`${sp.length - 1} species names`);

  const moves = mvTable ? readNames(rom, mvTable, 2047) : [""];
  report.push(mvTable ? `${moves.length - 1} moves` : "move names not found");
  const pp = findPP(rom, mvTable && mvTable.kind === "pointer" ? mvTable : null, moves.length);
  let moveTypes: string[] | null = null;
  if (mvTable && mvTable.kind === "pointer") {
    // expansion MoveInfo: the type is a byte somewhere in the record that holds the name pointer
    const s0 = mvTable.stride, rec = (mv: number) => mvTable.at + (mv - 1) * s0;
    for (const base of [0, -Math.min(s0, 64)]) {
      moveTypes = learnMoveTypes(moves.length, s0, (mv, k) => rom[rec(mv) + base + k] ?? 0, () => "Mystery");
      if (moveTypes) break;
    }
  }
  if (!moveTypes) {
    const bm = findBattleMoves(rom);
    if (bm) moveTypes = learnMoveTypes(moves.length, 12, (mv, k) => rom[bm.at + mv * 12 + k] ?? 0, () => "Mystery");
  }
  // older expansion: a separate battle-move table with its own record size
  let ppAll = pp, movePower: number[] | undefined, moveAcc: number[] | undefined, moveCat: ("Physical" | "Special" | "Status")[] | undefined;
  const mr = findMoveRecords(rom);
  if (mr) {
    const byteAt = (mv: number, k: number) => rom[mr.at + mv * mr.stride + k] ?? 0;
    ppAll ??= moves.map((_, i) => byteAt(i, 0));
    movePower = moves.map((_, i) => byteAt(i, mr.power));
    const ACC10 = [100, 100, 85, 85, 85, 100, 100, 100, 100, 100];
    for (let k = -mr.stride + 1; k < mr.stride && !moveAcc; k++) {
      if (k === 0 || k === mr.power) continue;
      let n = 0; for (let i = 0; i < 10; i++) if (byteAt(i + 1, k) === ACC10[i]) n++;
      if (n >= 8) moveAcc = moves.map((_, i) => byteAt(i, k));
    }
    const lo = -Math.min(mr.stride - 1, mr.at % mr.stride + mr.stride);
    if (!moveTypes) for (let base = lo; base < 0 && !moveTypes; base++) {
      // the type sits near the power; try the record window that starts at `base`
      moveTypes = learnMoveTypes(moves.length, mr.stride, (mv, k) => byteAt(mv, base + k), () => "Mystery");
    }
    for (let base = lo; base < 0 && !moveCat; base++) {
      const c = learnCategories(moves.length, mr.stride, (mv, k) => byteAt(mv, base + k));
      if (c) moveCat = c;
    }
  }
  if (!moveCat && moveTypes && movePower) {
    const SPECIAL = new Set(["Fire", "Water", "Grass", "Electric", "Psychic", "Ice", "Dragon", "Dark"]);
    moveCat = moves.map((_, i) => movePower![i] === 0 ? "Status" : SPECIAL.has(moveTypes![i]) ? "Special" : "Physical");
  }
  if (!ppAll) report.push("move PP not found");

  const itTable = findNameTable(rom, ["Master Ball", "Ultra Ball", "Great Ball"], 21)
    ?? findNameTable(rom, ["Poké Ball", "Great Ball", "Ultra Ball"], 21)      // later item orders
    ?? findNameTable(rom, ["Strange Ball", "Poké Ball", "Great Ball"], 21);
  const items = itTable ? readNames(rom, itTable, 1500) : [""];
  report.push(itTable ? `${items.length - 1} items` : "item names not found");

  const abTable = findNameTable(rom, ["Stench", "Drizzle", "Speed Boost"], 17)
    ?? (regional ? findTableByEntryZero(rom, "-------", [13, 17], 50) : null);
  const abilities = abTable ? readNames(rom, abTable, 1000) : [""];
  report.push(abTable ? `${abilities.length - 1} abilities` : "ability names not found");

  const curves = findExpTables(rom);
  let expTable: number[][] | undefined, growthNames: string[] | undefined;
  const bs = regional ? findBaseStatsByName(rom, sp) : findBaseStats(rom);
  const info: (SpeciesInfo | null)[] = sp.map(() => null);
  if (bs && regional) {
    const r = learnByName(rom, bs, sp, abilities, curves);
    info.splice(0, info.length, ...r.info);
    if (curves && !standardCurves(curves)) {
      expTable = curves.rows;
      growthNames = curves.rows.map((_, i) => curves.std[i] === null ? `Curve ${i}` : GROWTH_NAMES[curves.std[i]!] + (curves.exact[i] ? "" : " (modified)"));
    }
    report.push(`base stats (${bs.stride}-byte records, found by name${r.missing.length ? `; ${r.missing.join(", ")} not found` : ""})`);
    if (expTable) report.push("custom EXP curves");
  } else if (bs) {
    const rec = (i: number) => bs.at + (i - 1) * bs.stride;
    const g = learnField(rom, bs.at, bs.stride, GENDER);
    const gr = learnField(rom, bs.at, bs.stride, GROWTH);
    let abW = 1, ab = learnField(rom, bs.at, bs.stride, ABILITY1, 1);
    if (ab === null) { abW = 2; ab = learnField(rom, bs.at, bs.stride, ABILITY1, 2); }
    else {
      // u8 slots (vanilla, CFRU) put ability 2 right after ability 1, so that byte is often set;
      // u16 slots (expansion) put the high byte there, which is almost always zero.
      let nonzero = 0, n = 0;
      for (let i = 1; i < Math.min(sp.length, 387); i++) {
        const o = rec(i) + ab + 1;
        if (o >= rom.length) break;
        n++; if (rom[o] !== 0) nonzero++;
      }
      if (n && nonzero / n < 0.1) abW = 2;
    }
    const hid = learnField(rom, bs.at, bs.stride, HIDDEN, abW);
    // types: one byte each at +6/+7 in every engine seen so far
    const typeMap = new Map<number, string>();
    let tOff: number | null = 6;
    const tv = (i: number, k: number) => rom[rec(i) + (tOff as number) + k];
    if (tv(4, 0) !== tv(4, 1) || tv(1, 0) === tv(1, 1)) tOff = null;
    if (tOff !== null) {
      for (const [s, a, b] of TYPES) { typeMap.set(tv(s, 0), a); typeMap.set(tv(s, 1), b); }
      for (const s of FAIRY_CANDIDATES) for (const k of [0, 1]) if (!typeMap.has(tv(s, k))) typeMap.set(tv(s, k), "Fairy");
    }
    const read = (o: number, k: number | null, w = 1) => (k === null ? null : w === 1 ? rom[o + k] : rom[o + k] | (rom[o + k + 1] << 8));
    for (let i = 1; i < sp.length; i++) {
      const o = rec(i);
      if (o + bs.stride > rom.length) break;
      const stats = Array.from(rom.subarray(o, o + 6));
      const types = tOff === null ? ["Normal"] : [...new Set([typeMap.get(rom[o + 6]) ?? "Mystery", typeMap.get(rom[o + 7]) ?? "Mystery"])];
      info[i] = {
        bs: stats, t: types,
        gr: (() => { const v = read(o, gr); return v !== null && v <= 5 ? v : null; })(),
        g: read(o, g) ?? 255,
        ab: [read(o, ab, abW) ?? 0, ab === null ? 0 : read(o, ab + abW, abW) ?? 0, read(o, hid, abW) ?? 0],
      };
    }
    report.push(`base stats (${bs.stride}-byte records${gr === null ? ", growth rate not found" : ""}${hid === null ? ", no hidden abilities" : ""})`);
  } else report.push("base stats not found");

  const shedinja = sp.findIndex(n => norm(n) === "SHEDINJA");
  const nat = sp.map(() => 0);
  void TYPE_NAMES;
  const gameData: GameData = {
    id: `rom-${header.code}-${header.title}`,
    label: `From ROM: ${header.title || header.code}`,
    source: "rom",
    species: sp, nat, info,
    moves, movePP: ppAll ?? moves.map(() => 0), moveTypes: moveTypes ?? undefined, movePower, moveAcc, moveCat,
    moveDesc: findMoveDescriptions(rom, moves.length) ?? undefined,
    items, abilities, shedinja, expTable, growthNames,
    notes: report.filter(r => /not found/.test(r)),
  };
  return { data: gameData, header, report, record: bs };
}

