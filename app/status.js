// Top status bar shown on every screen during a workout: workout clock, totals
// and rest. Rest counts down from a stored end time, so it survives reloads.
import { h } from './ui.js';
import { activeSession, getSessionGraph, latestBodyWeight } from '../lib/db/repo.js';
import { summarizeSession } from '../lib/domain/summary.js';
import { elapsedSince } from '../lib/domain/time.js';

const KEY = 'rest_timer';
let app = null;
let ui = null;
let startedAt = null;
let beeped = false;
let wake = null;

function remember() {
  try {
    if (app.timer) localStorage.setItem(KEY, JSON.stringify(app.timer));
    else localStorage.removeItem(KEY);
  } catch { /* storage optional */ }
}

export function startRest(sec, label, setId = null) {
  app.timer = { endAt: Date.now() + sec * 1000, total: sec, label, setId };
  beeped = false;
  remember();
  tick();
}

export function stopRest() {
  app.timer = null;
  remember();
  tick();
}

function adjustRest(d) {
  if (!app.timer) return;
  app.timer.endAt += d * 1000;
  app.timer.total = Math.max(1, app.timer.total + d);
  remember();
  tick();
}

function beep() {
  try {
    navigator.vibrate?.([300, 120, 300]);
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.25, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.6);
  } catch { /* audio optional */ }
}

function build() {
  const host = document.getElementById('status-bar');
  ui = {
    host,
    link: h('a', { class: 'status-main' }),
    clock: h('strong', { class: 'status-clock' }),
    totals: h('span', { class: 'status-totals' }),
    rest: h('div', { class: 'status-rest' }),
    fill: h('div', { class: 'rest-fill' }),
    label: h('div', { class: 'rest-label' }),
    time: h('div', { class: 'rest-time' }),
    action: h('button', { class: 'btn small rest-go', onclick: () => stopRest() }, 'Skip'),
  };
  ui.link.append(ui.clock, ui.totals);
  ui.rest.append(ui.fill, h('div', { class: 'rest-inner' },
    h('div', { class: 'grow' }, ui.label, ui.time),
    h('button', { class: 'btn small', 'aria-label': 'Rest 15 seconds less', onclick: () => adjustRest(-15) }, '−15'),
    h('button', { class: 'btn small', 'aria-label': 'Rest 15 seconds more', onclick: () => adjustRest(15) }, '+15'),
    ui.action));
  host.append(ui.link, ui.rest);
}

function tick() {
  if (!ui) return;
  ui.clock.textContent = startedAt ? elapsedSince(startedAt) : '';
  const t = app.timer;
  ui.rest.hidden = !t;
  if (!t) return;
  const left = Math.round((t.endAt - Date.now()) / 1000);
  const over = left <= 0;
  if (over && !beeped) { beeped = true; beep(); }
  const abs = Math.abs(left);
  ui.time.textContent = `${over ? '+' : ''}${Math.floor(abs / 60)}:${String(abs % 60).padStart(2, '0')}`;
  ui.label.textContent = over ? 'Rest over' : `Rest · ${t.label}`;
  ui.action.textContent = over ? 'Done' : 'Skip';
  ui.rest.classList.toggle('over', over);
  ui.fill.style.transform = `scaleX(${Math.max(0, Math.min(1, 1 - left / t.total))})`;
}

async function syncWake(active) {
  try {
    if (active && !wake && document.visibilityState === 'visible' && navigator.wakeLock) {
      wake = await navigator.wakeLock.request('screen');
      wake.addEventListener('release', () => { wake = null; });
    } else if (!active && wake) {
      await wake.release();
      wake = null;
    }
  } catch { wake = null; /* screen-on is a convenience */ }
}

// Called after every screen draw, so totals always match the data.
export function refreshStatus() {
  const s = activeSession(app.db);
  ui.host.hidden = !s;
  startedAt = s?.started_at_utc ?? null;
  if (s) {
    const g = getSessionGraph(app.db, s.id);
    const sum = summarizeSession(g, { bodyKg: latestBodyWeight(app.db, g.session.date_local) });
    ui.link.href = `#/session/${s.id}`;
    ui.totals.textContent = `${sum.workingSets} set${sum.workingSets === 1 ? '' : 's'} · ${app.fmtVol(sum.volumeKg)}`;
  } else if (app.timer) {
    stopRest();
  }
  tick();
  syncWake(!!s);
}

export function initStatus(appRef) {
  app = appRef;
  try {
    const t = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (t && t.endAt > Date.now() - 10 * 60 * 1000) app.timer = t;
    if (t && t.endAt < Date.now()) beeped = true;
  } catch { /* storage optional */ }
  build();
  setInterval(tick, 1000);
  document.addEventListener('visibilitychange', () => { tick(); syncWake(!!startedAt); });
}
