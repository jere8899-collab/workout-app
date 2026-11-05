import { boot, storage, completeSetup } from './store.js';
import { restoreBackup } from '../lib/io/export.js';
import { h, toast, pickFiles, fmtNum } from './ui.js';
import { getSetting, setSetting, activeSession } from '../lib/db/repo.js';
import { REST_DEFAULT_SEC } from '../lib/catalog.js';
import { renderToday, renderSession } from './session.js';
import { renderHistory, renderExercises, renderExercise } from './browse.js';
import { renderPlan } from './plan.js';
import { renderSettings } from './settings.js';
import { closePad } from './pad.js';
import { initStatus, refreshStatus } from './status.js';

const LB = 2.20462;

export const app = {
  db: null,
  timer: null,     // { endAt, total, label, setId }
  get units() { return getSetting(this.db, 'units', 'kg'); },
  toDisplay(kg) { return this.units === 'lb' ? kg * LB : kg; },
  fromDisplay(v) { return this.units === 'lb' ? v / LB : v; },
  restFor(category) {
    const r = getSetting(this.db, 'rest_sec', {});
    return r[category] ?? REST_DEFAULT_SEC[category] ?? 105;
  },
  fmtLoad(kg, basis, exerciseName = '') {
    if (kg === null || kg === undefined) return '— kg';
    const v = Math.round(this.toDisplay(kg) * 100) / 100;
    const suffix = basis === 'per_side' ? '/side' : basis === 'per_limb' ? (/kick|leg|calf/i.test(exerciseName) ? '/leg' : '/arm') : '';
    return `${v} ${this.units}${suffix}`;
  },
  fmtDisplay(kg) {
    return kg === null || kg === undefined ? '–' : fmtNum(this.toDisplay(kg), 2);
  },
  fmtVol(kg) {
    if (kg === null || kg === undefined) return '—';
    const v = this.toDisplay(kg);
    return `${v.toLocaleString('en-SG', { maximumFractionDigits: 1 })} ${this.units}`;
  },
  go(hash) {
    if (location.hash === hash) render();
    else location.hash = hash;
  },
  render: () => render(),
};

// ------------------------------------------------------------ router
const TABS = [
  ['#/today', 'Today', '◉'],
  ['#/history', 'History', '☰'],
  ['#/exercises', 'Progress', '↗'],
  ['#/plan', 'Plan', '▦'],
  ['#/settings', 'Settings', '⚙'],
];

function announceImport(db, report) {
  const recon = db.get("SELECT COUNT(*) n FROM sets WHERE fidelity='reconstructed'").n;
  toast(`Imported ${report.sessions} sessions: ${report.sets - recon} detailed sets + ${recon} reconstructed from summaries.`, { action: 'Review', onAction: () => app.go('#/settings/import'), ms: 6000 });
  setSetting(db, 'first_import_report', { sessions: report.sessions, sets: report.sets, at: new Date().toISOString() });
}

// First open of the public site: nothing personal ships with it, so the user
// brings their own history file or a backup made on another device.
function renderSetup() {
  const { db } = app;
  const finish = (report) => {
    app.needsSetup = false;
    db.flush?.();
    location.hash = '#/today';
    render();
    if (report) announceImport(db, report);
  };
  const choose = async () => {
    const files = await pickFiles('.json,.md,application/json,text/markdown', true);
    if (!files.length) return;
    try {
      const json = files.filter((f) => /\.json$/i.test(f.name));
      const md = files.find((f) => /\.md$/i.test(f.name));
      if (json.length !== 1) return toast('Choose one .json file (plus the optional August .md).', { ms: 5000 });
      const obj = JSON.parse(json[0].text);
      if (obj.format === 'workout-app-backup') {
        restoreBackup(db, obj);
        setSetting(db, 'setup_done', true);
        toast('Backup restored.');
        return finish(null);
      }
      finish(completeSetup(db, { jsonText: json[0].text, augustMdText: md?.text ?? null }));
    } catch (e) {
      console.error(e);
      toast(`Could not import: ${e.message.split('\n')[0]}`, { ms: 7000 });
    }
  };
  return h('div', { class: 'stack' },
    h('header', { class: 'page-head' }, h('h1', {}, 'Welcome to Lift Log')),
    h('section', { class: 'card stack' },
      h('p', {}, 'Your training history is not stored online. Load it onto this device once and it stays here, offline.'),
      h('button', { class: 'btn primary block big', onclick: choose }, 'Choose files'),
      h('ul', { class: 'small' },
        h('li', {}, h('strong', {}, 'workout_history_and_logic.json'), ' — your history. Pick the original August log (.md) at the same time to restore RIR values the JSON lost.'),
        h('li', {}, 'or a ', h('strong', {}, 'workout-backup-….json'), ' exported from Settings on another device.'))),
    h('button', { class: 'btn block', onclick: () => { completeSetup(db, {}); finish(null); } }, 'Start with an empty log'),
    h('p', { class: 'tiny muted' }, 'Everything is saved in this browser only. Export a backup from Settings regularly.'));
}

function render() {
  closePad();
  const view = document.getElementById('view');
  const hash = location.hash || '#/today';
  const [, route, arg] = hash.split('/');
  let node;
  try {
    if (app.needsSetup) node = renderSetup();
    else if (route === 'session') node = renderSession(app, decodeURIComponent(arg));
    else if (route === 'history') node = renderHistory(app);
    else if (route === 'exercises') node = renderExercises(app);
    else if (route === 'exercise') node = renderExercise(app, decodeURIComponent(arg));
    else if (route === 'plan') node = renderPlan(app);
    else if (route === 'settings') node = renderSettings(app, arg);
    else node = renderToday(app);
  } catch (e) {
    console.error(e);
    node = h('div', { class: 'card' }, h('h2', {}, 'Something went wrong'), h('pre', { class: 'mono' }, String(e.stack || e)));
  }
  const y = view.dataset.hash === hash ? window.scrollY : 0;
  view.replaceChildren(node);
  view.dataset.hash = hash;
  window.scrollTo(0, y);
  const active = route === 'session' || !route ? '#/today' : route === 'exercise' ? '#/exercises' : `#/${route}`;
  document.querySelectorAll('#nav a').forEach((a) => a.setAttribute('aria-current', a.getAttribute('href') === active ? 'page' : 'false'));
  if (!app.needsSetup) refreshStatus();
  if (storage.error) document.getElementById('storage-warning').replaceChildren(h('div', { class: 'warn-bar', role: 'alert' }, storage.error));
}

async function start() {
  const nav = document.getElementById('nav');
  nav.replaceChildren(...TABS.map(([href, label, icon]) => h('a', { href }, h('span', { class: 'nav-icon', 'aria-hidden': 'true' }, icon), h('span', {}, label))));
  try {
    const { db, firstRun, needsSetup } = await boot();
    app.db = db;
    app.needsSetup = needsSetup;
    window.addEventListener('hashchange', render);
    initStatus(app);
    if (!location.hash) location.hash = activeSession(db) ? `#/session/${activeSession(db).id}` : '#/today';
    render();
    if (firstRun) announceImport(db, firstRun);
  } catch (e) {
    console.error(e);
    document.getElementById('view').replaceChildren(h('div', { class: 'card' }, h('h2', {}, 'Could not start'), h('p', {}, String(e.message || e))));
  }
  if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => {});
}

start();
