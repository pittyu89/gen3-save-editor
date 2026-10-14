// Builds a new Pokémon the way the game would when catching one: random personality value and IVs,
// the moves it would know at its level, and the player as its original trainer.
import { data, expForLevel, speciesName } from "./data";
import { encodeBytes } from "./text";
import { codecInfo, maxPP, toParty, type CodecId, type Pokemon } from "./gen3/pokemon";
import type { GameProfile } from "./profiles";
import type { Trainer } from "./gen3/save";
import { ballChoices } from "./balls";

const GAME_VERSION: Record<string, number> = { RS: 2, E: 3, FRLG: 4 }; // Ruby, Emerald, FireRed
const rand32 = () => (Math.random() * 0x100000000) >>> 0;

/** The last four distinct moves learned at or below `level`, like a wild Pokémon. */
export function defaultMoves(species: number, level: number): number[] {
  const lv = data().learn?.levelUp[species] ?? null;
  const out: number[] = [];
  if (lv) for (const [l, mv] of lv) {
    if (l > level) continue;
    const i = out.indexOf(mv);
    if (i >= 0) out.splice(i, 1);
    out.push(mv);
    if (out.length > 4) out.shift();
  }
  if (!out.length) out.push(33); // Tackle
  return out;
}

function encodableName(s: string, max: number): string {
  let out = "";
  for (const ch of s.toUpperCase()) { if (encodeBytes(out + ch)) out += ch; }
  return out.slice(0, max);
}

export function createPokemon(species: number, level: number, profile: GameProfile, trainer: Trainer, forParty: boolean): Pokemon {
  const codec: CodecId = forParty ? profile.partyCodec : profile.boxCodec;
  const ci = codecInfo(codec);
  const info = data().info[species];
  const lvl = Math.max(1, Math.min(100, level));
  const pid = rand32();
  const moves = defaultMoves(species, lvl);
  const poke = ballChoices(profile.engine).find(([, n]) => /^pok[eé] ?ball$/i.test(n))?.[0] ?? 4;
  const m: Pokemon = {
    codec, pid, otId: ((trainer.sid << 16) | trainer.tid) >>> 0,
    nickname: encodableName(speciesName(species), ci.nickLen), language: 2, flags: 0,
    otName: trainer.name, markings: 0, species, heldItem: 0,
    exp: info && info.gr !== null ? expForLevel(info.gr, lvl) : 0,
    ppBonuses: 0, friendship: 70,
    moves: [0, 1, 2, 3].map(i => moves[i] ?? 0), pp: [0, 0, 0, 0],
    evs: [0, 0, 0, 0, 0, 0], contest: [0, 0, 0, 0, 0, 0], pokerus: 0,
    metLocation: 0xff, metLevel: lvl, metGame: GAME_VERSION[profile.family] ?? 3, otGender: trainer.gender & 1,
    ball: Math.min(poke, ci.maxBall), ivs: Array.from({ length: 6 }, () => Math.floor(Math.random() * 32)),
    isEgg: false, abilityNum: ci.abilityKind === "cfru" ? pid & 1 : 0, shinyMod: 0, natureMod: 0,
    checksumOk: true, dirty: true,
  };
  m.pp = m.moves.map((mv, i) => (mv ? maxPP(mv, 0, i) || 10 : 0));
  if (forParty) toParty(m);
  return m;
}
