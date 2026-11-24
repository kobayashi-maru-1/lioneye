"""Gem link optimizer for the main skill group.

Coordinate ascent: for each enabled support slot in the main group, try every support PoB allows on the main
skill (support_trials, one recalc each) and keep the best when it beats the current gem under the rules.
Repeat until a round changes nothing. With `links`, empty links are filled first (best support appended, one at
a time). Awakened and exceptional supports (Empower, Enlighten, Enhance, ...) are left out unless allowed:
they cost far more than a budget build should assume.
"""


def _candidates(pool, allow_awakened, allow_exceptional):
    return [s["name"] for s in pool.compatible_supports_info()
            if (allow_awakened or not s["awakened"]) and (allow_exceptional or not s["exceptional"])]


def _main_group(pool):
    return next(g for g in pool.groups() if g["main"])


def _best(pool, rules, base, index, names, quality):
    """Best support for slot `index` among names: (name, result) when it beats `base`, else None."""
    if not names:
        return None
    trials = [{"index": index, "name": n, "quality": quality, "enabled": True} for n in names]
    results = pool.support_trials(trials)
    best = None
    for name, r in zip(names, results):
        if "error" in r:
            continue
        if best is None or rules.better(r, best[1]):
            best = (name, r)
    if best and rules.better(best[1], base):
        return best
    return None


def optimize_gems(pool, rules, links=None, allow_awakened=False, allow_exceptional=False, quality=20, rounds=4,
                  log=None):
    log = log if log is not None else []
    group = _main_group(pool)
    # fill empty links
    if links:
        while len(group["gems"]) < links:
            base = pool.stats()
            pick = _best(pool, rules, base, len(group["gems"]) + 1,
                         _candidates(pool, allow_awakened, allow_exceptional), quality)
            if not pick:
                break
            pool.apply([{"op": "gem", "group": "main", "name": pick[0], "quality": quality}])
            log.append({"step": "gems", "change": f"added {pick[0]}", "value": rules.value(pick[1])})
            group = _main_group(pool)
    # coordinate ascent over enabled support slots
    for _ in range(rounds):
        changed = False
        for gem in [g for g in group["gems"] if g["support"] and g["enabled"]]:
            base = pool.stats()
            pick = _best(pool, rules, base, gem["index"], _candidates(pool, allow_awakened, allow_exceptional),
                         quality)
            if pick:
                pool.apply([{"op": "gem", "group": "main", "index": gem["index"], "name": pick[0],
                             "quality": quality}])
                log.append({"step": "gems", "change": f"slot {gem['index']}: {gem['name']} -> {pick[0]}",
                            "value": rules.value(pick[1])})
                changed = True
                group = _main_group(pool)
        if not changed:
            break
    return log
