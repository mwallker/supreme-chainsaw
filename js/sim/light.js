// Light & visibility: time of day, light sources, per-tile light levels and hit chance.
// Pure functions of (state, map) so host (authoritative rolls) and clients (UI previews) agree.
import { T } from '../data/tiles.js';
import { ENEMIES } from '../data/enemies.js';

export const LIT = 2, DIM = 1, DARK = 0;
export const LIGHT_NAMES = ['Dark', 'Dim', 'Lit'];
export const LIGHT_ICONS = ['●', '◐', '☀'];
export const LIGHT_PENALTY = [-35, -15, 0];

// ---------------- time of day (minutes, 0..1440) ----------------
export const START_TIME = 9 * 60;
export const DAWN = 6 * 60, DAY = 7.5 * 60, DUSK = 18.5 * 60, NIGHT = 20 * 60;
export function phaseOf(time) {
  const m = ((time % 1440) + 1440) % 1440;
  if (m >= DAY && m < DUSK) return 'day';
  if (m >= DAWN && m < DAY) return 'dawn';
  if (m >= DUSK && m < NIGHT) return 'dusk';
  return 'night';
}
export const ambientOf = (time) => ({ day: LIT, dawn: DIM, dusk: DIM, night: DARK })[phaseOf(time)];
/** Smooth 0 (night) .. 1 (day) factor for rendering. */
export function daylight(time) {
  const m = ((time % 1440) + 1440) % 1440;
  if (m >= DAY && m < DUSK) return 1;
  if (m >= NIGHT || m < DAWN) return 0;
  if (m < DAY) return (m - DAWN) / (DAY - DAWN);
  return 1 - (m - DUSK) / (NIGHT - DUSK);
}
export function clockText(time) {
  const m = ((Math.floor(time) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

// ---------------- light sources ----------------
/** [x, y, brightRadius, dimRadius] for everything that emits light. */
export function lightSources(state, map) {
  const out = [];
  for (const e of Object.values(state.entities)) {
    if (e.kind === 'object') {
      if (e.type === 'campfire' && e.lit) out.push([e.x, e.y, 3, 6]);
      else if (e.type === 'forge' && e.lit) out.push([e.x, e.y, 2, 4]);
      else if (e.type === 'burning_tree') out.push([e.x, e.y, 2, 5]);
      continue;
    }
    if (e.dead) continue;
    if (e.st?.burning) out.push([e.x, e.y, 1, 3]);
    if (e.eq?.offhand?.id === 'lit_torch') out.push([e.x, e.y, 2, 5]);
    const glow = ENEMIES[e.type]?.glow;
    if (glow) out.push([e.x, e.y, glow[0], glow[1]]);
  }
  const W = map.W;
  for (const [k, s] of Object.entries(state.surfaces)) {
    const x = k % W, y = Math.floor(k / W);
    if (s.type === 'fire') out.push([x, y, 1, 3]);
    else if (s.e) out.push([x, y, 0, 2]);
  }
  return out;
}

const cache = new WeakMap();
const frozen = new WeakMap();
const baseCache = new WeakMap();
/** While evaluating many hypothetical actions (bots) the world doesn't change: compute light once. */
export function freezeLight(state, map, L) { frozen.delete(state); frozen.set(state, L || lightMap(state, map)); }
export function thawLight(state) { frozen.delete(state); }
/** Whole-map light levels (Uint8Array, LIT/DIM/DARK), cached until anything relevant changes. */
export function lightMap(state, map) {
  const fz = frozen.get(state);
  if (fz) return fz;
  const amb = ambientOf(state.time ?? START_TIME);
  // cheap allocation-free fingerprint of everything that affects light; full rebuild only when it changes
  let key = amb * 7919 + 17;
  const mix = (v) => { key = (Math.imul(key, 31) + v) | 0; };
  for (const id in state.entities) {
    const e = state.entities[id];
    if (e.kind === 'object') {
      if (e.type === 'burning_tree' || ((e.type === 'campfire' || e.type === 'forge') && e.lit)) { mix(e.x); mix(e.y); mix(e.type.length); }
    } else if (!e.dead && (e.st?.burning || e.eq?.offhand?.id === 'lit_torch' || ENEMIES[e.type]?.glow)) { mix(e.x * 1031 + e.y); mix(e.st?.burning ? 3 : 1); }
  }
  for (const k in state.surfaces) {
    const s = state.surfaces[k];
    if (s.type === 'fire' || s.e || s.type === 'steam' || s.type === 'smoke') { mix(+k); mix(s.type.length + (s.e ? 9 : 0)); }
  }
  const c = cache.get(state);
  if (c && c.key === key && c.map === map) return c.L;
  const src = lightSources(state, map);
  const W = map.W, H = map.H;
  // ambient layer depends only on map + phase: cache it and copy
  let b = baseCache.get(map);
  if (!b || b.amb !== amb) {
    const base = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) { const t = map.tiles[i]; base[i] = Math.max(0, amb - (t === T.FOREST || t === T.FLOOR ? 1 : 0)); }
    baseCache.set(map, (b = { amb, base }));
  }
  const L = c && c.map === map ? c.L : new Uint8Array(W * H);
  L.set(b.base);
  for (const [sx, sy, b, d] of src) {
    for (let y = Math.max(0, sy - d); y <= Math.min(H - 1, sy + d); y++)
      for (let x = Math.max(0, sx - d); x <= Math.min(W - 1, sx + d); x++) {
        const r = Math.hypot(x - sx, y - sy);
        if (r > d + 0.5) continue;
        const lv = r <= b + 0.5 ? LIT : DIM;
        const k = x + y * W;
        if (lv > L[k]) L[k] = lv;
      }
  }
  for (const [k, s] of Object.entries(state.surfaces)) {
    if (s.type === 'smoke') L[k] = DARK;
    else if (s.type === 'steam') L[k] = Math.min(L[k], DIM);
  }
  cache.set(state, { key, L, map });
  return L;
}
export const lightAt = (state, map, x, y) => (map.inb(x, y) ? lightMap(state, map)[map.idx(x, y)] : DARK);

// ---------------- accuracy ----------------
export const hasDarkvision = (e) => !!(e?.st?.nightsight || ENEMIES[e?.type]?.darkvision);

/**
 * Chance (5..95) for `att` to hit `tgt`. kind: 'melee' | 'ranged' | 'spell'.
 * Returns { chance, parts: [[label, modifier]], light } — parts explain the number in the UI.
 */
export function hitChance(state, map, att, tgt, kind = 'melee') {
  const L = lightMap(state, map);
  const lt = L[map.idx(tgt.x, tgt.y)], la = L[map.idx(att.x, att.y)];
  const parts = [['base', kind === 'melee' ? 90 : 85]];
  const fin = ((att.attrs?.finesse ?? 3) - 3) * 2;
  if (fin) parts.push(['your finesse', fin]);
  const dodge = -((tgt.attrs?.finesse ?? 3) - 3) * 2;
  if (dodge) parts.push(['target agility', dodge]);
  const seen = hasDarkvision(att) ? Math.min(LIT, lt + 1) : lt;
  if (seen < LIT) parts.push([`target ${seen === DIM ? 'in dim light' : 'in darkness'}${hasDarkvision(att) ? ' (darkvision)' : ''}`, LIGHT_PENALTY[seen]]);
  if (la === DARK && lt === LIT && !hasDarkvision(tgt)) parts.push(['you are unseen in the dark', 10]);
  if (tgt.st?.frozen || tgt.st?.stunned) parts.push(['target helpless', 50]);
  const sum = parts.reduce((a, [, v]) => a + v, 0);
  return { chance: Math.max(5, Math.min(95, sum)), parts, light: lt };
}
export const describeHit = (h) => h.parts.slice(1).map(([l, v]) => `${l} ${v > 0 ? '+' : ''}${v}`).join(', ');
