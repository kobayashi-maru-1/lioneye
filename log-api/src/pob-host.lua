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

-- Called by the exe: stats for `loadout` as JSON. nil: the loadout the build was saved on
-- when the build is new to PoB, else the loadout picked last.
function host_stats(xml, loadout)
	if xml ~= loadedXml then
		loadedXml = nil
		local bundled
		bundled, treeNotes = onBundledTrees(xml)
		takePromptError()
		loadBuildFromXML(bundled, "Guide")
		local msg = takePromptError()
		if msg then
			error("Build didn't load: " .. msg, 0)
		end
		loadedXml = xml
	end
	if loadout ~= nil and loadout ~= currentLoadout() then
		selectLoadout(loadout)
	end
	return json.encode({
		loadouts = loadouts(),
		loadout = currentLoadout(),
		rows = rows(),
		warnings = warnings(),
	})
end
