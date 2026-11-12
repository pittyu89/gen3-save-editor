// Evolutions read from the user's ROM, and how to describe each method.
//
// Layouts handled:
//   fixed    gEvolutionTable[species][N] of { u16 method, u16 param, u16 target, u16 extra }
//            (pokeemerald/pokefirered N = 5; CFRU; Emerald Z N = 10)
//   pointer  a pointer per species (in the species record or a separate table) to a list of entries
//            ending with method 0xFFFF (pokeemerald-expansion 1.8+), entries of 6, 8 or 12 bytes
// The table is found from well-known evolutions (Bulbasaur → Ivysaur at 16, ...), matched by name, so it
// works when a hack moves the table or changes its species order.
//
// Method numbers: 1-15 are Gen III's (pret include/constants/pokemon.h) everywhere. Above that:
//   Emerald-based (expansion, Monomyth, Emerald Z)  pokeemerald-expansion 1.0-1.7 include/constants/pokemon.h
//   FireRed-based (CFRU)                            Complete-Fire-Red-Upgrade include/pokemon.h
//   Emerald Z redefines 43-45; read from its GetEvolutionTargetSpecies (jump table 0x08B01C70).
//   Monomyth redefines 31-34; read from its GetEvolutionTargetSpecies (jump table 0x0805B3FC).
import { u16, u32, romHalves, romWords } from "./binary";
import type { Engine } from "./profiles";

export interface Evolution { method: number; param: number; target: number; extra: number }

export interface Evolutions {
  /** Entries per species (null: no data for that species). */
  list: (Evolution[] | null)[];
  /** The method number the ROM uses for "reaches level N" (4 in every known engine). */
  levelMethod: number;
  report: string;
}

const ANCHORS: [string, string, number][] = [
  ["BULBASAUR", "IVYSAUR", 16], ["CHARMANDER", "CHARMELEON", 16], ["SQUIRTLE", "WARTORTLE", 16],
  ["CATERPIE", "METAPOD", 7], ["WEEDLE", "KAKUNA", 7], ["PIDGEY", "PIDGEOTTO", 18], ["RATTATA", "RATICATE", 20],
  ["ABRA", "KADABRA", 16], ["MACHOP", "MACHOKE", 28], ["GEODUDE", "GRAVELER", 25], ["MAGIKARP", "GYARADOS", 20],
  ["CHIKORITA", "BAYLEEF", 16], ["CYNDAQUIL", "QUILAVA", 14], ["TOTODILE", "CROCONAW", 18],
  ["TREECKO", "GROVYLE", 16], ["TORCHIC", "COMBUSKEN", 16], ["MUDKIP", "MARSHTOMP", 16],
  ["POOCHYENA", "MIGHTYENA", 18], ["ZIGZAGOON", "LINOONE", 20], ["RALTS", "KIRLIA", 20], ["ARON", "LAIRON", 32],
];

/** More known evolutions, matched at any level or method (hacks retune levels and use regional dexes). */
const PAIRS = ("Poliwag Poliwhirl,Poliwhirl Poliwrath,Larvitar Pupitar,Pupitar Tyranitar,Phanpy Donphan,Pineco Forretress,Natu Xatu,"
  + "Koffing Weezing,Exeggcute Exeggutor,Growlithe Arcanine,Staryu Starmie,Gligar Gliscor,Misdreavus Mismagius,Tangela Tangrowth,"
  + "Dratini Dragonair,Dragonair Dragonite,Gastly Haunter,Haunter Gengar,Oddish Gloom,Bellsprout Weepinbell,Zubat Golbat,"
  + "Golbat Crobat,Seedot Nuzleaf,Lotad Lombre,Wingull Pelipper,Shroomish Breloom,Slakoth Vigoroth,Makuhita Hariyama,"
  + "Electrike Manectric,Numel Camerupt,Spoink Grumpig,Trapinch Vibrava,Swablu Altaria,Barboach Whiscash,Corphish Crawdaunt,"
  + "Baltoy Claydol,Shuppet Banette,Duskull Dusclops,Snorunt Glalie,Spheal Sealeo,Bagon Shelgon,Beldum Metang,Starly Staravia,"
  + "Shinx Luxio,Gible Gabite,Riolu Lucario,Pichu Pikachu,Pikachu Raichu,Ekans Arbok,Sandshrew Sandslash,Diglett Dugtrio,"
  + "Meowth Persian,Psyduck Golduck,Mankey Primeape,Tentacool Tentacruel,Ponyta Rapidash,Magnemite Magneton,Doduo Dodrio,"
  + "Seel Dewgong,Grimer Muk,Shellder Cloyster,Drowzee Hypno,Krabby Kingler,Voltorb Electrode,Cubone Marowak,Horsea Seadra,"
  + "Goldeen Seaking,Omanyte Omastar,Kabuto Kabutops,Sentret Furret,Hoothoot Noctowl,Ledyba Ledian,Spinarak Ariados,"
  + "Chinchou Lanturn,Mareep Flaaffy,Flaaffy Ampharos,Hoppip Skiploom,Skiploom Jumpluff,Wooper Quagsire,Snubbull Granbull,"
  + "Teddiursa Ursaring,Slugma Magcargo,Swinub Piloswine,Remoraid Octillery,Houndour Houndoom").split(",").map(x => x.split(" ") as [string, string]);

const norm = (s: string) => s.toUpperCase().replace(/[\s.\-']/g, "");
const END = 0xffff, NONE = 0xfffe;

interface Hit { s: number; at: number; method: number }

/** Entry positions (method field) of known evolutions, by pair. With `anyLevel`, matches the
 *  target alone (with a small method and param) instead of the exact level. */
function anchorHits(rom: Uint8Array, species: string[], anyLevel: boolean): Hit[][] {
  const index = new Map<string, number>();
  species.forEach((n, i) => { const k = norm(n); if (i > 0 && k && !index.has(k)) index.set(k, i); });
  const wanted: { s: number; t: number; lvl: number }[] = [];
  const pairs: [string, string, number][] = anyLevel ? [...ANCHORS, ...PAIRS.map(([a, b]) => [a, b, -1] as [string, string, number])] : ANCHORS;
  for (const [a, b, lvl] of pairs) {
    const s = index.get(norm(a)), t = index.get(norm(b));
    if (s && t) wanted.push({ s, t, lvl });
  }
  if (wanted.length < 2) return [];
  const h = romHalves(rom);
  const hits: Hit[][] = wanted.map(() => []);
  if (!anyLevel) {
    const isParam = new Uint8Array(256);
    for (const w of wanted) isParam[w.lvl] = 1;
    const byKey = new Map<number, number>();
    wanted.forEach((w, i) => byKey.set(w.lvl * 0x10000 + w.t, i));
    for (let i = 1; i + 1 < h.length; i++) {
      const p = h[i];
      if (p > 255 || !isParam[p]) continue;
      const k = byKey.get(p * 0x10000 + h[i + 1]);
      if (k === undefined) continue;
      const method = h[i - 1];
      if (method === 0 || method > 0xff || hits[k].length > 50) continue;
      hits[k].push({ s: wanted[k].s, at: (i - 1) * 2, method });
    }
  } else {
    const byTarget = new Map<number, number[]>();
    wanted.forEach((w, i) => { const l = byTarget.get(w.t) ?? []; l.push(i); byTarget.set(w.t, l); });
    for (let i = 1; i + 2 < h.length; i++) {
      const ks = byTarget.get(h[i + 1]);
      if (!ks) continue;
      const method = h[i - 1], param = h[i];
      if (method === 0 || method > 0x60 || param > 0x400) continue;
      for (const k of ks) if (hits[k].length < 300) hits[k].push({ s: wanted[k].s, at: (i - 1) * 2, method });
    }
  }
  return hits.filter(x => x.length);
}

/** Best (base, stride) explaining the most anchors as slot 0 of `base + species * stride`. */
function bestGrid(points: { s: number; at: number }[][], strides: (d: number) => boolean): { base: number; stride: number; n: number } | null {
  const votes = new Map<string, number>();
  const flat = points.flatMap(x => x);
  for (let i = 0; i < flat.length; i++) for (let j = 0; j < flat.length; j++) {
    const a = flat[i], b = flat[j];
    if (b.s <= a.s) continue;
    const d = b.at - a.at, ds = b.s - a.s;
    if (d <= 0 || d % ds) continue;
    const stride = d / ds;
    if (!strides(stride)) continue;
    const key = `${a.at - a.s * stride}:${stride}`;
    votes.set(key, (votes.get(key) ?? 0) + 1);
  }
  let best: { base: number; stride: number; n: number } | null = null;
  for (const key of votes.keys()) {
    const [base, stride] = key.split(":").map(Number);
    const n = points.filter(list => list.some(p => p.at === base + p.s * stride)).length;
    if (!best || n > best.n) best = { base, stride, n };
  }
  return best;
}

const validTarget = (t: number, count: number) => t > 0 && t < count;

function readFixed(rom: Uint8Array, base: number, stride: number, count: number): (Evolution[] | null)[] {
  const per = Math.floor(stride / 8);
  return Array.from({ length: count }, (_, s) => {
    if (!s) return null;
    const out: Evolution[] = [];
    for (let k = 0; k < per; k++) {
      const o = base + s * stride + k * 8;
      if (o + 8 > rom.length) break;
      const method = u16(rom, o), target = u16(rom, o + 4);
      if (method === 0 || method === END || method === NONE || !validTarget(target, count)) continue;
      out.push({ method, param: u16(rom, o + 2), target, extra: u16(rom, o + 6) });
    }
    return out;
  });
}

function readList(rom: Uint8Array, p: number, size: number, count: number): Evolution[] | null {
  const out: Evolution[] = [];
  for (let k = 0; k < 32; k++) {
    const o = p + k * size;
    if (o + size > rom.length) return null;
    const method = u16(rom, o);
    if (method === END) return out;
    const target = u16(rom, o + 4);
    if (method > 0xff && method !== NONE) return null;
    if (!validTarget(target, count)) return null;
    if (method !== NONE) out.push({ method, param: u16(rom, o + 2), target, extra: size >= 8 ? u16(rom, o + 6) : 0 });
  }
  return null;
}

/** The most common method in the table: "reaches level N" in every engine. */
function commonMethod(list: (Evolution[] | null)[]): number {
  const c = new Map<number, number>();
  for (const l of list) for (const e of l ?? []) c.set(e.method, (c.get(e.method) ?? 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 4;
}

export function findEvolutions(rom: Uint8Array, species: string[]): Evolutions | null {
  return findWith(rom, species, false) ?? findWith(rom, species, true);
}

function findWith(rom: Uint8Array, species: string[], anyLevel: boolean): Evolutions | null {
  const count = species.length;
  const hits = anchorHits(rom, species, anyLevel);
  if (hits.length < 2) return null;
  const need = anyLevel ? Math.max(3, Math.ceil(hits.length * 0.5)) : Math.min(3, hits.length);

  // fixed-size table: entry 0 of each species at base + species * stride
  const grid = bestGrid(hits, d => d >= 8 && d <= 512 && d % 8 === 0);
  if (grid && grid.n >= need) {
    const list = readFixed(rom, grid.base, grid.stride, count);
    return { list, levelMethod: commonMethod(list), report: `evolutions (${grid.stride / 8} per species)` };
  }

  // per-species pointers to lists
  const words = romWords(rom);
  const ptrHits = hits.map(list => {
    const out: { s: number; at: number; target: number }[] = [];
    for (const h of list) {
      // the anchor is usually the first entry; Eevee-like lists aren't anchors
      const want = (0x08000000 + h.at) >>> 0;
      for (let i = 0; i < words.length; i++) if (words[i] === want) out.push({ s: h.s, at: i * 4, target: h.at });
    }
    return out;
  }).filter(x => x.length);
  const pg = bestGrid(ptrHits, d => d >= 4 && d <= 512 && d % 4 === 0);
  if (!pg || pg.n < need) return null;
  const ptrAt = (s: number) => {
    const v = u32(rom, pg.base + s * pg.stride);
    return v >= 0x08000000 && v < 0x08000000 + rom.length ? v - 0x08000000 : null;
  };
  // entry size: the one that reads every sampled list cleanly
  let size = 0, bestOk = -1;
  for (const sz of [8, 6, 12]) {
    let ok = 0;
    for (let s = 1; s < count; s += Math.max(1, Math.floor(count / 200))) {
      const p = ptrAt(s);
      if (p !== null && readList(rom, p, sz, count)) ok++;
    }
    if (ok > bestOk) { bestOk = ok; size = sz; }
  }
  const list = Array.from({ length: count }, (_, s) => {
    if (!s) return null;
    const p = ptrAt(s);
    return p === null ? [] : readList(rom, p, size, count) ?? [];
  });
  return { list, levelMethod: commonMethod(list), report: "evolutions" };
}

// ---- Describing methods ----

export interface EvoNames {
  species: (i: number) => string;
  item: (i: number) => string;
  move: (i: number) => string;
}

/** Type names by the games' own type ids (Emerald/FireRed order; 9 is the unused "???" type). */
const TYPES = ["Normal", "Fighting", "Flying", "Poison", "Ground", "Rock", "Bug", "Ghost", "Steel", "???", "Fire", "Water", "Grass",
  "Electric", "Psychic", "Ice", "Dragon", "Dark", "Fairy"];
const typeName = (t: number, cfru: boolean) => (cfru && t === 23 ? "Fairy" : TYPES[t] ?? `type ${t}`);
/** "a Fire-type", "an Electric-type" */
const aType = (t: number, cfru: boolean) => { const n = typeName(t, cfru); return `${/^[AEIOU]/.test(n) ? "an" : "a"} ${n}-type`; };

/** Which method list applies. Emerald Z has its own 43-45. */
export type EvoScheme = "emerald" | "emerald-z" | "monomyth" | "cfru";
export function evoScheme(engine: Engine | undefined, romCode: string): EvoScheme {
  if (engine === "compact") return "emerald-z";
  if (engine === "monomyth") return "monomyth";
  if (engine === "cfru" || /^BP[RG]/.test(romCode)) return "cfru";
  return "emerald";
}

/** Plain-language condition for one evolution entry, e.g. "Level 16" or "Use a Fire Stone". */
export function describeEvolution(e: Evolution, scheme: EvoScheme, n: EvoNames, levelMethod = 4): string {
  const p = e.param, item = () => n.item(p), lv = `Level ${p}`;
  if (levelMethod !== 4) return e.method === levelMethod ? lv : `Method ${e.method} (value ${p})`;
  switch (e.method) {
    case 1: return "Level up with high friendship";
    case 2: return "Level up with high friendship during the day";
    case 3: return "Level up with high friendship at night";
    case 4: return lv;
    case 5: return "Trade";
    case 6: return `Trade while holding ${item()}`;
    case 7: return `Use ${item()}`;
    case 8: return `${lv} with Attack higher than Defense`;
    case 9: return `${lv} with Attack equal to Defense`;
    case 10: return `${lv} with Attack lower than Defense`;
    case 11: case 12: return `${lv} (which one depends on its personality value)`;
    case 13: return lv;
    case 14: return `${lv}, with a free party slot and a spare Poké Ball`;
    case 15: return `Level up with Beauty of at least ${p}`;
  }
  if (scheme === "cfru") {
    switch (e.method) {
      case 16: return `${lv} while it's raining or foggy`;
      case 17: return `Level up knowing ${aType(p, true)} move`;
      case 18: return `${lv} with ${aType(e.extra, true)} Pokémon in the party`;
      case 19: return `Level up on a specific map (bank ${p}, map ${e.extra})`;
      case 20: return `${lv}, male`;
      case 21: return `${lv}, female`;
      case 22: return `${lv} at night`;
      case 23: return `${lv} during the day`;
      case 24: return `Level up holding ${item()} at night`;
      case 25: return `Level up holding ${item()} during the day`;
      case 26: return `Level up knowing ${n.move(p)}`;
      case 27: return `Level up with ${n.species(p)} in the party`;
      case 28: return `${lv} between ${e.extra >> 8}:00 and ${e.extra & 0xff}:00`;
      case 29: return "Level up after a story event";
      case 30: return "Land 3 critical hits in one battle";
      case 31: return `${lv} with an Amped nature`;
      case 32: return `${lv} with a Low Key nature`;
      case 33: return "Take 49+ damage in battle without fainting, then go to a special spot";
      case 34: return `Use ${item()} at a special spot`;
      case 35: return `${lv} while holding an item`;
      case 36: return `Use ${item()} while it holds another item`;
      case 37: return `Level up knowing ${n.move(p)}, male`;
      case 38: return `Level up knowing ${n.move(p)}, female`;
      case 39: return `Use ${item()} at night`;
      case 0xfd: return "Gigantamax";
      case 0xfe: return `Mega Evolve holding ${item()}`;
    }
    return `Special method ${e.method} (value ${p})`;
  }
  if (scheme === "monomyth") {
    if (e.method === 31) return `Special method 31 (value ${p})`;
    if (e.method === 32) return `Level up holding ${item()}`;
    if (e.method === 33) return "Level up in a specific place";
    if (e.method === 34) return "Level up during a sandstorm";
    if (e.method > 34) return `Special method ${e.method} (value ${p})`;
  }
  if (scheme === "emerald-z") {
    if (e.method === 43) return `${lv} knowing a Fire-type move`;
    if (e.method === 44) return `${lv} without knowing a Fire-type move`;
    if (e.method === 45) return `Level up with 50 ${item()} in the Bag`;
  }
  switch (e.method) {
    case 16: return `${lv}, female`;
    case 17: return `${lv}, male`;
    case 18: return `${lv} at night`;
    case 19: return `${lv} during the day`;
    case 20: return `${lv} at dusk (5–6 PM)`;
    case 21: return `Level up holding ${item()} during the day`;
    case 22: return `Level up holding ${item()} at night`;
    case 23: return `Level up knowing ${n.move(p)}`;
    case 24: return `Level up with high friendship knowing ${aType(p, false)} move`;
    case 25: return `Level up in a specific area (map section ${p})`;
    case 26: return `Use ${item()} on a male`;
    case 27: return `Use ${item()} on a female`;
    case 28: return `${lv} while it's raining`;
    case 29: return `Level up with ${n.species(p)} in the party`;
    case 30: return `${lv} with a Dark-type Pokémon in the party`;
    case 31: return `Trade for ${n.species(p)}`;
    case 32: return `Level up on a specific map (${p >> 8}.${p & 0xff})`;
    case 33: return `${lv} with an Amped nature`;
    case 34: return `${lv} with a Low Key nature`;
    case 35: return `Land ${p} critical hits in one battle`;
    case 36: return `Lose at least ${p} HP, then go to a special spot`;
    case 37: return "Train in the Tower of Darkness";
    case 38: return "Train in the Tower of Waters";
    case 39: return `Use ${item()} at night`;
    case 40: return `Use ${item()} during the day`;
    case 41: return `Level up holding ${item()}`;
    case 42: return `${lv} in fog`;
    case 43: case 44: return `Level up knowing ${n.move(p)} (form depends on its personality value)`;
    case 45: case 46: return `${lv} (form depends on its personality value)`;
  }
  return `Special method ${e.method} (value ${p})`;
}

/** Species that evolve into `target`, with the entry used. */
export function preEvolutions(list: (Evolution[] | null)[], target: number): { from: number; evo: Evolution }[] {
  const out: { from: number; evo: Evolution }[] = [];
  list.forEach((evos, from) => evos?.forEach(evo => { if (evo.target === target) out.push({ from, evo }); }));
  return out;
}
