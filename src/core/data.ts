// Game data. The built-in tables come from the pret/pokeemerald decompilation (see README);
// ROM hacks can supply their own through rom.ts. Core code reads the active set via data().
import raw from "./gamedata.json";
import type { Learnsets } from "./learnsets";

export interface SpeciesInfo {
  t: string[];            // type names
  bs: number[];           // HP, Atk, Def, Spe, SpA, SpD
  gr: number | null;      // growth rate 0-5, null if unknown
  g: number;              // gender threshold: 0 male only, 254 female only, 255 genderless
  ab: number[];           // ability ids by slot [1, 2, hidden]; 0 = none
}

export interface GameData {
  id: string;
  label: string;
  source: "builtin" | "rom";
  species: string[];
  nat: number[];                  // National Dex number, 0 if unknown
  info: (SpeciesInfo | null)[];
  moves: string[];
  movePP: number[];
  /** Type name of each move, when read from a ROM. */
  moveTypes?: string[];
  movePower?: number[];
  moveAcc?: number[];
  moveCat?: ("Physical" | "Special" | "Status")[];
  moveDesc?: string[];
  items: string[];
  abilities: string[];
  shedinja: number;               // species index of Shedinja (HP is always 1), -1 if unknown
  notes: string[];                // what is missing or approximate in this data set
  /** Which moves each species learns; only read from a ROM. */
  learn?: Learnsets;
}

export const CHARMAP: Record<string, string> = raw.charmap;

export const NATURES = ["Hardy","Lonely","Brave","Adamant","Naughty","Bold","Docile","Relaxed","Impish","Lax",
  "Timid","Hasty","Serious","Jolly","Naive","Modest","Mild","Quiet","Bashful","Rash",
  "Calm","Gentle","Sassy","Careful","Quirky"];
export const GROWTH_NAMES = ["Medium Fast","Erratic","Fluctuating","Medium Slow","Fast","Slow"];
export const TYPE_NAMES = ["Normal","Fighting","Flying","Poison","Ground","Rock","Bug","Ghost","Steel","Fire",
  "Water","Grass","Electric","Psychic","Ice","Dragon","Dark","Fairy","Stellar","Mystery"];

export function titleCase(s: string): string {
  if (!s || s === "-" || /^\?+$/.test(s)) return s;
  if (/[a-z]/.test(s)) return s; // already mixed case (hack data)
  return s.toLowerCase().replace(/(^|[\s\-.'(])([a-zé])/g, (_m, p, c) => p + c.toUpperCase())
    .replace(/\bHm(\d)/g, "HM$1").replace(/\bTm(\d)/g, "TM$1").replace(/\bPp\b/g, "PP")
    .replace(/\bHp\b/g, "HP").replace(/\bS\.s\./g, "S.S.").replace(/\bTv\b/g, "TV");
}

// ---- Built-in vanilla Gen III data (internal species order) ----

export const VANILLA: GameData = {
  id: "gen3",
  label: "Built-in Gen III data",
  source: "builtin",
  species: raw.species.map((n: string, i: number) => (i >= 252 && i <= 276) || i === 0 ? "" : titleCase(n)),
  nat: raw.nat,
  info: raw.info.map((x: any, i: number) => (i === 0 || (i >= 252 && i <= 276) ? null : { ...x, ab: [x.ab[0], x.ab[1], 0] })),
  moves: raw.moves.map(titleCase),
  movePP: raw.pp,
  items: raw.items.map((n: string, i: number) => (n && n !== "????????" ? titleCase(n.replace("{POKEBLOCK}", "POKéBLOCK")) : i === 0 ? "None" : "")),
  abilities: raw.abilities.map(titleCase),
  shedinja: 303,
  notes: [],
};

/** Vanilla data re-indexed by National Dex number, for engines that number species nationally. */
export function nationalFallback(): GameData {
  const species: string[] = [""], nat: number[] = [0], info: (SpeciesInfo | null)[] = [null];
  for (let i = 1; i < VANILLA.species.length; i++) {
    const n = VANILLA.nat[i];
    if (!n) continue;
    species[n] = VANILLA.species[i]; nat[n] = n; info[n] = VANILLA.info[i];
  }
  for (let i = 0; i < species.length; i++) { species[i] ??= ""; nat[i] ??= 0; info[i] ??= null; }
  return {
    ...VANILLA, id: "gen3-national", species, nat, info, shedinja: 292,
    items: VANILLA.items.map((_, i) => (i === 0 ? "None" : "")),
    notes: [
      "Species after #386 and all item names are unknown without the ROM.",
      "Base stats are Gen III values; this hack may use updated ones.",
    ],
  };
}

export function cfruFallback(): GameData {
  return {
    ...VANILLA, id: "gen3-cfru",
    notes: ["Species after Chimecho, newer moves, items and abilities are unknown without the ROM."],
  };
}

let ACTIVE: GameData = VANILLA;
export const data = () => ACTIVE;
export function setData(d: GameData) { ACTIVE = d; }

export function speciesName(i: number): string {
  const n = ACTIVE.species[i];
  return n && !/^\?+$/.test(n) ? n : `Species ${i}`;
}
export function isValidSpecies(i: number): boolean {
  const n = ACTIVE.species[i];
  return i > 0 && i < ACTIVE.species.length && !!n && !/^\?+$/.test(n);
}
export const moveName = (i: number) => (i === 0 ? "—" : ACTIVE.moves[i] && !/^\?+$/.test(ACTIVE.moves[i]) ? ACTIVE.moves[i] : `Move ${i}`);
export const itemName = (i: number) => (i === 0 ? "None" : ACTIVE.items[i] || `Item ${i}`);
export const abilityName = (i: number) => (i === 0 ? "—" : ACTIVE.abilities[i] || `Ability ${i}`);

/** Experience needed to reach `n` for a growth rate, matching the decomp's integer formulas. */
export function expForLevel(rate: number, n: number): number {
  if (n <= 1) return n <= 0 ? 0 : 1;
  const c = n * n * n;
  const t = Math.trunc;
  switch (rate) {
    case 0: return c;
    case 1: return n <= 50 ? t((100 - n) * c / 50) : n <= 68 ? t((150 - n) * c / 100)
      : n <= 98 ? t(t((1911 - 10 * n) / 3) * c / 500) : t((160 - n) * c / 100);
    case 2: return n <= 15 ? t((t((n + 1) / 3) + 24) * c / 50) : n <= 36 ? t((n + 14) * c / 50)
      : t((t(n / 2) + 32) * c / 50);
    case 3: return t(6 * c / 5) - 15 * n * n + 100 * n - 140;
    case 4: return t(4 * c / 5);
    case 5: return t(5 * c / 4);
  }
  return c;
}

export function levelFromExp(rate: number, exp: number): number {
  let lvl = 1;
  while (lvl < 100 && exp >= expForLevel(rate, lvl + 1)) lvl++;
  return lvl;
}
