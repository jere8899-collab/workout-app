// Live personal records. Worked out from the sets each time, so an undo or a
// correction removes a badge by itself. `earlierSets` must already be limited to
// the exact machine and variation, and exclude reconstructed data.
import { isWorking, setVolume, effectiveReps } from './sets.js';

export function livePRs(set, earlierSets) {
  if (!isWorking(set) || set.load_kg === null || set.load_kg === undefined) return [];
  const prior = earlierSets.filter((s) => isWorking(s) && s.load_kg !== null && effectiveReps(s));
  if (!prior.length) return [];

  const out = [];
  const bestLoad = Math.max(...prior.map((s) => s.load_kg));
  if (set.load_kg > bestLoad) out.push({ kind: 'load', label: 'Heaviest', beat: bestLoad });

  const reps = effectiveReps(set);
  const sameLoad = prior.filter((s) => s.load_kg === set.load_kg);
  if (reps && sameLoad.length) {
    const bestReps = Math.max(...sameLoad.map(effectiveReps));
    if (reps > bestReps) out.push({ kind: 'reps', label: 'Most reps', beat: bestReps });
  }

  const vol = setVolume(set);
  const bestVol = Math.max(...prior.map((s) => setVolume(s) ?? 0));
  if (vol !== null && vol > bestVol) out.push({ kind: 'volume', label: 'Best set volume', beat: bestVol });
  return out;
}
