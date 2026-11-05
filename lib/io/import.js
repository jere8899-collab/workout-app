// Importers for the supplied history.
//
//   importCanonical(db, { jsonText, augustMdText })  — primary path
//   importFlatCsv(db, csvText)                        — alternative flat table
//
// Rules: every source document is stored verbatim; values are copied, not
// guessed; anything unclear becomes an import_issue the user can review.
import { stableId, fnv1a64, nowUtc } from '../util.js';
import { parseRir } from '../domain/rir.js';
import { normalizeSetType, setVolume, isWorking, round } from '../domain/sets.js';
import { parseTimingNote } from '../domain/time.js';
import {
  parseEquipment, parseVariation, loadBasisFromDisplay, parseCardioNote, parseBodyWeightNote, parseFocusNote,
  parseReportedKcal, parseClaimedTotals, parseSupersetNote, parsePartialSummary, parseAugustMarkdown, parseCsv,
} from './parse.js';
import {
  ensureUser, findOrCreateEquipment, findOrCreateExercise, findOrCreateVariant, USER_ID,
} from '../db/repo.js';

const REQUIRED_KEYS = ['schema_version', 'original_august_sessions', 'recent_detailed_sessions', 'additional_partial_sessions', 'set_rows'];

export function validateCanonical(doc) {
  const errors = [];
  if (!doc || typeof doc !== 'object') return ['Not a JSON object'];
  for (const k of REQUIRED_KEYS) if (!(k in doc)) errors.push(`missing key: ${k}`);
  const num = (v) => v === null || typeof v === 'number';
  (doc.original_august_sessions || []).forEach((s, i) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s.date ?? '')) errors.push(`original_august_sessions[${i}].date invalid`);
    (s.sets || []).forEach((x, j) => {
      if (!x.exercise) errors.push(`original_august_sessions[${i}].sets[${j}] has no exercise`);
      if (!num(x.load_kg) || !num(x.reps)) errors.push(`original_august_sessions[${i}].sets[${j}] load/reps not numeric`);
    });
  });
  (doc.recent_detailed_sessions || []).forEach((s, i) => {
    (s.exercises || []).forEach((e, j) => (e.sets || []).forEach((x, k) => {
      if (!num(x.load_kg) || !num(x.reps)) errors.push(`recent_detailed_sessions[${i}].exercises[${j}].sets[${k}] load/reps not numeric`);
    }));
  });
  return errors;
}

class Importer {
  constructor(db, sourceId) {
    this.db = db;
    this.sourceId = sourceId;
    this.report = { sessions: 0, skippedSessions: 0, exercises: 0, sets: 0, cardio: 0, partialLines: 0, parsedPartialLines: 0, issues: [] };
  }

  issue(severity, code, message, entity = null, entity_id = null) {
    const row = { id: stableId('iss', this.sourceId, code, entity_id ?? '', message), source_id: this.sourceId, severity, code, entity, entity_id, message };
    this.db.run('INSERT OR IGNORE INTO import_issues (id,source_id,severity,code,entity,entity_id,message) VALUES (?,?,?,?,?,?,?)',
      [row.id, row.source_id, row.severity, row.code, row.entity, row.entity_id, row.message]);
    this.report.issues.push(row);
  }

  session(fields) {
    if (this.db.get('SELECT id FROM sessions WHERE id=?', [fields.id])) {
      this.report.skippedSessions++;
      return false;
    }
    const now = nowUtc();
    this.db.insert('sessions', { user_id: USER_ID, status: 'completed', time_precision: 'unknown', created_at_utc: now, updated_at_utc: now, source_id: this.sourceId, ...fields });
    this.report.sessions++;
    return true;
  }

  exercise(sessionId, position, { name, equipment, variation, laterality, load_basis, raw }) {
    // "Technogym hack squat" on a Hack Squat says nothing beyond the brand.
    const d = (equipment.description || '').toLowerCase();
    if (equipment.brand !== 'unspecified' && (d === name.toLowerCase() || d === `${name.toLowerCase()} machine`)) equipment = { ...equipment, description: '' };
    const ex = findOrCreateExercise(this.db, name);
    const eq = findOrCreateEquipment(this.db, equipment);
    const v = findOrCreateVariant(this.db, { exercise_id: ex.id, equipment_id: eq.id, variation, laterality, load_basis });
    const id = stableId('se', sessionId, position);
    this.db.insert('session_exercises', {
      id, session_id: sessionId, variant_id: v.id, position,
      raw_exercise_name: raw.exercise ?? null, raw_equipment: raw.equipment ?? null, raw_variation: raw.variation ?? null, notes: raw.notes ?? null,
    });
    this.report.exercises++;
    return { id, variant: v, exercise: ex };
  }

  set(seId, position, fields, sides) {
    const now = nowUtc();
    const id = stableId('set', seId, position);
    this.db.insert('sets', { id, session_exercise_id: seId, position, created_at_utc: now, updated_at_utc: now, ...fields });
    for (const sd of sides || []) {
      this.db.insert('set_sides', { id: stableId('side', id, sd.side), set_id: id, ...sd });
    }
    this.report.sets++;
    return id;
  }

  cardio(sessionId, position, c) {
    const { issues, ...row } = c;
    this.db.insert('cardio', { id: stableId('car', sessionId, position), session_id: sessionId, position, ...row });
    for (const m of issues || []) this.issue('info', 'cardio_assumption', m, 'cardio', stableId('car', sessionId, position));
    this.report.cardio++;
  }

  body(dateLocal, weight, { approx = false, context = null, bodyFat = null } = {}) {
    const id = stableId('bm', dateLocal ?? 'undated');
    const ex = this.db.get('SELECT * FROM body_metrics WHERE id=?', [id]);
    if (ex) {
      if (ex.body_fat_pct === null && bodyFat !== null) this.db.update('body_metrics', id, { body_fat_pct: bodyFat });
      return;
    }
    this.db.insert('body_metrics', { id, user_id: USER_ID, date_local: dateLocal, weight_kg: weight, weight_is_approx: approx ? 1 : 0, body_fat_pct: bodyFat, context, source_id: this.sourceId });
  }
}

function addSource(db, kind, filename, text, meta = null, schemaVersion = null) {
  const hash = `fnv1a64:${fnv1a64(text)}`;
  const existing = db.get('SELECT id FROM import_sources WHERE content_hash=?', [hash]);
  if (existing) return { id: existing.id, duplicate: true };
  const id = stableId('src', kind, hash);
  db.insert('import_sources', { id, kind, filename, content_hash: hash, schema_version: schemaVersion, imported_at_utc: nowUtc(), raw_text: text, meta_json: meta ? JSON.stringify(meta) : null });
  return { id, duplicate: false };
}

function rirFields(raw, source) {
  const r = parseRir(raw);
  return {
    fields: { rir_raw: r?.raw ?? null, rir_min: r?.min ?? null, rir_max: r?.max ?? null, rir_approx: r?.approx ? 1 : 0, rir_source: r ? source : null },
    sides: r?.sides
      ? ['L', 'R'].filter((k) => r.sides[k]).map((k) => ({ side: k, reps: null, rir_raw: r.sides[k].raw, rir_min: r.sides[k].min, rir_max: r.sides[k].max, rir_approx: r.sides[k].approx ? 1 : 0 }))
      : [],
    unparsed: r?.unparsed,
  };
}

// ------------------------------------------------------------------ canonical JSON
export function importCanonical(db, { jsonText, filename = 'workout_history_and_logic.json', augustMdText = null, augustMdFilename = 'Jeremy_Workout_Training_Log_Aug2026.md' }) {
  const doc = JSON.parse(jsonText);
  const errors = validateCanonical(doc);
  if (errors.length) {
    const e = new Error(`Import validation failed:\n- ${errors.join('\n- ')}`);
    e.validation = errors;
    throw e;
  }

  return db.tx(() => {
    const meta = { completeness: doc.completeness, timezone: doc.timezone, subject: doc.subject, training_logic: doc.training_logic, source_inventory: doc.source_inventory, limitations: doc.limitations, profile_for_training: doc.profile_for_training, generated_date: doc.generated_date };
    const src = addSource(db, 'canonical_json', filename, jsonText, meta, doc.schema_version);
    const imp = new Importer(db, src.id);
    if (src.duplicate) {
      imp.issue('info', 'duplicate_source', 'This exact file was already imported; nothing new added.');
      return imp.report;
    }
    const p = doc.profile_for_training || {};
    ensureUser(db, { height_cm: p.height_cm_approx ?? null, height_is_approx: p.height_cm_approx ? 1 : 0, training_goal: p.training_goal ?? null, frequency_goal: p.training_frequency_goal_per_week ?? null });
    if (p.body_weight_kg_last_reported_approx) {
      imp.body(null, p.body_weight_kg_last_reported_approx, { approx: true, context: 'last reported (date not recorded)' });
    }

    let md = null;
    let mdSrc = null;
    if (augustMdText) {
      md = parseAugustMarkdown(augustMdText);
      mdSrc = addSource(db, 'august_markdown', augustMdFilename, augustMdText, { parsed_sessions: md.sessions.length });
      md.benchmarks.forEach((b) => db.run('INSERT OR IGNORE INTO benchmarks (id,source_id,position,label,benchmark,date_text,context) VALUES (?,?,?,?,?,?,?)',
        [stableId('bench', mdSrc.id, b.position), mdSrc.id, b.position, b.label, b.benchmark, b.date_text, b.context]));
      for (const bm of md.bodyMetrics) imp.body(bm.date_local, bm.weight_kg, { approx: false, context: bm.context, bodyFat: bm.body_fat_pct });
    }

    importAugust(imp, doc, md);
    importRecent(imp, doc);
    importPartial(imp, doc);
    crossCheckSetRows(imp, doc);
    return imp.report;
  });
}

function importAugust(imp, doc, md) {
  const { db } = imp;
  doc.original_august_sessions.forEach((s, si) => {
    const id = stableId('ses', 'aug', s.date, s.label);
    const notes = s.notes ?? [];
    const focus = notes.map(parseFocusNote).find(Boolean) ?? null;
    if (!imp.session({ id, date_local: s.date, label: s.label, focus, fidelity: s.fidelity ?? 'set_by_set', source_ref: `/original_august_sessions/${si}`, notes_json: JSON.stringify(notes) })) return;

    for (const n of notes) {
      const bw = parseBodyWeightNote(n);
      if (bw) {
        imp.body(s.date, bw.weight_kg, { context: bw.context });
        if (!bw.context) db.update('sessions', id, { body_weight_kg: bw.weight_kg });
        else imp.issue('info', 'body_weight_context', `Body weight ${bw.weight_kg} kg on ${s.date} was "${bw.context}" — kept as a metric, not used as the session's weight.`, 'sessions', id);
      }
      const c = parseCardioNote(n);
      if (c) imp.cardio(id, db.get('SELECT COUNT(*) n FROM cardio WHERE session_id=?', [id]).n, c);
    }

    const mdRows = md?.sessions.find((x) => x.date === s.date)?.rows ?? null;
    if (md && !mdRows) imp.issue('warning', 'md_session_missing', `August markdown has no table for ${s.date}`, 'sessions', id);
    if (mdRows && mdRows.length !== s.sets.length) imp.issue('warning', 'md_row_count', `August markdown has ${mdRows.length} rows for ${s.date}, JSON has ${s.sets.length}; RIR supplement skipped for this session`, 'sessions', id);

    let seIdx = -1;
    let cur = null;
    let pos = 0;
    s.sets.forEach((x, k) => {
      if (!cur || cur.key !== `${x.exercise}|${x.equipment}`) {
        seIdx++;
        const eq = parseEquipment(x.equipment);
        const basis = loadBasisFromDisplay(x.load_display, x.equipment);
        cur = { key: `${x.exercise}|${x.equipment}`, ...imp.exercise(id, seIdx, {
          name: x.exercise,
          equipment: eq,
          variation: '',
          laterality: basis === 'per_limb' ? 'unknown' : 'bilateral',
          load_basis: basis,
          raw: { exercise: x.exercise, equipment: x.equipment },
        }) };
        pos = 0;
      }
      const st = normalizeSetType(x.set_type);
      let rir = rirFields(x.rir, 'canonical_json');
      const mdRow = mdRows && mdRows.length === s.sets.length ? mdRows[k] : null;
      if (mdRow) {
        const same = mdRow.exercise === x.exercise && Number(String(mdRow.reps)) === x.reps && parseFloat(mdRow.load) === x.load_kg;
        if (!same) imp.issue('warning', 'md_row_mismatch', `August markdown row ${k + 1} on ${s.date} does not match JSON (${mdRow.exercise} ${mdRow.load} × ${mdRow.reps} vs ${x.exercise} ${x.load_kg} × ${x.reps})`, 'sessions', id);
        else if (x.rir === null && mdRow.rir) {
          rir = rirFields(mdRow.rir, 'august_markdown');
          imp.issue('info', 'rir_from_original_log', `${s.date} ${x.exercise} set ${pos + 1}: RIR "${mdRow.rir}" taken from the original August log (null in JSON).`, 'sets', stableId('set', cur.id, pos));
        } else if (x.rir !== null && mdRow.rir && parseRir(mdRow.rir)?.min !== x.rir) {
          imp.issue('warning', 'rir_conflict', `${s.date} ${x.exercise} set ${pos + 1}: JSON RIR ${x.rir} vs original log "${mdRow.rir}" — JSON kept.`, 'sets', stableId('set', cur.id, pos));
        }
      }
      const display = String(x.load_display ?? '');
      if (x.load_multiplier === 1 && /\/(leg|side|arm|hand)/i.test(display) && /both/i.test(x.notes ?? '')) {
        imp.issue('warning', 'load_multiplier_conflict', `${s.date} ${x.exercise} ${display}: note says "${x.notes}" but load_multiplier is 1. Kept as supplied (volume counts one side); fix it in the set editor if both legs should count.`, 'sets', stableId('set', cur.id, pos));
      }
      imp.set(cur.id, pos, {
        session_order: k,
        set_type: st.type,
        set_type_raw: x.set_type,
        set_subtype: st.subtype,
        load_kg: x.load_kg,
        load_display: x.load_display ?? null,
        load_multiplier: x.load_multiplier ?? null,
        reps: x.reps,
        partials: x.partials ?? null,
        ...rir.fields,
        rest_sec: x.rest_minutes !== null && x.rest_minutes !== undefined ? Math.round(x.rest_minutes * 60) : null,
        fidelity: 'reported',
        notes: x.notes || null,
      }, rir.sides);
      if (st.type === 'ambiguous') imp.issue('info', 'ambiguous_set_type', `${s.date} ${x.exercise} ${x.load_kg} kg × ${x.reps} is "${x.set_type}" — not counted as a working set.`, 'sets', stableId('set', cur.id, pos));
      pos++;
    });
  });
}

function importRecent(imp, doc) {
  const { db } = imp;
  doc.recent_detailed_sessions.forEach((s, si) => {
    const id = stableId('ses', 'recent', s.date, s.label);
    const notes = s.notes ?? [];
    const timing = notes.map((n) => parseTimingNote(n, s.date)).find(Boolean);
    const kcal = notes.map(parseReportedKcal).find(Boolean);
    if (!imp.session({
      id, date_local: s.date, label: s.label, fidelity: s.fidelity ?? 'set_by_set', source_ref: `/recent_detailed_sessions/${si}`,
      notes_json: JSON.stringify(notes),
      ...(timing ?? {}),
      reported_kcal_min: kcal?.min ?? null, reported_kcal_max: kcal?.max ?? null,
    })) return;

    const seByName = new Map();
    s.exercises.forEach((e, ei) => {
      const v = parseVariation(e.variation);
      const eq = parseEquipment(e.equipment_brand);
      if (v.load_type) eq.load_type = v.load_type;
      const anyDouble = e.sets.some((x) => x.load_multiplier === 2);
      const load_basis = v.load_basis ?? (anyDouble ? 'per_side' : 'total');
      const se = imp.exercise(id, ei, {
        name: e.exercise, equipment: eq, variation: v.variation, laterality: v.laterality ?? 'bilateral', load_basis,
        raw: { exercise: e.exercise, equipment: e.equipment_brand, variation: e.variation, notes: e.notes },
      });
      seByName.set(e.exercise.toLowerCase(), { se, e });
      e.sets.forEach((x, k) => {
        const st = normalizeSetType(x.set_type);
        const rir = rirFields(x.rir, 'canonical_json');
        if (rir.unparsed) imp.issue('warning', 'rir_unparsed', `Could not read RIR "${x.rir}" on ${s.date} ${e.exercise}; kept as text.`, 'sets', stableId('set', se.id, k));
        imp.set(se.id, k, {
          set_type: st.type, set_type_raw: x.set_type, set_subtype: st.subtype,
          load_kg: x.load_kg, load_display: null, load_multiplier: x.load_multiplier ?? null,
          reps: x.reps, partials: x.partials ?? null, ...rir.fields, fidelity: 'reported', notes: null,
        }, rir.sides);
      });
      if (v.raw && !v.variation && v.load_basis) {
        imp.issue('info', 'load_convention', `${s.date} ${e.exercise}: "${v.raw}" read as load convention (${v.load_basis.replace('_', ' ')}), not a separate variation.`, 'session_exercises', se.id);
      }
    });

    // Supersets: only what a note states explicitly.
    for (const { se, e } of seByName.values()) {
      const ss = parseSupersetNote(e.notes);
      if (!ss) continue;
      const partner = seByName.get(ss.partner.toLowerCase());
      if (!partner) {
        imp.issue('warning', 'superset_partner_missing', `${s.date} ${e.exercise}: superset partner "${ss.partner}" not found in session.`, 'session_exercises', se.id);
        continue;
      }
      db.update('session_exercises', se.id, { superset_group: 'A' });
      db.update('session_exercises', partner.se.id, { superset_group: 'A' });
      if (ss.pair) {
        const own = db.get('SELECT id FROM sets WHERE session_exercise_id=? AND load_kg=? ORDER BY position LIMIT 1', [se.id, ss.pair.ownLoad]);
        const other = db.get("SELECT id FROM sets WHERE session_exercise_id=? AND load_kg=? AND set_type='working' ORDER BY position LIMIT 1", [partner.se.id, ss.pair.partnerLoad]);
        if (own && other) {
          db.update('sets', own.id, { superset_pair_set_id: other.id });
          db.update('sets', other.id, { superset_pair_set_id: own.id });
        }
      }
      imp.issue('info', 'superset_from_note', `${s.date}: ${e.exercise} grouped as a superset with ${partner.e.exercise} from the note; other pairings are not inferred.`, 'session_exercises', se.id);
    }

    (s.cardio || []).forEach((c, k) => {
      const range = c.estimated_calories_kcal_range;
      imp.cardio(id, k, {
        type: c.type, equipment_brand: c.equipment_brand ?? null, duration_sec: c.duration_sec ?? c.duration_seconds ?? null,
        distance_km: c.distance_km ?? null, avg_speed_kmh: c.average_speed_kmh ?? null, incline_pct: c.incline_percent ?? null,
        elevation_gain_m: c.elevation_gain_m ?? null, avg_hr: c.average_heart_rate_bpm ?? null, max_hr: c.maximum_heart_rate_bpm ?? null,
        machine_kcal: c.machine_calories_kcal ?? null, handrail_support: c.handrail_support ?? null,
        reported_kcal_min: range?.[0] ?? null, reported_kcal_max: range?.[1] ?? null, fidelity: 'reported', raw_text: JSON.stringify(c),
      });
    });

    // Compare with any totals written in the notes.
    const claimed = notes.map(parseClaimedTotals).find(Boolean);
    if (claimed) {
      const sets = db.all(`SELECT st.* FROM sets st JOIN session_exercises se ON se.id=st.session_exercise_id WHERE se.session_id=?`, [id]);
      for (const st of sets) st.sides = db.all('SELECT * FROM set_sides WHERE set_id=?', [st.id]);
      const work = sets.filter(isWorking);
      const vol = round(work.reduce((a, x) => a + (setVolume(x) ?? 0), 0), 2);
      const ok = work.length === claimed.workingSets && Math.abs(vol - claimed.volumeKg) < 0.01;
      imp.issue(ok ? 'info' : 'warning', ok ? 'totals_match' : 'totals_differ',
        `${s.date}: notes say ${claimed.workingSets} working sets / ${claimed.volumeKg} kg; computed ${work.length} / ${vol} kg.`, 'sessions', id);
    }
    if (timing?.time_precision === 'approximate') imp.issue('info', 'approximate_time', `${s.date}: start/end times are approximate ("around").`, 'sessions', id);
  });
}

function importPartial(imp, doc) {
  const { db } = imp;
  doc.additional_partial_sessions.forEach((s, si) => {
    const id = stableId('ses', 'partial', s.date, s.label);
    if (!imp.session({ id, date_local: s.date, label: s.label, fidelity: s.fidelity ?? 'partial_reconstruction', source_ref: `/additional_partial_sessions/${si}`, notes_json: JSON.stringify(s.notes ?? []) })) return;
    let seIdx = 0;
    let carIdx = 0;
    (s.exercise_summaries || []).forEach((text, k) => {
      imp.report.partialLines++;
      const parsed = parsePartialSummary(text);
      db.insert('partial_summaries', { id: stableId('ps', id, k), session_id: id, position: k, text, parse_status: parsed ? 'parsed' : 'unparsed' });
      if (!parsed) {
        imp.issue('info', 'summary_unparsed', `${s.date}: "${text}" kept as text only (not converted to sets).`, 'sessions', id);
        return;
      }
      imp.report.parsedPartialLines++;
      if (parsed.kind === 'cardio') {
        imp.cardio(id, carIdx++, parsed.cardio);
        return;
      }
      const per = parsed.sets.find((x) => x.per)?.per ?? null;
      const se = imp.exercise(id, seIdx++, {
        name: parsed.exercise,
        equipment: { brand: parsed.brand ?? 'unspecified', description: '', load_type: 'unknown' },
        variation: '', laterality: 'bilateral', load_basis: !per ? 'total' : per === 'side' ? 'per_side' : 'per_limb',
        raw: { exercise: text },
      });
      parsed.sets.forEach((x, j) => imp.set(se.id, j, {
        set_type: 'unclassified', set_type_raw: null, load_kg: x.load_kg, load_display: x.per ? `${x.load_kg} kg/${x.per}` : `${x.load_kg} kg`,
        load_multiplier: x.per ? 2 : 1, reps: x.reps, rir_raw: null, rir_min: null, rir_max: null, rir_approx: 0,
        fidelity: 'reconstructed', notes: x.note,
      }));
    });
  });
}

// The flat set_rows table must agree with the nested sessions; it is never a
// second source of sets (that would double-count).
function crossCheckSetRows(imp, doc) {
  const key = (date, ex, type, load, reps, rir, mult) => [date, ex, String(type).toLowerCase(), load, reps, rir ?? '', mult].join('|');
  const nested = [];
  for (const s of doc.original_august_sessions) for (const x of s.sets) nested.push(key(s.date, x.exercise, x.set_type, x.load_kg, x.reps, x.rir, x.load_multiplier));
  for (const s of doc.recent_detailed_sessions) for (const e of s.exercises) for (const x of e.sets) nested.push(key(s.date, e.exercise, x.set_type, x.load_kg, x.reps, x.rir, x.load_multiplier));
  const flat = doc.set_rows.map((r) => key(r.date, r.exercise, r.set_type, r.load_kg, r.reps, r.rir, r.load_multiplier));
  const count = (arr) => arr.reduce((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map());
  const a = count(nested);
  const b = count(flat);
  let diffs = 0;
  for (const [k, n] of a) if (b.get(k) !== n) diffs++;
  for (const [k, n] of b) if (a.get(k) !== n) diffs++;
  if (diffs || nested.length !== flat.length) {
    imp.issue('warning', 'set_rows_mismatch', `set_rows (${flat.length}) and nested sessions (${nested.length}) disagree on ${diffs} row keys.`);
  } else {
    imp.issue('info', 'set_rows_match', `set_rows cross-check passed: ${flat.length} rows match the nested sessions (used for validation only, not imported twice).`);
  }
}

// ------------------------------------------------------------------ flat CSV (alternative)
export const CSV_COLUMNS = ['date', 'session', 'exercise', 'brand_or_variation', 'set_number', 'set_type', 'load_kg', 'load_display', 'reps', 'rir', 'load_multiplier', 'partials', 'notes', 'source_fidelity'];

export function validateCsv(rows) {
  const errors = [];
  const header = rows[0] ?? [];
  CSV_COLUMNS.forEach((c, i) => { if (header[i] !== c) errors.push(`column ${i + 1} should be "${c}" (found "${header[i] ?? ''}")`); });
  rows.slice(1).forEach((r, i) => {
    if (r.length !== CSV_COLUMNS.length) errors.push(`row ${i + 2}: expected ${CSV_COLUMNS.length} fields, found ${r.length}`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r[0] ?? '')) errors.push(`row ${i + 2}: bad date "${r[0]}"`);
    for (const [n, j] of [['load_kg', 6], ['reps', 8], ['load_multiplier', 10]]) {
      if (r[j] !== '' && r[j] !== undefined && Number.isNaN(Number(r[j]))) errors.push(`row ${i + 2}: ${n} "${r[j]}" is not a number`);
    }
  });
  return errors;
}

export function importFlatCsv(db, csvText, { filename = 'workout_sets.csv' } = {}) {
  const rows = parseCsv(csvText);
  const errors = validateCsv(rows);
  if (errors.length) {
    const e = new Error(`CSV validation failed:\n- ${errors.slice(0, 20).join('\n- ')}`);
    e.validation = errors;
    throw e;
  }
  return db.tx(() => {
    const src = addSource(db, 'flat_csv', filename, csvText);
    const imp = new Importer(db, src.id);
    if (src.duplicate) {
      imp.issue('info', 'duplicate_source', 'This exact file was already imported; nothing new added.');
      return imp.report;
    }
    ensureUser(db);
    const num = (v) => (v === '' || v === undefined ? null : Number(v));
    const groups = new Map();
    for (const r of rows.slice(1)) {
      const o = Object.fromEntries(CSV_COLUMNS.map((c, i) => [c, r[i]]));
      const k = `${o.date}|${o.session}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(o);
    }
    for (const [k, list] of groups) {
      const [date, label] = k.split('|');
      const dupe = db.get('SELECT id FROM sessions WHERE date_local=? AND label=? AND source_id<>?', [date, label, src.id]);
      if (dupe) {
        imp.issue('info', 'already_imported', `${date} "${label}" already exists from another source; CSV rows skipped to avoid double counting.`, 'sessions', dupe.id);
        imp.report.skippedSessions++;
        continue;
      }
      const id = stableId('ses', 'csv', date, label);
      const fidelity = list[0].source_fidelity === 'original_august_log' ? 'set_by_set' : list[0].source_fidelity;
      if (!imp.session({ id, date_local: date, label, fidelity, source_ref: `csv:${date}`, notes_json: '[]' })) continue;
      let cur = null;
      let seIdx = -1;
      let pos = 0;
      list.forEach((o, n) => {
        if (!cur || cur.key !== `${o.exercise}|${o.brand_or_variation}`) {
          seIdx++;
          let eq;
          let v = { variation: '', load_basis: null, laterality: null };
          if (o.source_fidelity === 'original_august_log') eq = parseEquipment(o.brand_or_variation);
          else {
            const [brand, variation] = o.brand_or_variation.split(' | ');
            eq = parseEquipment(brand);
            v = parseVariation(variation);
            if (v.load_type) eq.load_type = v.load_type;
          }
          const basis = v.load_basis ?? (o.source_fidelity === 'original_august_log' ? loadBasisFromDisplay(o.load_display, o.brand_or_variation) : (num(o.load_multiplier) === 2 ? 'per_side' : 'total'));
          cur = { key: `${o.exercise}|${o.brand_or_variation}`, ...imp.exercise(id, seIdx, { name: o.exercise, equipment: eq, variation: v.variation, laterality: v.laterality ?? 'bilateral', load_basis: basis, raw: { exercise: o.exercise, equipment: o.brand_or_variation } }) };
          pos = 0;
        }
        const st = normalizeSetType(o.set_type);
        const rir = rirFields(o.rir === '' ? null : (/^\d+$/.test(o.rir) ? Number(o.rir) : o.rir), 'flat_csv');
        imp.set(cur.id, pos++, {
          session_order: n, set_type: st.type, set_type_raw: o.set_type, set_subtype: st.subtype,
          load_kg: num(o.load_kg), load_display: o.load_display || null, load_multiplier: num(o.load_multiplier),
          reps: num(o.reps), partials: num(o.partials), ...rir.fields, fidelity: 'reported', notes: o.notes || null,
        }, rir.sides);
      });
    }
    imp.issue('info', 'csv_limits', 'The flat CSV carries no cardio, timing or session notes; import the canonical JSON for those.');
    return imp.report;
  });
}

