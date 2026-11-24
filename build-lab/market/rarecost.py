"""Rough cost, in divines, of a crafted rare from its affixes' tiers. poe.ninja doesn't price rares, so the gear
optimizer uses this during search (to stay inside a budget) and checks its final picks on the trade site
(trade.py). It is a heuristic, not a market price: the numbers below are deliberately simple and editable.

cost = BASE + sum(affix cost) then x SYNERGY for every good affix (T1/T2) beyond the second
affix cost = TIER_COST[tier] x premium multiplier (matched on the mod group); bench crafts cost BENCH.
Jewels use JEWEL_FACTOR of the same.
"""
import re

# Calibration (Covens, 2026-11-24): the first trade checks priced made-up rares at 0.05-0.16 divine where an
# earlier, higher table estimated 0.4-1.9. These numbers are about a third of that table: still above the
# observed prices, so a budget errs on the safe side. Re-check against trade prices each league.
BASE = 0.02            # a white base of the right item level
BENCH = 0.02           # a bench craft
TIER_COST = {1: 0.2, 2: 0.05, 3: 0.015}
LOW_TIER = 0.005       # T4 and below
SYNERGY = 1.5          # each good affix past two makes the item rarer to hit
JEWEL_FACTOR = 0.5
# Mod groups that sell for far more than their tier suggests.
PREMIUM = [
    (r"GemLevel|SocketedGems|GlobalSpellGemsLevel|AllGemLevel|MinionGemLevel", 5.0),
    (r"CriticalStrikeMultiplier|CritMultiplier", 2.0),
    (r"SpellSuppression|ChanceToSuppress", 1.5),
    (r"MovementVelocity|MovementSpeed", 1.5),
    (r"Maximum\w*Resist", 3.0),
    (r"^(?!.*Reduction).*PhysicalDamagePercent", 1.5),   # weapon phys %, not armour % (…ReductionRatingPercent)
]


def _premium(group):
    for pattern, mult in PREMIUM:
        if re.search(pattern, group or ""):
            return mult
    return 1.0


def estimate(affixes, jewel=False):
    """Divines for an item with these affixes (dicts with tier, group, crafted, as gear.py builds them)."""
    total = BASE
    good = 0
    for a in affixes:
        if a.get("crafted"):
            total += BENCH
            continue
        tier = a.get("tier") or 9
        total += TIER_COST.get(tier, LOW_TIER) * _premium(a.get("group"))
        if tier <= 2:
            good += 1
    total *= SYNERGY ** max(0, good - 2)
    return round(total * (JEWEL_FACTOR if jewel else 1.0), 3)
