"""What a build costs to put together, in divines, from a loaded Evaluator/EvalPool.

- Uniques: poe.ninja (ninja.Prices.unique), with the item's link count for linked armour/weapons. Foil uniques
  (PoB rarity RELIC) are priced as the normal unique and flagged as a floor.
- Gems: poe.ninja at the gem's level and quality, or a level 1 copy at that quality levelled by the player when
  that's cheaper (not for awakened or exceptional gems). Enabled, socketed gems only; groups PoB makes for item-,
  tree- or config-granted skills are skipped. A gem poe.ninja doesn't list goes to "unpriced".
- Rare/magic gear and rare jewels: the trade site when trade checks are on (trade.Trade), else unpriced. Local mods
  on weapons and armour are matched to the trade site's "(Local)" stats. A price from listings that lack some of
  the item's mods is marked as a floor; one where too few mods could be matched is left unpriced. Cluster jewels
  stay unpriced (their notables don't map to trade stats).
Anything that can't be priced is listed under "unpriced", never guessed.
"""
import re

from ninja import is_rare_gem

GEAR = ("Weapon 1", "Weapon 2", "Helmet", "Body Armour", "Gloves", "Boots", "Amulet", "Ring 1", "Ring 2", "Ring 3",
        "Belt", "Flask 1", "Flask 2", "Flask 3", "Flask 4", "Flask 5")
ARMOUR_TYPES = ("Body Armour", "Helmet", "Gloves", "Boots", "Shield")
WEAPON_TYPES = ("Bow", "Claw", "Dagger", "Rune Dagger", "Wand", "Sceptre", "Staff", "Warstaff", "One Handed Axe",
                "Two Handed Axe", "One Handed Mace", "Two Handed Mace", "One Handed Sword", "Two Handed Sword",
                "Thrusting One Handed Sword", "Fishing Rod")
ARMOUR_LOCAL = re.compile(r"\b(Armour|Evasion|Energy Shield|Ward)\b")
TAG = re.compile(r"\{[^}]*\}")
# Lines after the mods that describe the item rather than add a mod.
FLAG_LINE = re.compile(r"^(Corrupted|Mirrored|Split|Unidentified|Foil Unique.*|Fractured Item|Synthesised Item|"
                       r"\w+ Item|Has Alt Variant.*|Selected Variant.*)$")


def parse_item(text):
    """PoB raw item text -> {rarity, name, base, links, implicits, explicit, crafted}."""
    lines = (text or "").replace("\r", "").split("\n")
    out = {"rarity": None, "name": None, "base": None, "links": 0, "implicits": [], "explicit": [], "crafted": []}
    if not lines or not lines[0]:
        return out
    if lines[0].startswith("Rarity:"):
        out["rarity"] = lines[0].split(":", 1)[1].strip().upper()
    header = lines[1:]
    if out["rarity"] in ("RARE", "UNIQUE", "RELIC"):
        out["name"], out["base"] = (header[0] if header else None), (header[1] if len(header) > 1 else None)
    else:
        out["base"] = header[0] if header else None
    start, n_imp = None, 0
    for i, l in enumerate(lines):
        m = re.match(r"Sockets: (.+)", l)
        if m:
            out["links"] = max(len(g.split("-")) for g in m.group(1).split())
        m = re.match(r"Implicits: (\d+)", l)
        if m:
            n_imp, start = int(m.group(1)), i + 1
            break
    if start is None:
        return out
    out["implicits"] = [TAG.sub("", l) for l in lines[start:start + n_imp]]
    for l in lines[start + n_imp:]:
        clean = TAG.sub("", l).strip()
        if not clean or FLAG_LINE.match(clean):
            continue
        (out["crafted"] if "{crafted}" in l else out["explicit"]).append(clean)
    return out


def local_flags(item_type, lines):
    """Which mod lines are local to the item (prefer the trade site's "(Local)" stat)."""
    if item_type in WEAPON_TYPES:
        return [True] * len(lines)
    if item_type in ARMOUR_TYPES:
        return [bool(ARMOUR_LOCAL.search(l)) for l in lines]
    return [False] * len(lines)


def price_build(pool, prices, trade=None):
    items, gems, unpriced = [], [], []
    for s in pool.slots():
        slot, item = s["slot"], s.get("item")
        if not item or not (slot in GEAR or s.get("socket")):
            continue
        info = parse_item(item.get("text"))
        rarity = item.get("rarity")
        label = info["name"] or item.get("name") or item.get("base")
        row = {"slot": slot, "name": label, "base": item.get("base"), "rarity": rarity}
        if rarity in ("UNIQUE", "RELIC"):
            p = prices.unique(label, base=item.get("base"), links=info["links"] or None)
            if not p:
                unpriced.append(f"{slot}: {label} (not on poe.ninja)")
                continue
            row.update({"divine": p["divine"], "source": "poe.ninja", "variant": p.get("variant"),
                        "listings": p.get("listings")})
            if rarity == "RELIC":
                row["floor"] = "foil, priced as the normal unique"
        elif item.get("cluster") or (item.get("base") or "").endswith("Cluster Jewel"):
            unpriced.append(f"{slot}: {label} (cluster jewel; not priced)")
            continue
        elif trade is not None and rarity in ("RARE", "MAGIC") and info["explicit"]:
            try:
                t = trade.price(item.get("base"), info["explicit"], info["crafted"],
                                local_flags(item.get("type"), info["explicit"]))
            except RuntimeError as e:
                unpriced.append(f"{slot}: {label} (trade check failed: {e})")
                continue
            if t["divine"] is None:
                unpriced.append(f"{slot}: {label} ({t.get('reason') or 'nothing comparable listed'})")
                continue
            row.update({"divine": t["divine"], "source": "trade", "listings": t["listings"], "url": t["url"],
                        "matching": t["need"]})
            if t.get("floor"):
                row["floor"] = f"listings have {t['need']}"
            if t["unmatched"]:
                row["unmatched"] = t["unmatched"]
        else:
            if rarity in ("RARE", "MAGIC"):
                unpriced.append(f"{slot}: {label} ({rarity.lower()}; trade check off)")
            continue
        items.append(row)
    for g in pool.groups():
        if not g["enabled"] or g.get("source"):
            continue
        for gem in g["gems"]:
            if not gem["enabled"] or not gem["name"]:
                continue
            p = prices.gem(gem["name"], gem.get("level") or 1, gem.get("quality") or 0,
                           self_level=not is_rare_gem(gem["name"]))
            if p and p.get("divine") is not None:
                gems.append({"gem": gem["name"], "level": gem.get("level"), "quality": gem.get("quality"),
                             "divine": p["divine"], **({"relaxed": p["relaxed"]} if p.get("relaxed") else {})})
            else:
                unpriced.append(f"gem: {gem['name']} {gem.get('level')}/{gem.get('quality')} (not on poe.ninja)")
    total = sum(r["divine"] for r in items) + sum(g["divine"] for g in gems)
    return {"league": prices.league, "divineInChaos": prices.divine, "total": round(total, 2),
            "items": sorted(items, key=lambda r: -r["divine"]), "gems": sorted(gems, key=lambda g: -g["divine"]),
            "unpriced": unpriced}
