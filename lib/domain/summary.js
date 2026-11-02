// Workout summary: confirmed working sets, nominal volume, cardio, duration and
// energy range with its assumptions.
import { countByType, workingVolume, setVolume, isWorking, round } from './sets.js';
import { sessionDuration } from './time.js';
import { strengthKcal, cardioKcal } from './calories.js';

// graph: { session, exercises: [{ id, label, sets: [...] }], cardio: [...] }
export function summarizeSession(graph, { bodyKg } = {}) {
  const allSets = graph.exercises.flatMap((e) => e.sets);
  const counts = countByType(allSets);
  const vol = workingVolume(allSets);
  const perExercise = graph.exercises.map((e) => ({
    id: e.id,
    label: e.label,
    workingSets: e.sets.filter(isWorking).length,
    volume: round(e.sets.filter(isWorking).reduce((a, s) => a + (setVolume(s) ?? 0), 0), 2),
  }));

  const duration = sessionDuration(graph.session);
  const cardioSec = graph.cardio.reduce((a, c) => a + (c.duration_sec || 0), 0);
  const weight = graph.session.body_weight_kg ?? bodyKg ?? null;
  const assumptions = [];
  if (!graph.session.body_weight_kg && bodyKg) assumptions.push(`body weight ${bodyKg} kg (most recent weight on record for this date)`);

  const cardio = graph.cardio.map((c) => ({ ...c, kcal: cardioKcal(c, weight) }));

  let strength = null;
  if (duration.minutes !== null && counts.working > 0) {
    const strengthMin = Math.max(0, duration.minutes - cardioSec / 60);
    strength = strengthKcal(weight, strengthMin);
    if (strength) assumptions.push(strength.assumption + (cardioSec ? ' (session time minus cardio)' : ''));
  } else if (counts.working > 0) {
    assumptions.push('session duration unknown — strength energy not estimated');
  }

  let total = null;
  const cardioModel = cardio.map((c) => c.kcal.model);
  if (strength || cardioModel.some(Boolean)) {
    const parts = [strength, ...cardioModel].filter(Boolean);
    total = { min: parts.reduce((a, p) => a + p.min, 0), max: parts.reduce((a, p) => a + p.max, 0) };
    if (cardioModel.some((m) => !m)) assumptions.push('some cardio lacked data for a model estimate and is excluded from the total');
  }
  for (const c of cardio) for (const n of c.kcal.notes) assumptions.push(`${c.type}: ${n}`);

  return {
    counts,
    workingSets: counts.working,
    volumeKg: vol.kg,
    setsWithUnknownVolume: vol.setsWithUnknownVolume,
    perExercise,
    duration,
    cardio,
    cardioSec,
    kcal: {
      strength: strength ? { min: strength.min, max: strength.max } : null,
      total,
      machineCardio: cardio.reduce((a, c) => a + (c.kcal.machine || 0), 0) || null,
      reported: graph.session.reported_kcal_min !== null && graph.session.reported_kcal_min !== undefined
        ? { min: graph.session.reported_kcal_min, max: graph.session.reported_kcal_max }
        : null,
    },
    assumptions,
  };
}
