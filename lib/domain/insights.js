// Weekly, monthly and calendar views, worked out from sets each time.
// Unrecorded periods are reported as unrecorded, never as time off.
import { addDays } from './time.js';
import { isWorking, setVolume, effectiveReps, epley, round } from './sets.js';

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const monthName = (ym) => `${MONTH_NAMES[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;

export function weekStart(dateLocal) {
  const [Y, M, D] = dateLocal.split('-').map(Number);
  const dow = new Date(Date.UTC(Y, M - 1, D)).getUTCDay();
  return addDays(dateLocal, -((dow + 6) % 7));
}

export function addMonths(ym, n) {
  const [Y, M] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(Y, M - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

const counted = (r) => !r.deleted && r.fidelity !== 'partial_reconstruction' && r.set_fidelity !== 'reconstructed';

// Primary muscle 1 per working set, each secondary ½. Unclear sets are counted as excluded.
export function muscleSets(rows, assignments) {
  const byMuscle = {};
  let unassigned = 0;
  let excluded = 0;
  const add = (m, n) => { byMuscle[m] = (byMuscle[m] ?? 0) + n; };
  for (const r of rows) {
    if (!counted(r)) continue;
    if (r.set_type === 'ambiguous' || r.set_type === 'unclassified') { excluded++; continue; }
    if (r.set_type !== 'working') continue;
    const a = assignments.get(r.exercise_id);
    if (!a?.primary && !a?.secondary?.length) { unassigned++; continue; }
    if (a.primary) add(a.primary, 1);
    for (const m of a.secondary) add(m, 0.5);
  }
  return { byMuscle, unassigned, excluded };
}

export function targetStatus(count, [min, max]) {
  if (!count) return 'none';
  if (count < min) return 'below';
  if (count > max) return 'above';
  return 'within';
}

function periodStatus(sessions) {
  if (sessions.some((s) => s.fidelity !== 'partial_reconstruction')) return 'recorded';
  return sessions.length ? 'partial_only' : 'not_recorded';
}

export function weekSummary({ rows, sessions, assignments, monday }) {
  const end = addDays(monday, 7);
  const inWeek = (d) => d && d >= monday && d < end;
  const weekSessions = sessions.filter((s) => inWeek(s.date_local));
  return {
    monday,
    status: periodStatus(weekSessions),
    sessions: weekSessions,
    ...muscleSets(rows.filter((r) => inWeek(r.date_local)), assignments),
  };
}

// Month grid, Monday-first, with each day's sessions. Undated sessions are returned apart.
export function calendarMonth(sessions, ym) {
  const first = `${ym}-01`;
  const start = weekStart(first);
  const byDate = new Map();
  for (const s of sessions) {
    if (!s.date_local) continue;
    if (!byDate.has(s.date_local)) byDate.set(s.date_local, []);
    byDate.get(s.date_local).push(s);
  }
  const weeks = [];
  let d = start;
  while (d.slice(0, 7) <= ym || weeks.length === 0) {
    const week = [];
    for (let i = 0; i < 7; i++, d = addDays(d, 1)) week.push({ date: d, inMonth: d.slice(0, 7) === ym, sessions: byDate.get(d) ?? [] });
    weeks.push(week);
    if (d.slice(0, 7) > ym) break;
  }
  return { weeks, undated: sessions.filter((s) => !s.date_local) };
}

function monthTotals(rows, sessions, cardio, ym) {
  const inMonth = (d) => d && d.slice(0, 7) === ym;
  const detailed = sessions.filter((s) => inMonth(s.date_local) && s.fidelity !== 'partial_reconstruction');
  const work = rows.filter((r) => inMonth(r.date_local) && counted(r) && isWorking(r));
  return {
    sessions: detailed.length,
    workingSets: work.length,
    volumeKg: round(work.reduce((a, r) => a + (setVolume(r) ?? 0), 0), 2),
    cardioSec: cardio.filter((c) => inMonth(c.date_local) && c.fidelity !== 'partial_reconstruction').reduce((a, c) => a + (c.duration_sec ?? 0), 0),
  };
}

// Best estimated 1RM this month against the best before it, per machine only.
function improvements(rows, ym) {
  const best = (list) => Math.max(0, ...list.map((r) => { const reps = effectiveReps(r); return reps && reps <= 15 ? epley(r.load_kg, reps) : 0; }));
  const byVariant = new Map();
  for (const r of rows) {
    if (!counted(r) || !isWorking(r) || r.load_kg === null || !r.date_local) continue;
    if (!byVariant.has(r.variant_id)) byVariant.set(r.variant_id, []);
    byVariant.get(r.variant_id).push(r);
  }
  const out = [];
  for (const [variant_id, list] of byVariant) {
    const after = best(list.filter((r) => r.date_local.slice(0, 7) === ym));
    const before = best(list.filter((r) => r.date_local.slice(0, 7) < ym));
    if (after && before && after > before) out.push({ variant_id, before: round(before, 1), after: round(after, 1), pct: round(((after - before) / before) * 100, 1) });
  }
  return out.sort((a, b) => b.pct - a.pct).slice(0, 5);
}

export function monthReport({ rows, sessions, cardio, prs = [], month, today }) {
  const totals = monthTotals(rows, sessions, cardio, month);
  const prev = addMonths(month, -1);
  const before = monthTotals(rows, sessions, cardio, prev);
  const partialDates = [...new Set(sessions
    .filter((s) => s.date_local?.slice(0, 7) === month && s.fidelity === 'partial_reconstruction')
    .map((s) => s.date_local))].sort();
  let comparison = null;
  let comparisonNote = null;
  if (!totals.sessions) comparisonNote = `No detailed records for ${monthName(month)}.`;
  else if (!before.sessions) comparisonNote = `No detailed records for ${monthName(prev)}, so there is nothing to compare with.`;
  else {
    comparison = {
      sessions: totals.sessions - before.sessions,
      workingSets: totals.workingSets - before.workingSets,
      volumeKg: round(totals.volumeKg - before.volumeKg, 2),
    };
  }
  return {
    month,
    ...totals,
    prs: prs.filter((p) => p.date_local?.slice(0, 7) === month),
    partialDates,
    inProgress: today.slice(0, 7) === month,
    comparison,
    comparisonNote,
    improvements: improvements(rows, month),
  };
}
