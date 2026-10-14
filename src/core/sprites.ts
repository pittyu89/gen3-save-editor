// Reads Pokémon front sprites from the user's own ROM, the way an emulator would display them.
// Nothing is bundled with the editor: without a ROM there are no sprites.
//
// Vanilla Gen III and CFRU keep three tables of 8-byte entries indexed by species:
//   gMonFrontPicTable    { const u32 *lz77Tiles; u16 size = 0x800; u16 tag = species }
//   gMonPaletteTable     { const u32 *lz77Palette; u16 tag = species; u16 pad }
//   gMonShinyPaletteTable{ const u32 *lz77Palette; u16 tag = species + 500; u16 pad }
// pokeemerald-expansion stores sprite pointers inside each SpeciesInfo record instead; older
// releases use LZ77 like vanilla, newer ones a different compressor ("smol") that isn't read yet.
import { u16, u32 } from "./binary";

export interface SpriteTables {
  kind: "tables" | "records";
  front: { at: number; stride: number; ptrOff: number };   // entry for species s at at + s*stride
  palette: { at: number; stride: number; ptrOff: number; compressed: boolean } | null;
  shiny: { at: number; stride: number; ptrOff: number; compressed: boolean } | null;
  count: number;
}

export interface Sprite { width: number; height: number; rgba: Uint8ClampedArray }

const ptr = (rom: Uint8Array, at: number): number | null => {
  if (at < 0 || at + 4 > rom.length) return null;
  const o = u32(rom, at) - 0x08000000;
  return o >= 0 && o < rom.length ? o : null;
};

/** GBA BIOS LZ77 (type 0x10) decompression. Returns null on malformed data. */
export function lz77(rom: Uint8Array, at: number, maxOut = 0x10000): Uint8Array | null {
  if (rom[at] !== 0x10) return null;
  const size = rom[at + 1] | (rom[at + 2] << 8) | (rom[at + 3] << 16);
  if (size === 0 || size > maxOut) return null;
  const out = new Uint8Array(size);
  let src = at + 4, dst = 0;
  while (dst < size) {
    if (src >= rom.length) return null;
    const flags = rom[src++];
    for (let bit = 7; bit >= 0 && dst < size; bit--) {
      if (flags & (1 << bit)) {
        if (src + 1 >= rom.length) return null;
        const b1 = rom[src++], b2 = rom[src++];
        const len = (b1 >> 4) + 3, disp = (((b1 & 0xf) << 8) | b2) + 1;
        if (disp > dst) return null;
        for (let k = 0; k < len && dst < size; k++, dst++) out[dst] = out[dst - disp];
      } else {
        if (src >= rom.length) return null;
        out[dst++] = rom[src++];
      }
    }
  }
  return out;
}

/** Simple LZ77 encoder (literals only); used by tests to build synthetic ROMs. */
export function lz77EncodeLiteral(data: Uint8Array): Uint8Array {
  const out: number[] = [0x10, data.length & 0xff, (data.length >> 8) & 0xff, (data.length >> 16) & 0xff];
  for (let i = 0; i < data.length; i += 8) {
    out.push(0);
    for (let k = i; k < Math.min(i + 8, data.length); k++) out.push(data[k]);
  }
  while (out.length % 4) out.push(0);
  return new Uint8Array(out);
}

const isLz = (rom: Uint8Array, at: number | null, size: number) =>
  at !== null && rom[at] === 0x10 && (rom[at + 1] | (rom[at + 2] << 8) | (rom[at + 3] << 16)) === size;

/** Finds an 8-byte-entry table whose species tags run 1, 2, 3 ... with LZ77 data of `size` bytes. */
function findTagTable(rom: Uint8Array, tagOff: number, tagBase: number, size: number, extra?: (a: number) => boolean) {
  for (let a = 0; a + 64 <= rom.length; a += 4) {
    if (u16(rom, a + tagOff) !== tagBase + 1) continue;
    if (u16(rom, a + 8 + tagOff) !== tagBase + 2 || u16(rom, a + 16 + tagOff) !== tagBase + 3) continue;
    if (extra && !extra(a)) continue;
    if (!isLz(rom, ptr(rom, a), size) || !isLz(rom, ptr(rom, a + 8), size) || !isLz(rom, ptr(rom, a + 16), size)) continue;
    return a - 8; // entry for species 0
  }
  return -1;
}

/** Locates sprite data in a ROM. `species` gives the base-stats record layout for engines that keep pointers there. */
export function findSpriteTables(rom: Uint8Array, speciesCount: number, record?: { at: number; stride: number },
  gf?: { frontPics: number | null; normalPalettes: number | null; shinyPalettes: number | null }): SpriteTables | null {
  // 0) Table pointers from the GF ROM header (vanilla, binary hacks, CFRU)
  if (gf && gf.frontPics !== null) {
    const f = gf.frontPics, okFront = [1, 2, 3].every(sp => { const p = ptr(rom, f + sp * 8); return p !== null && rom[p] === 0x10; });
    const palOk = (t: number | null) => t !== null && [1, 2].every(sp => isLz(rom, ptr(rom, t + sp * 8), 0x20));
    if (okFront) return {
      kind: "tables",
      front: { at: f, stride: 8, ptrOff: 0 },
      palette: palOk(gf.normalPalettes) ? { at: gf.normalPalettes!, stride: 8, ptrOff: 0, compressed: true } : null,
      shiny: palOk(gf.shinyPalettes) ? { at: gf.shinyPalettes!, stride: 8, ptrOff: 0, compressed: true } : null,
      count: speciesCount,
    };
  }
  // 1) Vanilla / CFRU tables found by their tags
  const front = findTagTable(rom, 6, 0, 0x800, a => u16(rom, a + 4) === 0x800);
  if (front >= 0) {
    const pal = findTagTable(rom, 4, 0, 0x20);
    // Shiny palettes use tag = species + SPECIES_SHINY_TAG; find the offset rather than assume it.
    let shiny = -1;
    for (let a = 0; a + 64 <= rom.length && shiny < 0; a += 4) {
      const x = u16(rom, a + 4);
      if (x < 100 || x > 4000 || u16(rom, a + 12) !== x + 1 || u16(rom, a + 20) !== x + 2 || u16(rom, a - 4) !== x - 1 || u16(rom, a - 12) === x - 2) continue; // start of a run, not the middle of the normal table
      if (a - 8 === pal) continue;
      if (isLz(rom, ptr(rom, a), 0x20) && isLz(rom, ptr(rom, a + 8), 0x20) && isLz(rom, ptr(rom, a + 16), 0x20)) shiny = a - 8;
    }
    return {
      kind: "tables",
      front: { at: front, stride: 8, ptrOff: 0 },
      palette: pal >= 0 ? { at: pal, stride: 8, ptrOff: 0, compressed: true } : null,
      shiny: shiny >= 0 ? { at: shiny, stride: 8, ptrOff: 0, compressed: true } : null,
      count: speciesCount,
    };
  }
  // 2) Pointers inside SpeciesInfo records (pokeemerald-expansion)
  if (!record) return null;
  const rec = (s: number) => record.at + (s - 1) * record.stride;
  const sample = [1, 2, 3, 4, 7, 25];
  let frontOff = -1;
  for (let k = 0; k + 4 <= record.stride; k += 4) {
    if (sample.every(s => isLz(rom, ptr(rom, rec(s) + k), 0x800))) { frontOff = k; break; }
  }
  if (frontOff < 0) return null;
  // palette: LZ-compressed 32 bytes in older releases, raw 16 colours in newer ones
  let palOff = -1, compressed = true;
  for (let k = 0; k + 4 <= record.stride && palOff < 0; k += 4) {
    if (k !== frontOff && sample.every(s => isLz(rom, ptr(rom, rec(s) + k), 0x20))) palOff = k;
  }
  if (palOff < 0) {
    compressed = false;
    // A raw palette is 16 BGR555 colours with bit 15 clear; take the first pointer field after the
    // front pic whose targets all look like that and differ between species.
    for (let k = frontOff + 4; k + 4 <= record.stride && palOff < 0; k += 4) {
      const ps = sample.map(s => ptr(rom, rec(s) + k));
      if (ps.some(p => p === null)) continue;
      if (new Set(ps).size !== ps.length) continue;
      if (ps.every(p => { for (let i = 1; i < 32; i += 2) if (rom[p! + i] & 0x80) return false; return true; })) palOff = k;
    }
  }
  return {
    kind: "records",
    front: { at: record.at - record.stride, stride: record.stride, ptrOff: frontOff },
    palette: palOff >= 0 ? { at: record.at - record.stride, stride: record.stride, ptrOff: palOff, compressed } : null,
    shiny: palOff >= 0 ? { at: record.at - record.stride, stride: record.stride, ptrOff: palOff + 4, compressed } : null,
    count: speciesCount,
  };
}

function readPalette(rom: Uint8Array, t: NonNullable<SpriteTables["palette"]>, species: number): Uint16Array | null {
  const p = ptr(rom, t.at + species * t.stride + t.ptrOff);
  if (p === null) return null;
  const raw = t.compressed ? lz77(rom, p, 0x20) : rom.subarray(p, p + 32);
  if (!raw || raw.length < 32) return null;
  const pal = new Uint16Array(16);
  for (let i = 0; i < 16; i++) pal[i] = raw[i * 2] | (raw[i * 2 + 1] << 8);
  return pal;
}

/** Decodes a 64×64 front sprite. Colour 0 is transparent. Returns null when it can't be read. */
export function decodeSprite(rom: Uint8Array, t: SpriteTables, species: number, shiny = false): Sprite | null {
  if (species <= 0 || species >= t.count) return null;
  const p = ptr(rom, t.front.at + species * t.front.stride + t.front.ptrOff);
  if (p === null) return null;
  const tiles = lz77(rom, p, 0x2000);
  if (!tiles || tiles.length < 0x800) return null;
  const palT = (shiny && t.shiny) || t.palette;
  const pal = palT ? readPalette(rom, palT, species) : null;
  const W = 64, H = 64, rgba = new Uint8ClampedArray(W * H * 4);
  for (let tile = 0; tile < 64; tile++) {
    const tx = (tile % 8) * 8, ty = Math.floor(tile / 8) * 8;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const byte = tiles[tile * 32 + y * 4 + (x >> 1)];
      const ci = x & 1 ? byte >> 4 : byte & 0xf;
      if (ci === 0) continue;
      const o = ((ty + y) * W + tx + x) * 4;
      if (pal) {
        const c = pal[ci];
        rgba[o] = ((c & 31) * 255 / 31) | 0; rgba[o + 1] = (((c >> 5) & 31) * 255 / 31) | 0; rgba[o + 2] = (((c >> 10) & 31) * 255 / 31) | 0;
      } else { const g = 255 - ci * 15; rgba[o] = g; rgba[o + 1] = g; rgba[o + 2] = g; }
      rgba[o + 3] = 255;
    }
  }
  return { width: W, height: H, rgba };
}
