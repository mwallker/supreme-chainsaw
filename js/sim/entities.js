// Entity factories, derived stats and inventory helpers (pure — usable on host and client).
import { ITEMS } from '../data/items.js';
import { ENEMIES } from '../data/enemies.js';
import { CLASSES } from '../data/classes.js';

export const MAX_SLOTS = 32;

export function makeEnemy(type, x, y, grp, extra = {}) {
  const t = ENEMIES[type];
  return {
    kind: 'enemy', type, name: t.n, x, y, hx: x, hy: y, grp,
    hp: t.hp, maxHp: t.hp, ap: 0, mp: 0, st: {},
    attrs: { ...t.attrs }, skills: (t.skills || []).map((id) => ({ id, cd: 0 })),
    ...extra,
  };
}

export function makePlayer(char, x, y) {
  const c = CLASSES[char.cls];
  const e = {
    kind: 'player', type: 'player', name: char.name, cls: char.cls, color: char.color, x, y,
    attrs: { ...char.attrs }, level: 1, xp: 0, pts: 0,
    ap: 0, mp: 0, st: {}, inv: [], eq: { weapon: null, offhand: null, armor: null },
    skills: c.skills.map((id) => ({ id, cd: 0 })), passive: c.passive || null,
  };
  for (const [slot, id] of Object.entries(c.eq)) e.eq[slot] = { id, q: 1 };
  for (const [id, q] of c.inv) addItem(e, id, q);
  e.maxHp = maxHp(e);
  e.hp = e.maxHp;
  return e;
}

export function maxHp(e) {
  if (e.kind !== 'player') return e.maxHp;
  return 18 + e.attrs.vigor * 4 + (e.level - 1) * 6;
}
export const maxAp = () => 6;
export const apRegen = () => 4;
export function moveRange(e) {
  let r = e.kind === 'enemy' ? ENEMIES[e.type].move || 3 : 3 + (e.attrs.finesse >= 6 ? 1 : 0);
  if (e.st?.oiled) r = Math.max(1, Math.floor(r / 2));
  return r;
}
export function armorOf(e) {
  if (e.kind === 'enemy') return ENEMIES[e.type].armor || 0;
  let a = 0;
  for (const s of Object.values(e.eq || {})) if (s) a += ITEMS[s.id].armor || 0;
  return a;
}
export function resistOf(e, type) {
  if (e.kind === 'enemy') return ENEMIES[e.type].res?.[type] || 0;
  return 0;
}
const FISTS = { dmg: [1, 3], type: 'physical', range: 1, stat: 'might', ap: 2, n: 'Fists' };
export function weaponOf(e) {
  if (e.kind === 'enemy') {
    const a = ENEMIES[e.type].attack;
    return { type: 'physical', range: 1, ap: 2, stat: a.range > 1 ? 'finesse' : 'might', ranged: a.range > 1, ...a };
  }
  const s = e.eq?.weapon;
  if (!s) return FISTS;
  return { ...ITEMS[s.id].weapon, n: ITEMS[s.id].n, stack: s };
}
export const statMult = (e, stat) => 1 + 0.1 * ((e.attrs?.[stat] ?? 3) - 3);
export const critChance = (e) => 0.05 + 0.02 * (e.attrs?.finesse ?? 3);
export const throwRange = (e) => 4 + Math.floor((e.attrs?.might ?? 3) / 2);
export const throwAp = (e) => (e.passive === 'quick_toss' ? 1 : 2);

// ---------- inventory ----------
const sameData = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null);

export function addItem(e, id, q = 1, d) {
  const def = ITEMS[id];
  if (!def || q <= 0) return 0;
  e.inv = e.inv || [];
  let left = q;
  if (def.stack > 1) {
    for (const s of e.inv) {
      if (s.id === id && sameData(s.d, d) && s.q < def.stack) {
        const n = Math.min(left, def.stack - s.q);
        s.q += n; left -= n;
        if (!left) return 0;
      }
    }
  }
  while (left > 0 && e.inv.length < MAX_SLOTS) {
    const n = Math.min(left, def.stack);
    const s = { id, q: n };
    if (d) s.d = JSON.parse(JSON.stringify(d));
    e.inv.push(s);
    left -= n;
  }
  return left; // overflow (caller may drop it)
}
export function countItem(e, id) {
  return (e.inv || []).reduce((a, s) => a + (s.id === id ? s.q : 0), 0);
}
export function takeItem(e, id, q = 1) {
  if (countItem(e, id) < q) return false;
  // take plain stacks first
  const order = e.inv.map((s, i) => i).filter((i) => e.inv[i].id === id).sort((a, b) => (e.inv[a].d ? 1 : 0) - (e.inv[b].d ? 1 : 0));
  let left = q;
  for (const i of order) {
    const s = e.inv[i];
    const n = Math.min(s.q, left);
    s.q -= n; left -= n;
    if (!left) break;
  }
  e.inv = e.inv.filter((s) => s.q > 0);
  return true;
}
/** Removes q from a specific slot, returns {id,q,d} removed */
export function takeFromSlot(e, slot, q = 1) {
  const s = e.inv?.[slot];
  if (!s) return null;
  const n = Math.min(q, s.q);
  s.q -= n;
  const out = { id: s.id, q: n };
  if (s.d) out.d = JSON.parse(JSON.stringify(s.d));
  if (s.q <= 0) e.inv.splice(slot, 1);
  return out;
}
export function hasToolItem(e, tool) {
  if ((e.inv || []).some((s) => ITEMS[s.id].tools.includes(tool))) return true;
  return Object.values(e.eq || {}).some((s) => s && ITEMS[s.id].tools.includes(tool));
}
