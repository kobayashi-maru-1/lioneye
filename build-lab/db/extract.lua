-- Reads Path of Building's own game data from a running headless PoB and returns it as JSON, one section per
-- function. build-game-db.py loads this file into the PoB Lua state and calls bl_extract(section).
-- Everything here only reads PoB's tables; nothing is changed.

local dkjson = require "dkjson"
local band = bit.band

-- ---------- helpers ----------

local function keys(t)
  local out = { }
  for k in pairs(t or { }) do out[#out + 1] = k end
  table.sort(out, function(a, b) return tostring(a) < tostring(b) end)
  return out
end

-- Counts of things skipped or failed, read by the "stats" section so the checks can catch silent losses.
local stats = { gemErrors = 0, uniqueErrors = 0, uniquesWithoutBase = 0, parseErrors = 0, compatErrors = 0 }

local function flagNames(value, enum)
  local out = { }
  if type(value) ~= "number" or value == 0 then return out end
  for name, bitv in pairs(enum) do
    -- Composite masks (SourceMask, WeaponMask, MatchAll, ...) aren't flags of their own.
    if type(bitv) == "number" and bitv ~= 0 and not name:find("Mask") and name ~= "MatchAll"
       and band(value, bitv) == bitv then
      out[#out + 1] = name
    end
  end
  table.sort(out)
  return out
end

local skillTypeName = { }
for name, id in pairs(SkillType) do skillTypeName[id] = name end

-- A set {[SkillType.X] = true} or an expression list {SkillType.X, SkillType.AND, ...} as names.
local function typeSet(set)
  local out = { }
  for id, on in pairs(set or { }) do
    if on == true then out[#out + 1] = skillTypeName[id] or tostring(id) end
  end
  table.sort(out)
  return out
end
local function typeExpr(list)
  local out = { }
  for _, id in ipairs(list or { }) do out[#out + 1] = skillTypeName[id] or tostring(id) end
  return out
end

-- Plain copy of a value for JSON: scalars as-is, tables to a limited depth, functions and cycles dropped.
local function plain(v, depth)
  local tv = type(v)
  if tv == "number" then
    if v ~= v or v == math.huge or v == -math.huge then return tostring(v) end
    return v
  elseif tv == "string" or tv == "boolean" then
    return v
  elseif tv == "table" then
    if depth <= 0 then return nil end
    local out, n = { }, 0
    for k, x in pairs(v) do
      if (type(k) == "string" or type(k) == "number") and k ~= "source" then
        local px = plain(x, depth - 1)
        if px ~= nil then out[k] = px; n = n + 1 end
      end
    end
    return n > 0 and out or nil
  end
  return nil
end

-- PoB's parsed form of a mod line: one entry per mod it produces.
local function serMods(list)
  local out = { }
  for _, mod in ipairs(list or { }) do
    local tags = { }
    for _, tag in ipairs(mod) do tags[#tags + 1] = plain(tag, 3) end
    out[#out + 1] = {
      n = mod.name, t = mod.type, v = plain(mod.value, 4),
      f = flagNames(mod.flags, ModFlag), k = flagNames(mod.keywordFlags, KeywordFlag),
      tags = tags,
    }
  end
  return out
end

-- Parse one line the way PoB does, at the top of any roll range. supported = PoB understood all of it.
local function parseLine(line, isComb)
  local text = line
  if line:find("%(%-?%d") then
    local ok, ranged = pcall(itemLib.applyRange, line, 1)
    if ok and ranged then text = ranged end
  end
  local ok, modList, extra = pcall(modLib.parseMod, text, isComb)
  if not ok then
    stats.parseErrors = stats.parseErrors + 1
    return { supported = false, error = tostring(modList), mods = { } }
  end
  return { supported = modList ~= nil and extra == nil, extra = extra, mods = serMods(modList) }
end

local function lineEntry(line)
  local p = parseLine(line)
  p.text = line
  return p
end

-- A list of stat lines, joining a line PoB can't read with the next one when the pair parses (a stat that
-- wraps onto two lines), as PoB's item parser does.
local function lineEntries(lines)
  local out, i = { }, 1
  while lines[i] do
    local e = lineEntry(lines[i])
    if not e.supported and lines[i + 1] then
      local comb = parseLine(lines[i] .. " " .. lines[i + 1], true)
      if comb.supported then
        comb.text = lines[i] .. "\n" .. lines[i + 1]
        e = comb
        i = i + 1
      end
    end
    out[#out + 1] = e
    i = i + 1
  end
  return out
end

-- Passive and mastery lines from PoB's own processing (PassiveTree:ProcessStats), which already joined
-- wrapped lines: a joined line is marked `combined` and its text belongs to the line before it.
local function processedEntries(sd, mods)
  local out = { }
  for i, line in ipairs(sd or { }) do
    local m = mods and mods[i]
    if m and m.combined and #out > 0 then
      out[#out].text = out[#out].text .. "\n" .. line
    elseif m and m.list ~= nil and m.extra == nil then
      out[#out + 1] = { text = line, supported = true, mods = serMods(m.list) }
    else
      -- Unsupported: PoB's entry holds its last failed attempt to join this line with the ones after it,
      -- so parse the line on its own for its stored extra and mods.
      out[#out + 1] = lineEntry(line)
    end
  end
  return out
end

-- Legacy variant names: "Pre 3.19.0", "Pre.3.19.0", "... Pre 3.26.0", "(Pre 3.14)", and a bare version
-- ("3.19.0") on a unique that also has a "Current" variant.
local function isLegacyVariant(name, hasCurrent)
  return name:find("%f[%w]Pre[%s%.]*%d") ~= nil or (hasCurrent and name:find("^%d+%.%d+") ~= nil)
end

-- ---------- sections ----------

local sections = { }

function sections.meta()
  return { treeVersion = latestTreeVersion, gameVersion = data.gameVersion or nil }
end

local function gemEntry(id, gem)
    local ge = gem.grantedEffect
    if ge then
      local levels = { }
      for lvl, l in ipairs(ge.levels or { }) do
        local vals = { }
        for i, v in ipairs(l) do vals[i] = plain(v, 1) end
        levels[#levels + 1] = {
          level = lvl, req = l.levelRequirement, values = vals,
          -- How each value becomes a stat: 1 = as-is, 2/3 = interpolated (PoB's statInterpolation).
          interpolation = plain(l.statInterpolation, 1),
          cost = plain(l.cost, 1), manaMultiplier = l.manaMultiplier,
          effectiveness = l.damageEffectiveness, crit = l.critChance,
          cooldown = l.cooldown, storedUses = l.storedUses,
          reservation = (l.manaReservationPercent or l.manaReservationFlat or l.lifeReservationPercent
                         or l.lifeReservationFlat) and {
            manaPercent = l.manaReservationPercent, manaFlat = l.manaReservationFlat,
            lifePercent = l.lifeReservationPercent, lifeFlat = l.lifeReservationFlat,
          } or nil,
        }
      end
      local quality = { }
      for _, q in ipairs(ge.qualityStats or { }) do quality[#quality + 1] = { stat = q[1], perQuality = q[2] } end
      return {
        id = id, name = gem.name, baseTypeName = gem.baseTypeName or gem.name, variantId = gem.variantId,
        grantedEffectId = gem.grantedEffectId, secondaryGrantedEffectId = gem.secondaryGrantedEffectId,
        support = ge.support and true or false, vaal = gem.vaalGem and true or false,
        transfigured = (gem.variantId or ""):find("Alt[XY]$") ~= nil,
        unsupported = ge.unsupported and true or false,
        tags = keys(gem.tags), tagString = gem.tagString,
        reqStr = gem.reqStr, reqDex = gem.reqDex, reqInt = gem.reqInt, maxLevel = gem.naturalMaxLevel,
        description = ge.description, castTime = ge.castTime,
        skillTypes = typeSet(ge.skillTypes), minionSkillTypes = typeSet(ge.minionSkillTypes),
        requireSkillTypes = typeExpr(ge.requireSkillTypes), addSkillTypes = typeExpr(ge.addSkillTypes),
        excludeSkillTypes = typeExpr(ge.excludeSkillTypes), weaponTypes = keys(ge.weaponTypes),
        stats = plain(ge.stats, 1) or { }, constantStats = plain(ge.constantStats, 2) or { },
        qualityStats = quality, levels = levels,
      }
    end
end

function sections.gems()
  local out = { }
  for id, gem in pairs(data.gems) do
    local ok, entry = pcall(gemEntry, id, gem)
    if not ok then stats.gemErrors = stats.gemErrors + 1
    elseif entry then out[#out + 1] = entry end
  end
  return out
end

-- Which supports PoB lets support which actives, using the skills' own types (before anything a support or
-- item adds). The evaluator stays the final word for a real build.
function sections.supportCompat()
  local actor = { weaponData1 = { }, weaponData2 = { } }
  actor.enemy = { player = actor }
  local supports, actives = { }, { }
  for id, gem in pairs(data.gems) do
    local ge = gem.grantedEffect
    if ge and ge.support then supports[#supports + 1] = gem
    elseif ge and not ge.support then actives[#actives + 1] = gem end
  end
  local out = { }
  for _, a in ipairs(actives) do
    for _, ge in ipairs({ a.grantedEffect, a.secondaryGrantedEffect }) do
      if ge and not ge.support then
        local skill = {
          activeEffect = { grantedEffect = ge, gemData = a },
          skillTypes = ge.skillTypes or { }, minionSkillTypes = ge.minionSkillTypes,
          actor = actor,
        }
        for _, s in ipairs(supports) do
          local ok, yes = pcall(calcLib.canGrantedEffectSupportActiveSkill, s.grantedEffect, skill)
          if not ok then stats.compatErrors = stats.compatErrors + 1
          elseif yes then out[#out + 1] = { s.id, a.id, ge.id } end
        end
      end
    end
  end
  return out
end

function sections.bases()
  local out = { }
  for name, b in pairs(data.itemBases) do
    local lines = { }
    for line in (b.implicit or ""):gmatch("[^\n]+") do lines[#lines + 1] = line end
    local implicits = lineEntries(lines)
    out[#out + 1] = {
      name = name, type = b.type, subType = b.subType, hidden = b.hidden and true or false,
      tags = keys(b.tags), influenceTags = plain(b.influenceTags, 1), socketLimit = b.socketLimit,
      req = plain(b.req, 1), armour = plain(b.armour, 1), weapon = plain(b.weapon, 2),
      flask = plain(b.flask, 2), implicits = implicits,
    }
  end
  return out
end

local function affixEntry(domain, id, mod)
  local raw = { }
  for _, line in ipairs(mod) do raw[#raw + 1] = line end
  local lines = lineEntries(raw)
  local weights = { }
  for i, k in ipairs(mod.weightKey or { }) do weights[#weights + 1] = { tag = k, weight = (mod.weightVal or { })[i] } end
  return {
    id = tostring(id), domain = domain, type = mod.type, affix = mod.affix, group = mod.group,
    level = mod.level, modTags = plain(mod.modTags, 1) or { }, weights = weights,
    types = keys(mod.types), lines = lines,
  }
end

function sections.affixes()
  local out = { }
  -- Skipped: Item (PoB's merged copy of other domains), ItemExclusive (base implicits and unique-only mods,
  -- already stored with their bases and uniques) and Vestigial (a subset of ItemExclusive).
  local skip = { Item = true, ItemExclusive = true, Vestigial = true }
  for domain, mods in pairs(data.itemMods) do
    if not skip[domain] then
      for id, mod in pairs(mods) do out[#out + 1] = affixEntry(domain, id, mod) end
    end
  end
  for i, mod in ipairs(data.masterMods or { }) do out[#out + 1] = affixEntry("Bench", "Bench" .. i, mod) end
  for id, mod in pairs(data.veiledMods or { }) do out[#out + 1] = affixEntry("Veiled", id, mod) end
  return out
end

function sections.uniques()
  local out = { }
  for kind, list in pairs(data.uniques) do
    for _, raw in pairs(list) do
      local ok, item = pcall(function() return new("Item"):Item(raw, "UNIQUE", true) end)
      if not ok then stats.uniqueErrors = stats.uniqueErrors + 1
      elseif not (item and item.base) then stats.uniquesWithoutBase = stats.uniquesWithoutBase + 1 end
      if ok and item and item.base then
        -- Variants with "Pre x.y" in the name ("Pre 3.19.0", "Focus Ailment Duration Pre 3.26.0",
        -- "(Pre 3.14)") are legacy versions; the rest are current (some uniques have several).
        local current = { }
        local names = { }
        local hasCurrent = false
        for _, name in ipairs(item.variantList or { }) do
          if name == "Current" then hasCurrent = true end
        end
        for i, name in ipairs(item.variantList or { }) do
          if not isLegacyVariant(name, hasCurrent) then current[i] = true; names[#names + 1] = name end
        end
        local function keep(modLine)
          if not modLine.variantList or not item.variantList then return true, nil end
          local vs = { }
          for i in pairs(modLine.variantList) do
            if current[i] then vs[#vs + 1] = item.variantList[i] end
          end
          table.sort(vs)
          return #vs > 0, vs
        end
        local lines = { }
        for _, pair in ipairs({ { "implicit", item.implicitModLines }, { "explicit", item.explicitModLines } }) do
          for _, ml in ipairs(pair[2] or { }) do
            local yes, vs = keep(ml)
            if yes and ml.line then
              lines[#lines + 1] = {
                kind = pair[1], text = ml.line, variants = vs,
                supported = ml.extra == nil, extra = ml.extra, mods = serMods(ml.modList),
              }
            end
          end
        end
        out[#out + 1] = {
          name = item.title, base = item.baseName, type = item.type, file = kind,
          league = item.league, source = item.source,
          reqLevel = item.requirements and item.requirements.level or nil,
          variants = names, lines = lines,
        }
      end
    end
  end
  return out
end

function sections.tree()
  local tree = main.tree[latestTreeVersion]
  local nodes = { }
  for id, node in pairs(tree.nodes) do
    if not node.isProxy and not (node.group and node.group.isProxy) then
      local lines = processedEntries(node.sd, node.mods)
      local mastery = { }
      for _, fx in ipairs(node.masteryEffects or { }) do mastery[#mastery + 1] = fx.effect end
      local className
      if node.classStartIndex and tree.classes[node.classStartIndex] then
        className = tree.classes[node.classStartIndex].name
      end
      nodes[#nodes + 1] = {
        id = id, name = node.dn, type = node.type, ascendancy = node.ascendancyName,
        class = className, x = node.x, y = node.y, group = node.g,
        multipleChoice = node.isMultipleChoiceOption and true or false,
        blighted = node.isBlighted and true or false,
        links = plain(node.linkedId, 1) or { }, lines = lines, masteryEffects = mastery,
      }
    end
  end
  local effects = { }
  for id, fx in pairs(tree.masteryEffects or { }) do
    effects[#effects + 1] = { id = id, lines = processedEntries(fx.sd, fx.mods) }
  end
  local classes = { }
  for i, c in pairs(tree.classes or { }) do
    local asc = { }
    for _, a in pairs(c.classes or { }) do asc[#asc + 1] = a.name end
    table.sort(asc)
    classes[#classes + 1] = { index = i, name = c.name, ascendancies = asc }
  end
  return { nodes = nodes, masteryEffects = effects, classes = classes }
end

-- Read last: counts from every section run before it.
function sections.stats()
  return stats
end

function bl_extract(name)
  local fn = sections[name]
  if not fn then error("no section " .. tostring(name)) end
  return dkjson.encode(fn())
end
