// Skills: data + cast logic. target: 'self' | 'enemy' | 'ally' | 'tile'
import { ri, roll, chance, circleTiles, cheb } from '../util.js';
import { dealDamage, applyElement, applyArea, addStatus, heal, elementHit } from './rules.js';
import { weaponOf, statMult } from './entities.js';
import { ITEMS } from '../data/items.js';

const spell = (e, a, b) => Math.round(ri(a, b) * statMult(e, 'intellect'));

export const SKILLS = {
  cleave: { n: 'Cleave', i: '⟳', c: '#ff9b6b', ap: 2, cd: 2, range: 0, target: 'self', aoe: 1, d: 'Hit every adjacent enemy for 80% weapon damage.',
    cast(G, e) {
      const w = weaponOf(e);
      G.fx({ type: 'swing', x: e.x, y: e.y });
      let n = 0;
      for (const [x, y] of circleTiles(e.x, e.y, 1)) for (const c of G.creaturesAt(x, y)) if (G.hostile(e, c) && G.rollHit(e, c, 'melee', 'Cleave')) { dealDamage(G, c, Math.round(roll(w.dmg) * statMult(e, 'might') * 0.8), w.type, e); n++; }
      return n ? null : 'nobody in reach';
    } },
  shield_bash: { attack: true, n: 'Shield Bash', i: '⛉', c: '#ffd27f', ap: 2, cd: 3, range: 1, target: 'enemy', d: 'Knock an enemy back 2 tiles (through any surfaces). 50% stun. Requires a shield.',
    req: (e) => (e.kind === 'player' && !e.eq?.offhand ? 'Requires a shield' : null),
    cast(G, e, { target, miss }) {
      if (miss) return;
      dealDamage(G, target, Math.round(ri(2, 4) * statMult(e, 'might')), 'physical', e);
      G.knockback(target, e.x, e.y, 2);
      if (chance(0.5)) addStatus(G, target, 'stunned', 1);
    } },
  frost_nova: { n: 'Frost Nova', i: '✳', c: '#bfefff', ap: 2, cd: 3, range: 0, target: 'self', aoe: 1, d: 'Frost bursts from you: frost damage to adjacent foes (each rolls to hit) and freezes water and blood around you.',
    cast(G, e) {
      G.fx({ type: 'boom', x: e.x, y: e.y, r: 1, c: '#bfefff' });
      for (const [x, y] of circleTiles(e.x, e.y, 1)) {
        for (const c of G.creaturesAt(x, y)) if (G.hostile(e, c) && G.rollHit(e, c, 'spell', 'Frost Nova')) dealDamage(G, c, spell(e, 4, 7), 'frost', e);
        if (x !== e.x || y !== e.y) applyElement(G, x, y, 'frost', { src: e });
      }
    } },
  rally: { n: 'Second Wind', i: '✚', c: '#6ee07a', ap: 1, cd: 4, range: 0, target: 'self', d: 'Heal yourself for 6 + Might.',
    cast(G, e) { heal(G, e, 6 + (e.attrs?.might || 3)); } },
  aimed_shot: { n: 'Aimed Shot', i: '◎', c: '#ffe08a', ap: 3, cd: 2, range: 8, los: true, target: 'enemy', d: 'A careful shot for 160% damage. Requires a bow.',
    req: (e) => (weaponOf(e).ammo ? null : 'Requires a bow'),
    cast(G, e, { target }) { return G.weaponStrike(e, target, 1.6); } },
  flare_shot: { attack: true, n: 'Flare Arrow', i: '➹', c: '#ff7a2e', ap: 2, cd: 3, range: 8, los: true, target: 'tile', d: 'A burning arrow: fire damage, and ignites the target tile (oil! poison!).',
    req: (e) => (weaponOf(e).ammo ? null : 'Requires a bow'),
    cast(G, e, { x, y, miss }) {
      G.fx({ type: 'proj', fx: e.x, fy: e.y, tx: x, ty: y, c: '#ff7a2e' });
      if (!miss) for (const c of G.creaturesAt(x, y)) dealDamage(G, c, Math.round(ri(3, 5) * statMult(e, 'finesse')), 'fire', e);
      applyElement(G, x, y, 'fire', { ignite: true, src: e });
    } },
  dash: { n: 'Dash', i: '»', c: '#8fd0ff', ap: 1, cd: 3, range: 0, target: 'self', d: '+6 tiles of free movement this turn.',
    cast(G, e) { e.mp += 6; G.float(e, '+6 move', '#8fd0ff'); } },
  mend: { n: 'Mend', i: '❤', c: '#ff8fb1', ap: 2, cd: 2, range: 5, target: 'ally', d: 'Heal an ally (or yourself) for 8-12 (+Intellect). Revives downed allies.',
    cast(G, e, { target }) { G.fx({ type: 'proj', fx: e.x, fy: e.y, tx: target.x, ty: target.y, c: '#ff8fb1' }); heal(G, target, spell(e, 8, 12)); } },
  acid_splash: { attack: true, n: 'Acid Splash', i: '☣', c: '#8ee05a', ap: 2, cd: 2, range: 6, los: true, target: 'tile', d: 'Poison damage and a puddle of poison. Poison + fire = explosion.',
    cast(G, e, { x, y, miss }) {
      G.fx({ type: 'proj', fx: e.x, fy: e.y, tx: x, ty: y, c: '#8ee05a' });
      if (!miss) for (const c of G.creaturesAt(x, y)) dealDamage(G, c, spell(e, 4, 6), 'poison', e);
      applyElement(G, x, y, 'poison', { src: e });
    } },
  firebolt: { attack: true, n: 'Firebolt', i: '🔥', c: '#ff7a2e', ap: 2, cd: 0, range: 7, los: true, target: 'tile', d: 'Fire damage. Ignites oil, explodes poison, turns water to steam.',
    cast(G, e, { x, y, miss }) {
      G.fx({ type: 'proj', fx: e.x, fy: e.y, tx: x, ty: y, c: '#ff7a2e', big: true });
      if (!miss) for (const c of G.creaturesAt(x, y)) dealDamage(G, c, spell(e, 5, 8), 'fire', e);
      applyElement(G, x, y, 'fire', { ignite: true, src: e });
    } },
  frost_ray: { attack: true, n: 'Frost Ray', i: '❄', c: '#9fe3ff', ap: 2, cd: 2, range: 6, los: true, target: 'tile', d: 'Frost damage and chill. Freezes water and blood (and anyone standing in it).',
    cast(G, e, { x, y, miss }) {
      G.fx({ type: 'beam', fx: e.x, fy: e.y, tx: x, ty: y, c: '#bfefff' });
      if (!miss) for (const c of G.creaturesAt(x, y)) dealDamage(G, c, spell(e, 4, 7), 'frost', e);
      applyElement(G, x, y, 'frost', { src: e });
    } },
  lightning: { attack: true, n: 'Lightning Lash', i: '⚡', c: '#f5e663', ap: 2, cd: 2, range: 6, los: true, target: 'tile', d: 'Shock damage. Electrifies water, blood and steam — everyone in it is shocked.',
    cast(G, e, { x, y, miss }) {
      G.fx({ type: 'bolt', fx: e.x, fy: e.y, tx: x, ty: y, c: '#fff59a' });
      if (!miss) for (const c of G.creaturesAt(x, y)) dealDamage(G, c, spell(e, 4, 8), 'shock', e);
      applyElement(G, x, y, 'shock', { src: e });
    } },
  rain: { n: 'Rain', i: '☂', c: '#4aa3df', ap: 3, cd: 4, range: 8, target: 'tile', aoe: 2, d: 'Soak an area: puts out fires, makes everyone Wet, leaves water to electrify or freeze.',
    cast(G, e, { x, y }) { G.fx({ type: 'rain', x, y, r: 2 }); applyArea(G, x, y, 2, 'water', { src: e }); } },
  spit: { attack: true, n: 'Spit', i: '☣', c: '#8ee05a', ap: 2, cd: 1, range: 4, los: true, target: 'tile', d: 'Poison glob.',
    cast(G, e, { x, y, miss }) {
      G.fx({ type: 'proj', fx: e.x, fy: e.y, tx: x, ty: y, c: '#8ee05a' });
      if (!miss) for (const c of G.creaturesAt(x, y)) dealDamage(G, c, ri(3, 5), 'poison', e);
      applyElement(G, x, y, 'poison');
    } },
};
for (const [id, s] of Object.entries(SKILLS)) s.id = id;

/** Validation shared by UI preview and host. Returns error string or null. */
export function skillError(state, map, index, e, sk, { x, y, target }, losFn) {
  const s = SKILLS[sk.id];
  if (sk.cd > 0) return `${s.n} is on cooldown (${sk.cd})`;
  const r = s.req?.(e);
  if (r) return r;
  if (s.target === 'self') return null;
  if (s.target === 'enemy' && (!target || target.dead || target.downed || target.kind === 'player' || target.kind === 'object')) return 'Target an enemy';
  if (s.target === 'ally' && (!target || target.kind !== 'player' || target.dead)) return 'Target an ally';
  const tx = target ? target.x : x, ty = target ? target.y : y;
  const range = s.id === 'aimed_shot' ? weaponOf(e).range : s.range;
  if (cheb(e.x, e.y, tx, ty) > range) return 'Out of range';
  if (s.los && losFn && !losFn(e.x, e.y, tx, ty)) return 'No line of sight';
  return null;
}
export const skillRange = (e, id) => (id === 'aimed_shot' ? weaponOf(e).range : SKILLS[id].range);
