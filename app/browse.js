// History list, exercise/machine list, and per-variant progress detail.
import { h, sheet, badge, segmented, lineChart, longDate, shortDate, field, numInput, numVal, toast, confirmSheet } from './ui.js';
import * as repo from '../lib/db/repo.js';
import { personalRecords, sessionSeries } from '../lib/domain/progress.js';
import { effectiveReps } from '../lib/domain/sets.js';
import { recommendNextSet, repRangeFor } from '../lib/domain/recommend.js';
import { formatRir } from '../lib/domain/rir.js';
import { sessionRow } from './session.js';
import { renderWeek, renderMonth, renderWeight } from './insights.js';
import { bodyMap } from './bodymap.js';
import { calendarMonth, monthName, addMonths, weekStart } from '../lib/domain/insights.js';
import { addDays, todaySgt } from '../lib/domain/time.js';
import { MUSCLES } from '../lib/muscles.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

let historyFilter = 'all';
export function renderHistory(app) {
  const all = repo.listSessions(app.db);
  const rows = all.filter((s) => historyFilter === 'all' || (historyFilter === 'detailed' ? s.fidelity !== 'partial_reconstruction' : s.fidelity === 'partial_reconstruction'));
  return h('div', { class: 'stack' },
    h('header', { class: 'page-head' }, h('h1', {}, 'History'), h('p', { class: 'muted' }, `${all.length} sessions`)),
    calendarCard(app, all),
    segmented([['all', 'All'], ['detailed', 'Detailed'], ['partial', 'Partial']], historyFilter, (v) => { historyFilter = v; app.render(); }, 'Filter sessions'),
    ...sessionsByMonth(app, rows),
    h('p', { class: 'tiny muted' }, 'The imported history is a best-effort compilation, not every workout you ever did. Partial dates are summaries only.'));
}

let calMonth = null;
function calendarCard(app, sessions) {
  const today = todaySgt();
  calMonth ??= today.slice(0, 7);
  const cal = calendarMonth(sessions, calMonth);
  const monday = weekStart(today);
  const thisWeek = sessions.filter((s) => s.date_local >= monday && s.date_local < addDays(monday, 7) && s.fidelity !== 'partial_reconstruction').length;
  const goal = app.db.get('SELECT frequency_goal FROM users LIMIT 1')?.frequency_goal;
  const open = (day) => {
    if (day.sessions.length === 1) { app.go(`#/session/${day.sessions[0].id}`); return; }
    const ref = sheet(longDate(day.date), h('div', {}, ...day.sessions.map((s) => h('a', { class: 'list-row', href: `#/session/${s.id}`, onclick: () => ref.close() }, s.label || 'Workout'))));
  };
  return h('section', { class: 'card tight' },
    h('div', { class: 'row between period-nav' },
      h('button', { class: 'icon-btn', 'aria-label': 'Previous month', onclick: () => { calMonth = addMonths(calMonth, -1); app.render(); } }, '‹'),
      h('strong', {}, monthName(calMonth)),
      h('button', { class: 'icon-btn', 'aria-label': 'Next month', onclick: () => { calMonth = addMonths(calMonth, 1); app.render(); } }, '›')),
    h('div', { class: 'cal', role: 'grid', 'aria-label': `Training days, ${monthName(calMonth)}` },
      ...['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d) => h('span', { class: 'cal-head', 'aria-hidden': 'true' }, d)),
      ...cal.weeks.flat().map((d) => {
        const kind = !d.sessions.length ? '' : d.sessions.some((s) => s.fidelity !== 'partial_reconstruction') ? 'detailed' : 'partial';
        const label = `${longDate(d.date)}${kind === 'detailed' ? ', workout logged' : kind === 'partial' ? ', partial notes' : ''}`;
        return kind && d.inMonth
          ? h('button', { class: `cal-day ${kind} ${d.date === today ? 'today' : ''}`, 'aria-label': label, onclick: () => open(d) }, Number(d.date.slice(8)))
          : h('span', { class: `cal-day ${d.inMonth ? '' : 'out'} ${d.date === today ? 'today' : ''}`, 'aria-label': d.inMonth ? label : null }, d.inMonth ? Number(d.date.slice(8)) : '');
      })),
    h('div', { class: 'legend small' }, h('span', {}, h('i', { class: 'sw sw-within' }), 'Logged'), h('span', {}, h('i', { class: 'sw sw-partial' }), 'Partial notes'), h('span', { class: 'muted' }, 'Blank: not recorded')),
    h('p', { class: 'small' }, `This week: ${thisWeek} workout${thisWeek === 1 ? '' : 's'}`, goal ? ` · goal ${goal}` : ''),
    cal.undated.length > 0 && h('p', { class: 'tiny muted' }, `${cal.undated.length} session${cal.undated.length === 1 ? ' has' : 's have'} no date and appear only in the list below.`));
}

function sessionsByMonth(app, rows) {
  const groups = new Map();
  for (const s of rows) {
    const k = s.date_local ? `${MONTHS[Number(s.date_local.slice(5, 7)) - 1]} ${s.date_local.slice(0, 4)}` : 'Date unknown';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  }
  return [...groups].map(([k, list]) => h('section', {}, h('h2', { class: 'section-title' }, k), ...list.map((s) => sessionRow(app, s))));
}

const PROGRESS_TABS = [['week', 'Week'], ['month', 'Month'], ['weight', 'Weight'], ['machines', 'Machines']];
export function renderExercises(app, tab = 'week') {
  tab = PROGRESS_TABS.some(([k]) => k === tab) ? tab : 'week';
  const body = tab === 'week' ? renderWeek(app, { bodyMap }) : tab === 'month' ? renderMonth(app) : tab === 'weight' ? renderWeight(app) : machineList(app);
  return h('div', { class: 'stack' },
    h('header', { class: 'page-head' }, h('h1', {}, 'Progress')),
    h('nav', { class: 'tabs', 'aria-label': 'Progress views' }, ...PROGRESS_TABS.map(([k, l]) => h('a', { href: `#/exercises/${k}`, class: k === tab ? 'on' : '', 'aria-current': k === tab ? 'page' : 'false' }, l))),
    body);
}

let exQuery = '';
function machineList(app) {
  const vs = repo.listVariants(app.db).filter((v) => v.sessions > 0);
  const q = h('input', { type: 'search', placeholder: 'Search exercise or machine', value: exQuery, 'aria-label': 'Search exercises' });
  const list = h('div', { class: 'stack-s' });
  const draw = () => {
    const term = exQuery.toLowerCase();
    const by = new Map();
    for (const v of vs) {
      if (term && !v.label.toLowerCase().includes(term)) continue;
      if (!by.has(v.exercise_name)) by.set(v.exercise_name, []);
      by.get(v.exercise_name).push(v);
    }
    list.replaceChildren(...[...by].map(([name, list]) => h('section', { class: 'card tight' },
      h('h3', { class: 'ex-group' }, name, h('span', { class: 'muted small' }, list.length > 1 ? ` · ${list.length} machines/variations` : '')),
      ...list.sort((a, b) => (b.last_date ?? '').localeCompare(a.last_date ?? '')).map((v) => {
        const pr = personalRecords(repo.variantHistory(app.db, v.id));
        return h('a', { class: 'list-row', href: `#/exercise/${v.id}` },
          h('div', { class: 'grow' },
            h('div', { class: 'row-title' }, [v.brand !== 'unspecified' ? v.brand : 'Brand unspecified', v.equipment_description, v.variation].filter(Boolean).join(' · ')),
            h('div', { class: 'muted small' }, `${v.sessions} session${v.sessions === 1 ? '' : 's'} · last ${shortDate(v.last_date)}`)),
          h('div', { class: 'right small' }, pr ? h('span', {}, h('strong', {}, app.fmtLoad(pr.heaviest.load_kg, v.load_basis, v.exercise_name)), ` × ${pr.heaviest.reps}`) : h('span', { class: 'muted' }, 'no working sets')));
      }))));
  };
  q.addEventListener('input', () => { exQuery = q.value; draw(); });
  draw();
  return h('div', { class: 'stack' },
    h('p', { class: 'muted small' }, 'Records are per exact machine and variation — never compared across brands.'),
    q, list);
}

let metric = 'topLoad';
let showRecon = false;
export function renderExercise(app, variantId) {
  const { db } = app;
  const v = repo.getVariant(db, variantId);
  if (!v) return h('div', { class: 'card' }, 'Not found');
  const history = repo.variantHistory(db, variantId);
  const pr = personalRecords(history);
  const series = sessionSeries(history, { includeReconstructed: showRecon });
  const rec = recommendNextSet({ variant: v, exercise: { category: v.category }, equipment: { increment_kg: v.increment_kg, load_type: v.load_type }, history });
  const others = repo.listVariants(db).filter((x) => x.exercise_name === v.exercise_name && x.id !== v.id && x.sessions > 0);
  const [rmin, rmax] = repRangeFor(v, { category: v.category });
  const M = {
    topLoad: ['Top working load', (p) => p.topLoad, (y) => app.fmtLoad(y, v.load_basis, v.exercise_name).replace(/\/\w+$/, '')],
    e1rm: ['Estimated 1RM (Epley)', (p) => p.e1rm, (y) => `${Math.round(app.toDisplay(y))}`],
    volume: ['Working volume', (p) => p.volume, (y) => `${Math.round(app.toDisplay(y))}`],
  };
  const pts = series.filter((p) => M[metric][1](p) !== null).map((p) => ({
    date: p.date, y: M[metric][1](p), hollow: p.fidelity === 'partial_reconstruction' || !p.workingOnly,
    detail: `${app.fmtLoad(p.topLoad, v.load_basis, v.exercise_name)} × ${p.topReps ?? '?'} · ${p.workingSets} working sets`,
  }));

  return h('div', { class: 'stack' },
    h('header', { class: 'page-head' },
      h('a', { class: 'link small', href: '#/exercises/machines' }, '‹ Progress'),
      h('h1', {}, v.exercise_name),
      h('p', { class: 'muted' }, [v.brand !== 'unspecified' ? v.brand : 'Brand unspecified', v.equipment_description, v.variation].filter(Boolean).join(' · '),
        ` · load ${v.load_basis === 'total' ? 'is the stack total' : v.load_basis === 'per_side' ? 'is per side (×2 for volume)' : v.load_basis === 'per_limb' ? 'is per arm/leg' : 'convention unknown'}`)),
    pr ? h('div', { class: 'tiles' },
      prTile(app, v, 'Heaviest', pr.heaviest),
      pr.bestE1rm && h('div', { class: 'tile' }, h('div', { class: 'tile-label' }, 'Best e1RM'), h('div', { class: 'tile-val' }, `${Math.round(app.toDisplay(pr.bestE1rm.e1rm))} ${app.units}`), h('div', { class: 'tile-sub' }, `${pr.bestE1rm.load_kg} × ${pr.bestE1rm.reps} · ${shortDate(pr.bestE1rm.date)} · estimate`)),
      h('div', { class: 'tile' }, h('div', { class: 'tile-label' }, 'Best set volume'), h('div', { class: 'tile-val' }, app.fmtVol(pr.bestSetVolume.volume)), h('div', { class: 'tile-sub' }, `${pr.bestSetVolume.load_kg} × ${pr.bestSetVolume.reps} · ${shortDate(pr.bestSetVolume.date)}`)),
      pr.bestSessionVolume && h('div', { class: 'tile' }, h('div', { class: 'tile-label' }, 'Best session volume'), h('div', { class: 'tile-val' }, app.fmtVol(pr.bestSessionVolume.volume)), h('div', { class: 'tile-sub' }, shortDate(pr.bestSessionVolume.date))),
      ...['L', 'R'].filter((k) => pr.sides[k]).map((k) => h('div', { class: 'tile' }, h('div', { class: 'tile-label' }, `${k === 'L' ? 'Left' : 'Right'} side best`),
        h('div', { class: 'tile-val' }, `${pr.sides[k].load_kg} × ${pr.sides[k].reps}`), h('div', { class: 'tile-sub' }, `${pr.sides[k].rir_raw ? `RIR ${pr.sides[k].rir_raw} · ` : ''}${shortDate(pr.sides[k].date)}`))))
      : h('div', { class: 'card' }, h('p', { class: 'muted' }, 'No confirmed working sets on this machine yet, so no records.')),
    h('section', { class: 'card' },
      h('div', { class: 'eyebrow' }, 'Next time'),
      h('div', { class: 'rec-main' }, rec.load_kg !== null ? `${app.fmtLoad(rec.load_kg, v.load_basis, v.exercise_name)} × ${rec.rep_min}–${rec.rep_max} @ RIR ${formatRir(rec.rir_min, rec.rir_max)}` : 'Calibrate first'),
      h('p', { class: 'small' }, rec.rationale), ...rec.alternatives.map((a) => h('p', { class: 'small muted' }, a))),
    h('section', { class: 'card' },
      h('h3', {}, M[metric][0]),
      segmented([['topLoad', 'Top load'], ['e1rm', 'e1RM'], ['volume', 'Volume']], metric, (x) => { metric = x; app.render(); }, 'Chart metric'),
      lineChart(pts, { yLabel: M[metric][0], fmt: M[metric][2] }),
      h('label', { class: 'switch small' }, h('input', { type: 'checkbox', checked: showRecon, onchange: (e) => { showRecon = e.target.checked; app.render(); } }), h('span', {}, 'Include reconstructed dates (hollow points)')),
      h('p', { class: 'tiny muted' }, 'Hollow = reconstructed or no confirmed working sets that day. Tap a point for details.')),
    pr && h('section', { class: 'card' }, h('h3', {}, 'Rep records by load'),
      h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, h('th', {}, 'Load'), h('th', {}, 'Best reps'), h('th', {}, 'RIR'), h('th', {}, 'Date'))),
        h('tbody', {}, ...pr.repPRs.map((r) => h('tr', {}, h('td', {}, app.fmtLoad(r.load_kg, v.load_basis, v.exercise_name)), h('td', {}, r.reps), h('td', {}, r.rir_raw ?? '—'), h('td', {}, shortDate(r.date))))))),
    h('section', { class: 'card' }, h('h3', {}, 'Sessions'),
      ...[...history].reverse().filter((x) => x.sets.length).map((x) => h('a', { class: 'list-row', href: `#/session/${x.session.id}` },
        h('div', { class: 'grow' }, h('div', { class: 'row-title' }, longDate(x.session.date_local)),
          h('div', { class: 'small' }, x.sets.map((s) => `${s.set_type === 'working' ? '' : `(${s.set_type === 'warmup' ? 'wu' : s.set_type === 'calibration' ? 'cal' : '?'}) `}${s.load_kg}×${effectiveReps(s) ?? '?'}${s.sides.length ? ` [${s.sides.map((sd) => `${sd.side}${sd.reps ?? ''}${sd.rir_raw ? '@' + sd.rir_raw : ''}`).join(' ')}]` : s.rir_raw ? `@${s.rir_raw}` : ''}`).join(', '))),
        x.session.fidelity === 'partial_reconstruction' ? badge('partial', 'warn') : null))),
    others.length > 0 && h('section', { class: 'card' }, h('h3', {}, 'Same exercise, other machines'),
      h('p', { class: 'tiny muted' }, 'Reference only — resistance curves differ, so loads are not comparable.'),
      ...others.map((o) => h('a', { class: 'list-row', href: `#/exercise/${o.id}` }, h('div', { class: 'grow' }, o.label), h('span', { class: 'muted small' }, shortDate(o.last_date))))),
    muscleEditor(app, v),
    machineSettings(app, v, rmin, rmax, others));
}

function muscleEditor(app, v) {
  const { db } = app;
  const cur = repo.getMuscles(db).get(v.exercise_id) ?? { primary: null, secondary: [] };
  const primary = h('select', { 'aria-label': 'Main muscle' }, h('option', { value: '' }, '— none —'), ...MUSCLES.map((m) => h('option', { value: m, selected: m === cur.primary }, m)));
  const boxes = MUSCLES.map((m) => h('label', { class: 'check' }, h('input', { type: 'checkbox', value: m, checked: cur.secondary.includes(m) }), m));
  const summaryText = cur.primary ? `${cur.primary}${cur.secondary.length ? ` + ${cur.secondary.join(', ')}` : ''}` : 'not chosen';
  return h('details', { class: 'card', open: !cur.primary }, h('summary', {}, `Muscles: ${summaryText}`),
    h('div', { class: 'stack-s' },
      h('p', { class: 'tiny muted' }, `Applies to every machine for ${v.exercise_name}. Main muscle counts 1 per set, secondary ½.`),
      field('Main muscle', primary),
      h('fieldset', { class: 'fs' }, h('legend', {}, 'Secondary muscles'), h('div', { class: 'checks' }, ...boxes)),
      h('button', { class: 'btn primary', onclick: () => {
        const secondary = boxes.map((b) => b.querySelector('input')).filter((i) => i.checked).map((i) => i.value);
        repo.setExerciseMuscles(db, v.exercise_id, { primary: primary.value || null, secondary }, 'muscles edited');
        toast('Muscles saved. Weekly counts use them now.');
        app.render();
      } }, 'Save muscles')));
}

function prTile(app, v, label, r) {
  return h('div', { class: 'tile accent' }, h('div', { class: 'tile-label' }, label),
    h('div', { class: 'tile-val' }, `${app.fmtLoad(r.load_kg, v.load_basis, v.exercise_name)} × ${r.reps}`),
    h('div', { class: 'tile-sub' }, `${r.rir_raw ? `RIR ${r.rir_raw} · ` : ''}${shortDate(r.date)}`));
}

function machineSettings(app, v, rmin, rmax, others) {
  const { db } = app;
  const repMin = numInput(v.rep_min ?? rmin, { step: 1, inputmode: 'numeric' });
  const repMax = numInput(v.rep_max ?? rmax, { step: 1, inputmode: 'numeric' });
  const rest = numInput(v.rest_sec ?? app.restFor(v.category), { step: 15, inputmode: 'numeric' });
  const inc = numInput(v.increment_kg, { placeholder: 'auto from history' });
  const basis = h('select', {}, ...[['total', 'Stack total / single load'], ['per_side', 'Per side'], ['per_limb', 'Per arm/leg'], ['unknown', 'Unknown']].map(([x, l]) => h('option', { value: x, selected: v.load_basis === x }, l)));
  const lat = h('select', {}, ...[['bilateral', 'Both sides together'], ['unilateral', 'One side at a time'], ['unknown', 'Unknown']].map(([x, l]) => h('option', { value: x, selected: v.laterality === x }, l)));
  const mergeSel = h('select', {}, h('option', { value: '' }, '— choose —'), ...others.map((o) => h('option', { value: o.id }, o.label)));
  return h('details', { class: 'card' }, h('summary', {}, 'Machine settings'),
    h('div', { class: 'stack' },
      h('div', { class: 'grid2' }, field('Rep range min', repMin), field('Rep range max', repMax)),
      h('div', { class: 'grid2' }, field('Rest (sec)', rest), field('Weight increment (kg)', inc, 'Used for suggestions')),
      h('div', { class: 'grid2' }, field('Weight entered as', basis), field('Sides', lat)),
      h('p', { class: 'tiny muted' }, 'Changing "weight entered as" affects new sets only; logged sets keep their own multiplier (edit a set to correct it).'),
      h('button', { class: 'btn primary', onclick: () => {
        repo.updateVariant(db, v.id, { rep_min: numVal(repMin), rep_max: numVal(repMax), rest_sec: numVal(rest), load_basis: basis.value, laterality: lat.value }, 'machine settings');
        repo.updateEquipment(db, v.equipment_id, { increment_kg: numVal(inc) }, 'machine settings');
        toast('Saved');
        app.render();
      } }, 'Save settings'),
      others.length > 0 && h('div', { class: 'stack-s' },
        field('This is actually the same machine as…', mergeSel, 'Only merge if you are sure — it combines the histories.'),
        h('button', { class: 'btn danger', onclick: () => {
          if (!mergeSel.value) return toast('Choose a machine first.');
          confirmSheet('Merge histories?', 'All sessions of this entry move to the chosen machine. Recorded in the edit history.', 'Merge', () => {
            repo.mergeVariant(db, v.id, mergeSel.value, 'user confirmed same machine');
            app.go(`#/exercise/${mergeSel.value}`);
          }, { danger: true });
        } }, 'Merge into selected'))));
}

