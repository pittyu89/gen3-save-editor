import * as C from "../core";
import { h, mount, select, num, field } from "./dom";
import { openPicker, pickButton, closePicker, type PickOption } from "./picker";

type Sel = { where: "party"; i: number } | { where: "box"; box: number; i: number } | null;
type View = "trainer" | "party" | "box" | "repair";

const st = {
  save: null as C.ParsedSave | null,
  detected: null as C.DetectResult | null,
  fileName: "",
  isDemo: false,
  view: "party" as View,
  box: 0,
  sel: null as Sel,
  dirty: false,
  clip: null as C.Pokemon | null,
  armDelete: false,
  confirmExport: null as string[] | null,
  error: "",
  rom: null as { data: C.GameData; header: C.RomHeader; report: string[]; fileName: string; bytes: Uint8Array; sprites: C.SpriteTables | null; gf: C.GfHeader | null; itemIcons: C.ItemIconTable | null } | null,
  busy: "",
  sheet: false,                      // phone: editor sheet open
  moving: null as Sel,               // tap-to-move source
  edTab: "info" as "info" | "moves" | "stats" | "ot",
  teachSlot: null as number | null,
  addLevel: 5,  // move slot that "Teach" writes to; null = first empty, else the last
  fileMenu: false,                   // phone: file options expanded
  rememberRom: true,
  booting: true,
  repairPick: null as Set<string> | null, // chosen fixes; null = the recommended ones
};

const isPhone = () => matchMedia("(max-width: 900px)").matches;

const $ = (id: string) => document.getElementById(id)!;

// ---------- Data ----------

const romLabel = () => st.rom ? st.rom.fileName.replace(/\.(gba|bin)$/i, "").replace(/_/g, " ") : "";
const ROM_FAMILY: Record<string, C.Family> = { AXVE: "RS", AXPE: "RS", BPEE: "E", BPRE: "FRLG", BPGE: "FRLG" };
/** The loaded ROM's data when it belongs to the same game family as the profile; otherwise built-in data. */
function romFits(p: C.GameProfile) {
  if (!st.rom) return false;
  const fam = ROM_FAMILY[st.rom.header.code.slice(0, 3) + "E"] ?? ROM_FAMILY[st.rom.header.code];
  return !fam || fam === p.family;
}
function dataFor(p: C.GameProfile): C.GameData { return st.rom && romFits(p) ? st.rom.data : C.fallbackDataFor(p); }

const STAT_LABELS = ["HP", "Atk", "Def", "Spe", "SpA", "SpD"];   // the game's storage order
const STAT_ORDER = [0, 1, 2, 4, 5, 3];                              // shown with Speed last
const MARKS = ["●", "■", "▲", "♥"];
const WALLPAPERS = ["Forest", "City", "Desert", "Savanna", "Crag", "Volcano", "Snow", "Cave", "Beach", "Seafloor", "River", "Sky", "Polka-dot", "PokéCenter", "Machine", "Simple"];

function pad3(n: number) { return String(n).padStart(3, "0"); }
function pad5(n: number) { return String(n).padStart(5, "0"); }

/** Number shown before a species name: National Dex for vanilla data, the game's own index otherwise. */
function dexNo(s: number): string {
  const d = C.data(), p = st.save?.profile;
  if (d.source === "builtin" && d.nat[s]) return `#${pad3(d.nat[s])}`;
  if (p && (p.engine === "pex-modern" || p.engine === "pex-legacy" || p.engine === "compact") && s <= 1025) return `#${pad3(s)}`;
  return `No. ${s}`;
}
const speciesLabel = (s: number) => `${dexNo(s)} ${C.speciesName(s)}`;
const defaultName = (s: number) => C.speciesName(s).toUpperCase();

let optCache: { key: string; species: [number, string][]; items: [number, string][]; moves: [number, string][] } | null = null;
function options() {
  const d = C.data(), key = d.id + (st.save?.profile.id ?? "");
  if (optCache?.key === key) return optCache;
  const species: [number, string][] = [];
  for (let i = 1; i < d.species.length; i++) if (C.isValidSpecies(i)) species.push([i, speciesLabel(i)]);
  if (d.source === "builtin" && d.id === "gen3") species.sort((a, b) => d.nat[a[0]] - d.nat[b[0]]);
  const items: [number, string][] = d.items.map((n, i) => [i, i === 0 ? "None" : n] as [number, string]).filter(([i, n]) => i === 0 || n);
  const moves: [number, string][] = d.moves.map((_, i) => [i, C.moveName(i)] as [number, string]).filter(([i]) => i === 0 || (d.moves[i] && !/^\?+$/.test(d.moves[i])));
  optCache = { key, species, items, moves };
  return optCache;
}
const withCurrent = (opts: [number, string][], v: number, label: string): [number, string][] =>
  opts.some(o => o[0] === v) ? opts : [[v, label], ...opts];

// ---------- Selection ----------

function getSel(): C.Pokemon | null {
  const s = st.save, sel = st.sel;
  if (!s || !sel) return null;
  return sel.where === "party" ? s.party[sel.i] ?? null : s.boxes[sel.box]?.slots[sel.i] ?? null;
}
const codecAt = (sel: NonNullable<Sel>): C.CodecId => (sel.where === "party" ? st.save!.profile.partyCodec : st.save!.profile.boxCodec);

function setAt(sel: NonNullable<Sel>, m: C.Pokemon | null) {
  const s = st.save!;
  if (sel.where === "party") {
    if (m) {
      if (!m.party) C.toParty(m);
      if (sel.i < s.party.length) s.party[sel.i] = m; else s.party.push(m);
    } else s.party.splice(sel.i, 1);
  } else {
    if (m) m.party = undefined;
    s.boxes[sel.box].slots[sel.i] = m;
  }
}

function touch() { st.dirty = true; st.confirmExport = null; saveVersion++; renderAll(); }

function editMon(fn: (m: C.Pokemon) => void) {
  const m = getSel();
  if (!m) return;
  fn(m);
  m.dirty = true;
  C.refreshParty(m);
  touch();
}

// ---------- Loading ----------

const ARTIFACT_URL = "https://claude.ai/artifact/69Jw6VbYCG4vZT4cKpJ3ix";
// Only inside the Claude app (embedded frame) can file pickers be blocked; a normal browser tab is fine.
const IS_ANDROID_APP = /Android/i.test(navigator.userAgent) && (window.top !== window.self || !!(window as any).claude);

/**
 * A button whose tap lands directly on a real file input stretched over it. Some in-app
 * browsers ignore script-triggered pickers, so the input itself has to receive the tap.
 */
function fileButton(label: string, cls: string, kind: "save" | "rom", attrs: Record<string, unknown> = {}) {
  const input = h("input", {
    type: "file", class: "fileoverlay", "aria-label": label,
    onchange: async (e: Event) => {
      const inp = e.target as HTMLInputElement;
      const f = inp.files?.[0];
      inp.value = "";
      if (!f) return;
      if (kind === "save") { openFile(f); return; }
      try { await loadRom(await readFile(f), f.name); } catch (err) { toast(`Couldn't read ${f.name}: ${(err as Error)?.message ?? "unknown error"}`, "bad"); }
    },
  });
  return h("label", { class: `${cls} filebtn`, ...attrs }, h("span", {}, label), input);
}

function readFile(file: File): Promise<Uint8Array> {
  if (file.arrayBuffer) return file.arrayBuffer().then(b => new Uint8Array(b));
  return new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(new Uint8Array(fr.result as ArrayBuffer)); fr.onerror = () => rej(fr.error); fr.readAsArrayBuffer(file); });
}

async function openFile(file: File) {
  let buf: Uint8Array;
  try { buf = await readFile(file); } catch (e) { toast(`Couldn't read ${file.name}: ${(e as Error)?.message ?? "unknown error"}`, "bad"); return; }
  if (buf.length > 0x40000 && buf[0xb2] === 0x96) { await loadRom(buf, file.name); return; }
  if (!st.rom) { toast("Load your game's ROM first, then open the save.", "bad"); return; }
  loadBytes(buf, file.name, false);
}

function loadBytes(buf: Uint8Array, name: string, demo: boolean, profileId?: string, slot?: 0 | 1) {
  st.error = "";
  try {
    const det = C.detect(buf, dataFor);
    if (!det.ok) { st.error = det.messages.join(" "); renderAll(); return; }
    st.detected = det;
    const profile = C.getProfile(profileId ?? det.suggestedProfile!);
    C.setData(dataFor(profile));
    st.save = C.parse(buf, profile, slot);
    const gf = st.rom && romFits(profile) ? st.rom.gf : null;
    if (gf && gf.partyOffset && gf.partyOffset !== profile.offsets.sb1.party)
      st.save.warnings.push(`This ROM puts the party at 0x${gf.partyOffset.toString(16)} in SaveBlock1, but ${profile.name} expects 0x${profile.offsets.sb1.party.toString(16)}. Its save layout differs, so edits may corrupt the save.`);
    st.fileName = name; st.isDemo = demo; st.dirty = false; st.view = "party";
    st.box = st.save.currentBox;
    st.sel = st.save.party.length ? { where: "party", i: 0 } : null;
    st.confirmExport = null;
  } catch (e) {
    st.error = `This file could not be opened: ${(e as Error).message}`;
  }
  renderAll();
}

/** Re-reads the current save (with its edits) using another profile, slot or data set. */
function reparse(profileId: string, slot?: 0 | 1) {
  const s = st.save!;
  const bytes = st.dirty ? C.write(s) : s.bytes;
  const keepDirty = st.dirty, original = s.original, sel = st.sel, view = st.view, box = st.box, detected = st.detected;
  loadBytes(bytes, st.fileName, st.isDemo, profileId, slot ?? s.slot.index);
  if (st.save) {
    st.save.original = original; st.dirty = keepDirty; st.detected = detected;
    st.view = view; st.box = Math.min(box, st.save.boxes.length - 1);
    st.sel = sel && (sel.where === "party" || sel.box < st.save.boxes.length) ? sel : null;
  }
  renderAll();
}

// ---------- Remembering the ROM on this device (IndexedDB; never uploaded) ----------

function idb(): Promise<IDBDatabase | null> {
  return new Promise(res => {
    try {
      const req = indexedDB.open("gen3-save-editor", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("files");
      req.onsuccess = () => res(req.result);
      req.onerror = () => res(null);
    } catch { res(null); }
  });
}
async function idbPut(key: string, value: unknown) {
  const db = await idb(); if (!db) return;
  try { db.transaction("files", "readwrite").objectStore("files").put(value, key); } catch { /* storage unavailable */ }
}
async function idbGet<T>(key: string): Promise<T | null> {
  const db = await idb(); if (!db) return null;
  return new Promise(res => {
    try {
      const r = db.transaction("files").objectStore("files").get(key);
      r.onsuccess = () => res((r.result as T) ?? null); r.onerror = () => res(null);
    } catch { res(null); }
  });
}
async function forgetRom() {
  await idbPut("rom", null);
  st.rom = null; st.save = null; st.detected = null; st.dirty = false; spriteCache.clear(); optCache = null;
  toast("ROM forgotten on this device.", "");
  renderAll();
}

async function loadRom(buf: Uint8Array, name: string, fromStorage = false) {
  st.busy = "Reading ROM tables…"; renderAll();
  await new Promise(r => setTimeout(r, 30));
  try {
    const res = C.loadRomData(buf);
    const sprites = (() => { try { return C.findSpriteTables(buf, res.data.species.length, res.record ?? undefined, res.gf ?? undefined); } catch { return null; } })();
    const itemIcons = (() => { try { return C.findItemIcons(buf, res.data.items.length); } catch { return null; } })();
    st.rom = { ...res, fileName: name, bytes: buf, sprites, itemIcons };
    spriteCache.clear();
    if (!sprites) res.report.push("sprites not found (this ROM may use a newer compression)");
    optCache = null;
    if (!fromStorage) {
      toast(`Loaded ${res.data.species.length - 1} species, ${res.data.moves.length - 1} moves and ${res.data.items.length - 1} items from ${name.replace(/\.(gba|bin)$/i, "")}.`, "good");
      if (st.rememberRom) idbPut("rom", { name, bytes: buf });
    }
    if (st.save) {
      // re-rank engines with the ROM's tables, then reopen with the best one
      const bytes = st.dirty ? C.write(st.save) : st.save.bytes;
      const det = C.detect(bytes, dataFor);
      const keep = st.save.profile.id;
      const best = det.ok ? det.suggestedProfile! : keep;
      reparse(best);
      st.detected = det;
    }
  } catch (e) {
    if (!fromStorage) toast(`Couldn't read that ROM: ${(e as Error).message}`, "bad");
  }
  st.busy = "";
  renderAll();
}


// ---------- Export ----------

let downloadsCap: Promise<any> | null = null;
function getDownloads(): Promise<any> {
  const claude = (window as any).claude;
  if (!claude?.use) return Promise.resolve(null);
  downloadsCap ??= claude.use("downloads").catch(() => null);
  return downloadsCap!;
}

function baseName() { return (st.fileName || "pokemon").replace(/\.(sav|srm|bin|fla)$/i, ""); }

function exportProblems(): string[] {
  const s = st.save!, out: string[] = [];
  if (s.fit.records >= 3 && s.fit.score < 0.75)
    out.push(`Only ${s.fit.plausible} of ${s.fit.records} Pokémon read cleanly with ${s.profile.name}. Writing with the wrong layout can corrupt the save.`);
  s.party.forEach((m, i) => { const w = C.validatePokemon(m, s.profile.partyCodec); if (w.length && m.dirty) out.push(`Party ${i + 1} (${C.speciesName(m.species)}): ${w[0]}`); });
  s.boxes.forEach((b, bi) => b.slots.forEach((m, i) => {
    if (!m || !m.dirty) return;
    const w = C.validatePokemon(m, s.profile.boxCodec);
    if (w.length) out.push(`${b.name || `Box ${bi + 1}`} slot ${i + 1} (${C.speciesName(m.species)}): ${w[0]}`);
  }));
  if (!s.party.length) out.push("The party is empty. The game expects at least one Pokémon in the party.");
  return out;
}

async function exportEdited(force = false) {
  const s = st.save!;
  if (!force) {
    const w = exportProblems();
    if (w.length) { st.confirmExport = w; renderAll(); return; }
  }
  st.confirmExport = null;
  let out: Uint8Array;
  try { out = C.write(s); } catch (e) { toast(`Export failed: ${(e as Error).message}`, "bad"); return; }
  const problems = C.verify(out, s.slot.index, s.profile);
  if (problems.length) { toast(`Export stopped: ${problems.join(" ")}`, "bad"); return; }
  const ok = await deliver(out, `${baseName()}-edited.sav`);
  if (ok) {
    const sel = st.sel, view = st.view, box = st.box, original = s.original;
    st.save = C.parse(out, s.profile, s.slot.index);
    st.save.original = original;
    st.dirty = false; st.sel = sel; st.view = view; st.box = box;
    renderAll();
  }
}

async function exportBackup() { await deliver(st.save!.original.slice(), `${baseName()}-backup.sav`); }

async function deliver(bytes: Uint8Array, filename: string): Promise<boolean> {
  const dl = await getDownloads();
  if (dl) {
    try {
      const zip = C.zipStore([{ name: filename, data: bytes }]);
      await dl.save({ filename: filename.replace(/\.sav$/, ".zip"), data: new Blob([zip]) });
      toast(`Saved ${filename.replace(/\.sav$/, ".zip")}. Unzip it to get ${filename}.`, "good");
      return true;
    } catch (e: any) {
      if (e?.code === "declined") { toast("Download cancelled.", ""); return false; }
      if (e?.code === "rate_limited") { toast("A download prompt is already open.", ""); return false; }
    }
  }
  const picker = (window as any).showSaveFilePicker;
  if (picker && window.top === window.self) {
    try {
      const handle = await picker({ suggestedName: filename, types: [{ description: "GBA save", accept: { "application/octet-stream": [".sav"] } }] });
      const w = await handle.createWritable(); await w.write(bytes); await w.close();
      toast(`Saved ${filename}.`, "good");
      return true;
    } catch (e: any) {
      if (e?.name === "AbortError") return false;
    }
  }
  try {
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
    const a = h("a", { href: url, download: filename });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast(`Downloading ${filename}.`, "good");
    return true;
  } catch {
    toast("This view cannot start downloads. Open the editor as a standalone page to save files.", "bad");
    return false;
  }
}

// ---------- Toasts ----------

let toastTimer = 0;
function toast(msg: string, tone: "good" | "bad" | "") {
  const t = $("toast");
  t.textContent = msg; t.className = `toast ${tone}`; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { t.hidden = true; }, 6000);
}

// ---------- Rendering ----------

function renderAll() {
  renderTop();
  renderNav();
  renderTabs();
  renderMain();
  renderSide();
  renderBottom();
  document.body.classList.toggle("sheet-open", st.sheet && isPhone() && !!st.save && st.view !== "trainer" && st.view !== "repair");
}

function openSheet() { st.sheet = true; }
function closeSheet() { st.sheet = false; st.armDelete = false; renderAll(); }

function renderTop() {
  const s = st.save;
  const slotChip = s ? h("div", { class: "slotinfo" },
    s.slots.filter(x => x.complete).length > 1
      ? select("slotSel", s.slot.index, s.slots.filter(x => x.complete).map(x => [x.index, `Slot ${x.index === 0 ? "A" : "B"} · save no. ${x.counter}${x.valid ? "" : " · damaged"}`]),
          v => reparse(s.profile.id, Number(v) as 0 | 1), { "aria-label": "Save slot" })
      : h("span", {}, `Slot ${s.slot.index === 0 ? "A" : "B"} · save no. ${s.slot.counter}`),
    h("span", { class: `pill ${s.slot.valid ? "ok" : "bad"}` }, s.slot.valid ? "Checksums OK" : "Checksum errors")) : null;

  mount($("topActions"),
    h("div", { class: "actgroup open" },
      s ? fileButton("Open save", "btn primary", "save") : null,
      s ? h("button", { class: `btn icon-more ${st.fileMenu ? "on" : ""}`, "aria-expanded": st.fileMenu ? "true" : "false", "aria-controls": "fileMeta",
        onclick: () => { st.fileMenu = !st.fileMenu; renderAll(); } }, st.fileMenu ? "Done" : "File") : null),
    h("div", { id: "fileMeta", class: `actgroup meta ${st.fileMenu ? "show" : ""}` },
      s ? field("Game / engine", "gameSel", select("gameSel", s.profile.id, C.PROFILES.map(p => [p.id, p.name]), v => reparse(v))) : null,
      s ? h("div", { class: "field" }, h("span", { class: "fieldlabel" }, "Save slot"), slotChip) : null,
      st.rom ? h("div", { class: "romchip" }, h("span", {}, "ROM: ", h("strong", {}, romLabel()), ` (${st.rom.header.code})`),
        h("button", { class: "linkish", onclick: forgetRom }, "Forget")) : null,
      h("div", { class: "row tight phone-only-flex" },
        fileButton(st.rom ? "Change ROM" : "Load ROM", "btn", "rom", { title: "The ROM the save belongs to: names, stats and sprites come from it" }),
        s ? h("button", { class: "btn", onclick: exportBackup }, "Download original") : null)),
    h("div", { class: "actgroup export" },
      h("span", { class: "desktop-only" },
        s ? fileButton(st.rom ? "Change ROM" : "Load ROM", "btn", "rom", { title: "The ROM the save belongs to: names, stats and sprites come from it" }) : null,
        s ? h("button", { class: "btn", onclick: exportBackup }, "Download original") : null),
      st.busy ? h("span", { class: "pill warn" }, st.busy) : null,
      s && st.dirty ? h("span", { class: "pill warn", title: "Edits are not saved to a file yet" }, "Unsaved changes") : null,
      s ? h("button", { class: "btn primary", onclick: () => exportEdited() }, "Download edited save") : null),
  );

  const banner = $("banner");
  const hackNoRom = s && s.profile.engine !== "vanilla" && !(st.rom && romFits(s.profile));
  const romMismatch = s && st.rom && !romFits(s.profile);
  if (st.error) {
    banner.hidden = false; banner.className = "banner bad";
    mount(banner, h("strong", {}, "Couldn't open that file. "), st.error);
  } else if (st.confirmExport) {
    banner.hidden = false; banner.className = "banner warn";
    mount(banner,
      h("div", {}, h("strong", {}, `${st.confirmExport.length} problem${st.confirmExport.length > 1 ? "s" : ""} found. `), "The game may reject or misread this save."),
      h("ul", {}, st.confirmExport.slice(0, 5).map(w => h("li", {}, w))),
      h("div", { class: "row" },
        h("button", { class: "btn primary", onclick: () => exportEdited(true) }, "Export anyway"),
        h("button", { class: "btn", onclick: () => { st.confirmExport = null; renderAll(); } }, "Go back")));
  } else if (st.isDemo) {
    banner.hidden = false; banner.className = "banner";
    mount(banner, h("strong", {}, "Example save. "), "This is a generated Emerald save so you can try the editor. Open your own .sav to edit it; files never leave this device. ",
      st.rom ? null : [fileButton("Load your ROM", "linkish", "rom"), " to show Pokémon sprites."]);
  } else if (romMismatch) {
    banner.hidden = false; banner.className = "banner warn";
    const famName = (f: C.Family) => f === "E" ? "Emerald" : f === "FRLG" ? "FireRed" : "Ruby/Sapphire";
    const romFam = ROM_FAMILY[st.rom!.header.code];
    mount(banner, h("strong", {}, "Wrong ROM. "),
      `${romLabel()} is ${romFam ? `a ${famName(romFam)}-based game` : "for a different game"}, but this save is from ${s!.profile.family === "E" ? "an" : "a"} ${famName(s!.profile.family)}-based game, so names, sprites and stats can't be shown. `,
      fileButton("Load this save's ROM", "linkish", "rom"), ".");
  } else if (hackNoRom) {
    banner.hidden = false; banner.className = "banner";
    mount(banner, h("strong", {}, `${s!.profile.short} save. `),
      "Names and stats shown are Gen III defaults and may not match this hack. ",
      fileButton("Load the hack's ROM", "linkish", "rom"), " to read its own species, moves, items and abilities. The ROM stays on this device.");
  } else banner.hidden = true;
}

function slotCount(b: C.Box) { return b.slots.filter(Boolean).length; }

/** Phone navigation: three segments instead of the side rail. */
function renderTabs() {
  const s = st.save, el = $("tabs");
  el.hidden = !s;
  if (!s) { mount(el); return; }
  const tab = (v: View, label: string, meta: string) =>
    h("button", { class: `tab ${st.view === v ? "on" : ""}`, role: "tab", "aria-selected": st.view === v ? "true" : "false",
      onclick: () => { st.view = v; st.sheet = false; st.moving = st.moving; renderAll(); } },
      h("span", {}, label), h("small", {}, meta));
  mount(el,
    tab("trainer", "Trainer", s.trainer.name || "—"),
    tab("party", "Party", `${s.party.length}/6`),
    tab("box", "PC", `${s.boxes.reduce((a, b) => a + slotCount(b), 0)} stored`));
}

/** Phone action bar: save status and the download button within thumb reach. */
function renderBottom() {
  const s = st.save, el = $("bottombar");
  if (!s) { el.hidden = true; return; }
  el.hidden = false;
  mount(el,
    h("div", { class: "bbstatus" },
      h("span", { class: `dotstate ${st.dirty ? "dirty" : "clean"}`, "aria-hidden": "true" }),
      h("span", {}, st.dirty ? "Unsaved changes" : st.isDemo ? "Example save" : "No changes yet")),
    h("button", { class: "btn primary", onclick: () => exportEdited() }, "Download .sav"));
}

function movingStrip() {
  if (!st.moving) return null;
  const m = st.moving.where === "party" ? st.save!.party[st.moving.i] : st.save!.boxes[st.moving.box].slots[st.moving.i];
  return h("div", { class: "movestrip", role: "status" },
    h("span", {}, "Moving ", h("strong", {}, m ? (m.nickname || C.speciesName(m.species)) : "Pokémon"), ". Tap a slot to put it there — any box or the party."),
    h("button", { class: "btn small", onclick: () => { st.moving = null; renderAll(); } }, "Cancel"));
}

function renderNav() {
  const s = st.save;
  if (!s) { mount($("nav")); return; }
  const t = s.trainer;
  mount($("nav"),
    h("button", { class: `navitem ${st.view === "trainer" ? "on" : ""}`, onclick: () => { st.view = "trainer"; renderAll(); } },
      h("span", { class: "navlabel" }, "Trainer"),
      h("span", { class: "navmeta" }, `${t.name} · ID ${pad5(t.tid)}`)),
    h("button", { class: `navitem ${st.view === "party" ? "on" : ""}`, onclick: () => { st.view = "party"; renderAll(); } },
      h("span", { class: "navlabel" }, "Party"),
      h("span", { class: "navmeta" }, `${s.party.length}/6`)),
    h("button", { class: `navitem ${st.view === "repair" ? "on" : ""}`, onclick: () => openRepair() },
      h("span", { class: "navlabel" }, "Repair"),
      h("span", { class: "navmeta" }, repairSummary(s))),
    h("div", { class: "navhead" }, `PC boxes · ${s.boxes.length}`),
    h("div", { class: "boxlist" }, s.boxes.map((b, i) =>
      h("button", { class: `navitem box ${st.view === "box" && st.box === i ? "on" : ""}`, onclick: () => { st.view = "box"; st.box = i; renderAll(); } },
        h("span", { class: "navlabel" }, b.name || `Box ${i + 1}`),
        h("span", { class: "navmeta" }, `${slotCount(b)}/30`)))),
  );
}

// ---------- Sprites and icons ----------
// Sprites come only from the user's own ROM and are decoded on this device; none ship with the editor.

const spriteCache = new Map<string, string | null>();
function spriteURL(species: number, shiny: boolean): string | null {
  const r = st.rom, s = st.save;
  if (!r?.sprites || !s || !romFits(s.profile)) return null;
  const key = `${species}-${shiny ? 1 : 0}`;
  if (spriteCache.has(key)) return spriteCache.get(key)!;
  let url: string | null = null;
  try {
    const spr = C.decodeSprite(r.bytes, r.sprites, species, shiny);
    if (spr) {
      const c = document.createElement("canvas");
      c.width = spr.width; c.height = spr.height;
      c.getContext("2d")!.putImageData(new ImageData(spr.rgba, spr.width, spr.height), 0, 0);
      url = c.toDataURL("image/png");
    }
  } catch { url = null; }
  spriteCache.set(key, url);
  return url;
}

/** An item's bag icon from the ROM, as a data URL; null without a matching ROM. */
function itemIconURL(item: number): string | null {
  const r = st.rom, s = st.save;
  if (!item || !r?.itemIcons || !s || !romFits(s.profile)) return null;
  const key = `item-${item}`;
  if (spriteCache.has(key)) return spriteCache.get(key)!;
  let url: string | null = null;
  try {
    const spr = C.decodeItemIcon(r.bytes, r.itemIcons, item);
    if (spr) {
      const c = document.createElement("canvas");
      c.width = spr.width; c.height = spr.height;
      c.getContext("2d")!.putImageData(new ImageData(spr.rgba, spr.width, spr.height), 0, 0);
      url = c.toDataURL("image/png");
    }
  } catch { url = null; }
  spriteCache.set(key, url);
  return url;
}
const itemIcon = (item: number, cls = "itemicon") => {
  const url = itemIconURL(item);
  return url ? h("img", { class: cls, src: url, alt: "", width: 24, height: 24 }) : null;
};
const ballIcon = (m: C.Pokemon, cls = "itemicon") => {
  const it = C.ballItem(st.save!.profile.engine, m.ball);
  return it === null ? null : itemIcon(it, cls);
};
/** Type of a move, when the ROM's move table gave it. */
const moveType = (mv: number) => (mv ? C.data().moveTypes?.[mv] : undefined) || undefined;

// ---------- Move details ----------
const moveCat = (mv: number) => (mv ? C.data().moveCat?.[mv] : undefined);
const moveDesc = (mv: number) => (mv ? C.data().moveDesc?.[mv] || "" : "");
const CAT_SHORT = { Physical: "Phys", Special: "Spec", Status: "Status" } as const;
function catPill(mv: number, short = false) {
  const c = moveCat(mv);
  return c ? h("span", { class: `catpill cat-${c.toLowerCase()}`, title: c }, short ? CAT_SHORT[c] : c) : null;
}
/** "Physical · 80 power · 100% accuracy", with dashes for variable power and moves that never miss. */
function moveStats(mv: number, short = false) {
  const d = C.data();
  if (!mv || !d.movePower) return null;
  const pw = d.movePower[mv] ?? 0, acc = d.moveAcc?.[mv] ?? 0, cat = moveCat(mv);
  const power = cat === "Status" ? null : pw <= 1 ? "—" : String(pw);
  return h("span", { class: "mvstats" }, catPill(mv, short),
    power !== null ? h("span", {}, short ? power : `${power} power`) : null,
    short ? null : h("span", {}, acc ? `${acc}% accuracy` : "Never misses"));
}

// ---------- Pickers ----------
const speciesPickOptions = (): PickOption[] =>
  options().species.map(([v]) => {
    const info = C.data().info[v];
    const abil = info ? [...new Set(info.ab.filter(Boolean))].map(a => C.abilityName(a)).join(", ") : "";
    return {
      value: v, label: C.speciesName(v), meta: dexNo(v), icon: () => spriteURL(v, false),
      sub: info ? `${info.t.join(" / ")}${abil ? ` · ${abil}` : ""}` : undefined,
      right: info ? () => h("span", { class: "bst" }, h("small", {}, "Total"), String(info.bs.reduce((a, b) => a + b, 0))) : undefined,
    };
  });
const itemPickOptions = (max: number): PickOption[] =>
  options().items.filter(([v]) => v <= max).map(([v, label]) => ({ value: v, label, icon: () => itemIconURL(v) }));
const ballPickOptions = (max: number): PickOption[] =>
  C.ballChoices(st.save!.profile.engine).filter(([v]) => v <= max).map(([v, label]) => ({ value: v, label, icon: () => { const it = C.ballItem(st.save!.profile.engine, v); return it === null ? null : itemIconURL(it); } }));
const movePickOptions = (max: number): PickOption[] =>
  options().moves.filter(([v]) => v <= max).map(([v, label]) => ({
    value: v, label: v ? label : "— (no move)", type: moveType(v), sub: moveDesc(v) || undefined, right: v ? () => moveStats(v, true) : undefined,
  }));
function speciesPreview(v: number) {
  return h("div", { class: "spreview" },
    h("div", { class: "sphead" }, (() => { const u = spriteURL(v, false); return u ? h("img", { src: u, alt: "", class: "art md sprite" }) : null; })(),
      h("div", {}, h("strong", {}, C.speciesName(v)), h("div", { class: "muted small" }, dexNo(v)), typeBadges(v))),
    baseStats(v));
}
function pickSpecies(title: string, current: number, onPick: (v: number) => void, confirm: (v: number) => string) {
  openPicker({ title, options: speciesPickOptions(), current, onPick, iconSize: "lg", preview: speciesPreview, confirmLabel: confirm });
}

const svg = (body: string, cls: string, label?: string) => {
  const span = h("span", { class: cls, "aria-hidden": label ? undefined : "true", role: label ? "img" : undefined, "aria-label": label });
  span.innerHTML = body;
  return span;
};
const ICON = {
  item: '<svg viewBox="0 0 16 16"><path d="M2 2h6l6 6-6 6-6-6z" fill="currentColor"/><circle cx="5" cy="5" r="1.4" fill="var(--surface)"/></svg>',
  egg: '<svg viewBox="0 0 32 32"><ellipse cx="16" cy="18" rx="10" ry="12" fill="#f3ead2" stroke="#b9a978" stroke-width="1.5"/><circle cx="12" cy="14" r="2.4" fill="#8fbf7a"/><circle cx="20" cy="20" r="3" fill="#8fbf7a"/><circle cx="14" cy="24" r="1.8" fill="#8fbf7a"/></svg>',
  star: '<svg viewBox="0 0 16 16"><path d="M8 1l2 4.6 5 .5-3.8 3.3 1.1 4.9L8 11.8 3.7 14.3l1.1-4.9L1 6.1l5-.5z" fill="currentColor"/></svg>',
};

/** Sprite from the ROM, or an original placeholder: a type-tinted disc with the name's initial. */
function monArt(m: C.Pokemon, size: "sm" | "md" | "lg") {
  if (m.isEgg) return svg(ICON.egg, `art ${size} egg`, "Egg");
  const url = spriteURL(m.species, C.isShiny(m));
  if (url) return h("img", { class: `art ${size} sprite`, src: url, alt: "", width: 64, height: 64, decoding: "async" });
  const type = C.data().info[m.species]?.t?.[0] ?? "Normal";
  return h("span", { class: `art ${size} ph`, "data-type": type, "aria-hidden": "true" }, C.speciesName(m.species).replace(/^Species /, "#").slice(0, 2));
}

function typeBadges(species: number) {
  const t = C.data().info[species]?.t;
  if (!t) return null;
  return h("span", { class: "types" }, t.map(x => h("span", { class: "typebadge", "data-type": x }, x)));
}

const STATUS = (st: number): string | null =>
  st & 7 ? "SLP" : st & 0x80 ? "TOX" : st & 8 ? "PSN" : st & 0x10 ? "BRN" : st & 0x20 ? "FRZ" : st & 0x40 ? "PAR" : null;

function genderMark(m: C.Pokemon) {
  const g = C.gender(m);
  return g === "-" ? null : h("span", { class: `gender ${g === "M" ? "m" : "f"}`, title: g === "M" ? "Male" : "Female" }, g === "M" ? "♂" : "♀");
}

function slotTile(m: C.Pokemon | null, sel: NonNullable<Sel>, label: string) {
  const isSel = st.sel && st.sel.where === sel.where && st.sel.i === sel.i && (sel.where === "party" || (st.sel as any).box === (sel as any).box);
  const warn = m ? C.validatePokemon(m, codecAt(sel)) : [];
  const type = m ? C.data().info[m.species]?.t?.[0] ?? "Normal" : "";
  const lvl = m ? C.levelOf(m) : null;
  const title = !m ? `${label}: empty` : warn.length ? `${label}: ${warn.join(" ")}` : label;
  return h("button", {
    class: `slot ${m ? "full" : "empty"} ${isSel ? "sel" : ""} ${warn.length ? "warned" : ""}`,
    title, "aria-label": m ? `${label}: ${C.speciesName(m.species)} level ${lvl ?? "unknown"}` : `${label}: empty`,
    "data-type": type, draggable: m ? "true" : undefined,
    onclick: () => {
      if (st.moving) { const from = st.moving; st.moving = null; swap(from, sel); return; }
      st.sel = sel; st.armDelete = false; st.teachSlot = null;
      if (isPhone()) openSheet();
      renderAll();
    },
    ondragstart: (e: DragEvent) => { e.dataTransfer!.setData("text/plain", JSON.stringify(sel)); e.dataTransfer!.effectAllowed = "move"; },
    ondragover: (e: DragEvent) => { e.preventDefault(); (e.currentTarget as HTMLElement).classList.add("drop"); },
    ondragleave: (e: DragEvent) => (e.currentTarget as HTMLElement).classList.remove("drop"),
    ondrop: (e: DragEvent) => { e.preventDefault(); try { swap(JSON.parse(e.dataTransfer!.getData("text/plain")), sel); } catch { /* ignore */ } },
  },
    m ? [
      monArt(m, sel.where === "party" ? "md" : "sm"),
      h("span", { class: "slotinfo2" },
        sel.where === "party" ? h("span", { class: "dex" }, m.isEgg ? "Egg" : dexNo(m.species)) : null,
        h("span", { class: "sp" }, m.isEgg ? "Egg" : (sel.where === "party" && m.nickname ? m.nickname : C.speciesName(m.species))),
        h("span", { class: "lv" }, `Lv ${lvl ?? "?"}`, m.isEgg ? null : genderMark(m)),
        sel.where === "party" && m.party ? (() => {
          const pct = m.party!.stats[0] ? Math.max(0, Math.min(100, Math.round(m.party!.hp / m.party!.stats[0] * 100))) : 0;
          const stc = STATUS(m.party!.status);
          return h("span", { class: "hprow" },
            h("span", { class: `hpbar ${pct <= 20 ? "low" : pct <= 50 ? "mid" : ""}`, role: "img", "aria-label": `HP ${m.party!.hp} of ${m.party!.stats[0]}` }, h("span", { style: { width: `${pct}%` } })),
            stc ? h("span", { class: `status s-${stc.toLowerCase()}` }, stc) : null);
        })() : null),
      h("span", { class: "badges" },
        C.isShiny(m) ? svg(ICON.star, "badge shiny", "Shiny") : null,
        m.heldItem ? (itemIcon(m.heldItem, "itemicon tile") ?? svg(ICON.item, "badge item", `Holding ${C.itemName(m.heldItem)}`)) : null),
      warn.length ? h("span", { class: "dot", "aria-hidden": "true" }) : null,
    ] : h("span", { class: "emptylabel" }, "Empty"));
}

function swap(from: NonNullable<Sel>, to: NonNullable<Sel>) {
  const s = st.save!;
  const get = (x: NonNullable<Sel>) => x.where === "party" ? s.party[x.i] ?? null : s.boxes[x.box].slots[x.i];
  const a = get(from), b = get(to);
  if (!a || (from.where === to.where && from.i === to.i && (from as any).box === (to as any).box)) return;
  if (from.where === "party" && !b && to.where !== "party" && s.party.length === 1) { toast("Keep at least one Pokémon in the party.", "bad"); return; }
  a.dirty = true; if (b) b.dirty = true;
  if (from.where === "party" && to.where === "party") {
    const bi = Math.min(to.i, s.party.length - 1);
    [s.party[from.i], s.party[bi]] = [s.party[bi], s.party[from.i]];
    st.sel = { where: "party", i: bi };
  } else if (from.where === "party") {
    if (b) { C.toParty(b); s.party[from.i] = b; } else s.party.splice(from.i, 1);
    a.party = undefined; s.boxes[(to as any).box].slots[to.i] = a;
    st.sel = to;
  } else if (to.where === "party") {
    C.toParty(a);
    if (b) { b.party = undefined; s.boxes[from.box].slots[from.i] = b; s.party[to.i] = a; st.sel = to; }
    else { s.boxes[from.box].slots[from.i] = null; s.party.push(a); st.sel = { where: "party", i: s.party.length - 1 }; }
  } else {
    s.boxes[from.box].slots[from.i] = b; s.boxes[to.box].slots[to.i] = a; st.sel = to;
  }
  touch();
}

function renderMain() {
  const s = st.save, main = $("main");
  if (!s) { mount(main, onboarding()); return; }
  if (st.view === "trainer") return mount(main, trainerView(s));
  if (st.view === "repair") return mount(main, repairView(s));
  if (st.view === "party") {
    const tiles = [];
    for (let i = 0; i < 6; i++) tiles.push(slotTile(s.party[i] ?? null, { where: "party", i }, `Party ${i + 1}`));
    mount(main,
      movingStrip(),
      h("div", { class: "viewhead" }, h("h2", {}, "Party"), h("span", { class: "muted" }, `${s.party.length} of 6 · tap to edit`)),
      h("div", { class: "grid party" }, tiles),
      h("div", { class: "phone-only" }, warningsPanel(s, null)));
    return;
  }
  const n = s.boxes.length;
  const b = s.boxes[st.box];
  mount(main,
    movingStrip(),
    h("div", { class: "boxhead" },
      h("button", { class: "btn icon", "aria-label": "Previous box", onclick: () => { st.box = (st.box + n - 1) % n; renderAll(); } }, "‹"),
      select("boxPick", st.box, s.boxes.map((bx, i) => [i, `${bx.name || `Box ${i + 1}`} · ${slotCount(bx)}/30`] as [number, string]),
        v => { st.box = Number(v); renderAll(); }, { "aria-label": "Box", class: "boxpick" }),
      h("button", { class: "btn icon", "aria-label": "Next box", onclick: () => { st.box = (st.box + 1) % n; renderAll(); } }, "›")),
    h("div", { class: `grid box ${s.boxes.length > 14 ? "" : ""}` }, b.slots.map((m, i) => slotTile(m, { where: "box", box: st.box, i }, `${b.name || `Box ${st.box + 1}`} slot ${i + 1}`))),
    h("details", { class: "boxsettings" },
      h("summary", {}, `Box ${st.box + 1} of ${n} settings`),
      h("div", { class: "fields cols2" },
        field("Box name", "boxName", h("input", {
          id: "boxName", value: b.name, maxlength: 8, autocomplete: "off",
          onchange: (e: Event) => {
            const v = (e.target as HTMLInputElement).value;
            const bad = C.unencodable(v);
            if (bad.length) { toast(`The game can't show ${bad.join(" ")} in box names.`, "bad"); renderAll(); return; }
            b.name = v; touch();
          },
        }), "Up to 8 characters"),
        field("Wallpaper", "wallSel", select("wallSel", b.wallpaper, WALLPAPERS.map((w, i) => [i, w] as [number, string]).concat(b.wallpaper >= 16 ? [[b.wallpaper, `Wallpaper ${b.wallpaper}`]] : []),
          v => { b.wallpaper = Number(v); touch(); })))),
    h("div", { class: "phone-only" }, warningsPanel(s, null)));
}

function onboarding() {
  if (st.booting) return h("div", { class: "emptystate" }, h("p", { class: "muted" }, "Loading…"));
  const r = st.rom;
  return h("div", { class: "onboard" },
    h("h2", {}, "Edit a Gen III save in two steps"),
    h("p", { class: "muted" }, "Works with Ruby, Sapphire, Emerald, FireRed, LeafGreen and ROM hacks built on them, pokeemerald-expansion or CFRU. Files stay on this device."),
    h("ol", { class: "steps" },
      h("li", { class: `step ${r ? "done" : "now"}` },
        h("div", { class: "stepnum", "aria-hidden": "true" }, r ? "✓" : "1"),
        h("div", { class: "stepbody" },
          h("h3", {}, r ? "ROM loaded" : "Load your game's ROM"),
          r ? h("p", {}, h("strong", {}, romLabel()), ` · ${r.header.code} · ${r.data.species.length - 1} species · ${r.sprites ? "sprites found" : "no sprites"}`)
            : h("p", {}, "The .gba file you play. The editor reads the hack's own Pokémon names, moves, items, stats and sprites from it. It's only read, never changed or uploaded."),
          h("div", { class: "row" },
            fileButton(r ? "Use a different ROM" : "Choose ROM (.gba)", r ? "btn" : "btn primary", "rom"),
            r ? h("button", { class: "btn", onclick: forgetRom }, "Forget ROM") : null),
          h("label", { class: "check small" },
            h("input", { type: "checkbox", id: "remember", checked: st.rememberRom, onchange: (e: Event) => { st.rememberRom = (e.target as HTMLInputElement).checked; if (!st.rememberRom) idbPut("rom", null); } }),
            h("span", {}, "Remember the ROM on this device")))),
      h("li", { class: `step ${r ? "now" : "later"}` },
        h("div", { class: "stepnum", "aria-hidden": "true" }, "2"),
        h("div", { class: "stepbody" },
          h("h3", {}, "Open your save"),
          h("p", {}, "The 128 KB .sav file from your emulator. Close the game first so the file is up to date."),
          r ? fileButton("Choose save (.sav)", "btn primary", "save") : h("button", { class: "btn", disabled: true }, "Choose save (.sav)")))),
  );
}

function trainerView(s: C.ParsedSave) {
  const t = s.trainer;
  const setT = (fn: () => void) => { fn(); touch(); };
  const textField = (id: string, label: string, val: string, max: number, set: (v: string) => void) =>
    field(label, id, h("input", {
      id, value: val, maxlength: max, autocomplete: "off",
      onchange: (e: Event) => {
        const v = (e.target as HTMLInputElement).value;
        const bad = C.unencodable(v);
        if (bad.length) { toast(`The game can't show ${bad.join(" ")}.`, "bad"); renderAll(); return; }
        setT(() => set(v));
      },
    }), `Up to ${max} characters`);
  const det = st.detected;
  return h("div", { class: "trainer" },
    h("div", { class: "viewhead" }, h("h2", {}, "Trainer"), h("span", { class: "muted" }, s.profile.name)),
    h("div", { class: "card" },
      h("div", { class: "fields cols3" },
        textField("tName", "Name", t.name, 7, v => { t.name = v; }),
        field("Gender", "tGender", select("tGender", t.gender, [[0, "Boy"], [1, "Girl"]], v => setT(() => { t.gender = Number(v); }))),
        field("Play time", "tHours", h("div", { class: "playtime" },
          num("tHours", t.playTime.h, 0, 999, v => setT(() => { t.playTime.h = v; }), { "aria-label": "Hours" }), h("span", {}, "h"),
          num("tMins", t.playTime.m, 0, 59, v => setT(() => { t.playTime.m = v; }), { "aria-label": "Minutes" }), h("span", {}, "m"))),
        field("Trainer ID", "tTid", num("tTid", t.tid, 0, 65535, v => setT(() => { t.tid = v; })), "Shown in game"),
        field("Secret ID", "tSid", num("tSid", t.sid, 0, 65535, v => setT(() => { t.sid = v; })), "Hidden; affects shininess"),
        h("div", {}),
        field("Money (¥)", "tMoney", num("tMoney", t.money, 0, 999999, v => setT(() => { t.money = v; })), "0 – 999,999"),
        field("Game Corner coins", "tCoins", num("tCoins", t.coins, 0, 9999, v => setT(() => { t.coins = v; })), "0 – 9,999"),
        t.battlePoints !== null
          ? field("Battle Points", "tBp", num("tBp", t.battlePoints, 0, 9999, v => setT(() => { t.battlePoints = v; })), "Battle Frontier")
          : null,
      ),
      h("p", { class: "note" }, "Changing your Trainer ID or Secret ID does not change the OT ID stored on your Pokémon. Pokémon you caught will then count as traded and may disobey."),
    ),
    h("div", { class: "card" },
      h("h3", {}, "Save layout"),
      det && det.ranking.length > 1 ? h("div", { class: "fits" }, det.ranking.map(r =>
        h("div", { class: `fitrow ${r.id === s.profile.id || (C.getProfile(r.id).engine === s.profile.engine && C.getProfile(r.id).family === s.profile.family) ? "on" : ""}` },
          h("span", {}, r.name),
          h("span", { class: "fitbar", "aria-hidden": "true" }, h("span", { style: { width: `${Math.round(r.fit.score * 100)}%` } })),
          h("span", { class: "fitnum" }, r.fit.records ? `${Math.round(r.fit.score * 100)}%` : "no data")))) : null,
      det && det.ranking.length > 1 ? h("p", { class: "note" }, "How cleanly each engine's format reads the Pokémon in this save. The best match was picked; change it with the game menu at the top.") : null,
      h("dl", { class: "facts" },
        h("dt", {}, "File"), h("dd", {}, st.fileName),
        h("dt", {}, "Size"), h("dd", {}, `${(s.original.length / 1024).toFixed(0)} KB`),
        h("dt", {}, "Active slot"), h("dd", {}, `${s.slot.index === 0 ? "A" : "B"} (save no. ${s.slot.counter})`),
        h("dt", {}, "Security key"), h("dd", { class: "mono" }, s.profile.offsets.sb2.securityKey !== undefined ? `0x${s.securityKey.toString(16).toUpperCase().padStart(8, "0")}` : "None (Ruby/Sapphire)"),
        h("dt", {}, "Game data"), h("dd", {}, C.data().label),
        st.rom ? [h("dt", {}, "ROM"), h("dd", {}, `${st.rom.header.title} (${st.rom.header.code}) · ${st.rom.report.join(", ")}`)] : null),
      C.data().notes.length ? h("ul", { class: "warnlist" }, C.data().notes.map(n => h("li", {}, n))) : null),
  );
}

function renderSide() {
  const s = st.save, side = $("side");
  if (!s) { mount(side); return; }
  const m = getSel();
  const parts: Node[] = [];
  if (st.view !== "trainer") parts.push(m ? editor(m) : emptySlotPanel());
  parts.push(h("div", { class: "desktop-only" }, warningsPanel(s, m)));
  mount(side, ...parts);
}

function addPokemon(sel: NonNullable<Sel>) {
  const s = st.save!;
  pickSpecies("Add a Pokémon", 0, sp => {
    const target: NonNullable<Sel> = sel.where === "party" ? { where: "party", i: Math.min(sel.i, s.party.length) } : sel;
    const m = C.createPokemon(sp, st.addLevel, s.profile, s.trainer, target.where === "party");
    m.cipher = C.saveCipher(s);
    // formats with fields the editor doesn't decode: start from one of the save's own records
    if (s.profile.engine === "compact") {
      const t = [...s.party, ...s.boxes.flatMap(b => b.slots)].find(x => x?.raw && x.codec.startsWith("compact"));
      if (t) { m.raw = t.raw!.slice(); m.codec = t.codec; m.dirty = true; }
    }
    setAt(target, m);
    st.sel = target; st.edTab = "info"; st.teachSlot = null; st.sheet = isPhone();
    toast(`Added ${C.speciesName(sp)} at level ${st.addLevel}.`, "good");
    touch();
  }, v => `Add ${C.speciesName(v)} · Lv ${st.addLevel}`);
}

function emptySlotPanel() {
  const sel = st.sel;
  return h("div", { class: "card editor" },
    h("div", { class: "sheetbar phone-flex" }, h("span", {}, "Empty slot"), h("button", { class: "btn small", onclick: closeSheet }, "Close")),
    h("h3", {}, sel ? "Empty slot" : "Nothing selected"),
    h("p", { class: "muted" }, sel ? "Add a new Pokémon here, paste a copied one, or drag one in." : "Select a Pokémon to edit it, or an empty slot to add one."),
    sel ? h("div", { class: "addrow" },
      field("Level", "addLevel", num("addLevel", st.addLevel, 1, 100, v => { st.addLevel = v; })),
      h("button", { class: "btn primary", onclick: () => addPokemon(sel) }, "Add Pokémon")) : null,
    sel ? h("p", { class: "note" }, "It gets random IVs and personality, the moves it would know at that level, and you as its trainer. You can change everything afterwards.") : null,
    sel && st.clip ? h("button", { class: "btn primary", onclick: () => { setAt(sel, Object.assign(C.cloneMon(st.clip!), { dirty: true })); st.sheet = isPhone(); touch(); } }, `Paste ${C.speciesName(st.clip.species)}`) : null);
}

function editor(m: C.Pokemon) {
  const d = C.data();
  const sel = st.sel!;
  const codec = codecAt(sel);
  const ci = C.codecInfo(codec);
  const info = d.info[m.species];
  const lvl = C.levelOf(m);
  const g = C.gender(m);
  const ratio = info?.g ?? 255;
  const fixedGender = ratio === 0 || ratio === 254 || ratio === 255;
  const evTotal = m.evs.reduce((a, b) => a + b, 0);
  const opts = options();
  const stats = lvl !== null ? C.calcStats(m, lvl) : null;
  const isCfru = ci.abilityKind === "cfru";

  const reroll = (want: Parameters<typeof C.rerollPid>[1]) => {
    const keep = {
      nature: C.pidNature(m), gender: fixedGender ? undefined : (g as "M" | "F"), shiny: C.isShiny(m),
      parity: isCfru && m.abilityNum < 2 ? m.pid & 1 : undefined,
    };
    const pid = C.rerollPid(m, { ...keep, ...want });
    if (pid === null) { toast("Couldn't find a matching personality value. Try again.", "bad"); return; }
    editMon(x => { x.pid = pid; if (isCfru && x.abilityNum < 2) x.abilityNum = pid & 1; });
  };

  const nameInput = (id: string, label: string, value: string, max: number, set: (v: string) => void) =>
    field(label, id, h("input", {
      id, value, maxlength: max, autocomplete: "off",
      onchange: (e: Event) => {
        const v = (e.target as HTMLInputElement).value;
        const bad = C.unencodable(v);
        if (bad.length) { toast(`The game can't show ${bad.join(" ")}.`, "bad"); renderAll(); return; }
        editMon(() => set(v));
      },
    }));

  const abilitySlots: [number, string][] = [];
  if (info) {
    abilitySlots.push([0, C.abilityName(info.ab[0])]);
    if (info.ab[1] && info.ab[1] !== info.ab[0]) abilitySlots.push([1, C.abilityName(info.ab[1])]);
    if (ci.abilityKind !== "bit" && info.ab[2]) abilitySlots.push([2, `${C.abilityName(info.ab[2])} (hidden)`]);
  }
  if (!abilitySlots.some(a => a[0] === m.abilityNum)) abilitySlots.push([m.abilityNum, `${C.abilityName(C.abilityId(m))} (slot ${m.abilityNum + 1})`]);
  const setAbility = (n: number) => {
    if (isCfru && n < 2 && (m.pid & 1) !== n) { reroll({ parity: n }); return; } // reroll sets the slot from the new PID
    editMon(x => { x.abilityNum = n; });
  };

  const itemControl = opts.items.length > 1
    ? pickButton("mItem", m.heldItem ? C.itemName(m.heldItem) : "None", { icon: itemIconURL(m.heldItem), onclick: () =>
        openPicker({ title: "Held item", options: itemPickOptions(ci.maxItem), current: m.heldItem, onPick: v => editMon(x => { x.heldItem = v; }) }) })
    : num("mItem", m.heldItem, 0, ci.maxItem, v => editMon(x => { x.heldItem = v; }));

  const tabBtn = (k: typeof st.edTab, label: string) =>
    h("button", { class: `edtab ${st.edTab === k ? "on" : ""}`, role: "tab", "aria-selected": st.edTab === k ? "true" : "false", onclick: () => { st.edTab = k; renderAll(); } }, label);
  return h("div", { class: "card editor" },
    h("div", { class: "sheetbar phone-flex" },
      h("span", { class: "grab", "aria-hidden": "true" }),
      h("button", { class: "btn small", onclick: closeSheet }, "Done")),
    h("div", { class: "edhead", "data-type": info?.t?.[0] ?? "Normal" },
      h("div", { class: "edart" }, monArt(m, "lg")),
      h("div", { class: "edid" },
        h("div", { class: "edtitle" }, m.nickname || C.speciesName(m.species), C.isShiny(m) ? svg(ICON.star, "badge shiny big", "Shiny") : null),
        h("div", { class: "muted" }, `${speciesLabel(m.species)} · Lv ${lvl ?? "?"}`, " ", genderMark(m)),
        h("div", { class: "edmeta" }, typeBadges(m.species),
          h("span", { class: "itemchip", title: C.ballName(st.save!.profile.engine, m.ball) }, ballIcon(m), C.ballName(st.save!.profile.engine, m.ball)),
          m.heldItem ? h("span", { class: "itemchip" }, itemIcon(m.heldItem) ?? svg(ICON.item, "badge item"), C.itemName(m.heldItem)) : null)),
      h("div", { class: "row tight edactions" },
        h("button", { class: "btn small", onclick: () => { st.moving = sel; st.sheet = false; renderAll(); } }, "Move"),
        h("button", { class: "btn small", onclick: () => { st.clip = C.cloneMon(m); toast(`Copied ${C.speciesName(m.species)}. Tap an empty slot to paste.`, ""); renderAll(); } }, "Copy"),
        st.clip ? h("button", { class: "btn small", onclick: () => { setAt(sel, Object.assign(C.cloneMon(st.clip!), { dirty: true })); touch(); } }, "Paste") : null,
        st.armDelete
          ? h("button", { class: "btn small danger", onclick: () => {
              if (sel.where === "party" && st.save!.party.length === 1) { toast("Keep at least one Pokémon in the party.", "bad"); return; }
              setAt(sel, null); st.armDelete = false; st.sheet = false; if (sel.where === "party") st.sel = null; touch(); } }, "Confirm delete")
          : h("button", { class: "btn small", onclick: () => { st.armDelete = true; renderAll(); } }, "Delete"))),
    h("div", { class: "edtabs", role: "tablist" }, tabBtn("info", "Info"), tabBtn("moves", "Moves"), tabBtn("stats", "Stats"), tabBtn("ot", "Trainer")),

    st.edTab !== "info" ? null : section("Identity",
      h("div", { class: "fields cols2" },
        field("Species", "mSpecies", pickButton("mSpecies", C.speciesName(m.species), { icon: spriteURL(m.species, false), meta: dexNo(m.species), onclick: () => pickSpecies("Species", m.species, ns => {
          editMon(x => {
            const keepLvl = C.levelOf(x);
            if (x.nickname === defaultName(x.species)) x.nickname = defaultName(ns).slice(0, ci.nickLen);
            x.species = ns;
            const ab = C.data().info[ns]?.ab;
            if (ab && !ab[x.abilityNum]) x.abilityNum = isCfru ? x.pid & 1 : 0;
            if (keepLvl !== null) C.setLevel(x, keepLvl);
          });
        }, v => `Change to ${C.speciesName(v)}`) })),
        nameInput("mNick", "Nickname", m.nickname, ci.nickLen, v => { m.nickname = v; }),
        field("Level", "mLevel", C.canSetLevel(m)
          ? num("mLevel", lvl ?? 1, 1, 100, v => editMon(x => { C.setLevel(x, v); }))
          : h("input", { id: "mLevel", value: lvl ?? "?", disabled: true }),
          C.canSetLevel(m) ? `EXP ${m.exp.toLocaleString()}` : "Growth rate unknown; load the ROM to change level"),
        field("Held item", "mItem", itemControl),
        field("Poké Ball", "mBall", pickButton("mBall", C.ballName(st.save!.profile.engine, m.ball), {
          icon: (() => { const it = C.ballItem(st.save!.profile.engine, m.ball); return it === null ? null : itemIconURL(it); })(),
          onclick: () => openPicker({ title: "Poké Ball", options: ballPickOptions(ci.maxBall), current: m.ball, onPick: v => editMon(x => { x.ball = v; }) }) })),
        field("Nature", "mNature", select("mNature", C.nature(m), C.NATURES.map((n, i) => [i, n] as [number, string]),
          v => ci.hasNatureMod ? editMon(x => { x.natureMod = (x.pid % 25) ^ Number(v); }) : reroll({ nature: Number(v) }))),
        field("Ability", "mAbility", abilitySlots.length > 1
          ? select("mAbility", m.abilityNum, abilitySlots, v => setAbility(Number(v)))
          : h("input", { id: "mAbility", value: abilitySlots[0]?.[1] ?? "—", disabled: true })),
        field("Gender", "mGender", fixedGender
          ? h("input", { id: "mGender", value: g === "-" ? "Genderless" : g === "M" ? "Male only" : "Female only", disabled: true })
          : select("mGender", g, [["M", "Male"], ["F", "Female"]], v => reroll({ gender: v as "M" | "F" }))),
        field("Shiny", "mShiny", h("label", { class: "check" },
          h("input", { id: "mShiny", type: "checkbox", checked: C.isShiny(m), onchange: (e: Event) => {
            const want = (e.target as HTMLInputElement).checked;
            editMon(x => { if (!C.setShiny(x, want, codec)) toast("Couldn't find a matching personality value. Try again.", "bad"); });
          } }),
          h("span", {}, C.isShiny(m) ? "Shiny" : "Not shiny"))),
      ),
      h("p", { class: "note" }, ci.hasNatureMod
        ? "This engine stores shininess and the stat nature separately, so changing them keeps the personality value. Changing gender picks a new one."
        : isCfru
          ? "In CFRU the normal ability slot comes from the personality value, like nature, gender and shininess. Changing one picks a new value and keeps the others."
          : "In Gen III, nature, gender and shininess all come from one personality value, so changing any of them picks a new one and keeps the other two."),
    ),

    st.edTab !== "moves" ? null : section("Moves",
      h("div", { class: "moves" }, [0, 1, 2, 3].map(i => {
        const max = C.maxPP(m.moves[i], m.ppBonuses, i);
        return h("div", { class: "moveitem" }, h("div", { class: "moverow" },
          pickButton(`mMove${i}`, m.moves[i] ? C.moveName(m.moves[i]) : "—", { type: moveType(m.moves[i]) ?? "none", ariaLabel: `Move ${i + 1}: ${m.moves[i] ? C.moveName(m.moves[i]) : "none"}`,
            onclick: () => openPicker({ title: `Move ${i + 1}`, options: movePickOptions(ci.maxMove), current: m.moves[i], onPick: v => editMon(x => {
              x.moves[i] = v; x.pp[i] = C.maxPP(v, x.ppBonuses, i);
            }) }) }),
          ci.storesPP
            ? num(`mPP${i}`, m.pp[i], 0, codec === "pex-modern" ? 127 : 99, v => editMon(x => { x.pp[i] = v; }), { "aria-label": `PP for move ${i + 1}`, class: "pp" })
            : h("span", { class: "muted ppmax" }, "—"),
          h("span", { class: "muted ppmax" }, max ? `/ ${max}` : "")),
          m.moves[i] && (C.data().movePower || moveDesc(m.moves[i]))
            ? h("div", { class: "movedetail" }, moveStats(m.moves[i]), moveDesc(m.moves[i]) ? h("p", { class: "mvdesc" }, moveDesc(m.moves[i])) : null)
            : null);
      })),
      ci.storesPP
        ? h("button", { class: "btn small", onclick: () => editMon(x => { x.pp = x.moves.map((mv, i) => C.maxPP(mv, x.ppBonuses, i)); }) }, "Restore all PP")
        : h("p", { class: "note" }, "CFRU doesn't store PP for Pokémon in the PC; it's restored when you withdraw them."),
      learnable(m, lvl, ci.maxMove)),

    st.edTab !== "stats" ? null : section("Stats",
      baseStats(m.species),
      h("div", { class: "stats" },
        h("div", { class: "statrow head" }, h("span", {}), h("span", {}, "IV"), h("span", {}, "EV"), h("span", {}, "Stat")),
        STAT_ORDER.map(i => [STAT_LABELS[i], i] as const).map(([lab, i]) => h("div", { class: "statrow" },
          h("span", { class: "statlab" }, lab),
          num(`mIv${i}`, m.ivs[i], 0, 31, v => editMon(x => { x.ivs[i] = v; }), { "aria-label": `${lab} IV` }),
          num(`mEv${i}`, m.evs[i], 0, 255, v => editMon(x => { x.evs[i] = v; }), { "aria-label": `${lab} EV` }),
          h("span", { class: "statval" }, stats ? stats[i] : m.party ? m.party.stats[i] : "?"))),
        h("div", { class: `statrow foot ${evTotal > 510 ? "over" : ""}` }, h("span", {}, "Total"), h("span", {}), h("span", {}, `${evTotal}/510`), h("span", {}))),
      h("div", { class: "row tight" },
        h("button", { class: "btn small", onclick: () => editMon(x => { x.ivs = [31, 31, 31, 31, 31, 31]; }) }, "Max IVs"),
        h("button", { class: "btn small", onclick: () => editMon(x => { x.evs = [0, 0, 0, 0, 0, 0]; }) }, "Clear EVs"))),

    st.edTab !== "ot" ? null : section("Trainer & extras",
      h("div", { class: "fields cols2" },
        nameInput("mOt", "OT name", m.otName, 7, v => { m.otName = v; }),
        field("Friendship", "mFriend", num("mFriend", m.friendship, 0, 255, v => editMon(x => { x.friendship = v; })), "Max 255"),
        field("OT Trainer ID", "mTid", num("mTid", C.tid(m), 0, 65535, v => editMon(x => { x.otId = ((C.sid(x) << 16) | v) >>> 0; }))),
        field("OT Secret ID", "mSid", num("mSid", C.sid(m), 0, 65535, v => editMon(x => { x.otId = ((v << 16) | C.tid(x)) >>> 0; }))),
        field("Markings", "mMark0", h("div", { class: "marks" }, MARKS.map((mk, i) =>
          h("label", { class: `mark ${m.markings & (1 << i) ? "on" : ""}`, title: `Marking ${mk}` },
            h("input", { id: `mMark${i}`, type: "checkbox", checked: Boolean(m.markings & (1 << i)), onchange: () => editMon(x => { x.markings ^= 1 << i; }) }), mk)))),
        field("Egg", "mEgg", h("label", { class: "check" },
          h("input", { id: "mEgg", type: "checkbox", checked: m.isEgg, onchange: (e: Event) => editMon(x => { x.isEgg = (e.target as HTMLInputElement).checked; }) }),
          h("span", {}, m.isEgg ? "Is an egg" : "Hatched"))),
      ),
      h("dl", { class: "facts" },
        h("dt", {}, "Personality"), h("dd", { class: "mono" }, `0x${m.pid.toString(16).toUpperCase().padStart(8, "0")}`),
        h("dt", {}, "Met at level"), h("dd", {}, m.metLevel === 0 ? "Hatched" : String(m.metLevel)),
        h("dt", {}, "Format"), h("dd", {}, ci.label),
        m.party ? [h("dt", {}, "HP"), h("dd", {}, `${m.party.hp} / ${m.party.stats[0]}`)] : null)),
  );
}

const GROWTH = ["Medium Fast", "Erratic", "Fluctuating", "Medium Slow", "Fast", "Slow"];
function genderRatio(g: number) {
  if (g === 255) return "Genderless";
  if (g === 0) return "Always male";
  if (g >= 254) return "Always female";
  const f = (Math.round((g / 256) * 8) / 8) * 100; // the standard ratios: 12.5%, 25%, 50%, 75%, 87.5%
  return `${100 - f}% male · ${f}% female`;
}

/** The species' base stats with bars, as the game's tables define them. */
function baseStats(species: number) {
  const info = C.data().info[species];
  if (!info) return h("p", { class: "note" }, "Base stats for this species aren't known. Load the game's ROM to see them.");
  const total = info.bs.reduce((a, b) => a + b, 0);
  const abil = [...new Set(info.ab.filter(Boolean))];
  return h("div", { class: "basestats" },
    h("div", { class: "bshead" }, h("span", {}, "Base stats"), h("span", { class: "muted" }, `${C.speciesName(species)}`)),
    STAT_ORDER.map(i => {
      const lab = STAT_LABELS[i], v = info.bs[i];
      return h("div", { class: "bsrow" },
        h("span", { class: "statlab" }, lab),
        h("span", { class: "bsval" }, String(v)),
        h("span", { class: "bsbar", "aria-hidden": "true" },
          h("span", { class: `bsfill ${v >= 120 ? "hi" : v >= 80 ? "mid" : v >= 50 ? "lo" : "vlo"}`, style: `width:${Math.min(100, (v / 180) * 100)}%` })));
    }),
    h("div", { class: "bsrow total" }, h("span", { class: "statlab" }, "Total"), h("span", { class: "bsval" }, String(total)), h("span", {})),
    h("dl", { class: "facts" },
      h("dt", {}, "Type"), h("dd", {}, info.t.join(" / ")),
      h("dt", {}, "Abilities"), h("dd", {}, abil.map((a, i) => `${C.abilityName(a)}${a === info.ab[2] && a !== info.ab[0] && a !== info.ab[1] ? " (hidden)" : ""}${i < abil.length - 1 ? ", " : ""}`).join("") || "—"),
      h("dt", {}, "Growth"), h("dd", {}, info.gr === null ? "Unknown" : GROWTH[info.gr] ?? "Unknown"),
      h("dt", {}, "Gender"), h("dd", {}, genderRatio(info.g))));
}

const openDescs = new Set<string>(); // learnable moves whose description is expanded
const openGroups = new Map<string, boolean>(); // learnable-move groups the user opened or closed
/** Moves this species learns, with a button to teach each one. */
function learnable(m: C.Pokemon, lvl: number | null, maxMove: number) {
  const d = C.data(), L = d.learn;
  if (!L) return h("div", { class: "learn" }, h("h4", {}, "Moves it can learn"),
    h("p", { class: "note" }, "Load the game's ROM to see which moves this Pokémon learns."));
  const lv = L.levelUp[m.species] ?? null, teach = L.teach[m.species] ?? null, egg = L.egg[m.species] ?? null;
  const firstEmpty = m.moves.findIndex(x => x === 0);
  const slot = st.teachSlot ?? (firstEmpty >= 0 ? firstEmpty : 3);
  const known = new Set(m.moves.filter(Boolean));
  const teachBtn = (mv: number) => known.has(mv)
    ? h("span", { class: "known" }, "Known")
    : h("button", { class: "btn small", disabled: mv > maxMove, "aria-label": `Teach ${C.moveName(mv)} in slot ${slot + 1}`, onclick: () => {
        editMon(x => { x.moves[slot] = mv; x.pp[slot] = C.maxPP(mv, x.ppBonuses, slot); });
        st.teachSlot = null;
        toast(`${m.nickname || C.speciesName(m.species)} learned ${C.moveName(mv)}.`, "good");
      } }, "Teach");
  const row = (tag: string, mv: number, later = false) => {
    const key = `${tag}-${mv}`, open = openDescs.has(key), desc = moveDesc(mv);
    return h("li", { class: `learnrow ${later ? "later" : ""}` }, h("span", { class: "lrtag mono" }, tag),
      h("button", { class: "lrname mvname", type: "button", "data-type": moveType(mv) ?? "none", "aria-expanded": open ? "true" : "false",
        title: desc || undefined, onclick: () => { open ? openDescs.delete(key) : openDescs.add(key); renderAll(); } },
        h("span", { class: "mvlabel" }, C.moveName(mv)), moveStats(mv, true)),
      teachBtn(mv),
      open ? h("div", { class: "lrdesc" }, moveStats(mv), desc ? h("p", { class: "mvdesc" }, desc) : null) : null);
  };
  // remember which groups are open, since every edit re-renders the panel
  const group = (title: string, items: Node[], openByDefault: boolean, empty: string) =>
    h("details", { class: "learngroup", open: openGroups.get(title) ?? openByDefault,
      ontoggle: (e: Event) => openGroups.set(title, (e.currentTarget as HTMLDetailsElement).open) },
      h("summary", {}, `${title} · ${items.length}`),
      items.length ? h("ul", {}, items) : h("p", { class: "note" }, empty));
  const sortedTeach = teach ? [...teach].sort((a, b) => (L.tmLabel.get(a) ?? "~" + C.moveName(a)).localeCompare(L.tmLabel.get(b) ?? "~" + C.moveName(b))) : null;
  return h("div", { class: "learn" },
    h("h4", {}, "Moves it can learn"),
    h("div", { class: "teachto" }, h("span", { class: "muted small" }, "Teach into"),
      h("div", { class: "seg" }, [0, 1, 2, 3].map(i => h("button", { class: `segbtn ${slot === i ? "on" : ""}`, "aria-pressed": slot === i ? "true" : "false",
        onclick: () => { st.teachSlot = i; renderAll(); }, "data-type": moveType(m.moves[i]) ?? "none" }, `${i + 1} · ${m.moves[i] ? C.moveName(m.moves[i]) : "empty"}`)))),
    lv === null ? h("p", { class: "note" }, "Level-up moves weren't found in this ROM.")
      : group("By level", lv.map(([l, mv]) => row(l === 0 ? "Evo" : `Lv ${l}`, mv, lvl !== null && l > lvl)), true, "Learns no moves by level."),
    sortedTeach === null ? h("p", { class: "note" }, `${L.teachTitle} compatibility wasn't found in this ROM.`)
      : group(L.teachTitle, sortedTeach.map(mv => row(L.tmLabel.get(mv) ?? "Tutor", mv)), false, `Can't learn any ${L.teachTitle} moves.`),
    egg === null ? null : group("Egg moves", egg.map(mv => row("Egg", mv)), false, "Has no egg moves."));
}

function section(_title: string, ...body: Node[]) {
  return h("div", { class: "secbody", role: "tabpanel" }, body);
}

// ---------- Repair (cheat and glitch damage) ----------

let scanCache: { save: C.ParsedSave; version: number; scan: C.Scan } | null = null;
let saveVersion = 0;
function repairScan(s: C.ParsedSave): C.Scan {
  if (scanCache && scanCache.save === s && scanCache.version === saveVersion) return scanCache.scan;
  scanCache = { save: s, version: saveVersion, scan: C.scanSave(s) };
  return scanCache.scan;
}
function repairSummary(s: C.ParsedSave) {
  const n = repairScan(s).issues.length;
  return n ? `${n} problem${n > 1 ? "s" : ""}` : "No problems";
}
function openRepair() { st.view = "repair"; st.sheet = false; st.repairPick = null; st.fileMenu = false; renderAll(); }

const KIND_TITLES: [C.Issue["kind"], string][] = [
  ["bad-egg", "Bad Eggs"], ["species", "Glitch Pokémon"], ["item", "Glitch items"], ["move", "Glitch moves"],
  ["pp", "PP"], ["exp", "EXP and level"], ["stats", "Party stats"], ["ev", "EVs"], ["money", "Money and coins"],
];

function repairView(s: C.ParsedSave) {
  const { issues, notes } = repairScan(s);
  const pick = st.repairPick ?? new Set(issues.filter(i => i.recommended).map(i => i.id));
  const chosen = issues.filter(i => pick.has(i.id));
  const setPick = (next: Set<string>) => { st.repairPick = next; renderAll(); };
  const apply = () => {
    const n = C.applyIssues(s, chosen);
    st.repairPick = null; st.sel = null;
    toast(n ? `Applied ${n} fix${n > 1 ? "es" : ""}. Download the edited save to keep ${n > 1 ? "them" : "it"}.` : "Nothing was changed.", n ? "good" : "");
    if (n) touch(); else renderAll();
  };
  const groups = KIND_TITLES.map(([k, title]) => ({ title, items: issues.filter(i => i.kind === k) })).filter(g => g.items.length);
  return h("div", { class: "repair" },
    h("div", { class: "viewhead" }, h("h2", {}, "Repair"), h("span", { class: "muted" }, "Cheat and glitch damage")),
    h("p", { class: "muted small" }, "Cheat codes often write straight into a save's encrypted Pokémon data. When only the checksum or the Bad Egg flag is wrong, the Pokémon underneath can be restored. When the data itself was scrambled it can't be recovered, and deleting it frees the slot. Nothing changes until you apply, and your original file stays available under Download original."),
    notes.length ? h("ul", { class: "warnlist" }, notes.map(n => h("li", { class: "info" }, n))) : null,
    issues.length === 0
      ? h("div", { class: "card" }, h("p", { class: "okline" }, "No Bad Eggs or other cheat damage found."))
      : [
        h("div", { class: "row tight repairbar" },
          h("button", { class: "btn small", onclick: () => setPick(new Set(issues.filter(i => i.recommended).map(i => i.id))) }, "Recommended"),
          h("button", { class: "btn small", onclick: () => setPick(new Set(issues.map(i => i.id))) }, "All"),
          h("button", { class: "btn small", onclick: () => setPick(new Set()) }, "None")),
        groups.map(g => h("section", { class: "card repairgroup" },
          h("h3", {}, `${g.title} · ${g.items.length}`),
          h("ul", { class: "issuelist" }, g.items.map(is => h("li", { class: `issue ${is.remove ? "remove" : ""}` },
            h("label", { class: "issuecheck" },
              h("input", { type: "checkbox", checked: pick.has(is.id), onchange: (e: Event) => {
                const next = new Set(pick); (e.target as HTMLInputElement).checked ? next.add(is.id) : next.delete(is.id); setPick(next);
              } }),
              h("span", { class: "issuebody" },
                h("strong", {}, is.subject),
                h("span", {}, is.problem),
                h("span", { class: `issuefix ${is.remove ? "bad" : ""}` }, `Fix: ${is.fix}`)))))))),
        h("div", { class: "row repairapply" },
          h("button", { class: "btn primary", disabled: !chosen.length, onclick: apply },
            chosen.length ? `Apply ${chosen.length} fix${chosen.length > 1 ? "es" : ""}` : "Choose fixes to apply"),
          chosen.some(i => i.remove) ? h("span", { class: "muted small" }, `${chosen.filter(i => i.remove).length} Pokémon will be deleted.`) : null),
      ]);
}

function warningsPanel(s: C.ParsedSave, m: C.Pokemon | null) {
  const list: { tone: string; text: string }[] = [];
  // With another game's ROM loaded the fit score is meaningless; the banner already says to load the right ROM.
  const wrongRom = !!st.rom && !romFits(s.profile);
  s.warnings.filter(w => !(wrongRom && /read cleanly/.test(w)))
    .forEach(w => list.push({ tone: /checksum|missing|different saves|incomplete|probably/i.test(w) ? "bad" : "warn", text: w }));
  if (m && st.sel) C.validatePokemon(m, codecAt(st.sel)).forEach(w => list.push({ tone: "warn", text: w }));
  const bad = [...s.party, ...s.boxes.flatMap(b => b.slots)].filter(x => x && !x.checksumOk).length;
  if (bad) list.push({ tone: "bad", text: `${bad} Pokémon record${bad > 1 ? "s have" : " has"} a bad checksum and will appear as Bad Egg${bad > 1 ? "s" : ""}. Repair can restore or remove them.` });
  s.profile.notes.forEach(n => list.push({ tone: "info", text: n }));
  const n = repairScan(s).issues.length;
  return h("div", { class: "card checks" },
    h("div", { class: "checkshead" }, h("h3", {}, "Checks"),
      h("button", { class: `btn small ${n ? "primary" : ""}`, onclick: () => openRepair() }, n ? `Repair ${n} problem${n > 1 ? "s" : ""}` : "Scan for problems")),
    list.length
      ? h("ul", { class: "warnlist" }, list.map(w => h("li", { class: w.tone }, w.text)))
      : h("p", { class: "okline" }, "No problems found in this save."));
}

// ---------- Boot ----------

function boot() {
  if (IS_ANDROID_APP) {
    const hint = $("androidHint");
    hint.hidden = false;
    mount(hint,
      h("span", {}, "Nothing happens when you tap Open save? The Claude app on Android may not show file pickers. Open this page in Chrome instead:"),
      h("code", { class: "mono urltext" }, ARTIFACT_URL),
      h("button", { class: "btn small", onclick: async (e: Event) => {
        const b = e.currentTarget as HTMLButtonElement;
        try { await navigator.clipboard.writeText(ARTIFACT_URL); b.textContent = "Copied"; }
        catch { const r = document.createRange(); r.selectNodeContents(hint.querySelector(".urltext")!); getSelection()?.removeAllRanges(); getSelection()?.addRange(r); b.textContent = "Selected — copy it"; }
      } }, "Copy link"),
      h("a", { class: "btn small", href: ARTIFACT_URL, target: "_blank", rel: "noopener" }, "Open in browser"));
  }
  document.addEventListener("dragover", e => { if (e.dataTransfer?.types.includes("Files")) e.preventDefault(); });
  document.addEventListener("drop", e => {
    const f = e.dataTransfer?.files?.[0];
    if (f) { e.preventDefault(); openFile(f); }
  });
  $("scrim").addEventListener("click", () => closeSheet());
  document.addEventListener("keydown", e => { if (e.key === "Escape" && (st.sheet || st.moving)) { st.moving = null; closeSheet(); } });
  matchMedia("(max-width: 900px)").addEventListener?.("change", () => renderAll());
  window.addEventListener("beforeunload", e => { if (st.dirty && !st.isDemo) { e.preventDefault(); e.returnValue = ""; } });
  // Reopen the remembered ROM, if any; otherwise show the two-step start screen.
  idbGet<{ name: string; bytes: Uint8Array }>("rom").then(async saved => {
    if (saved?.bytes) await loadRom(new Uint8Array(saved.bytes), saved.name, true);
    st.booting = false;
    renderAll();
  });
  renderAll();
}

boot();
