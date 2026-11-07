// Reads Pokémon front sprites from the user's own ROM, the way an emulator would display them.
// Nothing is bundled with the editor: without a ROM there are no sprites.
//
// Vanilla Gen III and CFRU keep three tables of 8-byte entries indexed by species:
//   gMonFrontPicTable    { const u32 *lz77Tiles; u16 size = 0x800; u16 tag = species }
//   gMonPaletteTable     { const u32 *lz77Palette; u16 tag = species; u16 pad }
//   gMonShinyPaletteTable{ const u32 *lz77Palette; u16 tag = species + 500; u16 pad }
// pokeemerald-expansion stores sprite pointers inside each SpeciesInfo record instead; older
// releases use LZ77 like vanilla, newer ones (and Pokémon Monomyth) its "smol" compressor (see smol()).
import { u16, u32, countWord } from "./binary";

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

// ---- smol (pokeemerald-expansion src/decompress.c, SmolDecompressData) ----
// 8-byte header: u32 mode:4 imageSize:14 (×4 bytes) symSize:14; u32 initialState:6 bitstreamSize:13 loSize:13.
// The image is rebuilt from two vectors: "lo" bytes (length/offset instructions) and u16 symbols. Either may be
// entropy coded with tANS over 4-bit nibbles: 64 states, 16 symbol frequencies packed into three u32s, and one
// LSB-first bitstream shared by both vectors. Symbols can also be delta coded (running nibble sum mod 16).
const SMOL_MODES = new Set([1, 2, 3, 4, 5, 6]);

/** Builds the 64-entry decode table: [symbol, bits to read, next-state base] per state. */
function tansTable(rom: Uint8Array, at: number): Int32Array | null {
  const freqs = new Array<number>(16).fill(0);
  for (let i = 0; i < 3; i++) {
    const w = u32(rom, at + i * 4);
    for (let j = 0; j < 5; j++) freqs[i * 5 + j] = (w >>> (6 * j)) & 63;
    freqs[15] += ((w & 0xc0000000) >>> 0) >>> (30 - 2 * i);
  }
  if (freqs.reduce((a, b) => a + b, 0) !== 64) return null;
  const t = new Int32Array(64 * 3);
  let n = 0;
  freqs.forEach((f, sym) => {
    for (let x = f; x < 2 * f; x++) {
      const k = 6 - (31 - Math.clz32(x));
      t[n * 3] = sym; t[n * 3 + 1] = k; t[n * 3 + 2] = (x << k) - 64; n++;
    }
  });
  return t;
}

/** Decompresses smol data at `at`, or returns null if it isn't valid smol. */
export function smol(rom: Uint8Array, at: number, maxOut = 0x4000): Uint8Array | null {
  if (at < 0 || at + 8 > rom.length) return null;
  const w0 = u32(rom, at), w1 = u32(rom, at + 4);
  const mode = w0 & 15, size = ((w0 >>> 4) & 0x3fff) * 4, symSize = (w0 >>> 18) & 0x3fff;
  let state = w1 & 63;
  const bitWords = (w1 >>> 6) & 0x1fff, loSize = (w1 >>> 19) & 0x1fff;
  if (!SMOL_MODES.has(mode) || !size || size > maxOut || !loSize || !symSize) return null;
  const loCoded = mode === 4 || mode === 5 || mode === 6, symCoded = mode !== 1 && mode !== 4, delta = mode === 3 || mode === 6;
  const d = at + 8;
  let lo: Uint8Array, sym: Uint16Array;
  if (mode === 1) {
    if (d + symSize * 2 + loSize > rom.length) return null;
    sym = new Uint16Array(symSize); for (let i = 0; i < symSize; i++) sym[i] = u16(rom, d + i * 2);
    lo = rom.subarray(d + symSize * 2, d + symSize * 2 + loSize);
  } else {
    const loT = loCoded ? tansTable(rom, d) : null;
    const symT = symCoded ? tansTable(rom, d + (loCoded ? 12 : 0)) : null;
    if ((loCoded && !loT) || (symCoded && !symT)) return null;
    const bs = d + (loCoded ? 12 : 0) + (symCoded ? 12 : 0);
    const bsEnd = bs + bitWords * 4;
    if (bsEnd > rom.length) return null;
    let pos = 0;
    const read = (k: number) => {
      let v = 0;
      for (let b = 0; b < k; b++, pos++) v |= ((rom[bs + (pos >> 3)] >> (pos & 7)) & 1) << b;
      return v;
    };
    const nibble = (t: Int32Array) => { const e = state * 3; const s = t[e]; state = t[e + 2] + read(t[e + 1]); return s; };
    lo = new Uint8Array(loSize);
    if (loT) for (let i = 0; i < loSize; i++) { const a = nibble(loT); lo[i] = a | (nibble(loT) << 4); }
    sym = new Uint16Array(symSize);
    if (symT) {
      let cur = 0;
      for (let i = 0; i < symSize; i++) {
        let v = 0;
        for (let n = 0; n < 4; n++) { let x = nibble(symT); if (delta) x = cur = (cur + x) & 15; v |= x << (n * 4); }
        sym[i] = v;
      }
    }
    // the state update after the last nibble may read a few bits past the stream; they are never used
    if (pos > bitWords * 32 + 32) return null;
    // vectors that aren't entropy coded follow the bitstream: symbols (u16), then lo bytes
    let left = bsEnd;
    if (!symT) { if (left + symSize * 2 > rom.length) return null; for (let i = 0; i < symSize; i++) sym[i] = u16(rom, left + i * 2); left += symSize * 2; }
    if (!loT) { if (left + loSize > rom.length) return null; lo = rom.subarray(left, left + loSize); }
  }
  // instructions: length/offset pairs, 7 bits per byte with a continue bit
  const out = new Uint16Array(size / 2 + 1);
  let o = 0, li = 0, si = 0;
  while (li < loSize) {
    let len: number, off: number;
    if (lo[li] & 0x80) {
      len = (lo[li] & 0x7f) | (lo[li + 1] << 7); off = lo[li + 2] & 0x7f;
      if (lo[li + 2] & 0x80) { off |= lo[li + 3] << 7; li += 4; } else li += 3;
    } else {
      len = lo[li] & 0x7f; off = lo[li + 1] & 0x7f;
      if (lo[li + 1] & 0x80) { off |= lo[li + 2] << 7; li += 3; } else li += 2;
    }
    if (len) {
      if (si >= symSize || o + 1 + len > out.length || (off !== 1 && off > o + 1)) return null;
      const v = sym[si++]; out[o++] = v;
      if (off === 1) for (let k = 0; k < len; k++) out[o++] = v;
      else for (let k = 0; k < len; k++, o++) out[o] = out[o - off];
    } else {
      if (si + off > symSize || o + off > out.length) return null;
      for (let k = 0; k < off; k++) out[o++] = sym[si++];
    }
  }
  if (o * 2 < size) return null;
  return new Uint8Array(out.buffer, 0, size).slice();
}

/** Size of the image smol data at `at` unpacks to, or 0 if it isn't smol. */
export function smolSize(rom: Uint8Array, at: number | null): number {
  if (at === null || at + 8 > rom.length || at & 3) return 0;
  const w0 = u32(rom, at), w1 = u32(rom, at + 4);
  if (!SMOL_MODES.has(w0 & 15) || !((w1 >>> 19) & 0x1fff) || !((w0 >>> 18) & 0x3fff)) return 0;
  return ((w0 >>> 4) & 0x3fff) * 4;
}

/** LZ77 or smol, whichever `at` holds. */
export function decompressPic(rom: Uint8Array, at: number, maxOut = 0x4000): Uint8Array | null {
  return rom[at] === 0x10 ? lz77(rom, at, maxOut) : smol(rom, at, maxOut);
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
/** LZ77 data of exactly `size` bytes, or smol data of at least `size` (animated front pics hold two frames). */
const isPic = (rom: Uint8Array, at: number | null, size: number) => isLz(rom, at, size) || smolSize(rom, at) >= size;

/** Finds 8-byte-entry tables whose species tags run 1, 2, 3 ... with picture data of `size` bytes. */
function findTagTables(rom: Uint8Array, tagOff: number, tagBase: number, size: number, extra?: (a: number) => boolean, first = false) {
  const out: number[] = [];
  for (let a = 0; a + 64 <= rom.length; a += 4) {
    if (u16(rom, a + tagOff) !== tagBase + 1) continue;
    if (u16(rom, a + 8 + tagOff) !== tagBase + 2 || u16(rom, a + 16 + tagOff) !== tagBase + 3) continue;
    if (extra && !extra(a)) continue;
    if (!isPic(rom, ptr(rom, a), size) || !isPic(rom, ptr(rom, a + 8), size) || !isPic(rom, ptr(rom, a + 16), size)) continue;
    out.push(a - 8); // entry for species 0
    if (first) break;
  }
  return out;
}
const findTagTable = (rom: Uint8Array, tagOff: number, tagBase: number, size: number, extra?: (a: number) => boolean) =>
  findTagTables(rom, tagOff, tagBase, size, extra, true)[0] ?? -1;

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
  // A real species table tags (nearly) every entry with its own index; a short run of matching tags
  // is some other picture table (e.g. trainer pics).
  const tagged = (at: number) => {
    const n = Math.min(speciesCount - 1, 400);
    let ok = 0;
    for (let sp = 1; sp <= n; sp++) if (u16(rom, at + sp * 8 + 6) === sp) ok++;
    return n <= 0 || ok >= n * 0.9;
  };
  // Front and back pic tables look alike. Vanilla's front table comes first; smol builds keep two
  // animation frames in front pics, so the table whose pictures are larger is the front one.
  const cands = findTagTables(rom, 6, 0, 0x800, a => u16(rom, a + 4) === 0x800).filter(tagged);
  const frames = (t: number) => [1, 2, 3, 4, 5].reduce((n, sp) => n + Math.max(smolSize(rom, ptr(rom, t + sp * 8)), 0x800), 0);
  const front = cands.length ? cands.reduce((a, b) => (frames(b) > frames(a) ? b : a)) : -1;
  if (front >= 0) {
    const pal = findTagTable(rom, 4, 0, 0x20);
    // Shiny palettes use tag = species + SPECIES_SHINY_TAG; find the offset rather than assume it.
    let shiny = -1;
    for (let a = 0; a + 64 <= rom.length && shiny < 0; a += 4) {
      const x = u16(rom, a + 4);
      if (x < 100 || u16(rom, a + 12) !== x + 1 || u16(rom, a + 20) !== x + 2 || u16(rom, a - 4) !== x - 1 || u16(rom, a - 12) === x - 2) continue; // start of a run, not the middle of the normal table
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
    if (sample.every(s => isPic(rom, ptr(rom, rec(s) + k), 0x800))) { frontOff = k; break; }
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
  const tiles = decompressPic(rom, p, 0x4000);
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

// ---- Item icons ----
// Vanilla and CFRU keep gItemIconTable: per item { const u32 *lz77Tiles (24×24, 0x120 bytes); const u32 *lz77Palette }.
// pokeemerald-expansion keeps the same two pointers inside each item record instead. Either way the
// pairs repeat at a fixed stride, starting with item 0 (the "?" icon).

export interface ItemIconTable { at: number; stride: number; count: number }

const isIconPair = (rom: Uint8Array, a: number) => isLz(rom, ptr(rom, a), 0x120) && isLz(rom, ptr(rom, a + 4), 0x20);

/** Finds the item icon table. `itemCount` is the number of items the editor knows. */
export function findItemIcons(rom: Uint8Array, itemCount: number): ItemIconTable | null {
  const runs: ItemIconTable[] = [];
  for (const stride of [8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 60, 64]) {
    for (let a = 0; a + stride * 4 <= rom.length; a += 4) {
      if (!isIconPair(rom, a) || !isIconPair(rom, a + stride) || !isIconPair(rom, a + 2 * stride)) continue;
      // walk the run, tolerating a few entries without icons
      let n = 0, misses = 0, last = 0;
      for (let i = 0; a + i * stride + 8 <= rom.length && i < 4000; i++) {
        if (isIconPair(rom, a + i * stride)) { last = i; misses = 0; } else if (++misses > 4) break;
        n = last + 1;
      }
      if (n >= Math.min(100, itemCount * 0.5)) runs.push({ at: a, stride, count: n });
      a += Math.max(0, (n - 1) * stride) - 4 + 4;
    }
    if (runs.length) break;
  }
  if (!runs.length) return null;
  // the live table is the one the code points at; old copies after a repoint are unreferenced
  let best = runs[0], bestRefs = -1;
  for (const r of runs) {
    const v = 0x08000000 + r.at;
    let refs = 0;
    refs += countWord(rom, v);
    if (refs > bestRefs || (refs === bestRefs && r.count > best.count)) { best = r; bestRefs = refs; }
  }
  return best;
}

/** Decodes a 24×24 item icon. Colour 0 is transparent. */
export function decodeItemIcon(rom: Uint8Array, t: ItemIconTable, item: number): Sprite | null {
  if (item < 0 || item >= t.count) return null;
  const pTiles = ptr(rom, t.at + item * t.stride), pPal = ptr(rom, t.at + item * t.stride + 4);
  if (pTiles === null || pPal === null) return null;
  const tiles = lz77(rom, pTiles, 0x400), palRaw = lz77(rom, pPal, 0x20);
  if (!tiles || tiles.length < 0x120 || !palRaw) return null;
  const W = 24, rgba = new Uint8ClampedArray(W * W * 4);
  for (let tile = 0; tile < 9; tile++) {
    const tx = (tile % 3) * 8, ty = Math.floor(tile / 3) * 8;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const byte = tiles[tile * 32 + y * 4 + (x >> 1)];
      const ci = x & 1 ? byte >> 4 : byte & 0xf;
      if (ci === 0) continue;
      const c = palRaw[ci * 2] | (palRaw[ci * 2 + 1] << 8), o = ((ty + y) * W + tx + x) * 4;
      rgba[o] = ((c & 31) * 255 / 31) | 0; rgba[o + 1] = (((c >> 5) & 31) * 255 / 31) | 0; rgba[o + 2] = (((c >> 10) & 31) * 255 / 31) | 0; rgba[o + 3] = 255;
    }
  }
  return { width: W, height: W, rgba };
}
