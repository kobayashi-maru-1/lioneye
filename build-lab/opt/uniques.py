"""Uniques compete with rares, slot by slot.

After the gear step has crafted the best rare it can for every open slot, each candidate unique is tried in place
of that slot's item and kept only when the build is better with it under the rules. A unique is never preferred
for being a unique: it has to beat the rare the lab could craft for the same slot.

Candidates come from the caller ({slot group: [unique names]}, slot groups as popularity.SLOT_OF names, "Ring" =
either ring): the uniques ladder players of the build's skill wear (popularity.candidates) or a list the user
gave. Every candidate is screened with a probe (one parallel recalc each, the build unchanged); the best is then
equipped for real and kept only if it still wins (a two-handed weapon also empties the offhand, which a probe
can't model; a bow keeps its quiver, and quivers are tried only with a bow). One swap per round, best first, until
no candidate wins; a later swap in the same slot (or one emptying the offhand) refunds the earlier unique.

With a budget a unique must fit what's left once the slot's rare is refunded, and swaps are ranked by gain per
divine of what they add to the spend (at least MIN_COST, so a near-free swap isn't infinitely good). Without one the strongest result wins, whatever it costs. Uniques poe.ninja doesn't list
count as unavailable. Slots in `fixed` (uniques the spec named) are never swapped.
"""
import re

TWO_HANDED = frozenset({"Bow", "Staff", "Two Handed Sword", "Two Handed Axe", "Two Handed Mace", "Fishing Rod"})
GROUP_SLOTS = {"Ring": ("Ring 1", "Ring 2")}
UNIQUE_RARITIES = ("UNIQUE", "RELIC")


def _line(text, field):
    m = re.search(rf"^{field}: *(.+)$", text or "", re.M)
    return m.group(1).strip() if m else None


def with_sockets(text, sockets):
    """Unique item text with the slot's socket line, so the gems socketed there stay linked."""
    if not sockets or _line(text, "Sockets"):
        return text
    lines = text.split("\n")
    # "Rarity: UNIQUE", title, base: the socket line goes right after the base
    return "\n".join(lines[:3] + [f"Sockets: {sockets}"] + lines[3:])


def _main_links(pool):
    main = next((g for g in pool.groups() if g["main"]), None)
    if not main:
        return None, 0
    return main.get("slot"), sum(1 for g in main["gems"] if g.get("name") and g.get("enabled", True))


def _cost_key(slot):
    return f"crafted {slot}"


def _unique_key(slot):
    return f"unique:{slot}"


def trials(pool, cands, prices, budget=None, fixed=(), item_type=None, texts=None):
    """The swaps worth screening now: [{slot, name, base, text, divine, empties}], and the candidates left out
    with why ({name: reason}; only names with no swap to screen at all). empties: the swap also empties the offhand
    (a two-handed weapon; a bow keeps a quiver)."""
    texts = {} if texts is None else texts
    item_type = item_type or (lambda base: None)
    current = {s["slot"]: s.get("item") for s in pool.slots()}
    worn = {re.sub(r"^Foulborn ", "", (it.get("name") or "").split(", ")[0]) for it in current.values()
            if it and it.get("rarity") in UNIQUE_RARITIES}
    main_slot, links = _main_links(pool)
    weapon = (current.get("Weapon 1") or {}).get("type")
    offhand = (current.get("Weapon 2") or {}).get("type")
    out, reasons = [], {}
    for group, names in (cands or {}).items():
        for name in names:
            if name in worn:
                reasons[name] = "already worn"
                continue
            if name not in texts:
                try:
                    texts[name] = pool.unique_text(name)
                except ValueError as e:
                    texts[name] = {"error": str(e)}
            info = texts[name]
            if "error" in info:
                reasons[name] = info["error"]
                continue
            kind = item_type(info["base"])
            # A two-handed weapon empties the offhand (a bow keeps a quiver); any other weapon drops a quiver.
            empties = (kind in TWO_HANDED and not (kind == "Bow" and offhand == "Quiver")) or (
                group == "Weapon 1" and kind != "Bow" and offhand == "Quiver")
            for slot in GROUP_SLOTS.get(group, (group,)):
                why = None
                if slot in fixed:
                    why = f"{slot} holds a unique the spec named"
                elif slot not in current:
                    why = f"no {slot} slot"
                elif slot == "Weapon 2" and kind == "Quiver" and weapon != "Bow":
                    why = "a quiver needs a bow"
                elif slot == "Weapon 2" and kind != "Quiver" and weapon in TWO_HANDED:
                    why = "the weapon is two-handed" + (" (a bow takes a quiver)" if weapon == "Bow" else "")
                elif empties and "Weapon 2" in fixed:
                    why = "two-handed, and the offhand is a unique the spec named"
                if why:
                    reasons.setdefault(name, why)
                    continue
                main = slot == main_slot
                price = prices.unique(info["name"], base=info["base"], links=links if main and links >= 5 else None)
                if not price or price.get("divine") is None:
                    reasons[name] = "not listed on poe.ninja (unavailable)"
                    continue
                cost = price["divine"]
                was = current.get(slot) or {}
                t = {"slot": slot, "name": info["name"], "base": info["base"], "divine": cost, "empties": empties,
                     "replaces": f"{(was.get('rarity') or '').lower()} {was.get('base') or ''}".strip() or "nothing"}
                if budget is not None and cost > budget.remaining + _refund(budget, t) + 1e-9:
                    reasons[name] = f"{cost:.1f} div doesn't fit the budget"
                    continue
                sockets = _line((current.get(slot) or {}).get("text"), "Sockets")
                out.append({**t, "text": with_sockets(info["text"], sockets)})
    screened = {t["name"] for t in out}
    return out, {k: v for k, v in reasons.items() if k not in screened}


def _keys(t):
    """Budget keys a swap frees: the slot's rare or earlier unique, and the offhand's when it empties it."""
    keys = [_cost_key(t["slot"]), _unique_key(t["slot"])]
    if t["empties"]:
        keys += [_cost_key("Weapon 2"), _unique_key("Weapon 2")]
    return keys


def _refund(budget, t):
    return sum(budget.available(k) - budget.remaining for k in _keys(t))


def _net_cost(budget, t):
    """What a swap adds to the spend: the unique's price minus what it frees."""
    return t["divine"] if budget is None else t["divine"] - _refund(budget, t)


def _buy(budget, t):
    if budget is None:
        return
    for k in _keys(t):
        if k != _unique_key(t["slot"]):
            budget.charge(0.0, f"{k} (freed by {t['name']})", k)
    budget.charge(t["divine"], f"unique {t['name']}", _unique_key(t["slot"]))


MIN_COST = 0.05  # divines: a near-free swap still ranks by its gain, not as infinitely good


def _per_divine(rules, base, r, net):
    cls, primary, secondary = rules.rate(base, r, cost=1)
    cost = max(net, MIN_COST)
    return (cls, primary / cost, secondary / cost)


def compete(pool, rules, cands, prices, budget=None, fixed=(), item_type=None, main_skill=None, log=None,
            max_swaps=6):
    """Swap in candidate uniques where they beat the slot's current item. Returns {"swaps": [...], "tried": n,
    "skipped": {name: reason}, "results": [{slot, name, divine, gain, beats, decidedBy, ehp, moved}]}: each
    unique's last screen against the build as it stood (gain = relative change in the metric only; beats = better
    under the rules; decidedBy = what decided it: rules, floors, damage or same; ehp = relative EHP change; moved =
    the rules whose shortfall changed, readable). Swaps carry the same why fields. Log entries are added to `log`."""
    log = log if log is not None else []
    texts, tried, swaps, skipped, results_by = {}, set(), [], {}, {}
    for _ in range(max_swaps):
        base = pool.stats()
        ts, sk = trials(pool, cands, prices, budget, fixed, item_type, texts)
        skipped.update({k: v for k, v in sk.items() if k not in {s["name"] for s in swaps}})
        if not ts:
            break
        results = pool.probe([{"item": {"slot": t["slot"], "text": t["text"]}} for t in ts])
        tried.update(t["name"] for t in ts)
        ranked = []
        for t, r in zip(ts, results):
            if "error" in r:
                skipped[t["name"]] = f"PoB couldn't calculate it in {t['slot']}: {r['error'][:120]}"
                continue
            beats = rules.better(r, base)
            gain = rules.value(r) / max(rules.value(base), 1e-9) - 1
            prev = results_by.get(t["name"])
            if prev is None or prev["round"] < len(swaps) or gain > prev["gain"]:
                results_by[t["name"]] = {"slot": t["slot"], "name": t["name"], "against": t["replaces"],
                                         "divine": round(t["divine"], 3),
                                         "gain": round(gain, 4), "beats": beats, "round": len(swaps),
                                         **_why(rules, base, r),
                                         **({"broken": sorted(rules.hard_shortfalls(r))}
                                            if rules.hard_shortfalls(r) else {})}
            if not beats:
                continue
            key = _per_divine(rules, base, r, _net_cost(budget, t)) if budget is not None else None
            ranked.append((t, r, key))
        if budget is not None:
            ranked.sort(key=lambda x: x[2], reverse=True)
        else:
            ranked = _sort_best(rules, ranked)
        done = False
        for t, r, _ in ranked:
            snapshot = pool.save_xml()
            ops = [{"op": "equip", "slot": t["slot"], "text": t["text"]}]
            if t["empties"]:
                ops.append({"op": "unequip", "slot": "Weapon 2"})
            try:
                after = pool.apply(ops)
            except ValueError:
                pool.load(snapshot, main_skill)
                continue
            if not rules.better(after, base):
                pool.load(snapshot, main_skill)
                continue
            net = _net_cost(budget, t)
            _buy(budget, t)
            why = _why(rules, base, after)
            entry = {"step": "uniques", "change": f"{t['slot']}: {t['name']}", "divine": round(t["divine"], 3),
                     "value": rules.value(after), "before": rules.value(base), "decidedBy": why["decidedBy"],
                     **({"netDivine": round(net, 3)} if budget is not None else {})}
            log.append(entry)
            swaps[:] = [x for x in swaps if x["slot"] != t["slot"] and not (t["empties"] and x["slot"] == "Weapon 2")]
            swaps.append({"slot": t["slot"], "name": t["name"], "replaced": t["replaces"], "divine": t["divine"],
                          "gain": rules.value(after) / max(rules.value(base), 1e-9) - 1, **why})
            done = True
            break
        if not done:
            break
    kept = {s["name"] for s in swaps}
    for name in kept:
        skipped.pop(name, None)
    results = sorted(({k: v for k, v in r.items() if k != "round"} for r in results_by.values() if r["name"] not in kept),
                     key=lambda r: -r["gain"])
    return {"swaps": swaps, "tried": len(tried), "skipped": skipped, "results": results}


def _why(rules, base, r):
    """Why a unique won or lost, for the report: decidedBy, ehp and the rules it moved (the damage change is
    already `gain`)."""
    w = rules.why(base, r)
    return {"decidedBy": w["decidedBy"], "ehp": w["ehp"], **({"moved": w["moved"]} if w.get("moved") else {})}


def _sort_best(rules, ranked):
    """Best first by the rules (no budget): a plain sort with rules.better as the order."""
    import functools
    return sorted(ranked, key=functools.cmp_to_key(
        lambda a, b: -1 if rules.better(a[1], b[1]) else (1 if rules.better(b[1], a[1]) else 0)))
