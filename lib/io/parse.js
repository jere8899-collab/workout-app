// Parsers for the free-text parts of the history. Each returns only what the
// text literally states; anything it can't read cleanly is left as text.
import { KNOWN_BRANDS } from '../catalog.js';

export const stripMd = (s) => String(s ?? '').replace(/\*\*/g, '').replace(/\s+$/g, '').trim();

// "Life Fitness plate-loaded row" -> { brand: 'Life Fitness', description: 'plate-loaded row', load_type: 'plate_loaded' }
export function parseEquipment(raw) {
  const text = String(raw ?? '').trim();
  let brand = 'unspecified';
  let rest = text;
  for (const b of KNOWN_BRANDS) {
    const re = new RegExp(`\\b${b.replace(/ /g, '\\s+')}\\b`, 'i');
    if (re.test(text)) {
      brand = b;
      rest = text.replace(re, '').trim();
      break;
    }
  }
  if (/^unspecified$/i.test(rest)) rest = '';
  // "Life Fitness machine" says nothing beyond the brand.
  if (brand !== 'unspecified' && /^machine$/i.test(rest)) rest = '';
  return { brand, description: rest, load_type: loadTypeOf(text) };
}

export function loadTypeOf(text) {
  const t = String(text ?? '').toLowerCase();
  if (/plate[- ]?loaded/.test(t)) return 'plate_loaded';
  if (/dumbbell/.test(t)) return 'dumbbell';
  if (/barbell/.test(t)) return 'barbell';
  if (/selectori[sz]ed/.test(t)) return 'selectorized';
  if (/\bcable\b/.test(t)) return 'cable';
  return 'unknown';
}

// Variation strings in the recent history mix true variations with load
// conventions ("57.5 kg per side", "32.5 kg total weight stack").
export function parseVariation(raw) {
  const s = String(raw ?? '').trim();
  const out = { variation: '', load_basis: null, laterality: null, load_type: null, raw: s || null };
  if (!s) return out;
  if (/^\d+(?:\.\d+)?\s*kg\b/i.test(s)) {
    if (/per side|\/side|each side/i.test(s)) out.load_basis = 'per_side';
    else if (/total|stack/i.test(s)) out.load_basis = 'total';
    return out;
  }
  if (/^unilateral$/i.test(s)) return { ...out, variation: 'unilateral', laterality: 'unilateral', load_basis: 'per_limb' };
  if (/^selectori[sz]ed$/i.test(s)) return { ...out, load_type: 'selectorized' };
  if (/plate[- ]?loaded/i.test(s)) {
    return { ...out, variation: s.replace(/\s*per side\s*/i, '').trim(), load_type: 'plate_loaded', load_basis: /per side/i.test(s) ? 'per_side' : null };
  }
  return { ...out, variation: s };
}

export function loadBasisFromDisplay(display, equipmentText) {
  const d = String(display ?? '').toLowerCase();
  const eq = String(equipmentText ?? '').toLowerCase();
  if (/\/(leg|arm|hand)\b/.test(d)) return 'per_limb';
  if (/\/side\b/.test(d)) return /dumbbell|cable/.test(eq) ? 'per_limb' : 'per_side';
  return 'total';
}

// "**Cardio:** Incline walk — 17:39, 1.33 km, 194 m climbed, avg 4.5 km/h, avg HR 135, max HR 143, ~201 kcal"
export function parseCardioNote(note) {
  const s = stripMd(note);
  const m = s.match(/^Cardio:\s*(.+?)\s+[—–-]\s+(.+)$/i);
  if (!m) return null;
  const name = m[1].trim();
  const body = m[2];
  const c = { type: name.toLowerCase().replace(/\s+/g, '_'), raw_text: s, fidelity: 'parsed_from_note', issues: [] };
  let x;
  if ((x = body.match(/(?:^|,\s*)(\d{1,3}):(\d{2})(?=\s*(?:,|$))/))) c.duration_sec = Number(x[1]) * 60 + Number(x[2]);
  else if ((x = body.match(/(\d+(?:\.\d+)?)\s*min\b/))) c.duration_sec = Number(x[1]) * 60;
  if ((x = body.match(/(\d+(?:\.\d+)?)\s*km(?!\/h)\b/))) c.distance_km = Number(x[1]);
  if ((x = body.match(/(\d+(?:\.\d+)?)\s*m climbed/))) c.elevation_gain_m = Number(x[1]);
  if ((x = body.match(/(?:avg|pace)\s+(\d+(?:\.\d+)?)\s*km\/h/))) c.avg_speed_kmh = Number(x[1]);
  if ((x = body.match(/incline\s+(\d+(?:\.\d+)?)\s*(%)?/i))) {
    c.incline_pct = Number(x[1]);
    if (!x[2]) c.issues.push('incline unit not stated; stored as percent grade');
  }
  if ((x = body.match(/avg HR\s+(\d+)/i))) c.avg_hr = Number(x[1]);
  if ((x = body.match(/max HR\s+(\d+)/i))) c.max_hr = Number(x[1]);
  if ((x = body.match(/(~)?(\d+)\s*kcal(\s+machine estimate)?/i))) {
    if (x[3]) {
      c.machine_kcal = Number(x[2]);
      c.machine_kcal_is_approx = x[1] ? 1 : 0;
    } else {
      c.reported_kcal_min = Number(x[2]);
      c.reported_kcal_max = Number(x[2]);
      c.issues.push('kcal figure in note does not say whether it came from the machine; stored as reported estimate');
    }
  }
  return c;
}

export function parseBodyWeightNote(note) {
  const s = stripMd(note);
  const m = s.match(/^Body weight:\s*(\d+(?:\.\d+)?)\s*kg\s*(?:\((.+)\))?/i);
  return m ? { weight_kg: Number(m[1]), context: m[2] ?? null } : null;
}

export function parseFocusNote(note) {
  const m = stripMd(note).match(/^Focus:\s*(.+)$/i);
  return m ? m[1].trim() : null;
}

export function parseReportedKcal(note) {
  const m = String(note).match(/Estimated (?:total calories\s+)?(\d+)\s*[–-]\s*(\d+)\s*kcal/i);
  return m ? { min: Number(m[1]), max: Number(m[2]) } : null;
}

export function parseClaimedTotals(note) {
  const m = String(note).match(/(\d+) working sets[;,]\s*([\d.]+)\s*kg/i);
  return m ? { workingSets: Number(m[1]), volumeKg: Number(m[2]) } : null;
}

// "Superset with leg extension; 130kg paired with completed 60kg leg extension set"
export function parseSupersetNote(note) {
  const s = String(note ?? '');
  const m = s.match(/Superset with ([a-z][a-z \-]*?)(?:;|$)/i);
  if (!m) return null;
  const pair = s.match(/([\d.]+)\s*kg paired with (?:completed )?([\d.]+)\s*kg\s+([a-z][a-z \-]*?) set/i);
  return {
    partner: m[1].trim(),
    pair: pair ? { ownLoad: Number(pair[1]), partnerLoad: Number(pair[2]) } : null,
  };
}

// ---------------------------------------------------------------- partial summaries
const ALIASES = {
  'lat pulldown': 'Lat Pulldown',
  'rear delt fly': 'Rear Delt Fly',
  'seated row': 'Seated Row',
  'incline press': 'Incline Chest Press',
  'bayesian curls': 'Bayesian Curl',
  'bayesian curl': 'Bayesian Curl',
  'lateral raise machine': 'Lateral Raise Machine',
  'triceps press': 'Triceps Press',
  'hammer curls': 'Hammer Curl',
  'hammer curl': 'Hammer Curl',
  'hack squat': 'Hack Squat',
  'prone leg curl': 'Prone Leg Curl',
  'seated leg curl': 'Seated Leg Curl',
  'leg extension': 'Leg Extension',
  'hip abductor': 'Hip Abductor',
  'hip adductor': 'Hip Adductor',
  'cable lateral': 'Cable Lateral Raise',
  'cable lateral raise': 'Cable Lateral Raise',
  'kneeling cable crunch': 'Kneeling Cable Crunch',
  'kneeling crunch': 'Kneeling Cable Crunch',
};

const LOAD_SPEC = /(\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)*)\s*kg(?:\s*\/\s*(side|arm|hand|leg))?\s*x\s*(\d+(?:\s*,\s*\d+(?![\d.]|\s*(?:\.\d+)?\s*kg))*)(?![\d.]|\s*m\b)(?:\s*(?:per\s+(arm|side|leg|hand)))?(?:\s*x\s*(\d+)(?![\d.]))?/gi;

// Parses "Lat pulldown 80kg x9 x2" style summaries into reconstructed sets.
// Returns { kind: 'sets', exercise, brand, sets:[{load_kg, reps, per, note}] } | { kind: 'cardio', ... } | null.
export function parsePartialSummary(text) {
  const t = String(text).trim();
  const walk = t.match(/^Incline walk\s+(\d{1,3}):(\d{2})$/i);
  if (walk) return { kind: 'cardio', cardio: { type: 'incline_walk', duration_sec: Number(walk[1]) * 60 + Number(walk[2]), raw_text: t, fidelity: 'parsed_from_note' } };

  const first = t.search(/\d/);
  if (first <= 0) return null;
  let name = t.slice(0, first).trim();
  if (name.includes('/')) return null; // "abductor/adductor": two exercises in one line
  let brand = null;
  for (const b of KNOWN_BRANDS) {
    if (name.toLowerCase().startsWith(b.toLowerCase() + ' ')) {
      brand = b;
      name = name.slice(b.length).trim();
    }
  }
  const canonical = ALIASES[name.toLowerCase()] ?? name.replace(/\b\w/g, (c) => c.toUpperCase());

  const sets = [];
  let consumed = t.slice(0, first);
  let rest = t.slice(first);
  const leftovers = [];
  let lastIndex = 0;
  let note = null;
  for (const m of rest.matchAll(LOAD_SPEC)) {
    const between = rest.slice(lastIndex, m.index).replace(/[;,]/g, ' ').trim();
    if (between) {
      if (/\d/.test(between)) return null;
      note = between;
      leftovers.push(between);
    }
    lastIndex = m.index + m[0].length;
    const loads = m[1].split('/').map(Number);
    const per = m[2] || m[4] || null;
    const reps = m[3].split(',').map((r) => Number(r.trim()));
    const times = m[5] ? Number(m[5]) : 1;
    if (loads.length > 1 && reps.length > 1) return null;
    for (const load of loads) {
      for (let k = 0; k < times; k++) for (const r of reps) sets.push({ load_kg: load, reps: r, per, note });
    }
  }
  const tail = rest.slice(lastIndex).replace(/[;,]/g, ' ').trim();
  if (tail && !/^each$/i.test(tail)) return null;
  if (!sets.length) return null;
  consumed += rest;
  return { kind: 'sets', exercise: canonical, brand, sets, notes: leftovers };
}

// ---------------------------------------------------------------- CSV
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length > 1 || r[0] !== '');
}

export function toCsv(rows) {
  return rows.map((r) => r.map((v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\n') + '\n';
}

// ---------------------------------------------------------------- August markdown log
const MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12, jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

export function parseDayMonthYear(s) {
  const m = String(s).match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
  if (!m || !MONTHS[m[2].toLowerCase()]) return null;
  return `${m[3]}-${String(MONTHS[m[2].toLowerCase()]).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

function tableRows(lines, start) {
  const out = [];
  let i = start;
  while (i < lines.length && lines[i].trim().startsWith('|')) {
    out.push(lines[i].trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
    i++;
  }
  return { header: out[0] ?? [], rows: out.slice(2), end: i };
}

export function parseAugustMarkdown(text) {
  const lines = text.split(/\r?\n/);
  const sessions = [];
  const benchmarks = [];
  const bodyMetrics = [];
  let cur = null;
  let section = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const h = l.match(/^##\s+(.*)$/);
    if (h) {
      section = h[1];
      const sm = section.match(/^Session #(\d+)\s+[—–-]\s+(.+)$/);
      cur = sm ? { number: Number(sm[1]), label: sm[2].trim(), date: parseDayMonthYear(sm[2]), rows: [] } : null;
      if (cur) sessions.push(cur);
      continue;
    }
    if (!l.trim().startsWith('|')) continue;
    const t = tableRows(lines, i);
    i = t.end - 1;
    const hdr = t.header.map((x) => x.toLowerCase());
    if (cur && hdr[0] === 'exercise') {
      for (const r of t.rows) {
        cur.rows.push({ exercise: r[0], equipment: r[1], set_type: r[2], load: r[3], reps: r[4], partials: r[5], rir: r[6], rest: r[7], notes: r[8] });
      }
    } else if (/benchmark/i.test(section ?? '') && hdr[0]?.startsWith('exercise')) {
      t.rows.forEach((r, k) => benchmarks.push({ position: k, label: r[0], benchmark: r[1], date_text: r[2], context: r[3] }));
    } else if (/body metrics/i.test(section ?? '')) {
      for (const r of t.rows) {
        const w = r[1].match(/(\d+(?:\.\d+)?)/);
        const bf = r[2].match(/(~)?(\d+(?:\.\d+)?)\s*%/);
        bodyMetrics.push({ date_local: parseDayMonthYear(r[0]), weight_kg: w ? Number(w[1]) : null, body_fat_pct: bf ? Number(bf[2]) : null, body_fat_approx: !!bf?.[1], context: r[3] || null });
      }
    }
  }
  return { sessions, benchmarks, bodyMetrics };
}
