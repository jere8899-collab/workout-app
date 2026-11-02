// Today / active session / workout summary.
import { h, sheet, toast, confirmSheet, field, numInput, numVal, stepper, rirPicker, segmented, badge, longDate } from './ui.js';
import * as repo from '../lib/db/repo.js';
import { summarizeSession } from '../lib/domain/summary.js';
import { recommendNextSet, repRangeFor, inferIncrement } from '../lib/domain/recommend.js';
import { isWorking, effectiveReps, setVolume } from '../lib/domain/sets.js';
import { formatRir } from '../lib/domain/rir.js';
import { formatSgtTime, formatDuration, sgtToUtc, utcToSgtDate } from '../lib/domain/time.js';
import { KNOWN_BRANDS } from '../lib/catalog.js';
import { stripMd } from '../lib/io/parse.js';
import { startRest } from './main.js';

const TYPE_SHORT = { warmup: 'WU', working: 'W', calibration: 'CAL', ambiguous: '?', unclassified: '·' };
const TYPE_LABEL = { warmup: 'Warm-up', working: 'Working', calibration: 'Calibration', ambiguous: 'Ramp-up/working (unclear)', unclassified: 'Unclassified' };
const FIDELITY = {
  set_by_set: ['Detailed log', 'ok'],
  partial_reconstruction: ['Partial reconstruction', 'warn'],
  live: ['Logged live', 'ok'],
};

export const multiplierFor = (basis) => (basis === 'per_side' || basis === 'per_limb' ? 2 : 1);

// ------------------------------------------------------------ Today
export function renderToday(app) {
  const { db } = app;
  const active = repo.activeSession(db);
  const plans = repo.listPlans(db);
  const plan = plans.find((p) => p.is_active) ?? plans[0];
  const next = plan ? repo.nextPlanDay(db, plan.id) : null;
  const recent = repo.listSessions(db).filter((s) => s.status === 'completed').slice(0, 3);

  return h('div', { class: 'stack' },
    h('header', { class: 'page-head' }, h('h1', {}, 'Today'), h('p', { class: 'muted' }, longDate(new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10)))),
    active && h('a', { class: 'card hero-card', href: `#/session/${active.id}` },
      h('div', { class: 'eyebrow' }, 'In progress'),
      h('div', { class: 'hero-title' }, active.label || 'Workout'),
      h('div', { class: 'muted' }, 'Started ', formatSgtTime(active.started_at_utc), ' · ', h('span', { 'data-elapsed': active.started_at_utc }, elapsed(active.started_at_utc)), ' elapsed'),
      h('span', { class: 'btn primary block' }, 'Continue workout')),
    !active && next && h('div', { class: 'card' },
      h('div', { class: 'eyebrow' }, `Up next · ${plan.name}`),
      h('div', { class: 'hero-title' }, next.name),
      h('ul', { class: 'plain small muted' }, ...(plan.days.find((d) => d.id === next.id)?.items ?? []).map((i) =>
        h('li', {}, `${i.variant?.exercise_name ?? '?'} · ${i.variant?.brand !== 'unspecified' ? i.variant?.brand : 'brand ?'} — ${i.target_sets} sets`))),
      h('button', { class: 'btn primary block', onclick: () => startFromDay(app, plan.days.find((d) => d.id === next.id)) }, `Start ${next.name}`),
      h('div', { class: 'row gap-s wrap' }, ...plan.days.filter((d) => d.id !== next.id).map((d) =>
        h('button', { class: 'btn small', onclick: () => startFromDay(app, d) }, `Start ${d.name}`)))),
    !active && h('button', { class: `btn ${next ? '' : 'primary'} block`, onclick: () => {
      const s = repo.createSession(db, { label: 'Workout' });
      app.go(`#/session/${s.id}`);
    } }, 'Start an empty workout'),
    recent.length > 0 && h('section', {},
      h('h2', { class: 'section-title' }, 'Recent'),
      ...recent.map((s) => sessionRow(app, s))),
  );
}

export function startFromDay(app, day) {
  const items = day.items.filter((i) => i.substitutes.length);
  if (!items.length) {
    const s = repo.startSessionFromPlanDay(app.db, day.id);
    app.go(`#/session/${s.id}`);
    return;
  }
  // Offer substitutions before starting.
  const picks = {};
  let ref;
  const body = h('div', { class: 'stack' },
    h('p', { class: 'muted' }, 'Machine taken? Pick a substitute. Each machine keeps its own baseline.'),
    ...items.map((i) => {
      const opts = [i.variant_id, ...i.substitutes].map((id) => repo.getVariant(app.db, id)).filter(Boolean);
      const sel = h('select', { onchange: (e) => { picks[i.id] = e.target.value; } }, ...opts.map((v) => h('option', { value: v.id }, v.label)));
      return field(i.variant?.exercise_name ?? 'Exercise', sel);
    }),
    h('button', { class: 'btn primary block', onclick: () => {
      const s = repo.startSessionFromPlanDay(app.db, day.id, picks);
      ref.close();
      app.go(`#/session/${s.id}`);
    } }, 'Start'));
  ref = sheet(`Start ${day.name}`, body);
}

export function sessionRow(app, s) {
  const [fl, fk] = FIDELITY[s.fidelity] ?? [s.fidelity, ''];
  return h('a', { class: 'list-row', href: `#/session/${s.id}` },
    h('div', { class: 'grow' },
      h('div', { class: 'row-title' }, s.label || 'Workout'),
      h('div', { class: 'muted small' }, longDate(s.date_local),
        s.working_sets ? ` · ${s.working_sets} working sets` : '',
        s.cardio_count ? ' · cardio' : '')),
    s.status === 'active' ? badge('Active', 'live') : badge(fl, fk));
}

// ------------------------------------------------------------ Session (live or summary)
export function renderSession(app, id) {
  const g = repo.getSessionGraph(app.db, id);
  if (!g) return h('div', { class: 'card' }, h('p', {}, 'Session not found.'), h('a', { href: '#/history' }, 'Back to history'));
  return g.session.status === 'active' ? renderLive(app, g) : renderSummary(app, g);
}

function bodyKg(app, g) {
  return repo.latestBodyWeight(app.db, g.session.date_local);
}

function renderLive(app, g) {
  const { db } = app;
  const sum = summarizeSession(g, { bodyKg: bodyKg(app, g) });
  const sid = g.session.id;
  if (!app.focus[sid] || !g.exercises.some((e) => e.id === app.focus[sid])) {
    app.focus[sid] = (g.exercises.find((e) => e.sets.filter(isWorking).length < Math.max(1, e.planned.length)) ?? g.exercises[0])?.id;
  }

  const groups = [];
  for (const e of g.exercises) {
    const last = groups[groups.length - 1];
    if (e.superset_group && last && last.group === e.superset_group) last.items.push(e);
    else groups.push({ group: e.superset_group, items: [e] });
  }

  return h('div', { class: 'stack' },
    h('header', { class: 'session-head sticky' },
      h('div', { class: 'row between' },
        h('button', { class: 'title-btn', onclick: () => editSessionSheet(app, g) }, g.session.label || 'Workout', h('span', { class: 'muted small' }, ' ✎')),
        h('span', { class: 'elapsed', 'data-elapsed': g.session.started_at_utc }, elapsed(g.session.started_at_utc))),
      h('div', { class: 'stat-strip' },
        stat('Working sets', sum.workingSets),
        stat('Volume', app.fmtVol(sum.volumeKg)),
        stat('Cardio', sum.cardioSec ? formatDuration(sum.cardioSec) : '—'))),
    ...groups.map((grp) => grp.group && grp.items.length > 1
      ? h('section', { class: 'superset' }, h('div', { class: 'superset-tag' }, `Superset ${grp.group}`, h('span', { class: 'muted small' }, ' — alternate sets, rest after the round')), ...grp.items.map((e) => exerciseCard(app, g, e, grp)))
      : exerciseCard(app, g, grp.items[0], null)),
    !g.exercises.length && h('div', { class: 'card empty' }, h('p', {}, 'No exercises yet.'), h('p', { class: 'muted small' }, 'Add one, or start a plan day from Today.')),
    g.cardio.length > 0 && h('section', { class: 'card' }, h('h3', {}, 'Cardio'), ...sum.cardio.map((c) => cardioBlock(app, c, true))),
    h('div', { class: 'row gap wrap' },
      h('button', { class: 'btn grow', onclick: () => addExerciseSheet(app, sid) }, '+ Exercise'),
      h('button', { class: 'btn grow', onclick: () => cardioSheet(app, sid) }, '+ Cardio')),
    h('button', { class: 'btn primary block', onclick: () => confirmSheet('Finish workout?', `${sum.workingSets} working sets, ${app.fmtVol(sum.volumeKg)}.`, 'Finish', () => {
      repo.finishSession(db, sid);
      app.go(`#/session/${sid}`);
    }) }, 'Finish workout'),
  );
}

function stat(label, value) {
  return h('div', { class: 'stat' }, h('div', { class: 'stat-val' }, String(value)), h('div', { class: 'stat-label' }, label));
}

function targetFor(e) {
  if (!e.planned.length) return null;
  const p = e.planned[0];
  return { rep_min: p.rep_min, rep_max: p.rep_max, rir_min: p.rir_min, rir_max: p.rir_max, target_sets: e.planned.length };
}

export function recommendationFor(app, e, sessionId) {
  const { db } = app;
  const history = repo.variantHistory(db, e.variant_id, { excludeSessionId: sessionId });
  const others = repo.listVariants(db).filter((v) => v.exercise_name === e.exercise_name && v.id !== e.variant_id && v.working_sets > 0).map((v) => {
    const hist = repo.variantHistory(db, v.id).filter((x) => x.session.fidelity !== 'partial_reconstruction');
    const last = hist[hist.length - 1];
    const top = last?.sets.filter(isWorking).sort((a, b) => b.load_kg - a.load_kg)[0];
    return { label: v.label, summary: top ? `${top.load_kg} kg × ${effectiveReps(top)} on ${last.session.date_local}` : 'no confirmed sets' };
  });
  return recommendNextSet({
    variant: e, exercise: { category: e.category }, equipment: { increment_kg: e.increment_kg, load_type: e.load_type },
    history, currentSets: e.sets, target: targetFor(e), otherVariants: others,
  });
}

function setLine(app, e, s, { onEdit } = {}) {
  const sides = s.sides.length
    ? s.sides.map((x) => `${x.side} ${x.reps ?? s.reps ?? '?'}${x.rir_raw !== null ? ` @${x.rir_raw}` : ''}`).join(' · ')
    : null;
  const vol = s.set_type === 'working' ? setVolume(s) : null;
  return h('button', { class: `set-line ${s.deleted ? 'deleted' : ''} t-${s.set_type}`, onclick: onEdit, 'aria-label': `Edit set ${s.position + 1}` },
    h('span', { class: `set-type`, title: TYPE_LABEL[s.set_type] }, TYPE_SHORT[s.set_type] ?? s.set_type),
    h('span', { class: 'set-main' },
      h('strong', {}, app.fmtLoad(s.load_kg, e.load_basis ?? loadBasisOf(s), e.exercise_name)), ' × ', h('strong', {}, sides && !s.reps ? '' : (s.reps ?? '?')),
      s.partials ? h('span', { class: 'muted' }, ` +${s.partials}p`) : null,
      sides ? h('span', { class: 'sides' }, ` ${sides}`) : (s.rir_raw !== null ? h('span', { class: 'muted' }, ` @ RIR ${s.rir_raw}`) : h('span', { class: 'muted' }, ' · RIR —'))),
    h('span', { class: 'set-meta muted small' },
      s.technique === 'degraded' ? '⚠ form ' : '',
      s.superset_pair_set_id ? '⇄ ' : '',
      s.fidelity === 'reconstructed' ? 'recon. ' : '',
      vol !== null ? app.fmtVol(vol) : ''));
}

function loadBasisOf(s) {
  return s.load_multiplier === 2 ? 'per_side' : 'total';
}

function exerciseCard(app, g, e, grp) {
  const { db } = app;
  const sid = g.session.id;
  const focused = app.focus[sid] === e.id;
  const working = e.sets.filter(isWorking).length;
  const t = targetFor(e);
  const [rmin, rmax] = repRangeFor(e, { category: e.category }, t);
  const head = h('div', { class: 'ex-head' },
    h('button', { class: 'ex-title-btn', 'aria-expanded': focused ? 'true' : 'false', onclick: () => { app.focus[sid] = e.id; app.render(); } },
      h('div', { class: 'ex-name' }, e.exercise_name),
      h('div', { class: 'ex-sub muted small' }, [e.brand !== 'unspecified' ? e.brand : 'brand unspecified', e.equipment_description, e.variation].filter(Boolean).join(' · '))),
    h('div', { class: 'ex-count' }, t ? `${working}/${t.target_sets}` : `${working}`, h('div', { class: 'muted tiny' }, 'sets')));
  const card = h('section', { class: `card ex-card ${focused ? 'focused' : ''}` }, head,
    h('div', { class: 'muted small' }, `Target ${t ? `${t.target_sets} × ` : ''}${rmin}–${rmax} reps @ RIR ${formatRir(t?.rir_min ?? 1, t?.rir_max ?? 2)}`),
    e.sets.length > 0 && h('div', { class: 'set-list' }, ...e.sets.map((s) => setLine(app, e, s, { onEdit: () => editSetSheet(app, e, s) }))));

  if (!focused) {
    card.append(h('button', { class: 'btn block', onclick: () => { app.focus[sid] = e.id; app.render(); } }, working ? 'Log another set' : 'Log sets'));
    return card;
  }

  const rec = recommendationFor(app, e, sid);
  card.append(recBox(app, e, rec, () => applyRec()));
  const form = setForm(app, e, rec);
  card.append(form.el);
  function applyRec() { form.apply(rec); }

  card.append(h('div', { class: 'row gap' },
    h('button', { class: 'btn', onclick: () => form.copyPrevious() }, 'Copy previous'),
    h('button', { class: 'btn primary grow big', onclick: () => {
      const input = form.read();
      if (input.load_kg === null) return toast('Enter a weight (0 is fine for bodyweight).');
      if (input.reps === null && !input.sides?.some((x) => x.reps !== null)) return toast('Enter reps.');
      const saved = repo.saveRecommendation(db, sid, e.variant_id, rec);
      repo.logSet(db, e.id, { ...input, recommendation_id: saved.id });
      app.drafts[e.id] = { ...form.state(), rir: null, L: { ...form.state().L, rir: null }, R: { ...form.state().R, rir: null }, technique: null };
      afterLog(app, g, e, grp);
    } }, 'Log set')));
  card.append(h('div', { class: 'row gap-s wrap card-actions' },
    h('a', { class: 'link small', href: `#/exercise/${e.variant_id}` }, 'History & PRs'),
    h('button', { class: 'link small', onclick: () => supersetToggle(app, g, e) }, e.superset_group ? `Leave superset ${e.superset_group}` : 'Superset with previous'),
    !e.sets.length && h('button', { class: 'link small danger', onclick: () => { repo.removeSessionExercise(db, e.id); app.render(); } }, 'Remove')));
  return card;
}

function afterLog(app, g, e, grp) {
  const sid = g.session.id;
  const restSec = e.target_rest_sec ?? e.variant_rest_sec ?? app.restFor(e.category);
  if (grp && grp.items.length > 1) {
    const i = grp.items.findIndex((x) => x.id === e.id);
    if (i < grp.items.length - 1) {
      app.focus[sid] = grp.items[i + 1].id;
      toast(`Superset: now ${grp.items[i + 1].exercise_name}`);
      app.render();
      return;
    }
    app.focus[sid] = grp.items[0].id;
    startRest(Math.max(...grp.items.map((x) => x.target_rest_sec ?? x.variant_rest_sec ?? app.restFor(x.category))), `Rest after superset ${grp.group}`);
  } else {
    startRest(restSec, `Rest · ${e.exercise_name}`);
  }
  app.render();
}

function supersetToggle(app, g, e) {
  const { db } = app;
  if (e.superset_group) {
    repo.updateSessionExercise(db, e.id, { superset_group: null }, 'leave superset');
  } else {
    const i = g.exercises.findIndex((x) => x.id === e.id);
    const prev = g.exercises[i - 1];
    if (!prev) return toast('Move it below another exercise first — supersets pair with the exercise above.');
    let letter = prev.superset_group;
    if (!letter) {
      const used = new Set(g.exercises.map((x) => x.superset_group).filter(Boolean));
      letter = 'ABCDEFGH'.split('').find((l) => !used.has(l));
      repo.updateSessionExercise(db, prev.id, { superset_group: letter }, 'superset');
    }
    repo.updateSessionExercise(db, e.id, { superset_group: letter }, 'superset');
  }
  app.render();
}

const ACTION_LABEL = { increase: 'Add load', hold: 'Hold load', add_reps: 'Add reps', reduce: 'Reduce load', calibrate: 'Calibrate' };

function recBox(app, e, rec, onUse) {
  const load = rec.load_kg !== null ? app.fmtLoad(rec.load_kg, e.load_basis, e.exercise_name) : 'find your load';
  return h('div', { class: `rec rec-${rec.action}` },
    h('div', { class: 'row between' },
      h('div', {},
        h('div', { class: 'eyebrow' }, `Suggested next set · ${ACTION_LABEL[rec.action]}`),
        h('div', { class: 'rec-main' }, load, rec.load_kg !== null ? ` × ${rec.rep_min}–${rec.rep_max}` : '', h('span', { class: 'muted' }, ` @ RIR ${formatRir(rec.rir_min, rec.rir_max)}`))),
      rec.load_kg !== null && h('button', { class: 'btn small', onclick: onUse }, 'Use')),
    h('details', {},
      h('summary', { class: 'small' }, `Why? (${rec.confidence} confidence)`),
      h('p', { class: 'small' }, rec.rationale),
      ...rec.alternatives.map((a) => h('p', { class: 'small muted' }, a)),
      h('p', { class: 'tiny muted' }, `Increment: ${rec.increment.kg} kg — ${rec.increment.source}. A suggestion only; log what you actually did.`)));
}

// The set entry form. Keeps a draft per exercise so re-renders don't lose input.
function setForm(app, e, rec) {
  const { db } = app;
  const hist = repo.variantHistory(db, e.variant_id, { excludeSessionId: e.session_id });
  const lastHist = hist.filter((x) => x.session.fidelity !== 'partial_reconstruction').flatMap((x) => x.sets).filter(isWorking).pop();
  const lastHere = e.sets.filter((s) => !s.deleted).pop();
  const inc = inferIncrement(hist, { increment_kg: e.increment_kg, load_type: e.load_type });
  const sided = (s) => s?.sides?.length > 0;
  const d = app.drafts[e.id] ?? {
    set_type: e.sets.length || lastHist ? 'working' : 'warmup',
    load_kg: lastHere?.load_kg ?? rec.load_kg ?? lastHist?.load_kg ?? null,
    reps: lastHere?.reps ?? (rec.load_kg !== null ? rec.rep_min : null) ?? lastHist?.reps ?? null,
    rir: null,
    perSide: e.laterality === 'unilateral' || sided(lastHere) || sided(lastHist),
    L: { reps: null, rir: null },
    R: { reps: null, rir: null },
    technique: null,
  };
  if (d.perSide) {
    d.L.reps ??= d.reps;
    d.R.reps ??= d.reps;
  }
  app.drafts[e.id] = d;

  const type = segmented([['warmup', 'Warm-up'], ['working', 'Working'], ['calibration', 'Calib.']], d.set_type, (v) => { d.set_type = v; }, 'Set type');
  const load = stepper({ label: 'Weight', unit: app.fmtLoad(0, e.load_basis, e.exercise_name).replace(/^0 /, ''), value: d.load_kg, step: () => inc.kg, decimals: 2,
    toDisplay: (x) => app.toDisplay(x), fromDisplay: (x) => app.fromDisplay(x), onChange: (v) => { d.load_kg = v; } });
  const reps = stepper({ label: 'Reps', value: d.reps, step: 1, decimals: 0, onChange: (v) => { d.reps = v; } });
  const rir = rirPicker({ value: d.rir, onChange: (v) => { d.rir = v; } });
  const side = (k, name) => {
    const r = stepper({ label: `${name} reps`, value: d[k].reps, step: 1, decimals: 0, onChange: (v) => { d[k].reps = v; } });
    const p = rirPicker({ label: `${name} RIR`, value: d[k].rir, onChange: (v) => { d[k].rir = v; } });
    return { el: h('div', { class: 'side-block' }, r, p), r, p };
  };
  const L = side('L', 'Left');
  const R = side('R', 'Right');
  const both = h('div', { class: 'stack-s' }, reps, rir);
  const sides = h('div', { class: 'sides-grid' }, L.el, R.el);
  const perToggle = h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: d.perSide, onchange: (ev) => {
    d.perSide = ev.target.checked;
    if (d.perSide) { d.L.reps ??= d.reps; d.R.reps ??= d.reps; L.r.set(d.L.reps, false); R.r.set(d.R.reps, false); }
    draw();
  } }), h('span', {}, 'Left / right separately'));
  const tech = h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: d.technique === 'degraded', onchange: (ev) => { d.technique = ev.target.checked ? 'degraded' : null; } }), h('span', {}, 'Form broke down'));
  const el = h('div', { class: 'set-form' }, type, load, perToggle, both, sides, h('div', { class: 'row gap wrap' }, tech));
  function draw() {
    both.hidden = d.perSide;
    sides.hidden = !d.perSide;
  }
  draw();

  function fill(src) {
    if (!src) return toast('No previous set on this machine yet.');
    d.load_kg = src.load_kg;
    d.reps = src.reps;
    d.set_type = src.set_type === 'working' || src.set_type === 'warmup' || src.set_type === 'calibration' ? src.set_type : 'working';
    d.rir = src.rir_raw && !/left|right|both/.test(src.rir_raw) ? src.rir_raw : null;
    if (src.sides?.length) {
      d.perSide = true;
      for (const k of ['L', 'R']) {
        const sd = src.sides.find((x) => x.side === k);
        d[k] = { reps: sd?.reps ?? src.reps, rir: sd?.rir_raw ?? null };
      }
    }
    sync();
  }
  function sync() {
    type.set(d.set_type);
    load.set(d.load_kg, false);
    reps.set(d.reps, false);
    rir.set(d.rir);
    L.r.set(d.L.reps, false); L.p.set(d.L.rir);
    R.r.set(d.R.reps, false); R.p.set(d.R.rir);
    perToggle.querySelector('input').checked = d.perSide;
    draw();
  }
  return {
    el,
    state: () => d,
    apply(r) {
      d.load_kg = r.load_kg;
      d.reps = r.rep_min;
      d.set_type = 'working';
      if (d.perSide) { d.L.reps = r.rep_min; d.R.reps = r.rep_min; }
      sync();
    },
    copyPrevious() { fill(lastHere ?? lastHist); },
    read() {
      const base = { set_type: d.set_type, load_kg: d.load_kg, load_multiplier: multiplierFor(e.load_basis), technique: d.technique };
      if (d.perSide) {
        const sides = ['L', 'R'].map((k) => ({ side: k, reps: d[k].reps, rir: d[k].rir }));
        const same = sides[0].reps === sides[1].reps ? sides[0].reps : null;
        return { ...base, reps: same, sides };
      }
      return { ...base, reps: d.reps, rir: d.rir };
    },
  };
}

// ------------------------------------------------------------ sheets
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

export function addExerciseSheet(app, sessionId, { onPick } = {}) {
  const { db } = app;
  const all = repo.listVariants(db);
  const q = h('input', { type: 'search', placeholder: 'Search exercise or machine', 'aria-label': 'Search' });
  const list = h('div', { class: 'pick-list' });
  const ss = h('label', { class: 'switch' }, h('input', { type: 'checkbox' }), h('span', {}, 'Superset with the previous exercise'));
  let ref;
  const pick = (variantId) => {
    if (onPick) { onPick(variantId); ref.close(); return; }
    let group = null;
    if (ss.querySelector('input').checked) {
      const g = repo.getSessionGraph(db, sessionId);
      const prev = g.exercises[g.exercises.length - 1];
      if (prev) {
        group = prev.superset_group;
        if (!group) {
          const used = new Set(g.exercises.map((x) => x.superset_group).filter(Boolean));
          group = 'ABCDEFGH'.split('').find((l) => !used.has(l));
          repo.updateSessionExercise(db, prev.id, { superset_group: group }, 'superset');
        }
      }
    }
    const se = repo.addSessionExercise(db, sessionId, variantId, { superset_group: group });
    app.focus[sessionId] = se.id;
    ref.close();
    app.render();
  };
  const draw = () => {
    const term = q.value.trim().toLowerCase();
    const rows = all.filter((v) => !term || v.label.toLowerCase().includes(term))
      .sort((a, b) => (b.last_date ?? '').localeCompare(a.last_date ?? ''));
    list.replaceChildren(...rows.slice(0, 60).map((v) => h('button', { class: 'list-row', onclick: () => pick(v.id) },
      h('div', { class: 'grow' }, h('div', { class: 'row-title' }, v.exercise_name), h('div', { class: 'muted small' }, [v.brand !== 'unspecified' ? v.brand : 'brand unspecified', v.equipment_description, v.variation].filter(Boolean).join(' · '))),
      h('div', { class: 'muted tiny' }, v.last_date ? `last ${v.last_date}` : 'never'))));
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

export function cardioSheet(app, sessionId, existing = null) {
  const { db } = app;
  const c = existing ?? {};
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

function editSessionSheet(app, g) {
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

// ------------------------------------------------------------ Summary
function renderSummary(app, g) {
  const sum = summarizeSession(g, { bodyKg: bodyKg(app, g) });
  const s = g.session;
  const [fl, fk] = FIDELITY[s.fidelity] ?? [s.fidelity, ''];
  const time = s.started_at_utc
    ? `${s.time_precision === 'approximate' ? '~' : ''}${formatSgtTime(s.started_at_utc)}–${s.ended_at_utc ? formatSgtTime(s.ended_at_utc) : '?'}${s.ended_at_utc && utcToSgtDate(s.ended_at_utc) !== s.date_local ? ' (+1 day)' : ''} SGT`
    : 'Start/end time not recorded';
  const k = sum.kcal;
  return h('div', { class: 'stack' },
    h('header', { class: 'page-head' },
      h('a', { class: 'link small', href: '#/history' }, '‹ History'),
      h('div', { class: 'row between' }, h('h1', {}, s.label || 'Workout'), h('button', { class: 'icon-btn', 'aria-label': 'Edit session', onclick: () => editSessionSheet(app, g) }, '✎')),
      h('p', { class: 'muted' }, longDate(s.date_local), ' · ', time),
      h('div', { class: 'row gap-s wrap' }, badge(fl, fk), s.focus && badge(s.focus))),
    h('div', { class: 'tiles' },
      tile('Working sets', sum.workingSets, sum.counts.warmup || sum.counts.calibration || sum.counts.ambiguous
        ? `+ ${[sum.counts.warmup && `${sum.counts.warmup} warm-up`, sum.counts.calibration && `${sum.counts.calibration} calibration`, sum.counts.ambiguous && `${sum.counts.ambiguous} unclear`].filter(Boolean).join(', ')} (not counted)` : 'warm-ups & calibration excluded'),
      tile('Nominal volume', app.fmtVol(sum.volumeKg), 'weight × reps × sides, working sets only'),
      tile('Duration', sum.duration.minutes !== null ? `${sum.duration.minutes} min` : '—', sum.duration.source),
      tile('Energy (estimate)', k.total ? `${k.total.min}–${k.total.max} kcal` : '—', k.total ? 'range, see assumptions' : 'not enough data')),
    s.fidelity === 'partial_reconstruction' && h('div', { class: 'card warn-card' },
      h('p', {}, 'Partial reconstruction: these lines were summarised after the fact. Set types and RIR are unknown, so nothing here counts toward working sets, volume or PRs.')),
    g.partials.length > 0 && h('section', { class: 'card' }, h('h3', {}, 'Summary as recorded'),
      h('ul', { class: 'plain' }, ...g.partials.map((p) => h('li', {}, p.text, ' ', badge(p.parse_status === 'parsed' ? 'read into sets' : 'text only', p.parse_status === 'parsed' ? '' : 'muted'))))),
    ...g.exercises.map((e) => h('section', { class: 'card' },
      h('div', { class: 'row between' },
        h('a', { class: 'ex-link', href: `#/exercise/${e.variant_id}` }, h('div', { class: 'ex-name' }, e.exercise_name), h('div', { class: 'muted small' }, [e.brand !== 'unspecified' ? e.brand : 'brand unspecified', e.equipment_description, e.variation].filter(Boolean).join(' · '))),
        h('div', { class: 'right' }, h('div', {}, app.fmtVol(sum.perExercise.find((x) => x.id === e.id)?.volume ?? 0)), h('div', { class: 'muted tiny' }, `${e.sets.filter(isWorking).length} working`))),
      e.superset_group && h('div', { class: 'tiny muted' }, `Superset ${e.superset_group}`),
      e.raw_variation && h('div', { class: 'tiny muted' }, `Logged as: ${e.raw_variation}`),
      e.notes && h('div', { class: 'tiny muted' }, `Note: ${e.notes}`),
      h('div', { class: 'set-list' }, ...e.sets.map((x) => setLine(app, e, x, { onEdit: () => editSetSheet(app, e, x) }))))),
    (g.cardio.length > 0 || true) && h('section', { class: 'card' },
      h('div', { class: 'row between' }, h('h3', {}, 'Cardio'), h('button', { class: 'link small', onclick: () => cardioSheet(app, s.id) }, '+ Add')),
      g.cardio.length ? sum.cardio.map((c) => cardioBlock(app, c, true)) : h('p', { class: 'muted small' }, 'None recorded.')),
    h('section', { class: 'card' },
      h('h3', {}, 'Energy'),
      h('dl', { class: 'kv' },
        dt('Strength (model)', k.strength ? `${k.strength.min}–${k.strength.max} kcal` : '—'),
        dt('Cardio (model)', sum.cardio.some((c) => c.kcal.model) ? sum.cardio.filter((c) => c.kcal.model).map((c) => `${c.kcal.model.min}–${c.kcal.model.max}`).join(' + ') + ' kcal' : '—'),
        dt('Cardio (machine display)', k.machineCardio ? `${k.machineCardio} kcal` : '—'),
        dt('Estimate in your notes', k.reported ? `${k.reported.min}–${k.reported.max} kcal` : '—')),
      h('details', {}, h('summary', { class: 'small' }, 'Assumptions'), h('ul', { class: 'small muted' }, ...sum.assumptions.map((a) => h('li', {}, a)),
        h('li', {}, 'Machine and model figures are shown side by side and never merged.')))),
    g.session.notes.length > 0 && h('section', { class: 'card' }, h('h3', {}, 'Notes (verbatim)'), h('ul', { class: 'small' }, ...g.session.notes.map((n) => h('li', {}, stripMd(n))))),
  );
}

function dt(k, v) {
  return [h('dt', {}, k), h('dd', {}, v)];
}

function tile(label, value, sub) {
  return h('div', { class: 'tile' }, h('div', { class: 'tile-label' }, label), h('div', { class: 'tile-val' }, String(value)), sub && h('div', { class: 'tile-sub' }, sub));
}

export function cardioBlock(app, c, editable) {
  const bits = [
    c.duration_sec && formatDuration(c.duration_sec),
    c.distance_km && `${c.distance_km} km`,
    c.avg_speed_kmh && `${c.avg_speed_kmh} km/h`,
    c.incline_pct !== null && c.incline_pct !== undefined && `${c.incline_pct}% incline`,
    c.elevation_gain_m && `${c.elevation_gain_m} m climbed`,
    c.avg_hr && `avg HR ${c.avg_hr}`,
    c.max_hr && `max ${c.max_hr}`,
  ].filter(Boolean);
  const k = c.kcal;
  return h('div', { class: 'cardio' },
    h('div', { class: 'row between' },
      h('div', {}, h('strong', {}, c.type.replace(/_/g, ' ')), c.equipment_brand ? h('span', { class: 'muted' }, ` · ${c.equipment_brand}`) : null),
      editable && h('button', { class: 'link small', onclick: () => cardioSheet(app, c.session_id, c) }, 'Edit')),
    h('div', { class: 'small' }, bits.join(' · ') || 'No metrics recorded'),
    h('div', { class: 'small muted' },
      `Handrails: ${c.handrail_support ?? 'not recorded'}`,
      k.machine ? ` · machine ${k.machineApprox ? '~' : ''}${k.machine} kcal` : '',
      k.reported ? ` · noted ${k.reported.min === k.reported.max ? `~${k.reported.min}` : `${k.reported.min}–${k.reported.max}`} kcal` : '',
      k.model ? ` · model ${k.model.min}–${k.model.max} kcal` : ''),
    c.fidelity === 'parsed_from_note' && h('div', { class: 'tiny muted' }, `Read from note: “${c.raw_text}”`));
}

function elapsed(startIso) {
  return startIso ? formatDuration(Math.max(0, (Date.now() - Date.parse(startIso)) / 1000)) : '';
}
