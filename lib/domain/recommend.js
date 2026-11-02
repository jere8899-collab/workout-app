// Next-set recommendations using double progression on the EXACT variant.
//
// Inputs only come from the same exercise + machine + variation. History from
// other machines is surfaced as "reference only" and never converted.
// The output is a suggestion; nothing here creates a set.
import { isWorking, effectiveReps, round } from './sets.js';
import { conservativeRir, formatRir } from './rir.js';

export const DEFAULT_REP_RANGE = {
  compound: [8, 12],
  isolation: [10, 15],
  core: [12, 20],
};
export const DEFAULT_RIR = [1, 2];

export function repRangeFor(variant, exercise, target) {
  if (target?.rep_min && target?.rep_max) return [target.rep_min, target.rep_max];
  if (variant?.rep_min && variant?.rep_max) return [variant.rep_min, variant.rep_max];
  return DEFAULT_REP_RANGE[exercise?.category] ?? DEFAULT_REP_RANGE.isolation;
}

// Loads that physically exist on this machine, from every logged set
// (including warmups and reconstructed notes — the plates are real).
function knownLoads(history) {
  const s = new Set();
  for (const h of history) for (const x of h.sets) if (!x.deleted && x.load_kg > 0) s.add(x.load_kg);
  return [...s].sort((a, b) => a - b);
}

export function inferIncrement(history, equipment) {
  if (equipment?.increment_kg) return { kg: equipment.increment_kg, source: 'machine setting' };
  const loads = knownLoads(history);
  let step = Infinity;
  for (let i = 1; i < loads.length; i++) step = Math.min(step, loads[i] - loads[i - 1]);
  if (Number.isFinite(step) && step >= 0.5) return { kg: round(step, 2), source: 'smallest step seen on this machine' };
  const byType = { plate_loaded: 2.5, cable: 2.5, dumbbell: 2, barbell: 2.5, selectorized: 2.5 };
  return { kg: byType[equipment?.load_type] ?? 2.5, source: 'default — set the real increment in Machine library' };
}

function nextLoadUp(load, history, inc) {
  const above = knownLoads(history).filter((l) => l > load);
  if (above.length) return { kg: above[0], how: 'next load you have used on this machine' };
  return { kg: round(load + inc.kg, 2), how: `+${inc.kg} kg, ${inc.source}` };
}

function nextLoadDown(load, history, inc) {
  const below = knownLoads(history).filter((l) => l < load);
  if (below.length) return { kg: below[below.length - 1], how: 'previous load you have used on this machine' };
  return { kg: round(Math.max(0, load - inc.kg), 2), how: `−${inc.kg} kg` };
}

function asymmetry(sets) {
  for (const s of sets) {
    const L = (s.sides || []).find((x) => x.side === 'L');
    const R = (s.sides || []).find((x) => x.side === 'R');
    if (!L || !R) continue;
    const dr = (L.rir_min ?? null) !== null && (R.rir_min ?? null) !== null ? L.rir_min - R.rir_min : 0;
    const dreps = L.reps && R.reps ? L.reps - R.reps : 0;
    const hitFailure = Math.min(L.rir_min ?? Infinity, R.rir_min ?? Infinity) === 0;
    if (Math.abs(dr) >= 2 || (Math.abs(dr) >= 1 && hitFailure) || dreps !== 0) {
      const weak = dr < 0 || dreps < 0 ? 'left' : 'right';
      return { weak, text: `${weak} side is the limiter (${describeSides(s)})` };
    }
  }
  return null;
}

function describeSides(s) {
  return (s.sides || [])
    .map((x) => `${x.side} ${x.reps ?? s.reps ?? '?'} reps @ RIR ${formatRir(x.rir_min, x.rir_max, x.rir_approx)}`)
    .join(', ');
}

function rec(fields) {
  return { rir_min: DEFAULT_RIR[0], rir_max: DEFAULT_RIR[1], basis_set_ids: [], alternatives: [], ...fields };
}

/**
 * @param {object} p
 * @param {object} p.variant         exercise_variants row (+ laterality)
 * @param {object} p.exercise        exercises row (category)
 * @param {object} p.equipment       equipment row (increment_kg, load_type)
 * @param {Array}  p.history         [{session, sets}] for THIS variant, oldest first, excluding the current session
 * @param {Array}  p.currentSets     sets already logged for this variant in the current session
 * @param {object} [p.target]        plan targets {rep_min, rep_max, rir_min, rir_max, target_sets}
 * @param {Array}  [p.otherVariants] [{label, summary}] same exercise on other machines — reference only
 */
export function recommendNextSet({ variant, exercise, equipment, history, currentSets = [], target, otherVariants = [] }) {
  const [repMin, repMax] = repRangeFor(variant, exercise, target);
  const rirT = [target?.rir_min ?? DEFAULT_RIR[0], target?.rir_max ?? DEFAULT_RIR[1]];
  const inc = inferIncrement(history, equipment);
  const base = { rep_min: repMin, rep_max: repMax, rir_min: rirT[0], rir_max: rirT[1], increment: inc };

  const live = currentSets.filter((s) => !s.deleted);
  const liveWorking = live.filter(isWorking);

  // ---- Within a session: react to the set just done --------------------------
  if (liveWorking.length) {
    const last = liveWorking[liveWorking.length - 1];
    const reps = effectiveReps(last);
    const rir = conservativeRir(last);
    const asym = asymmetry([last]);
    const done = target?.target_sets && liveWorking.length >= target.target_sets;
    const tail = done ? ` You've done ${liveWorking.length}/${target.target_sets} planned sets — stop here unless you planned more.` : '';
    const basis = [last.id];

    if (last.technique === 'degraded') {
      return rec({ ...base, action: 'hold', load_kg: last.load_kg, rep_min: repMin, rep_max: Math.max(repMin, reps ?? repMin), confidence: 'medium', basis_set_ids: basis,
        rationale: `Technique slipped on the last set — keep ${last.load_kg} kg and own every rep before chasing more.${tail}` });
    }
    if (rir === null) {
      return rec({ ...base, action: 'hold', load_kg: last.load_kg, confidence: 'low', basis_set_ids: basis,
        rationale: `No RIR on the last set, so hold ${last.load_kg} kg and aim to match ${reps ?? 'the same'} reps. Log RIR to unlock better suggestions.${tail}` });
    }
    if (reps !== null && reps >= repMax && rir >= rirT[1] + 1 && !(asym && rir < 1)) {
      const up = nextLoadUp(last.load_kg, history.concat([{ sets: live }]), inc);
      return rec({ ...base, action: 'increase', load_kg: up.kg, rep_min: Math.max(repMin, repMax - 3), rep_max: repMax, confidence: 'medium', basis_set_ids: basis,
        rationale: `${reps} reps with ${rir}+ in reserve is above target effort — go to ${up.kg} kg (${up.how}) for the next set.${tail}` });
    }
    if (rir <= 0 && reps !== null && reps < repMin) {
      const down = nextLoadDown(last.load_kg, history.concat([{ sets: live }]), inc);
      return rec({ ...base, action: 'reduce', load_kg: down.kg, confidence: 'medium', basis_set_ids: basis,
        rationale: `Failure below ${repMin} reps — drop to ${down.kg} kg (${down.how}) to stay in the ${repMin}–${repMax} range.${tail}` });
    }
    if (rir <= 0) {
      return rec({ ...base, action: 'hold', load_kg: last.load_kg, rep_min: Math.max(repMin, (reps ?? repMin) - 2), rep_max: reps ?? repMax, confidence: 'medium', basis_set_ids: basis,
        rationale: `Last set reached failure${asym ? ` (${asym.text})` : ''}. Same load; expect 1–2 fewer reps. Stop at RIR 1 if form starts to go.${tail}` });
    }
    return rec({ ...base, action: 'hold', load_kg: last.load_kg, rep_min: Math.min(reps ?? repMin, repMax), rep_max: repMax, confidence: 'medium', basis_set_ids: basis,
      rationale: `On target (${reps} reps @ RIR ${formatRir(last.rir_min, last.rir_max, last.rir_approx)}). Same load, match or beat ${reps} reps.${asym ? ` Note: ${asym.text} — let it set the rep count.` : ''}${tail}` });
  }

  // ---- Start of the exercise: use the last comparable session ----------------
  const reported = history.filter((h) => h.session.fidelity !== 'partial_reconstruction' && h.sets.some((s) => isWorking(s) && s.load_kg !== null));
  if (!reported.length) {
    const recon = history.filter((h) => h.session.fidelity === 'partial_reconstruction');
    const refs = [];
    if (recon.length) refs.push(`Reconstructed notes for this machine exist (${recon.map((h) => h.session.date_local).join(', ')}) — use them only as a rough starting point.`);
    for (const o of otherVariants) refs.push(`${o.label}: ${o.summary} (different machine — not comparable, reference only)`);
    return rec({ ...base, action: 'calibrate', load_kg: null, confidence: 'low',
      rationale: `No confirmed working sets on this exact machine yet. Do 1–2 calibration sets, building to a load where ${repMin}–${repMax} reps leaves 2–3 in reserve, then log working sets from there.`,
      alternatives: refs });
  }

  const lastH = reported[reported.length - 1];
  const work = lastH.sets.filter((s) => isWorking(s) && s.load_kg !== null);
  const topLoad = Math.max(...work.map((s) => s.load_kg));
  const top = work.filter((s) => s.load_kg === topLoad);
  const repsList = top.map(effectiveReps).filter((r) => r !== null);
  const minReps = repsList.length ? Math.min(...repsList) : null;
  const rirs = top.map(conservativeRir).filter((r) => r !== null);
  const minRir = rirs.length ? Math.min(...rirs) : null;
  const allTop = repsList.length === top.length && repsList.every((r) => r >= repMax);
  const asym = asymmetry(top);
  const degraded = top.some((s) => s.technique === 'degraded');
  const basis = top.map((s) => s.id);
  const when = lastH.session.date_local ?? 'last session';
  const summary = `${when}: ${top.length}× ${topLoad} kg × ${repsList.join('/') || '?'}${rirs.length ? ` @ RIR ${top.map((s) => s.rir_raw ?? '—').join(' / ')}` : ' (RIR not recorded)'}`;

  if (degraded) {
    return rec({ ...base, action: 'hold', load_kg: topLoad, confidence: 'medium', basis_set_ids: basis,
      rationale: `${summary}. Technique degraded last time — repeat ${topLoad} kg with clean reps before progressing.` });
  }
  if (minRir === null) {
    return rec({ ...base, action: 'hold', load_kg: topLoad, rep_min: Math.min(repMax, (minReps ?? repMin) + 1), rep_max: repMax, confidence: 'low', basis_set_ids: basis,
      rationale: `${summary}. RIR wasn't recorded, so there's no safe basis for a load jump: hold ${topLoad} kg, try for ${Math.min(repMax, (minReps ?? repMin) + 1)} reps and log RIR.` });
  }
  if (allTop && minRir >= 1 && !(asym && minRir < 1)) {
    const up = nextLoadUp(topLoad, history, inc);
    const jumpPct = topLoad ? (up.kg - topLoad) / topLoad : 0;
    const alternatives = jumpPct > 0.075
      ? [`That's a ${Math.round(jumpPct * 100)}% jump. If ${up.kg} kg drops you below ${repMin} reps, stay at ${topLoad} kg and add a rep instead.`]
      : [];
    return rec({ ...base, action: 'increase', load_kg: up.kg, rep_min: repMin, rep_max: repMax, confidence: 'high', basis_set_ids: basis, alternatives,
      rationale: `${summary}. Top of the ${repMin}–${repMax} range with reps to spare on every top set — double progression says add load: ${up.kg} kg (${up.how}). Expect fewer reps; build back up to ${repMax}.` });
  }
  if (allTop) {
    return rec({ ...base, action: 'hold', load_kg: topLoad, rep_min: repMax, rep_max: repMax, confidence: 'high', basis_set_ids: basis,
      rationale: `${summary}. Range topped out but at failure${asym ? ` (${asym.text})` : ''} — repeat ${topLoad} kg × ${repMax} at RIR 1+ before adding load.` });
  }
  if (minReps !== null && minReps < repMin && minRir <= 0) {
    const down = nextLoadDown(topLoad, history, inc);
    return rec({ ...base, action: 'reduce', load_kg: down.kg, confidence: 'medium', basis_set_ids: basis,
      rationale: `${summary}. Below ${repMin} reps at failure — use ${down.kg} kg (${down.how}) and work back up through the range.` });
  }
  if (minRir <= 0) {
    return rec({ ...base, action: 'hold', load_kg: topLoad, rep_min: minReps ?? repMin, rep_max: Math.min(repMax, (minReps ?? repMin) + 1), confidence: 'medium', basis_set_ids: basis,
      rationale: `${summary}. A top set hit failure${asym ? ` — ${asym.text}` : ''}. Keep ${topLoad} kg and aim for ${minReps ?? repMin}–${Math.min(repMax, (minReps ?? repMin) + 1)} reps with 1 in reserve${asym ? ', letting the weaker side set the reps' : ''}.` });
  }
  const goal = Math.min(repMax, (minReps ?? repMin) + 1);
  return rec({ ...base, action: 'add_reps', load_kg: topLoad, rep_min: goal, rep_max: repMax, confidence: 'high', basis_set_ids: basis,
    rationale: `${summary}. In range with reps in reserve — keep ${topLoad} kg and aim for ${goal}+ reps. Add load once every top set reaches ${repMax}.${asym ? ` Note: ${asym.text}.` : ''}` });
}
