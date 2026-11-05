// Small DOM toolkit: h() element builder, sheets, toasts, steppers, RIR picker, charts.

export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  append(el, kids);
  return el;
}

function append(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k === null || k === undefined || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
}

const SVGNS = 'http://www.w3.org/2000/svg';
export function s(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) el.setAttribute(k, v);
  for (const k of kids.flat()) if (k) el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return el;
}

// ------------------------------------------------------------ toasts & sheets
export function toast(msg, { action, onAction, ms = 3500 } = {}) {
  const host = document.getElementById('toasts');
  const t = h('div', { class: 'toast', role: 'status' }, h('span', {}, msg),
    action && h('button', { class: 'link', onclick: () => { onAction?.(); t.remove(); } }, action));
  host.append(t);
  setTimeout(() => t.remove(), ms);
}

export function sheet(title, body, { onClose } = {}) {
  const host = document.getElementById('sheet-host');
  const close = () => { wrap.remove(); onClose?.(); document.removeEventListener('keydown', esc); };
  const esc = (e) => { if (e.key === 'Escape') close(); };
  const panel = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'sheet-head' }, h('h2', {}, title), h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: close }, '✕')),
    h('div', { class: 'sheet-body' }, body));
  const wrap = h('div', { class: 'sheet-wrap', onclick: (e) => { if (e.target === wrap) close(); } }, panel);
  host.append(wrap);
  document.addEventListener('keydown', esc);
  setTimeout(() => panel.querySelector('input,select,button:not(.icon-btn)')?.focus(), 50);
  return { close, panel };
}

export function confirmSheet(title, message, okLabel, onOk, { danger = false } = {}) {
  let ref;
  const body = h('div', {}, h('p', {}, message),
    h('div', { class: 'row gap' },
      h('button', { class: 'btn', onclick: () => ref.close() }, 'Cancel'),
      h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, onclick: () => { ref.close(); onOk(); } }, okLabel)));
  ref = sheet(title, body);
}

// ------------------------------------------------------------ inputs
export function field(label, input, hint) {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), input, hint && h('span', { class: 'hint' }, hint));
}

export function numInput(value, { step = 'any', min, placeholder, inputmode = 'decimal' } = {}) {
  return h('input', { type: 'number', inputmode, step, min, placeholder, value: value ?? '' });
}

export const numVal = (inp) => (inp.value === '' ? null : Number(inp.value));

export function fmtNum(n, dp = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return String(Math.round(n * 10 ** dp) / 10 ** dp);
}

export function segmented(options, value, onChange, ariaLabel) {
  let cur = value;
  const el = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': ariaLabel });
  const draw = () => el.replaceChildren(...options.map(([v, label]) =>
    h('button', { type: 'button', role: 'radio', 'aria-checked': v === cur ? 'true' : 'false', class: v === cur ? 'on' : '', onclick: () => { cur = v; draw(); onChange?.(v); } }, label)));
  draw();
  el.get = () => cur;
  el.set = (v) => { cur = v; draw(); };
  return el;
}

export function badge(text, kind = '') {
  return h('span', { class: `badge ${kind}` }, text);
}

export function download(filename, content, type = 'application/json') {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const a = h('a', { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

export function pickFiles(accept, multiple = false) {
  return new Promise((resolve) => {
    const inp = h('input', { type: 'file', accept, multiple, style: { display: 'none' } });
    inp.addEventListener('change', async () => {
      const list = await Promise.all([...inp.files].map(async (f) => ({ name: f.name, text: await f.text() })));
      inp.remove();
      resolve(list);
    });
    document.body.append(inp);
    inp.click();
  });
}

export function pickFile(accept) {
  return new Promise((resolve) => {
    const inp = h('input', { type: 'file', accept, style: { display: 'none' } });
    inp.addEventListener('change', async () => {
      const f = inp.files[0];
      inp.remove();
      resolve(f ? { name: f.name, text: await f.text() } : null);
    });
    document.body.append(inp);
    inp.click();
  });
}

// ------------------------------------------------------------ line chart
// Single series over time: 2px line, ≥8px markers, recessive grid, hover/focus
// tooltip, hollow markers for reconstructed points. Text uses text tokens.
export function lineChart(points, { yLabel, fmt = (v) => v, height = 200 } = {}) {
  const wrap = h('div', { class: 'chart' });
  if (!points.length) {
    wrap.append(h('p', { class: 'muted' }, 'No data yet.'));
    return wrap;
  }
  const W = 360;
  const H = height;
  const pad = { l: 44, r: 12, t: 14, b: 28 };
  const ys = points.map((p) => p.y);
  let lo = Math.min(...ys);
  let hi = Math.max(...ys);
  if (lo === hi) { lo -= 1; hi += 1; }
  const span = hi - lo;
  lo -= span * 0.12;
  hi += span * 0.12;
  if (lo < 0 && Math.min(...ys) >= 0) lo = 0;
  // Time-scaled x so gaps between sessions read honestly; index fallback if a date is missing.
  const ts = points.map((p) => (p.date ? Date.parse(p.date) : NaN));
  const timed = ts.every(Number.isFinite) && ts[ts.length - 1] > ts[0];
  const x = (i) => pad.l + (points.length === 1 ? (W - pad.l - pad.r) / 2
    : timed ? ((ts[i] - ts[0]) / (ts[ts.length - 1] - ts[0])) * (W - pad.l - pad.r)
    : (i * (W - pad.l - pad.r)) / (points.length - 1));
  const y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b);
  const ticks = niceTicks(lo, hi, 4);
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `${yLabel} over time`, class: 'chart-svg' });
  for (const t of ticks) {
    svg.append(s('line', { x1: pad.l, x2: W - pad.r, y1: y(t), y2: y(t), class: 'grid' }));
    svg.append(s('text', { x: pad.l - 6, y: y(t) + 4, 'text-anchor': 'end', class: 'tick' }, fmt(t)));
  }
  const labelIdx = new Set([0, points.length - 1, Math.floor((points.length - 1) / 2)]);
  points.forEach((p, i) => {
    if (labelIdx.has(i)) svg.append(s('text', { x: x(i), y: H - 8, 'text-anchor': i === 0 && points.length > 1 ? 'start' : i === points.length - 1 && points.length > 1 ? 'end' : 'middle', class: 'tick' }, shortDate(p.date)));
  });
  if (points.length > 1) svg.append(s('path', { d: points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.y).toFixed(1)}`).join(''), class: 'series-line' }));
  const tip = h('div', { class: 'chart-tip', role: 'status', 'aria-live': 'polite' });
  const cross = s('line', { y1: pad.t, y2: H - pad.b, class: 'crosshair', visibility: 'hidden' });
  svg.append(cross);
  const show = (i) => {
    const p = points[i];
    cross.setAttribute('x1', x(i));
    cross.setAttribute('x2', x(i));
    cross.setAttribute('visibility', 'visible');
    tip.replaceChildren(h('strong', {}, `${fmt(p.y)}`), ` · ${p.date}`, p.hollow ? ' · reconstructed' : '', p.detail ? h('div', { class: 'muted' }, p.detail) : null);
    tip.style.left = `${(x(i) / W) * 100}%`;
    tip.classList.add('on');
  };
  const hide = () => { cross.setAttribute('visibility', 'hidden'); tip.classList.remove('on'); };
  points.forEach((p, i) => {
    svg.append(s('circle', { cx: x(i), cy: y(p.y), r: 5, class: p.hollow ? 'dot hollow' : 'dot' }));
    const hit = s('circle', { cx: x(i), cy: y(p.y), r: 16, class: 'hit', tabindex: 0, 'aria-label': `${p.date}: ${fmt(p.y)}` });
    hit.addEventListener('pointerenter', () => show(i));
    hit.addEventListener('focus', () => show(i));
    hit.addEventListener('click', () => show(i));
    hit.addEventListener('blur', hide);
    svg.append(hit);
  });
  svg.addEventListener('pointerleave', hide);
  wrap.append(svg, tip);
  return wrap;
}

function niceTicks(lo, hi, n) {
  const raw = (hi - lo) / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((m) => m >= raw) ?? 10 * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v * 100) / 100);
  return out;
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function shortDate(d) {
  if (!d) return 'date unknown';
  const [, m, day] = d.split('-').map(Number);
  return `${day} ${MON[m - 1]}`;
}
export function longDate(d) {
  if (!d) return 'Date unknown';
  const [Y, m, day] = d.split('-').map(Number);
  const wd = new Date(Date.UTC(Y, m - 1, day)).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });
  return `${wd} ${day} ${MON[m - 1]} ${Y}`;
}
