// Little-endian helpers over Uint8Array. No DOM dependencies.

export const u8 = (b: Uint8Array, o: number) => b[o];
export const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
export const u32 = (b: Uint8Array, o: number) =>
  (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

export function w8(b: Uint8Array, o: number, v: number) { b[o] = v & 0xff; }
export function w16(b: Uint8Array, o: number, v: number) {
  b[o] = v & 0xff; b[o + 1] = (v >>> 8) & 0xff;
}
export function w32(b: Uint8Array, o: number, v: number) {
  b[o] = v & 0xff; b[o + 1] = (v >>> 8) & 0xff;
  b[o + 2] = (v >>> 16) & 0xff; b[o + 3] = (v >>> 24) & 0xff;
}

/** Gen III sector checksum: sum of u32 words, then fold high and low halves. */
export function sectorChecksum(b: Uint8Array, start: number, length: number): number {
  let sum = 0;
  for (let i = 0; i < length; i += 4) sum = (sum + u32(b, start + i)) >>> 0;
  return ((sum >>> 16) + (sum & 0xffff)) & 0xffff;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ROM-wide word scans run many times while tables are located; a cached 32-bit view makes them cheap.
const WORDS = new WeakMap<Uint8Array, Uint32Array>();
/** The ROM as aligned little-endian u32 words (cached per array). */
export function romWords(rom: Uint8Array): Uint32Array {
  let w = WORDS.get(rom);
  if (!w) {
    const n = rom.length >> 2;
    w = rom.byteOffset % 4 === 0 ? new Uint32Array(rom.buffer, rom.byteOffset, n) : new Uint32Array(rom.slice(0, n * 4).buffer);
    // typed arrays use the platform's byte order; GBA data is little-endian, as are all supported browsers
    WORDS.set(rom, w);
  }
  return w;
}
const HALVES = new WeakMap<Uint8Array, Uint16Array>();
/** The ROM as aligned little-endian u16 halfwords (cached per array). */
export function romHalves(rom: Uint8Array): Uint16Array {
  let h = HALVES.get(rom);
  if (!h) {
    const n = rom.length >> 1;
    h = rom.byteOffset % 2 === 0 ? new Uint16Array(rom.buffer, rom.byteOffset, n) : new Uint16Array(rom.slice(0, n * 2).buffer);
    HALVES.set(rom, h);
  }
  return h;
}

const POINTERS = new WeakMap<Uint8Array, Uint32Array>();
/** Every aligned word in the ROM that looks like a ROM pointer, sorted (cached). */
export function romPointers(rom: Uint8Array): Uint32Array {
  let idx = POINTERS.get(rom);
  if (!idx) {
    const w = romWords(rom);
    let n = 0;
    for (let i = 0; i < w.length; i++) if (w[i] >= 0x08000000 && w[i] < 0x0a000000) n++;
    idx = new Uint32Array(n);
    for (let i = 0, k = 0; i < w.length; i++) if (w[i] >= 0x08000000 && w[i] < 0x0a000000) idx[k++] = w[i];
    idx.sort();
    POINTERS.set(rom, idx);
  }
  return idx;
}
/** How many aligned words in the ROM equal `v`. ROM pointers (0x08…–0x09…) are answered from a sorted index. */
export function countWord(rom: Uint8Array, v: number): number {
  const x = v >>> 0;
  if (x < 0x08000000 || x >= 0x0a000000) {
    const w = romWords(rom);
    let n = 0;
    for (let i = 0; i < w.length; i++) if (w[i] === x) n++;
    return n;
  }
  const idx = romPointers(rom);
  const lower = (t: number) => { let lo = 0, hi = idx!.length; while (lo < hi) { const m = (lo + hi) >>> 1; if (idx![m] < t) lo = m + 1; else hi = m; } return lo; };
  return lower(x + 1) - lower(x);
}
