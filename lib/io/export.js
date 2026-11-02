// Lossless backup (every table, every column, original documents included)
// plus flat CSV exports for spreadsheets.
import { TABLES, SCHEMA_VERSION } from '../db/schema.js';
import { setVolume } from '../domain/sets.js';
import { toCsv } from './parse.js';
import { variantLabel } from '../db/repo.js';

export const BACKUP_FORMAT = 'workout-app-backup';

export function exportBackup(db) {
  const tables = {};
  for (const t of TABLES) tables[t] = db.all(`SELECT * FROM ${t} ORDER BY rowid`);
  return {
    format: BACKUP_FORMAT,
    schema_version: SCHEMA_VERSION,
    exported_at_utc: new Date().toISOString(),
    timezone: 'Asia/Singapore',
    tables,
  };
}

export function validateBackup(obj) {
  const errors = [];
  if (obj?.format !== BACKUP_FORMAT) errors.push('not a workout-app backup file');
  if (typeof obj?.schema_version !== 'number' || obj.schema_version > SCHEMA_VERSION) errors.push(`unsupported schema_version ${obj?.schema_version}`);
  for (const t of Object.keys(obj?.tables ?? {})) if (!TABLES.includes(t)) errors.push(`unknown table ${t}`);
  return errors;
}

// Replaces the whole database with the backup's contents.
export function restoreBackup(db, obj) {
  const errors = validateBackup(obj);
  if (errors.length) throw new Error(errors.join('; '));
  db.tx(() => {
    db.run('PRAGMA defer_foreign_keys = ON');
    for (const t of [...TABLES].reverse()) db.run(`DELETE FROM ${t}`);
    for (const t of TABLES) {
      const cols = new Set(db.all(`PRAGMA table_info(${t})`).map((c) => c.name));
      for (const row of obj.tables[t] ?? []) {
        const clean = Object.fromEntries(Object.entries(row).filter(([k]) => cols.has(k)));
        db.insert(t, clean);
      }
    }
  });
}

export function exportSetsCsv(db) {
  const rows = db.all(`
    SELECT s.date_local, s.label, s.fidelity session_fidelity, s.started_at_utc, s.ended_at_utc,
           e.name exercise, q.brand, q.description equipment_description, v.variation, v.load_basis,
           se.position ex_position, se.superset_group, st.*
    FROM sets st JOIN session_exercises se ON se.id=st.session_exercise_id JOIN sessions s ON s.id=se.session_id
    JOIN exercise_variants v ON v.id=se.variant_id JOIN exercises e ON e.id=v.exercise_id JOIN equipment q ON q.id=v.equipment_id
    ORDER BY s.date_local, se.position, st.position`);
  const sides = db.all('SELECT * FROM set_sides');
  const by = new Map();
  for (const sd of sides) by.set(`${sd.set_id}|${sd.side}`, sd);
  const header = ['date', 'session', 'session_fidelity', 'exercise', 'brand', 'equipment', 'variation', 'load_basis', 'superset_group',
    'set_number', 'set_type', 'set_type_raw', 'load_kg', 'load_display', 'load_multiplier', 'reps', 'partials', 'rir_raw',
    'left_reps', 'left_rir', 'right_reps', 'right_rir', 'technique', 'rest_sec', 'nominal_volume_kg', 'set_fidelity', 'deleted', 'notes', 'set_id'];
  const out = [header];
  for (const r of rows) {
    const L = by.get(`${r.id}|L`);
    const R = by.get(`${r.id}|R`);
    const vol = setVolume({ ...r, sides: [L, R].filter(Boolean) });
    out.push([r.date_local, r.label, r.session_fidelity, r.exercise, r.brand, r.equipment_description, r.variation, r.load_basis, r.superset_group,
      r.position + 1, r.set_type, r.set_type_raw, r.load_kg, r.load_display, r.load_multiplier, r.reps, r.partials, r.rir_raw,
      L?.reps, L?.rir_raw, R?.reps, R?.rir_raw, r.technique, r.rest_sec, r.set_type === 'working' && !r.deleted ? vol : '', r.fidelity, r.deleted, r.notes, r.id]);
  }
  return toCsv(out);
}

export function exportCardioCsv(db) {
  const rows = db.all('SELECT s.date_local, s.label, c.* FROM cardio c JOIN sessions s ON s.id=c.session_id ORDER BY s.date_local, c.position');
  const cols = ['date_local', 'label', 'type', 'equipment_brand', 'duration_sec', 'distance_km', 'avg_speed_kmh', 'incline_pct', 'elevation_gain_m', 'avg_hr', 'max_hr', 'machine_kcal', 'handrail_support', 'reported_kcal_min', 'reported_kcal_max', 'fidelity', 'id'];
  return toCsv([cols, ...rows.map((r) => cols.map((c) => r[c]))]);
}

export { variantLabel };
