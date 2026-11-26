"""Gear and jewel optimizer: made-up crafted rares.

For each slot, the explicit mods are rebuilt greedily on the current item: each step probes every affix that
still fits and keeps the one that helps most under the rules, until the affix limits are reached or nothing
helps. The current item's implicits (eldritch, corrupted, synthesised), enchants (e.g. an anoint), sockets and
quality stay, so the new item is the same item re-crafted (keep_implicits=False uses the base's own implicit
instead, and the report lists what was dropped). Limits: gear 3 prefixes + 3 suffixes with at most one bench
craft; jewels 2 + 2, no bench craft. One affix per mod group. Affixes come from PoB's own pool for the base
(spawn weights, item level), at one tier (default T2, "good crafted") and mid-range rolls; bench meta-crafts are
left out. With a budget, each mod group is also offered one tier lower (the cost estimate decides what fits), and
upgrade_tiers() then raises single affixes a tier at a time, best gain per divine first, while the budget allows:
what a rare costs depends on which mods it has and how they combine (market/rarecost.py), so the budget, not a
tier cap, decides where T1 mods go.

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
                  "affixes": [{"lines": a["lines"], "crafted": a["crafted"], "group": a["group"], "tier": a["tier"],
                               "type": a.get("type")} for a in chosen]})
    if budget is not None:
        budget.charge(cost, label, key=label)
    return entry


def _pool(pool, base, ilvl, tier, budget, domain="Explicit", bench=False):
    """The affix pool at `tier`; with a budget also one tier lower (one affix per group still applies)."""
    data = pool.affix_pool(base, ilvl=ilvl, tier=tier, domain=domain, bench=bench)
    if budget is not None:
        lower = pool.affix_pool(base, ilvl=ilvl, tier=tier + 1, domain=domain)
        have = {(a["group"], a["tier"]) for a in data["affixes"]}
        data = {**data, "affixes": data["affixes"] + [a for a in lower["affixes"]
                                                      if (a["group"], a["tier"]) not in have]}
    return data


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
                pool_data = _pool(pool, item["base"], ilvl, tier, budget, bench=True)
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
    pools = {b: _pool(pool, b, ilvl, tier, budget, domain="Jewel") for b in JEWEL_BASES}
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


UPGRADE_ROUNDS = 20
UPGRADES_PER_ROUND = 3   # applied per round, in different slots, each checked for real


def crafted_items(pool, log):
    """Slot -> the log entry of the crafted rare still equipped there (the last one per slot)."""
    last = {}
    for c in log:
        if c.get("step") in ("gear", "jewels") and c.get("affixes") is not None and c.get("base"):
            last[c["change"].split(":")[0]] = c
    out = {}
    for s in pool.slots():
        item, c = s.get("item"), last.get(s["slot"])
        if c and item and (item.get("name") or "").startswith("Build-lab") and item["base"] == c["base"]:
            out[s["slot"]] = (c, s)
    return out


def upgrade_tiers(pool, rules, budget, ilvl=84, main_skill=None, log=None, rounds=UPGRADE_ROUNDS):
    """Raise crafted affixes one tier at a time (T3 -> T2 -> T1), best gain per extra divine first, while the
    budget allows. Every upgrade is applied and kept only if the whole build gets better."""
    log = log if log is not None else []
    cache = {}

    def tier_pool(base, tier, jewel):
        key = (base, tier, jewel)
        if key not in cache:
            data = pool.affix_pool(base, ilvl=ilvl, tier=tier, domain="Jewel" if jewel else "Explicit")
            cache[key] = {a["group"]: a for a in data["affixes"]}
        return cache[key]

    for _ in range(rounds):
        items = crafted_items(pool, log)
        base_stats = pool.stats()
        cands = []
        for slot, (c, s) in items.items():
            jewel = c["step"] == "jewels"
            key = f"jewel {slot}" if jewel else f"crafted {slot}"
            old = c["affixes"]
            old_cost = rarecost.estimate(old, jewel=jewel)
            for i, a in enumerate(old):
                if a["crafted"] or (a.get("tier") or 1) <= 1:
                    continue
                better = tier_pool(c["base"], a["tier"] - 1, jewel).get(a["group"])
                if not better or better["tier"] >= a["tier"]:
                    continue
                new = old[:i] + [{"lines": better["lines"], "crafted": False, "group": a["group"],
                                  "tier": better["tier"], "type": a.get("type")}] + old[i + 1:]
                cost = rarecost.estimate(new, jewel=jewel)
                if not budget.can(cost, key):
                    continue
                item = s["item"]
                text = item_text(slot, c["base"], item.get("implicits") or [], item.get("enchants") or [], new, ilvl,
                                 _line(item.get("text"), "Sockets"), _line(item.get("text"), "Quality"))
                cands.append({"slot": slot, "key": key, "jewel": jewel, "entry": c, "affixes": new, "text": text,
                              "extra": max(cost - old_cost, 0.0)})
        if not cands:
            break
        results = pool.probe([{"item": {"slot": c["slot"], "text": c["text"]}} for c in cands])
        ranked = []
        for c, r in zip(cands, results):
            rate = rules.rate(base_stats, r, max(1.0, c["extra"] * 100))   # per centi-divine
            if rules.improves(rate):
                ranked.append((rate, c))
        ranked.sort(key=lambda t: t[0], reverse=True)
        done, moved = set(), False
        for _, c in ranked:
            if len(done) >= UPGRADES_PER_ROUND:
                break
            cost = rarecost.estimate(c["affixes"], jewel=c["jewel"])
            if c["slot"] in done or not budget.can(cost, c["key"]):
                continue
            now = pool.stats()
            after = _apply_checked(pool, rules, c["slot"], c["text"], now, main_skill)
            if after is None:
                continue
            done.add(c["slot"])
            moved = True
            entry = {"step": c["entry"]["step"], "change": f"{c['slot']}: {c['entry']['base']} with "
                                                           f"{_describe(c['affixes'])} (tier upgrade)",
                     "value": rules.value(after), "item": c["text"]}
            log.append(_record(entry, c["entry"]["base"], c["affixes"], budget, c["jewel"], c["key"]))
        if not moved:
            break
    return log


def tier_pools(pool, base, jewel=False, ilvl=84):
    """{tier: affix pool at roll 0} for every tier the base's mod groups have: what rarecost.match_tiers reads a
    finished item's lines back against. ilvl matches the crafting default (84), so tier numbers mean the same on
    both sides: an item-level-86 top roll reads as T1, as the lab's best would."""
    domain = "Jewel" if jewel else "Explicit"
    first = pool.affix_pool(base, ilvl=ilvl, tier=1, roll=0, domain=domain)
    deepest = max((a.get("tiers") or 1 for a in first["affixes"]), default=1)
    out = {1: first}
    for t in range(2, deepest + 1):
        out[t] = pool.affix_pool(base, ilvl=ilvl, tier=t, roll=0, domain=domain)
    return out
