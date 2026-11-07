import { encodeBytes, VANILLA, w16, w32, lz77EncodeLiteral, standardExp } from "../src/core";

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
  // sprites: species s gets a 64x64 image filled with palette colour (s % 15) + 1
  const SPR = 30;
  let dataAt = 0x110000;
  const putLz = (raw: Uint8Array) => { const e = lz77EncodeLiteral(raw); const at = dataAt; rom.set(e, at); dataAt += e.length; return at; };
  const sprAt: number[] = [], palAt: number[] = [], shinyAt: number[] = [], rawPalAt: number[] = [];
  for (let sp = 0; sp < SPR; sp++) {
    const ci = (sp % 15) + 1;
    // a filled disc, in 8x8 4bpp tiles
    const tiles = new Uint8Array(0x800);
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
      if ((x - 32) ** 2 + (y - 36) ** 2 > (14 + sp % 10) ** 2) continue;
      const t = (y >> 3) * 8 + (x >> 3), o = t * 32 + (y & 7) * 4 + ((x & 7) >> 1);
      tiles[o] |= (x & 1) ? ci << 4 : ci;
    }
    sprAt.push(putLz(tiles));
    const pal = new Uint8Array(32); w16(pal, ci * 2, 31 /* red */); const shinyPal = new Uint8Array(32); w16(shinyPal, ci * 2, 31 << 10 /* blue */);
    palAt.push(putLz(pal)); shinyAt.push(putLz(shinyPal));
    rawPalAt.push(dataAt); rom.set(pal, dataAt); dataAt += 32;
  }
  const P = (i: number) => 0x08000000 + i;
  if (style === "inline") {
    for (let sp = 0; sp < N; sp++) {
      const k = sp < SPR ? sp : 1;
      w32(rom, 0x100000 + sp * 8, P(sprAt[k])); w16(rom, 0x100000 + sp * 8 + 4, 0x800); w16(rom, 0x100000 + sp * 8 + 6, sp);
      w32(rom, 0x104000 + sp * 8, P(palAt[k])); w16(rom, 0x104000 + sp * 8 + 4, sp);
      w32(rom, 0x108000 + sp * 8, P(shinyAt[k])); w16(rom, 0x108000 + sp * 8 + 4, sp + 500);
    }
  } else {
    for (let sp = 1; sp < N; sp++) {
      const k = sp < SPR ? sp : 1;
      w32(rom, spBase + sp * 64 + 32, P(sprAt[k])); w32(rom, spBase + sp * 64 + 36, P(rawPalAt[k]));
    }
  }
  return rom;
}


// ---- A hack with its own species order (fakemon interleaved with real Pokémon), like Pokémon Monomyth:
// inline names with "??????????" at entry 0, 24-byte base stats (gender +9, growth +12, u8 abilities
// +20..22), an ability list in its own order starting "-------", a type-name table with Fairy at 18,
// and reordered, retuned EXP curves.
export const REGIONAL_REAL = (i: number) => (i % 3 === 0 ? i + 1 : 0); // ROM index -> Gen III species, or 0 for a fakemon
export const REGIONAL_CURVES = [2, 5, 3, 0, 4]; // ROM curve id -> standard growth rate
export function fakeRegionalRom(): Uint8Array {
  const rom = new Uint8Array(0x200000);
  rom[0xb2] = 0x96;
  rom.set(new TextEncoder().encode("REGIONAL"), 0xa0);
  rom.set(new TextEncoder().encode("BPEE"), 0xac);
  const N = 150;
  const abilities = ["-------", ...VANILLA.abilities.slice(1).reverse()];
  const abId = (vanillaId: number) => (vanillaId ? abilities.indexOf(VANILLA.abilities[vanillaId]) : 0);
  const TYPES = [...VTYPES.slice(0, 9), "???", ...VTYPES.slice(10), "Fairy"];
  const romCurve = (std: number) => REGIONAL_CURVES.indexOf(std);
  const spBase = 0x40000, bsBase = 0x60000;
  rom.set(encodeBytes("??????????")!, spBase);
  for (let i = 1; i < N; i++) {
    const real = REGIONAL_REAL(i), inf = real ? VANILLA.info[real] : null;
    rom.set(encodeBytes(real ? VANILLA.species[real] : `Fakemon${i}`)!.subarray(0, 11), spBase + i * 11);
    const r = bsBase + i * 24;
    const t = inf ? inf.t.map(x => TYPES.indexOf(x)) : [18, 18];
    rom.set(inf ? inf.bs : [50 + i % 40, 60, 70 + i % 7, 80, 90, 41 + i % 13], r);
    rom[r + 6] = t[0]; rom[r + 7] = t[1] ?? t[0];
    rom[r + 8] = 45; rom[r + 9] = inf ? inf.g : 127; rom[r + 10] = 20; rom[r + 11] = 70;
    rom[r + 12] = inf ? romCurve(inf.gr!) : 1;
    rom[r + 20] = inf ? abId(inf.ab[0]) : 7; rom[r + 21] = inf ? abId(inf.ab[1] || inf.ab[0]) : 8; rom[r + 22] = 9;
  }
  // moves right after the species names, as in pokeemerald
  const mvBase = spBase + N * 11;
  for (let i = 0; i < VANILLA.moves.length; i++) rom.set(encodeBytes(VANILLA.moves[i])!.subarray(0, 13), mvBase + i * 13);
  for (let i = 0; i < abilities.length; i++) rom.set(encodeBytes(abilities[i])!.subarray(0, 13), 0xc0000 + i * 13);
  for (let i = 0; i < TYPES.length; i++) rom.set(encodeBytes(TYPES[i])!, 0xd0000 + i * 9);
  // EXP curves in their own order, each 1000 higher at level 100 than the standard one
  REGIONAL_CURVES.forEach((std, row) => {
    for (let l = 0; l <= 100; l++) w32(rom, 0xe0000 + row * 404 + l * 4, standardExp(std, l) + (l === 100 ? 1000 : 0));
  });
  return rom;
}
