// Plan builder: rotations of days, each day a list of exercises with sets,
// rep range, RIR, rest, superset letter and substitutes.
import { h, sheet, field, numInput, numVal, toast, confirmSheet, badge } from './ui.js';
import * as repo from '../lib/db/repo.js';
import { repRangeFor } from '../lib/domain/recommend.js';
import { formatRir } from '../lib/domain/rir.js';
import { addExerciseSheet, startFromDay } from './session.js';

export function renderPlan(app) {
  const { db } = app;
  const plans = repo.listPlans(db);
  return h('div', { class: 'stack' },
    h('header', { class: 'page-head' }, h('h1', {}, 'Plan'), h('p', { class: 'muted' }, 'Days rotate in order; Today shows whichever is next.')),
    ...plans.map((p) => planCard(app, p)),
    h('button', { class: 'btn block', onclick: () => promptName('New plan', '', (name) => { repo.createPlan(db, name, { is_active: plans.length ? 0 : 1 }); app.render(); }) }, '+ New plan'));
}

function planCard(app, p) {
  const { db } = app;
  const next = repo.nextPlanDay(db, p.id);
  return h('section', { class: `card ${p.is_active ? 'focused' : ''}` },
    h('div', { class: 'row between' },
      h('div', {}, h('h2', { class: 'plan-name' }, p.name), p.is_active ? badge('Active', 'live') : null),
      h('div', { class: 'row gap-s' },
        !p.is_active && h('button', { class: 'btn small', onclick: () => { repo.updatePlan(db, p.id, { is_active: 1 }); app.render(); } }, 'Make active'),
        h('button', { class: 'icon-btn', 'aria-label': 'Rename plan', onclick: () => promptName('Rename plan', p.name, (n) => { repo.updatePlan(db, p.id, { name: n }); app.render(); }) }, '✎'))),
    p.notes && h('p', { class: 'small muted' }, p.notes),
    ...p.days.map((d) => dayBlock(app, p, d, next?.id === d.id)),
    h('div', { class: 'row gap wrap' },
      h('button', { class: 'btn small', onclick: () => promptName('New day', `Day ${p.days.length + 1}`, (n) => { repo.addPlanDay(db, p.id, n); app.render(); }) }, '+ Day'),
      h('button', { class: 'btn small danger', onclick: () => confirmSheet('Delete plan?', 'Logged sessions are kept.', 'Delete', () => { repo.deletePlan(db, p.id); app.render(); }, { danger: true }) }, 'Delete plan')));
}

function dayBlock(app, p, d, isNext) {
  const { db } = app;
  return h('div', { class: 'plan-day' },
    h('div', { class: 'row between' },
      h('div', {}, h('h3', {}, `${d.position + 1}. ${d.name}`), isNext && badge('Up next', 'live')),
      h('div', { class: 'row gap-s' },
        h('button', { class: 'icon-btn', 'aria-label': 'Rename day', onclick: () => promptName('Rename day', d.name, (n) => { repo.updatePlanDay(db, d.id, { name: n }); app.render(); }) }, '✎'),
        h('button', { class: 'icon-btn', 'aria-label': 'Delete day', onclick: () => confirmSheet('Delete day?', d.name, 'Delete', () => { repo.deletePlanDay(db, d.id); app.render(); }, { danger: true }) }, '🗑'))),
    h('div', { class: 'stack-s' }, ...d.items.map((i) => itemRow(app, i))),
    h('div', { class: 'row gap-s wrap' },
      h('button', { class: 'btn small', onclick: () => addExerciseSheet(app, null, { onPick: (vid) => {
        const v = repo.getVariant(db, vid);
        repo.addPlanItem(db, d.id, { variant_id: vid, target_sets: 2, rir_min: 1, rir_max: 2, rest_sec: app.restFor(v.category) });
        app.render();
      } }) }, '+ Exercise'),
      d.items.length > 0 && h('button', { class: 'btn small primary', onclick: () => {
        if (repo.activeSession(db)) return toast('Finish the workout in progress first.');
        startFromDay(app, d);
      } }, 'Start this day')));
}

function itemRow(app, i) {
  const { db } = app;
  const v = i.variant;
  const [rmin, rmax] = repRangeFor(v, { category: v?.category }, i);
  return h('div', { class: 'plan-item' },
    h('button', { class: 'grow plain-btn', onclick: () => editItem(app, i) },
      h('div', { class: 'row-title' }, i.superset_group ? h('span', { class: 'ss-letter' }, i.superset_group) : null, v?.exercise_name ?? 'Missing exercise'),
      h('div', { class: 'muted small' }, [v?.brand !== 'unspecified' ? v?.brand : 'brand unspecified', v?.equipment_description, v?.variation].filter(Boolean).join(' · ')),
      h('div', { class: 'small' }, `${i.target_sets} × ${rmin}–${rmax} @ RIR ${formatRir(i.rir_min ?? 1, i.rir_max ?? 2)} · rest ${Math.round((i.rest_sec ?? app.restFor(v?.category)) / 15) * 15}s`,
        i.substitutes.length ? ` · ${i.substitutes.length} substitute${i.substitutes.length > 1 ? 's' : ''}` : '')),
    h('div', { class: 'col' },
      h('button', { class: 'icon-btn', 'aria-label': 'Move up', onclick: () => { repo.movePlanItem(db, i.id, -1); app.render(); } }, '↑'),
      h('button', { class: 'icon-btn', 'aria-label': 'Move down', onclick: () => { repo.movePlanItem(db, i.id, 1); app.render(); } }, '↓')));
}

function editItem(app, i) {
  const { db } = app;
  const v = i.variant;
  const [dmin, dmax] = repRangeFor(v, { category: v?.category });
  const sets = numInput(i.target_sets, { step: 1, inputmode: 'numeric' });
  const rmin = numInput(i.rep_min, { step: 1, inputmode: 'numeric', placeholder: String(dmin) });
  const rmax = numInput(i.rep_max, { step: 1, inputmode: 'numeric', placeholder: String(dmax) });
  const rirMin = numInput(i.rir_min, { step: 1, inputmode: 'numeric' });
  const rirMax = numInput(i.rir_max, { step: 1, inputmode: 'numeric' });
  const rest = numInput(i.rest_sec, { step: 15, inputmode: 'numeric' });
  const ss = h('input', { type: 'text', maxlength: 1, value: i.superset_group ?? '', placeholder: 'e.g. A' });
  let subs = [...i.substitutes];
  const subList = h('div', { class: 'stack-s' });
  const drawSubs = () => subList.replaceChildren(...subs.map((id) => {
    const sv = repo.getVariant(db, id);
    return h('div', { class: 'row between small' }, sv?.label ?? id, h('button', { class: 'link danger', onclick: () => { subs = subs.filter((x) => x !== id); drawSubs(); } }, 'remove'));
  }));
  drawSubs();
  let ref;
  const body = h('div', { class: 'stack' },
    h('p', { class: 'muted small' }, v?.label),
    h('div', { class: 'grid2' }, field('Working sets', sets), field('Superset group', ss)),
    h('div', { class: 'grid2' }, field('Reps min', rmin), field('Reps max', rmax)),
    h('div', { class: 'grid2' }, field('RIR min', rirMin), field('RIR max', rirMax)),
    field('Rest (sec)', rest),
    h('fieldset', { class: 'fs' }, h('legend', {}, 'Substitutes (if the machine is taken)'), subList,
      h('button', { class: 'btn small', onclick: () => addExerciseSheet(app, null, { onPick: (vid) => { if (vid !== i.variant_id && !subs.includes(vid)) subs.push(vid); drawSubs(); } }) }, '+ Substitute'),
      h('p', { class: 'tiny muted' }, 'A substitute starts from its own history; no load is carried across machines.')),
    h('div', { class: 'row gap' },
      h('button', { class: 'btn danger', onclick: () => { repo.deletePlanItem(db, i.id); ref.close(); app.render(); } }, 'Remove'),
      h('button', { class: 'btn primary grow', onclick: () => {
        repo.updatePlanItem(db, i.id, {
          target_sets: Math.max(1, numVal(sets) ?? 1), rep_min: numVal(rmin), rep_max: numVal(rmax), rir_min: numVal(rirMin), rir_max: numVal(rirMax),
          rest_sec: numVal(rest), superset_group: ss.value.trim().toUpperCase() || null, substitutes: subs,
        });
        ref.close();
        app.render();
      } }, 'Save')));
  ref = sheet(v?.exercise_name ?? 'Exercise', body);
}

function promptName(title, value, onOk) {
  const inp = h('input', { type: 'text', value });
  let ref;
  const ok = () => { if (inp.value.trim()) { ref.close(); onOk(inp.value.trim()); } };
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok(); });
  ref = sheet(title, h('div', { class: 'stack' }, inp, h('button', { class: 'btn primary block', onclick: ok }, 'Save')));
}
