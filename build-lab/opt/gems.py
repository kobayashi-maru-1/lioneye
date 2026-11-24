"""Gem link optimizer for the main skill group.

Coordinate ascent: for each enabled support slot in the main group, try every support PoB allows on the main
skill (support_trials, one recalc each) and keep the best when it beats the current gem under the rules.
Repeat until a round changes nothing. With `links`, empty links are filled first (best support appended, one at
a time).

Without a budget, awakened and exceptional supports (Empower, Enlighten, Enhance, ...) are left out unless
allowed. With a budget (market/budget.py), every support costs its poe.ninja price at the level and quality the
optimizer uses (natural maximum, quality 20): only those that fit what's left are tried, and each one put in is
charged. awakened/exceptional are then allowed by default, since the budget already limits them.
"""

QUALITY = 20


def _candidates(pool, allow_awakened, allow_exceptional, budget=None, key=None):
    out = []
    for s in pool.compatible_supports_info():
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
                  log=None):
    log = log if log is not None else []
    # Default: off without a budget, on with one (the budget prices them).
    allow_awakened = (budget is not None) if allow_awakened is None else allow_awakened
    allow_exceptional = (budget is not None) if allow_exceptional is None else allow_exceptional
    group = _main_group(pool)
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
        for gem in [g for g in group["gems"] if g["support"] and g["enabled"]]:
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
