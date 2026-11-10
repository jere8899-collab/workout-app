// Live workout screen: a table of set rows per exercise. A row is a saved draft
// until its tick is pressed; only then does it become a set.
import { h, sheet, toast } from './ui.js';
import * as repo from '../lib/db/repo.js';
import { recommendNextSet, repRangeFor, inferIncrement } from '../lib/domain/recommend.js';
import { previousForRows, targetsForRows } from '../lib/domain/rows.js';
import { livePRs } from '../lib/domain/pr.js';
import { isWorking, effectiveReps } from '../lib/domain/sets.js';
import { formatRir } from '../lib/domain/rir.js';
import { addExerciseSheet, cardioSheet, editSessionSheet, editSetSheet } from './sheets.js';
import { summarizeSession } from '../lib/domain/summary.js';
import { cardioBlock } from './summary.js';
import { openPad, closePad } from './pad.js';
import { startRest, stopRest } from './status.js';

const ACTION_LABEL = { increase: 'Add load', hold: 'Hold load', add_reps: 'Add reps', reduce: 'Reduce load', calibrate: 'Calibrate' };
const TYPE_OPTIONS = [
  ['warmup', null, 'W', 'Warm-up', 'Not counted'],
  ['working', null, null, 'Working', 'Counted'],
  ['calibration', null, 'C', 'Calibration', 'Finding your load, not counted'],
  ['working', 'failure', 'F', 'Failure', 'Counted, no reps left'],
  ['working', 'drop', 'D', 'Drop set', 'Counted, reduced load'],
];
const brandLine = (e) => [e.brand !== 'unspecified' ? e.brand : 'brand unspecified', e.equipment_description, e.variation].filter(Boolean).join(' · ');
const repsFields = (d) => (d.per_side ? ['load_kg', 'left_reps', 'left_rir', 'right_reps', 'right_rir'] : ['load_kg', 'reps', 'rir']);

export function renderLive(app, g) {
  const sid = g.session.id;
  const views = g.exercises.map((e) => exerciseView(app, g, e));
  const groups = [];
  for (const v of views) {
    const last = groups[groups.length - 1];
    if (v.e.superset_group && last && last.group === v.e.superset_group) last.items.push(v);
    else groups.push({ group: v.e.superset_group, items: [v] });
  }
  const sum = summarizeSession(g, { bodyKg: repo.latestBodyWeight(app.db, g.session.date_local) });
  const finish = () => finishPrompt(app, sid);

  return h('div', { class: 'stack' },
    h('header', { class: 'row between' },
      h('button', { class: 'title-btn', onclick: () => editSessionSheet(app, g) }, g.session.label || 'Workout', h('span', { class: 'muted small', 'aria-hidden': 'true' }, ' ✎')),
      h('button', { class: 'btn small primary', onclick: finish }, 'Finish')),
    ...groups.map((grp) => (grp.group && grp.items.length > 1
      ? h('section', { class: 'superset' },
        h('div', { class: 'superset-tag' }, `Superset ${grp.group}`, h('span', { class: 'muted small' }, ' · alternate sets, rest after the round')),
        ...grp.items.map((v) => exerciseCard(app, g, v, grp)))
      : exerciseCard(app, g, grp.items[0], null))),
    !views.length && h('div', { class: 'card empty' }, h('p', {}, 'No exercises yet.'), h('p', { class: 'muted small' }, 'Add one, or start a plan day from Today.')),
    g.cardio.length > 0 && h('section', { class: 'card' }, h('h3', {}, 'Cardio'), ...sum.cardio.map((c) => cardioBlock(app, c, true))),
    h('div', { class: 'row gap wrap' },
      h('button', { class: 'btn grow', onclick: () => addExerciseSheet(app, sid) }, '+ Exercise'),
      h('button', { class: 'btn grow', onclick: () => cardioSheet(app, sid) }, '+ Cardio')),
    h('button', { class: 'btn primary block', onclick: finish }, 'Finish workout'));
}

// ------------------------------------------------------------ data for one exercise
function targetFor(e) {
  if (!e.planned.length) return null;
  const p = e.planned[0];
  return { rep_min: p.rep_min, rep_max: p.rep_max, rir_min: p.rir_min, rir_max: p.rir_max, target_sets: e.planned.length };
}

function otherMachines(app, e) {
  const { db } = app;
  return repo.listVariants(db).filter((v) => v.exercise_name === e.exercise_name && v.id !== e.variant_id && v.working_sets > 0).map((v) => {
    const hist = repo.variantHistory(db, v.id).filter((x) => x.session.fidelity !== 'partial_reconstruction');
    const last = hist[hist.length - 1];
    const top = last?.sets.filter(isWorking).sort((a, b) => b.load_kg - a.load_kg)[0];
    return { label: v.label, summary: top ? `${top.load_kg} kg × ${effectiveReps(top)} on ${last.session.date_local}` : 'no confirmed sets' };
  });
}

function exerciseView(app, g, e) {
  const { db } = app;
  const history = repo.variantHistory(db, e.variant_id, { excludeSessionId: g.session.id });
  const input = {
    variant: e, exercise: { category: e.category }, equipment: { increment_kg: e.increment_kg, load_type: e.load_type },
    history, currentSets: e.sets, target: targetFor(e),
  };
  let rec = recommendNextSet(input);
  if (rec.action === 'calibrate') rec = recommendNextSet({ ...input, otherVariants: otherMachines(app, e) });

  const before = repo.listDrafts(db, e.id);
  const prevAll = previousForRows([...e.sets, ...before], history);
  const prevDrafts = prevAll.slice(e.sets.length);
  repo.refreshDraftTargets(db, e.id, targetsForRows({ rows: before, rec, previous: prevDrafts }));
  const drafts = repo.listDrafts(db, e.id);

  const records = history.filter((h) => h.session.fidelity !== 'partial_reconstruction').flatMap((h) => h.sets);
  // A first session on a machine sets the baseline; it has nothing to beat yet.
  const prs = new Map(e.sets.map((s) => [s.id, records.length ? livePRs(s, [...records, ...e.sets.filter((x) => x.session_order < s.session_order)]) : []]));
  return { e, rec, drafts, history, prs, prevSets: prevAll.slice(0, e.sets.length), prevDrafts };
}

// ------------------------------------------------------------ card
function exerciseCard(app, g, v, grp) {
  const { e, rec, drafts, prs } = v;
  const t = targetFor(e);
  const working = e.sets.filter(isWorking).length;
  const [rmin, rmax] = repRangeFor(e, { category: e.category }, t);
  const unit = app.fmtLoad(0, e.load_basis, e.exercise_name).replace(/^0 /, '');
  let number = 0;
  const label = (type, subtype) => {
    const opt = TYPE_OPTIONS.find(([ty, su]) => ty === type && (su ?? null) === (subtype ?? null));
    if (opt?.[2]) return opt[2];
    if (type !== 'working') return '?';
    number += 1;
    return String(number);
  };
  const body = h('div', { class: 'set-table' },
    h('div', { class: 'set-head', 'aria-hidden': 'true' },
      h('span', {}, 'Set'), h('span', {}, 'Previous'), h('span', {}, unit), h('span', {}, 'Reps'), h('span', {}, 'RIR'), h('span', {}, '✓')),
    ...e.sets.map((s, i) => doneRow(app, g, e, s, label(s.set_type, s.set_subtype), v.prevSets[i], prs.get(s.id) ?? [])),
    ...drafts.map((d, i) => draftRow(app, g, v, d, label(d.set_type, d.set_subtype), v.prevDrafts[i], grp)));

  return h('section', { class: 'card ex-card', id: `se-${e.id}` },
    h('div', { class: 'ex-head' },
      h('div', { class: 'grow' }, h('div', { class: 'ex-name' }, e.exercise_name), h('div', { class: 'muted small' }, brandLine(e))),
      h('div', { class: 'ex-count', 'aria-label': `${working} working sets logged` }, t ? `${working}/${t.target_sets}` : working),
      h('button', { class: 'icon-btn', 'aria-label': `${e.exercise_name} options`, onclick: () => exerciseMenu(app, g, e) }, '⋯')),
    h('details', { class: 'rec' },
      h('summary', {}, h('strong', {}, ACTION_LABEL[rec.action]), ' ',
        rec.load_kg !== null ? `${app.fmtLoad(rec.load_kg, e.load_basis, e.exercise_name)} × ${rec.rep_min}–${rec.rep_max}` : `aim ${rmin}–${rmax} reps`,
        ` @ RIR ${formatRir(rec.rir_min, rec.rir_max)}`),
      h('p', { class: 'small' }, rec.rationale),
      ...rec.alternatives.map((a) => h('p', { class: 'small muted' }, a)),
      h('p', { class: 'tiny muted' }, `Increment: ${rec.increment.kg} kg, ${rec.increment.source}. A suggestion only; log what you actually did.`)),
    body,
    h('div', { class: 'row gap-s' },
      h('button', { class: 'btn small grow', onclick: () => addRow(app, e, drafts) }, '+ Add set'),
      h('button', { class: 'btn small grow', onclick: () => { repo.addDraft(app.db, e.id, { set_type: 'warmup', per_side: e.laterality === 'unilateral' ? 1 : 0 }, { before: true }); app.render(); } }, '+ Add warm-up')));
}

function addRow(app, e, drafts) {
  const last = drafts[drafts.length - 1] ?? e.sets[e.sets.length - 1];
  repo.addDraft(app.db, e.id, {
    set_type: 'working',
    load_kg: last?.load_kg ?? null,
    reps: last?.reps ?? null,
    per_side: last ? (last.per_side ?? (last.sides?.length ? 1 : 0)) : (e.laterality === 'unilateral' ? 1 : 0),
  });
  app.render();
}

function prevText(app, p, side) {
  if (!p) return '';
  const sd = side ? p.sides?.find((x) => x.side === side) : null;
  if (side && !sd) return '';
  const reps = sd?.reps ?? p.reps ?? '?';
  const rir = side ? sd?.rir_raw : (p.sides?.length ? null : p.rir_raw);
  return [`${app.fmtDisplay(p.load_kg)}×${reps}`, rir ? h('span', { class: 'prev-rir' }, ` @${rir}`) : null];
}

const marker = (text, onclick, name) => h('button', { type: 'button', class: `marker m-${text.length === 1 && /[WCFD?]/.test(text) ? text.toLowerCase() : 'n'}`, 'aria-label': name, onclick }, text);

// ------------------------------------------------------------ confirmed row
function doneRow(app, g, e, s, mark, prev, prs) {
  const open = () => typeMenu(app, g, e, { set: s });
  const undo = () => { undoSet(app, s.id); };
  const load = app.fmtDisplay(s.load_kg);
  const sided = s.sides.length > 0;
  const lines = sided
    ? s.sides.map((x) => [x.side, prevText(app, prev, x.side), x.reps ?? s.reps, x.rir_raw])
    : [[null, prevText(app, prev), s.reps, s.rir_raw]];
  return h('div', { class: 'set-group' },
    h('div', { class: `set-row done ${sided ? 'sided' : ''}` },
      marker(mark, open, `Set ${mark}, change type or edit`),
      lines.map(([side, p, reps, rir], i) => [
        h('span', { class: 'prev', style: { gridRow: i + 1, gridColumn: 2 } }, side ? `${side} ` : '', p),
        i === 0 ? h('span', { class: 'val', style: { gridRow: `1 / span ${lines.length}`, gridColumn: 3 } }, load) : null,
        h('span', { class: 'val', style: { gridRow: i + 1, gridColumn: 4 } }, reps ?? '–'),
        h('span', { class: 'val', style: { gridRow: i + 1, gridColumn: 5 } }, rir ?? '–'),
      ]),
      h('button', { type: 'button', class: 'tick on', 'aria-label': `Undo set ${mark}`, 'aria-pressed': 'true', onclick: undo }, '✓')),
    prs.length > 0 && h('div', { class: 'pr-note' }, h('span', { class: 'pr-tag' }, 'PR'), ' ',
      prs.map((p) => (p.kind === 'load' ? `Heaviest yet (was ${app.fmtDisplay(p.beat)} ${app.units})`
        : p.kind === 'reps' ? `Most reps at this weight (was ${p.beat})`
          : `Best set volume (was ${app.fmtVol(p.beat)})`)).join(' · ')));
}

function undoSet(app, setId) {
  closePad();
  repo.unconfirmSet(app.db, setId, 'undo');
  if (app.timer?.setId === setId) stopRest();
  app.render();
}

// ------------------------------------------------------------ unconfirmed row
function draftRow(app, g, v, d, mark, prev, grp) {
  const { e, rec, history } = v;
  const cells = {};
  const inc = inferIncrement(history, { increment_kg: e.increment_kg, load_type: e.load_type });
  const stateOf = (field) => (d[field] === null || d[field] === undefined ? 'empty' : d.touched.includes(field) ? 'typed' : 'target');

  const FIELD = {
    load_kg: { title: `Weight, set ${mark}`, mode: 'decimal' },
    reps: { title: `Reps, set ${mark}`, mode: 'int' },
    rir: { title: `RIR, set ${mark}`, mode: 'rir' },
    left_reps: { title: `Left reps, set ${mark}`, mode: 'int' },
    left_rir: { title: `Left RIR, set ${mark}`, mode: 'rir' },
    right_reps: { title: `Right reps, set ${mark}`, mode: 'int' },
    right_rir: { title: `Right RIR, set ${mark}`, mode: 'rir' },
  };
  const shown = (field) => {
    const val = d[field];
    if (val === null || val === undefined) return field.endsWith('rir') ? '–' : '';
    return field === 'load_kg' ? app.fmtDisplay(val) : String(val);
  };
  const open = (field) => {
    const f = FIELD[field];
    const order = repsFields(d);
    const at = order.indexOf(field);
    const nextField = order[at + 1];
    const isLoad = field === 'load_kg';
    openPad({
      title: f.title,
      mode: f.mode,
      value: isLoad && d.load_kg !== null ? app.toDisplay(d.load_kg) : d[field],
      step: isLoad ? app.toDisplay(inc.kg) : 1,
      unit: isLoad ? app.units : '',
      anchor: cells[field],
      nextLabel: nextField ? 'Next' : 'Done',
      onChange: (val) => {
        d[field] = isLoad && val !== null ? app.fromDisplay(val) : val;
        repo.saveDraft(app.db, d.id, { [field]: d[field] });
        cells[field].textContent = shown(field);
        cells[field].className = `cell typed active`;
        if (!d.touched.includes(field)) d.touched.push(field);
      },
      onNext: () => { closePad(); if (nextField) open(nextField); },
    });
  };
  const cell = (field, col, row, span = 1) => {
    cells[field] = h('button', {
      type: 'button',
      class: `cell ${stateOf(field)}`,
      style: { gridColumn: col, gridRow: span > 1 ? `${row} / span ${span}` : row },
      'aria-label': FIELD[field].title,
      onclick: () => open(field),
    }, shown(field));
    return cells[field];
  };
  const tick = h('button', { type: 'button', class: 'tick', 'aria-label': `Log set ${mark}`, onclick: () => confirm(app, g, e, grp, d.id, rec) }, '✓');
  const openMenu = () => typeMenu(app, g, e, { draft: d });

  if (d.per_side) {
    return h('div', { class: 'set-group' },
      h('div', { class: `set-row sided t-${d.set_type}` },
        marker(mark, openMenu, `Set ${mark}, change type`),
        h('span', { class: 'prev', style: { gridRow: 1, gridColumn: 2 } }, 'L ', prevText(app, prev, 'L')),
        h('span', { class: 'prev', style: { gridRow: 2, gridColumn: 2 } }, 'R ', prevText(app, prev, 'R')),
        cell('load_kg', 3, 1, 2), cell('left_reps', 4, 1), cell('left_rir', 5, 1), cell('right_reps', 4, 2), cell('right_rir', 5, 2),
        tick));
  }
  return h('div', { class: 'set-group' },
    h('div', { class: `set-row t-${d.set_type}` },
      marker(mark, openMenu, `Set ${mark}, change type`),
      h('span', { class: 'prev', style: { gridColumn: 2 } }, prevText(app, prev)),
      cell('load_kg', 3, 1), cell('reps', 4, 1), cell('rir', 5, 1), tick));
}

function confirm(app, g, e, grp, draftId, rec) {
  const { db } = app;
  closePad();
  const d = repo.listDrafts(db, e.id).find((x) => x.id === draftId);
  if (!d) return;
  const missing = repo.validateDraft(d);
  if (missing) { toast(missing); return; }
  const set = repo.confirmDraft(db, draftId, { recommendation: d.set_type === 'working' ? rec : null });
  if (!set) return;
  const restFor = (x) => x.target_rest_sec ?? x.variant_rest_sec ?? app.restFor(x.category);
  let scrollTo = null;
  if (grp && grp.items.length > 1) {
    const i = grp.items.findIndex((x) => x.e.id === e.id);
    if (i < grp.items.length - 1) scrollTo = grp.items[i + 1].e;
    else startRest(Math.max(...grp.items.map((x) => restFor(x.e))), `After superset ${grp.group}`, set.id);
  } else {
    startRest(restFor(e), e.exercise_name, set.id);
  }
  app.render();
  if (scrollTo) document.getElementById(`se-${scrollTo.id}`)?.scrollIntoView({ block: 'start' });
  toast(scrollTo ? `Now: ${scrollTo.exercise_name}` : 'Set logged', { action: 'Undo', onAction: () => undoSet(app, set.id), ms: 3000 });
}

// ------------------------------------------------------------ menus
function typeMenu(app, g, e, { draft, set }) {
  const { db } = app;
  let ref;
  const current = draft ?? set;
  const choose = (type, subtype) => {
    if (draft) {
      const patch = { set_type: type, set_subtype: subtype };
      if (subtype === 'failure') Object.assign(patch, draft.per_side ? { left_rir: '0', right_rir: '0' } : { rir: '0' });
      repo.saveDraft(db, draft.id, patch);
    } else {
      repo.updateSet(db, set.id, { set_type: type, set_subtype: subtype, set_type_raw: subtype ?? type }, 'changed set type');
    }
    ref.close();
    app.render();
  };
  const body = h('div', { class: 'stack-s' },
    ...TYPE_OPTIONS.map(([type, subtype, , name, hint]) => h('button', {
      class: `list-row ${current.set_type === type && (current.set_subtype ?? null) === subtype ? 'selected' : ''}`,
      onclick: () => choose(type, subtype),
    }, h('div', { class: 'grow' }, h('div', { class: 'row-title' }, name), h('div', { class: 'muted small' }, hint)))),
    draft && h('button', { class: 'btn block', onclick: () => {
      const on = draft.per_side ? 0 : 1;
      repo.saveDraft(db, draft.id, on
        ? { per_side: 1, left_reps: draft.reps, right_reps: draft.reps, left_rir: draft.rir, right_rir: draft.rir }
        : { per_side: 0, reps: draft.left_reps ?? draft.right_reps, rir: draft.left_rir ?? draft.right_rir });
      ref.close();
      app.render();
    } }, draft.per_side ? 'Use shared reps' : 'Log left and right separately'),
    draft && h('button', { class: 'btn block danger', onclick: () => { repo.removeDraft(db, draft.id); ref.close(); app.render(); } }, 'Remove row'),
    set && h('button', { class: 'btn block', onclick: () => { ref.close(); editSetSheet(app, e, set); } }, 'Edit details'));
  ref = sheet(draft ? 'Set type' : 'Logged set', body);
}

function nextLetter(g) {
  const used = new Set(g.exercises.map((x) => x.superset_group).filter(Boolean));
  return 'ABCDEFGH'.split('').find((l) => !used.has(l));
}

function supersetToggle(app, g, e) {
  const { db } = app;
  if (e.superset_group) {
    repo.updateSessionExercise(db, e.id, { superset_group: null }, 'leave superset');
    return;
  }
  const prev = g.exercises[g.exercises.findIndex((x) => x.id === e.id) - 1];
  if (!prev) { toast('Supersets pair with the exercise above.'); return; }
  const letter = prev.superset_group ?? nextLetter(g);
  if (!prev.superset_group) repo.updateSessionExercise(db, prev.id, { superset_group: letter }, 'superset');
  repo.updateSessionExercise(db, e.id, { superset_group: letter }, 'superset');
}

function exerciseMenu(app, g, e) {
  let ref;
  const body = h('div', { class: 'stack-s' },
    h('a', { class: 'btn block', href: `#/exercise/${e.variant_id}`, onclick: () => ref.close() }, 'History and PRs'),
    h('button', { class: 'btn block', onclick: () => { supersetToggle(app, g, e); ref.close(); app.render(); } }, e.superset_group ? `Leave superset ${e.superset_group}` : 'Superset with the exercise above'),
    !e.sets.length && h('button', { class: 'btn block danger', onclick: () => { repo.removeSessionExercise(app.db, e.id); ref.close(); app.render(); } }, 'Remove exercise'));
  ref = sheet(e.exercise_name, body);
}

function finishPrompt(app, sid) {
  const { db } = app;
  closePad();
  const c = repo.finishCheck(db, sid);
  let ref;
  const done = () => { ref.close(); stopRest(); repo.finishSession(db, sid); app.go(`#/session/${sid}`); };
  const keep = h('button', { class: 'btn block', onclick: () => ref.close() }, 'Keep logging');
  if (!c.confirmedSets && !c.cardio) {
    ref = sheet('Nothing logged yet', h('div', { class: 'stack' },
      h('p', {}, 'No sets have been ticked, so there is nothing to save.'),
      keep,
      h('button', { class: 'btn block danger', onclick: () => { ref.close(); stopRest(); repo.deleteSession(db, sid, 'discarded empty workout'); app.go('#/today'); } }, 'Discard workout')));
    return;
  }
  const left = c.unlogged.reduce((a, x) => a + x.count, 0);
  ref = sheet(left ? `${left} set${left === 1 ? '' : 's'} not logged` : 'Finish workout?', h('div', { class: 'stack' },
    left > 0 && h('ul', { class: 'plain small' }, ...c.unlogged.map((x) => h('li', {}, `${x.label}: ${x.count} not ticked`))),
    left > 0 && h('p', { class: 'small muted' }, 'Only ticked sets are saved.'),
    keep,
    h('button', { class: 'btn block primary', onclick: done }, left ? 'Finish anyway' : 'Finish')));
}
