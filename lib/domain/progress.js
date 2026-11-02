// Personal records and trend series for ONE exercise variant (exact
// exercise + machine + variation). Never mixes machines.
import { isWorking, setVolume, effectiveReps, epley, round } from './sets.js';

// history: [{ session: { id, date_local, fidelity }, sets: [...] }] in date order.
function eligible(history, { includeReconstructed = false } = {}) {
  return history.filter((h) => includeReconstructed || h.session.fidelity !== 'partial_reconstruction');
}

export function personalRecords(history, opts = {}) {
  const rows = [];
  for (const h of eligible(history, opts)) {
    for (const s of h.sets) {
      if (!isWorking(s) || s.load_kg === null) continue;
      const reps = effectiveReps(s);
      if (!reps) continue;
      rows.push({ s, reps, date: h.session.date_local, session_id: h.session.id });
    }
  }
  if (!rows.length) return null;

  const pick = (score) => rows.reduce((best, r) => (score(r) > score(best) ? r : best));
  const fmt = (r) => ({ set_id: r.s.id, date: r.date, load_kg: r.s.load_kg, reps: r.reps, rir_raw: r.s.rir_raw ?? null });

  const heaviest = pick((r) => r.s.load_kg * 1000 + r.reps);
  const e1 = pick((r) => (r.reps <= 15 ? epley(r.s.load_kg, r.reps) : 0));
  const vol = pick((r) => setVolume(r.s) ?? 0);

  // Most reps achieved at each load.
  const byLoad = new Map();
  for (const r of rows) {
    const cur = byLoad.get(r.s.load_kg);
    if (!cur || r.reps > cur.reps) byLoad.set(r.s.load_kg, r);
  }
  const repPRs = [...byLoad.values()].sort((a, b) => b.s.load_kg - a.s.load_kg).map(fmt);

  // Per-side best reps where sides were logged.
  const sides = {};
  for (const side of ['L', 'R']) {
    let best = null;
    for (const r of rows) {
      const sd = (r.s.sides || []).find((x) => x.side === side && x.reps);
      if (sd && (!best || r.s.load_kg * 1000 + sd.reps > best.load_kg * 1000 + best.reps)) {
        best = { load_kg: r.s.load_kg, reps: sd.reps, rir_raw: sd.rir_raw, date: r.date };
      }
    }
    if (best) sides[side] = best;
  }

  const sessionVols = sessionSeries(history, opts);
  const bestSession = sessionVols.reduce((b, x) => (x.volume > (b?.volume ?? -1) ? x : b), null);

  return {
    heaviest: fmt(heaviest),
    bestE1rm: e1.reps <= 15 ? { ...fmt(e1), e1rm: round(epley(e1.s.load_kg, e1.reps), 1) } : null,
    bestSetVolume: { ...fmt(vol), volume: round(setVolume(vol.s), 1) },
    bestSessionVolume: bestSession ? { date: bestSession.date, volume: bestSession.volume } : null,
    repPRs,
    sides,
  };
}

export function sessionSeries(history, opts = {}) {
  const out = [];
  for (const h of eligible(history, opts)) {
    const work = h.sets.filter((s) => isWorking(s) && s.load_kg !== null);
    const any = h.sets.filter((s) => !s.deleted && s.load_kg !== null);
    if (!any.length) continue;
    const pool = work.length ? work : any;
    const top = pool.reduce((b, s) => (s.load_kg > b.load_kg || (s.load_kg === b.load_kg && (effectiveReps(s) ?? 0) > (effectiveReps(b) ?? 0)) ? s : b));
    const e1 = Math.max(0, ...pool.map((s) => { const r = effectiveReps(s); return r && r <= 15 ? epley(s.load_kg, r) : 0; }));
    out.push({
      date: h.session.date_local,
      session_id: h.session.id,
      fidelity: h.session.fidelity,
      workingOnly: work.length > 0,
      topLoad: top.load_kg,
      topReps: effectiveReps(top),
      e1rm: e1 ? round(e1, 1) : null,
      volume: round(work.reduce((a, s) => a + (setVolume(s) ?? 0), 0), 1),
      workingSets: work.length,
    });
  }
  return out;
}
