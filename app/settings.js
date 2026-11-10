// Settings: units, rest defaults, body weight, machine library, backup/export/import,
// import review and edit history.
import { h, field, numInput, numVal, segmented, toast, confirmSheet, download, pickFile, badge } from './ui.js';
import * as repo from '../lib/db/repo.js';
import { exportBackup, restoreBackup, exportSetsCsv, exportCardioCsv } from '../lib/io/export.js';
import { importCanonical, importFlatCsv } from '../lib/io/import.js';
import { REST_DEFAULT_SEC } from '../lib/catalog.js';

const SECTIONS = [['general', 'General'], ['machines', 'Machines'], ['data', 'Backup & import'], ['import', 'Import review'], ['audit', 'Edit history']];

export function renderSettings(app, section = 'general') {
  section = SECTIONS.some(([k]) => k === section) ? section : 'general';
  const body = { general, machines, data, import: importReview, audit }[section](app);
  return h('div', { class: 'stack' },
    h('header', { class: 'page-head' }, h('h1', {}, 'Settings')),
    h('nav', { class: 'tabs', 'aria-label': 'Settings sections' }, ...SECTIONS.map(([k, l]) => h('a', { href: `#/settings/${k}`, class: k === section ? 'on' : '', 'aria-current': k === section ? 'page' : 'false' }, l))),
    body);
}

function setTheme(db, value) {
  repo.setSetting(db, 'theme', value);
  document.documentElement.dataset.theme = value;
  try { localStorage.setItem('theme', value); } catch { /* the saved setting is the fallback */ }
}

function general(app) {
  const { db } = app;
  const rest = repo.getSetting(db, 'rest_sec', {});
  const inputs = Object.fromEntries(Object.keys(REST_DEFAULT_SEC).map((k) => [k, numInput(rest[k] ?? REST_DEFAULT_SEC[k], { step: 15, inputmode: 'numeric' })]));
  const technique = techniqueNote(db);
  return h('div', { class: 'stack' },
    h('section', { class: 'card' }, h('h3', {}, 'Units'),
      segmented([['kg', 'Kilograms'], ['lb', 'Pounds']], app.units, (v) => { repo.setSetting(db, 'units', v); app.render(); }, 'Units'),
      h('p', { class: 'tiny muted' }, 'Everything is stored in kg; pounds are display only.')),
    h('section', { class: 'card' }, h('h3', {}, 'Look'),
      segmented([['dark', 'Dark'], ['light', 'Light'], ['system', 'Match phone']], repo.getSetting(db, 'theme', 'dark'), (v) => setTheme(db, v), 'Look')),
    h('section', { class: 'card' }, h('h3', {}, 'Default rest'),
      h('div', { class: 'grid3' }, field('Compound (s)', inputs.compound), field('Isolation (s)', inputs.isolation), field('Core (s)', inputs.core)),
      h('p', { class: 'tiny muted' }, 'Compounds usually 2–3 min, isolation 90–120 s. Plans and machines can override.'),
      h('button', { class: 'btn primary', onclick: () => {
        repo.setSetting(db, 'rest_sec', Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, numVal(i)])));
        toast('Saved');
      } }, 'Save')),
    h('section', { class: 'card' }, h('h3', {}, 'Body weight'),
      h('p', { class: 'small' }, 'Used for calorie estimates on and after each date. ', h('a', { href: '#/exercises/weight' }, 'Open the weight chart'))),
    technique && h('section', { class: 'card' }, h('h3', {}, 'Technique note from your history'),
      h('p', { class: 'small' }, technique)));
}

// Read from the imported file so nothing personal is baked into the app code.
function techniqueNote(db) {
  const r = db.get("SELECT meta_json FROM import_sources WHERE kind='canonical_json' AND meta_json IS NOT NULL LIMIT 1");
  return r ? JSON.parse(r.meta_json)?.training_logic?.technique_and_constraints ?? null : null;
}

function machines(app) {
  const { db } = app;
  const eq = db.all(`SELECT q.*, (SELECT COUNT(*) FROM exercise_variants v WHERE v.equipment_id=q.id AND v.archived=0) n FROM equipment q ORDER BY q.brand, q.description`);
  const brands = [...new Set(eq.map((e) => e.brand))];
  return h('div', { class: 'stack' },
    h('p', { class: 'muted small' }, 'Each brand + machine keeps its own baselines. Set the real weight increment so suggestions use actual plates.'),
    h('p', { class: 'small' }, h('a', { href: '#/library' }, 'Browse the machine library (AF Singapore)')),
    ...brands.map((b) => h('section', { class: 'card tight' }, h('h3', {}, b === 'unspecified' ? 'Brand unspecified' : b),
      ...eq.filter((e) => e.brand === b).map((e) => {
        const inc = numInput(e.increment_kg, { placeholder: 'auto' });
        inc.addEventListener('change', () => { repo.updateEquipment(db, e.id, { increment_kg: numVal(inc) }, 'machine library'); toast('Saved'); });
        const variants = repo.listVariants(db).filter((v) => v.equipment_id === e.id);
        return h('div', { class: 'machine-row' },
          h('div', { class: 'grow' },
            h('div', { class: 'row-title' }, e.description || '(no model given)'),
            h('div', { class: 'small muted' }, `${e.load_type.replace('_', ' ')} · `, ...variants.map((v, i) => [i ? ', ' : '', h('a', { href: `#/exercise/${v.id}` }, v.exercise_name + (v.variation ? ` (${v.variation})` : ''))]))),
          h('label', { class: 'inc' }, h('span', { class: 'tiny muted' }, 'step kg'), inc));
      }))));
}

function data(app) {
  const { db } = app;
  const stamp = new Date().toISOString().slice(0, 10);
  const sources = db.all('SELECT id, kind, filename, imported_at_utc, content_hash, length(raw_text) size FROM import_sources ORDER BY imported_at_utc');
  const handle = (fn) => async () => {
    try { await fn(); } catch (e) { toast(e.message.split('\n')[0], { ms: 6000 }); console.error(e); }
  };
  return h('div', { class: 'stack' },
    h('section', { class: 'card' }, h('h3', {}, 'Export'),
      h('p', { class: 'small muted' }, 'The full backup is lossless: every table, every edit, and your original files.'),
      h('div', { class: 'stack-s' },
        h('button', { class: 'btn block primary', onclick: () => download(`workout-backup-${stamp}.json`, JSON.stringify(exportBackup(db), null, 1)) }, 'Full backup (.json)'),
        h('button', { class: 'btn block', onclick: () => download(`workout-sets-${stamp}.csv`, exportSetsCsv(db), 'text/csv') }, 'All sets (.csv)'),
        h('button', { class: 'btn block', onclick: () => download(`workout-cardio-${stamp}.csv`, exportCardioCsv(db), 'text/csv') }, 'Cardio (.csv)'),
        h('button', { class: 'btn block', onclick: () => download(`workout-${stamp}.sqlite`, new Blob([db.export()], { type: 'application/x-sqlite3' })) }, 'SQLite database file'))),
    h('section', { class: 'card' }, h('h3', {}, 'Import'),
      h('div', { class: 'stack-s' },
        h('button', { class: 'btn block', onclick: handle(async () => {
          const f = await pickFile('.json,application/json');
          if (!f) return;
          const obj = JSON.parse(f.text);
          if (obj.format === 'workout-app-backup') {
            confirmSheet('Restore backup?', `Replaces everything on this device with ${f.name}. Export a backup first if unsure.`, 'Restore', () => {
              try { restoreBackup(db, obj); db.flush?.(); toast('Backup restored'); app.render(); } catch (e) { toast(e.message, { ms: 6000 }); }
            }, { danger: true });
          } else {
            const r = importCanonical(db, { jsonText: f.text, filename: f.name });
            toast(`Imported ${r.sessions} sessions, ${r.sets} sets (${r.skippedSessions} already present).`, { ms: 6000 });
            app.render();
          }
        }) }, 'Import history JSON or restore backup'),
        h('button', { class: 'btn block', onclick: handle(async () => {
          const f = await pickFile('.csv,text/csv');
          if (!f) return;
          const r = importFlatCsv(db, f.text, { filename: f.name });
          toast(`Imported ${r.sessions} sessions, ${r.sets} sets (${r.skippedSessions} skipped as already present).`, { ms: 6000 });
          app.render();
        }) }, 'Import flat sets CSV')),
      h('p', { class: 'tiny muted' }, 'Files are validated first. Re-importing the same file adds nothing; sessions already imported from another file are skipped.')),
    h('section', { class: 'card' }, h('h3', {}, 'Original files'),
      ...sources.map((s) => h('div', { class: 'row between' },
        h('div', {}, h('div', { class: 'row-title' }, s.filename ?? s.kind), h('div', { class: 'tiny muted' }, `${s.kind} · ${Math.round(s.size / 1024)} KB · ${s.imported_at_utc.slice(0, 10)}`)),
        h('button', { class: 'btn small', onclick: () => {
          const r = db.get('SELECT raw_text FROM import_sources WHERE id=?', [s.id]);
          download(s.filename ?? `${s.kind}.txt`, r.raw_text, 'text/plain');
        } }, 'Download')))),
    h('section', { class: 'card' }, h('h3', {}, 'Reset'),
      h('button', { class: 'btn danger', onclick: () => confirmSheet('Erase everything on this device?', 'All workouts on this device are deleted. Export a backup first if you want to keep them.', 'Erase', async () => {
        indexedDB.deleteDatabase('workout-tracker');
        location.hash = '';
        location.reload();
      }, { danger: true }) }, 'Erase local data')));
}

function importReview(app) {
  const { db } = app;
  const issues = db.all("SELECT * FROM import_issues ORDER BY CASE severity WHEN 'error' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, code");
  const meta = db.get("SELECT meta_json FROM import_sources WHERE kind='canonical_json' LIMIT 1");
  const m = meta ? JSON.parse(meta.meta_json) : null;
  const bench = db.all('SELECT * FROM benchmarks ORDER BY position');
  const counts = db.get(`SELECT (SELECT COUNT(*) FROM sessions) s, (SELECT COUNT(*) FROM sets WHERE fidelity='reported') r,
    (SELECT COUNT(*) FROM sets WHERE fidelity='reconstructed') c, (SELECT COUNT(*) FROM cardio) k`);
  const byCode = new Map();
  for (const i of issues) {
    if (!byCode.has(i.code)) byCode.set(i.code, []);
    byCode.get(i.code).push(i);
  }
  return h('div', { class: 'stack' },
    h('section', { class: 'card' }, h('h3', {}, 'What was imported'),
      h('p', {}, `${counts.s} sessions · ${counts.r} reported sets · ${counts.c} reconstructed sets · ${counts.k} cardio entries`),
      m && h('p', { class: 'small muted' }, m.completeness),
      m && h('ul', { class: 'small' }, ...(m.limitations ?? []).map((l) => h('li', {}, l)))),
    h('section', { class: 'card' }, h('h3', {}, 'Notes & decisions'),
      ...[...byCode].map(([code, list]) => h('details', {},
        h('summary', {}, badge(list[0].severity, list[0].severity === 'warning' ? 'warn' : ''), ` ${code.replace(/_/g, ' ')} (${list.length})`),
        h('ul', { class: 'small' }, ...list.map((i) => h('li', {}, i.entity === 'sessions' && i.entity_id ? h('a', { href: `#/session/${i.entity_id}` }, i.message) : i.message)))))),
    bench.length > 0 && h('section', { class: 'card' }, h('h3', {}, 'August benchmarks (as written)'),
      h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, h('th', {}, 'Machine'), h('th', {}, 'Benchmark'), h('th', {}, 'Context'))),
        h('tbody', {}, ...bench.map((b) => h('tr', {}, h('td', {}, b.label), h('td', {}, `${b.benchmark} (${b.date_text})`), h('td', { class: 'small' }, b.context)))))),
    m?.training_logic && h('details', { class: 'card' }, h('summary', {}, 'Training rules from your file'),
      h('dl', { class: 'kv small' }, ...Object.entries(m.training_logic).filter(([, v]) => typeof v === 'string').map(([k, v]) => [h('dt', {}, k.replace(/_/g, ' ')), h('dd', {}, v)]))));
}

function audit(app) {
  const rows = repo.auditFor(app.db);
  return h('section', { class: 'card' }, h('h3', {}, 'Edit history'),
    h('p', { class: 'tiny muted' }, 'Every change to sets, sessions, machines and plans. Old values are kept here and in the backup.'),
    rows.length ? h('ul', { class: 'audit' }, ...rows.map((r) => {
      const b = r.before_json ? JSON.parse(r.before_json) : null;
      const a = r.after_json ? JSON.parse(r.after_json) : null;
      const changed = b && a ? Object.keys(a).filter((k) => !['updated_at_utc', 'sides'].includes(k) && JSON.stringify(a[k]) !== JSON.stringify(b[k])) : [];
      return h('li', {},
        h('div', { class: 'small' }, h('strong', {}, `${r.action} ${r.entity.replace(/_/g, ' ')}`), ` · ${new Date(r.at_utc).toLocaleString('en-SG', { timeZone: 'Asia/Singapore' })}`),
        r.reason && h('div', { class: 'tiny' }, `Reason: ${r.reason}`),
        changed.length > 0 && h('div', { class: 'tiny muted mono' }, changed.slice(0, 6).map((k) => `${k}: ${JSON.stringify(b[k])} → ${JSON.stringify(a[k])}`).join('; ')));
    })) : h('p', { class: 'muted' }, 'No edits yet.'));
}
