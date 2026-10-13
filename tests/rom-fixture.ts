import { encodeBytes, VANILLA, w16, w32 } from "../src/core";

// ---- Synthetic ROMs: tables in both inline (vanilla/CFRU) and pointer (expansion) styles ----

const VTYPES = ["Normal","Fighting","Flying","Poison","Ground","Rock","Bug","Ghost","Steel","Mystery","Fire","Water","Grass","Electric","Psychic","Ice","Dragon","Dark"];

export function fakeRom(style: "inline" | "pointer"): Uint8Array {
  const rom = new Uint8Array(0x200000);
  rom[0xb2] = 0x96;
  rom.set(new TextEncoder().encode("TESTHACK"), 0xa0);
  rom.set(new TextEncoder().encode(style === "inline" ? "BPRE" : "BPEE"), 0xac);
  let cursor = 0x1000;
  const strings = new Map<string, number>();
  const putStr = (s: string) => {
    if (strings.has(s)) return strings.get(s)!;
    const e = encodeBytes(s)!; const at = cursor; rom.set(e, at); cursor += e.length + 1; strings.set(s, at); return at;
  };
  const N = 412;
  const name = (i: number) => (style === "inline" ? (VANILLA.species[i] || "?").toUpperCase() : VANILLA.species[i] || "??????????");
  // species: inline 11-byte names (vanilla) or names inside a 64-byte record (expansion style)
  const spStride = style === "inline" ? 11 : 64;
  const spBase = 0x40000;
  const bsBase = style === "inline" ? 0x60000 : spBase;
  const bsStride = style === "inline" ? 28 : 64;
  for (let i = 0; i < N; i++) {
    const nmAt = style === "inline" ? spBase + i * 11 : spBase + i * 64 + 40;
    const e = encodeBytes(name(i) || "?")!; rom.set(e.subarray(0, 11), nmAt);
    const inf = VANILLA.info[i];
    const r = bsBase + i * bsStride;
    if (!inf) continue;
    rom.set(inf.bs, r);
    const t = inf.t.map(x => VTYPES.indexOf(x));
    rom[r + 6] = t[0]; rom[r + 7] = t[1] ?? t[0];
    if (style === "inline") {
      rom[r + 16] = inf.g; rom[r + 19] = inf.gr!; rom[r + 22] = inf.ab[0]; rom[r + 23] = inf.ab[1];
      if (i === 1) rom[r + 26] = 34; if (i === 7) rom[r + 26] = 44; if (i === 25) rom[r + 26] = 31; // CFRU-style hidden
    } else {
      rom[r + 20] = inf.g; rom[r + 23] = inf.gr!; w16(rom, r + 26, inf.ab[0]); w16(rom, r + 28, inf.ab[1]);
      w16(rom, r + 30, i === 1 ? 34 : i === 7 ? 44 : i === 25 ? 31 : 0);
    }
  }
  if (style === "inline") rom.set(encodeBytes("SHEDINJA")!.subarray(0, 11), spBase + 303 * 11);
  // moves
  const mvBase = 0x80000;
  for (let i = 0; i < VANILLA.moves.length; i++) {
    const nm = style === "inline" ? VANILLA.moves[i].toUpperCase() : VANILLA.moves[i];
    if (style === "inline") { rom.set(encodeBytes(nm)!.subarray(0, 13), mvBase + i * 13); rom[0x90000 + i * 12 + 4] = VANILLA.movePP[i]; }
    else { w32(rom, mvBase + i * 24, 0x08000000 + putStr(nm === "DoubleSlap" ? "Double Slap" : nm)); rom[mvBase + i * 24 + 13] = VANILLA.movePP[i]; }
  }
  // items
  const itBase = 0xa0000;
  for (let i = 0; i < VANILLA.items.length; i++) {
    const nm = VANILLA.items[i] || "????????";
    if (style === "inline") rom.set(encodeBytes(nm.toUpperCase())!.subarray(0, 14), itBase + i * 44);
    else w32(rom, itBase + i * 40 + 20, 0x08000000 + putStr(nm));
  }
  // abilities (inline in both; 13 or 17 bytes)
  const abStride = style === "inline" ? 13 : 24;
  for (let i = 0; i < VANILLA.abilities.length; i++) {
    const nm = style === "inline" ? VANILLA.abilities[i].toUpperCase() : VANILLA.abilities[i];
    rom.set(encodeBytes(nm)!.subarray(0, abStride), 0xc0000 + i * abStride);
  }
  return rom;
}

