// Today screen, and routing a session to the live logger or its summary.
import { h, sheet, field, badge, longDate } from './ui.js';
import * as repo from '../lib/db/repo.js';
import { elapsedSince, formatSgtTime } from '../lib/domain/time.js';
import { renderLive } from './logger.js';
import { renderSummary, FIDELITY } from './summary.js';

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
      h('div', { class: 'muted' }, 'Started ', formatSgtTime(active.started_at_utc), ' · ', h('span', { 'data-elapsed': active.started_at_utc }, elapsedSince(active.started_at_utc)), ' elapsed'),
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
  const found = repo.getSessionGraph(app.db, id);
  if (found?.session.status === 'active') repo.prepareLiveRows(app.db, id);
  const g = found?.session.status === 'active' ? repo.getSessionGraph(app.db, id) : found;
  if (!g) return h('div', { class: 'card' }, h('p', {}, 'Session not found.'), h('a', { href: '#/history' }, 'Back to history'));
  return g.session.status === 'active' ? renderLive(app, g) : renderSummary(app, g);
}
