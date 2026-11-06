-- Starts Path of Building's own headless mode (HeadlessWrapper.lua) inside exile-leveling.exe
-- and answers stat requests from the guide. Set by the exe before this runs:
--   host_dir           the unpacked PoB folder (forward slashes)
--   host_log(line)     writes a line to the exe's log
--   host_inflate(data) zlib-inflates data (PoB's Inflate; headless mode has none)
--   host_fetch(path)   downloads a timeless jewel file (path relative to host_dir); true if it did

local dir = host_dir

-- PoB opens files relative to its own folder; the exe's working folder is elsewhere.
local function abs(path)
	if type(path) ~= "string" or path:match("^%a:[/\\]") or path:match("^[/\\]") then
		return path
	end
	return dir .. "/" .. path
end

local raw = {
	loadfile = loadfile,
	open = io.open,
	lines = io.lines,
	remove = os.remove,
	rename = os.rename,
}
loadfile = function(path, ...) return raw.loadfile(abs(path), ...) end

-- Timeless jewel data isn't bundled (170 MB); the exe downloads a jewel's file the first
-- time PoB opens it. PoB tries X.zip, then X.zip.part0, part1, ... until one is missing.
local JEWELS = dir .. "/Data/TimelessJewelData/"
local fetched = {}
io.open = function(path, mode, ...)
	local full = abs(path)
	local writing = mode ~= nil and mode:find("[wa+]") ~= nil
	if type(full) == "string" and full:sub(1, #JEWELS) == JEWELS then
		-- PoB caches the inflated data as X.bin but never reads it back headless (no file search).
		if writing and full:match("%.bin$") then
			return nil, "not cached"
		end
		local file, err = raw.open(full, mode, ...)
		if file or writing then
			return file, err
		end
		local name = full:sub(#dir + 2)
		if fetched[name] == nil then
			fetched[name] = host_fetch ~= nil and host_fetch(name) or false
		end
		if fetched[name] then
			return raw.open(full, mode, ...)
		end
		return file, err
	end
	return raw.open(full, mode, ...)
end
io.lines = function(path, ...)
	if path == nil then return raw.lines() end
	return raw.lines(abs(path), ...)
end
os.remove = function(path) return raw.remove(abs(path)) end
os.rename = function(from, to) return raw.rename(abs(from), abs(to)) end
-- No console to read from.
io.read = function() return nil end
-- The standalone interpreter's command-line table; PoB reads arg[1] as a build link to open.
arg = {}

local lastLine = ""
print = function(...)
	local parts = {}
	for i = 1, select("#", ...) do
		parts[i] = tostring((select(i, ...)))
	end
	lastLine = table.concat(parts, "\t")
	host_log(lastLine)
end

package.path = dir .. "/?.lua;" .. dir .. "/lua/?.lua;" .. dir .. "/lua/?/init.lua"
package.cpath = ""

-- PoB's text boxes use lua-utf8, a native module. Headless never edits text,
-- so byte-wise string functions stand in for it.
package.preload["lua-utf8"] = function()
	return setmetatable({
		next = function(s, i)
			i = (i or 0) + 1
			if i > #s then return nil end
			return i, s:byte(i)
		end,
	}, { __index = string })
end

dofile = function(path)
	if path == "Launch.lua" then
		-- HeadlessWrapper defines these just before it starts PoB; point them at PoB's folder.
		GetScriptPath = function() return dir end
		GetRuntimePath = function() return dir end
		GetUserPath = function() return dir end
		GetWorkDir = function() return dir end
		Inflate = host_inflate or Inflate
	end
	local chunk = assert(raw.loadfile(abs(path)))
	return chunk()
end

-- PoB catches its own errors and shows them in a popup (launch.promptMsg) instead of raising them.
-- Returns the popup's error line, without colour codes or keyboard hints, and clears it.
local function takePromptError()
	local msg = launch and launch.promptMsg
	if not msg then
		return nil
	end
	launch.promptMsg = nil
	msg = msg:gsub("%^x%x%x%x%x%x%x", ""):gsub("%^%d", "")
	for line in msg:gmatch("[^\n]+") do
		line = line:match("^%s*(.-)%s*$")
		if line ~= "" and line ~= "Error:" then
			return line
		end
	end
	return msg
end

local function raisePromptError()
	local msg = takePromptError()
	if msg then
		error(msg, 0)
	end
end

dofile("HeadlessWrapper.lua")
if build == nil then
	error("PoB didn't start: " .. (takePromptError() or lastLine), 0)
end
-- Dev mode (PoB's update check off) would also save the open build on every switch.
main.disableDevAutoSave = true

-- Marks an error that leaves PoB usable, so the exe keeps it loaded.
local KEEP = "[keep] "

local json = require("dkjson")
local ARRAY = { __jsontype = "array" }
local SKIP = "^%^7%^7" -- PoB's own entries in the loadout list ("Loadouts:", "New Loadout", ...)

-- Only the latest tree ships with the exe; specs on an older tree load on the latest one.
local function hasTree(version)
	local file = raw.open(abs("TreeData/" .. version .. "/tree.lua"), "r")
	if file then
		file:close()
		return true
	end
	return false
end

local function treeName(version)
	return treeVersions[version] and treeVersions[version].display or version
end

-- Returns the XML with every spec on a bundled tree, and a note per tree that was swapped.
local function onBundledTrees(xml)
	local swapped = {}
	local function swap(version)
		if version == latestTreeVersion or hasTree(version) then
			return nil
		end
		swapped[version] = true
		return latestTreeVersion
	end
	-- A spec without treeVersion is on PoB's oldest multi-tree version.
	xml = xml:gsub("<Spec(%s[^>]*)>", function(attrs)
		if attrs:find('treeVersion="') then
			return nil
		end
		local version = swap(defaultTreeVersion) or defaultTreeVersion
		return '<Spec treeVersion="' .. version .. '"' .. attrs .. ">"
	end)
	xml = xml:gsub('treeVersion="([%w_]+)"', function(version)
		local to = swap(version)
		return to and ('treeVersion="' .. to .. '"') or nil
	end)
	local notes = {}
	for version in pairs(swapped) do
		notes[#notes + 1] = "^xFFB000Tree " .. treeName(version) .. " calculated on " .. treeName(latestTreeVersion)
	end
	table.sort(notes)
	return xml, notes
end

local function loadoutControl()
	return build.controls.buildLoadouts
end

local function loadouts()
	local names = setmetatable({}, ARRAY)
	for _, value in ipairs(loadoutControl().list) do
		if not value:match(SKIP) and value ~= "No Loadouts" then
			names[#names + 1] = value
		end
	end
	return names
end

local function currentLoadout()
	local control = loadoutControl()
	local value = control.list[control.selIndex]
	if value == nil or value:match(SKIP) or value == "No Loadouts" then
		return nil
	end
	return value
end

-- Same as picking the loadout in PoB's dropdown. Errors leave PoB usable, so they keep it loaded.
local function selectLoadout(name)
	local control = loadoutControl()
	for index, value in ipairs(control.list) do
		if value == name then
			local ok, err = pcall(control.selFunc, index, value)
			if not ok then
				error(KEEP .. "Loadout " .. name .. " didn't load: " .. tostring(err), 0)
			end
			runCallback("OnFrame")
			local msg = takePromptError()
			if msg then
				error(KEEP .. msg, 0)
			end
			if currentLoadout() ~= name then
				error(KEEP .. "Loadout " .. name .. " didn't load. Check its sets in PoB.", 0)
			end
			return
		end
	end
	error(KEEP .. "No loadout " .. name .. ". Re-import the build.", 0)
end

-- PoB's sidebar: { label, value } rows, single-text rows (headers, notes) and gaps.
local function rows()
	local out = setmetatable({}, ARRAY)
	for _, line in ipairs(build.controls.statBox.list) do
		if line[1] == nil then
			out[#out + 1] = { gap = true }
		elseif line[2] == nil then
			out[#out + 1] = { text = line[1] }
		else
			out[#out + 1] = { label = line[1], value = line[2] }
		end
	end
	return out
end

local loadedXml
local treeNotes = {}

local function warnings()
	local out = setmetatable({}, ARRAY)
	for _, line in ipairs(treeNotes) do
		out[#out + 1] = line
	end
	for _, line in ipairs(build.controls.warnings.lines or {}) do
		out[#out + 1] = line
	end
	return out
end

-- Main skill -----------------------------------------------------------------------------
-- PoB keeps the main skill as one group number for every loadout, so reordered groups
-- change the skill. The guide remembers the skill gem instead and sends it as a pick.
-- Every change made for a pick is undone before the next request, so a loadout without
-- the picked gem shows exactly PoB's own main skill.

local undo = {}

local function setUndoable(tbl, key, value)
	if tbl[key] == value then
		return
	end
	undo[#undo + 1] = { tbl, key, tbl[key] }
	tbl[key] = value
	build.buildFlag = true
end

local function undoPicks()
	for i = #undo, 1, -1 do
		local entry = undo[i]
		entry[1][entry[2]] = entry[3]
		build.buildFlag = true
	end
	undo = {}
end

local function recalc()
	runCallback("OnFrame")
	local msg = takePromptError()
	if msg then
		error(KEEP .. msg, 0)
	end
end

local function mainActive()
	local group = build.skillsTab.socketGroupList[build.mainSocketGroup]
	local list = group and group.displaySkillList
	return group, list and list[group.mainActiveSkill or 1]
end

local function grantedId(active)
	return active and active.activeEffect and active.activeEffect.grantedEffect
		and active.activeEffect.grantedEffect.id
end

-- Active skill ids of a group, in PoB's order. PoB only builds displaySkillList for the
-- main group and enabled groups; for the others, read the group's active gems.
local function groupSkillIds(group)
	local ids = {}
	for _, active in ipairs(group.displaySkillList or {}) do
		ids[#ids + 1] = grantedId(active) or ""
	end
	if #ids == 0 then
		for _, gem in ipairs(group.gemList or {}) do
			local effect = gem.gemData and gem.gemData.grantedEffect or gem.grantedEffect
			if effect and not effect.support and gem.enabled then
				ids[#ids + 1] = effect.id
			end
		end
	end
	return ids
end

-- Applies a pick ({ id, label, group, skill, part, minion, minionSkill }); false when this
-- loadout has no group with that skill gem.
local function applyPick(pick)
	-- Search PoB's own state for this loadout, not lists left from the previous request.
	if build.buildFlag then
		recalc()
	end

	local best
	for groupIndex, group in ipairs(build.skillsTab.socketGroupList) do
		for skillIndex, id in ipairs(groupSkillIds(group)) do
			if id == pick.id then
				-- Enabled groups first, then the label you picked, then the same positions.
				local score = (group.enabled and 8 or 0)
					+ (group.displayLabel == pick.label and 4 or 0)
					+ (groupIndex == pick.group and 2 or 0)
					+ (skillIndex == pick.skill and 1 or 0)
				if best == nil or score > best.score then
					best = { group = groupIndex, skill = skillIndex, score = score }
				end
			end
		end
	end
	if best == nil then
		return false
	end

	local group = build.skillsTab.socketGroupList[best.group]
	setUndoable(build, "mainSocketGroup", best.group)
	setUndoable(group, "mainActiveSkill", best.skill)
	if build.buildFlag then
		recalc()
	end
	-- A group that wasn't calculated before may list its skills differently from its gems.
	local _, active = mainActive()
	if grantedId(active) ~= pick.id then
		for skillIndex, skill in ipairs(group.displaySkillList or {}) do
			if grantedId(skill) == pick.id then
				setUndoable(group, "mainActiveSkill", skillIndex)
				recalc()
				break
			end
		end
		_, active = mainActive()
	end
	if not active or grantedId(active) ~= pick.id then
		return true
	end

	local effect = active.activeEffect
	local source = effect.srcInstance
	if pick.part and effect.grantedEffect.parts then
		for index, part in ipairs(effect.grantedEffect.parts) do
			if part.name == pick.part then
				setUndoable(source, "skillPart", index)
			end
		end
	end
	if pick.minion then
		if effect.grantedEffect.minionHasItemSet then
			for _, itemSetId in ipairs(build.itemsTab.itemSetOrderList) do
				if (build.itemsTab.itemSets[itemSetId].title or "Default Item Set") == pick.minion then
					setUndoable(source, "skillMinionItemSet", itemSetId)
				end
			end
		else
			for _, minionId in ipairs(active.minionList or {}) do
				local minion = build.data.minions[minionId]
				if minion and minion.name == pick.minion then
					setUndoable(source, "skillMinion", minionId)
				end
			end
		end
	end
	if build.buildFlag then
		recalc()
	end

	-- A minion's skills exist only after a calculation with that minion.
	if pick.minionSkill then
		local _, current = mainActive()
		if current and current.minion then
			for index, skill in ipairs(current.minion.activeSkillList) do
				if skill.activeEffect.grantedEffect.name == pick.minionSkill then
					setUndoable(current.activeEffect.srcInstance, "skillMinionSkill", index)
					break
				end
			end
		end
	end
	return true
end

local function labels(list)
	local out = setmetatable({}, ARRAY)
	for _, entry in ipairs(list) do
		out[#out + 1] = type(entry) == "table" and (entry.label or "") or tostring(entry)
	end
	return out
end

-- PoB's main skill controls, as the guide shows them.
local function skillState(picked)
	local controls = build.controls
	local group, active = mainActive()
	local groupSkills = setmetatable({}, ARRAY)
	local groupMain = setmetatable({}, ARRAY)
	for index, socketGroup in ipairs(build.skillsTab.socketGroupList) do
		groupSkills[index] = setmetatable(groupSkillIds(socketGroup), ARRAY)
		groupMain[index] = socketGroup.mainActiveSkill or 1
	end
	local function shown(control)
		return control.shown == true
	end
	return {
		picked = picked,
		id = grantedId(active),
		label = group and group.displayLabel,
		groups = labels(controls.mainSocketGroup.list),
		groupSkills = groupSkills,
		-- Each group's own main skill, the default when you pick that group.
		groupMain = groupMain,
		group = controls.mainSocketGroup.selIndex,
		skills = shown(controls.mainSkill) and labels(controls.mainSkill.list) or setmetatable({}, ARRAY),
		skill = shown(controls.mainSkill) and controls.mainSkill.selIndex or nil,
		parts = shown(controls.mainSkillPart) and labels(controls.mainSkillPart.list) or setmetatable({}, ARRAY),
		part = shown(controls.mainSkillPart) and controls.mainSkillPart.selIndex or nil,
		minions = shown(controls.mainSkillMinion) and labels(controls.mainSkillMinion.list) or setmetatable({}, ARRAY),
		minion = shown(controls.mainSkillMinion) and controls.mainSkillMinion.selIndex or nil,
		minionSkills = shown(controls.mainSkillMinionSkill) and labels(controls.mainSkillMinionSkill.list) or setmetatable({}, ARRAY),
		minionSkill = shown(controls.mainSkillMinionSkill) and controls.mainSkillMinionSkill.selIndex or nil,
	}
end

-- Sets and config ----------------------------------------------------------------------

-- Titles of the sets PoB uses for the shown loadout, so the guide's tree and gem
-- sections can follow the same loadout.
local function setTitles()
	local tree = build.treeTab.specList[build.treeTab.activeSpec]
	local skills = build.skillsTab.skillSets[build.skillsTab.activeSkillSetId]
	local items = build.itemsTab.itemSets[build.itemsTab.activeItemSetId]
	local config = build.configTab.configSets[build.configTab.activeConfigSetId]
	return {
		tree = tree and tree.title or "Default",
		-- nil for an untitled skill set: the guide groups its gems by label instead.
		skills = skills and skills.title or nil,
		items = items and items.title or "Default",
		config = config and config.title or "Default",
	}
end

local configOptions

-- The config options this loadout sets away from PoB's defaults, with PoB's labels,
-- under their section names: { section } and { label, value } rows.
local function configRows(configSet)
	configOptions = configOptions or LoadModule("Modules/ConfigOptions")
	local tab = build.configTab
	-- PoB's GetDefaultState, for any config set: its placeholder first, then the default.
	local function defaultState(var, valueType)
		local placeholder = configSet.placeholder and configSet.placeholder[var]
		if placeholder ~= nil then
			return placeholder
		end
		if tab.defaultState[var] ~= nil then
			return tab.defaultState[var]
		end
		if valueType == "number" then
			return 0
		elseif valueType == "boolean" then
			return false
		end
		return ""
	end
	local out = setmetatable({}, ARRAY)
	local section, lastSection
	for _, option in ipairs(configOptions) do
		if option.section then
			section = option.section
		elseif option.var and option.label then
			local value = configSet.input[option.var]
			local unset = value == nil or value == "" or value == defaultState(option.var, type(value))
			if not unset then
				local shown
				if option.type == "check" then
					shown = value and "Yes" or "No"
				elseif option.type == "list" then
					for _, entry in ipairs(option.list or {}) do
						if entry.val == value then
							shown = entry.label
						end
					end
				end
				if section ~= lastSection then
					out[#out + 1] = { section = section }
					lastSection = section
				end
				out[#out + 1] = {
					label = option.label,
					value = shown or tostring(value),
					check = option.type == "check" or nil,
				}
			end
		end
	end
	-- Custom Modifiers: each mod group's lines as typed, `off` where PoB doesn't apply the
	-- line (it can't read it, e.g. a "#" note, or its group is turned off). Groups get
	-- titles only when there's more than one.
	local blocks = configSet.customModsList or {}
	if #blocks == 0 and configSet.input.customMods then
		blocks = { { title = "Default", enabled = true, text = configSet.input.customMods } }
	end
	local started = false
	for _, block in ipairs(blocks) do
		local text = block.text or ""
		if text:match("%S") then
			if not started then
				out[#out + 1] = { section = "Custom Modifiers" }
				started = true
			end
			if #blocks > 1 or block.enabled == false then
				out[#out + 1] = {
					group = (block.title or "Group") .. (block.enabled == false and " (off)" or ""),
				}
			end
			for line in text:gmatch("[^\r\n]+") do
				if line:match("%S") then
					-- As PoB's ConfigTab:BuildModList reads it.
					local mods, extra = modLib.parseMod(StripEscapes(line):match("^%s*(.-)%s*$"))
					local applied = block.enabled ~= false and mods ~= nil and not extra
					out[#out + 1] = { mod = line, off = not applied or nil }
				end
			end
		end
	end
	return out
end

-- Every tree, skill set, item set and config set (with its changed options), and which of
-- each the shown loadout uses, for the guide's per-panel set pickers.
local function setLists()
	local function titles(order, sets)
		local out = setmetatable({}, ARRAY)
		for _, id in ipairs(order) do
			out[#out + 1] = sets[id].title or "Default"
		end
		return out
	end
	local function position(order, activeId)
		for index, id in ipairs(order) do
			if id == activeId then
				return index
			end
		end
		return 1
	end
	local trees = setmetatable({}, ARRAY)
	for index, spec in ipairs(build.treeTab.specList) do
		trees[index] = spec.title or "Default"
	end
	local configs = setmetatable({}, ARRAY)
	for _, id in ipairs(build.configTab.configSetOrderList) do
		local configSet = build.configTab.configSets[id]
		configs[#configs + 1] = { title = configSet.title or "Default", rows = configRows(configSet) }
	end
	local skills = build.skillsTab
	local items = build.itemsTab
	local config = build.configTab
	return {
		trees = trees,
		skills = titles(skills.skillSetOrderList, skills.skillSets),
		items = titles(items.itemSetOrderList, items.itemSets),
		configs = configs,
		active = {
			tree = build.treeTab.activeSpec,
			skills = position(skills.skillSetOrderList, skills.activeSkillSetId),
			items = position(items.itemSetOrderList, items.activeItemSetId),
			config = position(config.configSetOrderList, config.activeConfigSetId),
		},
	}
end

-- The build's title and headline numbers, for the guide's header card.
local function headline()
	local output = build.calcsTab.mainOutput or {}
	local minion = build.calcsTab.mainEnv and build.calcsTab.mainEnv.minion
	local minionOutput = minion and minion.output or {}
	-- Only real numbers: PoB uses math.huge for "can't be killed" (eHP), and JSON has no infinity.
	local function finite(value)
		return type(value) == "number" and value == value and value ~= math.huge
			and value ~= -math.huge and value or nil
	end
	local function positive(value)
		value = finite(value)
		return value and value > 0 and value or nil
	end
	local _, active = mainActive()
	local spec = build.spec
	return {
		skill = active and active.activeEffect and active.activeEffect.grantedEffect.name,
		class = spec and spec.curClassName,
		ascendancy = spec and spec.curAscendClassId ~= 0 and spec.curAscendClassName or nil,
		level = build.characterLevel,
		life = finite(output.Life),
		es = finite(output.EnergyShield),
		mana = finite(output.Mana),
		ehp = finite(output.TotalEHP),
		-- The player's damage, else the minion's (for minion builds).
		dps = positive(output.FullDPS) or positive(output.CombinedDPS)
			or positive(minionOutput.FullDPS) or positive(minionOutput.CombinedDPS) or 0,
		fire = finite(output.FireResist),
		cold = finite(output.ColdResist),
		lightning = finite(output.LightningResist),
		chaos = finite(output.ChaosResist),
	}
end

-- Gear ---------------------------------------------------------------------------------

-- One item as the guide shows it: name, base, rarity and the mod lines PoB applies.
local function itemData(item)
	local function lines(modLines)
		local out = setmetatable({}, ARRAY)
		for _, modLine in ipairs(modLines or {}) do
			-- PoB's own formatting: ranges rolled ("+(60-80)" → "+72"), catalysts applied, and
			-- 0-value lines left out (nil). Its colour codes are dropped; the guide colours lines.
			local text = not modLine.disabled and modLine.line and modLine.line ~= ""
				and item:CheckModLineVariant(modLine) and itemLib.formatModLine(modLine)
			if text then
				text = text:gsub("%^x%x%x%x%x%x%x", ""):gsub("%^%d", "")
				out[#out + 1] = {
					text = text,
					crafted = modLine.crafted or nil,
					fractured = modLine.fractured or nil,
				}
			end
		end
		return out
	end
	-- "R-G-B B": a dash links two sockets, a space separates groups.
	local sockets = {}
	local lastGroup
	for _, socket in ipairs(item.sockets or {}) do
		if lastGroup ~= nil then
			sockets[#sockets + 1] = socket.group == lastGroup and "-" or " "
		end
		sockets[#sockets + 1] = socket.color
		lastGroup = socket.group
	end
	return {
		name = item.title or item.name,
		base = item.baseName,
		rarity = item.rarity,
		type = item.type,
		quality = item.quality,
		level = item.itemLevel,
		sockets = #sockets > 0 and table.concat(sockets) or nil,
		corrupted = item.corrupted or nil,
		-- What PoB's item tooltip shows under "Requires" (attributes after mods).
		requires = {
			level = (item.requirements.level or 0) > 0 and item.requirements.level or nil,
			str = (item.requirements.strMod or 0) > 0 and item.requirements.strMod or nil,
			dex = (item.requirements.dexMod or 0) > 0 and item.requirements.dexMod or nil,
			int = (item.requirements.intMod or 0) > 0 and item.requirements.intMod or nil,
		},
		-- The item as PoB writes it as text, for the guide's Copy button.
		raw = item:BuildRaw(),
		enchant = lines(item.enchantModLines),
		implicit = lines(item.implicitModLines),
		explicit = lines(item.explicitModLines),
	}
end

local gearCache

-- Every item set's slots (in PoB's slot order), the items they hold, and each tree's
-- socketed jewels. Items don't change with the loadout, so it's built once per build.
local function gear()
	if gearCache then
		return gearCache
	end
	local tab = build.itemsTab
	local items = {}
	local function use(itemId)
		local item = itemId and itemId ~= 0 and tab.items[itemId]
		if not item then
			return nil
		end
		items[tostring(itemId)] = items[tostring(itemId)] or itemData(item)
		return itemId
	end
	local sets = setmetatable({}, ARRAY)
	for _, setId in ipairs(tab.itemSetOrderList) do
		local itemSet = tab.itemSets[setId]
		local slots = setmetatable({}, ARRAY)
		for _, slot in ipairs(tab.orderedSlots) do
			if not slot.nodeId then
				local entry = itemSet[slot.slotName]
				local itemId = entry and use(entry.selItemId)
				if itemId then
					slots[#slots + 1] = { slot = slot.slotName, item = itemId }
				end
			end
		end
		sets[#sets + 1] = { title = itemSet.title or "Default", slots = slots }
	end
	local treeJewels = setmetatable({}, ARRAY)
	for index, spec in ipairs(build.treeTab.specList) do
		local jewels = setmetatable({}, ARRAY)
		for nodeId, itemId in pairs(spec.jewels or {}) do
			-- PoB keeps jewels in sockets the tree hasn't taken; only taken ones count.
			if spec.allocNodes and spec.allocNodes[nodeId] and use(itemId) then
				jewels[#jewels + 1] = { node = nodeId, item = itemId }
			end
		end
		treeJewels[index] = jewels
	end
	gearCache = { sets = sets, items = items, treeJewels = treeJewels }
	return gearCache
end

-- Compare --------------------------------------------------------------------------------

-- The shown skill set's socket groups and their gems, for the guide's Compare.
local function skillGroups()
	local out = setmetatable({}, ARRAY)
	for _, group in ipairs(build.skillsTab.socketGroupList) do
		local gems = setmetatable({}, ARRAY)
		for _, gem in ipairs(group.gemList or {}) do
			local effect = gem.gemData and gem.gemData.grantedEffect or gem.grantedEffect
			local name = gem.gemData and gem.gemData.name
				or (gem.nameSpec ~= nil and gem.nameSpec ~= "" and gem.nameSpec)
				or (effect and effect.name)
			if name then
				gems[#gems + 1] = {
					name = name,
					support = effect and effect.support or nil,
					enabled = gem.enabled ~= false,
					level = gem.level,
					quality = gem.quality,
				}
			end
		end
		if #gems > 0 then
			out[#out + 1] = {
				label = group.displayLabel or group.label,
				slot = group.slot,
				enabled = group.enabled ~= false,
				-- Granted by an item or a passive, not socketed.
				granted = group.source ~= nil or nil,
				gems = gems,
			}
		end
	end
	return out
end

-- The shown tree's allocated passives (masteries with the effect picked), for Compare.
local function passives()
	local out = setmetatable({}, ARRAY)
	local spec = build.spec
	for _, node in pairs(spec and spec.allocNodes or {}) do
		if node.type ~= "ClassStart" and node.type ~= "AscendClassStart" and node.dn then
			out[#out + 1] = {
				name = node.dn,
				type = node.type,
				ascendancy = node.ascendancyName,
				effect = node.type == "Mastery" and table.concat(node.sd or {}, " / ") or nil,
			}
		end
	end
	table.sort(out, function(a, b)
		if a.name ~= b.name then
			return a.name < b.name
		end
		return (a.effect or "") < (b.effect or "")
	end)
	return out
end

-- Build health --------------------------------------------------------------------------
-- The checks are ported from PoB Redux's sanity_check (crates/pob-engine/lua/bridge.lua,
-- https://github.com/pobredux/pob-redux), under its MIT License:
--
--   Copyright (c) 2026 Judd
--   Permission is hereby granted, free of charge, to any person obtaining a copy of this
--   software and associated documentation files (the "Software"), to deal in the Software
--   without restriction, including without limitation the rights to use, copy, modify,
--   merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
--   permit persons to whom the Software is furnished to do so, subject to the following
--   conditions: The above copyright notice and this permission notice shall be included in
--   all copies or substantial portions of the Software.
--   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED.
--
-- Changed for a leveling guide: every check is scaled to the loadout's level (an Act 2
-- loadout isn't expected to cap resistances), the texts are short, and checks PoB already
-- warns about (skill costs, reservation) are left to PoB's warnings. log-api/redux-watch.ps1
-- notices when Redux changes sanity_check.

-- Quest passive points by the level an act starts at (PoB's Modules/Build.lua acts table).
local QUEST_POINTS = {
	{ 1, 0 }, { 12, 2 }, { 22, 4 }, { 32, 6 }, { 40, 7 }, { 44, 9 },
	{ 50, 12 }, { 54, 15 }, { 60, 18 }, { 64, 20 }, { 67, 23 },
}

-- The level a loadout's tree is for, worked out from its passive points the way PoB's
-- EstimatePlayerProgress does. PoB keeps one level for the whole build (often a guide's
-- endgame level), so an Act 2 loadout is judged by its own tree, not by that.
local function levelForPoints(used, extra)
	local act, level = 0, 1
	repeat
		act = act + 1
		local bandit = act > 2 and extra or 0
		level = math.min(math.max(used + 1 - QUEST_POINTS[act][2] - bandit, QUEST_POINTS[act][1]), 100)
	until act == #QUEST_POINTS or level <= QUEST_POINTS[act + 1][1]
	return level
end

-- Ascendancy points by level, by PoB's lab suggestions: Normal from 33, Cruel 55,
-- Merciless 68, Eternal 75.
local function ascendancyExpected(level)
	return level >= 75 and 8 or level >= 68 and 6 or level >= 55 and 4 or level >= 33 and 2 or 0
end

local function nextLab(points)
	return ({ [0] = "Normal Lab", [2] = "Cruel Lab", [4] = "Merciless Lab", [6] = "Eternal Lab" })[points]
end

-- What to look at in the shown loadout, worst first: { severity, message, fix, panel }.
-- severity: high, medium, low. panel: the guide panel that fixes it (gear, tree, gems, config).
local function healthFindings()
	local o = build.calcsTab.mainOutput or {}
	local spec = build.spec
	local out = setmetatable({}, ARRAY)
	local function number(value)
		return type(value) == "number" and value == value and value or 0
	end
	local used, ascUsed = 0, 0
	if spec and spec.CountAllocNodes then
		used, ascUsed = spec:CountAllocNodes()
		used, ascUsed = used or 0, ascUsed or 0
	end
	local level = levelForPoints(used, number(o.ExtraPoints))
	local function add(severity, message, fix, panel)
		out[#out + 1] = { severity = severity, message = message, fix = fix, panel = panel }
	end

	-- Resistances: none expected before Act 5; half-capped through Acts 5-10; capped in maps.
	local cap = level >= 68 and 75 or level >= 40 and 50 or nil
	if cap then
		local low, worst = {}, 75
		for _, r in ipairs({ { "fire", o.FireResist }, { "cold", o.ColdResist }, { "lightning", o.LightningResist } }) do
			local value = number(r[2])
			if value < cap then
				low[#low + 1] = string.format("%s %.0f%%", r[1], value)
				worst = math.min(worst, value)
			end
		end
		if #low > 0 then
			add((cap == 75 and worst < 50) and "high" or "medium",
				string.format("Resistances below %d%%: %s", cap, table.concat(low, ", ")),
				"Resistances on rings, amulet, belt, boots, gloves, helmet.", "gear")
		end
	end
	local chaosImmune = false
	for _, node in pairs(spec and spec.allocNodes or {}) do
		if node.dn == "Chaos Inoculation" then
			chaosImmune = true
		end
	end
	if level >= 68 and number(o.ChaosResist) < 0 and not chaosImmune then
		add("low", string.format("Chaos resistance %.0f%%", number(o.ChaosResist)),
			"Add chaos resistance on gear.", "gear")
	end

	-- Ascendancy points for the labs done by this level. (Redux's spent-points check is left
	-- out: the level comes from the points.)
	if spec then
		local expected = ascendancyExpected(level)
		if spec.curAscendClassId == 0 and level >= 33 then
			add("medium", "No ascendancy chosen", "Pick one at the Normal Lab.", "tree")
		elseif spec.curAscendClassId ~= 0 and ascUsed < expected then
			local lab = nextLab(ascUsed - ascUsed % 2)
			add("medium", string.format("%d of %d ascendancy points", ascUsed, expected),
				lab and ("Next: " .. lab) or nil, "tree")
		end
	end

	-- Flasks: worth carrying from the first towns.
	if level >= 12 then
		local empty = 0
		for i = 1, 5 do
			local slot = build.itemsTab.slots["Flask " .. i]
			if slot and (not slot.selItemId or slot.selItemId == 0) then
				empty = empty + 1
			end
		end
		if empty > 0 then
			add(empty >= 3 and "medium" or "low", string.format("%d of 5 flask slots empty", empty),
				"Add life, quicksilver and utility flasks.", "gear")
		end
	end

	-- Main skill links, from maps on.
	local group = build.skillsTab.socketGroupList[build.mainSocketGroup]
	if level >= 68 and group and not group.source then
		local actives, supports = 0, 0
		for _, gem in ipairs(group.gemList or {}) do
			local effect = gem.gemData and gem.gemData.grantedEffect or gem.grantedEffect
			if gem.enabled ~= false and effect then
				if effect.support then supports = supports + 1 else actives = actives + 1 end
			end
		end
		local want = level >= 85 and 5 or 4
		-- A link can't outgrow its item: boots, gloves and helmets hold 4 sockets.
		local slot = group.slot and build.itemsTab.slots[group.slot]
		local item = slot and slot.selItemId and build.itemsTab.items[slot.selItemId]
		local limit = item and item.base and item.base.socketLimit
		if limit then
			want = math.min(want, limit - 1)
		end
		if actives == 1 and supports < want then
			add(supports < 3 and "high" or "medium", string.format("Main skill has %d supports", supports),
				string.format("Target: %d supports", want), "gems")
		end
	end

	-- Mind over Matter builds take hits on mana (Redux skips mana-first builds too).
	local manaFirst = false
	for _, node in pairs(spec and spec.allocNodes or {}) do
		if node.dn == "Mind Over Matter" then
			manaFirst = true
		end
	end
	if level >= 30 and number(o.Life) < 500 and number(o.EnergyShield) < 500
		and not (manaFirst and number(o.Mana) >= 500) then
		add("high", string.format("Life %.0f, energy shield %.0f", number(o.Life), number(o.EnergyShield)),
			"Add life on gear and tree.", "gear")
	end
	local speed = o.EffectiveMovementSpeedMod or o.MovementSpeedMod
	if level >= 15 and type(speed) == "number" and speed < 1.15 then
		add("medium", string.format("Movement speed %+.0f%%", (speed - 1) * 100),
			"Get boots with movement speed.", "gear")
	end
	local input = build.configTab and build.configTab.input or {}
	local major, minor = input.pantheonMajorGod, input.pantheonMinorGod
	if level >= 60 and (major == nil or major == "None") and (minor == nil or minor == "None") then
		add("low", "No pantheon gods", nil, "config")
	end

	local rank = { high = 1, medium = 2, low = 3 }
	table.sort(out, function(a, b)
		return rank[a.severity] < rank[b.severity]
	end)
	return out
end

-- Redux's Defences card: the largest hit of each type you survive, and the rest.
local function defences()
	local o = build.calcsTab.mainOutput or {}
	local function finite(value)
		return type(value) == "number" and value == value and value ~= math.huge
			and value ~= -math.huge and value or nil
	end
	return {
		physical = finite(o.PhysicalMaximumHitTaken),
		fire = finite(o.FireMaximumHitTaken),
		cold = finite(o.ColdMaximumHitTaken),
		lightning = finite(o.LightningMaximumHitTaken),
		chaos = finite(o.ChaosMaximumHitTaken),
		armour = finite(o.Armour),
		evasion = finite(o.Evasion),
		block = finite(o.EffectiveBlockChance or o.BlockChance),
		spellBlock = finite(o.EffectiveSpellBlockChance or o.SpellBlockChance),
		lifeRegen = finite(o.LifeRegenRecovery or o.LifeRegen),
		manaRegen = finite(o.ManaRegenRecovery or o.ManaRegen),
		movementSpeed = finite(o.EffectiveMovementSpeedMod or o.MovementSpeedMod),
	}
end

-- Gem top levels other than 20 (Empower 3, Awakened 5, Portal 1...), by gem item id, for
-- the Trade List's Max gem level. The same for every build, so built once.
local gemMaxLevelCache
local function gemMaxLevels()
	if not gemMaxLevelCache then
		gemMaxLevelCache = {}
		for _, gem in pairs(data.gems) do
			if gem.gameId and gem.naturalMaxLevel and gem.naturalMaxLevel ~= 20 then
				gemMaxLevelCache[gem.gameId] = gem.naturalMaxLevel
			end
		end
	end
	return gemMaxLevelCache
end

-- Runs an extra (Build health, Defenses); an error there is logged and gives `fallback`.
local function safely(fn, fallback)
	local ok, result = pcall(fn)
	if ok then
		return result
	end
	host_log("Build health failed: " .. tostring(result))
	return fallback
end

-- Called by the exe: stats for `loadout` as JSON. nil: the loadout the build was saved on
-- when the build is new to PoB, else the loadout picked last. `id` and the rest are the
-- guide's remembered main skill (all nil: PoB's own).
function host_stats(xml, loadout, id, label, group, skill, part, minion, minionSkill)
	if xml ~= loadedXml then
		loadedXml = nil
		undo = {}
		gearCache = nil
		local bundled
		bundled, treeNotes = onBundledTrees(xml)
		takePromptError()
		loadBuildFromXML(bundled, "Guide")
		local msg = takePromptError()
		if msg then
			error("Build didn't load: " .. msg, 0)
		end
		loadedXml = xml
	else
		undoPicks()
	end
	if loadout ~= nil and loadout ~= currentLoadout() then
		selectLoadout(loadout)
	end
	local picked
	if id ~= nil then
		picked = applyPick({
			id = id, label = label, group = group, skill = skill, part = part, minion = minion, minionSkill = minionSkill,
		})
	end
	if build.buildFlag then
		recalc()
	end
	return json.encode({
		loadouts = loadouts(),
		loadout = currentLoadout(),
		skill = skillState(picked),
		sets = setTitles(),
		lists = setLists(),
		headline = headline(),
		gear = gear(),
		config = configRows(build.configTab.configSets[build.configTab.activeConfigSetId]),
		skills = skillGroups(),
		passives = passives(),
		gemMaxLevels = gemMaxLevels(),
		health = safely(healthFindings, setmetatable({}, ARRAY)),
		defences = safely(defences, nil),
		rows = rows(),
		warnings = warnings(),
	})
end
