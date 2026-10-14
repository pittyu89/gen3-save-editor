// Reads species, move, item and ability data from a GBA ROM by finding its tables.
// Works without knowing the hack: tables are located by the names and base stats of entries that
// every Gen III engine keeps (Bulbasaur, Pound, Master Ball, Stench...), and struct field offsets are
// learned by matching values that never changed across engines. The ROM is only read, never modified.
import { u32 } from "./binary";
import { encodeBytes, decodeStrict } from "./text";
import { GameData, SpeciesInfo, titleCase, TYPE_NAMES } from "./data";

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
    out.push(titleCase(s.trim()));
  }
  while (out.length > 1 && out[out.length - 1] === "") out.pop();
  // entry 0 (the "none" entry) sits one stride before entry 1
  const zero = entry(rom, t, 0);
  out[0] = zero === null ? "" : titleCase(zero.trim());
  return out;
}

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
  return {
    gameName: name,
    frontPics: P(0x128), normalPalettes: P(0x130), shinyPalettes: P(0x134),
    speciesNames: P(0x144), moveNames: P(0x148),
    speciesInfo: P(0x1bc), abilityNames: P(0x1c0), items: P(0x1c8), moves: P(0x1cc),
    pokemonNameLength: rom[0x176],
    saveBlock2Size: u32(rom, 0x188), saveBlock1Size: u32(rom, 0x18c), partyCountOffset: u32(rom, 0x190), partyOffset: u32(rom, 0x194),
    trainerIdOffset: u32(rom, 0x19c), playerNameOffset: u32(rom, 0x1a0),
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
  const movePP = moves.map((_, i) => (gf.moves !== null ? rom[gf.moves + i * 12 + 4] ?? 0 : 0));
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
  report.push(`${sp.length - 1} species`, `${moves.length - 1} moves`, `${items.length - 1} items`, `${abilities.length - 1} abilities`, "read via the ROM's GF header");
  return { sp, moves, movePP, items, abilities, info, bs };
}

export interface RomLoadResult {
  data: GameData; header: RomHeader; report: string[];
  record: { at: number; stride: number } | null;
  gf: GfHeader | null;
}

export function loadRomData(rom: Uint8Array): RomLoadResult {
  const header = readRomHeader(rom);
  const report: string[] = [];
  if (!header.isGba) throw new Error("This file isn't a GBA ROM (its header check byte is missing).");
  const gf = readGfHeader(rom);
  // Vanilla-layout ROMs keep species names in their own table; expansion leaves that pointer empty.
  const viaHeader = gf && gf.speciesNames !== null ? loadFromGfHeader(rom, gf, report) : null;
  if (viaHeader) {
    const { sp, moves, movePP, items, abilities, info, bs } = viaHeader;
    const shedinja = sp.findIndex(n => norm(n) === "SHEDINJA");
    return {
      data: {
        id: `rom-${header.code}-${header.title}`, label: `From ROM: ${header.title || header.code}`, source: "rom",
        species: sp, nat: sp.map(() => 0), info, moves, movePP, items, abilities, shedinja: shedinja > 0 ? shedinja : 303,
        notes: [],
      },
      header, report, record: bs, gf,
    };
  }
  const res = scanRomData(rom, header, report);
  return { ...res, gf };
}

function scanRomData(rom: Uint8Array, header: RomHeader, report: string[]): Omit<RomLoadResult, "gf"> {
  const spTable = findNameTable(rom, ["Bulbasaur", "Ivysaur", "Venusaur"], 13);
  if (!spTable) throw new Error("Couldn't find this ROM's Pokémon tables. It may be a hack whose engine this editor doesn't know yet.");
  const sp = readNames(rom, spTable, 2047);
  report.push(`${sp.length - 1} species names`);

  const mvTable = findNameTable(rom, ["Pound", "Karate Chop", "Double Slap"], 17);
  const moves = mvTable ? readNames(rom, mvTable, 2047) : [""];
  report.push(mvTable ? `${moves.length - 1} moves` : "move names not found");
  const pp = findPP(rom, mvTable && mvTable.kind === "pointer" ? mvTable : null, moves.length);
  if (!pp) report.push("move PP not found");

  const itTable = findNameTable(rom, ["Master Ball", "Ultra Ball", "Great Ball"], 21);
  const items = itTable ? readNames(rom, itTable, 1500) : [""];
  report.push(itTable ? `${items.length - 1} items` : "item names not found");

  const abTable = findNameTable(rom, ["Stench", "Drizzle", "Speed Boost"], 17);
  const abilities = abTable ? readNames(rom, abTable, 1000) : [""];
  report.push(abTable ? `${abilities.length - 1} abilities` : "ability names not found");

  const bs = findBaseStats(rom);
  const info: (SpeciesInfo | null)[] = sp.map(() => null);
  if (bs) {
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
    moves, movePP: pp ?? moves.map(() => 0),
    items, abilities, shedinja,
    notes: report.filter(r => /not found/.test(r)),
  };
  return { data: gameData, header, report, record: bs };
}

