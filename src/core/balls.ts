// Poké Ball ids as each engine stores them in a Pokémon, with display names.
//   vanilla       the ball's item id (1 Master … 12 Premier), 4 bits
//   expansion 1.8+ enum PokeBall (0 Strange, 1 Poké …), 6 bits — include/constants/pokeball.h
//   expansion <1.8 the ball's item id, 5 bits
//   CFRU          enum BallTypes (0 Master, 1 Ultra …) — include/new/catching.h
import { data } from "./data";
import type { Engine } from "./profiles";

const VANILLA = ["", "Master Ball", "Ultra Ball", "Great Ball", "Poké Ball", "Safari Ball", "Net Ball", "Dive Ball", "Nest Ball",
  "Repeat Ball", "Timer Ball", "Luxury Ball", "Premier Ball"];
const PEX = ["Strange Ball", "Poké Ball", "Great Ball", "Ultra Ball", "Master Ball", "Premier Ball", "Heal Ball", "Net Ball", "Nest Ball",
  "Dive Ball", "Dusk Ball", "Timer Ball", "Quick Ball", "Repeat Ball", "Luxury Ball", "Level Ball", "Lure Ball", "Moon Ball",
  "Friend Ball", "Love Ball", "Fast Ball", "Heavy Ball", "Dream Ball", "Safari Ball", "Sport Ball", "Park Ball", "Beast Ball", "Cherish Ball"];
const CFRU = ["Master Ball", "Ultra Ball", "Great Ball", "Poké Ball", "Safari Ball", "Net Ball", "Dive Ball", "Nest Ball", "Repeat Ball",
  "Timer Ball", "Luxury Ball", "Premier Ball", "Dusk Ball", "Heal Ball", "Quick Ball", "Cherish Ball", "Park Ball", "Fast Ball",
  "Level Ball", "Lure Ball", "Heavy Ball", "Love Ball", "Friend Ball", "Moon Ball", "Sport Ball", "Beast Ball", "Dream Ball"];

const isBallName = (n: string | undefined) => !!n && /ball$/i.test(n.trim());

/** Ball ids this engine can store, with names. Item-id engines use the ROM's own item names. */
export function ballChoices(engine: Engine): [number, string][] {
  if (engine === "pex-modern") return PEX.map((n, i) => [i, n]);
  if (engine === "cfru") return CFRU.map((n, i) => [i, n]);
  const items = data().items, max = engine === "pex-legacy" ? 31 : 15;
  const out: [number, string][] = [];
  for (let i = 1; i <= max; i++) {
    const n = items[i];
    if (isBallName(n)) out.push([i, n]);
    else if (engine === "vanilla" && VANILLA[i]) out.push([i, VANILLA[i]]);
  }
  return out;
}

export function ballName(engine: Engine, id: number): string {
  return ballChoices(engine).find(c => c[0] === id)?.[1] ?? `Ball ${id}`;
}

const key = (s: string) => s.toLowerCase().replace(/é/g, "e").replace(/[^a-z]/g, "");

/** The item id with this ball's name, for showing its icon. */
export function ballItem(engine: Engine, id: number): number | null {
  if ((engine === "vanilla" || engine === "pex-legacy") && isBallName(data().items[id])) return id;
  const want = key(ballName(engine, id));
  const i = data().items.findIndex(n => n && key(n) === want);
  return i > 0 ? i : null;
}
