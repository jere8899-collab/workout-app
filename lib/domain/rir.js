// Reps-in-reserve parsing. Accepts what the logs actually contain:
//   1, "1", "3+", "1–2", "1-2", "~2", "2–3+", "3-4",
//   "left 1–2; right 3", "both sides 2–3", "left 0; right 1–2".
// Unreported RIR stays null — it is never inferred.

export function parseRirValue(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return { raw: String(raw), min: raw, max: raw, approx: false };
  let s = String(raw).trim();
  if (!s) return null;
  let approx = false;
  if (s.startsWith('~')) {
    approx = true;
    s = s.slice(1).trim();
  }
  // "2–3+" / "3+": open upper bound
  let m = s.match(/^(\d+(?:\.\d+)?)\s*(?:[–—-]\s*(\d+(?:\.\d+)?))?\s*(\+)?$/);
  if (!m) return { raw: String(raw), min: null, max: null, approx: true, unparsed: true };
  const lo = Number(m[1]);
  const hi = m[2] !== undefined ? Number(m[2]) : lo;
  return {
    raw: String(raw),
    min: Math.min(lo, hi),
    max: m[3] ? null : Math.max(lo, hi),
    approx,
  };
}

// Returns { raw, min, max, approx, sides: { L, R } | null }.
// Set-level min/max span both sides so the set row stays honest about the range.
export function parseRir(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number') return { ...parseRirValue(raw), sides: null };
  const s = String(raw).trim();

  const both = s.match(/^both sides\s+(.+)$/i);
  if (both) {
    const v = parseRirValue(both[1]);
    return { ...v, raw: s, sides: { L: { ...v }, R: { ...v } } };
  }

  if (/\b(left|right)\b/i.test(s)) {
    const sides = {};
    for (const part of s.split(/[;,]/)) {
      const pm = part.trim().match(/^(left|right)\s+(.+)$/i);
      if (!pm) continue;
      sides[pm[1].toLowerCase() === 'left' ? 'L' : 'R'] = parseRirValue(pm[2]);
    }
    const vals = Object.values(sides).filter(Boolean);
    const mins = vals.map((v) => v.min).filter((v) => v !== null);
    const maxs = vals.map((v) => v.max);
    return {
      raw: s,
      min: mins.length ? Math.min(...mins) : null,
      max: maxs.some((v) => v === null) || !maxs.length ? null : Math.max(...maxs),
      approx: vals.some((v) => v.approx),
      sides: { L: sides.L ?? null, R: sides.R ?? null },
    };
  }

  return { ...parseRirValue(s), sides: null };
}

export function formatRir(min, max, approx) {
  if (min === null || min === undefined) return '—';
  const p = approx ? '~' : '';
  if (max === null || max === undefined) return `${p}${min}+`;
  if (max === min) return `${p}${min}`;
  return `${p}${min}–${max}`;
}

// The conservative reading used for progression decisions: the lowest RIR the
// lifter reported for the set (or for its weaker side).
export function conservativeRir(set) {
  const sideMins = (set.sides || []).map((s) => s.rir_min).filter((v) => v !== null && v !== undefined);
  if (sideMins.length) return Math.min(...sideMins);
  return set.rir_min ?? null;
}

