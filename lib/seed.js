// First-run helpers: import the bundled history and build an editable
// starter plan from sessions the user actually did.
import { importCanonical } from './io/import.js';
import { createPlan, addPlanDay, addPlanItem, getSessionGraph, setSetting, getSetting } from './db/repo.js';
import { isWorking } from './domain/sets.js';
import { REST_DEFAULT_SEC } from './catalog.js';
import { stableId } from './util.js';

export function importBundled(db, { jsonText, augustMdText }) {
  const report = importCanonical(db, { jsonText, augustMdText });
  setSetting(db, 'bundled_import_done', true);
  return report;
}

// Builds "plan days" that mirror real sessions: same exercises, same machines,
// same number of working sets. Purely a starting point the user can edit.
export function createTemplatePlan(db) {
  if (getSetting(db, 'template_plan_done')) return null;
  const days = [
    { name: 'Lower — Precor', focus: 'lower body, shoulders, core', from: [['recent', '2026-11-01', 'Precor lower body, shoulders and core']] },
    { name: 'Upper', focus: 'upper body', from: [['recent', '2026-10-27', 'Upper body and treadmill']], extra: ['Triceps Press', 'Biceps Curl Machine', 'Shoulder Press', 'Lateral Raise Machine'] },
    { name: 'Lower + arms — Life Fitness', focus: 'lower, arms, shoulders', from: [['recent', '2026-10-29', 'Oct 29–30 lower, arms, shoulders and cardio']], skip: ['Biceps Curl Machine', 'Shoulder Press', 'Lateral Raise Machine', 'Triceps Press'] },
  ];
  const lf = getSessionGraph(db, stableId('ses', 'recent', '2026-10-29', 'Oct 29–30 lower, arms, shoulders and cardio'));
  const plan = createPlan(db, 'Upper / Lower rotation (template from your sessions)', { is_active: 1, notes: 'Built from your 27 Oct, 29 Oct and 1 Nov sessions. Edit freely.' });
  for (const d of days) {
    const day = addPlanDay(db, plan.id, d.name, d.focus);
    const items = [];
    for (const [kind, date, label] of d.from) {
      const g = getSessionGraph(db, stableId('ses', kind, date, label));
      if (!g) continue;
      for (const e of g.exercises) if (!(d.skip || []).includes(e.exercise_name)) items.push(e);
    }
    if (d.extra && lf) for (const e of lf.exercises) if (d.extra.includes(e.exercise_name)) items.push(e);
    // A superset letter only means something if its partner is in the same day.
    const groupCount = items.reduce((m, e) => (e.superset_group ? m.set(e.superset_group, (m.get(e.superset_group) ?? 0) + 1) : m), new Map());
    for (const e of items) {
      addPlanItem(db, day.id, {
        variant_id: e.variant_id,
        target_sets: Math.max(1, e.sets.filter(isWorking).length),
        rir_min: 1,
        rir_max: 2,
        rest_sec: REST_DEFAULT_SEC[e.category] ?? 105,
        superset_group: groupCount.get(e.superset_group) > 1 ? e.superset_group : null,
      });
    }
  }
  setSetting(db, 'template_plan_done', true);
  return plan;
}
