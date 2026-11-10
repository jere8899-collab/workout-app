// Bottom sheets shared by the logger and the summary.
import { h, sheet, toast, confirmSheet, field, numInput, numVal, segmented } from './ui.js';
import * as repo from '../lib/db/repo.js';
import { formatSgtTime, sgtToUtc, utcToSgtDate } from '../lib/domain/time.js';
import { KNOWN_BRANDS } from '../lib/catalog.js';
import { libraryRows, libraryPickSheet } from './library.js';

export const TYPE_LABEL = { warmup: 'Warm-up', working: 'Working', calibration: 'Calibration', ambiguous: 'Ramp-up/working (unclear)', unclassified: 'Unclassified' };

export function editSetSheet(app, e, s) {
  const { db } = app;
  const typeSel = h('select', {}, ...Object.entries(TYPE_LABEL).map(([v, l]) => h('option', { value: v, selected: v === s.set_type }, l)));
  const load = numInput(s.load_kg);
  const mult = h('select', {}, h('option', { value: '1', selected: s.load_multiplier !== 2 }, '× 1 — stack total / single load'), h('option', { value: '2', selected: s.load_multiplier === 2 }, '× 2 — per side / per arm'));
  const reps = numInput(s.reps, { step: 1, inputmode: 'numeric' });
  const partials = numInput(s.partials, { step: 1, inputmode: 'numeric' });
  const rir = h('input', { type: 'text', value: s.sides.length ? '' : (s.rir_raw ?? ''), placeholder: 'e.g. 2, 1–2, 3+, ~1 (blank = not reported)' });
  const sideIn = ['L', 'R'].map((k) => {
    const sd = s.sides.find((x) => x.side === k);
    return { k, reps: numInput(sd?.reps, { step: 1, inputmode: 'numeric', placeholder: 'same as set' }), rir: h('input', { type: 'text', value: sd?.rir_raw ?? '', placeholder: 'RIR' }) };
  });
  const tech = h('select', {}, ...[['', 'not noted'], ['good', 'good'], ['degraded', 'degraded']].map(([v, l]) => h('option', { value: v, selected: (s.technique ?? '') === v }, l)));
  const notes = h('textarea', { rows: 2 }, s.notes ?? '');
  const reason = h('input', { type: 'text', placeholder: 'Why the change? (kept in edit history)' });
  const provenance = [
    s.fidelity === 'reconstructed' ? 'Reconstructed from a partial summary' : s.fidelity === 'reported' ? 'Imported from your history' : 'Logged live',
    s.set_type_raw && s.set_type_raw !== s.set_type ? `original type "${s.set_type_raw}"` : null,
    s.rir_source ? `RIR source: ${s.rir_source.replace('_', ' ')}` : null,
    s.load_display ? `original load text "${s.load_display}"` : null,
  ].filter(Boolean).join(' · ');
  let ref;
  const body = h('div', { class: 'stack' },
    h('p', { class: 'muted small' }, provenance),
    s.notes && h('p', { class: 'small' }, `Note: ${s.notes}`),
    field('Set type', typeSel),
    h('div', { class: 'grid2' }, field('Load (kg)', load), field('Load counts', mult)),
    h('div', { class: 'grid2' }, field('Reps', reps), field('Partial reps', partials)),
    field('RIR', rir, s.sides.length ? 'Per-side RIR below' : null),
    h('fieldset', { class: 'fs' }, h('legend', {}, 'Per side (leave blank if not separate)'),
      ...sideIn.map((x) => h('div', { class: 'grid2' }, field(`${x.k === 'L' ? 'Left' : 'Right'} reps`, x.reps), field(`${x.k === 'L' ? 'Left' : 'Right'} RIR`, x.rir)))),
    field('Technique', tech),
    field('Notes', notes),
    field('Reason', reason),
    h('div', { class: 'row gap wrap' },
      s.deleted
        ? h('button', { class: 'btn', onclick: () => { repo.restoreSet(db, s.id, reason.value || 'restore'); ref.close(); app.render(); } }, 'Restore set')
        : h('button', { class: 'btn danger', onclick: () => { repo.deleteSet(db, s.id, reason.value || 'deleted'); ref.close(); app.render(); toast('Set removed', { action: 'Undo', onAction: () => { repo.restoreSet(db, s.id, 'undo'); app.render(); } }); } }, 'Delete'),
      h('button', { class: 'btn primary grow', onclick: () => {
        const sidesData = sideIn.filter((x) => x.reps.value !== '' || x.rir.value.trim() !== '').map((x) => ({ side: x.k, reps: numVal(x.reps), rir: x.rir.value.trim() || null }));
        const input = {
          set_type: typeSel.value, load_kg: numVal(load), load_multiplier: Number(mult.value), reps: numVal(reps), partials: numVal(partials),
          technique: tech.value || null, notes: notes.value.trim() || null, sides: sidesData,
        };
        if (!sidesData.length) input.rir = rir.value.trim() || null;
        repo.updateSet(db, s.id, input, reason.value.trim() || 'correction');
        ref.close();
        app.render();
        toast('Set updated — previous values kept in edit history.');
      } }, 'Save')));
  ref = sheet(`${e.exercise_name} · set ${s.position + 1}`, body);
}

// Own machines matching a search, most recently used first.
function ownMatches(all, term) {
  return all.filter((v) => !term || v.label.toLowerCase().includes(term))
    .sort((a, b) => (b.last_date ?? '').localeCompare(a.last_date ?? ''));
}

function ownRow(v, onPick) {
  return h('button', { class: 'list-row', onclick: () => onPick(v.id) },
    h('div', { class: 'grow' }, h('div', { class: 'row-title' }, v.exercise_name), h('div', { class: 'muted small' }, [v.brand !== 'unspecified' ? v.brand : 'brand unspecified', v.equipment_description, v.variation].filter(Boolean).join(' · '))),
    h('div', { class: 'muted tiny' }, v.last_date ? `last ${v.last_date}` : 'never'));
}

// Joins the previous exercise's superset group, creating a letter if it has none.
function supersetWithPrevious(db, sessionId) {
  const g = repo.getSessionGraph(db, sessionId);
  const prev = g.exercises[g.exercises.length - 1];
  if (!prev) return null;
  if (prev.superset_group) return prev.superset_group;
  const used = new Set(g.exercises.map((x) => x.superset_group).filter(Boolean));
  const group = 'ABCDEFGH'.split('').find((l) => !used.has(l));
  repo.updateSessionExercise(db, prev.id, { superset_group: group }, 'superset');
  return group;
}

export function addExerciseSheet(app, sessionId, { onPick } = {}) {
  const { db } = app;
  const all = repo.listVariants(db);
  const q = h('input', { type: 'search', placeholder: 'Search exercise or machine', 'aria-label': 'Search' });
  const list = h('div', { class: 'pick-list' });
  const ss = h('label', { class: 'switch' }, h('input', { type: 'checkbox' }), h('span', {}, 'Superset with the previous exercise'));
  let ref;
  const pick = (variantId) => {
    if (onPick) { onPick(variantId); ref.close(); return; }
    const group = ss.querySelector('input').checked ? supersetWithPrevious(db, sessionId) : null;
    repo.addSessionExercise(db, sessionId, variantId, { superset_group: group });
    ref.close();
    app.render();
  };
  const onEntry = (entry) => {
    ref.close();
    if (entry.load === 'cardio') cardioSheet(app, sessionId, null, { type: entry.cardioType });
    else libraryPickSheet(app, entry, { onCreated: pick });
  };
  const draw = () => {
    const term = q.value.trim().toLowerCase();
    const own = ownMatches(all, term).slice(0, 60).map((v) => ownRow(v, pick));
    const lib = libraryRows(app, term, { planMode: !!onPick, onEntry });
    list.replaceChildren(...(own.length && lib.length ? [h('h3', { class: 'pick-head' }, 'Your machines'), ...own] : own), ...lib);
  };
  q.addEventListener('input', draw);
  draw();
  const body = h('div', { class: 'stack' }, q, !onPick && ss, list,
    h('details', { class: 'card flat' }, h('summary', {}, 'New exercise or machine'), newVariantForm(app, (vid) => pick(vid))));
  ref = sheet(onPick ? 'Choose exercise' : 'Add exercise', body);
}

export function newVariantForm(app, onCreated) {
  const { db } = app;
  const exNames = db.all('SELECT name FROM exercises ORDER BY name').map((r) => r.name);
  const name = h('input', { type: 'text', list: 'ex-names', placeholder: 'e.g. Leg Extension' });
  const brand = h('input', { type: 'text', list: 'brand-names', placeholder: 'e.g. Precor (blank = unspecified)' });
  const desc = h('input', { type: 'text', placeholder: 'Model / description (optional)' });
  const variation = h('input', { type: 'text', placeholder: 'Variation, e.g. kneeling, unilateral, neutral grip' });
  const basis = h('select', {}, h('option', { value: 'total' }, 'Stack total / single load'), h('option', { value: 'per_side' }, 'Per side (plate-loaded, both sides together)'), h('option', { value: 'per_limb' }, 'Per arm / per leg'));
  const lat = h('select', {}, h('option', { value: 'bilateral' }, 'Both sides together'), h('option', { value: 'unilateral' }, 'One side at a time (log L/R)'));
  return h('div', { class: 'stack' },
    h('datalist', { id: 'ex-names' }, ...exNames.map((n) => h('option', { value: n }))),
    h('datalist', { id: 'brand-names' }, ...KNOWN_BRANDS.map((n) => h('option', { value: n }))),
    field('Exercise', name), field('Brand', brand), field('Machine', desc), field('Variation', variation),
    field('Weight entered as', basis), field('Sides', lat),
    h('p', { class: 'tiny muted' }, 'Different brand, machine or variation = separate baseline. Loads are never converted between machines.'),
    h('button', { class: 'btn primary', onclick: () => {
      if (!name.value.trim()) return toast('Name the exercise.');
      const ex = repo.findOrCreateExercise(db, name.value);
      const eq = repo.findOrCreateEquipment(db, { brand: brand.value, description: desc.value, load_type: basis.value === 'per_side' ? 'plate_loaded' : 'unknown' });
      const v = repo.findOrCreateVariant(db, { exercise_id: ex.id, equipment_id: eq.id, variation: variation.value, laterality: lat.value, load_basis: basis.value });
      onCreated(v.id);
    } }, 'Create & add'));
}

export function cardioSheet(app, sessionId, existing = null, preset = {}) {
  const { db } = app;
  const c = existing ?? preset;
  const type = h('select', {}, ...[['incline_treadmill', 'Incline treadmill'], ['treadmill', 'Treadmill'], ['bike', 'Bike'], ['elliptical', 'Elliptical'], ['stair_climber', 'Stair climber'], ['rower', 'Rower'], ['other', 'Other']]
    .map(([v, l]) => h('option', { value: v, selected: c.type === v }, l)));
  const brand = h('input', { type: 'text', list: 'brand-names2', value: c.equipment_brand ?? '' });
  const mm = numInput(c.duration_sec ? Math.floor(c.duration_sec / 60) : null, { step: 1, inputmode: 'numeric', placeholder: 'min' });
  const ss = numInput(c.duration_sec ? Math.round(c.duration_sec % 60) : null, { step: 1, inputmode: 'numeric', placeholder: 'sec' });
  const f = (v, ph) => numInput(v, { placeholder: ph });
  const dist = f(c.distance_km, 'km');
  const speed = f(c.avg_speed_kmh, 'km/h');
  const incline = f(c.incline_pct, '%');
  const elev = f(c.elevation_gain_m, 'm');
  const ahr = f(c.avg_hr, 'bpm');
  const mhr = f(c.max_hr, 'bpm');
  const kcal = f(c.machine_kcal, 'kcal');
  const rail = segmented([['none', 'None'], ['light', 'Light'], ['firm', 'Firm'], [null, 'Unknown']], c.handrail_support ?? null, null, 'Handrail support');
  let ref;
  const body = h('div', { class: 'stack' },
    h('datalist', { id: 'brand-names2' }, ...KNOWN_BRANDS.map((n) => h('option', { value: n }))),
    h('div', { class: 'grid2' }, field('Type', type), field('Brand', brand)),
    h('div', { class: 'grid2' }, field('Minutes', mm), field('Seconds', ss)),
    h('div', { class: 'grid2' }, field('Distance', dist), field('Avg speed', speed)),
    h('div', { class: 'grid2' }, field('Incline', incline), field('Elevation gain', elev)),
    h('div', { class: 'grid2' }, field('Avg HR', ahr), field('Max HR', mhr)),
    field('Machine calories', kcal, 'What the display said — kept separate from the app\'s estimate.'),
    field('Handrail support', rail, 'Holding the rails lowers the real energy cost.'),
    h('button', { class: 'btn primary block', onclick: () => {
      const dur = (numVal(mm) ?? 0) * 60 + (numVal(ss) ?? 0);
      const row = {
        type: type.value, equipment_brand: brand.value.trim() || null, duration_sec: dur || null, distance_km: numVal(dist), avg_speed_kmh: numVal(speed),
        incline_pct: numVal(incline), elevation_gain_m: numVal(elev), avg_hr: numVal(ahr), max_hr: numVal(mhr), machine_kcal: numVal(kcal), handrail_support: rail.get(),
      };
      if (existing) repo.updateCardio(db, existing.id, row, 'edit cardio');
      else repo.addCardio(db, sessionId, row);
      ref.close();
      app.render();
    } }, existing ? 'Save cardio' : 'Add cardio'),
    existing && h('button', { class: 'btn danger block', onclick: () => { repo.deleteCardio(db, existing.id, 'deleted'); ref.close(); app.render(); } }, 'Delete cardio'));
  ref = sheet(existing ? 'Edit cardio' : 'Add cardio', body);
}

export function editSessionSheet(app, g) {
  const { db } = app;
  const s = g.session;
  const label = h('input', { type: 'text', value: s.label ?? '' });
  const date = h('input', { type: 'date', value: s.date_local ?? '' });
  const start = h('input', { type: 'time', value: s.started_at_utc ? formatSgtTime(s.started_at_utc) : '' });
  const endDate = h('input', { type: 'date', value: s.ended_at_utc ? utcToSgtDate(s.ended_at_utc) : '' });
  const end = h('input', { type: 'time', value: s.ended_at_utc ? formatSgtTime(s.ended_at_utc) : '' });
  const bw = numInput(s.body_weight_kg, { placeholder: 'kg (optional)' });
  let ref;
  const body = h('div', { class: 'stack' },
    field('Name', label), field('Date (Singapore)', date),
    h('div', { class: 'grid2' }, field('Start time', start), field('End time', end)),
    field('End date', endDate, 'Set the next day if the session went past midnight.'),
    field('Body weight that day', bw),
    h('p', { class: 'tiny muted' }, `Times are Singapore time. Precision: ${s.time_precision}.`),
    h('button', { class: 'btn primary block', onclick: () => {
      const patch = { label: label.value.trim() || null, date_local: date.value || null, body_weight_kg: numVal(bw) };
      if (date.value && start.value) patch.started_at_utc = sgtToUtc(date.value, start.value);
      if (!start.value) patch.started_at_utc = null;
      if ((endDate.value || date.value) && end.value) patch.ended_at_utc = sgtToUtc(endDate.value || date.value, end.value);
      if (!end.value && s.status !== 'active') patch.ended_at_utc = null;
      if (start.value !== (s.started_at_utc ? formatSgtTime(s.started_at_utc) : '') || end.value !== (s.ended_at_utc ? formatSgtTime(s.ended_at_utc) : '')) {
        patch.time_precision = start.value && end.value ? 'exact' : 'unknown';
      }
      repo.updateSession(db, s.id, patch, 'edit session details');
      ref.close();
      app.render();
    } }, 'Save'),
    s.status === 'completed'
      ? h('button', { class: 'btn block', onclick: () => { repo.updateSession(db, s.id, { status: 'active' }, 'resume'); ref.close(); app.render(); } }, 'Resume logging this session')
      : null,
    h('button', { class: 'btn danger block', onclick: () => confirmSheet('Delete session?', 'It disappears from history; a full copy is kept in the edit history log.', 'Delete', () => {
      repo.deleteSession(db, s.id, 'deleted by user');
      ref.close();
      app.go('#/history');
    }, { danger: true }) }, 'Delete session'));
  ref = sheet('Session details', body);
}
