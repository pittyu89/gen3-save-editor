import re, json, sys
R = sys.argv[1]
def rd(p): return open(f"{R}/{p}", encoding="utf-8").read()

def defines(text, prefix):
    d = {}
    for m in re.finditer(r"#define\s+(%s\w+)\s+(\d+|0x[0-9A-Fa-f]+)\b" % prefix, text):
        d[m.group(1)] = int(m.group(2), 0)
    return d

def enum_vals(text, prefix):
    d = {}; n = 0
    body = text
    for m in re.finditer(r"^\s*(%s\w+)\s*(?:=\s*([^,\n]+))?,?" % prefix, body, re.M):
        name, val = m.group(1), m.group(2)
        if val is not None:
            val = val.strip().rstrip(',')
            n = int(val, 0) if re.match(r"^(0x[0-9a-fA-F]+|\d+)$", val) else d.get(val, n)
        d[name] = n; n += 1
    return d

species = defines(rd("include/constants/species.h"), "SPECIES_")
moves = defines(rd("include/constants/moves.h"), "MOVE_")
abil = defines(rd("include/constants/abilities.h"), "ABILITY_")
items = enum_vals(rd("include/constants/items.h").split("ITEMS_COUNT")[0], "ITEM_")
nat = enum_vals(rd("include/constants/pokedex.h").split("};")[0], "NATIONAL_DEX_")

def names(text, prefix, consts):
    out = {}
    for m in re.finditer(r"\[(%s\w+)\]\s*=\s*_\(\"(.*?)\"\)" % prefix, text):
        if m.group(1) in consts: out[consts[m.group(1)]] = m.group(2)
    return out

sp_names = names(rd("src/data/text/species_names.h"), "SPECIES_", species)
mv_names = names(rd("src/data/text/move_names.h"), "MOVE_", moves)
ab_names = names(rd("src/data/text/abilities.h").split("gAbilityNames")[1], "ABILITY_", abil)

for m in re.finditer(r"#define\s+(ITEM_\w+)\s+(ITEM_\w+)\s*$", rd("include/constants/items.h"), re.M):
    if m.group(2) in items and m.group(1) not in items: items[m.group(1)] = items[m.group(2)]
it_names = {}
for m in re.finditer(r"\[(ITEM_\w+)\]\s*=\s*\{\s*\.name\s*=\s*_\(\"(.*?)\"\),\s*\.itemId\s*=\s*(ITEM_\w+)", rd("src/data/items.h")):
    key, nm, iid = m.groups()
    if iid not in items: continue
    tm = re.match(r"ITEM_[TH]M_(\w+)", key)
    if tm and re.match(r"^[TH]M\d\d$", nm): nm += " " + tm.group(1).replace("_", " ")
    it_names[items[iid]] = nm

# move PP
pp = {}
for m in re.finditer(r"\[(MOVE_\w+)\]\s*=\s*\{(.*?)\n    \}", rd("src/data/battle_moves.h"), re.S):
    p = re.search(r"\.pp\s*=\s*(\d+)", m.group(2))
    if p and m.group(1) in moves: pp[moves[m.group(1)]] = int(p.group(1))

growth = {"GROWTH_MEDIUM_FAST":0,"GROWTH_ERRATIC":1,"GROWTH_FLUCTUATING":2,"GROWTH_MEDIUM_SLOW":3,"GROWTH_FAST":4,"GROWTH_SLOW":5}
info = {}
txt = rd("src/data/pokemon/species_info.h")
for m in re.finditer(r"\[(SPECIES_\w+)\]\s*=\s*\n\s*\{(.*?)\n    \}", txt, re.S):
    b = m.group(2); sid = species.get(m.group(1))
    if sid is None: continue
    g = lambda k: int(re.search(r"\.%s\s*=\s*(\d+)" % k, b).group(1))
    gr = re.search(r"\.genderRatio\s*=\s*([^,]+),", b).group(1).strip()
    if gr == "MON_MALE": gv = 0
    elif gr == "MON_FEMALE": gv = 254
    elif gr == "MON_GENDERLESS": gv = 255
    else:
        pct = float(re.search(r"PERCENT_FEMALE\(([\d.]+)\)", gr).group(1)); gv = min(254, int(pct*255/100))
    ab = re.search(r"\.abilities\s*=\s*\{\s*(\w+)\s*,\s*(\w+)", b)
    ty = re.search(r"\.types\s*=\s*\{\s*TYPE_(\w+)\s*,\s*TYPE_(\w+)", b)
    info[sid] = dict(t=sorted(set([ty.group(1).title(), ty.group(2).title()]), key=[ty.group(1).title(), ty.group(2).title()].index), bs=[g("baseHP"),g("baseAttack"),g("baseDefense"),g("baseSpeed"),g("baseSpAttack"),g("baseSpDefense")],
        gr=growth[re.search(r"\.growthRate\s*=\s*(\w+)", b).group(1)], g=gv,
        ab=[abil.get(ab.group(1),0), abil.get(ab.group(2),0)])

# national dex map, species name -> NATIONAL_DEX_name
spnat = {}
for k, v in species.items():
    n = "NATIONAL_DEX_" + k[8:]
    if n in nat: spnat[v] = nat[n]

exp = []
et = rd("src/data/pokemon/experience_tables.h").split("gExperienceTables")[1]
for blk in re.findall(r"\{ //[^\n]*\n(.*?)\n    \}", et, re.S):
    exp.append([int(x) for x in re.findall(r"^\s*(\d+),", blk, re.M)])

# charmap latin
cm = {}
for line in rd("charmap.txt").split("@ Hiragana")[0].splitlines():
    m = re.match(r"^'(.|\\')'\s*=\s*([0-9A-F]{2})\s*$", line)
    if m:
        ch = "'" if m.group(1) == "\\'" else m.group(1)
        b = int(m.group(2), 16)
        if b not in cm: cm[b] = ch

maxsp = 411
out = dict(
  species=[sp_names.get(i, "?") for i in range(maxsp+1)],
  nat=[spnat.get(i, 0) for i in range(maxsp+1)],
  info=[info.get(i, dict(t=['Normal'], bs=[0]*6, gr=0, g=255, ab=[0,0])) for i in range(maxsp+1)],
  moves=[mv_names.get(i, "?") for i in range(max(mv_names)+1)],
  pp=[pp.get(i, 0) for i in range(max(mv_names)+1)],
  items=[it_names.get(i, "") for i in range(max(items.values())+1)],
  abilities=[ab_names.get(i, "?") for i in range(max(ab_names)+1)],
  exp=exp, charmap={str(k): v for k, v in sorted(cm.items())})
print(len(out["species"]), len(out["moves"]), len(out["items"]), len(out["abilities"]), len(exp), [len(e) for e in exp], len(cm), file=sys.stderr)
print(out["species"][277], out["nat"][277], out["nat"][411], out["info"][6], out["moves"][354], out["pp"][354], out["items"][376], out["abilities"][76], file=sys.stderr)
json.dump(out, open(sys.argv[2], "w"), separators=(",", ":"), ensure_ascii=False)
