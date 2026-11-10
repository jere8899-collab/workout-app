// Repository: every read and write the UI and importers use.
// All edits to existing rows go through audit() so history can be reviewed.
import { stableId, randomId, nowUtc } from '../util.js';
import { categoryOf, EXERCISE_CATALOG } from '../catalog.js';
import { MUSCLES, DEFAULT_MUSCLES } from '../muscles.js';
import { parseRir } from '../domain/rir.js';
import { todaySgt } from '../domain/time.js';
import { livePRs } from '../domain/pr.js';
import { getEntry, defaultsFor, equipmentLoadType } from '../library/index.js';

export const USER_ID = 'user_default';

// ---------------------------------------------------------------- audit
export function audit(db, entity, entityId, action, before, after, reason = null) {
  db.insert('audit_log', {
    id: randomId('aud'),
    at_utc: nowUtc(),
    entity,
    entity_id: entityId,
    action,
    before_json: before ? JSON.stringify(before) : null,
    after_json: after ? JSON.stringify(after) : null,
    reason,
  });
}

// ---------------------------------------------------------------- settings
export function getSetting(db, key, fallback = null) {
  const r = db.get('SELECT value_json FROM settings WHERE key=?', [key]);
  return r ? JSON.parse(r.value_json) : fallback;
}
export function setSetting(db, key, value) {
  db.run('INSERT INTO settings(key,value_json) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json', [key, JSON.stringify(value)]);
}

// ---------------------------------------------------------------- user
export function ensureUser(db, fields = {}) {
  const u = db.get('SELECT * FROM users WHERE id=?', [USER_ID]);
  if (u) return u;
  const row = { id: USER_ID, timezone: 'Asia/Singapore', created_at_utc: nowUtc(), ...fields };
  db.insert('users', row);
  return row;
}

export function latestBodyWeight(db, dateLocal) {
  const dated = db.get(
    `SELECT weight_kg, date_local, source_id FROM body_metrics WHERE weight_kg IS NOT NULL AND date_local IS NOT NULL
     AND (? IS NULL OR date_local <= ?) ORDER BY date_local DESC, rowid DESC LIMIT 1`, [dateLocal, dateLocal]);
  const undated = db.get('SELECT weight_kg FROM body_metrics WHERE weight_kg IS NOT NULL AND date_local IS NULL LIMIT 1');
  // An entry made in the app is newer than anything imported, so it wins.
  if (dated && !dated.source_id) return dated.weight_kg;
  // The imported undated "last reported" figure is newer than every imported
  // dated entry, so it applies after the newest of those.
  const lastImported = db.get('SELECT MAX(date_local) d FROM body_metrics WHERE source_id IS NOT NULL')?.d ?? '';
  if (undated && (!dated || !dateLocal || dateLocal > lastImported)) return undated.weight_kg;
  return dated?.weight_kg ?? undated?.weight_kg ?? null;
}

// ---------------------------------------------------------------- catalog rows
export function findOrCreateEquipment(db, { brand, description = '', load_type = 'unknown', library_id = null }) {
  brand = brand?.trim() || 'unspecified';
  description = description?.trim() || '';
  const id = stableId('eq', brand.toLowerCase(), description.toLowerCase());
  const ex = db.get('SELECT * FROM equipment WHERE id=?', [id]);
  if (ex) {
    const patch = {};
    if (ex.load_type === 'unknown' && load_type !== 'unknown') patch.load_type = load_type;
    if (!ex.library_id && library_id) patch.library_id = library_id;
    if (Object.keys(patch).length) db.update('equipment', id, patch);
    return { ...ex, ...patch };
  }
  const row = { id, brand, description, load_type };
  if (library_id) row.library_id = library_id;
  db.insert('equipment', row);
  return row;
}

export function findOrCreateExercise(db, name) {
  name = name.trim();
  const ex = db.get('SELECT * FROM exercises WHERE lower(name)=lower(?)', [name]);
  if (ex) return ex;
  const row = { id: stableId('ex', name.toLowerCase()), name, category: categoryOf(name), muscle_group: EXERCISE_CATALOG[name]?.[1] ?? null };
  db.insert('exercises', row);
  seedMuscles(db, row);
  return row;
}

// ---------------------------------------------------------------- muscles
function seedMuscles(db, ex) {
  const d = DEFAULT_MUSCLES[ex.name];
  if (d) {
    db.insert('exercise_muscles', { exercise_id: ex.id, muscle: d[0], role: 'primary' });
    for (const m of d[1]) db.insert('exercise_muscles', { exercise_id: ex.id, muscle: m, role: 'secondary' });
  }
  db.run('UPDATE exercises SET muscles_seeded=1 WHERE id=?', [ex.id]);
}

// Applies defaults once per exercise; a lifter's later changes are never overwritten.
export function ensureMuscleDefaults(db) {
  const todo = db.all('SELECT id, name FROM exercises WHERE muscles_seeded=0');
  if (todo.length) db.tx(() => todo.forEach((ex) => seedMuscles(db, ex)));
}

export function getMuscles(db) {
  const out = new Map();
  for (const r of db.all('SELECT * FROM exercise_muscles ORDER BY muscle')) {
    if (!out.has(r.exercise_id)) out.set(r.exercise_id, { primary: null, secondary: [] });
    const m = out.get(r.exercise_id);
    if (r.role === 'primary') m.primary = r.muscle;
    else m.secondary.push(r.muscle);
  }
  return out;
}

export function setExerciseMuscles(db, exerciseId, { primary = null, secondary = [] }, reason) {
  for (const m of [primary, ...secondary].filter(Boolean)) {
    if (!MUSCLES.includes(m)) throw new Error(`Unknown muscle: ${m}`);
  }
  const before = getMuscles(db).get(exerciseId) ?? { primary: null, secondary: [] };
  const sec = [...new Set(secondary)].filter((m) => m !== primary).sort();
  db.tx(() => {
    db.run('DELETE FROM exercise_muscles WHERE exercise_id=?', [exerciseId]);
    if (primary) db.insert('exercise_muscles', { exercise_id: exerciseId, muscle: primary, role: 'primary' });
    for (const m of sec) db.insert('exercise_muscles', { exercise_id: exerciseId, muscle: m, role: 'secondary' });
    db.run('UPDATE exercises SET muscles_seeded=1 WHERE id=?', [exerciseId]);
    audit(db, 'exercise_muscles', exerciseId, 'update', before, { primary, secondary: sec }, reason);
  });
}

// ---------------------------------------------------------------- insight data
// Every non-deleted set with what the insight views need, in one query.
export function insightRows(db) {
  const rows = db.all(`
    SELECT st.id, st.set_type, st.set_subtype, st.deleted, st.load_kg, st.reps, st.load_multiplier, st.fidelity set_fidelity,
           s.id session_id, s.date_local, s.fidelity, se.variant_id, v.exercise_id
    FROM sets st JOIN session_exercises se ON se.id=st.session_exercise_id JOIN sessions s ON s.id=se.session_id
    JOIN exercise_variants v ON v.id=se.variant_id
    WHERE st.deleted=0`);
  const sides = new Map();
  for (const sd of db.all('SELECT * FROM set_sides')) {
    if (!sides.has(sd.set_id)) sides.set(sd.set_id, []);
    sides.get(sd.set_id).push(sd);
  }
  for (const r of rows) r.sides = sides.get(r.id) ?? [];
  return rows;
}

export function insightCardio(db) {
  return db.all('SELECT c.duration_sec, s.date_local, s.fidelity FROM cardio c JOIN sessions s ON s.id=c.session_id');
}

// PRs as they stood on the day: each set against earlier sessions on the same
// machine and earlier sets that day. Partial reconstructions claim none.
export function sessionPRs(db, sessionId) {
  const g = getSessionGraph(db, sessionId);
  if (!g || g.session.fidelity === 'partial_reconstruction') return [];
  const out = [];
  for (const e of g.exercises) {
    const history = variantHistory(db, e.variant_id);
    const at = history.findIndex((h) => h.session.id === sessionId);
    const earlier = history.slice(0, at < 0 ? history.length : at)
      .filter((h) => h.session.fidelity !== 'partial_reconstruction').flatMap((h) => h.sets);
    for (const s of e.sets) {
      // A first session on a machine sets the baseline; it has nothing to beat yet.
      const prs = earlier.length ? livePRs(s, [...earlier, ...e.sets.filter((x) => x.position < s.position)]) : [];
      if (prs.length) out.push({ exercise_name: e.exercise_name, label: variantLabel(e), variant_id: e.variant_id, load_basis: e.load_basis, set: s, prs });
    }
  }
  return out;
}

// ---------------------------------------------------------------- body weight
export function listBodyMetrics(db) {
  return db.all("SELECT * FROM body_metrics ORDER BY COALESCE(date_local, '9999'), rowid");
}

function checkWeight(w) {
  if (!(w > 0 && w < 400)) throw new Error('Enter a body weight in kg between 0 and 400.');
}

export function addBodyMetric(db, { date_local, weight_kg, context = null }) {
  checkWeight(weight_kg);
  ensureUser(db);
  const row = { id: randomId('bm'), user_id: USER_ID, date_local, weight_kg, context };
  db.tx(() => {
    db.insert('body_metrics', row);
    audit(db, 'body_metrics', row.id, 'create', null, row);
  });
  return row;
}

export function updateBodyMetric(db, id, patch, reason) {
  if (patch.weight_kg !== undefined) checkWeight(patch.weight_kg);
  const before = db.get('SELECT * FROM body_metrics WHERE id=?', [id]);
  db.tx(() => {
    db.update('body_metrics', id, patch);
    audit(db, 'body_metrics', id, 'update', before, { ...before, ...patch }, reason);
  });
}

export function deleteBodyMetric(db, id, reason) {
  const before = db.get('SELECT * FROM body_metrics WHERE id=?', [id]);
  db.tx(() => {
    db.run('DELETE FROM body_metrics WHERE id=?', [id]);
    audit(db, 'body_metrics', id, 'delete', before, null, reason);
  });
}

export function findOrCreateVariant(db, { exercise_id, equipment_id, variation = '', laterality = 'bilateral', load_basis = 'total' }) {
  variation = variation?.trim() || '';
  const ex = db.get('SELECT * FROM exercise_variants WHERE exercise_id=? AND equipment_id=? AND variation=?', [exercise_id, equipment_id, variation]);
  if (ex) return ex;
  const row = { id: stableId('var', exercise_id, equipment_id, variation.toLowerCase()), exercise_id, equipment_id, variation, laterality, load_basis };
  db.insert('exercise_variants', row);
  return row;
}

// ---------------------------------------------------------------- machine library
// Creates the lifter's own machine from a library entry. Existing machines are reused only when
// they are the same brand + machine + variation; nothing is ever merged (specs/003).
export function createFromLibrary(db, entryId, { exercise, variation = '', laterality, load_basis } = {}) {
  const entry = getEntry(entryId);
  if (!entry || entry.load === 'cardio') throw new Error(`Not a machine in the library: ${entryId}`);
  if (!entry.exercises.includes(exercise)) throw new Error(`${exercise} is not an exercise for ${entry.name}`);
  const d = defaultsFor(entry, exercise, variation);
  return db.tx(() => {
    const ex = findOrCreateExercise(db, exercise);
    const eq = findOrCreateEquipment(db, {
      brand: entry.brand ?? 'unspecified',
      description: entry.brand ? `${entry.series} ${entry.name}` : entry.name,
      load_type: equipmentLoadType(entry),
      library_id: entry.id,
    });
    const v = (variation ?? '').trim();
    const existing = db.get('SELECT * FROM exercise_variants WHERE exercise_id=? AND equipment_id=? AND variation=?', [ex.id, eq.id, v]);
    if (existing) return existing;
    const row = findOrCreateVariant(db, { exercise_id: ex.id, equipment_id: eq.id, variation: v, laterality: laterality ?? d.laterality, load_basis: load_basis ?? d.load_basis });
    audit(db, 'exercise_variants', row.id, 'create', null, row, `from library ${entry.id}`);
    return row;
  });
}

export function findLibraryMachines(db, entryId) {
  return db.all(`${VARIANT_SELECT} WHERE q.library_id=? ORDER BY v.variation`, [entryId]).map((v) => ({ ...v, label: variantLabel(v) }));
}

// The lifter's machines for the same exercise and brand — shown as a suggestion, never linked.
export function similarMachines(db, entry, exercise) {
  return db.all(`${VARIANT_SELECT} WHERE lower(e.name)=lower(?) AND q.brand=? AND v.archived=0 ORDER BY q.description, v.variation`, [exercise, entry.brand ?? 'unspecified'])
    .map((v) => ({ ...v, label: variantLabel(v) }));
}

export function variantLabel(v) {
  const parts = [v.exercise_name];
  parts.push(v.brand && v.brand !== 'unspecified' ? v.brand : 'brand unspecified');
  if (v.equipment_description) parts.push(v.equipment_description);
  if (v.variation) parts.push(v.variation);
  return parts.join(' · ');
}

const VARIANT_SELECT = `
  SELECT v.*, e.name AS exercise_name, e.category, e.muscle_group, q.brand, q.description AS equipment_description,
         q.load_type, q.increment_kg, q.id AS equipment_id
  FROM exercise_variants v JOIN exercises e ON e.id=v.exercise_id JOIN equipment q ON q.id=v.equipment_id`;

export function getVariant(db, id) {
  const v = db.get(`${VARIANT_SELECT} WHERE v.id=?`, [id]);
  return v && { ...v, label: variantLabel(v) };
}

export function listVariants(db, { includeArchived = false } = {}) {
  const rows = db.all(`${VARIANT_SELECT} ${includeArchived ? '' : 'WHERE v.archived=0'} ORDER BY e.name, q.brand, q.description, v.variation`);
  const stats = db.all(`
    SELECT se.variant_id, COUNT(DISTINCT se.session_id) sessions, MAX(s.date_local) last_date,
           SUM(CASE WHEN st.set_type='working' AND st.deleted=0 THEN 1 ELSE 0 END) working_sets
    FROM session_exercises se JOIN sessions s ON s.id=se.session_id LEFT JOIN sets st ON st.session_exercise_id=se.id
    GROUP BY se.variant_id`);
  const by = new Map(stats.map((r) => [r.variant_id, r]));
  return rows.map((v) => ({ ...v, label: variantLabel(v), sessions: by.get(v.id)?.sessions ?? 0, last_date: by.get(v.id)?.last_date ?? null, working_sets: by.get(v.id)?.working_sets ?? 0 }));
}

export function updateVariant(db, id, patch, reason) {
  const before = db.get('SELECT * FROM exercise_variants WHERE id=?', [id]);
  db.update('exercise_variants', id, patch);
  audit(db, 'exercise_variants', id, 'update', before, { ...before, ...patch }, reason);
}

export function updateEquipment(db, id, patch, reason) {
  const before = db.get('SELECT * FROM equipment WHERE id=?', [id]);
  db.update('equipment', id, patch);
  audit(db, 'equipment', id, 'update', before, { ...before, ...patch }, reason);
}

// Move every logged exercise from one variant into another (e.g. the user
// confirms two entries were the same machine). Audited and reversible by hand.
export function mergeVariant(db, fromId, intoId, reason) {
  db.tx(() => {
    const moved = db.all('SELECT id FROM session_exercises WHERE variant_id=?', [fromId]).map((r) => r.id);
    db.run('UPDATE session_exercises SET variant_id=? WHERE variant_id=?', [intoId, fromId]);
    db.run('UPDATE plan_items SET variant_id=? WHERE variant_id=?', [intoId, fromId]);
    db.run('UPDATE exercise_variants SET archived=1 WHERE id=?', [fromId]);
    audit(db, 'exercise_variants', fromId, 'update', { variant_id: fromId, session_exercises: moved }, { merged_into: intoId }, reason || 'merge variants');
  });
}

// ---------------------------------------------------------------- sessions
export function listSessions(db) {
  return db.all(`
    SELECT s.*,
      (SELECT COUNT(*) FROM sets st JOIN session_exercises se ON se.id=st.session_exercise_id WHERE se.session_id=s.id AND st.set_type='working' AND st.deleted=0) AS working_sets,
      (SELECT COUNT(*) FROM cardio c WHERE c.session_id=s.id) AS cardio_count,
      (SELECT COUNT(*) FROM session_exercises se WHERE se.session_id=s.id) AS exercise_count
    FROM sessions s ORDER BY COALESCE(s.date_local,'0000') DESC, COALESCE(s.started_at_utc, s.created_at_utc) DESC`);
}

function setsFor(db, seIds) {
  if (!seIds.length) return new Map();
  const q = seIds.map(() => '?').join(',');
  const sets = db.all(`SELECT * FROM sets WHERE session_exercise_id IN (${q}) ORDER BY position`, seIds);
  const sides = sets.length
    ? db.all(`SELECT * FROM set_sides WHERE set_id IN (${sets.map(() => '?').join(',')}) ORDER BY side`, sets.map((s) => s.id))
    : [];
  const sideBy = new Map();
  for (const sd of sides) {
    if (!sideBy.has(sd.set_id)) sideBy.set(sd.set_id, []);
    sideBy.get(sd.set_id).push(sd);
  }
  const out = new Map();
  for (const s of sets) {
    s.sides = sideBy.get(s.id) ?? [];
    if (!out.has(s.session_exercise_id)) out.set(s.session_exercise_id, []);
    out.get(s.session_exercise_id).push(s);
  }
  return out;
}

export function getSessionGraph(db, sessionId, { includeDeleted = false } = {}) {
  const session = db.get('SELECT * FROM sessions WHERE id=?', [sessionId]);
  if (!session) return null;
  session.notes = session.notes_json ? JSON.parse(session.notes_json) : [];
  const ses = db.all(`
    SELECT se.*, v.laterality, v.load_basis, v.variation, v.rep_min, v.rep_max, v.rest_sec AS variant_rest_sec,
           e.name AS exercise_name, e.category, q.brand, q.description AS equipment_description, q.load_type, q.increment_kg, q.id AS equipment_id
    FROM session_exercises se JOIN exercise_variants v ON v.id=se.variant_id JOIN exercises e ON e.id=v.exercise_id
    JOIN equipment q ON q.id=v.equipment_id WHERE se.session_id=? ORDER BY se.position`, [sessionId]);
  const sets = setsFor(db, ses.map((r) => r.id));
  const planned = ses.length
    ? db.all(`SELECT * FROM planned_sets WHERE session_exercise_id IN (${ses.map(() => '?').join(',')}) ORDER BY position`, ses.map((r) => r.id))
    : [];
  const exercises = ses.map((se) => ({
    ...se,
    label: variantLabel(se),
    sets: (sets.get(se.id) ?? []).filter((s) => includeDeleted || !s.deleted),
    planned: planned.filter((p) => p.session_exercise_id === se.id),
  }));
  const cardio = db.all('SELECT * FROM cardio WHERE session_id=? ORDER BY position', [sessionId]);
  const partials = db.all('SELECT * FROM partial_summaries WHERE session_id=? ORDER BY position', [sessionId]);
  return { session, exercises, cardio, partials };
}

// All logged work on one variant, oldest first, as [{session, sets}].
export function variantHistory(db, variantId, { excludeSessionId = null } = {}) {
  const ses = db.all(`
    SELECT se.id se_id, s.id, s.date_local, s.fidelity, s.label, s.started_at_utc
    FROM session_exercises se JOIN sessions s ON s.id=se.session_id
    WHERE se.variant_id=? AND (? IS NULL OR s.id<>?)
    ORDER BY COALESCE(s.date_local,'0000'), COALESCE(s.started_at_utc,''), se.position`, [variantId, excludeSessionId, excludeSessionId]);
  const sets = setsFor(db, ses.map((r) => r.se_id));
  const out = [];
  for (const r of ses) {
    const list = (sets.get(r.se_id) ?? []).filter((s) => !s.deleted);
    const prev = out[out.length - 1];
    if (prev && prev.session.id === r.id) prev.sets.push(...list);
    else out.push({ session: { id: r.id, date_local: r.date_local, fidelity: r.fidelity, label: r.label }, sets: list });
  }
  return out;
}

export function createSession(db, { label = null, plan_day_id = null, date_local = null } = {}) {
  ensureUser(db);
  const now = nowUtc();
  const row = {
    id: randomId('ses'),
    user_id: USER_ID,
    date_local: date_local ?? todaySgt(),
    label,
    status: 'active',
    fidelity: 'live',
    started_at_utc: now,
    time_precision: 'exact',
    plan_day_id,
    notes_json: '[]',
    created_at_utc: now,
    updated_at_utc: now,
  };
  db.insert('sessions', row);
  audit(db, 'sessions', row.id, 'create', null, row);
  return row;
}

export function updateSession(db, id, patch, reason = null) {
  const before = db.get('SELECT * FROM sessions WHERE id=?', [id]);
  const p = { ...patch, updated_at_utc: nowUtc() };
  db.update('sessions', id, p);
  audit(db, 'sessions', id, 'update', before, { ...before, ...p }, reason);
}

export function finishSession(db, id) {
  db.tx(() => {
    db.run('DELETE FROM set_drafts WHERE session_exercise_id IN (SELECT id FROM session_exercises WHERE session_id=?)', [id]);
    updateSession(db, id, { status: 'completed', ended_at_utc: nowUtc() }, 'finish session');
  });
}

export function activeSession(db) {
  return db.get("SELECT * FROM sessions WHERE status='active' ORDER BY started_at_utc DESC LIMIT 1");
}

export function deleteSession(db, id, reason) {
  const g = getSessionGraph(db, id, { includeDeleted: true });
  db.tx(() => {
    db.run('DELETE FROM recommendations WHERE session_id=?', [id]);
    db.run('DELETE FROM sessions WHERE id=?', [id]);
    audit(db, 'sessions', id, 'delete', g, null, reason);
  });
}

export function addSessionExercise(db, sessionId, variantId, { superset_group = null, planned = [], plan_item_id = null, target_rest_sec = null } = {}) {
  const pos = (db.get('SELECT MAX(position) m FROM session_exercises WHERE session_id=?', [sessionId])?.m ?? -1) + 1;
  const row = { id: randomId('se'), session_id: sessionId, variant_id: variantId, position: pos, superset_group, plan_item_id, target_rest_sec };
  db.tx(() => {
    db.insert('session_exercises', row);
    planned.forEach((p, i) => db.insert('planned_sets', { id: randomId('ps'), session_exercise_id: row.id, position: i, ...p }));
    audit(db, 'session_exercises', row.id, 'create', null, row);
  });
  return row;
}

export function updateSessionExercise(db, id, patch, reason = null) {
  const before = db.get('SELECT * FROM session_exercises WHERE id=?', [id]);
  db.update('session_exercises', id, patch);
  audit(db, 'session_exercises', id, 'update', before, { ...before, ...patch }, reason);
}

export function removeSessionExercise(db, id, reason = 'removed from session') {
  const before = db.get('SELECT * FROM session_exercises WHERE id=?', [id]);
  db.tx(() => {
    db.run('DELETE FROM session_exercises WHERE id=?', [id]);
    audit(db, 'session_exercises', id, 'delete', before, null, reason);
  });
}

// Normalises user input for a set. `sides` = [{side, reps, rir}] when logged per side.
function setFields(input) {
  const rir = input.rir === undefined || input.rir === null || input.rir === '' ? null : parseRir(input.rir);
  return {
    set_type: input.set_type ?? 'working',
    set_type_raw: input.set_type_raw ?? input.set_type ?? 'working',
    set_subtype: input.set_subtype ?? null,
    load_kg: input.load_kg ?? null,
    load_display: input.load_display ?? null,
    load_multiplier: input.load_multiplier ?? 1,
    reps: input.reps ?? null,
    partials: input.partials ?? null,
    rir_raw: rir?.raw ?? null,
    rir_min: rir?.min ?? null,
    rir_max: rir?.max ?? null,
    rir_approx: rir?.approx ? 1 : 0,
    technique: input.technique ?? null,
    rest_sec: input.rest_sec ?? null,
    notes: input.notes ?? null,
  };
}

function writeSides(db, setId, sides) {
  db.run('DELETE FROM set_sides WHERE set_id=?', [setId]);
  for (const sd of sides || []) {
    const r = sd.rir === undefined || sd.rir === null || sd.rir === '' ? null : parseRir(sd.rir);
    db.insert('set_sides', {
      id: stableId('side', setId, sd.side),
      set_id: setId,
      side: sd.side,
      reps: sd.reps ?? null,
      partials: sd.partials ?? null,
      rir_raw: r?.raw ?? null,
      rir_min: r?.min ?? null,
      rir_max: r?.max ?? null,
      rir_approx: r?.approx ? 1 : 0,
    });
  }
}

// Combine per-side RIR into a set-level range so list views stay truthful.
function sidesToSetRir(fields, sides) {
  const parsed = (sides || []).map((s) => (s.rir === undefined || s.rir === null || s.rir === '' ? null : parseRir(s.rir))).filter(Boolean);
  if (!parsed.length) return fields;
  const raw = (sides || []).filter((s) => s.rir !== null && s.rir !== undefined && s.rir !== '').map((s) => `${s.side === 'L' ? 'left' : 'right'} ${s.rir}`).join('; ');
  const mins = parsed.map((p) => p.min).filter((v) => v !== null);
  const maxs = parsed.map((p) => p.max);
  return { ...fields, rir_raw: raw, rir_min: mins.length ? Math.min(...mins) : null, rir_max: maxs.some((m) => m === null) ? null : Math.max(...maxs), rir_approx: parsed.some((p) => p.approx) ? 1 : 0 };
}

export function logSet(db, sessionExerciseId, input) {
  const now = nowUtc();
  const pos = (db.get('SELECT MAX(position) m FROM sets WHERE session_exercise_id=?', [sessionExerciseId])?.m ?? -1) + 1;
  const sesId = db.get('SELECT session_id FROM session_exercises WHERE id=?', [sessionExerciseId]).session_id;
  const order = (db.get('SELECT MAX(st.session_order) m FROM sets st JOIN session_exercises se ON se.id=st.session_exercise_id WHERE se.session_id=?', [sesId])?.m ?? -1) + 1;
  let fields = setFields(input);
  if (input.sides?.length) fields = sidesToSetRir(fields, input.sides);
  const row = {
    id: randomId('set'),
    session_exercise_id: sessionExerciseId,
    position: pos,
    session_order: order,
    ...fields,
    rir_source: fields.rir_raw ? 'live' : null,
    superset_pair_set_id: input.superset_pair_set_id ?? null,
    fidelity: 'live',
    completed_at_utc: now,
    created_at_utc: now,
    updated_at_utc: now,
  };
  db.tx(() => {
    db.insert('sets', row);
    writeSides(db, row.id, input.sides);
    if (input.recommendation_id) {
      const r = db.get('SELECT * FROM recommendations WHERE id=?', [input.recommendation_id]);
      if (r) db.update('recommendations', r.id, { logged_set_id: row.id, outcome: r.load_kg === row.load_kg ? 'followed' : 'overridden' });
    }
    audit(db, 'sets', row.id, 'create', null, { ...row, sides: input.sides ?? [] });
  });
  return row;
}

// ---------------------------------------------------------------- set rows (drafts)
const DRAFT_FIELDS = ['set_type', 'set_subtype', 'load_kg', 'reps', 'rir', 'per_side', 'left_reps', 'left_rir', 'right_reps', 'right_rir'];
const toDraft = (r) => ({ ...r, touched: JSON.parse(r.touched_json || '[]') });

export function listDrafts(db, sessionExerciseId) {
  return db.all('SELECT * FROM set_drafts WHERE session_exercise_id=? ORDER BY position', [sessionExerciseId]).map(toDraft);
}

function insertDraft(db, sessionExerciseId, position, fields = {}) {
  const row = { id: randomId('dft'), session_exercise_id: sessionExerciseId, position, ...fields };
  db.insert('set_drafts', row);
  return row;
}

// Creates rows once per exercise, so a row the lifter removed stays removed.
export function prepareLiveRows(db, sessionId) {
  const pending = db.all(`
    SELECT se.id, v.laterality,
      (SELECT COUNT(*) FROM planned_sets p WHERE p.session_exercise_id=se.id) planned,
      (SELECT COUNT(*) FROM sets s WHERE s.session_exercise_id=se.id AND s.deleted=0) done
    FROM session_exercises se JOIN exercise_variants v ON v.id=se.variant_id
    WHERE se.session_id=? AND se.rows_seeded=0`, [sessionId]);
  if (!pending.length) return;
  db.tx(() => {
    for (const se of pending) {
      const count = se.planned ? Math.max(0, se.planned - se.done) : se.done ? 0 : 1;
      for (let i = 0; i < count; i++) insertDraft(db, se.id, i, { per_side: se.laterality === 'unilateral' ? 1 : 0 });
      db.update('session_exercises', se.id, { rows_seeded: 1 });
    }
  });
}

export function addDraft(db, sessionExerciseId, seed = {}, { before = false } = {}) {
  const r = db.get('SELECT MIN(position) lo, MAX(position) hi FROM set_drafts WHERE session_exercise_id=?', [sessionExerciseId]);
  const position = before ? (r?.lo ?? 1) - 1 : (r?.hi ?? -1) + 1;
  const fields = Object.fromEntries(Object.entries(seed).filter(([k]) => DRAFT_FIELDS.includes(k)));
  return toDraft({ ...insertDraft(db, sessionExerciseId, position, fields), touched_json: '[]' });
}

export function removeDraft(db, draftId) {
  db.run('DELETE FROM set_drafts WHERE id=?', [draftId]);
}

// Saves what the lifter changed and remembers it, so targets never overwrite it.
export function saveDraft(db, draftId, patch) {
  const d = db.get('SELECT * FROM set_drafts WHERE id=?', [draftId]);
  if (!d) return null;
  const clean = Object.fromEntries(Object.entries(patch).filter(([k]) => DRAFT_FIELDS.includes(k)));
  const touched = [...new Set([...JSON.parse(d.touched_json), ...Object.keys(clean)])];
  db.update('set_drafts', draftId, { ...clean, touched_json: JSON.stringify(touched) });
  return toDraft(db.get('SELECT * FROM set_drafts WHERE id=?', [draftId]));
}

// Fills untouched weight and reps. RIR is never pre-filled: only the lifter can report it.
export function refreshDraftTargets(db, sessionExerciseId, targets) {
  const drafts = new Map(listDrafts(db, sessionExerciseId).map((d) => [d.id, d]));
  db.tx(() => {
    for (const t of targets) {
      const d = drafts.get(t.draft_id);
      if (!d) continue;
      const patch = {};
      const set = (field, value) => { if (!d.touched.includes(field) && d[field] !== (value ?? null)) patch[field] = value ?? null; };
      set('load_kg', t.load_kg);
      set('reps', t.reps);
      set('left_reps', t.reps);
      set('right_reps', t.reps);
      db.update('set_drafts', d.id, patch);
    }
  });
}

export function validateDraft(d) {
  if (d.load_kg === null || d.load_kg === undefined) return 'Enter a weight first (0 is fine).';
  const hasReps = d.per_side ? d.left_reps !== null || d.right_reps !== null : d.reps !== null;
  return hasReps ? null : 'Enter reps first.';
}

// Actual rest belongs to the set before this one, except between exercises of a superset round.
function recordActualRest(db, sessionId, se, now) {
  const prev = db.get(`
    SELECT st.id, st.completed_at_utc, st.fidelity, x.id se_id, x.superset_group
    FROM sets st JOIN session_exercises x ON x.id=st.session_exercise_id
    WHERE x.session_id=? AND st.deleted=0 AND st.completed_at_utc IS NOT NULL
    ORDER BY st.session_order DESC LIMIT 1`, [sessionId]);
  if (!prev || prev.fidelity !== 'live') return;
  if (se.superset_group && prev.superset_group === se.superset_group && prev.se_id !== se.id) return;
  db.update('sets', prev.id, { rest_sec: Math.round((Date.parse(now) - Date.parse(prev.completed_at_utc)) / 1000) });
}

// The only way a row becomes a set. Delete and insert share one transaction, so a
// second tap finds no draft and records nothing.
export function confirmDraft(db, draftId, { recommendation = null } = {}) {
  return db.tx(() => {
    const row = db.get('SELECT * FROM set_drafts WHERE id=?', [draftId]);
    if (!row) return null;
    const d = toDraft(row);
    if (validateDraft(d)) return null;
    const se = db.get(`SELECT se.*, v.load_basis FROM session_exercises se JOIN exercise_variants v ON v.id=se.variant_id WHERE se.id=?`, [d.session_exercise_id]);
    const input = {
      set_type: d.set_type,
      set_type_raw: d.set_subtype ?? d.set_type,
      set_subtype: d.set_subtype,
      load_kg: d.load_kg,
      load_multiplier: se.load_basis === 'per_side' || se.load_basis === 'per_limb' ? 2 : 1,
    };
    if (d.per_side) {
      input.reps = d.left_reps === d.right_reps ? d.left_reps : null;
      input.sides = [['L', d.left_reps, d.left_rir], ['R', d.right_reps, d.right_rir]]
        .filter(([, reps, rir]) => reps !== null || rir !== null)
        .map(([side, reps, rir]) => ({ side, reps, rir }));
    } else {
      input.reps = d.reps;
      input.rir = d.rir;
    }
    if (recommendation) input.recommendation_id = saveRecommendation(db, se.session_id, se.variant_id, recommendation).id;
    recordActualRest(db, se.session_id, se, nowUtc());
    db.run('DELETE FROM set_drafts WHERE id=?', [draftId]);
    return logSet(db, d.session_exercise_id, input);
  });
}

// Undo: an audited soft delete, with the values going back on a row.
export function unconfirmSet(db, setId, reason = 'undo') {
  return db.tx(() => {
    const s = getSet(db, setId);
    if (!s || s.deleted) return null;
    const sesId = db.get('SELECT session_id FROM session_exercises WHERE id=?', [s.session_exercise_id]).session_id;
    deleteSet(db, setId, reason);
    db.run(`UPDATE sets SET rest_sec=NULL WHERE id=(
      SELECT st.id FROM sets st JOIN session_exercises x ON x.id=st.session_exercise_id
      WHERE x.session_id=? AND st.deleted=0 AND st.fidelity='live' AND st.session_order<? ORDER BY st.session_order DESC LIMIT 1)`, [sesId, s.session_order]);
    const side = (k) => s.sides.find((x) => x.side === k);
    const fields = {
      set_type: s.set_type, set_subtype: s.set_subtype, load_kg: s.load_kg, reps: s.reps,
      rir: s.sides.length ? null : s.rir_raw,
      per_side: s.sides.length ? 1 : 0,
      left_reps: side('L')?.reps ?? (side('L') ? s.reps : null), left_rir: side('L')?.rir_raw ?? null,
      right_reps: side('R')?.reps ?? (side('R') ? s.reps : null), right_rir: side('R')?.rir_raw ?? null,
      touched_json: JSON.stringify(['load_kg', 'reps', 'left_reps', 'right_reps']),
      restored_from_set_id: setId,
    };
    const lo = db.get('SELECT MIN(position) lo FROM set_drafts WHERE session_exercise_id=?', [s.session_exercise_id])?.lo ?? 1;
    return toDraft(insertDraft(db, s.session_exercise_id, lo - 1, fields));
  });
}

export function finishCheck(db, sessionId) {
  const count = (sql) => db.get(sql, [sessionId]).n;
  return {
    confirmedSets: count('SELECT COUNT(*) n FROM sets s JOIN session_exercises x ON x.id=s.session_exercise_id WHERE x.session_id=? AND s.deleted=0'),
    cardio: count('SELECT COUNT(*) n FROM cardio WHERE session_id=?'),
    unlogged: db.all(`
      SELECT e.name label, COUNT(*) count FROM set_drafts d
      JOIN session_exercises x ON x.id=d.session_exercise_id
      JOIN exercise_variants v ON v.id=x.variant_id JOIN exercises e ON e.id=v.exercise_id
      WHERE x.session_id=? GROUP BY x.id ORDER BY x.position`, [sessionId]),
  };
}

export function getSet(db, id) {
  const s = db.get('SELECT * FROM sets WHERE id=?', [id]);
  if (s) s.sides = db.all('SELECT * FROM set_sides WHERE set_id=? ORDER BY side', [id]);
  return s;
}

// Corrections to any set (live or imported). `input` uses the same shape as logSet.
export function updateSet(db, id, input, reason) {
  const before = getSet(db, id);
  if (!before) throw new Error(`set ${id} not found`);
  const merged = {
    set_type: before.set_type, set_type_raw: before.set_type_raw, set_subtype: before.set_subtype,
    load_kg: before.load_kg, load_display: before.load_display, load_multiplier: before.load_multiplier,
    reps: before.reps, partials: before.partials, rir: before.rir_raw, technique: before.technique,
    rest_sec: before.rest_sec, notes: before.notes, ...input,
  };
  // Saving the same type keeps its original wording and subtype (Top set, failure).
  if (input.set_type && input.set_type !== before.set_type) {
    merged.set_type_raw = input.set_type_raw ?? input.set_type;
    merged.set_subtype = input.set_subtype ?? null;
  }
  let fields = setFields(merged);
  const sides = input.sides !== undefined ? input.sides : before.sides.map((s) => ({ side: s.side, reps: s.reps, partials: s.partials, rir: s.rir_raw }));
  if (input.sides !== undefined && input.sides.length) fields = sidesToSetRir(fields, input.sides);
  else if (input.rir === undefined && input.sides === undefined) {
    fields = { ...fields, rir_raw: before.rir_raw, rir_min: before.rir_min, rir_max: before.rir_max, rir_approx: before.rir_approx };
  }
  const rirChanged = fields.rir_raw !== before.rir_raw;
  db.tx(() => {
    db.update('sets', id, { ...fields, ...(rirChanged ? { rir_source: 'correction' } : {}), updated_at_utc: nowUtc() });
    if (input.sides !== undefined) writeSides(db, id, sides);
    audit(db, 'sets', id, 'update', before, getSet(db, id), reason);
  });
  return getSet(db, id);
}

export function deleteSet(db, id, reason) {
  const before = getSet(db, id);
  db.tx(() => {
    db.update('sets', id, { deleted: 1, updated_at_utc: nowUtc() });
    audit(db, 'sets', id, 'delete', before, null, reason);
  });
}

export function restoreSet(db, id, reason = 'restore') {
  db.tx(() => {
    db.update('sets', id, { deleted: 0, updated_at_utc: nowUtc() });
    audit(db, 'sets', id, 'update', { deleted: 1 }, { deleted: 0 }, reason);
  });
}

export function addCardio(db, sessionId, input) {
  const pos = (db.get('SELECT MAX(position) m FROM cardio WHERE session_id=?', [sessionId])?.m ?? -1) + 1;
  const row = { id: randomId('car'), session_id: sessionId, position: pos, fidelity: 'live', type: 'incline_treadmill', ...input };
  db.tx(() => {
    db.insert('cardio', row);
    audit(db, 'cardio', row.id, 'create', null, row);
  });
  return row;
}

export function updateCardio(db, id, patch, reason) {
  const before = db.get('SELECT * FROM cardio WHERE id=?', [id]);
  db.update('cardio', id, patch);
  audit(db, 'cardio', id, 'update', before, { ...before, ...patch }, reason);
}

export function deleteCardio(db, id, reason) {
  const before = db.get('SELECT * FROM cardio WHERE id=?', [id]);
  db.tx(() => {
    db.run('DELETE FROM cardio WHERE id=?', [id]);
    audit(db, 'cardio', id, 'delete', before, null, reason);
  });
}

export function saveRecommendation(db, sessionId, variantId, r) {
  const row = {
    id: randomId('rec'),
    session_id: sessionId,
    variant_id: variantId,
    created_at_utc: nowUtc(),
    action: r.action,
    load_kg: r.load_kg ?? null,
    rep_min: r.rep_min ?? null,
    rep_max: r.rep_max ?? null,
    rir_min: r.rir_min ?? null,
    rir_max: r.rir_max ?? null,
    confidence: r.confidence,
    rationale: r.rationale,
    basis_set_ids_json: JSON.stringify(r.basis_set_ids ?? []),
  };
  db.insert('recommendations', row);
  return row;
}

export function auditFor(db, entity = null, limit = 200) {
  return entity
    ? db.all('SELECT * FROM audit_log WHERE entity=? ORDER BY at_utc DESC LIMIT ?', [entity, limit])
    : db.all("SELECT * FROM audit_log WHERE action<>'import' ORDER BY at_utc DESC LIMIT ?", [limit]);
}

// ---------------------------------------------------------------- plans
export function listPlans(db) {
  const plans = db.all('SELECT * FROM plans ORDER BY is_active DESC, created_at_utc');
  for (const p of plans) {
    p.days = db.all('SELECT * FROM plan_days WHERE plan_id=? ORDER BY position', [p.id]);
    for (const d of p.days) {
      d.items = db.all('SELECT * FROM plan_items WHERE plan_day_id=? ORDER BY position', [d.id]).map((i) => ({
        ...i,
        substitutes: JSON.parse(i.substitute_variant_ids_json || '[]'),
        variant: getVariant(db, i.variant_id),
      }));
    }
  }
  return plans;
}

export function createPlan(db, name, { is_active = 0, notes = null } = {}) {
  const row = { id: randomId('plan'), name, notes, is_active, created_at_utc: nowUtc() };
  db.tx(() => {
    if (is_active) db.run('UPDATE plans SET is_active=0');
    db.insert('plans', row);
    audit(db, 'plans', row.id, 'create', null, row);
  });
  return row;
}

export function updatePlan(db, id, patch) {
  db.tx(() => {
    if (patch.is_active) db.run('UPDATE plans SET is_active=0');
    const before = db.get('SELECT * FROM plans WHERE id=?', [id]);
    db.update('plans', id, patch);
    audit(db, 'plans', id, 'update', before, { ...before, ...patch });
  });
}

export function deletePlan(db, id) {
  const before = db.get('SELECT * FROM plans WHERE id=?', [id]);
  db.tx(() => {
    db.run('UPDATE sessions SET plan_day_id=NULL WHERE plan_day_id IN (SELECT id FROM plan_days WHERE plan_id=?)', [id]);
    db.run('DELETE FROM plans WHERE id=?', [id]);
    audit(db, 'plans', id, 'delete', before, null);
  });
}

export function addPlanDay(db, planId, name, focus = null) {
  const pos = (db.get('SELECT MAX(position) m FROM plan_days WHERE plan_id=?', [planId])?.m ?? -1) + 1;
  const row = { id: randomId('pday'), plan_id: planId, position: pos, name, focus };
  db.insert('plan_days', row);
  return row;
}

export function updatePlanDay(db, id, patch) {
  db.update('plan_days', id, patch);
}

export function deletePlanDay(db, id) {
  db.tx(() => {
    db.run('UPDATE sessions SET plan_day_id=NULL WHERE plan_day_id=?', [id]);
    db.run('DELETE FROM plan_days WHERE id=?', [id]);
  });
}

export function addPlanItem(db, dayId, item) {
  const pos = (db.get('SELECT MAX(position) m FROM plan_items WHERE plan_day_id=?', [dayId])?.m ?? -1) + 1;
  const row = {
    id: randomId('pitem'), plan_day_id: dayId, position: pos, target_sets: 2,
    ...item,
    substitute_variant_ids_json: JSON.stringify(item.substitutes ?? []),
  };
  delete row.substitutes;
  db.insert('plan_items', row);
  return row;
}

export function updatePlanItem(db, id, patch) {
  const p = { ...patch };
  if (p.substitutes) { p.substitute_variant_ids_json = JSON.stringify(p.substitutes); delete p.substitutes; }
  db.update('plan_items', id, p);
}

export function movePlanItem(db, id, dir) {
  const it = db.get('SELECT * FROM plan_items WHERE id=?', [id]);
  const other = db.get(`SELECT * FROM plan_items WHERE plan_day_id=? AND position ${dir < 0 ? '<' : '>'} ? ORDER BY position ${dir < 0 ? 'DESC' : 'ASC'} LIMIT 1`, [it.plan_day_id, it.position]);
  if (!other) return;
  db.tx(() => {
    db.update('plan_items', it.id, { position: other.position });
    db.update('plan_items', other.id, { position: it.position });
  });
}

export function deletePlanItem(db, id) {
  db.run('DELETE FROM plan_items WHERE id=?', [id]);
}

// Rotation: the day after the most recent session that used this plan.
export function nextPlanDay(db, planId) {
  const days = db.all('SELECT * FROM plan_days WHERE plan_id=? ORDER BY position', [planId]);
  if (!days.length) return null;
  const last = db.get(`SELECT d.position FROM sessions s JOIN plan_days d ON d.id=s.plan_day_id WHERE d.plan_id=?
    ORDER BY s.started_at_utc DESC LIMIT 1`, [planId]);
  if (!last) return days[0];
  return days.find((d) => d.position > last.position) ?? days[0];
}

// Start a live session from a plan day. `swaps` maps plan_item_id -> substitute variant id.
export function startSessionFromPlanDay(db, dayId, swaps = {}) {
  const day = db.get('SELECT * FROM plan_days WHERE id=?', [dayId]);
  const items = db.all('SELECT * FROM plan_items WHERE plan_day_id=? ORDER BY position', [dayId]);
  return db.tx(() => {
    const ses = createSession(db, { label: day.name, plan_day_id: dayId });
    if (day.focus) db.update('sessions', ses.id, { focus: day.focus });
    for (const it of items) {
      const planned = Array.from({ length: it.target_sets }, () => ({
        rep_min: it.rep_min, rep_max: it.rep_max, rir_min: it.rir_min, rir_max: it.rir_max,
      }));
      addSessionExercise(db, ses.id, swaps[it.id] ?? it.variant_id, { superset_group: it.superset_group, planned, plan_item_id: it.id, target_rest_sec: it.rest_sec });
    }
    return ses;
  });
}
