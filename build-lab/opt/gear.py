"""Gear and jewel optimizer: made-up crafted rares.

For each slot, the explicit mods are rebuilt greedily on the current item: each step probes every affix that
still fits and keeps the one that helps most under the rules, until the affix limits are reached or nothing
helps. The current item's implicits (eldritch, corrupted, synthesised), enchants (e.g. an anoint), sockets and
quality stay, so the new item is the same item re-crafted (keep_implicits=False uses the base's own implicit
instead, and the report lists what was dropped). Limits: gear 3 prefixes + 3 suffixes with at most one bench
craft; jewels 2 + 2, no bench craft. One affix per mod group. Affixes come from PoB's own pool for the base
(spawn weights, item level), at one tier (default T2, "good crafted") and mid-range rolls; bench meta-crafts are
left out.

Slots are optimized one at a time with the others as they are; two rounds let resistances settle where they are
cheapest. A new item is applied, recalculated for real, and kept only when the whole build beats the current one
under the rules; otherwise the build is restored. Uniques and relics stay unless replace_uniques (an item saved
as a rare stays replaceable, whatever its name). Weapons keep their base. Jewel sockets: every allocated socket
that is empty or holds a rare/magic Cobalt, Crimson or Viridian jewel (cluster and abyss jewels stay); all three
bases are tried.
"""
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "market"))
import rarecost  # noqa: E402

GEAR_SLOTS = ("Weapon 1", "Weapon 2", "Helmet", "Body Armour", "Gloves", "Boots", "Amulet", "Ring 1", "Ring 2",
              "Belt")
JEWEL_BASES = ("Cobalt Jewel", "Crimson Jewel", "Viridian Jewel")
UNIQUE_RARITIES = ("UNIQUE", "RELIC")  # relics are foil uniques
QUALITY_TYPES = ("Body Armour", "Helmet", "Gloves", "Boots", "Shield", "Quiver") + (
    "Bow", "Claw", "Dagger", "Rune Dagger", "Wand", "Sceptre", "Staff", "Warstaff", "One Handed Axe",
    "Two Handed Axe", "One Handed Mace", "Two Handed Mace", "One Handed Sword", "Two Handed Sword",
    "Thrusting One Handed Sword")


def _line(text, field):
    m = re.search(rf"^{field}: *(.+)$", text or "", re.M)
    return m.group(1).strip() if m else None


def item_text(slot, base, implicits, enchants, affixes, ilvl=84, sockets=None, quality=None):
    lines = ["Rarity: RARE", f"Build-lab {slot}", base, f"Item Level: {ilvl}"]
    if quality:
        lines.append(f"Quality: {quality}")
    if sockets:
        lines.append(f"Sockets: {sockets}")
    lines.append(f"Implicits: {len(enchants) + len(implicits)}")
    lines += ["{enchant}" + e for e in enchants] + list(implicits)
    for a in affixes:
        lines += [("{crafted}" if a["crafted"] else "") + line for line in a["lines"]]
    return "\n".join(lines)


def _fits(a, chosen, max_prefix, max_suffix, max_bench):
    if any(c["group"] == a["group"] for c in chosen):
        return False
    if a["crafted"] and sum(c["crafted"] for c in chosen) >= max_bench:
        return False
    n = sum(c["type"] == a["type"] for c in chosen)
    return n < (max_prefix if a["type"] == "Prefix" else max_suffix)


def synthesize(pool, rules, slot, pool_data, implicits, enchants=(), max_prefix=3, max_suffix=3, max_bench=1,
               ilvl=84, sockets=None, quality=None, budget=None, jewel=False, key=None):
    """Greedy affix build for one slot. With a budget, an affix is only tried if the item's estimated cost
    (market/rarecost.py) still fits what's left. Returns (text, probe result, affixes)."""
    base = pool_data["base"]

    def text_for(chosen):
        return item_text(slot, base, implicits, enchants, chosen, ilvl, sockets, quality)

    chosen = []
    if budget is not None and not budget.can(budget.rare_cost(chosen, jewel=jewel), key):
        return None, {"error": "the budget can't cover even a base"}, []
    text = text_for(chosen)
    cur = pool.probe([{"item": {"slot": slot, "text": text}}])[0]
    if "error" in cur:
        return None, cur, []
    while len(chosen) < max_prefix + max_suffix:
        cands = [a for a in pool_data["affixes"] if _fits(a, chosen, max_prefix, max_suffix, max_bench)]
        if budget is not None:
            cands = [a for a in cands if budget.can(budget.rare_cost(chosen + [a], jewel=jewel), key)]
        if not cands:
            break
        texts = [text_for(chosen + [a]) for a in cands]
        results = pool.probe([{"item": {"slot": slot, "text": t}} for t in texts])
        best = None
        for a, t, r in zip(cands, texts, results):
            rate = rules.rate(cur, r)
            if rules.improves(rate) and (best is None or rate > best[0]):
                best = (rate, a, t, r)
        if not best:
            break
        _, a, text, cur = best
        chosen.append(a)
    return text, cur, chosen


def _apply_checked(pool, rules, slot, text, base_stats, main_skill):
    """Equip for real; keep it only if the build beats base_stats. Returns the new stats or None."""
    snapshot = pool.save_xml()
    try:
        after = pool.apply([{"op": "equip", "slot": slot, "text": text}])
    except ValueError:
        return None
    if rules.better(after, base_stats):
        return after
    pool.load(snapshot, main_skill)
    return None


def _describe(chosen):
    return "; ".join(" / ".join(a["lines"]) + (" (crafted)" if a["crafted"] else "") for a in chosen)


def _record(entry, base, chosen, budget, jewel, label):
    """Add what a trade check and the report need, and charge the budget for the item."""
    cost = rarecost.estimate(chosen, jewel=jewel)
    entry.update({"base": base, "estimate": cost,
                  "affixes": [{"lines": a["lines"], "crafted": a["crafted"], "group": a["group"], "tier": a["tier"]}
                              for a in chosen]})
    if budget is not None:
        budget.charge(cost, label, key=label)
    return entry


def optimize_gear(pool, rules, tier=2, ilvl=84, replace_uniques=False, slots=None, rounds=2, keep_implicits=True,
                  main_skill=None, budget=None, log=None):
    log = log if log is not None else []
    wanted = slots or GEAR_SLOTS
    for _ in range(rounds):
        changed = False
        current = {s["slot"]: s for s in pool.slots()}
        for slot in wanted:
            item = (current.get(slot) or {}).get("item")
            if not item or (item["rarity"] in UNIQUE_RARITIES and not replace_uniques):
                continue
            try:
                pool_data = pool.affix_pool(item["base"], ilvl=ilvl, tier=tier, bench=True)
            except ValueError as e:
                log.append({"step": "gear", "change": f"{slot}: skipped ({e})"})
                continue
            implicits = (item.get("implicits") or []) if keep_implicits else pool_data["implicits"]
            dropped = [] if keep_implicits else [i for i in item.get("implicits") or [] if i not in pool_data["implicits"]]
            quality = _line(item.get("text"), "Quality") or (20 if item.get("type") in QUALITY_TYPES else None)
            base_stats = pool.stats()
            text, res, chosen = synthesize(pool, rules, slot, pool_data, implicits, item.get("enchants") or [],
                                           ilvl=ilvl, sockets=_line(item.get("text"), "Sockets"), quality=quality,
                                           budget=budget, key=f"crafted {slot}")
            if not text or not rules.better(res, base_stats):
                continue
            after = _apply_checked(pool, rules, slot, text, base_stats, main_skill)
            if after is None:
                log.append({"step": "gear", "change": f"{slot}: kept the current item (the made-up one checked worse)"})
                continue
            entry = {"step": "gear", "change": f"{slot}: {item['base']} with {_describe(chosen)}",
                     "value": rules.value(after), "item": text}
            if dropped:
                entry["droppedImplicits"] = dropped
            log.append(_record(entry, item["base"], chosen, budget, False, f"crafted {slot}"))
            changed = True
            current = {s["slot"]: s for s in pool.slots()}
        if not changed:
            break
    return log


def jewel_sockets(pool):
    """Sockets the jewel optimizer may fill: allocated, empty or holding a rare/magic plain jewel."""
    out = []
    for s in pool.slots():
        if not s["socket"]:
            continue
        item = s.get("item")
        if item and (item["rarity"] not in ("RARE", "MAGIC", "NORMAL") or item.get("cluster")
                     or item["base"] not in JEWEL_BASES):
            continue
        out.append(s)
    return out


def optimize_jewels(pool, rules, tier=2, ilvl=84, rounds=2, main_skill=None, budget=None, log=None):
    log = log if log is not None else []
    pools = {b: pool.affix_pool(b, ilvl=ilvl, tier=tier, domain="Jewel") for b in JEWEL_BASES}
    for _ in range(rounds):
        changed = False
        for s in jewel_sockets(pool):
            base_stats = pool.stats()
            best = None
            for b in JEWEL_BASES:
                text, res, chosen = synthesize(pool, rules, s["slot"], pools[b], pools[b]["implicits"],
                                               max_prefix=2, max_suffix=2, max_bench=0, ilvl=ilvl, budget=budget,
                                               jewel=True, key=f"jewel {s['slot']}")
                if text and (best is None or rules.better(res, best[1])):
                    best = (text, res, chosen, b)
            if not best or not rules.better(best[1], base_stats):
                continue
            after = _apply_checked(pool, rules, s["slot"], best[0], base_stats, main_skill)
            if after is None:
                log.append({"step": "jewels", "change": f"{s['slot']}: kept the current jewel (the made-up one checked worse)"})
                continue
            log.append(_record({"step": "jewels", "change": f"{s['slot']}: {best[3]} with {_describe(best[2])}",
                                "value": rules.value(after), "item": best[0]}, best[3], best[2], budget, True,
                               f"jewel {s['slot']}"))
            changed = True
        if not changed:
            break
    return log
