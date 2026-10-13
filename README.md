# Gen III Save Editor

A browser-only save editor for GBA Pokémon games and the two main ROM hack engines. Open a `.sav`, edit it, download the edited `.sav`. Nothing is uploaded. A hack's ROM can optionally be loaded so the editor reads that hack's own species, moves, items and abilities; the ROM is only read, never modified or sent anywhere.

## Supported games and engines

| Profile | Game code | Record format | Layout source |
|---|---|---|---|
| ruby-us, sapphire-us | AXVE / AXPE | Gen III | pret/pokeruby |
| emerald-us | BPEE | Gen III | pret/pokeemerald |
| firered-us, leafgreen-us | BPRE / BPGE | Gen III | pret/pokefirered |
| pex-modern | BPEE | pokeemerald-expansion 1.8 → 1.17 | rh-hideout/pokeemerald-expansion (tags 1.8.0–1.17.1) |
| pex-legacy | BPEE | pokeemerald-expansion 1.0 → 1.7 | same repo, tags 1.0.0–1.7.x |
| cfru | BPRE | CFRU (Complete FireRed Upgrade) | Skeli789/Complete-Fire-Red-Upgrade |

Western-language releases (EU, Rev 1) share the vanilla layouts. Japanese saves are not supported (different text table).

### What differs per engine

- **pokeemerald-expansion 1.8+** packs the Growth/Attacks blocks with bitfields: 11-bit species with a 5-bit Tera type, 10-bit item, 21-bit EXP, 11-bit moves, 7-bit PP, 6-bit ball, characters 11–12 of the nickname, a 2-bit ability number (hidden ability = 2), a shiny modifier bit and a nature (mint) modifier. Species are numbered nationally. The bit positions were confirmed by compiling the structs with gcc.
- **pokeemerald-expansion 1.0–1.7** keeps vanilla-size fields but moves the ball into the Growth block and uses a 2-bit ability number.
- Both expansion formats keep Emerald's SaveBlock prefix (trainer, key, party, money, coins) and PC layout. Later SaveBlock fields depend on each hack's config, so Battle Points are not offered.
- **CFRU** uses 0xFF0 data bytes per sector and stores 25 PC boxes as 58-byte compressed, unencrypted records: boxes 1–19 in storage, 20–22 in flash sectors 30–31, 23–24 in SaveBlock1 at 0x1F08, and 25 in SaveBlock2 at 0xB0. The normal ability slot comes from PID bit 0, and the IV word's top bit marks the hidden ability. PC records carry no PP, contest stats or ribbons, as in the game.

### Engine detection

A save doesn't say which engine wrote it. `detect()` reads the save with every profile of the detected family (RS / E / FRLG from SaveBlock2 0xAC) and scores how plausible the decoded Pokémon are: checksums, species and move ranges, ball, EXP versus party level. The best fit is suggested and the scores are shown on the Trainer page. If the chosen profile reads fewer than 75% of records cleanly, export asks for confirmation, because writing with the wrong layout can corrupt a save.

A hack that changes these layouts beyond what the engine does by default will show a low fit. Treat that as unsupported.

### ROM data

`loadRomData()` finds tables in any Gen III ROM without knowing the hack:

- Name tables are located from entries every engine keeps (Bulbasaur/Ivysaur/Venusaur, Pound/Karate Chop/Double Slap, Master/Ultra/Great Ball, Stench/Drizzle/Speed Boost). Both inline-name tables (vanilla, CFRU) and records holding name pointers (expansion) are handled.
- The base-stats table is found from Bulbasaur–Charmander's stats. Field offsets for gender ratio, growth rate, abilities (u8 or u16, with or without a hidden slot) and types are learned by matching values that are identical across engines.
- Move PP comes from the move record (expansion) or a separate battle-move table (vanilla, CFRU).

Without a ROM, hack profiles fall back to Gen III data (indexed nationally for expansion), and the UI says so.

## Run and build

```
npm install
npm test            # vitest, core logic
npm run build       # dist/ (website) + dist-artifact/index.html (Claude artifact)
npm run dev         # build and serve dist/ locally
```

`dist/` is a plain static site: one `index.html` with everything inlined, a web app manifest and icon (so it can be added to a phone's home screen), and a service worker that keeps it working offline after the first visit. Desktop Chrome/Edge save through the "Save As" dialog; phones and other browsers download the `.sav` directly. Inside a Claude artifact, downloads arrive as a `.zip` because that host only allows common file types.

## Deploy to Vercel

1. Push this repo to GitHub.
2. In Vercel, choose **Add New → Project**, import the repo, and keep the defaults. `vercel.json` sets the build command (`npm run build`) and output folder (`dist`).
3. Every push to `main` redeploys.

Any static host works the same way: run `npm run build` and serve `dist/`.

## Layout

```
src/core/            pure TypeScript, no DOM
  binary.ts          little-endian read/write, sector checksum
  text.ts            Gen III Western charmap codec (0xFF terminator)
  data.ts            GameData model, built-in tables, EXP formulas
  gamedata.json      extracted from pokeemerald (scratch/extract.py)
  rom.ts             ROM table discovery
  profiles.ts        per-game/engine offsets, sector sizes, box locations
  gen3/save.ts       sectors, slots, detect / parse / write / verify, engine ranking
  gen3/pokemon.ts    record codecs (vanilla, expansion ×2, CFRU party/PC), stats, PID tools
  zip.ts             store-only ZIP writer
  fixtures.ts        synthetic save builder (tests + demo save)
src/ui/              vanilla DOM UI, bundled with esbuild
tests/               core tests and a synthetic ROM builder
```

## Profile format

See `GameProfile` in `src/core/profiles.ts`. Offsets are relative to reconstructed blocks: `sb2` (section 0), `sb1` (sections 1–4), `storage` (sections 5–13) and `ext` (raw extra sectors, CFRU only). `chunk` is how many bytes of each sector belong to the blocks; `sectionSizes` is how many bytes each checksum covers. `boxSlot`, `boxName` and `wallpaper` map a box position to a block and offset, so a new engine can spread boxes anywhere. `partyCodec` and `boxCodec` pick the record format.

## How saving works

- Both slots are read; the newest slot whose 14 sections all pass their checksum is opened. You can switch slots in the top bar. Custom save signatures are accepted when all 14 sectors agree.
- Untouched Pokémon records, names and unknown bytes are written back byte-for-byte; an unchanged export is identical to the input. Edited records keep bits the editor doesn't model (Tera type, evolution trackers, hyper training, ribbons).
- Edited Pokémon are re-encoded with a fresh checksum; edited party members get level, stats and HP recalculated when base stats are known.
- Every section checksum in the active slot is recomputed, then the output is re-read and verified before it is offered.

## Not done yet / TODO

- Not tested against real hack saves or ROMs. The formats come from the engines' source and are covered by synthetic tests; try an edited copy in an emulator before trusting it.
- Expansion hacks built on pokefirered-expansion, and older non-expansion hacks with custom engines, aren't profiled.
- Radical Red is CFRU-based but its source isn't public, so whether it changes CFRU's layout is unknown; the fit score will show it.
- Hyper training is kept but not editable; stats ignore it. Dynamax level, Gigantamax and Tera type are kept but not editable.
- Bag and PC item editing, event flags/vars, daycare, Frontier data, berries.
- RS SaveBlock1 size (0x3AC0) is unverified; the full-length checksum is also accepted, which is equivalent because the game zero-fills sectors.
- Changing nature/gender/shininess (and CFRU's ability slot) rerolls the PID, which also changes Unown's letter and Spinda's spots.
- No legality checking by design.
