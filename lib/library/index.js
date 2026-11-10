// Machine library helpers: expand the data into entries, search, group, and default settings.
// Pure functions — no database — so the browser and the tests run the same code.
import { SERIES, CARDIO } from './machines.js';
import { DEFAULT_MUSCLES } from '../muscles.js';

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const CARDIO_SOURCE = 'Listed on AF Singapore club equipment pages (count of 105 club pages, Nov 2026)';

export const LOAD_LABEL = {
  selectorized: 'Pin-loaded', plate_loaded: 'Plate-loaded', cable: 'Cable', dumbbell: 'Free weights',
  barbell: 'Barbell', bodyweight: 'Functional', cardio: 'Cardio',
};

export const CONFIDENCE_LABEL = { seen: 'Seen at AF Singapore', brand: 'Sold by a brand AF Singapore uses' };

// Generic variations by exercise: common ways these machines are used. Offered, never applied.
const BY_EXERCISE = {
  'Lat Pulldown': ['wide grip', 'close grip', 'neutral grip', 'underhand grip'],
  'Seated Row': ['wide grip', 'neutral grip'],
  'Low Row': ['wide grip', 'neutral grip'],
  'High Row': ['wide grip', 'neutral grip'],
  'Plate-Loaded Row': ['wide grip', 'neutral grip'],
  'T-Bar Row': ['wide grip', 'neutral grip'],
  'Seated Leg Press': ['feet high', 'feet low', 'single-leg'],
  'Linear Leg Press': ['feet high', 'feet low', 'single-leg'],
  'Leg Extension': ['single-leg'],
  'Leg Curl': ['single-leg'],
  'Seated Leg Curl': ['single-leg'],
  'Prone Leg Curl': ['single-leg'],
  'Hip Thrust': ['single-leg'],
};

const ONE_SIDE = /one side|single[- ]arm|single[- ]leg/i;

function expand() {
  const out = [];
  for (const g of SERIES) {
    for (const [name, ex, opt = {}] of g.machines) {
      const iso = opt.iso ?? g.iso ?? null;
      const variations = [...(opt.vars ?? [])];
      if (iso === true && !variations.includes('one side at a time')) variations.push('one side at a time');
      out.push({
        id: `${slug(g.brand ?? 'general')}/${slug(g.series)}/${slug(name)}`,
        brand: g.brand, series: g.series, name, load: g.load, confidence: g.confidence, source: g.source,
        exercises: Array.isArray(ex) ? ex : [ex], iso, variations, cardioType: null,
      });
    }
  }
  for (const [name, type] of CARDIO) {
    out.push({ id: `general/cardio/${slug(name)}`, brand: null, series: 'Cardio', name, load: 'cardio', confidence: 'seen',
      source: CARDIO_SOURCE, exercises: [], iso: null, variations: [], cardioType: type });
  }
  return out;
}

export const LIBRARY = expand();
const BY_ID = new Map(LIBRARY.map((e) => [e.id, e]));

export const getEntry = (id) => BY_ID.get(id);

export const entryTitle = (e) => [e.brand, e.series, e.name].filter(Boolean).join(' · ');

// Variations to offer for a chosen exercise: the maker's, then the generic ones.
export function variationsFor(entry, exercise) {
  return [...new Set([...entry.variations, ...(BY_EXERCISE[exercise] ?? [])])];
}

export function musclesOf(entry) {
  const set = new Set();
  for (const x of entry.exercises) {
    const m = DEFAULT_MUSCLES[x];
    if (m) { set.add(m[0]); m[1].forEach((s) => set.add(s)); }
  }
  return [...set];
}

const haystack = (e) => [e.brand, e.series, e.name, ...e.exercises, ...e.variations, LOAD_LABEL[e.load]].filter(Boolean).join(' ').toLowerCase();
const HAY = new Map(LIBRARY.map((e) => [e.id, haystack(e)]));

export function searchLibrary(query = '', { brand, load, muscle } = {}) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const rank = (e) => (e.confidence === 'seen' ? 0 : 1);
  return LIBRARY
    .filter((e) => (!brand || e.brand === brand) && (!load || e.load === load) && (!muscle || musclesOf(e).includes(muscle)))
    .filter((e) => words.every((w) => HAY.get(e.id).includes(w)))
    .sort((a, b) => rank(a) - rank(b) || (a.brand == null) - (b.brand == null) || (a.brand ?? '').localeCompare(b.brand ?? '') || a.series.localeCompare(b.series) || a.name.localeCompare(b.name));
}

export function groupLibrary(entries) {
  const groups = new Map();
  for (const e of entries) {
    const key = `${e.brand ?? 'General'}|${e.series}`;
    if (!groups.has(key)) groups.set(key, { brand: e.brand ?? 'General', series: e.series, entries: [] });
    groups.get(key).entries.push(e);
  }
  return [...groups.values()];
}

export const BRANDS = [...new Set(LIBRARY.map((e) => e.brand).filter(Boolean))];

// How weight is entered and whether sides are logged separately. Always editable.
export function defaultsFor(entry, exercise, variation = '') {
  const load_basis = entry.load === 'plate_loaded' ? 'per_side' : entry.load === 'dumbbell' ? 'per_limb' : 'total';
  const laterality = ONE_SIDE.test(variation ?? '') ? 'unilateral' : 'bilateral';
  return { load_basis, laterality };
}

// equipment.load_type for a library entry (bodyweight has no matching value).
export const equipmentLoadType = (entry) => (['selectorized', 'plate_loaded', 'cable', 'dumbbell', 'barbell'].includes(entry.load) ? entry.load : 'unknown');
