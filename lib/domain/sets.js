// Set classification and nominal volume.

export function normalizeSetType(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return { type: 'unclassified', subtype: null };
  if (s === 'ramp-up/working' || s.includes('/')) return { type: 'ambiguous', subtype: null };
  if (s === 'working' || s === 'work') return { type: 'working', subtype: null };
  if (s === 'top set' || s === 'top') return { type: 'working', subtype: 'top' };
  if (s === 'back-off' || s === 'backoff' || s === 'back off') return { type: 'working', subtype: 'backoff' };
  if (s === 'failure' || s === 'failure set') return { type: 'working', subtype: 'failure' };
  if (s === 'drop' || s === 'drop set' || s === 'dropset') return { type: 'working', subtype: 'drop' };
  if (['warmup', 'warm-up', 'warm up', 'ramp-up', 'ramp up', 'rampup'].includes(s)) return { type: 'warmup', subtype: null };
  if (s === 'calibration') return { type: 'calibration', subtype: null };
  return { type: 'unclassified', subtype: null };
}

export const isActive = (set) => !set.deleted;
export const isWorking = (set) => isActive(set) && set.set_type === 'working';

// Nominal volume of one set in kg.
// - Per-side rep counts present: load × reps for each reported side
//   (asymmetry is kept, not averaged; a missing side contributes nothing).
// - Otherwise: load × reps × load_multiplier (2 = per side/arm, 1 = stack total).
// Partial reps are not counted. Returns null when load or reps are unknown.
export function setVolume(set) {
  if (set.load_kg === null || set.load_kg === undefined) return null;
  const sideReps = (set.sides || []).filter((s) => s.reps !== null && s.reps !== undefined);
  if (sideReps.length) return sideReps.reduce((a, s) => a + set.load_kg * s.reps, 0);
  if (set.reps === null || set.reps === undefined) return null;
  return set.load_kg * set.reps * (set.load_multiplier ?? 1);
}

// Only confirmed working sets count toward volume and the set tally.
export function workingVolume(sets) {
  let kg = 0;
  let unknown = 0;
  for (const s of sets) {
    if (!isWorking(s)) continue;
    const v = setVolume(s);
    if (v === null) unknown++;
    else kg += v;
  }
  return { kg: round(kg, 2), setsWithUnknownVolume: unknown };
}

export function countByType(sets) {
  const out = { working: 0, warmup: 0, calibration: 0, ambiguous: 0, unclassified: 0 };
  for (const s of sets) if (isActive(s)) out[s.set_type] = (out[s.set_type] ?? 0) + 1;
  return out;
}

// Reps used for comparisons: the weaker reported side when sided.
export function effectiveReps(set) {
  const r = (set.sides || []).map((s) => s.reps).filter((v) => v !== null && v !== undefined);
  return r.length ? Math.min(...r) : set.reps ?? null;
}

export const epley = (load, reps) => (load > 0 && reps > 0 ? load * (1 + reps / 30) : null);

export function round(n, dp = 1) {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
