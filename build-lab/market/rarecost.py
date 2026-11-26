"""Rough cost, in divines, of a rare from its affixes. poe.ninja doesn't price rares, so the gear optimizer uses
this during search (to stay inside a budget) and checks its final picks on the trade site (trade.py). It is a
heuristic, not a market price: the numbers below are deliberately simple and editable.

A rare's price comes from which mods buyers want and whether they want them together, not from tiers alone: six
T1 mods nobody wants, or that suit different builds, sell for next to nothing.

  affix cost = TIER_COST[tier] x demand weight (DEMAND, matched on the mod group); bench crafts cost BENCH
  buyer      = the offence line (spell, attack, dot, minion) whose mods are worth most; generic mods (life, resists,
               defences, attributes, movement speed, ...) and "any" offence mods (crit, gem levels, elemental
               damage) suit every buyer. Mods of another line are worth OFF_LINE of their cost.
  cost       = (BASE + sum of affix costs) x SYNERGY for every wanted good affix beyond the second, where wanted =
               the buyer's lines with weight >= WANTED, good = T1 or T2
Jewels use JEWEL_FACTOR of the same.

match_tiers() reads a finished item's mod lines back to (group, tier) from PoB's affix pools, so a guide's rares can
be priced with the same model the optimizer spends against.
"""
import re

# Calibration (Covens, 2026-11-24): the first trade checks priced made-up rares at 0.05-0.16 divine where an
# earlier, higher table estimated 0.4-1.9. These numbers are about a third of that table: still above the
# observed prices, so a budget errs on the safe side. Re-check against trade prices each league.
BASE = 0.02            # a white base of the right item level
BENCH = 0.02           # a bench craft
TIER_COST = {1: 0.2, 2: 0.05, 3: 0.015}
LOW_TIER = 0.005       # T4 and below
SYNERGY = 1.5          # each wanted good affix past two makes the item rarer to hit
WANTED = 0.5           # demand weight from which a mod counts toward SYNERGY
OFF_LINE = 0.2         # a mod for another kind of build than the item's buyer
JEWEL_FACTOR = 0.5
DEFAULT = (0.5, None)  # a group no pattern names
UNMATCHED = 0.1        # match_tiers: a line no affix pool explains (influence, veiled, fractured ...): about a
                       # T1 mod at the default weight

# (pattern on the mod group, demand weight, line). line None = generic, "any" = any offence, else that offence line.
# First match wins, so specific patterns come before broad ones.
DEMAND = [
    # junk: few buyers pay for these at any tier
    (r"AttackerTakesDamage|LightRadius|LocalAttributeRequirements|^StunRecovery|StunDuration|StunRecoveryForJewel|StunThreshold|"
     r"GainedFromEnemyDeath|ManaLeech|ProjectileSpeed|Knockback|AvoidInterruption|ChanceTo(Freeze|Ignite|Shock)|"
     r"(Freeze|Ignite|Shock)ChanceAndDuration|VaalSoul|^IncreasedAccuracy$|LifeGainPerTarget|ManaGainPerTarget|"
     r"EnergyShieldGainPerTarget", 0.02, None),
    # gem levels
    (r"SocketedMinionGemLevel", 2.0, "minion"),
    (r"MinionSpellSkillGemLevel|MinionGemLevel", 5.0, "minion"),
    (r"Global\w*Spell\w*GemLevel|GlobalSpellGemsLevel", 5.0, "spell"),
    (r"SocketedBowGemLevel|SocketedMeleeGemLevel|AdditionalArrows", 3.0, "attack"),
    (r"LocalIncreaseSocketed\w*GemLevel", 2.0, "any"),
    (r"Global\w*GemLevel|GlobalSkillGemLevel|AllGemLevel", 5.0, "any"),
    (r"SocketedGemLevel|SocketedGems", 2.0, "any"),
    # defences and other generic mods
    (r"Maximum\w*Resist", 3.0, None),
    (r"ChanceToSuppress|SpellSuppression", 1.5, None),
    (r"MovementVelocity|MovementSpeed", 1.5, None),
    (r"^IncreasedLife$|^PercentIncreasedLife", 1.0, None),
    (r"GlobalEnergyShieldPercent|^LocalEnergyShield$|^LocalEnergyShieldPercent$|EnergyShieldForJewel", 0.8, None),
    (r"AllResistances", 0.8, None),
    (r"FlaskEffect", 1.0, None),
    (r"Penetration", 0.6, "any"),
    (r"^(Minion|Totem)\w*Resist", 0.4, None),
    (r"Resist", 0.6, None),
    (r"DamageTakenGainedAsLife|LifeRecoup|ReducedPhysicalDamageTaken", 0.6, None),
    (r"^EnergyShield$|LocalBase|AndStunRecovery|LocalArmourAnd|LocalPhysicalDamageReductionRating|"
     r"LocalEvasionRating|BlockPercentage|SpellBlock|BlockShield|BlockStaff|BlockDualWielding", 0.5, None),
    (r"AllAttributes", 0.5, None),
    (r"Strength|Dexterity|Intelligence|EvasionRating|PhysicalDamageReductionRating|AllDefences|Regenerat|"
     r"EnergyShieldDelay|EnergyShieldRecharge|IncreasedMana|ManaRegen|ManaReservation|ManaCost|AvoidElemental|"
     r"Belt|ItemFoundRarity|EffectOnSelf|DurationOnSelf|Reduced(Bleed|Poison)Duration|CurseEffectOnYou|"
     r"DamageGoesToMana|DamageOverTimeTaken|Onslaught|OnSelf", 0.3, None),
    # offence
    (r"DamageOverTimeMultiplier", 1.5, "dot"),
    (r"AilmentDamage|Burn(ing)?Damage|PoisonDamage|BleedDamage|DamageOverTimeFor|FasterAilment|"
     r"^(Bleed|Poison)Duration", 0.5, "dot"),
    (r"^Minion", 0.6, "minion"),
    (r"^Totem", 0.5, "any"),
    (r"AttackAndCastSpeed", 0.6, "any"),
    (r"^LocalPhysicalDamagePercent$", 1.5, "attack"),
    (r"LocalIncreasedPhysicalDamagePercentAndAccuracy|^LocalPhysicalDamage|^LocalIncreasedAttackSpeed$", 1.0, "attack"),
    (r"^Local(Fire|Cold|Lightning|Chaos)Damage", 0.8, "attack"),
    (r"IncreasedAttackSpeed|AttackSpeed", 0.6, "attack"),
    (r"^(Fire|Cold|Lightning|Physical)Damage$|WeaponElementalDamage|LifeLeech|LocalAccuracy|Impale|Wand|"
     r"BleedChance|ProjectileDamage", 0.4, "attack"),
    (r"^WeaponSpellDamage$", 1.0, "spell"),
    (r"SpellAdded|IncreasedCastSpeed|CastSpeed", 0.8, "spell"),
    (r"CriticalStrikeMultiplier|CritMultiplier", 2.0, "any"),
    (r"SpellCrit|SpellDamage|^WeaponSpellDamageAndMana$", 0.6, "spell"),
    (r"CriticalStrikeChance|CritChance", 0.6, "any"),
    (r"DamageWeaponPrefix", 0.8, "any"),
    (r"DamagePercentage|DamageForJewel|IncreasedChaosDamage|AreaDamage|MineDamage", 0.4, "any"),
]
_DEMAND = [(re.compile(p), w, line) for p, w, line in DEMAND]
OFFENCE_LINES = ("spell", "attack", "dot", "minion")


def demand(group):
    """(weight, line) for a mod group: line None = generic, "any" = any offence, else an offence line."""
    for pattern, weight, line in _DEMAND:
        if pattern.search(group or ""):
            return weight, line
    return DEFAULT


def _affix_cost(a):
    if a.get("crafted"):
        return BENCH
    weight = a["weight"] if "weight" in a else demand(a.get("group"))[0]
    return TIER_COST.get(a.get("tier") or 9, LOW_TIER) * weight


def estimate(affixes, jewel=False):
    """Divines for an item with these affixes (dicts with tier, group, crafted, as gear.py builds them; an affix
    with "weight" uses it instead of DEMAND, e.g. an unmatched line)."""
    rows = []
    for a in affixes:
        weight, line = (a["weight"], a.get("line")) if "weight" in a else demand(a.get("group"))
        rows.append((a, weight, line, _affix_cost(a)))
    # the buyer: the offence line whose own mods are worth most (ties: the first)
    worth = {ln: sum(c for _, _, line, c in rows if line == ln) for ln in OFFENCE_LINES}
    buyer = max(OFFENCE_LINES, key=lambda ln: worth[ln]) if any(worth.values()) else None
    total, wanted = BASE, 0
    for a, weight, line, cost in rows:
        fits = line in (None, "any", buyer)
        total += cost if fits or a.get("crafted") else cost * OFF_LINE
        if fits and not a.get("crafted") and not a.get("unmatched") and weight >= WANTED and (a.get("tier") or 9) <= 2:
            wanted += 1
    total *= SYNERGY ** max(0, wanted - 2)
    return round(total * (JEWEL_FACTOR if jewel else 1.0), 3)


# ---------------- reading tiers back from an item ----------------

NUM = re.compile(r"[+-]?\d+(?:\.\d+)?")


def template(line):
    """'+107 to maximum Life' -> '+# to maximum Life'."""
    return re.sub(r"(?<![\w.])(\d+(?:\.\d+)?)", "#", line.strip())


def line_value(line):
    nums = [float(n) for n in NUM.findall(line)]
    if not nums:
        return None
    if re.search(r"\bAdds \S+ to \S+", line) and len(nums) >= 2:
        return (abs(nums[0]) + abs(nums[1])) / 2
    return abs(nums[0])


def match_tiers(lines, tier_pools):
    """Explicit mod lines of a finished item -> (affixes, unmatched lines). tier_pools: {tier: affix pool} for the
    item's base, from PoB's ev_affix_pool at roll 0 (each tier's lowest roll; a group with fewer tiers repeats its
    last). A line gets the best tier whose lowest roll it reaches; a hybrid mod's lines count once per group.
    When several groups share a line ("+# to maximum Life" is pure life and armour-and-life), a group whose every
    line is on the item comes first, so a lone life line isn't read as the hybrid's low-rolled T1."""
    index = {}   # template -> {group: [(tier, min value)]}
    needs = {}   # group -> its line templates
    for tier, pool in sorted(tier_pools.items()):
        for a in pool.get("affixes") or []:
            if a.get("crafted"):
                continue
            needs.setdefault(a["group"], set()).update(template(ln) for ln in a["lines"])
            for ln in a["lines"]:
                rows = index.setdefault(template(ln), {}).setdefault(a["group"], [])
                if not any(t == a["tier"] for t, _ in rows):
                    rows.append((a["tier"], line_value(ln)))
    best, unmatched = {}, []
    on_item = {template(ln) for ln in lines}
    for line in lines:
        groups = index.get(template(line))
        if not groups:
            unmatched.append(line)
            continue
        v = line_value(line)
        pick = None
        for group, rows in groups.items():
            ok = [t for t, low in rows if v is None or low is None or v >= low - 1e-9]
            tier = min(ok) if ok else max(t for t, _ in rows)
            key = (not needs.get(group, set()) <= on_item, tier)
            if pick is None or key < pick[2]:
                pick = (group, tier, key)
        group, tier, _ = pick
        if group not in best or tier < best[group]:
            best[group] = tier
    return [{"group": g, "tier": t, "crafted": False} for g, t in best.items()], unmatched


def estimate_lines(lines, crafted_lines, tier_pools, jewel=False):
    """Divines for a finished rare from its mod lines (match_tiers), with each unmatched line at UNMATCHED."""
    affixes, unmatched = match_tiers(lines, tier_pools)
    affixes += [{"crafted": True} for _ in crafted_lines]
    affixes += [{"tier": 1, "weight": UNMATCHED / TIER_COST[1], "line": None, "crafted": False, "unmatched": True} for _ in unmatched]
    return estimate(affixes, jewel=jewel), unmatched
