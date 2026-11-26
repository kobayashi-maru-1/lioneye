"""Gem link optimizer for the main skill group.

Coordinate ascent: for each enabled support slot in the main group, try every support PoB allows on the main
skill (support_trials, one recalc each) and keep the best when it beats the current gem under the rules.
Repeat until a round changes nothing. With `links`, empty links are filled first (best support appended, one at
a time).

Without a budget, awakened and exceptional supports (Empower, Enlighten, Enhance, ...) are left out unless
allowed. With a budget (market/budget.py), every support costs its poe.ninja price at the level and quality the
optimizer uses (natural maximum, quality 20): only those that fit what's left are tried, and each one put in is
charged. awakened/exceptional are then allowed by default, since the budget already limits them.

drop_side_skills turns off auras, heralds and other side skills, one at a time, only while mana or life
reservation is overdrawn and turning one off cuts the overdraw and is better under the rules.
"""
import re

QUALITY = 20
# Trigger supports whose trigger condition PoB takes as always met (being stunned, taking a set amount of damage,
# dying), so it credits them with damage a real character rarely sees. Never picked; one the build already has
# stays where it is.
UNRELIABLE_TRIGGERS = frozenset({"Cast when Stunned", "Cast when Damage Taken", "Cast on Death"})


def _candidates(pool, allow_awakened, allow_exceptional, budget=None, key=None):
    out = []
    for s in pool.compatible_supports_info():
        if re.sub(r" Support$", "", s["name"]) in UNRELIABLE_TRIGGERS:
            continue
        if not allow_awakened and s["awakened"]:
            continue
        if not allow_exceptional and s["exceptional"]:
            continue
        if budget is not None and not budget.can(budget.gem_cost(s["name"], s.get("maxLevel") or 20, QUALITY,
                                                                 rare=s["awakened"] or s["exceptional"]), key):
            continue
        out.append(s)
    return out


def _main_group(pool):
    return next(g for g in pool.groups() if g["main"])


def _best(pool, rules, base, index, cands):
    """Best support for slot `index` among cands: (info, result) when it beats `base`, else None."""
    if not cands:
        return None
    trials = [{"index": index, "name": c["name"], "quality": QUALITY, "enabled": True} for c in cands]
    results = pool.support_trials(trials)
    best = None
    for c, r in zip(cands, results):
        if "error" in r:
            continue
        if best is None or rules.better(r, best[1]):
            best = (c, r)
    if best and rules.better(best[1], base):
        return best
    return None


def _buy(budget, info, log_entry, key, owned=()):
    """Charge a support put in. A gem the build already had (in any group at the start) costs nothing."""
    if budget is not None:
        if info["name"] in owned:
            cost, what = 0.0, f"gem {info['name']} (already owned)"
        else:
            cost = budget.gem_cost(info["name"], info.get("maxLevel") or 20, QUALITY,
                                   rare=info["awakened"] or info["exceptional"])
            what = f"gem {info['name']}"
        budget.charge(cost, what, key)
        log_entry["divine"] = round(cost, 3)
    return log_entry


def optimize_gems(pool, rules, links=None, allow_awakened=None, allow_exceptional=None, rounds=4, budget=None,
                  log=None, owned=None, keep=()):
    """owned: gem names that cost nothing (default: every gem in the build at the start). A concept built from
    nothing passes an empty set, since its starting gems are bought too. keep: support names never replaced (a
    totem, trap, mine or trigger support that decides how the skill is used)."""
    log = log if log is not None else []
    # Default: off without a budget, on with one (the budget prices them).
    allow_awakened = (budget is not None) if allow_awakened is None else allow_awakened
    allow_exceptional = (budget is not None) if allow_exceptional is None else allow_exceptional
    group = _main_group(pool)
    if owned is None:
        owned = {g["name"] for grp in pool.groups() for g in grp["gems"] if g.get("name")}
    if links:
        while len(group["gems"]) < links:
            base = pool.stats()
            index = len(group["gems"]) + 1
            pick = _best(pool, rules, base, index,
                         _candidates(pool, allow_awakened, allow_exceptional, budget, f"gem:{index}"))
            if not pick:
                break
            pool.apply([{"op": "gem", "group": "main", "name": pick[0]["name"], "quality": QUALITY}])
            log.append(_buy(budget, pick[0], {"step": "gems", "change": f"added {pick[0]['name']}",
                                              "value": rules.value(pick[1])}, f"gem:{index}", owned))
            group = _main_group(pool)
    for _ in range(rounds):
        changed = False
        for gem in [g for g in group["gems"] if g["support"] and g["enabled"] and g["name"] not in (keep or ())]:
            base = pool.stats()
            key = f"gem:{gem['index']}"
            pick = _best(pool, rules, base, gem["index"],
                         _candidates(pool, allow_awakened, allow_exceptional, budget, key))
            if pick:
                pool.apply([{"op": "gem", "group": "main", "index": gem["index"], "name": pick[0]["name"],
                             "quality": QUALITY}])
                log.append(_buy(budget, pick[0], {"step": "gems", "change": f"slot {gem['index']}: {gem['name']} -> "
                                                  f"{pick[0]['name']}", "value": rules.value(pick[1])}, key, owned))
                changed = True
                group = _main_group(pool)
        if not changed:
            break
    return log


def _side_skills(pool):
    """(group index, gem index, name) for each active gem the lab may turn off: outside the main group, socketed
    (not granted by an item, the tree or config), enabled, and not on the weapon swap."""
    out = []
    for g in pool.groups():
        if g["main"] or not g["enabled"] or g.get("source") or "Swap" in (g.get("slot") or ""):
            continue
        for gem in g["gems"]:
            if gem.get("name") and gem["enabled"] and not gem["support"]:
                out.append((g["index"], gem["index"], gem["name"]))
    return out


RESERVATION = ("warn:Your unreserved Mana", "warn:Your unreserved Life")


def _overdraw(rules, r):
    """The reservation part of a result's hard shortfalls (unreserved mana negative, unreserved life below 1)."""
    return sum(v for k, v in rules.hard_shortfalls(r).items() if k.startswith(RESERVATION))


def _toggle(pool, gi, idx, on):
    return pool.apply([{"op": "gem-enable", "group": gi, "index": idx, "enabled": on}])


def _refund(pool, budget, gi, name, log_entry):
    """A turned-off skill isn't bought; nor are the supports of a group left with no active skill."""
    if budget is None:
        return
    g = next((g for g in pool.groups() if g["index"] == gi), None)
    if g is None:
        return
    idle = not any(x["enabled"] and not x["support"] for x in g["gems"] if x.get("name"))
    back = 0.0
    for x in g["gems"]:
        if x.get("name") and (not x["enabled"] or (idle and x["support"])):
            key = f"group:{gi}:gem:{x['index']}"
            back += budget.available(key) - budget.remaining
            budget.charge(0.0, f"gem {x['name']} (not used)", key)
    log_entry["refund"] = round(back, 3)


def drop_side_skills(pool, rules, log=None, max_drops=10, budget=None):
    """Turn off side skills (auras, heralds, golems, ...) while the build overdraws its mana or life reservation
    and turning one off cuts the overdraw and is better under the rules. The gear and tree steps can only add mana;
    no other step removes a skill. Other broken rules (attributes, resists) never start a drop: a skill's attribute
    requirement only counts while it's on, so they would remove whatever skill asks the most. One skill per round,
    the best of all tried; stops when none helps, nothing is overdrawn, or after max_drops. Never touches the main
    group or the weapon swap. With a budget, turned-off skills (and supports left with nothing to support) are
    refunded."""
    log = log if log is not None else []
    for _ in range(max_drops):
        base = pool.stats()
        over = _overdraw(rules, base)
        if over <= 0:
            break
        best = None
        for gi, idx, name in _side_skills(pool):
            try:
                r = _toggle(pool, gi, idx, False)
            except ValueError:
                r = None
            finally:
                _toggle(pool, gi, idx, True)
            if r is None or _overdraw(rules, r) >= over:
                continue
            if best is None or rules.better(r, best[1]):
                best = ((gi, idx, name), r)
        if not best or not rules.better(best[1], base):
            break
        (gi, idx, name), r = best
        _toggle(pool, gi, idx, False)
        entry = {"step": "gems", "change": f"turned off {name} (group {gi})", "value": rules.value(r),
                 "fixes": sorted(set(rules.hard_shortfalls(base)) - set(rules.hard_shortfalls(r)))}
        _refund(pool, budget, gi, name, entry)
        log.append(entry)
    return log
