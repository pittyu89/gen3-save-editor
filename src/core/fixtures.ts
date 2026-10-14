// Builds synthetic Gen III saves for tests and the example save. No real game data or user saves are used.
import { w16, w32, sectorChecksum } from "./binary";
import { encodeText } from "./text";
import { GameProfile, Block } from "./profiles";
import { Pokemon, encodePokemon, calcStats, levelOf, codecInfo } from "./gen3/pokemon";
import { expForLevel, data } from "./data";
import { SECTOR_SIZE, SIGNATURE } from "./gen3/save";

export function makeMon(species: number, level: number, opts: Partial<Pokemon> = {}): Pokemon {
  const gr = data().info[species]?.gr ?? 0;
  const m: Pokemon = {
    codec: "vanilla",
    pid: 0x1234abcd, otId: (54321 << 16) | 12345, nickname: "TESTMON", language: 2, flags: 0,
    otName: "ASH", markings: 0, species, heldItem: 0, exp: expForLevel(gr, level),
    ppBonuses: 0, friendship: 70, moves: [33, 45, 0, 0], pp: [35, 40, 0, 0], evs: [0, 0, 0, 0, 0, 0],
    contest: [0, 0, 0, 0, 0, 0], pokerus: 0, metLocation: 16, metLevel: level, metGame: 3, otGender: 0, ball: 4,
    ivs: [31, 20, 10, 5, 0, 15], isEgg: false, abilityNum: 0, shinyMod: 0, natureMod: 0,
    checksumOk: true, dirty: true, ...opts,
  };
  return m;
}

export interface FixtureOpts {
  profile: GameProfile;
  name?: string;
  money?: number;
  key?: number;
  party?: Pokemon[];
  boxMons?: { box: number; slot: number; mon: Pokemon }[];
  counterA?: number;
  counterB?: number;
  rotate?: number;   // sector rotation inside each slot, as the game does
}

export function buildSave(o: FixtureOpts): Uint8Array {
  const p = o.profile, c = p.chunk;
  const blocks: Record<Block, Uint8Array> = {
    sb2: new Uint8Array(c), sb1: new Uint8Array(c * 4), storage: new Uint8Array(c * 9), ext: new Uint8Array(c * p.extSectors.length),
  };
  const { sb2, sb1 } = blocks;
  encodeText(o.name ?? "RED", sb2, p.offsets.sb2.name, 8);
  w16(sb2, p.offsets.sb2.trainerId, 12345); w16(sb2, p.offsets.sb2.trainerId + 2, 54321);
  w16(sb2, p.offsets.sb2.playTime, 12); sb2[p.offsets.sb2.playTime + 2] = 34;
  const key = o.key ?? 0;
  // Family marker at 0xAC: RS = 0, FRLG = 1, Emerald = security key
  if (p.family === "E") w32(sb2, 0xac, key || 0xdeadbeef);
  if (p.family === "FRLG") { w32(sb2, 0xac, 1); w32(sb2, p.offsets.sb2.securityKey!, key); }
  const realKey = p.family === "E" ? (key || 0xdeadbeef) : p.family === "FRLG" ? key : 0;
  w32(sb1, p.offsets.sb1.money, ((o.money ?? 3000) ^ realKey) >>> 0);
  w16(sb1, p.offsets.sb1.coins, (0 ^ realKey) & 0xffff);
  const party = o.party ?? [];
  sb1[p.offsets.sb1.partyCount] = party.length;
  party.forEach((m, i) => {
    const lvl = levelOf(m) ?? 5;
    const stats = calcStats(m, lvl) ?? [20, 10, 10, 10, 10, 10];
    m.party = m.party ?? { status: 0, level: lvl, mail: 0xff, hp: stats[0], stats };
    encodePokemon(m, sb1, p.offsets.sb1.party + i * codecInfo(p.partyCodec).partySize, true, p.partyCodec);
  });
  for (const b of o.boxMons ?? []) {
    const l = p.boxSlot(b.box, b.slot);
    encodePokemon(b.mon, blocks[l.block], l.offset, false, p.boxCodec);
  }
  for (let b = 0; b < p.boxCount; b++) {
    const l = p.boxName(b);
    encodeText(`BOX${b + 1}`, blocks[l.block], l.offset, 9);
  }
  void codecInfo;

  const out = new Uint8Array(0x20000).fill(0xff);
  const sections: Uint8Array[] = [sb2];
  for (let i = 0; i < 4; i++) sections.push(sb1.subarray(i * c, (i + 1) * c));
  for (let i = 0; i < 9; i++) sections.push(blocks.storage.subarray(i * c, (i + 1) * c));
  const writeSlot = (slot: number, counter: number) => {
    for (let id = 0; id < 14; id++) {
      const phys = slot * 14 + ((id + (o.rotate ?? 0)) % 14);
      const base = phys * SECTOR_SIZE;
      out.fill(0, base, base + SECTOR_SIZE);
      out.set(sections[id], base);
      w16(out, base + 0xff4, id);
      w16(out, base + 0xff6, sectorChecksum(out, base, p.sectionSizes[id]));
      w32(out, base + 0xff8, SIGNATURE);
      w32(out, base + 0xffc, counter);
    }
  };
  writeSlot(0, o.counterA ?? 10);
  writeSlot(1, o.counterB ?? 9);
  p.extSectors.forEach((sec, i) => {
    out.fill(0, sec * SECTOR_SIZE, (sec + 1) * SECTOR_SIZE);
    out.set(blocks.ext.subarray(i * c, (i + 1) * c), sec * SECTOR_SIZE);
  });
  return out;
}
