// Number pad docked at the bottom of the screen. It has no backdrop, so the set
// table stays usable while it is open, including the ticks.
import { h, fmtNum } from './ui.js';

const RIR_VALUES = [0, 1, 2, 3, 4, 5];
let current = null;

export function closePad() {
  if (!current) return;
  current = null;
  document.getElementById('pad-host').replaceChildren();
  document.body.classList.remove('pad-open');
  document.querySelectorAll('.cell.active').forEach((c) => c.classList.remove('active'));
}

function parseRange(v) {
  const m = String(v ?? '').match(/(\d+)(?:\s*[–-]\s*(\d+))?/);
  if (!m) return null;
  return m[2] ? [Number(m[1]), Number(m[2])] : [Math.min(5, Number(m[1]))];
}

function numberKeys(state, { decimals, step, unit, onChange, onNext, nextLabel }) {
  const shown = h('div', { class: 'pad-value', 'aria-live': 'polite' });
  const paint = () => { shown.textContent = state.buffer === '' ? '–' : `${state.buffer}${unit ? ` ${unit}` : ''}`; };
  const emit = () => {
    paint();
    const n = parseFloat(state.buffer);
    onChange(Number.isFinite(n) ? n : null);
  };
  const press = (k) => {
    if (state.fresh) { state.buffer = ''; state.fresh = false; }
    if (k === '.' && state.buffer.includes('.')) return;
    state.buffer = k === '.' && !state.buffer ? '0.' : state.buffer + k;
    emit();
  };
  const back = () => { state.fresh = false; state.buffer = state.buffer.slice(0, -1); emit(); };
  const nudge = (d) => {
    const n = (parseFloat(state.buffer) || 0) + d;
    state.buffer = fmtNum(Math.max(0, n), 2);
    state.fresh = true;
    emit();
  };
  paint();
  const key = (label, fn, cls = '', aria) => h('button', { type: 'button', class: `pad-key ${cls}`, 'aria-label': aria, onclick: fn }, label);
  return h('div', {},
    h('div', { class: 'pad-top' }, shown),
    h('div', { class: 'pad-grid' },
      ...['1', '2', '3'].map((k) => key(k, () => press(k))),
      key(`−${fmtNum(step, 2)}`, () => nudge(-step), 'alt', `Decrease by ${step}`),
      ...['4', '5', '6'].map((k) => key(k, () => press(k))),
      key(`+${fmtNum(step, 2)}`, () => nudge(step), 'alt', `Increase by ${step}`),
      ...['7', '8', '9'].map((k) => key(k, () => press(k))),
      key('⌫', back, 'alt', 'Delete'),
      decimals ? key('.', () => press('.')) : h('span', {}),
      key('0', () => press('0')),
      key(nextLabel, onNext, 'next wide')));
}

function rirKeys(state, { onChange, onNext, nextLabel }) {
  const row = h('div', { class: 'pad-rir' });
  const text = () => {
    if (!state.sel) return null;
    if (state.sel[1] !== undefined) return `${state.sel[0]}–${state.sel[1]}`;
    return state.sel[0] === 5 ? '5+' : String(state.sel[0]);
  };
  const shown = h('div', { class: 'pad-value', 'aria-live': 'polite' });
  const draw = () => {
    shown.textContent = text() ?? 'Not sure';
    row.replaceChildren(...RIR_VALUES.map((n) => {
      const on = state.sel && n >= state.sel[0] && n <= (state.sel[1] ?? state.sel[0]);
      return h('button', { type: 'button', class: `pad-key ${on ? 'on' : ''}`, 'aria-pressed': on ? 'true' : 'false', onclick: () => pick(n) }, n === 5 ? '5+' : String(n));
    }));
  };
  const pick = (n) => {
    const single = state.sel && state.sel[1] === undefined;
    state.sel = single && Math.abs(n - state.sel[0]) === 1 ? [Math.min(n, state.sel[0]), Math.max(n, state.sel[0])] : [n];
    draw();
    onChange(text());
  };
  draw();
  return h('div', {},
    h('div', { class: 'pad-top' }, shown, h('span', { class: 'tiny muted' }, 'Tap two neighbours for a range')),
    row,
    h('div', { class: 'pad-row' },
      h('button', { type: 'button', class: 'pad-key alt', onclick: () => { state.sel = null; draw(); onChange(null); } }, 'Not sure'),
      h('button', { type: 'button', class: 'pad-key next', onclick: onNext }, nextLabel)));
}

// mode: 'decimal' | 'int' | 'rir'. Values and steps are in display units.
export function openPad({ title, mode, value, step = 1, unit = '', onChange, onNext, nextLabel = 'Next', anchor }) {
  closePad();
  const state = mode === 'rir'
    ? { sel: parseRange(value) }
    : { buffer: value === null || value === undefined ? '' : fmtNum(value, 2), fresh: true };
  const keys = mode === 'rir'
    ? rirKeys(state, { onChange, onNext, nextLabel })
    : numberKeys(state, { decimals: mode === 'decimal', step, unit, onChange, onNext, nextLabel });
  const panel = h('div', { class: 'pad', role: 'group', 'aria-label': title },
    h('div', { class: 'pad-head' }, h('strong', {}, title), h('button', { type: 'button', class: 'link', onclick: closePad }, 'Done')),
    keys);
  current = panel;
  document.getElementById('pad-host').replaceChildren(panel);
  document.body.classList.add('pad-open');
  anchor?.classList.add('active');
  if (anchor) {
    const gap = anchor.getBoundingClientRect().bottom + 12 - panel.getBoundingClientRect().top;
    if (gap > 0) window.scrollBy({ top: gap });
  }
}
