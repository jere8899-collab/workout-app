// Boots SQLite in the browser and persists the database file to IndexedDB.
import { Db } from '../lib/db/database.js';
import { importBundled, createTemplatePlan } from '../lib/seed.js';
import * as repo from '../lib/db/repo.js';
import { getSetting, setSetting } from '../lib/db/repo.js';

const IDB_NAME = 'workout-tracker';
const STORE = 'files';
const KEY = 'main.sqlite';

function idb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(IDB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function idbGet() {
  const d = await idb();
  return new Promise((resolve, reject) => {
    const q = d.transaction(STORE).objectStore(STORE).get(KEY);
    q.onsuccess = () => resolve(q.result ?? null);
    q.onerror = () => reject(q.error);
  });
}

async function idbPut(bytes) {
  const d = await idb();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(bytes, KEY);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

export const storage = { ok: true, lastSaved: null, error: null };

export async function boot() {
  const SQL = await window.initSqlJs({ locateFile: (f) => `vendor/${f}` });
  let bytes = null;
  try {
    bytes = await idbGet();
  } catch (e) {
    storage.ok = false;
    storage.error = 'This browser blocked local storage — data will be lost on reload. Export a backup before closing.';
  }
  const db = new Db(SQL, bytes);
  let timer = null;
  const save = async () => {
    clearTimeout(timer);
    timer = null;
    if (!storage.ok) return;
    try {
      await idbPut(db.export());
      storage.lastSaved = new Date();
    } catch (e) {
      storage.ok = false;
      storage.error = `Could not save: ${e.message}. Export a backup now.`;
    }
  };
  db.onWrite = () => {
    clearTimeout(timer);
    timer = setTimeout(save, 250);
  };
  db.flush = save;
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && timer) save(); });

  // History is bundled only on a private/local install. The public site ships
  // without it, so the user imports their own file on first open.
  let firstRun = null;
  let needsSetup = false;
  if (!getSetting(db, 'bundled_import_done') && !getSetting(db, 'setup_done')) {
    const get = (f) => fetch(f).then((r) => (r.ok ? r.text() : null)).catch(() => null);
    const [jsonText, augustMdText] = await Promise.all([
      get('data/workout_history_and_logic.json'),
      get('data/Jeremy_Workout_Training_Log_Aug2026.md'),
    ]);
    if (jsonText) {
      firstRun = completeSetup(db, { jsonText, augustMdText });
      await save();
    } else {
      needsSetup = true;
    }
  }
  repo.ensureMuscleDefaults(db);
  return { db, firstRun, needsSetup };
}

export function completeSetup(db, { jsonText = null, augustMdText = null } = {}) {
  const report = jsonText ? importBundled(db, { jsonText, augustMdText }) : null;
  if (report) createTemplatePlan(db);
  setSetting(db, 'setup_done', true);
  return report;
}

