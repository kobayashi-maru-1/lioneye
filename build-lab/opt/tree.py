"""Passive tree optimizer.

improve(): keep the point budget and make the tree better under the rules:
  1. Over budget: refund the node whose removal costs least per point.
  2. Spare points: add the best path (node or mastery+effect) per point, until no spare or nothing helps.
  3. Swap: probe every pair (removable node r, addition a) among the best few of each, where a fits in the
     points r frees; apply the best pair that beats the current tree. Repeat until no pair helps.
  Every applied change is checked with a real recalc; a change that turns out worse is undone.

build(): start from the class start (tree-reset), spend ascendancy points greedily, grow the main tree greedily
by gain per point (paths up to max_dist, so far notables count), then improve().

Probes come from PoB's calculator (see evaluator.py); paths are PoB's own (node.path).
"""


def _rules_worse(rules, after, base):
    """True when `after` is worse than `base` on the rules alone (the metric aside)."""
    for x, y in zip(rules.score(base), rules.score(after)):
        if y > x + 1e-7:
            return True
        if y < x - 1e-7:
            return False
    return False


def _mastery_options(pool, max_dist, limit=None):
    out = []
    for m in pool.reachable_masteries(max_dist):
        for eff in m["effects"][:limit]:
            out.append({"key": f"m{m['id']}:{eff}", "label": f"{m['name']} (effect {eff})", "id": m["id"],
                        "masteries": {str(m["id"]): eff}, "points": m["dist"]})
    return out


def _additions(pool, max_dist, include_masteries=True):
    adds = [{"key": f"n{n['id']}", "label": n["name"], "id": n["id"], "masteries": None, "points": n["dist"]}
            for n in pool.reachable_nodes(max_dist)]
    if include_masteries:
        adds += _mastery_options(pool, max_dist)
    return adds


def _spec(add):
    s = {"allocate": [add["id"]]}
    if add["masteries"]:
        s["masteries"] = add["masteries"]
    return s


def _op(add):
    op = {"op": "allocate", "nodes": [add["id"]]}
    if add["masteries"]:
        op["masteries"] = add["masteries"]
    return op


def _rank(pool, rules, base, cands, spec_of, cost_of):
    """Probe each candidate; return [(rate, cand, result)] best first (errors dropped)."""
    if not cands:
        return []
    results = pool.probe([spec_of(c) for c in cands])
    rows = [(rules.rate(base, r, cost_of(c, r)), c, r) for c, r in zip(cands, results) if "error" not in r]
    rows.sort(key=lambda t: t[0], reverse=True)
    return rows


def _apply_checked(pool, rules, ops, base, budget, main_skill):
    """Apply ops; keep them only if the result beats base and stays within budget. Returns (kept, stats)."""
    snapshot = pool.save_xml()
    try:
        after = pool.apply(ops)
    except ValueError:
        return False, base
    if (budget is None or pool.points()["used"] <= budget) and rules.better(after, base):
        return True, after
    pool.load(snapshot, main_skill)
    return False, base


def _removals(pool, rules, base, max_frees, keep_keystones=True):
    """Refundable nodes. Keystones stay by default: several (Ghost Reaver, Zealot's Oath, ...) give recovery
    PoB's EHP doesn't count, so the numbers alone would refund them."""
    rems = [n for n in pool.allocated_nodes() if n["frees"] <= max_frees and n["type"] != "ClassStart"
            and not (keep_keystones and n["type"] == "Keystone")]
    rows = _rank(pool, rules, base, rems, lambda n: {"deallocate": [n["id"]]}, lambda n, r: n["frees"])
    return rows


def _fill(pool, rules, budget, max_dist, main_skill, log, stage):
    """Spend spare points on the best additions, one at a time."""
    tabu = set()
    while True:
        pts = pool.points()["used"]
        spare = budget - pts
        if spare <= 0:
            return
        base = pool.stats()
        adds = [a for a in _additions(pool, min(max_dist, spare)) if a["points"] <= spare and a["key"] not in tabu]
        rows = _rank(pool, rules, base, adds, _spec, lambda a, r: a["points"])
        rows = [row for row in rows if rules.improves(row[0])]
        if not rows:
            return
        rate, add, _ = rows[0]
        kept, after = _apply_checked(pool, rules, [_op(add)], base, budget, main_skill)
        if kept:
            log.append({"step": stage, "change": f"+ {add['label']} ({add['points']} pts)", "value": rules.value(after)})
        else:
            tabu.add(add["key"])


def _trim(pool, rules, budget, main_skill, log, stage, keep_keystones=True):
    """Over budget: refund the cheapest nodes until within it."""
    while pool.points()["used"] > budget:
        base = pool.stats()
        rows = _removals(pool, rules, base, max_frees=pool.points()["used"] - budget + 3,
                         keep_keystones=keep_keystones)
        if not rows:
            raise RuntimeError("over the point budget and no node can be refunded")
        rate, node, _ = rows[0]
        pool.apply([{"op": "deallocate", "nodes": [node["id"]]}])
        log.append({"step": stage, "change": f"- {node['name']} (refund, {node['frees']} pts)",
                    "value": rules.value(pool.stats())})


def improve(pool, rules, budget=None, max_dist=6, k_add=40, k_remove=30, max_frees=6, max_iters=40,
            main_skill=None, log=None, stage="tree", keep_keystones=True):
    log = log if log is not None else []
    budget = budget if budget is not None else pool.points()["used"]
    _trim(pool, rules, budget, main_skill, log, stage, keep_keystones)
    _fill(pool, rules, budget, max_dist, main_skill, log, stage)
    tabu = set()
    for _ in range(max_iters):
        base = pool.stats()
        spare = budget - pool.points()["used"]
        adds = _rank(pool, rules, base, _additions(pool, max_dist), _spec, lambda a, r: a["points"])[:k_add]
        rems = _removals(pool, rules, base, max_frees, keep_keystones)[:k_remove]
        if not adds or not rems:
            break
        # A path attaches to the tree at its anchors; if removing r takes all of them, the probe would count a
        # floating path, so such pairs are skipped (the real change would need a different path).
        anchors = {a["key"]: set(pool.node_anchors(a["id"])) for _, a, _ in adds}
        deps = {r["id"]: set(pool.node_depends(r["id"])) for _, r, _ in rems}
        pairs = []
        for _, r, _ in rems:
            for _, a, _ in adds:
                if a["points"] > r["frees"] + spare or (r["id"], a["key"]) in tabu:
                    continue
                if anchors[a["key"]] and anchors[a["key"]] <= deps[r["id"]]:
                    continue
                spec = _spec(a)
                spec["deallocate"] = [r["id"]]
                pairs.append((r, a, spec))
        if not pairs:
            break
        results = pool.probe([p[2] for p in pairs])
        good = [(r, p) for p, r in zip(pairs, results) if "error" not in r and rules.better(r, base)]
        # best first: lower (hard, soft) score, then higher metric
        ranked = sorted(good, key=lambda t: (tuple(-x for x in rules.score(t[0])), rules.value(t[0])), reverse=True)
        if not ranked:
            break
        moved = False
        for res, (r, a, _) in ranked[:8]:  # the probe can differ from a real change when paths shift: verify
            kept, after = _apply_checked(pool, rules, [{"op": "deallocate", "nodes": [r["id"]]}, _op(a)],
                                         base, budget, main_skill)
            if kept:
                log.append({"step": stage, "change": f"swap - {r['name']} ({r['frees']} pts) + {a['label']} "
                                                     f"({a['points']} pts)", "value": rules.value(after)})
                moved = True
                break
            tabu.add((r["id"], a["key"]))
        if not moved:
            break
        _fill(pool, rules, budget, max_dist, main_skill, log, stage)
    return log


def build(pool, rules, cls, ascendancy=None, points=123, asc_points=8, max_dist=10, main_skill=None, log=None,
          improve_iters=40):
    """Grow a tree from the class start with `points` main and `asc_points` ascendancy points (opt.py passes the
    loaded build's counts). The build's gear, gems and config stay as they are."""
    log = log if log is not None else []
    pool.apply([{"op": "tree-reset", "class": cls, **({"ascendancy": ascendancy} if ascendancy else {})}],
               allow_main_change=True)
    log.append({"step": "tree-build", "change": f"reset to {cls}" + (f" / {ascendancy}" if ascendancy else ""),
                "value": rules.value(pool.stats())})
    # ascendancy points
    tabu = set()
    while pool.points()["ascendancy"] < asc_points:
        spare = asc_points - pool.points()["ascendancy"]
        base = pool.stats()
        cands = [n for n in pool.reachable_nodes(spare, ascendancy=True) if n["id"] not in tabu]
        rows = _rank(pool, rules, base, cands, lambda n: {"allocate": [n["id"]]}, lambda n, r: n["dist"])
        rows = [row for row in rows if row[0][0] >= 1]
        if not rows:
            break
        rate, node, _ = rows[0]
        snapshot = pool.save_xml()
        try:
            after = pool.apply([{"op": "allocate", "nodes": [node["id"]]}])
        except ValueError:
            tabu.add(node["id"])
            continue
        if pool.points()["ascendancy"] > asc_points or _rules_worse(rules, after, base):
            pool.load(snapshot, main_skill)
            tabu.add(node["id"])
            continue
        log.append({"step": "tree-build", "change": f"+ {node['name']} (ascendancy, {node['dist']} pts)",
                    "value": rules.value(pool.stats())})
    # main tree: greedy by rate per point; when nothing improves the metric, take the best EHP-per-point path
    # so travel through empty areas still happens
    tabu = set()
    while pool.points()["used"] < points:
        spare = points - pool.points()["used"]
        base = pool.stats()
        adds = [a for a in _additions(pool, min(max_dist, spare)) if a["points"] <= spare and a["key"] not in tabu]
        rows = _rank(pool, rules, base, adds, _spec, lambda a, r: a["points"])
        rows = [row for row in rows if row[0][0] >= 1]
        if not rows:
            break
        rate, add, _ = rows[0]
        snapshot = pool.save_xml()
        try:
            after = pool.apply([_op(add)])
        except ValueError:
            tabu.add(add["key"])
            continue
        # probes can differ from the real change (e.g. a socket holding a radius jewel): undo if the rules got worse
        if pool.points()["used"] > points or _rules_worse(rules, after, base):
            pool.load(snapshot, main_skill)
            tabu.add(add["key"])
            continue
        log.append({"step": "tree-build", "change": f"+ {add['label']} ({add['points']} pts)",
                    "value": rules.value(pool.stats())})
    # A grown tree has no keystones the player chose, so the swap search may refund any.
    improve(pool, rules, budget=points, main_skill=main_skill, log=log, stage="tree-build", max_iters=improve_iters,
            keep_keystones=False)
    return log
