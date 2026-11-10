// Finished workout summary, and the read-only pieces it shares with the logger.
import { h, badge, longDate } from './ui.js';
import * as repo from '../lib/db/repo.js';
import { summarizeSession } from '../lib/domain/summary.js';
import { isWorking, setVolume } from '../lib/domain/sets.js';
import { formatSgtTime, formatDuration, utcToSgtDate } from '../lib/domain/time.js';
import { stripMd } from '../lib/io/parse.js';
import { muscleSets } from '../lib/domain/insights.js';
import { cardioSheet, editSessionSheet, editSetSheet, TYPE_LABEL } from './sheets.js';

const TYPE_SHORT = { warmup: 'WU', working: 'W', calibration: 'CAL', ambiguous: '?', unclassified: '·' };
const SUBTYPE_SHORT = { failure: 'F', drop: 'D' };
export const FIDELITY = {
  set_by_set: ['Detailed log', 'ok'],
  partial_reconstruction: ['Partial reconstruction', 'warn'],
  live: ['Logged live', 'ok'],
};

export function setLine(app, e, s, { onEdit } = {}) {
  const sides = s.sides.length
    ? s.sides.map((x) => `${x.side} ${x.reps ?? s.reps ?? '?'}${x.rir_raw !== null ? ` @${x.rir_raw}` : ''}`).join(' · ')
    : null;
  const vol = s.set_type === 'working' ? setVolume(s) : null;
  return h('button', { class: `set-line ${s.deleted ? 'deleted' : ''} t-${s.set_type}`, onclick: onEdit, 'aria-label': `Edit set ${s.position + 1}` },
    h('span', { class: `set-type`, title: TYPE_LABEL[s.set_type] }, SUBTYPE_SHORT[s.set_subtype] ?? TYPE_SHORT[s.set_type] ?? s.set_type),
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

export function renderSummary(app, g) {
  const sum = summarizeSession(g, { bodyKg: repo.latestBodyWeight(app.db, g.session.date_local) });
  const s = g.session;
  return h('div', { class: 'stack' },
    summaryHeader(app, g),
    totalsTiles(app, sum),
    s.fidelity !== 'partial_reconstruction' && prSection(app, s.id),
    s.fidelity !== 'partial_reconstruction' && muscleSection(app, s.id),
    s.fidelity === 'partial_reconstruction' && h('div', { class: 'card warn-card' },
      h('p', {}, 'Partial reconstruction: these lines were summarised after the fact. Set types and RIR are unknown, so nothing here counts toward working sets, volume or PRs.')),
    g.partials.length > 0 && h('section', { class: 'card' }, h('h3', {}, 'Summary as recorded'),
      h('ul', { class: 'plain' }, ...g.partials.map((p) => h('li', {}, p.text, ' ', badge(p.parse_status === 'parsed' ? 'read into sets' : 'text only', p.parse_status === 'parsed' ? '' : 'muted'))))),
    ...g.exercises.map((e) => exerciseSection(app, e, sum)),
    h('section', { class: 'card' },
      h('div', { class: 'row between' }, h('h3', {}, 'Cardio'), h('button', { class: 'link small', onclick: () => cardioSheet(app, s.id) }, '+ Add')),
      g.cardio.length ? sum.cardio.map((c) => cardioBlock(app, c, true)) : h('p', { class: 'muted small' }, 'None recorded.')),
    energySection(sum),
    s.notes.length > 0 && h('section', { class: 'card' }, h('h3', {}, 'Notes (verbatim)'), h('ul', { class: 'small' }, ...s.notes.map((n) => h('li', {}, stripMd(n))))),
  );
}

function summaryHeader(app, g) {
  const s = g.session;
  const [fl, fk] = FIDELITY[s.fidelity] ?? [s.fidelity, ''];
  const time = s.started_at_utc
    ? `${s.time_precision === 'approximate' ? '~' : ''}${formatSgtTime(s.started_at_utc)}–${s.ended_at_utc ? formatSgtTime(s.ended_at_utc) : '?'}${s.ended_at_utc && utcToSgtDate(s.ended_at_utc) !== s.date_local ? ' (+1 day)' : ''} SGT`
    : 'Start/end time not recorded';
  return h('header', { class: 'page-head' },
    h('a', { class: 'link small', href: '#/history' }, '‹ History'),
    h('div', { class: 'row between' }, h('h1', {}, s.label || 'Workout'), h('button', { class: 'icon-btn', 'aria-label': 'Edit session', onclick: () => editSessionSheet(app, g) }, '✎')),
    h('p', { class: 'muted' }, longDate(s.date_local), ' · ', time),
    h('div', { class: 'row gap-s wrap' }, badge(fl, fk), s.focus && badge(s.focus)));
}

function prSection(app, sessionId) {
  const prs = repo.sessionPRs(app.db, sessionId);
  if (!prs.length) return null;
  const say = (p) => (p.kind === 'load' ? `heaviest (was ${app.fmtDisplay(p.beat)} ${app.units})` : p.kind === 'reps' ? `most reps at this weight (was ${p.beat})` : `best set volume (was ${app.fmtVol(p.beat)})`);
  return h('section', { class: 'card tight' }, h('h3', {}, h('span', { class: 'pr-tag' }, 'PR'), ` ${prs.length} record${prs.length === 1 ? '' : 's'}`),
    ...prs.map((p) => h('a', { class: 'list-row', href: `#/exercise/${p.variant_id}` },
      h('div', { class: 'grow' }, h('div', { class: 'row-title' }, p.exercise_name), h('div', { class: 'small muted' }, `${app.fmtLoad(p.set.load_kg, p.load_basis, p.exercise_name)} × ${p.set.reps ?? '?'}: ${p.prs.map(say).join('; ')}`)))));
}

function muscleSection(app, sessionId) {
  const m = muscleSets(repo.insightRows(app.db).filter((r) => r.session_id === sessionId), repo.getMuscles(app.db));
  const list = Object.entries(m.byMuscle).sort((a, b) => b[1] - a[1]);
  if (!list.length && !m.unassigned) return null;
  return h('section', { class: 'card tight' }, h('h3', {}, 'Muscles'),
    h('div', { class: 'chips-row' }, ...list.map(([k, n]) => h('span', { class: 'mchip' }, `${k} `, h('strong', {}, Number.isInteger(n) ? n : n.toFixed(1))))),
    h('p', { class: 'tiny muted' }, 'Working sets: main muscle 1, secondary ½.',
      m.unassigned ? [' ', h('a', { href: '#/exercises/machines' }, `${m.unassigned} set${m.unassigned === 1 ? '' : 's'} need a muscle chosen.`)] : ''));
}

function totalsTiles(app, sum) {
  const k = sum.kcal;
  const c = sum.counts;
  const extra = [c.warmup && `${c.warmup} warm-up`, c.calibration && `${c.calibration} calibration`, c.ambiguous && `${c.ambiguous} unclear`].filter(Boolean);
  return h('div', { class: 'tiles' },
    tile('Working sets', sum.workingSets, extra.length ? `+ ${extra.join(', ')} (not counted)` : 'warm-ups & calibration excluded'),
    tile('Nominal volume', app.fmtVol(sum.volumeKg), 'weight × reps × sides, working sets only'),
    tile('Duration', sum.duration.minutes !== null ? `${sum.duration.minutes} min` : '—', sum.duration.source),
    tile('Energy (estimate)', k.total ? `${k.total.min}–${k.total.max} kcal` : '—', k.total ? 'range, see assumptions' : 'not enough data'));
}

function exerciseSection(app, e, sum) {
  return h('section', { class: 'card' },
    h('div', { class: 'row between' },
      h('a', { class: 'ex-link', href: `#/exercise/${e.variant_id}` }, h('div', { class: 'ex-name' }, e.exercise_name), h('div', { class: 'muted small' }, [e.brand !== 'unspecified' ? e.brand : 'brand unspecified', e.equipment_description, e.variation].filter(Boolean).join(' · '))),
      h('div', { class: 'right' }, h('div', {}, app.fmtVol(sum.perExercise.find((x) => x.id === e.id)?.volume ?? 0)), h('div', { class: 'muted tiny' }, `${e.sets.filter(isWorking).length} working`))),
    e.superset_group && h('div', { class: 'tiny muted' }, `Superset ${e.superset_group}`),
    e.raw_variation && h('div', { class: 'tiny muted' }, `Logged as: ${e.raw_variation}`),
    e.notes && h('div', { class: 'tiny muted' }, `Note: ${e.notes}`),
    h('div', { class: 'set-list' }, ...e.sets.map((x) => setLine(app, e, x, { onEdit: () => editSetSheet(app, e, x) }))));
}

function energySection(sum) {
  const k = sum.kcal;
  return h('section', { class: 'card' },
    h('h3', {}, 'Energy'),
    h('dl', { class: 'kv' },
      dt('Strength (model)', k.strength ? `${k.strength.min}–${k.strength.max} kcal` : '—'),
      dt('Cardio (model)', sum.cardio.some((c) => c.kcal.model) ? sum.cardio.filter((c) => c.kcal.model).map((c) => `${c.kcal.model.min}–${c.kcal.model.max}`).join(' + ') + ' kcal' : '—'),
      dt('Cardio (machine display)', k.machineCardio ? `${k.machineCardio} kcal` : '—'),
      dt('Estimate in your notes', k.reported ? `${k.reported.min}–${k.reported.max} kcal` : '—')),
    h('details', {}, h('summary', { class: 'small' }, 'Assumptions'), h('ul', { class: 'small muted' }, ...sum.assumptions.map((a) => h('li', {}, a)),
      h('li', {}, 'Machine and model figures are shown side by side and never merged.'))));
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
