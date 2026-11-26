"""What the optimizers maximize, and the rules they must keep.

Rules (the resist, chaos and EHP rules can be changed or switched off; PoB's warnings always count):
- Fire, cold and lightning: resistance at least `res_cap` (75). An element is exempt only when none of its hits
  land as itself (all taken as another type, e.g. "100% of Cold and Lightning Damage from Hits taken as Fire
  Damage"): PoB's <X>TakenDamage is 0 while <X>EnemyDamage is above 0. When the enemy deals none of that type
  the rule still applies, and armour, suppression or "less damage taken" never stand in for resistance.
- Chaos: resistance at least `chaos_min` (0), exempt the same way. Skipped for builds with 1 life (Chaos
  Inoculation).
- Total EHP at least `ehp_floor`: "start" (the loaded build's EHP), a number, or None.
- Stat floors (`floors`, optional): {player stat: minimum}, e.g. {"PhysicalMaximumHitTaken": 9000,
  "EffectiveSpellSuppressionChance": 100}. They hold a defence profile that one EHP number doesn't: suppression,
  block, the biggest hit of each type, recovery.
- PoB's own hard warnings: attribute requirements, unreserved life/mana, Precise Technique accuracy, plus the
  main skill's cost against its pool.

Each rule has a shortfall: (cap - res) / cap per failing element ((chaos_min - chaos) / 75 for chaos),
(floor - EHP) / floor and the same for each stat floor, 0.01 + the share missing for attribute requirements and the skill cost,
0.01 + the overdraw as a share of the pool for "unreserved Mana is negative" / "unreserved Life is below 1" (so
reservation efficiency and more mana count as progress), 1 for any other warning.

How results compare: a score tuple, lower is better, then the metric (FullDPS, CombinedDPS or
minion.CombinedDPS), higher is better.
- start_breaks="keep" (default, improving a build): (hard, worse). hard = total shortfall of rules the loaded
  build met; they must stay met. worse = how much any rule the loaded build already broke got worse, rule by
  rule (no trading one rule's fix against another's regression). Fixing a broken rule earns nothing, so the
  metric is never spent on it (with weighted floors, closing the soft band of a floor does earn utility).
- start_breaks="fix" (opt-in): (hard, worse, -fixed), where fixed = the starting shortfall of each broken rule
  fixed completely. A full fix then outranks the metric; partial progress still earns nothing.
- start_breaks="repair" (growing a tree from a class start, where a bare tree breaks most rules): (total
  shortfall,), so partial progress counts.

Weighted floors (floor_weight > 0 and an EHP or stat floor set; concepts and the back-test use it): the EHP floor and the stat floors stop
outranking damage. A floor's shortfall up to 1 - floor_hard (0.3 for floor_hard 0.7) is soft; only what's below
floor_hard x the floor stays in the score tuple above. After the score, results compare on
    utility = ln(metric) - floor_weight x (sum of soft floor shortfalls)
so with floor_weight 2, closing 10% of a floor is worth about 20% of the metric. Without it, one keystone that
clears a whole floor (Chaos Inoculation and a chaos max-hit floor) outranked any damage it cost. Resists, chaos
and PoB's warnings stay hard. shortfalls() and breaks() still report every floor a result misses.
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "eval"))
import evaluator as E  # noqa: E402

RES_KEYS = ("FireResist", "ColdResist", "LightningResist")
DEFAULT_FLOOR_HARD = 0.7   # with floor_weight and no floor_hard given
EPS = 1e-9
TOL = 1e-7
MODES = ("keep", "fix", "repair")

_REQ = {"Strength": ("ReqStr", "Str"), "Dexterity": ("ReqDex", "Dex"), "Intelligence": ("ReqInt", "Int"),
        "Omniscience": ("ReqOmni", "Omni")}
_COST = {"Life": ("LifeCost", "LifeUnreserved"), "Mana": ("ManaCost", "ManaUnreserved"),
         "Rage": ("RageCost", "Rage"), "Energy Shield": ("ESCost", "EnergyShield")}
# PoB's reservation warnings: pool -> (unreserved stat, the warning's wording)
_UNRESERVED = {"Mana": ("ManaUnreserved", "negative"), "Life": ("LifeUnreserved", "below 1")}


def _share(need, have):
    if not isinstance(need, (int, float)) or not isinstance(have, (int, float)) or need <= 0:
        return 1.0
    return min(1.0, max(0.0, (need - have) / need))


def _warning(w, p):
    """(rule key, shortfall) for one PoB warning."""
    for attr, (req, have) in _REQ.items():
        if w.startswith(f"You do not meet the {attr} requirement"):
            return f"req:{attr}", 0.01 + _share(p.get(req), p.get(have))
    for pool, (cost, have) in _COST.items():
        if w == f"Not enough {pool} for the main skill's cost":
            return f"cost:{pool}", 0.01 + _share(p.get(cost), p.get(have))
    for pool, (unreserved, cut) in _UNRESERVED.items():
        if w == f"Your unreserved {pool} is {cut}":
            total, left = p.get(pool), p.get(unreserved)
            if isinstance(total, (int, float)) and isinstance(left, (int, float)) and total > 0:
                # Not capped at the pool: an overdraw of several pools must still show each aura turned off.
                return f"warn:{w}", 0.01 + max(0.0, (1 - left if pool == "Life" else -left) / total)
    return f"warn:{w}", 1.0


class Rules:
    def __init__(self, metric, start_stats, res_cap=75, chaos_min=0, ehp_floor="start", start_breaks="keep",
                 floors=None, floor_weight=None, floor_hard=None):
        p = start_stats.get("player") or {}
        self.floors = {k: float(v) for k, v in (floors or {}).items() if isinstance(v, (int, float)) and v > 0}
        self.metric = metric
        self.res_cap = res_cap
        self.chaos_min = None if chaos_min is None or (p.get("Life") or 0) <= 1 else chaos_min
        if ehp_floor == "start":
            self.ehp_floor = p.get("TotalEHP")
        elif ehp_floor in (None, "none"):
            self.ehp_floor = None
        else:
            self.ehp_floor = float(ehp_floor)
        if start_breaks not in MODES:
            raise ValueError(f"start_breaks must be one of {MODES}")
        self.start_breaks = start_breaks
        # Weighting needs a positive weight and a floor to weigh; otherwise the rules are exactly the unweighted
        # ones (a run with no floors keeps ranking by the metric itself).
        has_floor = bool(self.ehp_floor) or bool(self.floors)
        self.floor_weight = float(floor_weight) if floor_weight and floor_weight > 0 and has_floor else None
        self.floor_hard = min(1.0, max(0.0, float(DEFAULT_FLOOR_HARD if floor_hard is None else floor_hard)))
        self.start_short = self.hard_shortfalls(start_stats) if start_breaks != "repair" else {}
        self.start_missed = sorted(self.shortfalls(start_stats)) if start_breaks != "repair" else []

    def describe(self):
        return {"metric": self.metric, "resCap": self.res_cap, "chaosMin": self.chaos_min,
                "ehpFloor": round(self.ehp_floor) if self.ehp_floor else None,
                **({"floors": {k: round(v, 1) for k, v in self.floors.items()}} if self.floors else {}),
                "pobWarnings": "attribute requirements, unreserved life/mana, accuracy, main skill cost",
                **({"floorWeight": self.floor_weight, "floorHard": self.floor_hard} if self.floor_weight else {}),
                "startBreaks": self.start_breaks, "brokenAtStart": self.start_missed}

    # -- rules --
    @staticmethod
    def _exempt(p, element):
        """True when none of the element's hits land as itself (all taken as another type)."""
        enemy, taken = p.get(f"{element}EnemyDamage"), p.get(f"{element}TakenDamage")
        return (isinstance(enemy, (int, float)) and enemy > 0 and isinstance(taken, (int, float))
                and taken <= enemy * 1e-6)

    def _short(self, p, res_key, cap):
        res = p.get(res_key)
        if res is None or res >= cap - EPS or self._exempt(p, res_key.replace("Resist", "")):
            return 0.0
        return (cap - res) / (75 if res_key == "ChaosResist" else max(cap, 1))

    def shortfalls(self, r):
        """{rule key: shortfall > 0} for every rule a result breaks."""
        p = r.get("player") or {}
        out = {}
        if self.res_cap:
            for k in RES_KEYS:
                s = self._short(p, k, self.res_cap)
                if s > 0:
                    out[f"res:{k}"] = s
        if self.chaos_min is not None:
            s = self._short(p, "ChaosResist", self.chaos_min)
            if s > 0:
                out["res:ChaosResist"] = s
        if self.ehp_floor:
            x = p.get("TotalEHP")
            if x is not None and x < self.ehp_floor * (1 - 1e-6):
                out["ehp"] = (self.ehp_floor - x) / self.ehp_floor
        for k, need in self.floors.items():
            x = p.get(k)
            if isinstance(x, (int, float)) and x < need * (1 - 1e-6):
                out[f"floor:{k}"] = (need - x) / need
        for w in r.get("violations") or []:
            k, s = _warning(w, p)
            out[k] = max(out.get(k, 0.0), s)
        return out

    @staticmethod
    def _is_floor(k):
        return k == "ehp" or k.startswith("floor:")

    def _split(self, sf):
        """(hard shortfalls, soft floor total). Without floor_weight everything is hard."""
        if not self.floor_weight:
            return sf, 0.0
        slack = 1.0 - self.floor_hard
        hard, soft = {}, 0.0
        for k, v in sf.items():
            if self._is_floor(k):
                soft += min(v, slack)
                if v > slack + TOL:
                    hard[k] = v - slack
            else:
                hard[k] = v
        return hard, soft

    def hard_shortfalls(self, r):
        """shortfalls() without the soft part of the floors: what the score tuple holds."""
        return self._split(self.shortfalls(r))[0]

    def utility(self, r):
        """ln(metric) - floor_weight x soft floor shortfall (the metric itself without floor_weight)."""
        v = self.value(r)
        if not self.floor_weight:
            return v
        return math.log(max(v, 1.0)) - self.floor_weight * self._split(self.shortfalls(r))[1]

    def score(self, r):
        """Lower is better, compared element by element. See the module docstring."""
        n = {"keep": 2, "fix": 3, "repair": 1}[self.start_breaks]
        if "error" in r:
            return (float("inf"),) * n
        sf = self.hard_shortfalls(r)
        if self.start_breaks == "repair":
            return (sum(sf.values()),)
        hard = sum(v for k, v in sf.items() if k not in self.start_short)
        worse = sum(max(0.0, sf.get(k, 0.0) - s0) for k, s0 in self.start_short.items()
                    if sf.get(k, 0.0) > s0 + TOL)
        if self.start_breaks == "keep":
            return (hard, worse)
        fixed = sum(s0 for k, s0 in self.start_short.items() if sf.get(k, 0.0) <= 0)
        return (hard, worse, -fixed)

    def breaks(self, r):
        """The rules a result breaks, readable."""
        p = r.get("player") or {}
        out = []
        for k in self.shortfalls(r):
            if k.startswith("res:"):
                key = k[4:]
                cap = self.chaos_min if key == "ChaosResist" else self.res_cap
                out.append(f"{key} {p.get(key):g} < {cap:g}")
            elif k == "ehp":
                out.append(f"TotalEHP {p.get('TotalEHP'):.0f} < {self.ehp_floor:.0f}")
            elif k.startswith("floor:"):
                out.append(f"{k[6:]} {p.get(k[6:]):.0f} < {self.floors[k[6:]]:.0f}")
        out.extend(r.get("violations") or [])
        return out

    # -- comparing --
    def value(self, r):
        v = E.value(r, self.metric)
        return v if isinstance(v, (int, float)) else 0.0

    def rank_value(self, r):
        """What ranks results with equal scores: utility with weighted floors, else the metric."""
        return self.utility(r)

    def better(self, a, b):
        """True when result a is strictly better than result b."""
        sa, sb = self.score(a), self.score(b)
        for x, y in zip(sa, sb):
            if abs(x - y) > TOL:
                return x < y
        if self.floor_weight:
            return self.utility(a) > self.utility(b) + 1e-9
        ma, mb = self.value(a), self.value(b)
        return ma > mb + max(1e-9, abs(mb) * 1e-9)

    def not_worse(self, a, b):
        """True when a is at least as good as b."""
        return not self.better(b, a)

    def rate(self, base, r, cost=1):
        """How good a change from `base` to `r` is per point/slot of `cost`, for ranking candidates:
        (class, primary, secondary), higher is better. class 2 = better on the rules (primary = how much, per
        cost, earlier score parts weighted more), 1 = same on the rules (primary = relative metric gain per
        cost, secondary = relative EHP gain per cost), 0 = worse on the rules, -1 = error."""
        if "error" in r:
            return (-1, 0.0, 0.0)
        cost = max(cost, 1)
        sb, sr = self.score(base), self.score(r)
        for i, (x, y) in enumerate(zip(sb, sr)):
            weight = 1000.0 ** (len(sb) - 1 - i)
            if y < x - TOL:
                return (2, (x - y) / cost * weight, self._rel(base, r, self.metric) / cost)
            if y > x + TOL:
                return (0, -(y - x) * weight, 0.0)
        if self.floor_weight:   # utility is a log: its difference is a relative gain, floors included
            return (1, (self.utility(r) - self.utility(base)) / cost, self._rel(base, r, "TotalEHP") / cost)
        return (1, self._rel(base, r, self.metric) / cost, self._rel(base, r, "TotalEHP") / cost)

    @staticmethod
    def _rel(a, b, key):
        x, y = E.value(a, key), E.value(b, key)
        if not isinstance(x, (int, float)) or not isinstance(y, (int, float)):
            return 0.0
        return (y - x) / max(abs(x), 1.0)

    @staticmethod
    def improves(rate):
        """A rated change worth making: better on the rules, or raises the metric (or EHP at equal metric)."""
        cls, primary, secondary = rate
        return cls == 2 or (cls == 1 and (primary > 1e-9 or (abs(primary) <= 1e-9 and secondary > 1e-9)))


def summary(rules, r):
    """The numbers a report needs from a result."""
    p = r.get("player") or {}
    return {"metric": rules.metric, "value": rules.value(r), "score": [round(x, 4) for x in rules.score(r)],
            "breaks": rules.breaks(r), "Life": p.get("Life"), "EnergyShield": p.get("EnergyShield"),
            "TotalEHP": p.get("TotalEHP"), "res": {k: p.get(k) for k in RES_KEYS + ("ChaosResist",)}}
