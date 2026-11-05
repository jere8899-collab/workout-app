// Set rows in the live logger: what to show beside each row and what to pre-fill.
// Everything here is a reference or a suggestion; nothing creates a set.

const bucket = (type) => (type === 'working' ? 'working' : type === 'warmup' || type === 'calibration' ? 'warmup' : null);

function latestSets(history) {
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if (h.session.fidelity === 'partial_reconstruction') continue;
    const sets = h.sets.filter((s) => !s.deleted);
    if (sets.length) return sets;
  }
  return [];
}

// Pairs rows with the last comparable session, like with like. Unmatched rows get null.
export function previousForRows(rows, history) {
  const queues = { working: [], warmup: [] };
  for (const s of latestSets(history)) {
    const b = bucket(s.set_type);
    if (b) queues[b].push(s);
  }
  return rows.map((r) => queues[bucket(r.set_type)]?.shift() ?? null);
}

// Weight and reps to pre-fill. No target is returned when there is nothing real to base one on.
export function targetsForRows({ rows, rec, previous = [] }) {
  const out = [];
  rows.forEach((r, i) => {
    if (r.set_subtype === 'drop') return;
    if (r.set_type === 'working') {
      if (rec?.load_kg !== null && rec?.load_kg !== undefined) out.push({ draft_id: r.id, load_kg: rec.load_kg, reps: rec.rep_min ?? null });
    } else if (previous[i]) {
      out.push({ draft_id: r.id, load_kg: previous[i].load_kg, reps: previous[i].reps });
    }
  });
  return out;
}
