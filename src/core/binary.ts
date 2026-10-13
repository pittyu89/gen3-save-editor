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
