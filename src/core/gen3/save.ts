// Gen III flash save: 32 sectors of 0x1000 bytes. Slot A = sectors 0-13, slot B = 14-27.
// Footer (from include/save.h): 0xFF4 id u16, 0xFF6 checksum u16, 0xFF8 signature u32, 0xFFC counter u32.
import { u16, u32, w16, w32, sectorChecksum } from "../binary";
import { decodeText, encodeText, decodeStrict } from "../text";
import { GameProfile, PROFILES, Family, Block, Loc, getProfile, profilesForFamily } from "../profiles";
import { Pokemon, decodePokemon, encodePokemon, clearRecord, codecInfo, plausibility, PARTY_SIZE } from "./pokemon";
import { GameData, data, setData, VANILLA, nationalFallback, cfruFallback } from "../data";

export const SECTOR_SIZE = 0x1000;
export const SECTOR_DATA = 3968;
export const MAX_CHUNK = 0xff0;
export const SECTORS_PER_SLOT = 14;
export const SIGNATURE = 0x08012025;
export const SAVE_SIZE = 0x20000;

export interface SectorInfo {
  physical: number; id: number; counter: number; checksum: number; checksumLength: number; valid: boolean;
}

export interface SlotInfo {
  index: 0 | 1;
  counter: number;
  signature: number;
  sectors: SectorInfo[];          // ordered by section id
  complete: boolean;
  valid: boolean;
  problems: string[];
}

export interface Trainer {
  name: string; gender: number; tid: number; sid: number;
  playTime: { h: number; m: number; s: number };
  money: number; coins: number; battlePoints: number | null;
}

export interface Box { name: string; wallpaper: number; slots: (Pokemon | null)[] }

export interface Fit { records: number; plausible: number; score: number }

export interface ParsedSave {
  original: Uint8Array;
  bytes: Uint8Array;
  profile: GameProfile;
  slot: SlotInfo;
  slots: SlotInfo[];
  blocks: Record<Block, Uint8Array>;
  securityKey: number;
  trainer: Trainer;
  party: Pokemon[];
  currentBox: number;
  boxes: Box[];
  warnings: string[];
  fit: Fit;
  /** Data bytes per sector this save actually uses (may be larger than the profile's in some hacks). */
  chunk: number;
}

export interface ProfileRank { id: string; name: string; fit: Fit }

export interface DetectResult {
  ok: boolean;
  family: Family | null;
  suggestedProfile: string | null;
  ranking: ProfileRank[];
  activeSlot: 0 | 1 | null;
  slots: SlotInfo[];
  messages: string[];
}

// ---- Sector parsing ----

function readSlot(bytes: Uint8Array, index: 0 | 1): SlotInfo {
  const problems: string[] = [];
  const sigCount = new Map<number, number>();
  for (let i = 0; i < SECTORS_PER_SLOT; i++) {
    const sig = u32(bytes, (index * SECTORS_PER_SLOT + i) * SECTOR_SIZE + 0xff8);
    sigCount.set(sig, (sigCount.get(sig) ?? 0) + 1);
  }
  // Hacks may change the signature; use the one most sectors agree on.
  let signature = SIGNATURE, best = 0;
  for (const [sig, n] of sigCount) if (n > best || (n === best && sig === SIGNATURE)) { signature = sig; best = n; }
  if (signature === 0 || signature === 0xffffffff) signature = SIGNATURE;
  const seen = new Map<number, SectorInfo>();
  for (let i = 0; i < SECTORS_PER_SLOT; i++) {
    const physical = index * SECTORS_PER_SLOT + i;
    const base = physical * SECTOR_SIZE;
    const id = u16(bytes, base + 0xff4);
    if (u32(bytes, base + 0xff8) !== signature || id >= SECTORS_PER_SLOT) continue;
    if (seen.has(id)) problems.push(`Section ${id} appears twice.`);
    seen.set(id, { physical, id, counter: u32(bytes, base + 0xffc), checksum: u16(bytes, base + 0xff6), checksumLength: 0, valid: false });
  }
  const sectors: SectorInfo[] = [];
  for (let id = 0; id < SECTORS_PER_SLOT; id++) {
    const s = seen.get(id);
    if (!s) { problems.push(`Section ${id} is missing.`); continue; }
    sectors.push(s);
  }
  const complete = sectors.length === SECTORS_PER_SLOT;
  if (complete && new Set(sectors.map(s => s.counter)).size > 1) problems.push("Sections in this slot come from different saves.");
  if (complete && signature !== SIGNATURE) problems.push(`Uses a custom save signature (0x${signature.toString(16)}).`);
  return { index, counter: sectors[0]?.counter ?? 0, signature, sectors, complete, valid: false, problems };
}

/** Find the checksum length for a sector from the known struct sizes. */
function resolveChecksum(bytes: Uint8Array, s: SectorInfo, candidates: number[]): void {
  const base = s.physical * SECTOR_SIZE;
  for (const len of candidates) {
    if (len > 0 && sectorChecksum(bytes, base, len) === s.checksum) { s.checksumLength = len; s.valid = true; return; }
  }
  s.checksumLength = candidates[0] || SECTOR_DATA;
}

function validateSlot(bytes: Uint8Array, slot: SlotInfo, sizesById: number[][]): void {
  for (const s of slot.sectors) {
    resolveChecksum(bytes, s, sizesById[s.id]);
    if (!s.valid) slot.problems.push(`Section ${s.id} has a bad checksum.`);
  }
  slot.valid = slot.complete && slot.sectors.every(s => s.valid) && new Set(slot.sectors.map(s => s.counter)).size === 1;
}

/** Candidate checksum lengths per section: the profile's struct size first, then the full data area. */
function sizesFor(profiles: GameProfile[]): number[][] {
  // The game zero-fills each sector before writing, so the full chunk length is equivalent to the
  // struct size. No other lengths are guessed, to avoid false matches on mostly-empty sectors.
  return Array.from({ length: SECTORS_PER_SLOT }, (_, id) =>
    [...new Set(profiles.flatMap(p => [p.sectionSizes[id], p.chunk]).concat(SECTOR_DATA, MAX_CHUNK, FULL_CHUNK))]);
}

/** Some hacks use more of each sector than vanilla's 3968 bytes: 0xFF0 (CFRU-style save expansion) or
 *  every byte up to the footer (0xFF4). Data past a boundary rules the smaller sizes out; when that
 *  leaves a choice, the box names at the end of storage (section 13) show which alignment is right. */
export const FULL_CHUNK = 0xff4;
export function detectChunk(bytes: Uint8Array, slot: SlotInfo): number {
  let min = SECTOR_DATA;
  for (const s of slot.sectors) {
    if (s.id < 1 || s.id > 12) continue;
    const base = s.physical * SECTOR_SIZE;
    for (let i = SECTOR_DATA; i < FULL_CHUNK; i++) if (bytes[base + i]) min = Math.max(min, i >= MAX_CHUNK ? FULL_CHUNK : MAX_CHUNK);
  }
  const candidates = [SECTOR_DATA, MAX_CHUNK, FULL_CHUNK].filter(c => c >= min);
  if (candidates.length === 1) return candidates[0];
  const s13 = slot.sectors.find(s => s.id === 13);
  if (!s13) return candidates[0];
  const score = (c: number) => {
    const at = s13.physical * SECTOR_SIZE + 0x8344 - 8 * c;
    let n = 0;
    for (let b = 0; b < 14; b++) { const t = decodeStrict(bytes, at + b * 9, 9); if (t && t.trim()) n++; }
    const wp = s13.physical * SECTOR_SIZE + 0x83c2 - 8 * c;
    for (let b = 0; b < 14; b++) if (bytes[wp + b] < 16) n += 0.25;
    return n;
  };
  let best = candidates[0], bestScore = score(best);
  for (const c of candidates.slice(1)) { const v = score(c); if (v > bestScore) { best = c; bestScore = v; } }
  return best;
}

function newer(a: number, b: number): boolean {
  if (a === 0xffffffff) return false;
  if (b === 0xffffffff) return true;
  return a > b;
}

function familyFromSb2(sb2: Uint8Array): Family {
  const v = u32(sb2, 0xac);
  return v === 0 ? "RS" : v === 1 ? "FRLG" : "E";
}

function pickSlot(bytes: Uint8Array, sizes: number[][], messages: string[]) {
  const slots = [readSlot(bytes, 0), readSlot(bytes, 1)];
  slots.forEach(s => validateSlot(bytes, s, sizes));
  const valid = slots.filter(s => s.valid);
  let active: SlotInfo | null = null;
  if (valid.length === 2) active = newer(slots[1].counter, slots[0].counter) ? slots[1] : slots[0];
  else if (valid.length === 1) active = valid[0];
  else {
    const usable = slots.filter(s => s.complete);
    if (usable.length) {
      active = usable.reduce((a, b) => (newer(b.counter, a.counter) ? b : a));
      messages.push("Neither save slot passed every checksum. The newest complete slot was opened; check the warnings.");
    }
  }
  return { slots, active };
}

/**
 * Detects the game family and ranks the profiles that could have written this save by how
 * cleanly their record formats read it. `dataFor` supplies the species/move tables per profile.
 */
/** Built-in data for a profile when no ROM is loaded. */
export function fallbackDataFor(p: GameProfile): GameData {
  return p.fallbackData === "national" ? NATIONAL_FB : p.fallbackData === "cfru" ? CFRU_FB : VANILLA;
}
const NATIONAL_FB = nationalFallback();
const CFRU_FB = cfruFallback();

export function detect(bytes: Uint8Array, dataFor: (p: GameProfile) => GameData = fallbackDataFor): DetectResult {
  const messages: string[] = [];
  if (bytes.length < SAVE_SIZE) {
    messages.push(`File is ${(bytes.length / 1024).toFixed(1)} KB. Gen III saves are 128 KB, so this is not a supported save.`);
    return { ok: false, family: null, suggestedProfile: null, ranking: [], activeSlot: null, slots: [], messages };
  }
  if (bytes.length > SAVE_SIZE) messages.push(`File is ${(bytes.length / 1024).toFixed(1)} KB; only the first 128 KB is used and the rest is kept as is.`);
  const { slots, active } = pickSlot(bytes, sizesFor(PROFILES), messages);
  if (!active) {
    messages.push("No Gen III save data found. The file may be blank, from another game, or use an emulator format this editor does not read.");
    return { ok: false, family: null, suggestedProfile: null, ranking: [], activeSlot: null, slots, messages };
  }
  const s0 = active.sectors.find(s => s.id === 0)!;
  const family = familyFromSb2(bytes.subarray(s0.physical * SECTOR_SIZE, s0.physical * SECTOR_SIZE + SECTOR_DATA));

  const ranking: ProfileRank[] = [];
  const seen = new Set<string>();
  for (const p of profilesForFamily(family)) {
    const key = `${p.engine}-${p.family}`;
    if (seen.has(key)) continue; // Ruby/Sapphire and FR/LG read identically
    seen.add(key);
    try {
      const prev = data();
      setData(dataFor(p));
      try {
        const s = parse(bytes, p, active.index);
        ranking.push({ id: p.id, name: p.name, fit: s.fit });
      } finally { setData(prev); }
    } catch { /* this profile cannot read the save */ }
  }
  ranking.sort((a, b) => b.fit.score - a.fit.score || (a.id.includes("-us") ? -1 : 1));
  const suggestedProfile = ranking[0]?.id ?? (family === "RS" ? "ruby-us" : family === "E" ? "emerald-us" : "firered-us");
  if (family === "RS") messages.push("Ruby and Sapphire saves look identical. Pick the right one if it matters to you; both edit the same way.");
  if (family === "FRLG" && suggestedProfile !== "cfru") messages.push("FireRed and LeafGreen saves look identical. Pick the right one if it matters to you; both edit the same way.");
  return { ok: true, family, suggestedProfile, ranking, activeSlot: active.index, slots, messages };
}

// ---- Logical blocks ----

function gather(bytes: Uint8Array, slot: SlotInfo, from: number, to: number, chunk: number): Uint8Array {
  const out = new Uint8Array((to - from + 1) * chunk);
  for (let id = from; id <= to; id++) {
    const s = slot.sectors.find(x => x.id === id)!;
    out.set(bytes.subarray(s.physical * SECTOR_SIZE, s.physical * SECTOR_SIZE + chunk), (id - from) * chunk);
  }
  return out;
}

function scatter(bytes: Uint8Array, slot: SlotInfo, from: number, block: Uint8Array, chunk: number): void {
  for (let i = 0; i * chunk < block.length; i++) {
    const s = slot.sectors.find(x => x.id === from + i)!;
    bytes.set(block.subarray(i * chunk, (i + 1) * chunk), s.physical * SECTOR_SIZE);
  }
}

function gatherExt(bytes: Uint8Array, p: GameProfile): Uint8Array {
  const out = new Uint8Array(p.extSectors.length * p.chunk);
  p.extSectors.forEach((sec, i) => out.set(bytes.subarray(sec * SECTOR_SIZE, sec * SECTOR_SIZE + p.chunk), i * p.chunk));
  return out;
}

const at = (blocks: Record<Block, Uint8Array>, l: Loc) => blocks[l.block];

export function parse(input: Uint8Array, profile: GameProfile, slotIndex?: 0 | 1): ParsedSave {
  const messages: string[] = [];
  if (input.length < SAVE_SIZE) throw new Error("File is smaller than a 128 KB Gen III save.");
  const bytes = input.slice();
  const sizes = sizesFor([profile]).map((c, id) => [...new Set([...c, ...sizesFor(PROFILES)[id]])]);
  const picked = pickSlot(bytes, sizes, messages);
  const slots = picked.slots;
  const idx = slotIndex ?? picked.active?.index;
  if (idx === undefined) throw new Error("No complete save slot found.");
  const slot = slots[idx];
  if (!slot.complete) throw new Error(`Save slot ${idx === 0 ? "A" : "B"} is incomplete and cannot be opened.`);
  const warnings = [...messages, ...slot.problems];

  // CFRU's compressed boxes fix its layout; other profiles follow what the save itself uses.
  const c = profile.engine === "cfru" ? profile.chunk : Math.max(profile.chunk, detectChunk(bytes, slot));
  const blocks: Record<Block, Uint8Array> = {
    sb2: gather(bytes, slot, 0, 0, c), sb1: gather(bytes, slot, 1, 4, c), storage: gather(bytes, slot, 5, 13, c),
    ext: gatherExt(bytes, profile),
  };
  const { sb2, sb1, storage } = blocks;
  const fam = familyFromSb2(sb2);
  if (fam !== profile.family) warnings.push(`This save looks like ${fam === "RS" ? "Ruby/Sapphire" : fam === "E" ? "Emerald" : "FireRed/LeafGreen"}, but ${profile.name} is selected. Values may read wrong.`);

  const o2 = profile.offsets.sb2, o1 = profile.offsets.sb1;
  const securityKey = o2.securityKey !== undefined ? u32(sb2, o2.securityKey) : 0;
  const trainer: Trainer = {
    name: decodeText(sb2, o2.name, 7),
    gender: sb2[o2.gender],
    tid: u16(sb2, o2.trainerId), sid: u16(sb2, o2.trainerId + 2),
    playTime: { h: u16(sb2, o2.playTime), m: sb2[o2.playTime + 2], s: sb2[o2.playTime + 3] },
    money: (u32(sb1, o1.money) ^ securityKey) >>> 0,
    coins: (u16(sb1, o1.coins) ^ (securityKey & 0xffff)) & 0xffff,
    battlePoints: o2.battlePoints !== undefined ? u16(sb2, o2.battlePoints) : null,
  };

  const fitScores: number[] = [];
  const party: Pokemon[] = [];
  const count = Math.min(6, sb1[o1.partyCount]);
  if (sb1[o1.partyCount] > 6) warnings.push(`Party count is ${sb1[o1.partyCount]}; only 6 are read.`);
  for (let i = 0; i < count; i++) {
    const m = decodePokemon(sb1, o1.party + i * PARTY_SIZE, true, profile.partyCodec);
    if (m) { party.push(m); fitScores.push(plausibility(m, profile.partyCodec)); }
    else fitScores.push(0);
  }

  const boxes: Box[] = [];
  for (let b = 0; b < profile.boxCount; b++) {
    const slotsInBox: (Pokemon | null)[] = [];
    for (let s = 0; s < profile.boxSlots; s++) {
      const l = profile.boxSlot(b, s);
      const blk = at(blocks, l);
      if (l.offset + codecInfo(profile.boxCodec).size > blk.length) { slotsInBox.push(null); continue; }
      const m = decodePokemon(blk, l.offset, false, profile.boxCodec);
      if (m) fitScores.push(plausibility(m, profile.boxCodec));
      slotsInBox.push(m);
    }
    const nl = profile.boxName(b), wl = profile.wallpaper(b);
    boxes.push({ name: decodeText(at(blocks, nl), nl.offset, 8), wallpaper: at(blocks, wl)[wl.offset], slots: slotsInBox });
  }

  const plausible = fitScores.filter(x => x >= 0.8).length;
  const fit: Fit = { records: fitScores.length, plausible, score: fitScores.length ? fitScores.reduce((a, b) => a + b, 0) / fitScores.length : 0 };
  if (fitScores.length >= 3 && fit.score < 0.75)
    warnings.push(`Only ${plausible} of ${fitScores.length} Pokémon read cleanly with ${profile.name}. This save probably uses a different layout.`);

  const cb = at(blocks, profile.currentBox)[profile.currentBox.offset];
  return {
    original: input, bytes, profile, slot, slots, blocks, securityKey, trainer, party,
    currentBox: cb < profile.boxCount ? cb : 0, boxes, warnings, fit, chunk: c,
  };
}

/** Serializes the edited state back into a full save file, recomputing every checksum it touches. */
export function write(save: ParsedSave): Uint8Array {
  const p = save.profile, o2 = p.offsets.sb2, o1 = p.offsets.sb1;
  const blocks: Record<Block, Uint8Array> = {
    sb2: save.blocks.sb2.slice(), sb1: save.blocks.sb1.slice(), storage: save.blocks.storage.slice(), ext: save.blocks.ext.slice(),
  };
  const { sb2, sb1 } = blocks;
  const t = save.trainer;

  if (decodeText(sb2, o2.name, 7) !== t.name) encodeText(t.name, sb2, o2.name, 8);
  sb2[o2.gender] = t.gender & 1;
  w16(sb2, o2.trainerId, t.tid); w16(sb2, o2.trainerId + 2, t.sid);
  w16(sb2, o2.playTime, t.playTime.h); sb2[o2.playTime + 2] = t.playTime.m; sb2[o2.playTime + 3] = t.playTime.s;
  w32(sb1, o1.money, (t.money ^ save.securityKey) >>> 0);
  w16(sb1, o1.coins, (t.coins ^ (save.securityKey & 0xffff)) & 0xffff);
  if (o2.battlePoints !== undefined && t.battlePoints !== null) w16(sb2, o2.battlePoints, t.battlePoints);

  sb1[o1.partyCount] = save.party.length;
  for (let i = 0; i < 6; i++) {
    const off = o1.party + i * PARTY_SIZE;
    if (i < save.party.length) encodePokemon(save.party[i], sb1, off, true, p.partyCodec);
    else if (decodePokemon(sb1, off, true, p.partyCodec)) clearRecord(sb1, off, PARTY_SIZE); // leave already-empty slots byte-identical
  }
  const recSize = codecInfo(p.boxCodec).size;
  save.boxes.forEach((box, b) => {
    box.slots.forEach((m, s) => {
      const l = p.boxSlot(b, s), blk = blocks[l.block];
      if (l.offset + recSize > blk.length) return;
      if (m) encodePokemon(m, blk, l.offset, false, p.boxCodec);
      else if (decodePokemon(blk, l.offset, false, p.boxCodec)) clearRecord(blk, l.offset, recSize);
    });
    const nl = p.boxName(b), wl = p.wallpaper(b);
    if (decodeText(blocks[nl.block], nl.offset, 8) !== box.name) encodeText(box.name, blocks[nl.block], nl.offset, 9);
    blocks[wl.block][wl.offset] = box.wallpaper;
  });

  const out = save.bytes.slice();
  const c = save.chunk ?? p.chunk;
  scatter(out, save.slot, 0, sb2, c);
  scatter(out, save.slot, 1, sb1, c);
  scatter(out, save.slot, 5, blocks.storage, c);
  p.extSectors.forEach((sec, i) => out.set(blocks.ext.subarray(i * p.chunk, (i + 1) * p.chunk), sec * SECTOR_SIZE));
  for (const s of save.slot.sectors) {
    const base = s.physical * SECTOR_SIZE;
    let len = s.checksumLength || p.sectionSizes[s.id];
    // In hacks that fill the whole sector, edits can reach past 3968 bytes; the checksum must cover them.
    if (c > SECTOR_DATA && len === SECTOR_DATA) len = c;
    w16(out, base + 0xff6, sectorChecksum(out, base, len));
  }
  return out;
}

/** Re-reads exported bytes and reports any checksum problem. Used before offering a download. */
export function verify(bytes: Uint8Array, slotIndex: 0 | 1, profile?: GameProfile): string[] {
  const slot = readSlot(bytes, slotIndex);
  validateSlot(bytes, slot, sizesFor(profile ? [profile] : PROFILES).map((c, id) => [...new Set([...c, ...sizesFor(PROFILES)[id]])]));
  return slot.problems.filter(p => !/custom save signature/.test(p));
}

export { getProfile };

/** The record scrambling most Pokémon in this save use, so new ones match what the game expects. */
export function saveCipher(save: ParsedSave): Pokemon["cipher"] {
  const n = new Map<string, number>();
  for (const m of [...save.party, ...save.boxes.flatMap(b => b.slots)]) if (m && m.checksumOk) n.set(m.cipher ?? "vanilla", (n.get(m.cipher ?? "vanilla") ?? 0) + 1);
  let best: string = "vanilla", c = 0;
  for (const [k, v] of n) if (v > c) { best = k; c = v; }
  return best as Pokemon["cipher"];
}
