-- Lioneye build-lab game database. One file per Path of Building release, built by build-game-db.py.
-- Numbers come from PoB's own data, so the database and the evaluator never disagree. JSON columns hold
-- PoB structures as-is; query them with SQLite's json functions.

PRAGMA journal_mode = OFF;
PRAGMA synchronous = OFF;

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);

-- Every stat line from every source in one table: unique mods, affixes, base implicits, passives, masteries.
-- supported = PoB's mod parser understood the whole line (0 = PoB ignores part or all of it).
-- parsed = PoB's parse: [{n: mod name, t: type, v: value, f: ModFlags, k: KeywordFlags, tags: [...]}].
CREATE TABLE mod_lines (
  id          INTEGER PRIMARY KEY,
  source_type TEXT NOT NULL,   -- unique | affix | base | node | mastery
  source_id   TEXT NOT NULL,   -- uniques.id | affixes.domain:affixes.id | base_items.name | nodes.id | mastery_effects.id
  seq         INTEGER NOT NULL,
  kind        TEXT,            -- unique lines: implicit | explicit
  text        TEXT NOT NULL,
  variants    TEXT,            -- unique lines: JSON list of the current variants the line belongs to
  supported   INTEGER NOT NULL,
  extra       TEXT,            -- the part PoB couldn't parse
  parsed      TEXT NOT NULL
);
CREATE INDEX mod_lines_source ON mod_lines (source_type, source_id);
CREATE VIRTUAL TABLE mod_lines_fts USING fts5 (text, content = 'mod_lines', content_rowid = 'id');

-- The interaction index: mechanics each line touches (rules in mechanic-rules.json).
CREATE TABLE mechanic_tags (line_id INTEGER NOT NULL, tag TEXT NOT NULL, PRIMARY KEY (line_id, tag)) WITHOUT ROWID;
CREATE INDEX mechanic_tags_tag ON mechanic_tags (tag);

-- Skills
CREATE TABLE gems (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, base_type_name TEXT, variant_id TEXT,
  granted_effect_id TEXT, secondary_effect_id TEXT,
  is_support INTEGER, is_vaal INTEGER, is_transfigured INTEGER,
  pob_unsupported INTEGER,     -- PoB has the gem but doesn't calculate it
  tag_string TEXT, req_str INTEGER, req_dex INTEGER, req_int INTEGER, max_level INTEGER,
  cast_time REAL, description TEXT,
  skill_types TEXT, minion_skill_types TEXT,                -- JSON lists of SkillType names
  require_types TEXT, add_types TEXT, exclude_types TEXT,   -- JSON postfix expressions (AND / OR / NOT)
  weapon_types TEXT, stats TEXT, constant_stats TEXT, quality_stats TEXT
);
CREATE INDEX gems_name ON gems (name);
CREATE TABLE gem_tags (gem_id TEXT NOT NULL, tag TEXT NOT NULL, PRIMARY KEY (gem_id, tag)) WITHOUT ROWID;
CREATE INDEX gem_tags_tag ON gem_tags (tag);
CREATE TABLE gem_skill_types (gem_id TEXT NOT NULL, skill_type TEXT NOT NULL, minion INTEGER NOT NULL,
  PRIMARY KEY (gem_id, skill_type, minion)) WITHOUT ROWID;
-- stat_values line up with gems.stats; interpolation says how each becomes a stat (PoB's statInterpolation:
-- 1 = the value as-is, 2/3 = interpolated). reservation: {manaPercent, manaFlat, lifePercent, lifeFlat}.
CREATE TABLE gem_levels (
  gem_id TEXT NOT NULL, level INTEGER NOT NULL, req_level INTEGER, stat_values TEXT, interpolation TEXT,
  cost TEXT, mana_multiplier REAL, effectiveness REAL, crit REAL, cooldown REAL, stored_uses INTEGER,
  reservation TEXT,
  PRIMARY KEY (gem_id, level)
) WITHOUT ROWID;
-- Supports PoB lets support each active skill, from the skills' own types (before types a support or item
-- adds, e.g. Spell Totem adding Totem). effect_id tells a Vaal gem's two skills apart.
CREATE TABLE support_compat (support_id TEXT NOT NULL, active_id TEXT NOT NULL, effect_id TEXT NOT NULL,
  PRIMARY KEY (support_id, active_id, effect_id)) WITHOUT ROWID;
CREATE INDEX support_compat_active ON support_compat (active_id);

-- Items
CREATE TABLE base_items (
  name TEXT PRIMARY KEY, type TEXT, sub_type TEXT, hidden INTEGER, socket_limit INTEGER,
  tags TEXT, influence_tags TEXT, req TEXT, armour TEXT, weapon TEXT, flask TEXT
);
CREATE TABLE base_tags (base_name TEXT NOT NULL, tag TEXT NOT NULL, PRIMARY KEY (base_name, tag)) WITHOUT ROWID;
CREATE INDEX base_tags_tag ON base_tags (tag);

-- Item affixes by domain: Explicit (what rares roll), Delve, Eldritch, Synthesis, Scourge, Corrupted, Flask,
-- Tincture, Jewel*, Graft, Foulborn, Mercenary, WatchersEye (that unique's mod pool), Bench (crafting bench)
-- and Veiled. Filter by domain for what a given item can actually get.
CREATE TABLE affixes (
  domain TEXT NOT NULL, id TEXT NOT NULL, type TEXT, affix TEXT, mod_group TEXT, level INTEGER,
  mod_tags TEXT, types TEXT,  -- types: bench crafts list the item types they apply to
  PRIMARY KEY (domain, id)
) WITHOUT ROWID;
CREATE INDEX affixes_group ON affixes (mod_group);
-- Spawn weights by base tag, in PoB's order: the first tag a base has decides (0 = can't roll).
CREATE TABLE affix_spawn (domain TEXT NOT NULL, affix_id TEXT NOT NULL, seq INTEGER NOT NULL, tag TEXT NOT NULL,
  weight INTEGER NOT NULL, PRIMARY KEY (domain, affix_id, seq)) WITHOUT ROWID;
CREATE INDEX affix_spawn_tag ON affix_spawn (tag);

CREATE TABLE uniques (
  id TEXT PRIMARY KEY,          -- "name|base": a few uniques share a name across bases
  name TEXT NOT NULL, base TEXT, type TEXT, file TEXT, league TEXT, source TEXT, req_level INTEGER,
  variants TEXT,                -- JSON list of current variants (legacy variants, "Pre x.y" in the name, dropped)
  -- From poewiki (NULL when the wiki had no match or wasn't fetched):
  drop_enabled INTEGER, drop_restricted INTEGER, drop_text TEXT, release_version TEXT, removal_version TEXT
);
CREATE INDEX uniques_name ON uniques (name);

-- Passive tree (latest tree version PoB supports)
CREATE TABLE nodes (
  id INTEGER PRIMARY KEY, name TEXT, type TEXT,  -- Normal | Notable | Keystone | Mastery | Socket | ClassStart | AscendClassStart
  ascendancy TEXT, class TEXT, x REAL, y REAL, grp INTEGER,
  multiple_choice INTEGER, blighted INTEGER
);
CREATE INDEX nodes_name ON nodes (name);
CREATE TABLE node_edges (a INTEGER NOT NULL, b INTEGER NOT NULL, PRIMARY KEY (a, b)) WITHOUT ROWID;  -- both directions
CREATE TABLE mastery_effects (id INTEGER PRIMARY KEY);
CREATE TABLE node_mastery_effects (node_id INTEGER NOT NULL, effect_id INTEGER NOT NULL,
  PRIMARY KEY (node_id, effect_id)) WITHOUT ROWID;
CREATE TABLE classes (class TEXT NOT NULL, ascendancy TEXT NOT NULL, PRIMARY KEY (class, ascendancy)) WITHOUT ROWID;

-- Convenience views
CREATE VIEW v_unique_lines AS
  SELECT u.name, u.base, u.type, l.kind, l.text, l.supported, l.variants, l.id AS line_id
  FROM uniques u JOIN mod_lines l ON l.source_type = 'unique' AND l.source_id = u.id;

CREATE VIEW v_supports_for AS
  SELECT a.name AS active, s.name AS support, c.effect_id
  FROM support_compat c JOIN gems a ON a.id = c.active_id JOIN gems s ON s.id = c.support_id;

CREATE VIEW v_tagged_lines AS
  SELECT t.tag, l.source_type,
         CASE l.source_type
           WHEN 'unique' THEN (SELECT name FROM uniques WHERE id = l.source_id)
           WHEN 'node' THEN (SELECT name FROM nodes WHERE id = CAST(l.source_id AS INTEGER))
           ELSE l.source_id END AS source_name,
         l.text, l.supported, l.id AS line_id
  FROM mechanic_tags t JOIN mod_lines l ON l.id = t.line_id;
