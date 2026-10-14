// Gen III Pokémon record codecs.
//   vanilla     BoxPokemon 80 bytes, encrypted (pokeruby/pokeemerald/pokefirered)
//   pex-modern  pokeemerald-expansion 1.8+ (bit-packed substructs)
//   pex-legacy  pokeemerald-expansion 1.0-1.7
//   cfru-party  CFRU party Pokémon (vanilla layout, ball byte moved, hidden ability bit)
//   cfru-box    CFRU PC Pokémon: 58-byte compressed, unencrypted (src/pokemon_storage_system.c)
// Party records add 20 bytes (status, level, HP, stats) after the 80-byte box record.
import { u8, u16, u32, w8, w16, w32 } from "../binary";
import { decodeText, encodeText, decodeStrict } from "../text";
import { data, isValidSpecies, expForLevel, levelFromExp } from "../data";

export const BOX_SIZE = 80;
export const PARTY_SIZE = 100;
export const CFRU_BOX_SIZE = 58;

// For PID % 24: position (0-3) of [Growth, Attacks, EVs, Misc]. From GetSubstruct() in pokemon.c.
const ORDER: number[][] = [
  [0,1,2,3],[0,1,3,2],[0,2,1,3],[0,3,1,2],[0,2,3,1],[0,3,2,1],
  [1,0,2,3],[1,0,3,2],[2,0,1,3],[3,0,1,2],[2,0,3,1],[3,0,2,1],
  [1,2,0,3],[1,3,0,2],[2,1,0,3],[3,1,0,2],[2,3,0,1],[3,2,0,1],
  [1,2,3,0],[1,3,2,0],[2,1,3,0],[3,1,2,0],[2,3,1,0],[3,2,1,0],
];

export type CodecId = "vanilla" | "pex-modern" | "pex-legacy" | "cfru-party" | "cfru-box";

export interface Pokemon {
  codec: CodecId;            // codec that produced this record
  pid: number;
  otId: number;              // TID low 16 bits, SID high 16 bits
  nickname: string;
  language: number;
  flags: number;             // byte 0x13: bit0 bad egg, bit1 has species, bit2 egg name (other bits kept)
  otName: string;
  markings: number;          // 4 marking bits
  species: number;
  heldItem: number;
  exp: number;
  ppBonuses: number;
  friendship: number;
  moves: number[];
  pp: number[];
  evs: number[];             // HP, Atk, Def, Spe, SpA, SpD
  contest: number[];
  pokerus: number;
  metLocation: number;
  metLevel: number;
  metGame: number;
  otGender: number;
  ball: number;
  ivs: number[];
  isEgg: boolean;
  abilityNum: number;        // 0, 1, or 2 (hidden). CFRU derives 0/1 from the PID.
  shinyMod: number;          // expansion: flips shininess without changing the PID
  natureMod: number;         // expansion: XORed with PID nature to give the stat nature (mints)
  party?: PartyExtra;
  checksumOk: boolean;
  /** Decrypted 48 bytes in canonical order (Growth, Attacks, EVs, Misc), kept so unmodelled bits survive. */
  secure?: Uint8Array;
  raw?: Uint8Array;
  origNick?: string;
  dirty?: boolean;
}

export interface PartyExtra {
  status: number; level: number; mail: number; hp: number;
  stats: number[];           // maxHP, Atk, Def, Spe, SpA, SpD
}

// ---- Bit helpers (little-endian, window of up to 32 bits starting at a byte) ----

type Bits = [byteOffset: number, bit: number, width: number];

function getBits(b: Uint8Array, [o, bit, w]: Bits): number {
  const v = (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  return w === 32 ? v : (v >>> bit) & ((1 << w) - 1);
}
function setBits(b: Uint8Array, [o, bit, w]: Bits, value: number) {
  const cur = (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  const mask = w === 32 ? 0xffffffff : (((1 << w) - 1) << bit) >>> 0;
  const next = ((cur & ~mask) | (((value << bit) >>> 0) & mask)) >>> 0;
  b[o] = next & 0xff; b[o + 1] = (next >>> 8) & 0xff; b[o + 2] = (next >>> 16) & 0xff; b[o + 3] = (next >>> 24) & 0xff;
}

// ---- Codec specs for the 80-byte encrypted family ----
// Offsets in the secure area are canonical: Growth 0-11, Attacks 12-23, EVs 24-35, Misc 36-47.

interface FullSpec {
  id: Exclude<CodecId, "cfru-box">;
  label: string;
  nickLen: number;
  species: Bits; item: Bits; exp: Bits;
  nick11?: Bits; nick12?: Bits;
  ball: Bits;                         // in secure area
  moves: Bits[]; pp: Bits[];
  metGame: Bits; metLevel: Bits; otGender: Bits;
  egg: Bits;
  ability: { kind: "bit"; bits: Bits } | { kind: "num"; bits: Bits } | { kind: "cfru"; hidden: Bits };
  language: Bits; natureMod?: Bits; markings: Bits; shinyMod?: Bits;   // header (record-relative)
  maxSpecies: number; maxItem: number; maxMove: number; maxPP: number;
}

const VANILLA_MOVES: Bits[] = [[12, 0, 16], [14, 0, 16], [16, 0, 16], [18, 0, 16]];
const VANILLA_PP: Bits[] = [[20, 0, 8], [21, 0, 8], [22, 0, 8], [23, 0, 8]];

const SPECS: Record<FullSpec["id"], FullSpec> = {
  vanilla: {
    id: "vanilla", label: "Gen III", nickLen: 10,
    species: [0, 0, 16], item: [2, 0, 16], exp: [4, 0, 32], ball: [38, 11, 4],
    moves: VANILLA_MOVES, pp: VANILLA_PP,
    metLevel: [38, 0, 7], metGame: [38, 7, 4], otGender: [38, 15, 1], egg: [40, 30, 1],
    ability: { kind: "bit", bits: [40, 31, 1] },
    language: [0x12, 0, 8], markings: [0x1b, 0, 8],
    maxSpecies: 0xffff, maxItem: 0xffff, maxMove: 0xffff, maxPP: 255,
  },
  "pex-legacy": {
    id: "pex-legacy", label: "pokeemerald-expansion 1.0–1.7", nickLen: 10,
    species: [0, 0, 16], item: [2, 0, 16], exp: [4, 0, 32], ball: [10, 0, 5],
    moves: VANILLA_MOVES, pp: VANILLA_PP,
    metLevel: [38, 0, 7], metGame: [38, 7, 4], otGender: [38, 15, 1], egg: [40, 30, 1],
    ability: { kind: "num", bits: [44, 29, 2] },
    language: [0x12, 0, 8], markings: [0x1b, 0, 8],
    maxSpecies: 0xffff, maxItem: 0xffff, maxMove: 0xffff, maxPP: 255,
  },
  "pex-modern": {
    id: "pex-modern", label: "pokeemerald-expansion 1.8+", nickLen: 12,
    species: [0, 0, 11], item: [2, 0, 10], exp: [4, 0, 21], nick11: [4, 21, 8], ball: [10, 0, 6], nick12: [10, 6, 8],
    moves: [[12, 0, 11], [14, 0, 11], [16, 0, 11], [18, 0, 11]],
    pp: [[20, 0, 7], [21, 0, 7], [22, 0, 7], [23, 0, 7]],
    metLevel: [38, 0, 7], metGame: [38, 7, 4], otGender: [38, 15, 1], egg: [40, 30, 1],
    ability: { kind: "num", bits: [44, 29, 2] },
    language: [0x12, 0, 3], natureMod: [0x12, 3, 5], markings: [0x1b, 0, 4], shinyMod: [0x1e, 14, 1],
    maxSpecies: 2047, maxItem: 1023, maxMove: 2047, maxPP: 127,
  },
  "cfru-party": {
    id: "cfru-party", label: "CFRU", nickLen: 10,
    species: [0, 0, 16], item: [2, 0, 16], exp: [4, 0, 32], ball: [10, 0, 8],
    moves: VANILLA_MOVES, pp: VANILLA_PP,
    metLevel: [38, 0, 7], metGame: [38, 7, 4], otGender: [38, 15, 1], egg: [40, 30, 1],
    ability: { kind: "cfru", hidden: [40, 31, 1] },
    language: [0x12, 0, 8], markings: [0x1b, 0, 8],
    maxSpecies: 0xffff, maxItem: 0xffff, maxMove: 0xffff, maxPP: 255,
  },
};

export interface CodecInfo {
  id: CodecId; label: string; nickLen: number; maxSpecies: number; maxItem: number; maxMove: number;
  encrypted: boolean; storesPP: boolean; hasShinyMod: boolean; hasNatureMod: boolean; abilityKind: "bit" | "num" | "cfru";
  size: number;
}

export function codecInfo(id: CodecId): CodecInfo {
  if (id === "cfru-box") return {
    id, label: "CFRU PC (compressed)", nickLen: 10, maxSpecies: 0xffff, maxItem: 0xffff, maxMove: 1023,
    encrypted: false, storesPP: false, hasShinyMod: false, hasNatureMod: false, abilityKind: "cfru", size: CFRU_BOX_SIZE,
  };
  const s = SPECS[id];
  return {
    id, label: s.label, nickLen: s.nickLen, maxSpecies: s.maxSpecies, maxItem: s.maxItem, maxMove: s.maxMove,
    encrypted: true, storesPP: true, hasShinyMod: !!s.shinyMod, hasNatureMod: !!s.natureMod, abilityKind: s.ability.kind, size: BOX_SIZE,
  };
}

// ---- Decoding ----

export function isEmptyRecord(b: Uint8Array, o: number): boolean {
  return u32(b, o) === 0 && u32(b, o + 4) === 0 && (u8(b, o + 0x13) & 0x02) === 0;
}

export function decodePokemon(b: Uint8Array, o: number, isParty: boolean, codec: CodecId = "vanilla"): Pokemon | null {
  const m = codec === "cfru-box" ? decodeCompressed(b, o) : decodeFull(b, o, SPECS[codec]);
  if (m && isParty) {
    m.party = {
      status: u32(b, o + 0x50), level: u8(b, o + 0x54), mail: u8(b, o + 0x55), hp: u16(b, o + 0x56),
      stats: [0, 1, 2, 3, 4, 5].map(i => u16(b, o + 0x58 + i * 2)),
    };
    m.raw = b.slice(o, o + PARTY_SIZE);
  }
  return m;
}

function decodeFull(b: Uint8Array, o: number, s: FullSpec): Pokemon | null {
  if (isEmptyRecord(b, o)) return null;
  const pid = u32(b, o), otId = u32(b, o + 4), key = (pid ^ otId) >>> 0;
  const pos = ORDER[pid % 24];
  const sec = new Uint8Array(48);
  let sum = 0;
  for (let blk = 0; blk < 4; blk++) {
    for (let i = 0; i < 12; i += 4) {
      const v = (u32(b, o + 0x20 + pos[blk] * 12 + i) ^ key) >>> 0;
      w32(sec, blk * 12 + i, v);
    }
  }
  for (let i = 0; i < 48; i += 2) sum = (sum + u16(sec, i)) & 0xffff;
  const hdr = b.subarray(o, o + 0x20);
  let nickname = decodeText(b, o + 8, 10);
  if (s.nick11 && nickname.length === 10) {
    // Characters 11-12 live in spare bits; older expansion releases leave junk there, so stop at anything unprintable.
    let add = "";
    for (const c of [getBits(sec, s.nick11), getBits(sec, s.nick12!)]) {
      const t = c === 0xff ? null : decodeStrict(new Uint8Array([c, 0xff]), 0, 2);
      if (!t) break;
      add += t;
    }
    nickname += add.replace(/ +$/, "");
  }
  const ivw = u32(sec, 40);
  const abilityNum = s.ability.kind === "cfru"
    ? (getBits(sec, s.ability.hidden) ? 2 : pid & 1)
    : getBits(sec, s.ability.bits);
  const mon: Pokemon = {
    codec: s.id, pid, otId, nickname,
    language: getBits(hdr, s.language),
    flags: u8(b, o + 0x13),
    otName: decodeText(b, o + 0x14, 7),
    markings: getBits(hdr, s.markings) & 0xf,
    species: getBits(sec, s.species), heldItem: getBits(sec, s.item), exp: getBits(sec, s.exp),
    ppBonuses: sec[8], friendship: sec[9],
    moves: s.moves.map(x => getBits(sec, x)),
    pp: s.pp.map(x => getBits(sec, x)),
    evs: [0, 1, 2, 3, 4, 5].map(i => sec[24 + i]),
    contest: [0, 1, 2, 3, 4, 5].map(i => sec[30 + i]),
    pokerus: sec[36], metLocation: sec[37],
    metLevel: getBits(sec, s.metLevel), metGame: getBits(sec, s.metGame), otGender: getBits(sec, s.otGender),
    ball: getBits(sec, s.ball),
    ivs: [0, 1, 2, 3, 4, 5].map(i => (ivw >>> (i * 5)) & 31),
    isEgg: getBits(sec, s.egg) === 1,
    abilityNum,
    shinyMod: s.shinyMod ? getBits(hdr, s.shinyMod) : 0,
    natureMod: s.natureMod ? getBits(hdr, s.natureMod) : 0,
    checksumOk: sum === u16(b, o + 0x1c),
    secure: sec,
    raw: b.slice(o, o + BOX_SIZE),
  };
  mon.origNick = nickname;
  return mon;
}

// CFRU CompressedPokemon (packed): verified layout with gcc
//  0x00 pid, 0x04 otid, 0x08 nickname[10], 0x12 language, 0x13 sanity, 0x14 otname[7], 0x1B markings,
//  0x1C species u16, 0x1E item u16, 0x20 exp u32, 0x24 ppBonuses, 0x25 friendship, 0x26 ball,
//  0x27 moves 4x10 bits (40 bits), 0x2C EVs[6], 0x32 pokerus, 0x33 metLocation, 0x34 metInfo u16, 0x36 IVs u32
function decodeCompressed(b: Uint8Array, o: number): Pokemon | null {
  const species = u16(b, o + 0x1c);
  if (species === 0) return null; // CFRU treats species 0 as an empty slot
  const lo = u32(b, o + 0x27), hi = b[o + 0x2b];
  const moves = [lo & 0x3ff, (lo >>> 10) & 0x3ff, (lo >>> 20) & 0x3ff, ((lo >>> 30) | (hi << 2)) & 0x3ff];
  const pid = u32(b, o);
  const ivw = u32(b, o + 0x36), metInfo = u16(b, o + 0x34);
  const m: Pokemon = {
    codec: "cfru-box", pid, otId: u32(b, o + 4),
    nickname: decodeText(b, o + 8, 10), language: b[o + 0x12], flags: b[o + 0x13],
    otName: decodeText(b, o + 0x14, 7), markings: b[o + 0x1b] & 0xf,
    species, heldItem: u16(b, o + 0x1e), exp: u32(b, o + 0x20), ppBonuses: b[o + 0x24], friendship: b[o + 0x25],
    ball: b[o + 0x26], moves, pp: [0, 0, 0, 0],
    evs: [0, 1, 2, 3, 4, 5].map(i => b[o + 0x2c + i]), contest: [0, 0, 0, 0, 0, 0],
    pokerus: b[o + 0x32], metLocation: b[o + 0x33],
    metLevel: metInfo & 0x7f, metGame: (metInfo >>> 7) & 0xf, otGender: (metInfo >>> 15) & 1,
    ivs: [0, 1, 2, 3, 4, 5].map(i => (ivw >>> (i * 5)) & 31), isEgg: ((ivw >>> 30) & 1) === 1,
    abilityNum: (ivw >>> 31) & 1 ? 2 : pid & 1,
    shinyMod: 0, natureMod: 0, checksumOk: true,
    raw: b.slice(o, o + CFRU_BOX_SIZE),
  };
  m.pp = m.moves.map((mv, i) => maxPP(mv, m.ppBonuses, i)); // the game restores PP on withdrawal
  return m;
}

// ---- Encoding ----

/** Writes `mon` into `b` at `o` using `codec`, re-encrypting and recomputing the checksum. */
export function encodePokemon(mon: Pokemon, b: Uint8Array, o: number, isParty: boolean, codec: CodecId = "vanilla"): void {
  const size = isParty ? PARTY_SIZE : codecInfo(codec).size;
  if (!mon.dirty && mon.raw && mon.codec === codec && mon.raw.length >= size) { b.set(mon.raw.subarray(0, size), o); return; }
  if (codec === "cfru-box") encodeCompressed(mon, b, o);
  else encodeFull(mon, b, o, SPECS[codec]);
  if (isParty) {
    if (!mon.party) toParty(mon);
    const p = mon.party!;
    w32(b, o + 0x50, p.status); w8(b, o + 0x54, p.level); w8(b, o + 0x55, p.mail); w16(b, o + 0x56, p.hp);
    p.stats.forEach((s, i) => w16(b, o + 0x58 + i * 2, s));
  }
  mon.checksumOk = true;
}

function encodeFull(mon: Pokemon, b: Uint8Array, o: number, s: FullSpec) {
  const sameCodec = mon.codec === s.id;
  const sec = sameCodec && mon.secure ? mon.secure.slice() : new Uint8Array(48);
  const hdr = sameCodec && mon.raw ? mon.raw.slice(0, 0x20) : new Uint8Array(0x20);
  if (!sameCodec && mon.raw && mon.raw.length >= 0x1c) hdr.set(mon.raw.subarray(0, 0x1c)); // same header layout in every codec
  setBits(sec, s.species, mon.species); setBits(sec, s.item, mon.heldItem); setBits(sec, s.exp, mon.exp);
  sec[8] = mon.ppBonuses & 0xff; sec[9] = mon.friendship & 0xff;
  s.moves.forEach((x, i) => setBits(sec, x, mon.moves[i]));
  s.pp.forEach((x, i) => setBits(sec, x, Math.min(mon.pp[i], s.maxPP)));
  mon.evs.forEach((v, i) => { sec[24 + i] = v & 0xff; });
  mon.contest.forEach((v, i) => { sec[30 + i] = v & 0xff; });
  sec[36] = mon.pokerus & 0xff; sec[37] = mon.metLocation & 0xff;
  setBits(sec, s.metLevel, mon.metLevel); setBits(sec, s.metGame, mon.metGame); setBits(sec, s.otGender, mon.otGender);
  setBits(sec, s.ball, mon.ball);
  let ivw = getBits(sec, [40, 30, 2]) << 30; // keep the top two bits, then rewrite the ones we model
  mon.ivs.forEach((v, i) => { ivw |= (v & 31) << (i * 5); });
  w32(sec, 40, ivw >>> 0);
  setBits(sec, s.egg, mon.isEgg ? 1 : 0);
  if (s.ability.kind === "bit") setBits(sec, s.ability.bits, mon.abilityNum & 1);
  else if (s.ability.kind === "num") setBits(sec, s.ability.bits, Math.min(mon.abilityNum, 2));
  else setBits(sec, s.ability.hidden, mon.abilityNum === 2 ? 1 : 0);

  // nickname: first 10 characters in the header, 11th/12th in the Growth block (expansion)
  const chars = [...mon.nickname];
  const head = chars.slice(0, 10).join("");
  const nickUnchanged = sameCodec && mon.origNick === mon.nickname;
  if (s.nick11 && !nickUnchanged) {
    const tail = new Uint8Array(3);
    encodeText(chars.slice(10, 12).join(""), tail, 0, 2);
    setBits(sec, s.nick11, chars.length > 10 ? tail[0] : 0xff);
    setBits(sec, s.nick12!, chars.length > 11 ? tail[1] : 0xff);
  }

  let sum = 0;
  for (let i = 0; i < 48; i += 2) sum = (sum + u16(sec, i)) & 0xffff;

  w32(hdr, 0, mon.pid); w32(hdr, 4, mon.otId);
  if (!nickUnchanged) writeName(mon, head, 8, 10, hdr);
  setBits(hdr, s.language, mon.language);
  if (s.natureMod) setBits(hdr, s.natureMod, mon.natureMod);
  let flags = mon.flags & ~0x06;
  if (mon.species !== 0) flags |= 0x02;
  if (mon.isEgg) flags |= 0x04;
  hdr[0x13] = flags;
  writeName(mon, mon.otName, 0x14, 7, hdr);
  setBits(hdr, s.markings, s.markings[2] === 4 ? mon.markings & 0xf : ((hdr[0x1b] & 0xf0) | (mon.markings & 0xf)));
  if (s.shinyMod) setBits(hdr, s.shinyMod, mon.shinyMod & 1);
  w16(hdr, 0x1c, sum);
  b.set(hdr, o);
  const key = (mon.pid ^ mon.otId) >>> 0;
  const pos = ORDER[mon.pid % 24];
  for (let blk = 0; blk < 4; blk++)
    for (let i = 0; i < 12; i += 4)
      w32(b, o + 0x20 + pos[blk] * 12 + i, (u32(sec, blk * 12 + i) ^ key) >>> 0);
  mon.secure = sec;
  mon.origNick = mon.nickname;
  mon.codec = s.id;
  mon.raw = b.slice(o, o + BOX_SIZE);
}

function encodeCompressed(mon: Pokemon, b: Uint8Array, o: number) {
  const same = mon.codec === "cfru-box" && mon.raw;
  const r = same ? mon.raw!.slice(0, CFRU_BOX_SIZE) : new Uint8Array(CFRU_BOX_SIZE);
  w32(r, 0, mon.pid); w32(r, 4, mon.otId);
  writeName(mon, [...mon.nickname].slice(0, 10).join(""), 8, 10, r);
  r[0x12] = mon.language & 0xff;
  let flags = mon.flags & ~0x06;
  if (mon.species !== 0) flags |= 0x02;
  if (mon.isEgg) flags |= 0x04;
  r[0x13] = flags;
  writeName(mon, mon.otName, 0x14, 7, r);
  r[0x1b] = (r[0x1b] & 0xf0) | (mon.markings & 0xf);
  w16(r, 0x1c, mon.species); w16(r, 0x1e, mon.heldItem); w32(r, 0x20, mon.exp);
  r[0x24] = mon.ppBonuses; r[0x25] = mon.friendship; r[0x26] = mon.ball;
  const mv = mon.moves.map(x => x & 0x3ff);
  const lo = (mv[0] | (mv[1] << 10) | (mv[2] << 20) | ((mv[3] & 3) << 30)) >>> 0;
  w32(r, 0x27, lo); r[0x2b] = (mv[3] >>> 2) & 0xff;
  mon.evs.forEach((v, i) => { r[0x2c + i] = v; });
  r[0x32] = mon.pokerus; r[0x33] = mon.metLocation;
  const prev = same ? u16(r, 0x34) : 0;
  w16(r, 0x34, (prev & 0x7800) | (mon.metLevel & 0x7f) | ((mon.metGame & 0xf) << 7) | ((mon.otGender & 1) << 15));
  let ivw = 0;
  mon.ivs.forEach((v, i) => { ivw |= (v & 31) << (i * 5); });
  ivw = (ivw | ((mon.isEgg ? 1 : 0) << 30) | ((mon.abilityNum === 2 ? 1 : 0) << 31)) >>> 0;
  w32(r, 0x36, ivw);
  b.set(r, o);
  mon.codec = "cfru-box";
  mon.raw = r;
  mon.secure = undefined;
}

/** Keeps the original bytes of a name field when the text did not change, so padding survives. */
function writeName(mon: Pokemon, text: string, rel: number, len: number, out: Uint8Array) {
  if (mon.raw && mon.raw.length >= rel + len && decodeText(mon.raw, rel, len) === text) out.set(mon.raw.subarray(rel, rel + len), rel);
  else encodeText(text, out, rel, len);
}

export function clearRecord(b: Uint8Array, o: number, size: number) { b.fill(0, o, o + size); }

/** Adds party-only data (level, stats, full HP) when a boxed Pokémon joins the party. */
export function toParty(m: Pokemon): void {
  const lvl = levelOf(m) ?? 1;
  const stats = calcStats(m, lvl) ?? [0, 0, 0, 0, 0, 0];
  m.party = { status: 0, level: lvl, mail: 0xff, hp: stats[0], stats };
  m.dirty = true;
}

// ---- Derived values ----

export const tid = (m: Pokemon) => m.otId & 0xffff;
export const sid = (m: Pokemon) => m.otId >>> 16;
const shinyValue = (m: Pokemon, pid = m.pid) => (tid(m) ^ sid(m) ^ (pid >>> 16) ^ (pid & 0xffff)) & 0xffff;
/** Nature from the PID (what Gen III shows). */
export const pidNature = (m: Pokemon) => m.pid % 25;
/** Nature used for stats; expansion mints change it without touching the PID. */
export function nature(m: Pokemon): number {
  const n = (m.pid % 25) ^ (m.natureMod || 0);
  return n < 25 ? n : m.pid % 25;
}
export function isShiny(m: Pokemon): boolean { return (shinyValue(m) < 8) !== Boolean(m.shinyMod); }
export function genderOf(species: number, pid: number): "M" | "F" | "-" {
  const r = data().info[species]?.g ?? 255;
  if (r === 255) return "-";
  if (r === 0) return "M";
  if (r === 254) return "F";
  return (pid & 0xff) < r ? "F" : "M";
}
export const gender = (m: Pokemon) => genderOf(m.species, m.pid);
export function abilityId(m: Pokemon): number {
  const ab = data().info[m.species]?.ab ?? [0, 0, 0];
  return ab[m.abilityNum] || ab[0] || 0;
}
/** Level from EXP, or the stored party level when this species' growth rate is unknown. */
export function levelOf(m: Pokemon): number | null {
  const info = data().info[m.species];
  if (info && info.gr !== null) return levelFromExp(info.gr, m.exp);
  return m.party?.level ?? null;
}
export const ballId = (m: Pokemon) => m.ball;

export function maxPP(move: number, ppBonuses: number, slot: number): number {
  const base = data().movePP[move] ?? 0;
  const ups = (ppBonuses >>> (slot * 2)) & 3;
  return base + Math.trunc((base * ups) / 5);
}

const NATURE_TABLE = (n: number, stat: number) => // stat 1..5 = Atk, Def, Spe, SpA, SpD
  Math.trunc(n / 5) === n % 5 ? 0 : Math.trunc(n / 5) === stat - 1 ? 1 : n % 5 === stat - 1 ? -1 : 0;

/** Stat formula from CalculateMonStats() in pokemon.c. Null when base stats are unknown. */
export function calcStats(m: Pokemon, level: number): number[] | null {
  const bs = data().info[m.species]?.bs;
  if (!bs || bs.every(x => x === 0)) return null;
  const out: number[] = [];
  const hp = m.species === data().shedinja ? 1
    : Math.trunc(((2 * bs[0] + m.ivs[0] + Math.trunc(m.evs[0] / 4)) * level) / 100) + level + 10;
  out.push(hp);
  for (let s = 1; s < 6; s++) {
    let n = Math.trunc(((2 * bs[s] + m.ivs[s] + Math.trunc(m.evs[s] / 4)) * level) / 100) + 5;
    const mod = NATURE_TABLE(nature(m), s);
    if (mod === 1) n = Math.trunc((n * 110) / 100);
    if (mod === -1) n = Math.trunc((n * 90) / 100);
    out.push(n);
  }
  return out;
}

export function canSetLevel(m: Pokemon): boolean {
  const info = data().info[m.species];
  return !!info && info.gr !== null;
}

/** Sets EXP to the minimum for `level`, and refreshes party level/stats. Returns false if the growth rate is unknown. */
export function setLevel(m: Pokemon, level: number): boolean {
  const info = data().info[m.species];
  if (!info || info.gr === null) return false;
  m.exp = expForLevel(info.gr, Math.max(1, Math.min(100, level)));
  refreshParty(m);
  return true;
}

/** Keeps the party-only cache (level, stats, HP) consistent with box data. */
export function refreshParty(m: Pokemon): void {
  if (!m.party) return;
  const lvl = levelOf(m) ?? m.party.level;
  const stats = calcStats(m, lvl);
  m.party.level = lvl;
  if (!stats) return;
  const wasFull = m.party.hp >= m.party.stats[0];
  m.party.stats = stats;
  m.party.hp = wasFull || m.party.hp > stats[0] ? stats[0] : m.party.hp;
}

/**
 * Finds a PID with the wanted nature/gender/shininess/low bit, keeping the OT ID.
 * Gen III ties these to the PID, so changing one rerolls it. `parity` is CFRU's ability slot.
 */
export function rerollPid(m: Pokemon, want: { nature?: number; gender?: "M" | "F"; shiny?: boolean; parity?: number }): number | null {
  const r = data().info[m.species]?.g ?? 255;
  const t = tid(m), s = sid(m);
  const flip = Boolean(m.shinyMod);
  const ok = (pid: number) => {
    if (want.nature !== undefined && pid % 25 !== want.nature) return false;
    if (want.parity !== undefined && (pid & 1) !== want.parity) return false;
    if (want.gender && r !== 0 && r !== 254 && r !== 255) {
      if (((pid & 0xff) < r ? "F" : "M") !== want.gender) return false;
    }
    const sh = (((t ^ s ^ (pid >>> 16) ^ (pid & 0xffff)) & 0xffff) < 8) !== flip;
    if (want.shiny !== undefined && sh !== want.shiny) return false;
    return true;
  };
  const wantRawShiny = want.shiny === undefined ? undefined : want.shiny !== flip;
  for (let tries = 0; tries < 400000; tries++) {
    let pid: number;
    if (wantRawShiny) {
      const lo = (Math.random() * 0x10000) | 0;
      const hi = (t ^ s ^ lo ^ ((Math.random() * 8) | 0)) & 0xffff;
      pid = ((hi << 16) | lo) >>> 0;
    } else pid = (Math.random() * 0x100000000) >>> 0;
    if (ok(pid)) return pid;
  }
  return null;
}

/** Sets shininess: flips the expansion modifier bit when available, otherwise rerolls the PID. */
export function setShiny(m: Pokemon, shiny: boolean, codec: CodecId): boolean {
  if (codecInfo(codec).hasShinyMod) {
    m.shinyMod = ((shinyValue(m) < 8) !== shiny) ? 1 : 0;
    return true;
  }
  const g = gender(m);
  const pid = rerollPid(m, { nature: pidNature(m), gender: g === "-" ? undefined : g, shiny, parity: codecInfo(codec).abilityKind === "cfru" && m.abilityNum < 2 ? m.pid & 1 : undefined });
  if (pid === null) return false;
  m.pid = pid;
  return true;
}

// ---- Structural validation ----

export function validatePokemon(m: Pokemon, codec: CodecId = m.codec): string[] {
  const w: string[] = [];
  const d = data(), c = codecInfo(codec);
  if (!m.checksumOk) w.push("Stored checksum does not match the data. The game shows this as a Bad Egg.");
  if (!isValidSpecies(m.species) || m.species > c.maxSpecies) w.push(`Species index ${m.species} is not a known species.`);
  const knowsItems = d.items.length > 1 && d.items.slice(1).some(Boolean);
  if (m.heldItem > c.maxItem || (knowsItems && m.heldItem > 0 && !d.items[m.heldItem])) w.push(`Held item ${m.heldItem} is not a known item.`);
  m.moves.forEach((mv, i) => {
    if (mv > c.maxMove || (mv >= d.moves.length && (d.source === "rom" || codec === "vanilla"))) w.push(`Move ${i + 1} (${mv}) is out of range.`);
  });
  if (m.moves.every(mv => mv === 0)) w.push("Has no moves.");
  const evTotal = m.evs.reduce((a, b) => a + b, 0);
  if (evTotal > 510) w.push(`EV total is ${evTotal}; the game caps it at 510.`);
  const info = d.info[m.species];
  if (info && info.gr !== null && m.exp > expForLevel(info.gr, 100)) w.push("EXP is above the level 100 maximum.");
  if (m.abilityNum === 2 && info && !info.ab[2]) w.push("Hidden ability is set, but this species has none.");
  return w;
}

/** How plausible a decoded record is, 0-1. Used to pick the engine that best fits a save. */
export function plausibility(m: Pokemon, codec: CodecId): number {
  const c = codecInfo(codec);
  let score = 0, total = 0;
  const check = (ok: boolean, weight = 1) => { total += weight; if (ok) score += weight; };
  check(m.checksumOk, 3);
  check(m.species > 0 && m.species <= c.maxSpecies && isValidSpecies(m.species), 3);
  check(m.moves.every(x => x <= Math.min(c.maxMove, data().moves.length + 1200)) && m.moves[0] > 0, 2);
  check(m.ball > 0 && m.ball <= 30, 1);
  check(m.heldItem <= (c.maxItem === 0xffff ? 2000 : c.maxItem));
  const info = data().info[m.species];
  if (info && info.gr !== null) check(m.exp <= expForLevel(info.gr, 100), 2);
  if (m.party && info && info.gr !== null) check(levelFromExp(info.gr, m.exp) === m.party.level, 2);
  return total ? score / total : 0;
}

export function cloneMon(m: Pokemon): Pokemon { return structuredClone(m); }

