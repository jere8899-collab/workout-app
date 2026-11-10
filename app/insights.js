// Progress → Week, Month and Weight views. Everything is worked out from sets.
import { h, sheet, toast, field, numInput, numVal, lineChart, shortDate, longDate, confirmSheet } from './ui.js';
import * as repo from '../lib/db/repo.js';
import { MUSCLES, DEFAULT_TARGET } from '../lib/muscles.js';
import { weekStart, weekSummary, targetStatus, monthReport, monthName, addMonths } from '../lib/domain/insights.js';
import { addDays, todaySgt } from '../lib/domain/time.js';

const STATUS_WORD = { none: 'no sets', below: 'below target', within: 'on target', above: 'above target' };
const PERIOD_NOTE = {
  partial_only: 'Only partial notes for this week, so set counts are not available.',
  not_recorded: 'Nothing recorded for this week. That may mean a week off, or workouts that were not logged.',
};
const fmtSets = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
const targets = (db) => repo.getSetting(db, 'muscle_targets', {});
const targetFor = (db, m) => targets(db)[m] ?? DEFAULT_TARGET;

let weekOf = null;
let monthOf = null;

// ------------------------------------------------------------ week
export function renderWeek(app, { bodyMap }) {
  const { db } = app;
  weekOf ??= weekStart(todaySgt());
  const rows = repo.insightRows(db);
  const assignments = repo.getMuscles(db);
  const w = weekSummary({ rows, sessions: repo.listSessions(db), assignments, monday: weekOf });
  const status = Object.fromEntries(MUSCLES.map((m) => [m, targetStatus(w.byMuscle[m] ?? 0, targetFor(db, m))]));
  const pick = (m) => muscleSheet(app, m, rows, assignments);
  const goal = db.get('SELECT frequency_goal FROM users LIMIT 1')?.frequency_goal;
  const detailed = w.sessions.filter((s) => s.fidelity !== 'partial_reconstruction').length;

  return h('div', { class: 'stack' },
    h('div', { class: 'row between period-nav' },
      h('button', { class: 'icon-btn', 'aria-label': 'Previous week', onclick: () => { weekOf = addDays(weekOf, -7); app.render(); } }, '‹'),
      h('div', { class: 'center' }, h('strong', {}, `Week of ${shortDate(weekOf)}`), h('div', { class: 'muted small' }, `${shortDate(weekOf)} – ${shortDate(addDays(weekOf, 6))}`)),
      h('button', { class: 'icon-btn', 'aria-label': 'Next week', onclick: () => { weekOf = addDays(weekOf, 7); app.render(); } }, '›')),
    w.status !== 'recorded'
      ? h('div', { class: 'card warn-card' }, h('p', {}, PERIOD_NOTE[w.status]))
      : h('p', { class: 'small' }, `${detailed} session${detailed === 1 ? '' : 's'} logged`, goal ? ` · goal ${goal} a week` : ''),
    w.status === 'recorded' && h('section', { class: 'card' },
      bodyMap(status, pick),
      h('div', { class: 'legend small' },
        h('span', {}, h('i', { class: 'sw sw-none' }), 'No sets'), h('span', {}, h('i', { class: 'sw sw-below' }), 'Below'),
        h('span', {}, h('i', { class: 'sw sw-within' }), 'On target'), h('span', {}, h('i', { class: 'sw sw-above' }), 'Above'))),
    w.status === 'recorded' && h('section', { class: 'card tight' },
      h('div', { class: 'row between' }, h('h3', {}, 'Working sets per muscle'), h('button', { class: 'link small', onclick: () => targetsSheet(app) }, 'Targets')),
      h('p', { class: 'tiny muted' }, 'Main muscle counts 1 per set, secondary muscles ½.'),
      ...MUSCLES.map((m) => {
        const n = w.byMuscle[m] ?? 0;
        const [lo, hi] = targetFor(db, m);
        return h('button', { class: 'list-row muscle-row', onclick: () => pick(m) },
          h('div', { class: 'grow' }, h('div', { class: 'row-title' }, cap(m)), h('div', { class: 'muted small' }, `target ${lo}–${hi}`)),
          h('div', { class: 'right' }, h('strong', {}, fmtSets(n)), h('div', { class: `tiny st-${status[m]}` }, STATUS_WORD[status[m]])));
      }),
      (w.excluded > 0 || w.unassigned > 0) && h('p', { class: 'small muted' },
        w.excluded ? `${w.excluded} unclear set${w.excluded === 1 ? '' : 's'} not counted. ` : '',
        w.unassigned ? h('a', { href: '#/exercises/machines' }, `${w.unassigned} set${w.unassigned === 1 ? '' : 's'} on exercises with no muscle chosen`) : '')));
}

const cap = (m) => m[0].toUpperCase() + m.slice(1);

function muscleSheet(app, muscle, rows, assignments) {
  const { db } = app;
  const end = addDays(weekOf, 7);
  const variants = new Map(repo.listVariants(db, { includeArchived: true }).map((v) => [v.id, v]));
  const mine = rows.filter((r) => r.date_local >= weekOf && r.date_local < end && r.set_type === 'working' && r.fidelity !== 'partial_reconstruction')
    .filter((r) => { const a = assignments.get(r.exercise_id); return a && (a.primary === muscle || a.secondary.includes(muscle)); });
  const byVariant = new Map();
  for (const r of mine) {
    if (!byVariant.has(r.variant_id)) byVariant.set(r.variant_id, []);
    byVariant.get(r.variant_id).push(r);
  }
  sheet(cap(muscle), h('div', { class: 'stack-s' },
    mine.length ? null : h('p', { class: 'muted' }, 'No working sets this week.'),
    ...[...byVariant].map(([vid, list]) => {
      const v = variants.get(vid);
      const role = assignments.get(list[0].exercise_id).primary === muscle ? 'main' : 'secondary, ½ each';
      return h('a', { class: 'list-row', href: `#/exercise/${vid}` },
        h('div', { class: 'grow' }, h('div', { class: 'row-title' }, v?.label ?? 'Exercise'),
          h('div', { class: 'small muted' }, list.map((r) => `${shortDate(r.date_local)} ${app.fmtDisplay(r.load_kg)}×${r.reps ?? '?'}`).join(', '))),
        h('div', { class: 'right small' }, `${list.length} set${list.length === 1 ? '' : 's'}`, h('div', { class: 'tiny muted' }, role)));
    })));
}

function targetsSheet(app) {
  const { db } = app;
  const current = targets(db);
  const inputs = MUSCLES.map((m) => {
    const [lo, hi] = current[m] ?? DEFAULT_TARGET;
    return [m, numInput(lo, { step: 1, inputmode: 'numeric' }), numInput(hi, { step: 1, inputmode: 'numeric' })];
  });
  let ref;
  ref = sheet('Weekly set targets', h('div', { class: 'stack-s' },
    h('p', { class: 'small muted' }, `The default ${DEFAULT_TARGET[0]}–${DEFAULT_TARGET[1]} sets a week is a general hypertrophy guide, not personal advice.`),
    ...inputs.map(([m, lo, hi]) => h('div', { class: 'target-row' }, h('span', {}, cap(m)), lo, h('span', { class: 'muted' }, 'to'), hi)),
    h('button', { class: 'btn primary block', onclick: () => {
      const next = {};
      for (const [m, lo, hi] of inputs) {
        const a = numVal(lo);
        const b = numVal(hi);
        if (a === null || b === null || a < 0 || b < a) { toast(`Check the ${m} range.`); return; }
        if (a !== DEFAULT_TARGET[0] || b !== DEFAULT_TARGET[1]) next[m] = [a, b];
      }
      repo.setSetting(db, 'muscle_targets', next);
      ref.close();
      app.render();
    } }, 'Save targets')));
}

// ------------------------------------------------------------ month
export function renderMonth(app) {
  const { db } = app;
  const today = todaySgt();
  monthOf ??= today.slice(0, 7);
  const sessions = repo.listSessions(db);
  const prs = sessions.filter((x) => x.date_local?.slice(0, 7) === monthOf && x.fidelity !== 'partial_reconstruction')
    .flatMap((x) => repo.sessionPRs(db, x.id).map((p) => ({ ...p, date_local: x.date_local })));
  const r = monthReport({ rows: repo.insightRows(db), sessions, cardio: repo.insightCardio(db), prs, month: monthOf, today });
  const variants = new Map(repo.listVariants(db, { includeArchived: true }).map((v) => [v.id, v]));
  const sign = (n, f = String) => (n > 0 ? `+${f(n)}` : n < 0 ? `−${f(-n)}` : '±0');
  const recorded = r.sessions > 0;

  return h('div', { class: 'stack' },
    h('div', { class: 'row between period-nav' },
      h('button', { class: 'icon-btn', 'aria-label': 'Previous month', onclick: () => { monthOf = addMonths(monthOf, -1); app.render(); } }, '‹'),
      h('div', { class: 'center' }, h('strong', {}, monthName(monthOf)), r.inProgress ? h('div', { class: 'muted small' }, 'so far') : null),
      h('button', { class: 'icon-btn', 'aria-label': 'Next month', onclick: () => { monthOf = addMonths(monthOf, 1); app.render(); } }, '›')),
    !recorded && h('div', { class: 'card warn-card' }, h('p', {}, r.partialDates.length ? 'Only partial notes this month, so there are no totals.' : 'Nothing recorded this month.')),
    recorded && h('div', { class: 'tiles' },
      tile('Workouts', r.sessions, r.comparison && `${sign(r.comparison.sessions)} vs last month`),
      tile('Working sets', r.workingSets, r.comparison && `${sign(r.comparison.workingSets)} vs last month`),
      tile('Volume', app.fmtVol(r.volumeKg), r.comparison ? `${sign(r.comparison.volumeKg, (n) => app.fmtVol(n))}; all machines, descriptive only` : 'all machines, descriptive only'),
      tile('Cardio', r.cardioSec ? `${Math.round(r.cardioSec / 60)} min` : '—', null)),
    recorded && r.comparisonNote && h('p', { class: 'small muted' }, r.comparisonNote),
    r.partialDates.length > 0 && h('p', { class: 'small muted' }, `Partial notes on ${r.partialDates.map(shortDate).join(', ')} are not in these totals.`),
    recorded && h('section', { class: 'card tight' }, h('h3', {}, `PRs (${r.prs.length})`),
      r.prs.length ? r.prs.map((p) => h('a', { class: 'list-row', href: `#/exercise/${p.variant_id}` },
        h('div', { class: 'grow' }, h('div', { class: 'row-title' }, p.exercise_name), h('div', { class: 'small muted' }, `${shortDate(p.date_local)} · ${app.fmtLoad(p.set.load_kg, p.load_basis, p.exercise_name)} × ${p.set.reps ?? '?'}`)),
        h('div', { class: 'small right' }, p.prs.map((x) => x.label).join(', '))))
        : h('p', { class: 'muted small' }, 'No PRs this month.')),
    recorded && r.improvements.length > 0 && h('section', { class: 'card tight' }, h('h3', {}, 'Most improved machines'),
      h('p', { class: 'tiny muted' }, 'Best estimated 1RM this month against the best before it, each machine against itself.'),
      ...r.improvements.map((i) => h('a', { class: 'list-row', href: `#/exercise/${i.variant_id}` },
        h('div', { class: 'grow' }, h('div', { class: 'row-title' }, variants.get(i.variant_id)?.label ?? 'Machine')),
        h('div', { class: 'right' }, h('strong', {}, `+${i.pct}%`), h('div', { class: 'tiny muted' }, `est. 1RM ${app.fmtDisplay(i.before)} → ${app.fmtDisplay(i.after)} ${app.units}`))))));
}

function tile(label, value, sub) {
  return h('div', { class: 'tile' }, h('div', { class: 'tile-label' }, label), h('div', { class: 'tile-val' }, String(value)), sub && h('div', { class: 'tile-sub' }, sub));
}

// ------------------------------------------------------------ body weight
export function renderWeight(app) {
  const { db } = app;
  const all = repo.listBodyMetrics(db).filter((m) => m.weight_kg !== null);
  const dated = all.filter((m) => m.date_local);
  const undated = all.filter((m) => !m.date_local);
  const points = dated.map((m) => ({ date: m.date_local, y: app.toDisplay(m.weight_kg), detail: m.context ?? '' }));
  return h('div', { class: 'stack' },
    h('button', { class: 'btn primary block', onclick: () => weightSheet(app) }, '+ Add weight'),
    h('section', { class: 'card' }, h('h3', {}, 'Body weight'),
      dated.length >= 2 ? lineChart(points, { yLabel: 'Body weight', fmt: (y) => `${Math.round(y * 10) / 10}` })
        : h('p', { class: 'muted small' }, 'Add at least two dated weights to see a trend.')),
    h('section', { class: 'card tight' }, h('h3', {}, 'Entries'),
      ...[...dated].reverse().map((m) => h('button', { class: 'list-row', onclick: () => weightSheet(app, m) },
        h('div', { class: 'grow' }, h('div', { class: 'row-title' }, longDate(m.date_local)), m.context && h('div', { class: 'small muted' }, m.context)),
        h('strong', {}, `${app.fmtDisplay(m.weight_kg)} ${app.units}${m.weight_is_approx ? ' ~' : ''}`))),
      !dated.length && h('p', { class: 'muted small' }, 'No dated entries yet.')),
    undated.length > 0 && h('section', { class: 'card tight' }, h('h3', {}, 'Without a date'),
      h('p', { class: 'tiny muted' }, 'Kept as reported. Not placed on the chart because the date is unknown.'),
      ...undated.map((m) => h('div', { class: 'list-row' }, h('div', { class: 'grow' }, m.context ?? 'Undated'), h('strong', {}, `${app.fmtDisplay(m.weight_kg)} ${app.units}${m.weight_is_approx ? ' (approx.)' : ''}`)))));
}

function weightSheet(app, m = null) {
  const { db } = app;
  const date = h('input', { type: 'date', value: m?.date_local ?? todaySgt() });
  const kg = numInput(m ? Math.round(app.toDisplay(m.weight_kg) * 10) / 10 : null, { placeholder: app.units });
  const ctx = h('input', { type: 'text', value: m?.context ?? '', placeholder: 'e.g. morning, after breakfast' });
  const reason = h('input', { type: 'text', placeholder: 'Why the change? (kept in edit history)' });
  let ref;
  const save = () => {
    const w = numVal(kg);
    if (!date.value) return toast('Choose a date.');
    try {
      const weight = w === null ? null : app.fromDisplay(w);
      if (m) repo.updateBodyMetric(db, m.id, { date_local: date.value, weight_kg: weight, context: ctx.value.trim() || null }, reason.value.trim() || 'correction');
      else repo.addBodyMetric(db, { date_local: date.value, weight_kg: weight, context: ctx.value.trim() || null });
    } catch (e) { toast(e.message); return; }
    ref.close();
    app.render();
  };
  ref = sheet(m ? 'Edit weight' : 'Add weight', h('div', { class: 'stack' },
    h('div', { class: 'grid2' }, field('Date', date), field(`Weight (${app.units})`, kg)),
    field('Note', ctx),
    m && field('Reason', reason),
    h('button', { class: 'btn primary block', onclick: save }, 'Save'),
    m && h('button', { class: 'btn danger block', onclick: () => confirmSheet('Delete this weight?', 'A copy stays in edit history.', 'Delete', () => {
      repo.deleteBodyMetric(db, m.id, reason.value.trim() || 'deleted');
      ref.close();
      app.render();
    }, { danger: true }) }, 'Delete')));
}
