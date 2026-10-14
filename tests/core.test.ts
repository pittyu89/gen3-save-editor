import { describe, it, expect, beforeEach } from "vitest";
import {
  sectorChecksum, w32, w16, u16, decodeText, encodeText, encodeBytes, unencodable, getProfile, PROFILES,
  detect, parse, write, verify, decodePokemon, encodePokemon, levelOf, setLevel, calcStats,
  isShiny, rerollPid, nature, gender, expForLevel, VANILLA, setData, data, nationalFallback, fallbackDataFor,
  setShiny, abilityId, crc32, zipStore, loadRomData, readRomHeader, findSpriteTables, decodeSprite, lz77,
  SECTOR_SIZE, BOX_SIZE, PARTY_SIZE, CFRU_BOX_SIZE, Pokemon, GameProfile,
} from "../src/core";
import { buildSave, makeMon } from "../src/core/fixtures";

const E = getProfile("emerald-us"), FR = getProfile("firered-us"), RS = getProfile("ruby-us");
const PEX = getProfile("pex-modern"), PEXL = getProfile("pex-legacy"), CFRU = getProfile("cfru");

beforeEach(() => setData(VANILLA));

describe("binary", () => {
  it("folds the u32 sum into 16 bits", () => {
    const b = new Uint8Array(8);
    w32(b, 0, 0x00010002); w32(b, 4, 0x00030004);
    expect(sectorChecksum(b, 0, 8)).toBe(0x0004 + 0x0006);
  });
});

describe("data tables", () => {
  it("maps internal Hoenn indices to National Dex numbers", () => {
    expect(VANILLA.species[277]).toBe("Treecko"); expect(VANILLA.nat[277]).toBe(252);
    expect(VANILLA.species[411]).toBe("Chimecho"); expect(VANILLA.nat[411]).toBe(358);
    expect(VANILLA.species[25]).toBe("Pikachu");
  });
  it("has 354 moves and the Gen III item list", () => {
    expect(VANILLA.moves[354]).toBe("Psycho Boost"); expect(VANILLA.moves.length).toBe(355);
    expect(VANILLA.items[1]).toBe("Master Ball"); expect(VANILLA.items[289]).toBe("TM01 Focus Punch");
  });
  it("re-indexes nationally for expansion saves", () => {
    const n = nationalFallback();
    expect(n.species[252]).toBe("Treecko"); expect(n.species[386]).toBe("Deoxys"); expect(n.shedinja).toBe(292);
  });
  it("matches known EXP values", () => {
    expect([0, 1, 2, 3, 4, 5].map(r => expForLevel(r, 100))).toEqual([1000000, 600000, 1640000, 1059860, 800000, 1250000]);
  });
});

describe("text", () => {
  it("round-trips English text with terminator and padding", () => {
    const b = new Uint8Array(10);
    encodeText("Mr. Mime'", b, 0, 10);
    expect(b[9]).toBe(0xff);
    expect(decodeText(b, 0, 10)).toBe("Mr. Mime'");
  });
  it("uses the game's table, not ASCII", () => {
    expect([...encodeBytes("A")!]).toEqual([0xbb, 0xff]);
  });
  it("flags characters the game cannot show", () => {
    expect(unencodable("Pika😀")).toEqual(["😀"]);
  });
});

describe("vanilla records", () => {
  it("round-trips through encryption for every block order", () => {
    for (let k = 0; k < 24; k++) {
      const m = makeMon(6, 36, { pid: 0x10000000 + k, heldItem: 200, moves: [53, 17, 82, 163], pp: [15, 35, 10, 20], ball: 2 });
      const b = new Uint8Array(BOX_SIZE);
      encodePokemon(m, b, 0, false);
      const d = decodePokemon(b, 0, false)!;
      expect(d.checksumOk).toBe(true);
      expect([d.species, d.heldItem, d.ball, d.metLevel]).toEqual([6, 200, 2, 36]);
      expect(d.moves).toEqual([53, 17, 82, 163]); expect(d.pp).toEqual([15, 35, 10, 20]);
      expect(d.ivs).toEqual([31, 20, 10, 5, 0, 15]);
      expect(levelOf(d)).toBe(36);
      expect(d.nickname).toBe("TESTMON");
    }
  });
  it("detects a corrupted record", () => {
    const b = new Uint8Array(BOX_SIZE);
    encodePokemon(makeMon(1, 5), b, 0, false);
    b[0x25] ^= 0x40;
    expect(decodePokemon(b, 0, false)!.checksumOk).toBe(false);
  });
  it("leaves untouched records byte-identical", () => {
    const b = new Uint8Array(BOX_SIZE);
    encodePokemon(makeMon(1, 5), b, 0, false);
    b[0x08 + 8] = 0x00; // garbage after the nickname terminator
    const d = decodePokemon(b, 0, false)!;
    const c = new Uint8Array(BOX_SIZE);
    encodePokemon(d, c, 0, false);
    expect([...c]).toEqual([...b]);
  });
  it("keeps unmodelled bits when a record is edited", () => {
    const b = new Uint8Array(BOX_SIZE);
    encodePokemon(makeMon(1, 5), b, 0, false);
    const d = decodePokemon(b, 0, false)!;
    d.secure![46] = 0x55; // ribbon bits we don't expose
    d.heldItem = 13; d.dirty = true;
    encodePokemon(d, b, 0, false);
    const r = decodePokemon(b, 0, false)!;
    expect(r.secure![46]).toBe(0x55); expect(r.heldItem).toBe(13); expect(r.checksumOk).toBe(true);
  });
  it("treats an all-zero slot as empty", () => {
    expect(decodePokemon(new Uint8Array(BOX_SIZE), 0, false)).toBeNull();
  });
  it("computes stats with the Gen III formula", () => {
    const m = makeMon(25, 50, { ivs: [31, 31, 31, 31, 31, 31], pid: 0 /* Hardy */ });
    expect(calcStats(m, 50)).toEqual([110, 75, 50, 110, 70, 60]);
  });
  it("sets level by EXP and rerolls PID for nature and shininess", () => {
    const m = makeMon(25, 5);
    setLevel(m, 77); expect(levelOf(m)).toBe(77);
    m.pid = rerollPid(m, { nature: 3, shiny: true })!;
    expect(nature(m)).toBe(3); expect(isShiny(m)).toBe(true);
    m.pid = rerollPid(m, { gender: "F", shiny: false })!;
    expect(gender(m)).toBe("F"); expect(isShiny(m)).toBe(false);
  });
});

describe("pokeemerald-expansion records", () => {
  beforeEach(() => setData(nationalFallback()));
  it("packs 11-bit species, 12-character nicknames, and preserves tera bits", () => {
    const m = makeMon(252, 30, { nickname: "ABCDEFGHIJKL", heldItem: 700, moves: [1500, 89, 0, 2047], pp: [5, 10, 0, 127], ball: 40, abilityNum: 2 });
    const b = new Uint8Array(PARTY_SIZE);
    encodePokemon(m, b, 0, false, "pex-modern");
    const d = decodePokemon(b, 0, false, "pex-modern")!;
    expect(d.checksumOk).toBe(true);
    expect([d.species, d.heldItem, d.ball, d.abilityNum]).toEqual([252, 700, 40, 2]);
    expect(d.moves).toEqual([1500, 89, 0, 2047]); expect(d.pp).toEqual([5, 10, 0, 127]);
    expect(d.nickname).toBe("ABCDEFGHIJKL");
    expect(levelOf(d)).toBe(30);
    // set tera type bits (11-15 of the species word), then edit something else
    d.secure![1] |= 0xa8; d.dirty = true; d.heldItem = 3;
    encodePokemon(d, b, 0, false, "pex-modern");
    const r = decodePokemon(b, 0, false, "pex-modern")!;
    expect(r.species).toBe(252); expect(r.secure![1] & 0xf8).toBe(0xa8); expect(r.heldItem).toBe(3);
  });
  it("uses the shiny and nature modifier bits instead of changing the PID", () => {
    const m = makeMon(25, 10);
    const pid = m.pid;
    setShiny(m, true, "pex-modern");
    expect(isShiny(m)).toBe(true); expect(m.pid).toBe(pid);
    m.natureMod = (m.pid % 25) ^ 10;
    expect(nature(m)).toBe(10);
    const b = new Uint8Array(BOX_SIZE);
    encodePokemon(m, b, 0, false, "pex-modern");
    const d = decodePokemon(b, 0, false, "pex-modern")!;
    expect(isShiny(d)).toBe(true); expect(nature(d)).toBe(10); expect(d.pid).toBe(pid);
  });
  it("reads the 1.0-1.7 layout with the ball in the Growth block", () => {
    const m = makeMon(6, 40, { ball: 26, abilityNum: 1 });
    const b = new Uint8Array(BOX_SIZE);
    encodePokemon(m, b, 0, false, "pex-legacy");
    const d = decodePokemon(b, 0, false, "pex-legacy")!;
    expect([d.ball, d.abilityNum, d.species, levelOf(d)]).toEqual([26, 1, 6, 40]);
  });
});

describe("CFRU records", () => {
  it("round-trips the 58-byte compressed PC format", () => {
    const m = makeMon(1, 20, { moves: [1023, 512, 7, 300], heldItem: 513, ball: 9, abilityNum: 2, ppBonuses: 0b11 });
    const b = new Uint8Array(CFRU_BOX_SIZE);
    encodePokemon(m, b, 0, false, "cfru-box");
    const d = decodePokemon(b, 0, false, "cfru-box")!;
    expect(d.moves).toEqual([1023, 512, 7, 300]);
    expect([d.species, d.heldItem, d.ball, d.abilityNum, levelOf(d)]).toEqual([1, 513, 9, 2, 20]);
    expect(d.ivs).toEqual(m.ivs);
    expect(d.nickname).toBe("TESTMON");
  });
  it("derives the normal ability slot from the PID", () => {
    const m = makeMon(25, 10, { pid: 0x100 });
    const b = new Uint8Array(PARTY_SIZE);
    encodePokemon(m, b, 0, false, "cfru-party");
    expect(decodePokemon(b, 0, false, "cfru-party")!.abilityNum).toBe(0);
    m.pid = 0x101; m.dirty = true; encodePokemon(m, b, 0, false, "cfru-party");
    expect(decodePokemon(b, 0, false, "cfru-party")!.abilityNum).toBe(1);
  });
});

function roundTrip(profile: GameProfile, species: { party: number[]; box: [number, number, number][] }) {
  setData(fallbackDataFor(profile));
  const bytes = buildSave({
    profile, name: "MAY", money: 123456, key: 0x5a5a1234, rotate: 5,
    party: species.party.map((s, i) => makeMon(s, 5 + i * 7, { pid: 0x0badf00d + i * 7919 })),
    boxMons: species.box.map(([box, slot, s]) => ({ box, slot, mon: makeMon(s, 30) })),
  });
  return bytes;
}

describe("save files", () => {
  const cases: [GameProfile, number[], [number, number, number][]][] = [
    [E, [280, 25], [[0, 0, 150], [13, 29, 386]]],
    [FR, [280, 25], [[0, 0, 150], [13, 29, 386]]],
    [RS, [280, 25], [[0, 0, 150], [13, 29, 386]]],
    [PEX, [255, 25], [[0, 0, 150], [13, 29, 386]]],
    [PEXL, [255, 25], [[0, 0, 150], [13, 29, 386]]],
    [CFRU, [280, 25], [[0, 0, 150], [18, 29, 1], [19, 0, 4], [21, 29, 7], [22, 0, 10], [23, 29, 16], [24, 0, 19], [24, 29, 25]]],
  ];
  for (const [profile, party, box] of cases) {
    it(`${profile.name}: parses, round-trips and edits`, () => {
      const bytes = roundTrip(profile, { party, box });
      const det = detect(bytes);
      expect(det.ok).toBe(true);
      expect(det.activeSlot).toBe(0);
      const s = parse(bytes, profile);
      expect(s.warnings.filter(w => /checksum|missing|probably/i.test(w))).toEqual([]);
      expect(s.slot.valid).toBe(true);
      expect(s.trainer.name).toBe("MAY");
      expect(s.trainer.money).toBe(123456);
      expect(s.party.map(p => p.species)).toEqual(party);
      for (const [b, sl, sp] of box) expect(s.boxes[b].slots[sl]!.species).toBe(sp);
      expect(s.boxes[3].name).toBe("BOX4");
      expect(s.boxes.length).toBe(profile.boxCount);
      expect(s.fit.score).toBeGreaterThan(0.9);

      // Unchanged export is byte-identical
      expect([...write(s)]).toEqual([...bytes]);

      // Edit money and a Pokémon, and move the first party member into the last box
      s.trainer.money = 999999;
      const pk = s.party[1];
      pk.species = 26; setLevel(pk, 40); pk.moves = [85, 87, 0, 0]; pk.dirty = true;
      const moved = s.party.splice(0, 1)[0]; moved.party = undefined; moved.dirty = true;
      const lastBox = profile.boxCount - 1;
      s.boxes[lastBox].slots[4] = moved;
      s.boxes[lastBox].name = "KEEP";
      const out = write(s);
      expect(verify(out, 0, profile)).toEqual([]);
      const r = parse(out, profile);
      expect(r.trainer.money).toBe(999999);
      expect(r.party.length).toBe(1);
      expect(r.party[0].species).toBe(26); expect(levelOf(r.party[0])).toBe(40);
      expect(r.party[0].party!.level).toBe(40);
      expect(r.party[0].moves).toEqual([85, 87, 0, 0]);
      expect(r.party[0].checksumOk).toBe(true);
      expect(r.boxes[lastBox].slots[4]!.species).toBe(party[0]);
      expect(r.boxes[lastBox].name).toBe("KEEP");
      for (const [b, sl, sp] of box) if (!(b === lastBox && sl === 4)) expect(r.boxes[b].slots[sl]!.species).toBe(sp);
      expect(r.slot.valid).toBe(true);
    });
  }

  it("ranks the engine that wrote the save first", () => {
    const pexSave = (() => {
      setData(nationalFallback());
      const mons = [252, 255, 258, 25].map((s, i) => { const m = makeMon(s, 20, { pid: 0x1000 + i * 31 }); return m; });
      const b = buildSave({ profile: PEX, party: mons });
      // give each party Pokémon a tera type, as expansion does
      const s = parse(b, PEX);
      s.party.forEach(m => { m.secure![1] |= 0x60; m.dirty = true; });
      return write(s);
    })();
    expect(detect(pexSave).suggestedProfile).toBe("pex-modern");

    setData(VANILLA);
    const eSave = buildSave({ profile: E, party: [makeMon(280, 10), makeMon(25, 10)], boxMons: [{ box: 0, slot: 0, mon: makeMon(300, 12) }] });
    expect(detect(eSave).suggestedProfile).toBe("emerald-us");

    const frSave = buildSave({ profile: FR, party: [makeMon(4, 10)], boxMons: [{ box: 0, slot: 0, mon: makeMon(1, 12) }, { box: 0, slot: 1, mon: makeMon(7, 12) }] });
    expect(detect(frSave).suggestedProfile).toBe("firered-us");

    const cfruSave = buildSave({ profile: CFRU, party: [makeMon(4, 10)], boxMons: [{ box: 0, slot: 0, mon: makeMon(1, 12) }, { box: 20, slot: 1, mon: makeMon(7, 12) }] });
    const d = detect(cfruSave);
    expect(d.suggestedProfile).toBe("cfru");
    expect(d.ranking[0].fit.score).toBeGreaterThan(d.ranking[1].fit.score);
  });

  it("warns when the selected layout reads the save badly", () => {
    const cfruSave = buildSave({ profile: CFRU, party: [makeMon(4, 10)], boxMons: [0, 1, 2, 3].map(i => ({ box: 0, slot: i, mon: makeMon(1 + i, 12) })) });
    const s = parse(cfruSave, FR);
    expect(s.fit.score).toBeLessThan(0.75);
  });

  it("picks the slot with the higher save counter", () => {
    expect(detect(buildSave({ profile: E, counterA: 3, counterB: 4 })).activeSlot).toBe(1);
  });

  it("falls back to the other slot when the newest has a bad checksum", () => {
    const bytes = buildSave({ profile: E, counterA: 3, counterB: 4 });
    bytes[(14 + 2) * SECTOR_SIZE + 10] ^= 0xff;
    const d = detect(bytes);
    expect(d.activeSlot).toBe(0);
    expect(d.slots[1].problems.some(p => /checksum/.test(p))).toBe(true);
  });

  it("rejects files that are not saves without throwing", () => {
    expect(detect(new Uint8Array(1000)).ok).toBe(false);
    expect(detect(new Uint8Array(0x20000)).ok).toBe(false);
    expect(() => parse(new Uint8Array(0x20000), E)).toThrow();
  });

  it("exposes every profile", () => {
    expect(PROFILES.map(p => p.id)).toEqual(["ruby-us", "sapphire-us", "emerald-us", "firered-us", "leafgreen-us", "pex-modern", "pex-legacy", "cfru"]);
    for (const p of PROFILES) expect(p.sectionSizes.length).toBe(14);
    expect(u16(new Uint8Array([1, 2]), 0)).toBe(0x0201);
  });
});

import { fakeRom } from "./rom-fixture";

describe("ROM reader", () => {
  for (const style of ["inline", "pointer"] as const) {
    it(`finds ${style} tables and learns field offsets`, () => {
      const rom = fakeRom(style);
      expect(readRomHeader(rom).code).toBe(style === "inline" ? "BPRE" : "BPEE");
      const { data: d, report } = loadRomData(rom);
      expect(d.species[1]).toBe("Bulbasaur"); expect(d.species[25]).toBe("Pikachu");
      expect(d.species.length).toBeGreaterThanOrEqual(412);
      expect(d.moves[1]).toBe("Pound"); expect(d.moves[354]).toBe("Psycho Boost");
      expect(d.movePP[1]).toBe(35); expect(d.movePP[2]).toBe(25); expect(d.movePP[354]).toBe(5);
      expect(d.items[1]).toBe("Master Ball"); expect(d.items[68]).toBe("Rare Candy");
      expect(d.abilities[1]).toBe("Stench"); expect(d.abilities[65]).toBe("Overgrow");
      expect(d.info[1]!.bs).toEqual([45, 49, 49, 45, 65, 65]);
      expect(d.info[1]!.gr).toBe(3); expect(d.info[129]!.gr).toBe(5);
      expect(d.info[29]!.g).toBe(254); expect(d.info[81]!.g).toBe(255);
      expect(d.info[1]!.ab).toEqual([65, 0, 34]);
      expect(d.info[1]!.t).toEqual(["Grass", "Poison"]); expect(d.info[4]!.t).toEqual(["Fire"]);
      expect(d.info[197]!.t).toEqual(["Dark"]);
      expect(report.some(r => /not found/.test(r) && !/moves|TM|learnsets/.test(r))).toBe(false);
      setData(d);
      const m = makeMon(1, 12, { abilityNum: 2 });
      expect(abilityId(m)).toBe(34);
      expect(levelOf(m)).toBe(12);
      expect(data().source).toBe("rom");
    });
  }
  for (const style of ["inline", "pointer"] as const) {
    it(`decodes front sprites from ${style === "inline" ? "vanilla/CFRU tables" : "expansion records"}`, () => {
      const rom = fakeRom(style);
      const res = loadRomData(rom);
      const t = findSpriteTables(rom, res.data.species.length, res.record ?? undefined)!;
      expect(t).not.toBeNull();
      expect(t.kind).toBe(style === "inline" ? "tables" : "records");
      const sp = decodeSprite(rom, t, 4)!;
      expect(sp.width).toBe(64);
      const mid = (36 * 64 + 32) * 4;
      expect([...sp.rgba.subarray(mid, mid + 4)]).toEqual([255, 0, 0, 255]);
      expect(sp.rgba[3]).toBe(0); // corner is transparent
      if (style === "inline") {
        const sh = decodeSprite(rom, t, 4, true)!;
        expect([...sh.rgba.subarray(mid, mid + 4)]).toEqual([0, 0, 255, 255]);
      }
      expect(decodeSprite(rom, t, 0)).toBeNull();
    });
  }
  it("decompresses GBA LZ77 with back-references", () => {
    // 'ab' literal then copy 6 bytes from distance 2 -> 'abababab'
    const data = new Uint8Array([0x10, 8, 0, 0, 0b00100000, 0x61, 0x62, (3 << 4) | 0, 1]);
    expect(String.fromCharCode(...lz77(data, 0)!)).toBe("abababab");
  });
  it("rejects files that aren't GBA ROMs", () => {
    expect(() => loadRomData(new Uint8Array(1024))).toThrow();
  });
});

describe("zip", () => {
  it("computes the standard CRC-32", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });
  it("writes a valid single-entry archive", () => {
    const z = zipStore([{ name: "a.sav", data: new Uint8Array([1, 2, 3]) }]);
    expect(z[0]).toBe(0x50); expect(z[1]).toBe(0x4b);
    expect(z.length).toBe(30 + 5 + 3 + 46 + 5 + 22);
  });
});

void (null as unknown as Pokemon);

import { scanSave, applyIssues } from "../src/core";

describe("full-sector hacks", () => {
  for (const [base, chunk] of [[E, 0xff4], [PEX, 0xff4], [FR, 0xff0]] as [GameProfile, number][]) {
    it(`${base.name} saves that use ${chunk.toString(16)} bytes per sector`, () => {
      const wide: GameProfile = { ...base, chunk, sectionSizes: base.sectionSizes.map(() => chunk) };
      // index 49 straddles the vanilla 3968-byte boundary of the first storage sector
      const bytes = buildSave({ profile: wide, party: [makeMon(25, 10)], boxMons: [{ box: 1, slot: 19, mon: makeMon(150, 50) }, { box: 13, slot: 29, mon: makeMon(386, 70) }] });
      const s = parse(bytes, base);
      expect(s.chunk).toBe(chunk);
      expect(s.slot.valid).toBe(true);
      expect(s.boxes[1].slots[19]?.species).toBe(150);
      expect(s.boxes[13].slots[29]?.species).toBe(386);
      expect(s.boxes[13].name).toBe("BOX14");
      s.boxes[1].slots[19]!.nickname = "MEWTWO"; s.boxes[1].slots[19]!.dirty = true;
      const out = write(s);
      expect(verify(out, s.slot.index, base)).toEqual([]);
      const r = parse(out, base);
      expect(r.boxes[1].slots[19]?.nickname).toBe("MEWTWO");
      expect(r.boxes[13].slots[29]?.species).toBe(386);
    });
  }
});

describe("repair", () => {
  const boxOff = (b: number, s: number) => E.boxSlot(b, s).offset;
  function damaged() {
    const bytes = buildSave({ profile: E, money: 50, party: [makeMon(25, 10), makeMon(280, 12)],
      boxMons: [0, 1, 2, 3, 4].map(i => ({ box: 0, slot: i, mon: makeMon(1 + i, 20) })) });
    const s = parse(bytes, E);
    // slot 0: only the stored checksum is wrong (data intact)
    const st = s.blocks.storage;
    w16(st, boxOff(0, 0) + 0x1c, u16(st, boxOff(0, 0) + 0x1c) ^ 0x1111);
    // slot 1: encrypted data scrambled by a cheat
    for (let k = 0x20; k < 0x50; k++) st[boxOff(0, 1) + k] ^= (k * 37) & 0xff;
    // slot 2: bad-egg flag set on good data
    st[boxOff(0, 2) + 0x13] |= 1;
    for (let i = 0; i < 3; i++) s.boxes[0].slots[i] = decodePokemon(st, boxOff(0, i), false, E.boxCodec);
    return parse(write(s), E);
  }
  it("finds and fixes Bad Eggs", () => {
    const s = damaged();
    const issues = scanSave(s).issues;
    const eggs = issues.filter(i => i.kind === "bad-egg");
    expect(eggs.map(e => e.id).sort()).toEqual(["b0-0-egg", "b0-1-egg", "b0-2-egg"]);
    expect(eggs.find(e => e.id === "b0-0-egg")!.remove).toBeFalsy();
    expect(eggs.find(e => e.id === "b0-1-egg")!.remove).toBe(true);
    expect(eggs.find(e => e.id === "b0-2-egg")!.remove).toBeFalsy();
    applyIssues(s, issues.filter(i => i.recommended));
    expect(scanSave(s).issues.filter(i => i.kind === "bad-egg")).toEqual([]);
    const r = parse(write(s), E);
    expect(r.boxes[0].slots[0]?.checksumOk).toBe(true);
    expect(r.boxes[0].slots[0]?.species).toBe(1);
    expect(r.boxes[0].slots[1]).toBeNull();
    expect(r.boxes[0].slots[2]!.flags & 1).toBe(0);
    expect(r.boxes[0].slots[3]?.species).toBe(4);
    expect(scanSave(r).issues.filter(i => i.kind === "bad-egg")).toEqual([]);
  });
  it("fixes glitch items, moves, PP, EXP and money", () => {
    setData({ ...VANILLA, source: "rom" }); // table checks need the game's own tables
    const s = parse(buildSave({ profile: E, party: [makeMon(25, 10)], boxMons: [{ box: 0, slot: 0, mon: makeMon(4, 10) }] }), E);
    const m = s.boxes[0].slots[0]!;
    m.heldItem = 500; m.moves = [33, 900, 0, 0]; m.pp = [99, 5, 0, 0]; m.exp = 9_999_999; m.dirty = true;
    s.party[0].party!.hp = 999; s.party[0].dirty = true;
    s.trainer.money = 5_000_000;
    const issues = scanSave(s).issues;
    expect(issues.map(i => i.kind).sort()).toEqual(["exp", "item", "money", "move", "stats"]);
    applyIssues(s, issues);
    const r = parse(write(s), E);
    const x = r.boxes[0].slots[0]!;
    expect(x.heldItem).toBe(0);
    expect(x.moves).toEqual([33, 0, 0, 0]);
    expect(levelOf(x)).toBe(100);
    expect(r.party[0].party!.hp).toBe(r.party[0].party!.stats[0]);
    expect(r.trainer.money).toBe(999999);
    expect(scanSave(r).issues.filter(i => i.kind === "pp")).toHaveLength(1);
  });
  it("skips table checks without ROM tables and when the ROM doesn't match", () => {
    const s = parse(buildSave({ profile: E, party: [makeMon(25, 10)], boxMons: [0, 1, 2, 3].map(i => ({ box: 0, slot: i, mon: makeMon(1 + i, 10, { heldItem: 600 }) })) }), E);
    let r = scanSave(s);
    expect(r.issues).toEqual([]);
    expect(r.notes.length).toBe(1);
    setData({ ...VANILLA, source: "rom", species: VANILLA.species.slice(0, 2) });
    r = scanSave(s);
    expect(r.issues.filter(i => i.kind !== "bad-egg")).toEqual([]);
    expect(r.notes[0]).toMatch(/isn't the one/);
  });
  it("never empties the party", () => {
    const s = parse(buildSave({ profile: E, party: [makeMon(25, 10)] }), E);
    const sb1 = s.blocks.sb1, o = E.offsets.sb1.party;
    for (let k = 0x20; k < 0x50; k++) sb1[o + k] ^= 0x5a;
    s.party[0] = decodePokemon(sb1, o, true, E.partyCodec)!;
    const r = parse(write(s), E);
    const issues = scanSave(r).issues;
    expect(issues[0].recommended).toBe(false);
    applyIssues(r, issues);
    expect(r.party).toHaveLength(1);
  });
});

import { findLearnsets } from "../src/core";

describe("learnsets", () => {
  const N = 40, MOVES = 300;
  const rom = () => { const r = new Uint8Array(0x40000); r.fill(0xff, 0x100, 0x200); return r; };
  const P = (o: number) => 0x08000000 + o;
  it("reads vanilla level-up, TM/HM and egg tables, preferring the copy the code points to", () => {
    const r = rom();
    let free = 0x10000;
    const put = (bytes: number[]) => { const at = free; r.set(bytes, at); free += (bytes.length + 3) & ~3; return at; };
    const u16s = (vals: number[]) => vals.flatMap(v => [v & 0xff, v >> 8]);
    const lists: number[] = [];
    for (let s = 0; s < N; s++) lists.push(put(u16s([(1 << 9) | 33, (5 << 9) | ((s % 200) + 1), (9 << 9) | 45, 0xffff])));
    const writeTable = (shift: number) => { const t = free; for (let s = 0; s < N; s++) w32(r, t + s * 4, P(lists[(s + shift) % N])); free += N * 4; return t; };
    writeTable(1); // stale copy left behind by a repoint
    const live = writeTable(0);
    const tmMoves = put(u16s([...Array.from({ length: 50 }, (_, i) => 100 + i), 15, 19, 57, 70, 148, 249, 127, 291]));
    const bits = free; free += N * 8;
    for (let s = 1; s < N; s++) { w32(r, bits + s * 8, (s * 2654435761) >>> 6); w32(r, bits + s * 8 + 4, (s * 7) & 0x3ffffff); }
    const egg = put(u16s([20001, 10, 11, 20003, 12, 20004, 13, 20005, 14, 20006, 15, 0xffff]));
    // "code" referencing the live tables
    [live, tmMoves, bits, egg].forEach((t, i) => w32(r, 0x8000 + i * 4, P(t)));
    const L = findLearnsets(r, N, MOVES, "BPEE", null);
    expect(L.levelUp[7]).toEqual([[1, 33], [5, 8], [9, 45]]);
    expect(L.teach[1]!.length).toBeGreaterThan(3);
    expect(L.tmLabel.get(100)).toBe("TM01");
    expect(L.tmLabel.get(15)).toBe("HM01");
    expect(L.egg[1]).toEqual([10, 11]);
    expect(L.egg[3]).toEqual([12]);
    expect(L.egg[2]).toEqual([]);
    // a hack with more moves than the name table the editor found still reads
    expect(findLearnsets(r, N, 20, "BPEE", null).levelUp[7]).toEqual([[1, 33], [5, 8], [9, 45]]);
  });
  it("reads expansion pointers from species records", () => {
    const r = rom();
    const stride = 64, at = 0x20000;
    let free = 0x30000;
    const put = (bytes: number[]) => { const a = free; r.set(bytes, a); free += (bytes.length + 3) & ~3; return a; };
    const u16s = (vals: number[]) => vals.flatMap(v => [v & 0xff, v >> 8]);
    for (let s = 1; s < N; s++) {
      const o = at + (s - 1) * stride;
      w32(r, o + 40, P(put(u16s([33, 1, 200 + (s % 50), 7, 0xffff, 0]))));
      w32(r, o + 44, P(put(u16s([60, 61, 62, 0xffff]))));
      w32(r, o + 48, P(put(u16s(s % 2 ? [70, 0xffff] : [0xffff]))));
    }
    const L = findLearnsets(r, N, MOVES, "BPEE", { at, stride });
    expect(L.levelUp[3]).toEqual([[1, 33], [7, 203]]);
    expect(L.teach[3]).toEqual([60, 61, 62]);
    expect(L.egg[3]).toEqual([70]);
    expect(L.egg[4]).toEqual([]);
  });
});
