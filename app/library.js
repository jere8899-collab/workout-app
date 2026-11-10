// Machine library screens (specs/003): browse, entry details, and the pick/confirm sheet.
import { h, sheet, toast, field, segmented, badge } from './ui.js';
import * as repo from '../lib/db/repo.js';
import { MUSCLES, DEFAULT_MUSCLES } from '../lib/muscles.js';
import {
  LIBRARY, BRANDS, LOAD_LABEL, CONFIDENCE_LABEL, getEntry, searchLibrary, groupLibrary,
  defaultsFor, variationsFor, musclesOf, entryTitle,
} from '../lib/library/index.js';

const ISO_LABEL = (iso) => (iso === true ? 'yes' : iso === false ? 'no' : 'not stated');
const subline = (e) => [e.brand ?? 'General', e.series, LOAD_LABEL[e.load].toLowerCase() !== e.series.toLowerCase() && LOAD_LABEL[e.load]].filter(Boolean).join(' · ');

// ---------------------------------------------------------------- rows used by the add sheet
export function libraryRows(app, term, { planMode, onEntry }) {
  if (!term.trim()) return [];
  const used = new Set(app.db.all('SELECT DISTINCT library_id FROM equipment WHERE library_id IS NOT NULL').map((r) => r.library_id));
  const rows = searchLibrary(term).filter((e) => !(planMode && e.load === 'cardio')).slice(0, 40);
  if (!rows.length) return [];
  return [
    h('h3', { class: 'pick-head' }, 'Library', h('span', { class: 'muted small' }, ' · machines you may find at AF Singapore')),
    ...rows.map((e) => h('button', { class: 'list-row', onclick: () => onEntry(e) },
      h('div', { class: 'grow' }, h('div', { class: 'row-title' }, e.name), h('div', { class: 'muted small' }, subline(e))),
      h('div', { class: 'stack-xs right' }, badge('Library', 'muted'), used.has(e.id) && h('span', { class: 'tiny muted' }, 'you have this')))),
  ];
}

// ---------------------------------------------------------------- confirm sheet
// onCreated(variantId) receives the lifter's machine (new or existing).
export function libraryPickSheet(app, entry, { onCreated }) {
  const { db } = app;
  let exercise = entry.exercises.length === 1 ? entry.exercises[0] : null;
  let variation = '';
  const host = h('div', { class: 'stack' });
  let ref;

  const draw = () => {
    const parts = [h('p', { class: 'muted small' }, subline(entry))];
    if (entry.exercises.length > 1) {
      parts.push(field('Exercise', segmented(entry.exercises.map((x) => [x, x]), exercise, (v) => { exercise = v; variation = ''; draw(); }, 'Exercise')));
    }
    if (!exercise) { host.replaceChildren(...parts, h('p', { class: 'small' }, 'Choose the exercise you are doing on it.')); return; }

    const vars = variationsFor(entry, exercise);
    if (vars.length) parts.push(field('Variation', segmented([['', 'None'], ...vars.map((v) => [v, v])], variation, (v) => { variation = v; draw(); }, 'Variation'),
      'A variation is tracked as its own machine.'));

    const d = defaultsFor(entry, exercise, variation);
    const basis = h('select', {}, ...[['total', 'Stack total / single load'], ['per_side', 'Per side (plates on each side)'], ['per_limb', 'Per arm / per leg']]
      .map(([v, l]) => h('option', { value: v, selected: v === d.load_basis }, l)));
    const lat = h('select', {}, ...[['bilateral', 'Both sides together'], ['unilateral', 'One side at a time (log L/R)']]
      .map(([v, l]) => h('option', { value: v, selected: v === d.laterality }, l)));
    parts.push(h('div', { class: 'grid2' }, field('Weight entered as', basis), field('Sides', lat)));

    const mine = repo.findLibraryMachines(db, entry.id).filter((v) => v.exercise_name === exercise && v.variation === variation);
    const similar = repo.similarMachines(db, entry, exercise).filter((v) => !mine.some((m) => m.id === v.id));
    if (similar.length) {
      parts.push(h('div', { class: 'card flat stack-s' },
        h('div', { class: 'small' }, 'Similar machines you already have (kept separate unless you pick one):'),
        ...similar.slice(0, 5).map((v) => h('button', { class: 'list-row', onclick: () => { ref.close(); onCreated(v.id); } },
          h('div', { class: 'grow small' }, v.label)))));
    }
    const isNewExercise = !db.get('SELECT 1 FROM exercises WHERE lower(name)=lower(?)', [exercise]);
    if (isNewExercise && DEFAULT_MUSCLES[exercise]) {
      const [p, s] = DEFAULT_MUSCLES[exercise];
      parts.push(h('p', { class: 'tiny muted' }, `New exercise. Muscles: ${p}${s.length ? ` (+ ${s.join(', ')})` : ''}. You can change them on the machine page.`));
    }
    parts.push(h('button', { class: 'btn primary block', onclick: () => {
      try {
        const v = repo.createFromLibrary(db, entry.id, { exercise, variation, laterality: lat.value, load_basis: basis.value });
        ref.close();
        onCreated(v.id);
      } catch (e) { toast(e.message); }
    } }, mine.length ? 'Use your existing one' : 'Add machine'));
    host.replaceChildren(...parts);
  };
  draw();
  ref = sheet(entry.name, host);
}

// ---------------------------------------------------------------- browse screen
const filters = { brand: '', load: '', muscle: '' };

export function renderLibrary(app, arg) {
  if (arg) return renderEntry(app, decodeURIComponent(arg));
  const list = h('div', { class: 'stack-s' });
  const sel = (key, label, options) => {
    const s = h('select', { 'aria-label': label }, h('option', { value: '' }, `Any ${label.toLowerCase()}`),
      ...options.map(([v, l]) => h('option', { value: v, selected: filters[key] === v }, l)));
    s.addEventListener('change', () => { filters[key] = s.value; draw(); });
    return s;
  };
  const draw = () => {
    const entries = searchLibrary('', { brand: filters.brand || undefined, load: filters.load || undefined, muscle: filters.muscle || undefined });
    const groups = groupLibrary(entries);
    list.replaceChildren(
      h('p', { class: 'muted small' }, `${entries.length} of ${LIBRARY.length} entries`),
      ...groups.map((g) => h('details', { class: 'card tight', open: groups.length <= 3 },
        h('summary', {}, h('strong', {}, `${g.brand} · ${g.series}`), h('span', { class: 'muted small' }, ` · ${g.entries.length}`)),
        ...g.entries.map((e) => h('a', { class: 'list-row', href: `#/library/${encodeURIComponent(e.id)}` },
          h('div', { class: 'grow' }, h('div', { class: 'row-title' }, e.name),
            h('div', { class: 'muted small' }, e.load === 'cardio' ? 'Cardio' : e.exercises.join(', '))))))),
      !entries.length && h('p', { class: 'muted' }, 'Nothing matches these filters.'));
  };
  draw();
  return h('div', { class: 'stack' },
    h('header', { class: 'page-head' }, h('a', { href: '#/exercises/machines', class: 'small' }, '← Machines'), h('h1', {}, 'Machine library')),
    h('p', { class: 'muted small' }, 'Machines you may find at Anytime Fitness clubs in Singapore, from club pages and makers’ catalogues. Reference only: nothing here is part of your history. Add one from a workout or plan with + Exercise.'),
    h('div', { class: 'grid3' },
      sel('brand', 'Brand', BRANDS.map((b) => [b, b])),
      sel('load', 'Loading', Object.entries(LOAD_LABEL)),
      sel('muscle', 'Muscle', MUSCLES.map((m) => [m, m]))),
    list);
}

function renderEntry(app, id) {
  const e = getEntry(id);
  const back = h('a', { href: '#/library', class: 'small' }, '← Machine library');
  const mine = repo.findLibraryMachines(app.db, id);
  const yours = mine.length
    ? h('section', { class: 'card tight' }, h('h3', {}, 'Your machines from this'),
      ...mine.map((v) => h('a', { class: 'list-row', href: `#/exercise/${v.id}` }, h('div', { class: 'grow small' }, v.label))))
    : null;
  if (!e) {
    return h('div', { class: 'stack' }, h('header', { class: 'page-head' }, back, h('h1', {}, 'Not in the library')),
      h('p', { class: 'muted' }, 'This entry is no longer in the library. Your machines made from it keep their details.'), yours);
  }
  const row = (k, v) => h('div', { class: 'kv' }, h('span', { class: 'muted small' }, k), h('span', {}, v));
  return h('div', { class: 'stack' },
    h('header', { class: 'page-head' }, back, h('h1', {}, e.name)),
    h('section', { class: 'card stack-s' },
      row('Brand', e.brand ?? 'General equipment'),
      row('Series', e.series),
      row('Loading', LOAD_LABEL[e.load]),
      e.load !== 'cardio' && row('Arms or legs move on their own', ISO_LABEL(e.iso)),
      e.load !== 'cardio' && row('Exercises', e.exercises.join(', ')),
      e.load !== 'cardio' && row('Variations', [...new Set(e.exercises.flatMap((x) => variationsFor(e, x)))].join(', ') || 'none listed'),
      e.load !== 'cardio' && row('Muscles', musclesOf(e).join(', ')),
      row('How sure', CONFIDENCE_LABEL[e.confidence]),
      row('Source', e.source)),
    yours,
    h('p', { class: 'tiny muted' }, `${entryTitle(e)}. To use it, start a workout or edit a plan and choose + Exercise.`));
}
