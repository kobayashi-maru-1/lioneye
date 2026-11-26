"""Unit tests for backtest.py (no PoB run): delivery supports, floors, the report.

    python backtest/test-backtest.py
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import backtest as BT  # noqa: E402

for sub in ("design", "eval", "opt", "market"):
    sys.path.insert(0, os.path.join(HERE, "..", sub))


def main():
    import concept as C
    report = []

    def add(test, ok, **extra):
        report.append({"test": test, "ok": bool(ok), **extra})

    db = C.GameDB()
    for name in ("Ballista Totem", "Spell Totem", "Trap", "High-Impact Mine", "Cast On Critical Strike",
                 "Cast while Channelling", "Hextouch"):
        add(f"delivery: {name} stays", BT.is_delivery(db, name))
    for name in ("Combustion", "Greater Volley", "Volatility", "Increased Critical Damage", "Empower"):
        add(f"delivery: {name} is the lab's to choose", not BT.is_delivery(db, name))
    guide = {"stats": {"profile": {"MovementSpeedMod": 2.0, "EffectiveSpellSuppressionChance": 0,
                                   "ChaosMaximumHitTaken": 1e12, "PhysicalMaximumHitTaken": 10000}}}
    floors = BT.guide_floors(guide)
    add("floors: held at FLOOR_SHARE of the guide's", abs(floors.get("MovementSpeedMod", 0) - 2.0 * BT.FLOOR_SHARE)
        < 1e-9 and abs(floors.get("PhysicalMaximumHitTaken", 0) - 10000 * BT.FLOOR_SHARE) < 1e-6, detail=str(floors))
    add("floors: zero and unlimited stats aren't floors", "EffectiveSpellSuppressionChance" not in floors
        and "ChaosMaximumHitTaken" not in floors)
    add("report: a one-listing trade price is thin", BT.thin({"divine": 728.7, "listings": 1}))
    add("report: three listings make a price", not BT.thin({"divine": 0.3, "listings": 3}))
    add("report: a cached result without the flag is judged by its listings", BT.thin({"divine": 46, "listings": 2}))
    a = {"hardBroken": [], "brokenRules": ["floor:x"], "utility": 13.2, "stats": {"value": 1.0e6}}
    b = {"hardBroken": [], "brokenRules": [], "utility": 13.6, "stats": {"value": 0.8e6}}
    add("pick: seeds ranked by utility, not raw damage", BT.pick([a, b], {}) is b)
    c = {"brokenRules": ["res:FireResist"], "stats": {"value": 9e9}}
    add("pick: older results without hardBroken count every broken rule", BT.pick([c, b], {}) is b)
    failed = [r for r in report if not r["ok"]]
    print(json.dumps({"passed": len(report) - len(failed), "failed": failed}, indent=1, default=str))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
