// A simple front-and-back body figure drawn for this app: one shape per muscle.
// Shading always comes with a pattern, so it never depends on colour alone.
import { s } from './ui.js';

// [muscle, side, shape, ...geometry] on a 220 × 230 canvas (front x<110, back x>110).
const SHAPES = [
  ['front delts', 'front', 'ellipse', 33, 52, 9, 8], ['front delts', 'front', 'ellipse', 77, 52, 9, 8],
  ['side delts', 'front', 'ellipse', 25, 58, 5, 9], ['side delts', 'front', 'ellipse', 85, 58, 5, 9],
  ['chest', 'front', 'rect', 39, 52, 32, 20, 6],
  ['biceps', 'front', 'rect', 19, 66, 9, 22, 4], ['biceps', 'front', 'rect', 82, 66, 9, 22, 4],
  ['forearms', 'front', 'rect', 15, 92, 9, 24, 4], ['forearms', 'front', 'rect', 86, 92, 9, 24, 4],
  ['abs', 'front', 'rect', 44, 76, 22, 34, 5],
  ['quads', 'front', 'rect', 35, 122, 15, 46, 6], ['quads', 'front', 'rect', 60, 122, 15, 46, 6],
  ['adductors', 'front', 'rect', 51, 122, 8, 30, 3],
  ['calves', 'front', 'rect', 37, 176, 11, 34, 5], ['calves', 'front', 'rect', 62, 176, 11, 34, 5],
  ['rear delts', 'back', 'ellipse', 143, 52, 9, 8], ['rear delts', 'back', 'ellipse', 187, 52, 9, 8],
  ['side delts', 'back', 'ellipse', 135, 58, 5, 9], ['side delts', 'back', 'ellipse', 195, 58, 5, 9],
  ['back', 'back', 'rect', 149, 52, 32, 30, 6],
  ['lower back', 'back', 'rect', 154, 85, 22, 18, 4],
  ['triceps', 'back', 'rect', 129, 66, 9, 22, 4], ['triceps', 'back', 'rect', 192, 66, 9, 22, 4],
  ['forearms', 'back', 'rect', 125, 92, 9, 24, 4], ['forearms', 'back', 'rect', 196, 92, 9, 24, 4],
  ['glutes', 'back', 'rect', 146, 106, 38, 18, 8],
  ['hamstrings', 'back', 'rect', 145, 128, 15, 40, 6], ['hamstrings', 'back', 'rect', 170, 128, 15, 40, 6],
  ['calves', 'back', 'rect', 147, 176, 11, 34, 5], ['calves', 'back', 'rect', 172, 176, 11, 34, 5],
];

function outline(cx) {
  return [
    s('circle', { cx, cy: 26, r: 13, class: 'bm-skin' }),
    s('rect', { x: cx - 36, y: 44, width: 72, height: 70, rx: 14, class: 'bm-skin' }),
    s('rect', { x: cx - 22, y: 112, width: 44, height: 104, rx: 10, class: 'bm-skin' }),
    s('rect', { x: cx - 46, y: 50, width: 14, height: 70, rx: 7, class: 'bm-skin' }),
    s('rect', { x: cx + 32, y: 50, width: 14, height: 70, rx: 7, class: 'bm-skin' }),
  ];
}

// status: muscle -> 'none' | 'below' | 'within' | 'above'
export function bodyMap(status, onPick) {
  const svg = s('svg', { viewBox: '0 0 220 230', class: 'bodymap', role: 'img', 'aria-label': 'Muscles trained this week, front and back' },
    s('defs', {},
      s('pattern', { id: 'bm-hatch', width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, s('rect', { width: 2, height: 6, class: 'bm-pat' })),
      s('pattern', { id: 'bm-dots', width: 5, height: 5, patternUnits: 'userSpaceOnUse' }, s('circle', { cx: 2.5, cy: 2.5, r: 1.2, class: 'bm-pat' }))),
    ...outline(55), ...outline(165),
    s('text', { x: 55, y: 228, 'text-anchor': 'middle', class: 'bm-label' }, 'Front'),
    s('text', { x: 165, y: 228, 'text-anchor': 'middle', class: 'bm-label' }, 'Back'));
  for (const [muscle, , shape, ...g] of SHAPES) {
    const st = status[muscle] ?? 'none';
    const attrs = shape === 'ellipse'
      ? { cx: g[0], cy: g[1], rx: g[2], ry: g[3] }
      : { x: g[0], y: g[1], width: g[2], height: g[3], rx: g[4] };
    const base = s(shape, { ...attrs, class: `bm-m bm-${st}` });
    const overlay = st === 'below' || st === 'above'
      ? s(shape, { ...attrs, class: 'bm-overlay', fill: `url(#bm-${st === 'below' ? 'hatch' : 'dots'})` })
      : null;
    const hit = s(shape, { ...attrs, class: 'bm-hit', tabindex: 0, 'aria-label': `${muscle}: ${st === 'none' ? 'no sets' : `${st} target`}` });
    hit.addEventListener('click', () => onPick(muscle));
    hit.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(muscle); } });
    svg.append(base, overlay ?? '', hit);
  }
  return svg;
}
