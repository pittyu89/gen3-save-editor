// Per-game layout profiles. Offsets are relative to the reconstructed save blocks:
//   sb2 = section 0, sb1 = sections 1-4, storage = sections 5-13, ext = sectors 30-31 (CFRU only).
// Sources: pret/pokeruby, pret/pokeemerald, pret/pokefirered include/global.h;
//          rh-hideout/pokeemerald-expansion include/global.h, include/pokemon.h;
//          Skeli789/Complete-Fire-Red-Upgrade src/save.c, src/pokemon_storage_system.c.
import type { CodecId } from "./gen3/pokemon";

export type Family = "RS" | "E" | "FRLG";
export type Engine = "vanilla" | "pex-modern" | "pex-legacy" | "cfru";
export type Block = "sb2" | "sb1" | "storage" | "ext";
export interface Loc { block: Block; offset: number }

export interface GameProfile {
  id: string;
  name: string;
  short: string;
  family: Family;
  engine: Engine;
  gameCode: string;
  revision: number;
  language: string;
  saveSize: number;
  textEncoding: "western";
  /** Bytes of each sector's data area that make up the save blocks (3968 in vanilla, 0xFF0 in CFRU). */
  chunk: number;
  /** Bytes covered by each section's checksum. */
  sectionSizes: number[];
  /** Extra sectors read and written as raw data (no checksum), e.g. CFRU's sectors 30-31. */
  extSectors: number[];
  partyCodec: CodecId;
  boxCodec: CodecId;
  /** Which built-in data to use when no ROM is loaded. */
  fallbackData: "vanilla" | "national" | "cfru";
  offsets: {
    sb2: { name: number; gender: number; trainerId: number; playTime: number; securityKey?: number; battlePoints?: number; familyMarker: number };
    sb1: { partyCount: number; party: number; money: number; coins: number };
  };
  boxCount: number;
  boxSlots: number;
  currentBox: Loc;
  boxSlot(box: number, slot: number): Loc;
  boxName(box: number): Loc;
  wallpaper(box: number): Loc;
  notes: string[];
}

const D = 3968;
function chunks(sb2: number, sb1: number, storage: number, size = D): number[] {
  const split = (n: number, k: number) => Array.from({ length: k }, (_, i) => Math.max(0, Math.min(size, n - i * size)));
  return [...split(sb2, 1), ...split(sb1, 4), ...split(storage, 9)];
}
const STORAGE_SIZE = 0x83d0;

const vanillaBoxes = (recordSize: number) => ({
  boxCount: 14, boxSlots: 30,
  currentBox: { block: "storage" as Block, offset: 0 },
  boxSlot: (b: number, s: number): Loc => ({ block: "storage", offset: 4 + (b * 30 + s) * recordSize }),
  boxName: (b: number): Loc => ({ block: "storage", offset: 0x8344 + b * 9 }),
  wallpaper: (b: number): Loc => ({ block: "storage", offset: 0x83c2 + b }),
});

const base = { revision: 0, language: "en-US", saveSize: 0x20000, textEncoding: "western" as const, extSectors: [] as number[], notes: [] as string[] };

const RS = {
  ...base, family: "RS" as Family, engine: "vanilla" as Engine, chunk: D,
  // TODO: verify the RS SaveBlock1 size (0x3AC0) against a real save; the full-length checksum is also accepted.
  sectionSizes: chunks(0x890, 0x3ac0, STORAGE_SIZE),
  partyCodec: "vanilla" as CodecId, boxCodec: "vanilla" as CodecId, fallbackData: "vanilla" as const,
  offsets: {
    sb2: { name: 0x00, gender: 0x08, trainerId: 0x0a, playTime: 0x0e, familyMarker: 0xac },
    sb1: { partyCount: 0x234, party: 0x238, money: 0x490, coins: 0x494 },
  },
  ...vanillaBoxes(80),
};

const E = {
  ...RS, family: "E" as Family,
  sectionSizes: chunks(0xf2c, 0x3d88, STORAGE_SIZE),
  offsets: {
    sb2: { name: 0x00, gender: 0x08, trainerId: 0x0a, playTime: 0x0e, securityKey: 0xac, battlePoints: 0xeb8, familyMarker: 0xac },
    sb1: { partyCount: 0x234, party: 0x238, money: 0x490, coins: 0x494 },
  },
};

const FRLG = {
  ...RS, family: "FRLG" as Family,
  sectionSizes: chunks(0xf24, 0x3d68, STORAGE_SIZE),
  offsets: {
    sb2: { name: 0x00, gender: 0x08, trainerId: 0x0a, playTime: 0x0e, securityKey: 0xf20, familyMarker: 0xac },
    sb1: { partyCount: 0x34, party: 0x38, money: 0x290, coins: 0x294 },
  },
};

// pokeemerald-expansion keeps Emerald's SaveBlock prefix (trainer, key, party, money) and storage layout
// in every release so far, but later fields depend on each hack's config, so Battle Points are not offered.
const PEX = {
  ...E,
  offsets: { sb2: { ...E.offsets.sb2, battlePoints: undefined }, sb1: E.offsets.sb1 },
  fallbackData: "national" as const,
};

// CFRU: sectors use 0xFF0 data bytes; PC boxes are 58-byte compressed records spread over
// storage (boxes 1-19), sectors 30-31 (20-22), SaveBlock1 (23-24) and SaveBlock2 (25).
const CFRU_REC = 58;
const CFRU: Omit<GameProfile, "id" | "name" | "short" | "gameCode"> = {
  ...FRLG, engine: "cfru", chunk: 0xff0,
  sectionSizes: [0xf24, 0xff0, 0xff0, 0xff0, 0xd98, 0xff0, 0xff0, 0xff0, 0xff0, 0xff0, 0xff0, 0xff0, 0xff0, 0x450],
  extSectors: [30, 31],
  partyCodec: "cfru-party", boxCodec: "cfru-box", fallbackData: "cfru",
  boxCount: 25, boxSlots: 30,
  currentBox: { block: "storage", offset: 0 },
  boxSlot: (b, s) => {
    if (b < 19) return { block: "storage", offset: 4 + (b * 30 + s) * CFRU_REC };
    if (b < 22) return { block: "ext", offset: 0xb0c + ((b - 19) * 30 + s) * CFRU_REC };   // RAM 0x203CB44
    if (b < 24) return { block: "sb1", offset: 0x1f08 + ((b - 22) * 30 + s) * CFRU_REC };  // RAM 0x2027434
    return { block: "sb2", offset: 0xb0 + s * CFRU_REC };                                // RAM 0x2024638
  },
  boxName: b => ({ block: "storage", offset: b < 14 ? 0x8344 + b * 9 : 0x8344 - 9 * (b - 13) }),
  wallpaper: b => ({ block: "storage", offset: b < 14 ? 0x83c2 + b : 0x8128 + (b - 14) }),
  notes: ["CFRU drops contest stats, ribbons and current PP for Pokémon stored in the PC; the game does the same."],
};

export const PROFILES: GameProfile[] = [
  { id: "ruby-us", name: "Pokémon Ruby (US)", short: "Ruby", gameCode: "AXVE", ...RS },
  { id: "sapphire-us", name: "Pokémon Sapphire (US)", short: "Sapphire", gameCode: "AXPE", ...RS },
  { id: "emerald-us", name: "Pokémon Emerald (US)", short: "Emerald", gameCode: "BPEE", ...E },
  { id: "firered-us", name: "Pokémon FireRed (US)", short: "FireRed", gameCode: "BPRE", ...FRLG },
  { id: "leafgreen-us", name: "Pokémon LeafGreen (US)", short: "LeafGreen", gameCode: "BPGE", ...FRLG },
  { id: "pex-modern", name: "Emerald hack · pokeemerald-expansion 1.8+", short: "Expansion 1.8+", gameCode: "BPEE", ...PEX, engine: "pex-modern", partyCodec: "pex-modern", boxCodec: "pex-modern" },
  { id: "pex-legacy", name: "Emerald hack · pokeemerald-expansion 1.0–1.7", short: "Expansion 1.0–1.7", gameCode: "BPEE", ...PEX, engine: "pex-legacy", partyCodec: "pex-legacy", boxCodec: "pex-legacy" },
  { id: "cfru", name: "FireRed hack · CFRU", short: "CFRU", gameCode: "BPRE", ...CFRU },
];

export function getProfile(id: string): GameProfile {
  const p = PROFILES.find(p => p.id === id);
  if (!p) throw new Error(`Unknown game profile: ${id}`);
  return p;
}

export const profilesForFamily = (f: Family) => PROFILES.filter(p => p.family === f || (f === "FRLG" && p.engine === "cfru"));
