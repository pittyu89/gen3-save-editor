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
    expect(PROFILES.map(p => p.id)).toEqual(["ruby-us", "sapphire-us", "emerald-us", "firered-us", "leafgreen-us", "pex-modern", "pex-legacy", "cfru", "monomyth", "compact"]);
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
      expect(report.some(r => /not found/.test(r) && !/moves|TM|learnsets|evolutions/.test(r))).toBe(false);
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
  // per-species tutor bits: a spread that sets every bit somewhere
  const tutorBit = (s: number, i: number) => ((s * 31 + i * 17) % 7) < 3 || i === s % 40;
  const writeTutors = (r: Uint8Array, list: number, moves: number[], table: number, stride: number, bits: number) => {
    moves.forEach((m, i) => w16(r, list + i * 2, m));
    for (let s = 1; s < N; s++) for (let i = 0; i < bits; i++) if (tutorBit(s, i)) r[table + s * stride + (i >> 3)] |= 1 << (i & 7);
  };
  const expectTutors = (L: ReturnType<typeof findLearnsets>, moves: number[], bits: number) => {
    expect(L.tutor).not.toBeNull();
    for (const s of [1, 7, 23]) expect(L.tutor![s]).toEqual(moves.slice(0, bits).filter((m, i) => m && tutorBit(s, i)));
  };

  it("reads Emerald-style move tutors (u16 list, then a u32 per species)", () => {
    const r = rom();
    const moves = Array.from({ length: 30 }, (_, i) => 5 + i * 7);
    const list = 0x20000, table = list + 60;
    writeTutors(r, list, moves, table, 4, 30);
    w32(r, 0x8000, P(list)); w32(r, 0x8004, P(table));
    expectTutors(findLearnsets(r, N, MOVES, "BPEE", null), moves, 30);
  });

  it("reads Monomyth-style move tutors (40, a u64 per species, an empty slot)", () => {
    const r = rom();
    const moves = Array.from({ length: 40 }, (_, i) => (i === 3 ? 0 : 50 + i * 5));
    const list = 0x20000, table = list + 80;
    writeTutors(r, list, moves, table, 8, 40);
    w32(r, 0x8000, P(list)); w32(r, 0x8004, P(table));
    const L = findLearnsets(r, N, MOVES, "BPEE", null);
    expectTutors(L, moves, 40);
    expect(L.report).toContain("tutor moves (39)");
  });

  it("reads FireRed and CFRU move tutors from the code's literals", () => {
    // FireRed: 18 moves (the last 3 are starter-only), a u16 per species with 15 bits
    const fr = new Uint8Array(0x130000);
    const frMoves = Array.from({ length: 18 }, (_, i) => 5 + i * 9);
    writeTutors(fr, 0x125000, frMoves, 0x126000, 2, 15);
    w32(fr, 0x120be4, P(0x125000)); w32(fr, 0x120c30, P(0x126000));
    expectTutors(findLearnsets(fr, N, MOVES, "BPRE", null), frMoves, 15);
    // CFRU: 146 tutors repointed elsewhere, u32[5] per species
    const cf = new Uint8Array(0x130000);
    const cfMoves = Array.from({ length: 146 }, (_, i) => 1 + i);
    writeTutors(cf, 0x125000, cfMoves, 0x127000, 20, 146);
    w32(cf, 0x120be4, P(0x125000)); w32(cf, 0x120c30, P(0x127000));
    expectTutors(findLearnsets(cf, N, MOVES, "BPRE", null), cfMoves, 146);
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

import { createPokemon } from "../src/core";

describe("adding Pokémon", () => {
  it("creates a valid Pokémon that survives a write", () => {
    const s = parse(buildSave({ profile: E, party: [makeMon(25, 10)] }), E);
    const m = createPokemon(150, 50, E, s.trainer, false);
    expect(levelOf(m)).toBe(50);
    expect(m.otName).toBe(s.trainer.name);
    s.boxes[2].slots[7] = m;
    const p = createPokemon(4, 12, E, s.trainer, true);
    s.party.push(p);
    const r = parse(write(s), E);
    expect(r.boxes[2].slots[7]?.species).toBe(150);
    expect(r.boxes[2].slots[7]?.checksumOk).toBe(true);
    expect(r.party[1].species).toBe(4);
    expect(r.party[1].party!.level).toBe(12);
  });
});

describe("hacks without Pokémon encryption", () => {
  it("reads and writes back records stored plain", () => {
    const bytes = buildSave({ profile: E, party: [makeMon(25, 10)], boxMons: [{ box: 0, slot: 0, mon: makeMon(4, 20) }] });
    const s = parse(bytes, E);
    // rewrite the box record with encryption off (shuffle kept)
    const m = s.boxes[0].slots[0]!; m.cipher = "plain"; m.dirty = true;
    const r = parse(write(s), E);
    expect(r.boxes[0].slots[0]!.checksumOk).toBe(true);
    expect(r.boxes[0].slots[0]!.cipher).toBe("plain");
    expect(r.boxes[0].slots[0]!.species).toBe(4);
    r.boxes[0].slots[0]!.nickname = "CHAR"; r.boxes[0].slots[0]!.dirty = true;
    const r2 = parse(write(r), E);
    expect(r2.boxes[0].slots[0]!.nickname).toBe("CHAR");
    expect(r2.boxes[0].slots[0]!.cipher).toBe("plain");
    expect(r2.party[0].cipher).toBe("vanilla");
  });
});

describe("compact unencrypted records (Emerald Z style)", () => {
  it("round-trips party and PC Pokémon", () => {
    const P = getProfile("compact");
    const bytes = buildSave({ profile: P, money: 4321, party: [makeMon(25, 30, { moves: [85, 98, 0, 0], pp: [15, 30, 0, 0], heldItem: 7 })],
      boxMons: [{ box: 0, slot: 0, mon: makeMon(150, 70) }, { box: 17, slot: 29, mon: makeMon(4, 12) }] });
    const s = parse(bytes, P);
    expect(s.chunk).toBe(0xff4);
    expect(s.trainer.money).toBe(4321);
    expect(s.party[0].species).toBe(25);
    expect(levelOf(s.party[0])).toBe(30);
    expect(s.party[0].moves).toEqual([85, 98, 0, 0]);
    expect(s.party[0].pp).toEqual([15, 30, 0, 0]);
    expect(s.party[0].heldItem).toBe(7);
    expect(s.boxes[0].slots[0]?.species).toBe(150);
    expect(s.boxes[17].slots[29]?.species).toBe(4);
    expect(s.boxes[17].name).toBe("BOX18");
    expect(write(s)).toEqual(bytes);
    s.boxes[0].slots[0]!.nickname = "MEWTWOOO"; s.boxes[0].slots[0]!.dirty = true;
    const r = parse(write(s), P);
    expect(r.boxes[0].slots[0]!.nickname).toBe("MEWTWOOO");
    expect(verify(write(s), s.slot.index, P)).toEqual([]);
  });
});

import { zeroRunEncode, zeroRunDecode, packedLength, monomythKey, natureOfPid, codecInfo, standardExp, abilityName } from "../src/core";
import { fakeRegionalRom, REGIONAL_REAL, REGIONAL_CURVES } from "./rom-fixture";

describe("Pokémon Monomyth", () => {
  const MM = getProfile("monomyth");

  it("packs sectors the way the game does", () => {
    // an all-zero section is one zero run: header (4 bytes, no literal start) then 0x7C0 words
    expect([...zeroRunEncode(new Uint8Array(0xf80))]).toEqual([0x04, 0x00, 0xc0, 0x07]);
    const d = new Uint8Array(0xf80);
    d.set([1, 2, 3, 4, 0, 0, 5, 0], 0); d[0xf7e] = 9;
    const p = zeroRunEncode(d);
    expect(u16(p, 0)).toBe(0x8000 | p.length);
    // literal 2 words, zero 1, literal 1 (0x0005), zero up to the last word, literal 1
    expect([...p.subarray(2, 10)]).toEqual([2, 0, 1, 2, 3, 4, 1, 0]);
    const sector = new Uint8Array(0x1000).fill(0xff);
    sector.set(p); w32(sector, 0xff0, 1);
    expect(packedLength(sector, 0)).toBe(p.length);
    expect(zeroRunDecode(sector, 0, 0xf80)).toEqual(d);
  });

  it("uses the game's record key and nature hash", () => {
    // reference values from an independent model of DecryptBoxMon / GetNature in the v1.1 ROM
    expect(monomythKey(0x12345678, 0x9abcdef0)).toBe(0x1fff485d);
    expect(monomythKey(0, 0)).toBe(0x80002d34);
    expect(monomythKey(0xdeadbeef, 0xcafef00d)).toBe(0xd7c3fc1c);
    expect(natureOfPid(0x12345678, "monomyth")).toBe(4);
    expect(natureOfPid(0xffffffff, "monomyth")).toBe(21);
    expect(natureOfPid(0xffffffff, "vanilla")).toBe(0xffffffff % 25);
  });

  it("detects, reads and round-trips a compressed save", () => {
    const bytes = buildSave({ profile: MM, money: 4321, key: 0x1234f833,
      party: [makeMon(25, 30, { codec: "monomyth", moves: [85, 98, 0, 0], pp: [15, 30, 0, 0], ball: 18, abilityNum: 1 })],
      boxMons: [{ box: 0, slot: 0, mon: makeMon(150, 70, { codec: "monomyth" }) }, { box: 13, slot: 29, mon: makeMon(4, 12, { codec: "monomyth" }) }] });
    // every sector is packed and flagged
    for (let sec = 0; sec < 28; sec++) expect(u32At(bytes, sec * SECTOR_SIZE + 0xff0)).toBe(1);
    const det = detect(bytes);
    expect(det.suggestedProfile).toBe("monomyth");
    expect(det.messages).toEqual([]);
    const s = parse(bytes, MM);
    expect(s.warnings).toEqual([]);
    expect(s.trainer.money).toBe(4321);
    expect(s.party[0].species).toBe(25);
    expect(s.party[0].cipher).toBe("monomyth");
    expect(s.party[0].checksumOk).toBe(true);
    expect(s.party[0].ball).toBe(18);
    expect(s.party[0].abilityNum).toBe(1);
    expect(s.boxes[0].slots[0]?.species).toBe(150);
    expect(s.boxes[13].slots[29]?.species).toBe(4);
    expect(s.boxes[13].name).toBe("BOX14");
    expect(write(s)).toEqual(bytes);

    s.trainer.money = 999999;
    s.boxes[0].name = "LEGENDS";
    const mew = s.boxes[0].slots[0]!; mew.nickname = "MEWTWOOO"; mew.ivs = [31, 31, 31, 31, 31, 31]; mew.dirty = true;
    const out = write(s);
    expect(verify(out, s.slot.index, MM)).toEqual([]);
    const r = parse(out, MM);
    expect(r.warnings).toEqual([]);
    expect(r.trainer.money).toBe(999999);
    expect(r.boxes[0].name).toBe("LEGENDS");
    expect(r.boxes[0].slots[0]!.nickname).toBe("MEWTWOOO");
    expect(r.boxes[0].slots[0]!.ivs).toEqual([31, 31, 31, 31, 31, 31]);
    expect(r.boxes[0].slots[0]!.checksumOk).toBe(true);
  });

  it("gives no nature boost to stats", () => {
    const m = makeMon(25, 50, { codec: "monomyth", pid: 1 }); // pid 1 is Lonely in Gen III
    const neutral = makeMon(25, 50, { codec: "monomyth", pid: 0 });
    expect(codecInfo("monomyth").natures).toBe(false);
    expect(calcStats(m, 50)).toEqual(calcStats(neutral, 50));
    expect(calcStats(makeMon(25, 50, { pid: 1 }), 50)).not.toEqual(calcStats(makeMon(25, 50, { pid: 0 }), 50));
  });
});

const u32At = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

describe("ROMs with their own species order", () => {
  it("finds names, base stats, abilities, types and EXP curves without Bulbasaur at #1", () => {
    const rom = fakeRegionalRom();
    const { data: d, report } = loadRomData(rom);
    expect(d.species[0]).toBe("??????????");
    expect(d.species[1]).toBe("Fakemon1");
    expect(d.species[3]).toBe(VANILLA.species[4]);
    expect(d.moves[1]).toBe("Pound");
    expect(d.abilities[0]).toBe("-------");
    expect(report.some(r => /found by name/.test(r))).toBe(true);
    setData(d);
    for (const i of [3, 24, 99]) {
      const real = REGIONAL_REAL(i), want = VANILLA.info[real]!;
      const got = d.info[i]!;
      expect(got.bs).toEqual(want.bs);
      expect(got.t).toEqual(want.t);
      expect(got.g).toBe(want.g);
      expect(REGIONAL_CURVES[got.gr!]).toBe(want.gr);
      expect(abilityName(got.ab[0])).toBe(VANILLA.abilities[want.ab[0]]);
    }
    expect(d.info[1]!.t).toEqual(["Fairy"]);
    // EXP comes from the ROM's curves
    expect(d.expTable).toHaveLength(5);
    const gr = d.info[3]!.gr!;
    expect(expForLevel(gr, 100)).toBe(standardExp(REGIONAL_CURVES[gr], 100) + 1000);
    expect(expForLevel(gr, 50)).toBe(standardExp(REGIONAL_CURVES[gr], 50));
    expect(d.growthNames![gr]).toMatch(/\(modified\)$/);
  });
});

import { smol } from "../src/core";
import { REGIONAL_TMS } from "./rom-fixture";

describe("smol sprites (pokeemerald-expansion, Monomyth)", () => {
  const header = (mode: number, size: number, sym: number, state: number, words: number, lo: number) => {
    const h = new Uint8Array(8);
    w32(h, 0, (mode | ((size / 4) << 4) | (sym << 18)) >>> 0);
    w32(h, 4, (state | (words << 6) | (lo << 19)) >>> 0);
    return h;
  };
  // literal 7 symbols, then the 8th repeated to fill 0x800 bytes (0x400 halfwords)
  const LO = [0x00, 0x07, (0x3f8 & 0x7f) | 0x80, 0x3f8 >> 7, 0x01];

  it("decodes plain (BASE_ONLY) data", () => {
    const syms = [1, 2, 3, 4, 5, 6, 7, 8];
    const rom = new Uint8Array(0x100);
    rom.set(header(1, 0x800, 8, 0, 0, LO.length), 0x10);
    syms.forEach((v, i) => w16(rom, 0x18 + i * 2, v));
    rom.set(LO, 0x18 + 16);
    const out = smol(rom, 0x10)!;
    expect(out.length).toBe(0x800);
    expect(Array.from({ length: 10 }, (_, i) => u16(out, i * 2))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 8, 8]);
    expect(u16(out, 0x7fe)).toBe(8);
  });

  it("decodes tANS, delta-coded symbols", () => {
    // frequencies: symbol 1 = 63, symbol 2 = 1. From state 40 the decoder emits symbol 1 without reading
    // bits for 41 nibbles, so with delta coding the nibbles count 1, 2, 3 ... (mod 16).
    const rom = new Uint8Array(0x100);
    rom.set(header(3, 0x800, 8, 40, 0, LO.length), 0x10);
    w32(rom, 0x18, (63 << 6) | (1 << 12));
    rom.set(LO, 0x18 + 12);
    const out = smol(rom, 0x10)!;
    const want = Array.from({ length: 8 }, (_, i) => [0, 1, 2, 3].reduce((v, n) => v | (((4 * i + n + 1) & 15) << (4 * n)), 0));
    expect(Array.from({ length: 8 }, (_, i) => u16(out, i * 2))).toEqual(want);
    expect(u16(out, 0x7fe)).toBe(want[7]);
    expect(smol(rom, 0x11)).toBeNull();
  });
});

describe("TM lists with their own length", () => {
  it("reads 51 TMs plus Monomyth-style HMs and their compatibility", () => {
    const rom = fakeRegionalRom();
    const d = loadRomData(rom).data;
    expect(d.learn!.report).toContain("TM/HM moves (51 TMs)");
    expect(d.learn!.tmLabel.get(REGIONAL_TMS[0])).toBe("TM01");
    expect(d.learn!.tmLabel.get(15)).toBe("HM01");
    expect(d.learn!.tmLabel.get(300)).toBe("HM08");
    expect(d.learn!.teach[3]).toContain(REGIONAL_TMS[3 % 59]);
  });
});

import { findEvolutions, describeEvolution, evoScheme, preEvolutions, splitTeachable, Evolution } from "../src/core";

describe("Emerald Z record layout (from its GetBoxMonData)", () => {
  // builds a 64-byte PC record by hand, field by field as the game stores it
  const record = (o: { item?: number; nature?: number; egg?: boolean; ball?: number; metGame?: number; ability?: number; ht?: number; marks?: number; rus?: number }) => {
    const r = new Uint8Array(64);
    w32(r, 0, 0x12345678); w32(r, 4, (54321 << 16) | 12345);
    encodeText("Abdominion", r, 8, 12);
    w32(r, 0x14, 1 | (1000 << 11));                                  // species 1, 1000 EXP
    w32(r, 0x18, 33 | (45 << 10) | (2 << 20) | (200 << 24));            // moves, language 2, friendship 200
    w32(r, 0x1c, 73 | (22 << 10) | ((o.rus ?? 0) << 20) | (0b11 << 24)); // moves, pokérus, PP bonuses
    w16(r, 0x2c, (o.item ?? 0) | ((o.nature ?? 26) << 10) | ((o.egg ? 1 : 0) << 15));
    w16(r, 0x2e, 5 | ((o.metGame ?? 3) << 7) | ((o.ball ?? 1) << 10) | (1 << 15));
    r[0x30] = 16;
    encodeText("Pittlog", r, 0x31, 7);
    w32(r, 0x38, (31 | (30 << 5) | (29 << 10) | (28 << 15) | (27 << 20) | (26 << 25) | ((o.ability ?? 0) << 30)) >>> 0);
    const htBits = [26, 27, 22, 23, 24, 25];
    let rib = (o.marks ?? 0) << 28;
    htBits.forEach((b, i) => { if ((o.ht ?? 0) & (1 << i)) rib |= 1 << b; });
    w32(r, 0x3c, rib >>> 0);
    return r;
  };

  it("reads every field where the game keeps it", () => {
    const m = decodePokemon(record({ item: 476, ball: 27, metGame: 5, ability: 2, ht: 0b100001, marks: 0b1010, rus: 3 }), 0, false, "compact-box")!;
    expect(m.species).toBe(1); expect(m.exp).toBe(1000);
    expect(m.nickname).toBe("Abdominion"); expect(m.otName).toBe("Pittlog");
    expect(m.moves).toEqual([33, 45, 73, 22]);
    expect(m.friendship).toBe(200); expect(m.language).toBe(2); expect(m.ppBonuses).toBe(3);
    expect(m.heldItem).toBe(476); expect(m.ball).toBe(27); expect(m.metGame).toBe(5); expect(m.metLevel).toBe(5);
    expect(m.otGender).toBe(1); expect(m.metLocation).toBe(16);
    expect(m.ivs).toEqual([31, 30, 29, 28, 27, 26]); expect(m.abilityNum).toBe(2);
    expect(m.hyperTrained).toBe(0b100001); expect(m.markings).toBe(0b1010); expect(m.pokerus).toBe(3);
    expect(m.isEgg).toBe(false);
    expect(nature(m)).toBe(0x12345678 % 25);                          // stored 26: nature from the PID
  });

  it("uses a stored nature over the PID's, and writes it back", () => {
    const m = decodePokemon(record({ nature: 3 }), 0, false, "compact-box")!;
    expect(nature(m)).toBe(3);
    const out = new Uint8Array(64);
    m.dirty = true; m.natureMod = (m.pid % 25) ^ 10; encodePokemon(m, out, 0, false, "compact-box");
    expect((u16(out, 0x2c) >> 10) & 31).toBe(10);
    m.natureMod = 0; encodePokemon(m, out, 0, false, "compact-box");
    expect((u16(out, 0x2c) >> 10) & 31).toBe(26);
  });

  it("round-trips every byte of a record", () => {
    const r = record({ item: 300, nature: 7, egg: true, ball: 12, metGame: 2, ability: 1, ht: 0b010110, marks: 5, rus: 9 });
    const m = decodePokemon(r, 0, false, "compact-box")!;
    expect(m.isEgg).toBe(true);
    m.dirty = true; m.raw = undefined;                                // encode from the fields alone
    const out = new Uint8Array(64); encodePokemon(m, out, 0, false, "compact-box");
    expect(out).toEqual(r);
  });

  it("counts hyper-trained stats as IV 31", () => {
    setData(VANILLA);
    const m = decodePokemon(record({}), 0, false, "compact-box")!;
    m.ivs = [0, 0, 0, 0, 0, 0];
    const plain = calcStats(m, 50)!;
    m.hyperTrained = 0b111111;
    const ht = calcStats(m, 50)!;
    m.ivs = [31, 31, 31, 31, 31, 31]; m.hyperTrained = 0;
    expect(ht).toEqual(calcStats(m, 50));
    expect(ht[0]).toBeGreaterThan(plain[0]);
  });

  it("is shiny below 16, not 8", () => {
    const m = decodePokemon(record({}), 0, false, "compact-box")!;
    const t = m.otId & 0xffff, s = m.otId >>> 16;
    const pidFor = (sv: number) => (((t ^ s ^ sv) << 16) | 0) >>> 0;   // low half 0: value = t^s^high
    m.pid = pidFor(12); expect(isShiny(m)).toBe(true);
    m.pid = pidFor(16); expect(isShiny(m)).toBe(false);
    expect(codecInfo("compact-box").shinyLimit).toBe(16);
    expect(codecInfo("vanilla").shinyLimit).toBe(8);
  });
});

describe("evolutions", () => {
  const names = VANILLA.species;
  const id = (n: string) => names.indexOf(n);
  const put = (rom: Uint8Array, at: number, e: [number, number, number]) => { w16(rom, at, e[0]); w16(rom, at + 2, e[1]); w16(rom, at + 4, e[2]); };
  const EVOS: [string, [number, number, string][]][] = [
    ["Bulbasaur", [[4, 16, "Ivysaur"]]], ["Charmander", [[4, 16, "Charmeleon"]]], ["Squirtle", [[4, 16, "Wartortle"]]],
    ["Caterpie", [[4, 7, "Metapod"]]], ["Pidgey", [[4, 18, "Pidgeotto"]]], ["Abra", [[4, 16, "Kadabra"]]],
    ["Eevee", [[7, 96, "Jolteon"], [7, 97, "Vaporeon"], [2, 0, "Espeon"]]], ["Machoke", [[5, 0, "Machamp"]]],
  ];

  it("reads a fixed table (5 entries per species, as pokeemerald)", () => {
    const rom = new Uint8Array(0x100000), base = 0x40000;
    for (const [from, list] of EVOS) list.forEach(([m, p, to], k) => put(rom, base + id(from) * 40 + k * 8, [m, p, id(to)]));
    const ev = findEvolutions(rom, names)!;
    expect(ev.levelMethod).toBe(4);
    expect(ev.list[id("Eevee")]!.map(e => e.target)).toEqual([id("Jolteon"), id("Vaporeon"), id("Espeon")]);
    expect(preEvolutions(ev.list, id("Machamp")).map(x => x.from)).toEqual([id("Machoke")]);
  });

  it("reads per-species lists through pointers (expansion 1.8+)", () => {
    const rom = new Uint8Array(0x100000), ptrs = 0x20000;
    let cursor = 0x50000;
    for (const [from, list] of EVOS) {
      w32(rom, ptrs + id(from) * 4, 0x08000000 + cursor);
      for (const [m, p, to] of list) { put(rom, cursor, [m, p, id(to)]); cursor += 8; }
      w16(rom, cursor, 0xffff); cursor += 8;
    }
    const ev = findEvolutions(rom, names)!;
    expect(ev.list[id("Bulbasaur")]).toEqual([{ method: 4, param: 16, target: id("Ivysaur"), extra: 0 }]);
    expect(ev.list[id("Eevee")]!.length).toBe(3);
  });

  it("describes methods per game", () => {
    const N = { species: (i: number) => names[i], item: (i: number) => (i === 804 ? "Scrap Metal" : `Item${i}`), move: (i: number) => `Move${i}` };
    const say = (method: number, param: number, scheme: ReturnType<typeof evoScheme>) => describeEvolution({ method, param, target: 1, extra: 0 } as Evolution, scheme, N);
    expect(say(4, 16, "emerald")).toBe("Level 16");
    expect(say(24, 18, "emerald")).toBe("Level up with high friendship knowing a Fairy-type move");
    expect(say(24, 13, "emerald")).toBe("Level up with high friendship knowing an Electric-type move");
    expect(say(29, id("Remoraid"), "emerald")).toBe("Level up with Remoraid in the party");
    expect(say(43, 29, "emerald-z")).toBe("Level 29 knowing a Fire-type move");
    expect(say(45, 804, "emerald-z")).toBe("Level up with 50 Scrap Metal in the Bag");
    expect(say(34, 0, "monomyth")).toBe("Level up during a sandstorm");
    expect(say(26, 5, "cfru")).toBe("Level up knowing Move5");
    expect(evoScheme("compact", "BPEE")).toBe("emerald-z");
    expect(evoScheme(undefined, "BPRE")).toBe("cfru");
  });
});

describe("combined teachable lists", () => {
  it("splits TMs and HMs from tutor moves using the TM items", () => {
    const L = { levelUp: [], teach: [null, [15, 92, 34, 111]], egg: [], tutor: null, tmLabel: new Map(), teachTitle: "TM, HM & tutor", report: ["teachable moves"] } as any;
    splitTeachable(L, [{ name: "TM06", move: 92 }, { name: "HM01", move: 15 }]);
    expect(L.teach[1]).toEqual([15, 92]);
    expect(L.tutor[1]).toEqual([34, 111]);
    expect(L.tmLabel.get(92)).toBe("TM06");
    expect(L.teachTitle).toBe("TM & HM");
  });
});
