// Finds damage that cheat codes (and glitches) typically leave in a save, and offers fixes.
// Nothing changes until a fix is applied, and every fix only touches the parsed save in memory.
import { data, isValidSpecies, expForLevel, speciesName } from "./data";
import type { ParsedSave } from "./gen3/save";
import { codecInfo, plausibility, maxPP, refreshParty, levelOf, calcStats, type Pokemon } from "./gen3/pokemon";

export type Where = { where: "party"; i: number } | { where: "box"; box: number; i: number } | { where: "trainer" };

export interface Issue {
  id: string;
  where: Where;
  /** Short name of the Pokémon or field the issue is about. */
  subject: string;
  problem: string;
  fix: string;
  /** Pre-selected in the UI: the fix is safe and almost certainly wanted. */
  recommended: boolean;
  kind: "bad-egg" | "item" | "move" | "pp" | "exp" | "stats" | "ev" | "species" | "money";
  /** The fix deletes the record instead of changing it. */
  remove?: boolean;
  apply?(save: ParsedSave): void;
}

const MAX_MONEY = 999999, MAX_COINS = 9999;

function monAt(save: ParsedSave, w: Where): Pokemon | null {
  if (w.where === "party") return save.party[w.i] ?? null;
  if (w.where === "box") return save.boxes[w.box]?.slots[w.i] ?? null;
  return null;
}

/** Removes a record. Party members are spliced out later (see applyIssues) so indexes stay valid while fixing. */
function markRemoved(save: ParsedSave, w: Where, removed: Set<Pokemon>): void {
  const m = monAt(save, w);
  if (!m) return;
  if (w.where === "box") save.boxes[w.box].slots[w.i] = null;
  else removed.add(m);
}

const placeName = (save: ParsedSave, w: Where) =>
  w.where === "party" ? `Party ${w.i + 1}` : w.where === "box" ? `${save.boxes[w.box].name || `Box ${w.box + 1}`} · slot ${w.i + 1}` : "Trainer";

function label(save: ParsedSave, w: Where, m: Pokemon, ok: boolean): string {
  const name = !ok ? "Bad Egg" : m.nickname.trim() || (isValidSpecies(m.species) ? speciesName(m.species) : `No. ${m.species}`);
  return `${placeName(save, w)} · ${name}`;
}

/** Shape checks that hold for every real Pokémon in any Gen III game or hack, whatever its tables. */
function structurallySound(m: Pokemon): boolean {
  const LIMIT = 2047; // no hack has this many species, moves or items
  const moves = m.moves.filter(x => x > 0);
  return m.species > 0 && m.species <= LIMIT && m.heldItem <= LIMIT && m.moves[0] > 0
    && m.moves.every(x => x <= LIMIT) && new Set(moves).size === moves.length
    && m.pp.every(x => x <= 64) && m.ball >= 1 && m.ball <= 40 && m.metLevel <= 100;
}

/** Whether a Bad Egg's data still reads as a real Pokémon once its checksum is ignored. A cheat that
 *  wrote into encrypted data scrambles it; one that only broke the checksum or flag leaves it intact. */
function readsCleanly(m: Pokemon, codec: Parameters<typeof plausibility>[1], tablesTrusted: boolean): boolean {
  if (!structurallySound(m) || m.species > codecInfo(codec).maxSpecies) return false;
  if (!tablesTrusted) return true;
  return isValidSpecies(m.species) && plausibility({ ...m, checksumOk: true }, codec) >= 0.9;
}

export interface Scan { issues: Issue[]; notes: string[] }

/**
 * Scans the whole save for cheat and glitch damage. Checks that depend on the game's tables (species,
 * moves, items, stats) only run with tables read from the game's ROM, since a hack's own species and
 * moves would otherwise look like glitches.
 */
export function scanSave(save: ParsedSave): Scan {
  const issues: Issue[] = [];
  const notes: string[] = [];
  const d = data();
  const tablesTrusted = d.source === "rom";
  const knowsItems = d.items.length > 1 && d.items.slice(1).some(Boolean);
  const knowsMoves = d.source === "rom" || d.id === "gen3";
  const knowsPP = d.movePP.length > 1 && d.movePP.slice(1).some(x => x > 0);

  const visit = (w: Where, m: Pokemon, codec: Parameters<typeof codecInfo>[0]) => {
    const c = codecInfo(codec);
    const key = w.where === "party" ? `p${w.i}` : w.where === "box" ? `b${w.box}-${w.i}` : "t";
    const flagged = (m.flags & 1) === 1;

    // 1) Bad Eggs: checksum mismatch or the bad-egg flag
    if (!m.checksumOk || flagged) {
      const clean = readsCleanly(m, codec, tablesTrusted);
      const what = !m.checksumOk ? "Stored checksum doesn't match its data, so the game shows a Bad Egg." : "Marked as a Bad Egg although its data checks out.";
      const lastInParty = w.where === "party" && save.party.length === 1;
      if (clean) {
        issues.push({
          id: `${key}-egg`, where: w, subject: label(save, w, m, true), kind: "bad-egg", recommended: true,
          problem: what + " The data underneath still reads as a normal Pokémon.",
          fix: `Restore it as ${m.nickname.trim() || speciesName(m.species)}`,
          apply: s => { const x = monAt(s, w); if (x) { x.flags &= ~1; x.checksumOk = true; x.dirty = true; refreshParty(x); } }, // the checksum is rewritten on export
        });
      } else {
        issues.push({
          id: `${key}-egg`, where: w, subject: label(save, w, m, false), kind: "bad-egg", recommended: !lastInParty,
          problem: what + " The data is scrambled and can't be recovered.",
          fix: lastInParty ? "Delete it (move another Pokémon to the party first)" : "Delete it", remove: true,
        });
      }
      return; // other checks on a scrambled record are meaningless
    }

    if (!tablesTrusted) return;
    const name = label(save, w, m, true);
    // 2) Unknown species with a valid checksum ("?????" glitch Pokémon)
    if (!isValidSpecies(m.species) || m.species > c.maxSpecies) {
      issues.push({ id: `${key}-species`, where: w, subject: `${placeName(save, w)} · No. ${m.species}`, kind: "species", recommended: false,
        problem: `Species ${m.species} doesn't exist in this game (a glitch Pokémon).`, fix: "Delete it", remove: true });
      return;
    }
    // 3) Glitch held item
    if (m.heldItem > 0 && (m.heldItem > c.maxItem || (knowsItems && !d.items[m.heldItem])))
      issues.push({ id: `${key}-item`, where: w, subject: name, kind: "item", recommended: true,
        problem: `Holds item ${m.heldItem}, which doesn't exist (shows as "?????" or crashes the bag).`, fix: "Remove the held item",
        apply: s => { const x = monAt(s, w); if (x) { x.heldItem = 0; x.dirty = true; } } });
    // 4) Glitch moves
    const badMoves = m.moves.map((mv, i) => ({ mv, i })).filter(({ mv }) => mv > c.maxMove || (knowsMoves && mv >= d.moves.length) || (knowsMoves && mv > 0 && !d.moves[mv]));
    if (badMoves.length)
      issues.push({ id: `${key}-moves`, where: w, subject: name, kind: "move", recommended: true,
        problem: `Knows move${badMoves.length > 1 ? "s" : ""} ${badMoves.map(b => b.mv).join(", ")}, which ${badMoves.length > 1 ? "don't" : "doesn't"} exist. Using ${badMoves.length > 1 ? "them" : "it"} can freeze the game.`,
        fix: "Forget the broken moves",
        apply: s => {
          const x = monAt(s, w); if (!x) return;
          const keep = x.moves.map((mv, i) => ({ mv, pp: x.pp[i] })).filter(({ mv }) => mv > 0 && !badMoves.some(b => b.mv === mv));
          if (!keep.length) keep.push({ mv: 1, pp: d.movePP[1] || 35 }); // a Pokémon must know a move: Pound
          x.moves = [0, 1, 2, 3].map(i => keep[i]?.mv ?? 0);
          x.pp = [0, 1, 2, 3].map(i => keep[i]?.pp ?? 0);
          x.dirty = true;
        } });
    // 5) PP above the maximum
    if (knowsPP && c.storesPP) {
      const over = m.moves.some((mv, i) => mv > 0 && mv < d.movePP.length && d.movePP[mv] > 0 && m.pp[i] > maxPP(mv, m.ppBonuses, i));
      if (over && !badMoves.length)
        issues.push({ id: `${key}-pp`, where: w, subject: name, kind: "pp", recommended: true,
          problem: "Has more PP than its moves allow (a common infinite-PP cheat side effect).", fix: "Set PP to the maximum",
          apply: s => { const x = monAt(s, w); if (!x) return; x.moves.forEach((mv, i) => { if (mv > 0) x.pp[i] = Math.min(x.pp[i], maxPP(mv, x.ppBonuses, i)); }); x.dirty = true; } });
    }
    // 6) EXP above level 100
    const info = d.info[m.species];
    if (info && info.gr !== null && m.exp > expForLevel(info.gr, 100))
      issues.push({ id: `${key}-exp`, where: w, subject: name, kind: "exp", recommended: true,
        problem: "Has more EXP than level 100 allows; the game can show it as level 0 or above 100.", fix: "Cap at level 100",
        apply: s => { const x = monAt(s, w); if (x && info.gr !== null) { x.exp = expForLevel(info.gr, 100); x.dirty = true; refreshParty(x); } } });
    // 7) EV total above 510
    const ev = m.evs.reduce((a, b) => a + b, 0);
    if (ev > 510)
      issues.push({ id: `${key}-ev`, where: w, subject: name, kind: "ev", recommended: false,
        problem: `EV total is ${ev}; legit play caps it at 510. The game accepts it, but it can't happen normally.`, fix: "Scale EVs down to 510",
        apply: s => {
          const x = monAt(s, w); if (!x) return;
          const total = x.evs.reduce((a, b) => a + b, 0);
          x.evs = x.evs.map(e => Math.floor((e * 510) / total));
          x.dirty = true; refreshParty(x);
        } });
    // 8) Party data that disagrees with the Pokémon (wrong level, HP above max, stats from another species)
    if (m.party) {
      const lvl = levelOf(m), stats = lvl !== null ? calcStats(m, lvl) : null;
      const wrongLevel = lvl !== null && lvl !== m.party.level;
      const wrongStats = !!stats && stats.some((v, i) => v !== m.party!.stats[i]);
      const hpOver = m.party.hp > m.party.stats[0];
      if (wrongLevel || hpOver || wrongStats)
        issues.push({ id: `${key}-stats`, where: w, subject: name, kind: "stats", recommended: wrongLevel || hpOver,
          problem: wrongLevel ? `Shown as level ${m.party.level}, but its EXP is level ${lvl}.`
            : hpOver ? `HP is ${m.party.hp} out of ${m.party.stats[0]}.`
            : "Its battle stats don't match its level, base stats, IVs, EVs and nature. Some hacks change the stat formula, so only fix this if you're sure.",
          fix: "Recalculate level, stats and HP",
          apply: s => { const x = monAt(s, w); if (x?.party) { refreshParty(x); if (x.party.hp > x.party.stats[0]) x.party.hp = x.party.stats[0]; x.dirty = true; } } });
    }
  };

  save.party.forEach((m, i) => visit({ where: "party", i }, m, save.profile.partyCodec));
  save.boxes.forEach((b, bi) => b.slots.forEach((m, i) => { if (m) visit({ where: "box", box: bi, i }, m, save.profile.boxCodec); }));

  // A ROM from another game makes everything look broken; don't offer to "fix" a whole save.
  const mons = save.party.length + save.boxes.reduce((a, b) => a + b.slots.filter(Boolean).length, 0);
  const tableBased = issues.filter(i => i.kind === "species" || i.kind === "move");
  if (tablesTrusted && mons >= 4 && new Set(tableBased.map(i => i.subject)).size > mons * 0.3) {
    notes.push("Many Pokémon have species or moves the loaded ROM doesn't know, so the ROM probably isn't the one this save belongs to. Load the matching ROM to check moves, items and stats.");
    for (let i = issues.length - 1; i >= 0; i--) if (issues[i].kind !== "bad-egg") issues.splice(i, 1);
  }
  if (!tablesTrusted) notes.push("Moves, items and stats aren't checked without the game's own ROM loaded; only Bad Eggs and money are.");

  const t = save.trainer, tw: Where = { where: "trainer" };
  if (t.money > MAX_MONEY)
    issues.push({ id: "money", where: tw, subject: "Trainer · Money", kind: "money", recommended: true,
      problem: `Money is ${t.money.toLocaleString("en-US")}; the game's maximum is 999,999 and larger values display wrong.`, fix: "Set to 999,999",
      apply: s => { s.trainer.money = MAX_MONEY; } });
  if (t.coins > MAX_COINS)
    issues.push({ id: "coins", where: tw, subject: "Trainer · Coins", kind: "money", recommended: true,
      problem: `Game Corner coins are ${t.coins.toLocaleString("en-US")}; the maximum is 9,999.`, fix: "Set to 9,999",
      apply: s => { s.trainer.coins = MAX_COINS; } });

  return { issues, notes };
}

/** Applies the chosen fixes. Returns how many were applied. */
export function applyIssues(save: ParsedSave, chosen: Issue[]): number {
  const removed = new Set<Pokemon>();
  let n = 0;
  for (const is of chosen) {
    if (is.remove) {
      // never empty the party
      if (is.where.where === "party" && save.party.length - removed.size <= 1) continue;
      markRemoved(save, is.where, removed);
    } else is.apply?.(save);
    n++;
  }
  if (removed.size) save.party = save.party.filter(m => !removed.has(m));
  return n;
}
