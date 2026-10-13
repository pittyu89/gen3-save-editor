// Gen III (English/Western) text codec. 0xFF terminates a string.
import { CHARMAP } from "./data";

const DECODE = new Map<number, string>();
const ENCODE = new Map<string, number>();
for (const [k, v] of Object.entries(CHARMAP)) {
  const b = Number(k);
  DECODE.set(b, v);
  if (!ENCODE.has(v)) ENCODE.set(v, b);
}
ENCODE.set("'", 0xb4);
DECODE.set(0xb4, "'"); // show the apostrophe as typed

export const EOS = 0xff;

export function decodeText(b: Uint8Array, offset: number, maxLen: number): string {
  let s = "";
  for (let i = 0; i < maxLen; i++) {
    const c = b[offset + i];
    if (c === EOS) break;
    s += DECODE.get(c) ?? "�";
  }
  return s;
}

/** Characters in `s` that the game cannot display. */
export function unencodable(s: string): string[] {
  return [...new Set([...s].filter(ch => !ENCODE.has(ch)))];
}

/** Writes `s` into a fixed field, terminated and padded with 0xFF. */
export function encodeText(s: string, b: Uint8Array, offset: number, fieldLen: number): void {
  const chars = [...s].slice(0, fieldLen);
  for (let i = 0; i < fieldLen; i++) {
    b[offset + i] = i < chars.length ? (ENCODE.get(chars[i]) ?? 0xac /* '?' */) : EOS;
  }
}

/** Encodes `s` followed by the terminator, or null if a character has no game encoding. */
export function encodeBytes(s: string): Uint8Array | null {
  const chars = [...s];
  const out = new Uint8Array(chars.length + 1);
  for (let i = 0; i < chars.length; i++) {
    const b = ENCODE.get(chars[i]);
    if (b === undefined) return null;
    out[i] = b;
  }
  out[chars.length] = EOS;
  return out;
}

/** Strict decode: null unless every byte before the terminator is a known character. */
export function decodeStrict(b: Uint8Array, offset: number, maxLen: number): string | null {
  let s = "";
  for (let i = 0; i < maxLen; i++) {
    const p = offset + i;
    if (p >= b.length) return null;
    const c = b[p];
    if (c === EOS) return s;
    const ch = DECODE.get(c);
    if (ch === undefined) return null;
    s += ch;
  }
  return null;
}
