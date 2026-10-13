import { describe, it, expect, beforeEach } from "vitest";
import {
  sectorChecksum, w32, w16, u16, decodeText, encodeText, encodeBytes, unencodable, getProfile, PROFILES,
  detect, parse, write, verify, decodePokemon, encodePokemon, levelOf, setLevel, calcStats,
  isShiny, rerollPid, nature, gender, expForLevel, VANILLA, setData, data, nationalFallback, fallbackDataFor,
  setShiny, abilityId, crc32, zipStore, loadRomData, readRomHeader,
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
      expect(report.some(r => /not found/.test(r))).toBe(false);
      setData(d);
      const m = makeMon(1, 12, { abilityNum: 2 });
      expect(abilityId(m)).toBe(34);
      expect(levelOf(m)).toBe(12);
      expect(data().source).toBe("rom");
    });
  }
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
