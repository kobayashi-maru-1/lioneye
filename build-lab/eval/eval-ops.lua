-- Evaluation operations inside a headless PoB (loaded by evaluator.py).
--
-- Probes use PoB's misc calculator (calcs.getMiscCalculator): no state change, ~5-20 ms each.
-- Changes (ev_apply) edit the build in memory the way PoB's UI does, then recalculate (~150-250 ms). A batch is
-- all-or-nothing: on any failure (bad op, calc error, main skill changed) the build is restored from a snapshot.
-- Arguments arrive as JSON strings and results leave as JSON strings (dkjson). Errors are raised without Lua
-- location prefixes (error(msg, 0)) so callers can show them as-is.

local dkjson = require "dkjson"

local function B() return launch.main.modes.BUILD end

local function fail(msg) error(msg, 0) end

local function decode(s, what)
  local v, _, err = dkjson.decode(s)
  if err then fail("bad JSON for " .. what .. ": " .. tostring(err)) end
  return v
end

-- A JSON array (dkjson gives arrays as Lua sequences; an object has string keys).
local function isList(v)
  if type(v) ~= "table" then return false end
  for k in pairs(v) do if type(k) ~= "number" then return false end end
  return true
end

-- PoB reports calc errors through launch.promptMsg (OnFrame runs in a protected call). Take and clear it.
local function takePrompt()
  local m = launch.promptMsg
  if not m then return nil end
  launch.promptMsg = nil
  m = tostring(m):gsub("%^x%x%x%x%x%x%x", ""):gsub("%^%d", "")
  -- Keep PoB's message, drop its UI boilerplate ("Error:\n\nIn 'OnFrame': ... \nv2.68.1 master\nPress Enter...").
  m = m:gsub("\nv%d+%.%d+.*$", ""):gsub("^Error:%s*", ""):gsub("^In '%w+':%s*", "")
  return m
end

local function int(v, what)
  local n = tonumber(v)
  if not n or n % 1 ~= 0 then fail(what .. " must be a whole number, got " .. tostring(v)) end
  return n
end

function ev_clear_prompt()
  launch.promptMsg = nil
end

local function mainSkillName()
  local ok, name = pcall(function() return B().calcsTab.mainEnv.player.mainSkill.activeEffect.grantedEffect.name end)
  return ok and name or nil
end

local function recalc()
  local b = B()
  b.buildFlag = true
  runCallback("OnFrame")
  ev_calc = nil
  local err = takePrompt()
  if err then fail("PoB's calculation failed: " .. err) end
end

local function calculator()
  if not ev_calc then
    local b = B()
    ev_calc = b.calcsTab.calcs.getMiscCalculator(b)
  end
  return ev_calc
end

local function num(v)
  if type(v) ~= "number" then return nil end
  if v ~= v or v == math.huge or v == -math.huge then return nil end
  return v
end

-- FullDPS: the calculator leaves these out when no group counts in Full DPS, the main calc says 0. Report 0.
local zeroWhenMissing = { FullDPS = true, FullDotDPS = true }

local function pick(out, keys, minionKeys)
  local res = { player = { } }
  for _, k in ipairs(keys) do
    res.player[k] = num(out[k])
    if res.player[k] == nil and zeroWhenMissing[k] then res.player[k] = 0 end
  end
  if out.Minion and minionKeys then
    res.minion = { }
    for _, k in ipairs(minionKeys) do res.minion[k] = num(out.Minion[k]) end
  end
  return res
end

-- ---------- lookups ----------

local gemByName
local function findGem(name)
  if type(name) ~= "string" then return nil end
  if not gemByName then
    gemByName = { }
    for id, gem in pairs(data.gems) do
      gemByName[gem.name:lower()] = id
    end
  end
  local lower = name:lower()
  local id = gemByName[lower] or gemByName[(lower:gsub(" support$", ""))]
    or data.gemForBaseName[lower] or data.gemForBaseName[lower .. " support"]
  return id and data.gems[id]
end

local function node(id)
  local n = B().spec.nodes[tonumber(id)]
  if not n then fail("no passive node " .. tostring(id)) end
  return n
end

-- The nodes allocating n takes: its path from the tree, or only n inside an Intuitive Leap / Thread of Hope /
-- Impossible Escape radius (PassiveSpec:AllocNode does the same).
local function pathOf(n)
  if not n.path then return nil end
  if n.intuitiveLeapLikesAffecting and #n.intuitiveLeapLikesAffecting > 0 then return { n } end
  return n.path
end

local function group(index)
  local b = B()
  local i = index == "main" and b.mainSocketGroup or tonumber(index)
  local g = b.skillsTab.socketGroupList[i]
  if not g then fail("no skill group " .. tostring(index)) end
  return g, i
end

local function parseItem(text)
  if type(text) ~= "string" then fail("item text must be a string") end
  local ok, item = pcall(function() return new("Item"):Item(text) end)
  if not ok or not item or not item.base then fail("PoB couldn't read the item:\n" .. text:sub(1, 200)) end
  item:BuildModList()
  return item
end

local function slotFor(slotName, item)
  local it = B().itemsTab
  local slot = type(slotName) == "string" and it.slots[slotName]
  if not slot then fail("no item slot '" .. tostring(slotName) .. "'") end
  if item and not it:IsItemValidForSlot(item, slotName) then
    fail((item.name or "the item") .. " can't go in " .. slotName)
  end
  return slot
end

-- Which node already holds a mastery effect (PoB lets each effect be chosen once on the tree).
local function effectHolder(effectId)
  for nodeId, eff in pairs(B().spec.masterySelections or { }) do
    if eff == effectId then return nodeId end
  end
end

-- Check a mastery effect choice for node n: offered by that mastery and not taken elsewhere. Returns the id.
local function checkMasteryEffect(n, effectId)
  local id = tonumber(effectId)
  local offered = false
  for _, fx in ipairs(n.masteryEffects or { }) do if fx.effect == id then offered = true end end
  if not id or not B().spec.tree.masteryEffects[id] or not offered then
    fail("mastery " .. n.id .. " (" .. tostring(n.dn) .. ") has no effect " .. tostring(effectId))
  end
  local holder = effectHolder(id)
  if holder and holder ~= n.id then
    fail("mastery effect " .. id .. " is already taken by node " .. holder .. "; PoB allows each effect once")
  end
  return id
end

-- A mastery node with one chosen effect, as PoB's node-power builder makes it (for calculator overrides).
local function masteryEffectNode(n, effectId)
  local eff = B().spec.tree.masteryEffects[checkMasteryEffect(n, effectId)]
  local en = { id = n.id, type = n.type, name = n.name, dn = n.dn, sd = { } }
  for i, sd in ipairs(eff.sd or { }) do en.sd[i] = sd end
  B().spec.tree:ProcessStats(en)
  return en
end

-- ---------- probes ----------

-- spec: {allocate = {ids}, masteries = {[id] = effectId}, deallocate = {ids}, addNodes = {ids},
--        removeNodes = {ids}, item = {slot, text}, conditions = {...}}
-- allocate adds each node with its path from the tree; a mastery (in allocate or on a path) needs its effect in
-- masteries. Several allocates union their shortest paths (may cost more than allocating one by one).
-- deallocate removes each node with the nodes that depend on it. addNodes/removeNodes take exact node sets.
local function buildOverride(spec)
  if type(spec) ~= "table" or isList(spec) and next(spec) then fail("a probe spec must be an object") end
  local o = { }
  local add, remove = { }, { }
  local masteries = spec.masteries or { }
  if type(masteries) ~= "table" or (isList(masteries) and next(masteries)) then fail("masteries must be an object {nodeId: effectId}") end
  for k, eff in pairs(masteries) do
    local n = node(k)
    if n.alloc and B().spec.masterySelections[n.id] ~= tonumber(eff) then
      fail("mastery " .. n.id .. " is already allocated with effect " .. tostring(B().spec.masterySelections[n.id])
           .. "; deallocate it first to change the effect")
    end
  end
  local seen, usedEffects = { }, { }  -- one synthetic node per mastery; each effect once per probe
  local function addNode(n)
    if n.alloc or seen[n.id] then return end
    seen[n.id] = true
    if n.type == "Mastery" then
      local eff = masteries[tostring(n.id)] or masteries[n.id]
      if not eff then fail("mastery " .. n.id .. " (" .. tostring(n.dn) .. ") needs an effect: masteries = {\"" .. n.id .. "\": effectId}") end
      if usedEffects[tonumber(eff)] then fail("mastery effect " .. tostring(eff) .. " is chosen twice") end
      usedEffects[tonumber(eff)] = true
      add[masteryEffectNode(n, eff)] = true
    else
      add[n] = true
    end
  end
  for _, id in ipairs(spec.allocate or { }) do
    local n = node(id)
    if not n.alloc then
      local path = pathOf(n)
      if not path then fail("node " .. id .. " (" .. tostring(n.dn) .. ") can't be reached from the tree") end
      for _, p in ipairs(path) do addNode(p) end
    end
  end
  for _, id in ipairs(spec.addNodes or { }) do addNode(node(id)) end
  for _, id in ipairs(spec.deallocate or { }) do
    local n = node(id)
    if n.alloc then
      for _, d in ipairs(n.depends or { n }) do remove[d] = true end
    end
  end
  for _, id in ipairs(spec.removeNodes or { }) do
    local n = node(id)
    if n.alloc then remove[n] = true end
  end
  -- The calculator doesn't match a real deallocation when a removed socket holds a jewel (cluster subgraphs,
  -- radius jewels): checked against XML reloads. Refuse instead of returning a wrong number.
  local jewels = B().spec.jewels or { }
  for n in pairs(remove) do
    if n.type == "Socket" and jewels[n.id] and jewels[n.id] ~= 0 then
      fail("removing " .. tostring(n.dn) .. " (" .. n.id .. ") takes out a socketed jewel; a probe can't model "
           .. "that exactly, use apply deallocate")
    end
  end
  if next(add) then o.addNodes = add end
  if next(remove) then o.removeNodes = remove end
  if spec.item then
    local item = parseItem(spec.item.text)
    local slot = slotFor(spec.item.slot, item)
    if spec.item.slot:find("^Flask") and not slot.active then
      fail(spec.item.slot .. " is switched off and a probe keeps the slot's state; use apply equip")
    end
    o.repSlotName = spec.item.slot
    o.repItem = item
  end
  if spec.conditions then
    if not isList(spec.conditions) then fail("conditions must be a list of condition names") end
    o.conditions = spec.conditions
  end
  local points = 0
  for _ in pairs(add) do points = points + 1 end
  for _ in pairs(remove) do points = points - 1 end
  return o, points
end

-- specs: JSON list of specs; keys / minionKeys: JSON lists. Returns a JSON list of results ({error} per bad spec).
function ev_probe(specsJson, keysJson, minionKeysJson)
  local specs = decode(specsJson, "probe specs")
  if not isList(specs) then fail("probe specs must be a list") end
  local keys, minionKeys = decode(keysJson, "keys"), decode(minionKeysJson, "minion keys")
  local calc = calculator()
  local out = { }
  for i, spec in ipairs(specs) do
    local ok, res = pcall(function()
      local o, points = buildOverride(spec)
      local r = pick(calc(o), keys, minionKeys)
      r.points = points
      return r
    end)
    out[i] = ok and res or { error = tostring(res) }
  end
  return dkjson.encode(out)
end

-- The build's current numbers, from the main calc.
function ev_stats(keysJson, minionKeysJson)
  local res = pick(B().calcsTab.mainOutput, decode(keysJson, "keys"), decode(minionKeysJson, "minion keys"))
  res.mainSkill = mainSkillName()
  return dkjson.encode(res)
end

-- ---------- changes ----------

local added = { }  -- item ids ev_apply added, so a later replacement can delete them

local ops = { }

function ops.allocate(op)
  local spec = B().spec
  local masteries = op.masteries or { }
  for k, eff in pairs(masteries) do
    local n = node(k)
    if n.alloc and spec.masterySelections[n.id] ~= tonumber(eff) then
      fail("mastery " .. n.id .. " is already allocated with effect " .. tostring(spec.masterySelections[n.id])
           .. "; deallocate it first to change the effect")
    end
  end
  for _, id in ipairs(op.nodes or { }) do
    local n = node(id)
    if not n.alloc then
      local path = pathOf(n)
      if not path then fail("node " .. id .. " (" .. tostring(n.dn) .. ") can't be reached from the tree") end
      for _, p in ipairs(path) do
        if p.type == "Mastery" and not p.alloc then
          local eff = masteries[tostring(p.id)] or masteries[p.id]
          if not eff then fail("mastery " .. p.id .. " (" .. tostring(p.dn) .. ") needs an effect: masteries = {\"" .. p.id .. "\": effectId}") end
          spec.masterySelections[p.id] = checkMasteryEffect(p, eff)
        end
      end
      spec:AllocNode(n)
    end
  end
end

function ops.deallocate(op)
  local spec = B().spec
  for _, id in ipairs(op.nodes or { }) do
    local n = node(id)
    if n.alloc then spec:DeallocNode(n) end
  end
end

local function dropIfOurs(it, id)
  if id and id ~= 0 and added[id] and it.items[id] then
    added[id] = nil
    it:DeleteItem(it.items[id], true)
  end
end

local function setFlaskActive(it, slotName, slot, active)
  slot.active = active
  if it.activeItemSet and it.activeItemSet[slotName] then it.activeItemSet[slotName].active = active end
  if slot.controls and slot.controls.activate then slot.controls.activate.state = active end
end

function ops.equip(op)
  local it = B().itemsTab
  local item = parseItem(op.text)
  local slot = slotFor(op.slot, item)
  local old = slot.selItemId
  it:AddItem(item, true)
  added[item.id] = true
  slot:SetSelItemId(item.id)
  if op.slot:find("^Flask") then setFlaskActive(it, op.slot, slot, op.active ~= false) end
  it:PopulateSlots()
  if slot.selItemId ~= item.id then fail("PoB didn't keep the item in " .. op.slot) end
  dropIfOurs(it, old)
end

function ops.unequip(op)
  local it = B().itemsTab
  local slot = slotFor(op.slot)
  local old = slot.selItemId
  slot:SetSelItemId(0)
  it:PopulateSlots()
  dropIfOurs(it, old)
end

-- Fields a gem instance carries for the gem it was (minion choice, skill part, ...), cleared on replacement.
local gemStateFields = { "skillPart", "skillPartCalcs", "skillMinion", "skillMinionCalcs", "skillMinionItemSet",
  "skillMinionItemSetCalcs", "skillMinionSkill", "skillMinionSkillCalcs", "skillStageCount", "skillStageCountCalcs",
  "skillMineCount", "skillMineCountCalcs", "statSet", "statSetCalcs", "errMsg" }

-- Replace the gem at index (or append when index is past the end) in a group ("main" or 1-based index).
function ops.gem(op)
  local g = group(op.group)
  local gem = findGem(op.name)
  if not gem then fail("no gem '" .. tostring(op.name) .. "'") end
  local index = op.index and int(op.index, "gem index") or (#g.gemList + 1)
  if index < 1 or index > #g.gemList + 1 then fail("gem index " .. tostring(index) .. " is out of range") end
  if op.level ~= nil then int(op.level, "gem level") end
  if op.quality ~= nil then int(op.quality, "gem quality") end
  local inst = g.gemList[index]
  if not inst then
    inst = { enabled = true, enableGlobal1 = true, enableGlobal2 = false, count = 1, qualityId = "Default" }
    g.gemList[#g.gemList + 1] = inst
  end
  for _, f in ipairs(gemStateFields) do inst[f] = nil end
  -- Without gemData, ProcessSocketGroup keeps the level we set instead of resetting it to the gem's max.
  inst.gemData, inst.grantedEffect = nil, nil
  inst.gemId, inst.skillId, inst.nameSpec = gem.id, gem.grantedEffectId, gem.name
  inst.level = op.level or gem.naturalMaxLevel or 20
  inst.quality = op.quality or 0
  inst.count = 1
  if op.enabled ~= nil then inst.enabled = op.enabled end
  B().skillsTab:ProcessSocketGroup(g)
end

ops["gem-remove"] = function(op)
  local g = group(op.group)
  local index = int(op.index, "gem index")
  if not g.gemList[index] then fail("no gem at index " .. index) end
  table.remove(g.gemList, index)
  B().skillsTab:ProcessSocketGroup(g)
end

ops["gem-enable"] = function(op)
  local g = group(op.group)
  local inst = g.gemList[int(op.index, "gem index")]
  if not inst then fail("no gem at index " .. tostring(op.index)) end
  inst.enabled = op.enabled ~= false
end

-- A Config tab option, by its variable name (as in the build XML's <Input name="...">).
function ops.config(op)
  local ct = B().configTab
  if type(op.var) ~= "string" or not ct.varControls[op.var] then fail("no config option '" .. tostring(op.var) .. "'") end
  local tv = type(op.value)
  if tv ~= "string" and tv ~= "number" and tv ~= "boolean" then fail("a config value must be a string, number or boolean") end
  local set = ct.configSets[ct.activeConfigSetId]
  set.input[op.var] = op.value
  ct.input = set.input
  ct:BuildModList()
end

-- ops: JSON list of {op = "...", ...}; allowMainChange: JSON bool. All-or-nothing: on a bad op, a calc error,
-- or (unless allowed) a different main skill afterwards, the build is restored and the error returned.
-- Returns JSON {ok = true} or {error = msg}.
function ev_apply(opsJson, allowMainChangeJson)
  local okDecode, list = pcall(decode, opsJson, "ops")
  if not okDecode then return dkjson.encode({ error = list }) end
  if not isList(list) then return dkjson.encode({ error = "ops must be a list of {op = ...}" }) end
  local allowMainChange = decode(allowMainChangeJson, "allowMainChange") == true
  local b = B()
  local before = mainSkillName()
  local snapshot = b:SaveDB("ev-snapshot")
  if type(snapshot) ~= "string" or snapshot == "" then
    return dkjson.encode({ error = "couldn't snapshot the build before changing it; nothing was changed" })
  end
  local addedBefore = copyTable(added, true)
  local ok, err = pcall(function()
    for _, op in ipairs(list) do
      if type(op) ~= "table" then fail("each op must be an object") end
      local fn = ops[op.op]
      if not fn then fail("unknown op '" .. tostring(op.op) .. "'") end
      fn(op)
    end
    recalc()
    local after = mainSkillName()
    if not allowMainChange and after ~= before then
      fail("the main skill changed from " .. tostring(before) .. " to " .. tostring(after)
           .. "; pass allow_main_change to keep it")
    end
  end)
  if ok then return dkjson.encode({ ok = true }) end
  -- Restore the build as it was. If that fails the build is gone: report it as lost (the caller must reload).
  takePrompt()
  local okLoad, loadErr = pcall(loadBuildFromXML, snapshot, "ev-snapshot")
  local restoreErr = (not okLoad and tostring(loadErr)) or takePrompt()
  added = addedBefore
  ev_calc = nil
  if restoreErr or not B() or mainSkillName() ~= before then
    return dkjson.encode({ error = tostring(err), lost = "restoring the build failed: " .. tostring(restoreErr or "main skill differs") })
  end
  return dkjson.encode({ error = tostring(err) })
end

-- ---------- support trials ----------

-- Supports PoB allows on the main skill as it is now (its current skill types, which include types added by
-- the supports already in the group).
function ev_compatible_supports()
  local b = B()
  local skill = b.calcsTab.mainEnv.player.mainSkill
  if not skill then fail("no main skill") end
  local g = group("main")
  local have = { }
  for _, inst in ipairs(g.gemList) do if inst.gemId then have[inst.gemId] = true end end
  local out = { }
  for id, gem in pairs(data.gems) do
    local ge = gem.grantedEffect
    if ge and ge.support and not ge.unsupported and not have[id] then
      local ok, yes = pcall(calcLib.canGrantedEffectSupportActiveSkill, ge, skill)
      if ok and yes then out[#out + 1] = gem.name end
    end
  end
  table.sort(out)
  return dkjson.encode(out)
end

-- Try each candidate support in slot `index` of the main group (a support's slot, or one past the end to add),
-- one recalc each; the group is restored after. trials: JSON list of {index, name, level?, quality?, enabled?}.
-- A trial that changes the main skill or fails PoB's calculation returns {error}.
function ev_support_trials(trialsJson, keysJson, minionKeysJson)
  local trials = decode(trialsJson, "trials")
  if not isList(trials) then fail("trials must be a list") end
  local keys, minionKeys = decode(keysJson, "keys"), decode(minionKeysJson, "minion keys")
  local b = B()
  local g = group("main")
  local mainName = mainSkillName()
  local saved = { }
  for i, inst in ipairs(g.gemList) do saved[i] = copyTable(inst, true) end
  local savedActive = g.mainActiveSkill
  local count = #g.gemList
  local out = { }
  for t, trial in ipairs(trials) do
    local ok, res = pcall(function()
      if type(trial) ~= "table" then fail("each trial must be an object") end
      trial.index = int(trial.index, "trial index")
      local cur = g.gemList[trial.index]
      if cur and not (cur.gemData and cur.gemData.grantedEffect.support) then
        fail("gem " .. tostring(trial.index) .. " (" .. tostring(cur.nameSpec) .. ") isn't a support")
      end
      ops.gem({ group = "main", index = trial.index, name = trial.name, level = trial.level,
                quality = trial.quality or 0, enabled = trial.enabled })
      b.buildFlag = true
      runCallback("OnFrame")
      local err = takePrompt()
      if err then fail("PoB's calculation failed: " .. err) end
      if mainSkillName() ~= mainName then fail("the main skill changed to " .. tostring(mainSkillName())) end
      return pick(b.calcsTab.mainOutput, keys, minionKeys)
    end)
    out[t] = ok and res or { error = tostring(res) }
    -- restore the group's gems (same tables, original fields) for the next trial
    for i = #g.gemList, count + 1, -1 do g.gemList[i] = nil end
    for i, inst in ipairs(saved) do
      local live = g.gemList[i]
      for k in pairs(live) do live[k] = nil end
      for k, v in pairs(inst) do live[k] = v end
    end
    g.mainActiveSkill = savedActive
    b.skillsTab:ProcessSocketGroup(g)
  end
  recalc()
  return dkjson.encode(out)
end

-- ---------- reading the build ----------

function ev_groups()
  local b = B()
  local out = { }
  for i, g in ipairs(b.skillsTab.socketGroupList) do
    local gems = { }
    for j, inst in ipairs(g.gemList) do
      gems[j] = { index = j, name = inst.nameSpec, level = inst.level, quality = inst.quality,
                  enabled = inst.enabled ~= false,
                  support = inst.gemData and inst.gemData.grantedEffect.support and true or false }
    end
    out[i] = { index = i, label = g.label or "", slot = g.slot or "", enabled = g.enabled ~= false,
               main = (i == b.mainSocketGroup), fullDPS = g.includeInFullDPS and true or false, gems = gems }
  end
  return dkjson.encode(out)
end

-- Unallocated nodes reachable from the tree, for node-power style searches. Skips ascendancy, mastery and
-- class-start nodes, and nodes farther than maxDist points.
function ev_reachable_nodes(maxDist)
  maxDist = tonumber(maxDist)
  local out = { }
  for id, n in pairs(B().spec.nodes) do
    local path = pathOf(n)
    if not n.alloc and path and not n.ascendancyName and n.type ~= "Mastery" and n.type ~= "ClassStart"
       and n.type ~= "AscendClassStart" and not n.isProxy and (not maxDist or #path <= maxDist) then
      out[#out + 1] = { id = id, name = n.dn, type = n.type, dist = #path }
    end
  end
  table.sort(out, function(a, b) return a.id < b.id end)
  return dkjson.encode(out)
end

-- Unallocated masteries reachable from the tree, with the effects each still offers (effects taken by another
-- mastery are left out).
function ev_reachable_masteries(maxDist)
  maxDist = tonumber(maxDist)
  local out = { }
  for id, n in pairs(B().spec.nodes) do
    local path = pathOf(n)
    if n.type == "Mastery" and not n.alloc and path and not n.ascendancyName and (not maxDist or #path <= maxDist) then
      local effects = { }
      for _, fx in ipairs(n.masteryEffects or { }) do
        if not effectHolder(fx.effect) then effects[#effects + 1] = fx.effect end
      end
      out[#out + 1] = { id = id, name = n.dn, dist = #path, effects = effects }
    end
  end
  table.sort(out, function(a, b) return a.id < b.id end)
  return dkjson.encode(out)
end

-- Node ids PoB would allocate to reach node `id`, or [] when it's allocated or unreachable.
function ev_node_path(id)
  local n = node(decode(id, "node id"))
  local out = { }
  for _, p in ipairs((not n.alloc and pathOf(n)) or { }) do out[#out + 1] = p.id end
  return dkjson.encode(out)
end

-- Node ids deallocating node `id` removes (it and the nodes that depend on it).
function ev_node_depends(id)
  local n = node(decode(id, "node id"))
  local out = { }
  for _, d in ipairs((n.alloc and (n.depends or { n })) or { }) do out[#out + 1] = d.id end
  return dkjson.encode(out)
end

-- What the build XML stores for a gem: {gemId (game id), variantId, skillId, name, maxLevel}.
function ev_gem_info(name)
  local gem = findGem(decode(name, "gem name"))
  if not gem then return dkjson.encode({ error = "no gem" }) end
  return dkjson.encode({ gemId = gem.gameId, variantId = gem.variantId, skillId = gem.grantedEffectId,
                         name = gem.name, maxLevel = gem.naturalMaxLevel })
end

-- Allocated nodes (for removal searches), with how many points removing each frees (itself + dependents).
function ev_allocated_nodes()
  local out = { }
  for id, n in pairs(B().spec.allocNodes) do
    if n.type ~= "ClassStart" and n.type ~= "AscendClassStart" and not n.ascendancyName then
      out[#out + 1] = { id = id, name = n.dn, type = n.type, frees = #(n.depends or { n }) }
    end
  end
  table.sort(out, function(a, b) return a.id < b.id end)
  return dkjson.encode(out)
end

-- After loading a new build, forget items added to the previous one.
function ev_reset()
  added = { }
  ev_calc = nil
  launch.promptMsg = nil
end
