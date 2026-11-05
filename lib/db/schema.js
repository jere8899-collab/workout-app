// SQLite schema, applied as ordered migrations. Never edit a shipped migration;
// append a new one instead so existing databases upgrade in place.
//
// Conventions
// - Stable TEXT ids (deterministic for imported rows, random UUIDs for live rows).
// - *_utc columns are ISO-8601 UTC instants; date_local is the Asia/Singapore
//   calendar date the session belongs to (a session may end after midnight).
// - NULL means "not reported". We never write a guessed value into a NULL column;
//   derived values live in clearly named columns or are computed on read.

export const MIGRATIONS = [
  {
    version: 1,
    name: 'initial',
    sql: `
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT,
  height_cm REAL,
  height_is_approx INTEGER NOT NULL DEFAULT 0,
  training_goal TEXT,
  frequency_goal TEXT,
  timezone TEXT NOT NULL DEFAULT 'Asia/Singapore',
  notes_json TEXT,
  created_at_utc TEXT NOT NULL
);

CREATE TABLE body_metrics (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  date_local TEXT,
  weight_kg REAL,
  weight_is_approx INTEGER NOT NULL DEFAULT 0,
  body_fat_pct REAL,
  context TEXT,
  source_id TEXT REFERENCES import_sources(id)
);

-- Every imported file is kept verbatim so exports stay lossless and
-- any value can be traced back to the document it came from.
CREATE TABLE import_sources (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,              -- canonical_json | flat_csv | august_markdown | app_backup
  filename TEXT,
  content_hash TEXT NOT NULL,     -- fnv1a64 of raw_text, used to detect re-imports
  schema_version TEXT,
  imported_at_utc TEXT NOT NULL,
  raw_text TEXT NOT NULL,
  meta_json TEXT                   -- completeness, limitations, training_logic, etc.
);

CREATE TABLE import_issues (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES import_sources(id),
  severity TEXT NOT NULL,          -- info | warning | error
  code TEXT NOT NULL,
  entity TEXT,
  entity_id TEXT,
  message TEXT NOT NULL
);

CREATE TABLE equipment (
  id TEXT PRIMARY KEY,
  brand TEXT NOT NULL,             -- 'unspecified' when not reported
  description TEXT,                -- raw machine text, e.g. 'Life Fitness plate-loaded row'
  load_type TEXT NOT NULL DEFAULT 'unknown', -- selectorized | plate_loaded | cable | dumbbell | barbell | unknown
  increment_kg REAL,               -- user-set; NULL = infer from history
  notes TEXT
);

CREATE TABLE exercises (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL DEFAULT 'isolation', -- compound | isolation | core | cardio
  muscle_group TEXT,
  notes TEXT
);

-- The unit of comparison: exact exercise + exact machine + exact variation.
-- Baselines, PRs, charts and recommendations never cross variants.
CREATE TABLE exercise_variants (
  id TEXT PRIMARY KEY,
  exercise_id TEXT NOT NULL REFERENCES exercises(id),
  equipment_id TEXT NOT NULL REFERENCES equipment(id),
  variation TEXT NOT NULL DEFAULT '',
  laterality TEXT NOT NULL DEFAULT 'bilateral',   -- bilateral | unilateral
  load_basis TEXT NOT NULL DEFAULT 'total',       -- total | per_side | per_limb | unknown
  rep_min INTEGER,
  rep_max INTEGER,
  rest_sec INTEGER,
  archived INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  UNIQUE (exercise_id, equipment_id, variation)
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  date_local TEXT,                 -- NULL allowed: date unknown
  label TEXT,
  focus TEXT,
  status TEXT NOT NULL DEFAULT 'completed', -- active | completed
  fidelity TEXT NOT NULL,          -- set_by_set | partial_reconstruction | live
  started_at_utc TEXT,
  ended_at_utc TEXT,
  time_precision TEXT NOT NULL DEFAULT 'unknown', -- exact | approximate | unknown
  reported_duration_min REAL,
  reported_kcal_min REAL,
  reported_kcal_max REAL,
  body_weight_kg REAL,
  plan_day_id TEXT REFERENCES plan_days(id),
  source_id TEXT REFERENCES import_sources(id),
  source_ref TEXT,                 -- JSON pointer into the source document
  notes_json TEXT,                 -- original note strings, verbatim
  created_at_utc TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL
);
CREATE INDEX idx_sessions_date ON sessions(date_local);

CREATE TABLE session_exercises (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  variant_id TEXT NOT NULL REFERENCES exercise_variants(id),
  position INTEGER NOT NULL,
  superset_group TEXT,             -- same letter = performed as a superset
  plan_item_id TEXT,
  target_rest_sec INTEGER,
  raw_exercise_name TEXT,
  raw_equipment TEXT,
  raw_variation TEXT,
  notes TEXT
);
CREATE INDEX idx_se_session ON session_exercises(session_id);
CREATE INDEX idx_se_variant ON session_exercises(variant_id);

CREATE TABLE sets (
  id TEXT PRIMARY KEY,
  session_exercise_id TEXT NOT NULL REFERENCES session_exercises(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,        -- order within the exercise
  session_order INTEGER,            -- order within the whole session, when known
  set_type TEXT NOT NULL,           -- warmup | working | calibration | ambiguous | unclassified
  set_type_raw TEXT,
  set_subtype TEXT,                 -- top | backoff | failure | drop | NULL
  load_kg REAL,
  load_display TEXT,
  load_multiplier REAL,             -- 1 = stack total, 2 = per side / per arm on both sides
  reps INTEGER,                     -- shared rep count; per-side counts live in set_sides
  partials INTEGER,
  rir_raw TEXT,
  rir_min REAL,
  rir_max REAL,
  rir_approx INTEGER NOT NULL DEFAULT 0,
  rir_source TEXT,                  -- which document the RIR came from
  technique TEXT,                   -- good | degraded | NULL
  rest_sec INTEGER,
  superset_pair_set_id TEXT,        -- explicit pairing only, never inferred
  fidelity TEXT NOT NULL,           -- reported | reconstructed | live
  completed_at_utc TEXT,
  notes TEXT,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at_utc TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL
);
CREATE INDEX idx_sets_se ON sets(session_exercise_id);

-- Left/right performance. Present only when sides were reported or logged
-- separately; never back-filled from the other side.
CREATE TABLE set_sides (
  id TEXT PRIMARY KEY,
  set_id TEXT NOT NULL REFERENCES sets(id) ON DELETE CASCADE,
  side TEXT NOT NULL CHECK (side IN ('L','R')),
  reps INTEGER,
  partials INTEGER,
  rir_raw TEXT,
  rir_min REAL,
  rir_max REAL,
  rir_approx INTEGER NOT NULL DEFAULT 0,
  UNIQUE (set_id, side)
);

CREATE TABLE cardio (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  type TEXT NOT NULL,
  equipment_brand TEXT,
  duration_sec REAL,
  distance_km REAL,
  avg_speed_kmh REAL,
  incline_pct REAL,
  elevation_gain_m REAL,
  avg_hr REAL,
  max_hr REAL,
  machine_kcal REAL,
  machine_kcal_is_approx INTEGER NOT NULL DEFAULT 0,
  handrail_support TEXT,            -- none | light | firm | NULL (unknown)
  reported_kcal_min REAL,
  reported_kcal_max REAL,
  fidelity TEXT NOT NULL,           -- reported | parsed_from_note | live
  raw_text TEXT,
  notes TEXT
);

-- Free-text exercise summaries from partially reconstructed dates.
CREATE TABLE partial_summaries (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  text TEXT NOT NULL,
  parse_status TEXT NOT NULL        -- parsed | unparsed
);

CREATE TABLE plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  notes TEXT,
  is_active INTEGER NOT NULL DEFAULT 0,
  created_at_utc TEXT NOT NULL
);

CREATE TABLE plan_days (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,        -- rotation order
  name TEXT NOT NULL,
  focus TEXT
);

CREATE TABLE plan_items (
  id TEXT PRIMARY KEY,
  plan_day_id TEXT NOT NULL REFERENCES plan_days(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  variant_id TEXT NOT NULL REFERENCES exercise_variants(id),
  target_sets INTEGER NOT NULL DEFAULT 2,
  rep_min INTEGER,
  rep_max INTEGER,
  rir_min REAL,
  rir_max REAL,
  rest_sec INTEGER,
  superset_group TEXT,
  substitute_variant_ids_json TEXT NOT NULL DEFAULT '[]',
  notes TEXT
);

-- Planned targets for a live session, kept apart from what was actually done.
CREATE TABLE planned_sets (
  id TEXT PRIMARY KEY,
  session_exercise_id TEXT NOT NULL REFERENCES session_exercises(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  target_load_kg REAL,
  rep_min INTEGER,
  rep_max INTEGER,
  rir_min REAL,
  rir_max REAL
);

-- Suggestions shown to the user. A recommendation is never a completed set.
CREATE TABLE recommendations (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  variant_id TEXT NOT NULL REFERENCES exercise_variants(id),
  created_at_utc TEXT NOT NULL,
  action TEXT NOT NULL,             -- increase | hold | add_reps | reduce | calibrate
  load_kg REAL,
  rep_min INTEGER,
  rep_max INTEGER,
  rir_min REAL,
  rir_max REAL,
  confidence TEXT NOT NULL,
  rationale TEXT NOT NULL,
  basis_set_ids_json TEXT NOT NULL DEFAULT '[]',
  outcome TEXT,                     -- followed | overridden | NULL
  logged_set_id TEXT
);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  at_utc TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,             -- create | update | delete | import
  before_json TEXT,
  after_json TEXT,
  reason TEXT
);
CREATE INDEX idx_audit_entity ON audit_log(entity, entity_id);

-- Machine benchmarks as written in source documents (e.g. the August log table).
CREATE TABLE benchmarks (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES import_sources(id),
  position INTEGER NOT NULL,
  label TEXT NOT NULL,
  benchmark TEXT NOT NULL,
  date_text TEXT,
  context TEXT
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);
`,
  },
  {
    version: 2,
    name: 'set_drafts',
    sql: `
-- Unconfirmed rows in a live workout. Never counted; deleted when the workout finishes.
CREATE TABLE set_drafts (
  id TEXT PRIMARY KEY,
  session_exercise_id TEXT NOT NULL REFERENCES session_exercises(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  set_type TEXT NOT NULL DEFAULT 'working',   -- warmup | working | calibration
  set_subtype TEXT,                           -- failure | drop | NULL
  load_kg REAL,
  reps INTEGER,
  rir TEXT,
  per_side INTEGER NOT NULL DEFAULT 0,
  left_reps INTEGER,
  left_rir TEXT,
  right_reps INTEGER,
  right_rir TEXT,
  touched_json TEXT NOT NULL DEFAULT '[]',    -- fields the lifter changed
  restored_from_set_id TEXT
);
CREATE INDEX idx_drafts_se ON set_drafts(session_exercise_id);

ALTER TABLE session_exercises ADD COLUMN rows_seeded INTEGER NOT NULL DEFAULT 0;
`,
  },
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

// Tables in dependency order — used by export/import so a backup restores cleanly.
export const TABLES = [
  'users', 'import_sources', 'import_issues', 'body_metrics', 'equipment', 'exercises',
  'exercise_variants', 'plans', 'plan_days', 'plan_items', 'sessions', 'session_exercises',
  'sets', 'set_sides', 'planned_sets', 'set_drafts', 'cardio', 'partial_summaries', 'recommendations',
  'benchmarks', 'audit_log', 'settings',
];
