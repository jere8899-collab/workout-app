// Energy estimates. Always a range, always with the assumptions spelled out,
// and always kept apart from what a machine displayed.

// Gross MET range for machine-based hypertrophy work including rest periods
// (Compendium of Physical Activities: resistance training 3.5 moderate,
// ~5.0 for harder multi-exercise circuits).
export const STRENGTH_MET = { min: 3.5, max: 5.0 };

// Holding handrails unloads body weight and cuts oxygen cost substantially;
// the factors below widen the range rather than pretend to precision.
export const HANDRAIL_FACTOR = {
  none: { min: 1.0, max: 1.0 },
  light: { min: 0.8, max: 0.95 },
  firm: { min: 0.55, max: 0.75 },
  unknown: { min: 0.55, max: 1.0 },
};

export function strengthKcal(bodyKg, minutes) {
  if (!bodyKg || !minutes || minutes <= 0) return null;
  const h = minutes / 60;
  return {
    min: Math.round(STRENGTH_MET.min * bodyKg * h),
    max: Math.round(STRENGTH_MET.max * bodyKg * h),
    assumption: `MET ${STRENGTH_MET.min}–${STRENGTH_MET.max} × ${bodyKg} kg × ${Math.round(minutes)} min of strength work`,
  };
}

// ACSM walking equation: VO2 = 0.1·v + 1.8·v·grade + 3.5 (ml/kg/min, v in m/min);
// ~5 kcal per litre O2. Valid for walking speeds (≈ 3–7.5 km/h).
export function treadmillKcal(cardio, bodyKg) {
  const notes = [];
  const dur = cardio.duration_sec;
  if (!dur || !bodyKg) return { range: null, notes: ['Needs duration and body weight'] };

  let kmh = cardio.avg_speed_kmh;
  if (!kmh && cardio.distance_km) {
    kmh = cardio.distance_km / (dur / 3600);
    notes.push(`speed derived from distance/time (${kmh.toFixed(1)} km/h)`);
  }
  let grade = cardio.incline_pct !== null && cardio.incline_pct !== undefined ? cardio.incline_pct / 100 : null;
  if (grade === null && cardio.elevation_gain_m && cardio.distance_km) {
    grade = cardio.elevation_gain_m / (cardio.distance_km * 1000);
    notes.push(`grade derived from elevation/distance (${(grade * 100).toFixed(1)}%)`);
  }
  if (!kmh || grade === null) {
    return { range: null, notes: ['Speed and incline (or elevation + distance) are needed for a model estimate'] };
  }
  const v = (kmh * 1000) / 60;
  const vo2 = 0.1 * v + 1.8 * v * grade + 3.5;
  const kcal = ((vo2 * bodyKg) / 1000) * 5 * (dur / 60);
  const support = cardio.handrail_support || 'unknown';
  const f = HANDRAIL_FACTOR[support] ?? HANDRAIL_FACTOR.unknown;
  notes.push(`ACSM walking equation, ${bodyKg} kg, handrail support: ${support} (×${f.min}–${f.max})`);
  return { range: { min: Math.round(kcal * f.min), max: Math.round(kcal * f.max) }, unsupported: Math.round(kcal), notes };
}

export function cardioKcal(cardio, bodyKg) {
  const isWalk = /treadmill|walk/i.test(cardio.type || '');
  const model = isWalk ? treadmillKcal(cardio, bodyKg) : { range: null, notes: ['No model for this cardio type'] };
  return {
    machine: cardio.machine_kcal ?? null,
    machineApprox: !!cardio.machine_kcal_is_approx,
    reported:
      cardio.reported_kcal_min !== null && cardio.reported_kcal_min !== undefined
        ? { min: cardio.reported_kcal_min, max: cardio.reported_kcal_max }
        : null,
    model: model.range,
    notes: model.notes,
  };
}
