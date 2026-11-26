export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const ri = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
export const roll = (r) => ri(r[0], r[1]);
export const chance = (p) => Math.random() < p;
export const cheb = (ax, ay, bx, by) => Math.max(Math.abs(ax - bx), Math.abs(ay - by));
export const pick = (a) => a[Math.floor(Math.random() * a.length)];
export const shuffle = (a) => {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
export const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Tiles in a rough circle of radius r around (x,y). r=0 -> single tile, r=1 -> 3x3. */
export function circleTiles(x, y, r) {
  const out = [];
  for (let dy = -r; dy <= r; dy++)
    for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= r * r + r) out.push([x + dx, y + dy]);
  return out;
}

export class Emitter {
  constructor() { this.h = {}; }
  on(e, f) { (this.h[e] || (this.h[e] = [])).push(f); return this; }
  off(e, f) { this.h[e] = (this.h[e] || []).filter((g) => g !== f); }
  emit(e, ...a) { for (const f of (this.h[e] || []).slice()) f(...a); }
}

export const randomCode = (n = 5) => {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < n; i++) s += A[Math.floor(Math.random() * A.length)];
  return s;
};
