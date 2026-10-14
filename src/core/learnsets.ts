// Reads which moves each species learns from the user's ROM: by level, by TM/HM (or an engine's
// "teachable" list), and as egg moves. Nothing here is bundled; without a ROM there are no learnsets.
//
// Formats handled:
//   level-up  vanilla      u16 (level << 9 | move), ends 0xFFFF           (pokeemerald, pokefirered)
//             CFRU / DPE   packed { u16 move; u8 level }, ends {0, 0xFF}
//             expansion    { u16 move; u16 level }, ends move 0xFFFF
//   TM/HM     vanilla      u16 move per TM/HM, plus a per-species bitfield (8 or 16 bytes)
//             expansion    per-species u16 list ("teachable"), ends 0xFFFF
//   egg       vanilla      one u16 list: 20000 + species, its moves, next species ..., ends 0xFFFF
//             expansion    per-species u16 list, ends 0xFFFF
import { u16, u32 } from "./binary";

export interface Learnsets {
  /** [level, move] pairs per species, in the game's order. */
  levelUp: ([number, number][] | null)[];
  /** Moves taught by TM/HM (vanilla, CFRU) or the engine's teachable list (expansion). */
  teach: (number[] | null)[];
  egg: (number[] | null)[];
  /** TM/HM number for a move, e.g. "TM24" (vanilla layouts only). */
  tmLabel: Map<number, string>;
  teachTitle: string;
  report: string[];
}

type LvFmt = "packed16" | "packed3" | "pair32";

const ptr = (rom: Uint8Array, at: number): number | null => {
  if (at < 0 || at + 4 > rom.length) return null;
  const v = u32(rom, at);
  if (v < 0x08000000 || v >= 0x08000000 + rom.length) return null;
  return v - 0x08000000;
};

/** How many aligned words in the ROM point at `t`. Hacks that move a table leave the old copy behind,
 *  unreferenced; the live one is what the code points to. */
function refs(rom: Uint8Array, t: number): number {
  const v = 0x08000000 + t, b0 = v & 0xff, b1 = (v >> 8) & 0xff, b2 = (v >> 16) & 0xff, b3 = v >>> 24;
  let n = 0;
  for (let a = 0; a + 4 <= rom.length; a += 4) if (rom[a] === b0 && rom[a + 1] === b1 && rom[a + 2] === b2 && rom[a + 3] === b3) n++;
  return n;
}
function pickReferenced<T extends { at: number }>(rom: Uint8Array, cands: T[]): T | null {
  if (cands.length <= 1) return cands[0] ?? null;
  let best = cands[0], bestRefs = -1;
  for (const c of cands) { const r = refs(rom, c.at); if (r > bestRefs) { best = c; bestRefs = r; } }
  return best;
}

/** Reads one level-up list. `strict` also requires sorted levels, used when hunting for tables. */
function readLevelUp(rom: Uint8Array, p: number, fmt: LvFmt, moveCount: number, strict: boolean): [number, number][] | null {
  const out: [number, number][] = [];
  const step = fmt === "packed16" ? 2 : fmt === "packed3" ? 3 : 4;
  for (let i = 0; i < 80; i++) {
    const o = p + i * step;
    if (o + step > rom.length) return null;
    let mv: number, lv: number;
    if (fmt === "packed16") {
      const v = u16(rom, o);
      if (v === 0xffff) return out;
      mv = v & 0x1ff; lv = v >> 9;
      if (lv === 0 && strict) return null;
    } else if (fmt === "packed3") {
      mv = u16(rom, o); lv = rom[o + 2];
      if (lv === 0xff && (mv === 0 || mv === 0xffff)) return out;
      if (mv === 0xffff) return out;
    } else {
      mv = u16(rom, o); lv = u16(rom, o + 2);
      if (mv === 0xffff) return out;
    }
    if (mv === 0 || mv >= moveCount || lv > 100) return null;
    if (strict && out.length && lv < out[out.length - 1][0]) return null;
    out.push([lv, mv]);
  }
  return null;
}

/** A u16 move list ending in 0xFFFF (expansion teachable / egg lists). */
function readMoveList(rom: Uint8Array, p: number, moveCount: number, max = 600): number[] | null {
  const out: number[] = [];
  for (let i = 0; i < max; i++) {
    const o = p + i * 2;
    if (o + 2 > rom.length) return null;
    const v = u16(rom, o);
    if (v === 0xffff) return out;
    if (v === 0 || v >= moveCount) return null;
    out.push(v);
  }
  return null;
}

const SAMPLE = (n: number) => {
  const s = new Set<number>([1, 2, 3, 4, 7, 25]);
  for (let k = 1; k <= 14; k++) s.add(Math.floor((n - 1) * k / 15));
  return [...s].filter(x => x > 0 && x < n);
};

function tableFits(rom: Uint8Array, t: number, n: number, fmt: LvFmt, moveCount: number): boolean {
  let ok = 0, tried = 0;
  for (const s of SAMPLE(n)) {
    tried++;
    const p = ptr(rom, t + s * 4);
    if (p === null) continue;
    const l = readLevelUp(rom, p, fmt, moveCount, true);
    if (l && l.length) ok++;
  }
  return ok >= tried * 0.8;
}

/** Finds a table of pointers to level-up lists, indexed by species. */
function findLevelUpTable(rom: Uint8Array, n: number, moveCount: number, anchor: number | null): { at: number; fmt: LvFmt } | null {
  const fmts: LvFmt[] = ["packed16", "packed3", "pair32"];
  if (anchor !== null) {
    const t = ptr(rom, anchor);
    if (t !== null) for (const f of fmts) if (tableFits(rom, t, n, f, moveCount)) return { at: t, fmt: f };
  }
  const found: { at: number; fmt: LvFmt }[] = [];
  for (let a = 0; a + n * 4 <= rom.length; a += 4) {
    // species 1-3 first: cheap rejection
    const p1 = ptr(rom, a + 4);
    if (p1 === null) continue;
    const p2 = ptr(rom, a + 8), p3 = ptr(rom, a + 12);
    if (p2 === null || p3 === null) continue;
    for (const f of fmts) {
      const l1 = readLevelUp(rom, p1, f, moveCount, true);
      if (!l1 || !l1.length) continue;
      const l2 = readLevelUp(rom, p2, f, moveCount, true);
      if (!l2 || !l2.length || !readLevelUp(rom, p3, f, moveCount, true)) continue;
      if (tableFits(rom, a, n, f, moveCount)) {
        // a table whose species-0 entry is also a valid list fits one word early too; keep the shifts
        // that fit and let the code's own pointer decide
        for (let k = 0; k <= 16; k += 4) if (tableFits(rom, a + k, n, f, moveCount)) found.push({ at: a + k, fmt: f });
        a += n * 4 - 4; break;
      }
    }
  }
  return pickReferenced(rom, found);
}

const HM_SIG = [15, 19, 57, 70, 148]; // Cut, Fly, Surf, Strength, Flash: the HM order in every Gen III game

/** The TM/HM move list: from the anchor if given, else by its HM run. */
function findTmMoves(rom: Uint8Array, moveCount: number, anchor: number | null): { at: number; tms: number; total: number } | null {
  const hmAt = (start: number, limit: number) => {
    for (let j = 0; j < limit; j++) if (HM_SIG.every((m, k) => u16(rom, start + (j + k) * 2) === m)) return j;
    return -1;
  };
  const valid = (at: number, total: number) => {
    for (let i = 0; i < total; i++) { const v = u16(rom, at + i * 2); if (v === 0 || v >= moveCount) return false; }
    return true;
  };
  if (anchor !== null) {
    const t = ptr(rom, anchor);
    if (t !== null) { const j = hmAt(t, 130); if (j >= 20 && valid(t, j + 8)) return { at: t, tms: j, total: j + 8 }; }
  }
  const sig = new Uint8Array(HM_SIG.flatMap(m => [m & 0xff, m >> 8]));
  const found: { at: number; tms: number; total: number }[] = [];
  outer: for (let a = 100; a + sig.length <= rom.length; a += 2) {
    for (let k = 0; k < sig.length; k++) if (rom[a + k] !== sig[k]) continue outer;
    const start = a - 100; // 50 TMs before the HMs
    if (valid(start, 58)) found.push({ at: start, tms: 50, total: 58 });
  }
  return pickReferenced(rom, found);
}

/** Per-species TM/HM bitfields. Entry 0 (no species) is empty (or all set) and unused bits stay clear.
 *  Returns how many species the table covers (hacks that add species may not extend it), or 0. */
function bitTableRun(rom: Uint8Array, t: number, n: number, total: number, checkZero = true): number {
  const stride = total > 64 ? 16 : 8, words = stride / 4;
  if (t < 0 || t + stride * 2 > rom.length) return 0;
  const lastWord = Math.floor((total - 1) / 32), usedBits = total - lastWord * 32;
  const full = (w: number) => (w < lastWord ? 0xffffffff : w === lastWord ? (usedBits === 32 ? 0xffffffff : (2 ** usedBits) - 1) : 0);
  const e0 = Array.from({ length: words }, (_, w) => u32(rom, t + w * 4));
  if (checkZero && !e0.every(v => v === 0) && !e0.every((v, w) => v === full(w))) return 0;
  const seen = new Set<string>();
  let nonzero = 0, s = 1;
  for (; s < n && t + (s + 1) * stride <= rom.length; s++) {
    const o = t + s * stride;
    let any = false, ok = true; const key: number[] = [];
    for (let w = 0; w < words && ok; w++) {
      const v = u32(rom, o + w * 4); key.push(v);
      if (v) any = true;
      if ((w > lastWord && v) || (w === lastWord && usedBits < 32 && v >>> usedBits)) ok = false;
    }
    if (!ok) break;
    if (any) { nonzero++; seen.add(key.join(",")); }
  }
  const covered = s - 1;
  if (covered < Math.min(n - 1, 200)) return 0;
  return nonzero >= covered * 0.6 && seen.size >= covered * 0.3 ? s : 0;
}

function findTmTable(rom: Uint8Array, n: number, total: number, anchor: number | null): { at: number; count: number } | null {
  if (anchor !== null) { const t = ptr(rom, anchor); if (t !== null) { const c = bitTableRun(rom, t, n, total, false); if (c) return { at: t, count: c }; } } // the code's own pointer: trust its alignment
  const stride = total > 64 ? 16 : 8;
  const found: { at: number; count: number }[] = [];
  for (let a = 0; a + 3 * stride <= rom.length; a += 4) {
    const z = !u32(rom, a) && !u32(rom, a + 4), f = u32(rom, a) === 0xffffffff;
    if (!z && !f) continue;
    if (!u32(rom, a + stride) && !u32(rom, a + stride + 4)) continue; // species 1 must learn something
    const c = bitTableRun(rom, a, n, total);
    if (c) { found.push({ at: a, count: c }); a += c * stride - 4; }
  }
  return pickReferenced(rom, found);
}

/** The vanilla egg move list (species markers 20000 + species). */
function findEggMoves(rom: Uint8Array, n: number, moveCount: number): (number[] | null)[] | null {
  const parse = (a: number) => {
    const map = new Map<number, number[]>();
    let cur: number[] | null = null;
    for (let o = a; o + 2 <= rom.length && o < a + 0x8000; o += 2) {
      const v = u16(rom, o);
      if (v === 0xffff) return map.size >= 5 ? map : null;
      if (v > 20000 && v < 20000 + n) { cur = []; map.set(v - 20000, cur); continue; }
      if (!cur || v === 0 || v >= moveCount) return null;
      cur.push(v);
    }
    return null;
  };
  const found: { at: number; map: Map<number, number[]> }[] = [];
  for (let a = 0; a + 4 <= rom.length; a += 2) {
    const v = u16(rom, a);
    if (v <= 20000 || v >= 20000 + n) continue;
    const m = u16(rom, a + 2);
    if (m === 0 || m >= moveCount) continue;
    const map = parse(a);
    if (map) { found.push({ at: a, map }); a += [...map.values()].reduce((x, l) => x + 2 + l.length * 2, 0); }
  }
  const best = pickReferenced(rom, found);
  return best ? Array.from({ length: n }, (_, s) => best.map.get(s) ?? null) : null;
}

// FireRed/LeafGreen (and CFRU, which keeps them) load these tables through fixed literal-pool words.
const FR_ANCHORS = { levelUp: 0x43e20, tmLearn: 0x43c68, tmMoves: 0x125a8c };

/**
 * Finds the learnset tables in a ROM. `record` is the expansion SpeciesInfo layout (pointers live there);
 * pass null for vanilla-layout ROMs.
 */
export function findLearnsets(rom: Uint8Array, speciesCount: number, moveCount: number, code: string,
  record: { at: number; stride: number } | null): Learnsets {
  const n = speciesCount;
  // Hacks can add moves past the name table the editor found, so accept any plausible move id
  moveCount = Math.max(moveCount, 1024);
  const report: string[] = [];
  const isFr = /^BP[RG]/.test(code);
  const empty = () => Array.from({ length: n }, () => null);
  const res: Learnsets = { levelUp: empty(), teach: empty(), egg: empty(), tmLabel: new Map(), teachTitle: "TM & HM", report };

  // Expansion 1.8+: pointers inside each species record
  if (record && record.stride >= 40) {
    const rec = (s: number) => record.at + (s - 1) * record.stride;
    const sample = SAMPLE(Math.min(n, 1000));
    for (let k = 0; k + 12 <= record.stride; k += 4) {
      const fits = sample.filter(s => { const p = ptr(rom, rec(s) + k); return p !== null && !!readLevelUp(rom, p, "pair32", moveCount, true)?.length; }).length;
      if (fits < sample.length * 0.8) continue;
      for (let s = 1; s < n; s++) { const p = ptr(rom, rec(s) + k); res.levelUp[s] = p === null ? null : readLevelUp(rom, p, "pair32", moveCount, false); }
      const listAt = (off: number) => sample.filter(s => { const p = ptr(rom, rec(s) + off); return p !== null && readMoveList(rom, p, moveCount) !== null; }).length >= sample.length * 0.8;
      if (listAt(k + 4)) {
        for (let s = 1; s < n; s++) { const p = ptr(rom, rec(s) + k + 4); res.teach[s] = p === null ? null : readMoveList(rom, p, moveCount); }
        res.teachTitle = "TM, HM & tutor";
        report.push("teachable moves");
      }
      if (listAt(k + 8)) {
        for (let s = 1; s < n; s++) { const p = ptr(rom, rec(s) + k + 8); res.egg[s] = p === null ? null : readMoveList(rom, p, moveCount, 100); }
        report.push("egg moves");
      }
      report.unshift("level-up moves");
      return res;
    }
  }

  const lv = findLevelUpTable(rom, n, moveCount, isFr ? FR_ANCHORS.levelUp : null);
  if (lv) {
    for (let s = 1; s < n; s++) { const p = ptr(rom, lv.at + s * 4); res.levelUp[s] = p === null ? null : readLevelUp(rom, p, lv.fmt, moveCount, false); }
    report.push("level-up moves");
  } else report.push("level-up moves not found");

  const tm = findTmMoves(rom, moveCount, isFr ? FR_ANCHORS.tmMoves : null);
  const tmTable = tm ? findTmTable(rom, n, tm.total, isFr ? FR_ANCHORS.tmLearn : null) : null;
  if (tm && tmTable !== null) {
    const stride = tm.total > 64 ? 16 : 8;
    const moves = Array.from({ length: tm.total }, (_, i) => u16(rom, tm.at + i * 2));
    moves.forEach((m, i) => res.tmLabel.set(m, i < tm.tms ? `TM${String(i + 1).padStart(2, "0")}` : `HM${String(i - tm.tms + 1).padStart(2, "0")}`));
    for (let s = 1; s < Math.min(n, tmTable.count); s++) {
      const o = tmTable.at + s * stride, list: number[] = [];
      for (let i = 0; i < tm.total; i++) if (u32(rom, o + (i >> 5) * 4) & (1 << (i & 31))) list.push(moves[i]);
      res.teach[s] = list;
    }
    report.push(`TM/HM moves (${tm.tms} TMs)`);
  } else report.push("TM/HM compatibility not found");

  const egg = findEggMoves(rom, n, moveCount);
  if (egg) { res.egg = egg.map(x => x ?? []); report.push("egg moves"); }
  else report.push("egg moves not found");
  return res;
}
