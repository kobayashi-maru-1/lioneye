"""A spending budget, in divines, for the optimizers: what they may buy (support gems, crafted rares) and a ledger
of what they did buy. Gems are priced on poe.ninja at the level and quality the optimizer would use (the gem's
natural maximum, quality 20); a gem poe.ninja doesn't list is taken as a vendor gem (VENDOR). Rares use the
rarecost estimate. Things the build already owns cost nothing.
"""
import rarecost

VENDOR = 0.02


class Budget:
    def __init__(self, divines, prices):
        self.limit = float(divines)
        self.prices = prices
        self.spent = 0.0
        self.ledger = []
        self._gem_cache = {}

    @property
    def remaining(self):
        return self.limit - self.spent

    def can(self, cost, key=None):
        return cost is not None and cost <= self.available(key) + 1e-9

    def charge(self, cost, what, key=None):
        """Record a purchase. With a key (a gear slot, a gem slot), a later purchase for the same key replaces
        the earlier one: only the final item would be bought, so the earlier one is refunded."""
        if key is not None:
            for e in self.ledger:
                if e.get("key") == key and not e.get("replaced"):
                    self.spent -= e["cost"]
                    e["replaced"] = True
        self.spent += cost
        self.ledger.append({"what": what, "divine": round(cost, 3), "cost": cost,
                            **({"key": key} if key is not None else {})})

    def available(self, key=None):
        """What's left to spend on `key`, counting a refund of what was bought for it already."""
        back = sum(e["cost"] for e in self.ledger if key is not None and e.get("key") == key and not e.get("replaced"))
        return self.remaining + back

    def gem_cost(self, name, level, quality=20, rare=False):
        """Divines for a gem, or None when it can't be bought. A gem poe.ninja doesn't list is a vendor gem
        (VENDOR) unless rare (awakened/exceptional): those aren't sold by vendors, and an unlisted one isn't in
        this league's economy (e.g. most awakened gems in Covens), so it can't be bought."""
        key = (name, level, quality, rare)
        if key not in self._gem_cache:
            p = self.prices.gem(name, level, quality)
            if p and p.get("divine") is not None:
                cost = p["divine"]
            elif p and p.get("chaos") is not None:
                cost = self.prices.to_divine(p["chaos"])
            else:
                cost = None if rare else VENDOR
            self._gem_cache[key] = cost
        return self._gem_cache[key]

    @staticmethod
    def rare_cost(affixes, jewel=False):
        return rarecost.estimate(affixes, jewel=jewel)

    def report(self):
        return {"limit": self.limit, "spent": round(self.spent, 3), "remaining": round(self.remaining, 3),
                "ledger": [{k: v for k, v in e.items() if k not in ("key", "cost")} for e in self.ledger]}
