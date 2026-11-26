// Bots for BOTH sides. One utility-based brain plays player characters (through the normal
// action API, exactly like a human client) and enemies ("smart" enemy AI). It scores every
// legal action by expected value: hit chance (incl. light), resistances, kills, statuses, and
// predicted surface chain reactions (oil fires, electrified pools, freezing, barrel blasts).
import { ITEMS } from '../data/items.js';
import { ENEMIES } from '../data/enemies.js';
import { SKILLS, skillError } from './skills.js';
import { weaponOf, moveRange, statMult, critChance, armorOf, resistOf, throwRange, throwAp, maxAp } from './entities.js';
import { findPath, los, walkable, isCreature } from './map.js';
import { surfaceAt } from './rules.js';
import { hitChance, lightMap } from './light.js';
import { cheb, circleTiles } from '../util.js';

// Damage estimates for skills: [min, max, type, scaling stat]
const SKILL_DMG = {
  firebolt: [5, 8, 'fire', 'intellect'], frost_ray: [4, 7, 'frost', 'intellect'], lightning: [4, 8, 'shock', 'intellect'],
  acid_splash: [4, 6, 'poison', 'intellect'], flare_shot: [3, 5, 'fire', 'finesse'], spit: [3, 5, 'poison', null],
  frost_nova: [4, 7, 'frost', 'intellect'], shield_bash: [2, 4, 'physical', 'might'],
};
const SKILL_EL = { firebolt: 'fire', frost_ray: 'frost', lightning: 'shock', acid_splash: 'poison', flare_shot: 'fire', spit: 'poison', rain: 'water' };
const FF = 1.4; // friendly fire weighs more than enemy damage

const side = (e) => (e.kind === 'player' ? 'P' : 'E');
const alive = (c) => c && isCreature(c) && c.kind !== 'npc' && !c.dead && !c.downed;

export function combatants(G) {
  const c = G.state.combat;
  return c ? c.order.map((id) => G.ent(id)).filter(Boolean) : [];
}
function foesHave(G, e, what) {
  for (const a of combatants(G)) if (alive(a) && side(a) !== side(e) && (a.skills?.some((s) => what.includes(s.id)) || a.inv?.some((s) => what.includes(s.id)) || what.includes(a.eq?.weapon?.id))) return true;
  return false;
}
function teamHas(G, e, what) {
  for (const a of combatants(G)) {
    if (!alive(a) || side(a) !== side(e)) continue;
    if (a.skills?.some((s) => what.includes(s.id))) return true;
    if (a.inv?.some((s) => what.includes(s.id))) return true;
  }
  return false;
}

// ---------------------------------------------------------------- damage & status estimates
function estDamage(att, tgt, avg, type) {
  const res = resistOf(tgt, type);
  if (res >= 100) return 0;
  let m = 1 - res / 100;
  if (type === 'shock' && tgt.st?.wet) m *= 1.5;
  if (type === 'physical' && tgt.st?.frozen) m *= 1.5;
  if (type === 'physical') avg = Math.max(1, avg - armorOf(tgt));
  return avg * m * (att.dm || 1);
}
function statusValue(tgt, el) {
  const imm = { fire: 'fire', frost: 'frost', shock: 'shock', poison: 'poison' }[el];
  if (imm && resistOf(tgt, imm) >= 100) return 0;
  switch (el) {
    case 'fire': return tgt.st?.wet ? 0 : tgt.st?.oiled ? 7 : 4;
    case 'frost': return tgt.st?.wet || tgt.st?.chilled ? 9 : 2;
    case 'shock': return tgt.st?.wet || tgt.st?.shocked ? 8 : 2;
    case 'poison': return 3;
    default: return 0;
  }
}
/** Value of dealing `dmg` + status to creature c, from att's point of view. */
function creatureValue(att, c, dmg, sv = 0) {
  if (!alive(c)) return 0;
  const hostile = side(c) !== side(att);
  let v = Math.min(dmg, c.hp) + sv;
  if (dmg >= c.hp) v += ENEMIES[c.type]?.boss ? 14 : c.kind === 'player' ? 20 : 8;
  return hostile ? v : -v * FF;
}

// ---------------------------------------------------------------- surface chain prediction
function flood(G, x, y, pred, limit) {
  const { map, state } = G;
  const out = [], seen = new Set([map.idx(x, y)]), q = [[x, y]];
  while (q.length && out.length < limit) {
    const [cx, cy] = q.shift();
    out.push([cx, cy]);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = cx + dx, ny = cy + dy;
      if (!map.inb(nx, ny)) continue;
      const k = map.idx(nx, ny);
      if (seen.has(k)) continue;
      seen.add(k);
      if (pred(surfaceAt(state, map, k))) q.push([nx, ny]);
    }
  }
  return out;
}
const waterish = (s) => s && (s.type === 'water' || s.type === 'blood');

/** Predicted value of applying element `el` to tile (x,y). `done` dedupes flood regions across an AoE. */
function predictElement(G, att, x, y, el, done) {
  const { map, state } = G;
  if (!map.inb(x, y) || !map.tilePass(x, y)) return 0;
  const k = map.idx(x, y);
  if (done.has(k)) return 0;
  const s = surfaceAt(state, map, k);
  let v = 0;
  const each = (tiles, fn) => { for (const [tx, ty] of tiles) { const kk = map.idx(tx, ty); if (done.has(kk)) continue; done.add(kk); for (const c of G.creaturesAt(tx, ty)) v += fn(c); } };
  const barrels = (tiles) => {
    for (const [tx, ty] of tiles) for (const o of G.objectsAt(tx, ty)) {
      if (o.type !== 'barrel' || (o.liquid !== 'oil' && o.liquid !== 'powder')) continue;
      const r = o.liquid === 'powder' ? 2 : 1, dmg = o.liquid === 'powder' ? 13 : 7, type = o.liquid === 'powder' ? 'physical' : 'fire';
      for (const [bx, by] of circleTiles(o.x, o.y, r)) for (const c of G.creaturesAt(bx, by)) v += creatureValue(att, c, estDamage({}, c, dmg, type), type === 'fire' ? 4 : 0);
    }
  };
  switch (el) {
    case 'fire':
      if (s?.type === 'oil') { const t = flood(G, x, y, (q) => q?.type === 'oil', 80); each(t, (c) => creatureValue(att, c, estDamage({}, c, 4.5, 'fire'), statusValue(c, 'fire'))); barrels(t.concat(t.flatMap(([a, b]) => circleTiles(a, b, 1)))); }
      else if (s?.type === 'poison') { const t = flood(G, x, y, (q) => q?.type === 'poison', 40); const hit = new Set(); for (const [tx, ty] of t) { done.add(map.idx(tx, ty)); for (const [bx, by] of circleTiles(tx, ty, 1)) for (const c of G.creaturesAt(bx, by)) if (!hit.has(c.id)) { hit.add(c.id); v += creatureValue(att, c, estDamage({}, c, 5.5, 'fire'), 2); } } }
      else if (waterish(s)) { done.add(k); for (const c of G.creaturesAt(x, y)) v += side(c) !== side(att) && teamHas(G, att, ['lightning', 'frost_ray', 'shock_bomb', 'frost_bomb']) ? 1 : 0; }
      else { done.add(k); for (const c of G.creaturesAt(x, y)) v += creatureValue(att, c, 0, statusValue(c, 'fire') * 0.7); barrels([[x, y]]); }
      break;
    case 'shock':
      if (waterish(s) || s?.type === 'steam') { const t = flood(G, x, y, s.type === 'steam' ? (q) => q?.type === 'steam' : waterish, 60); each(t, (c) => creatureValue(att, c, estDamage({}, c, 4.5, 'shock') * 1.5, 8)); }
      break;
    case 'frost':
      if (waterish(s)) { const t = flood(G, x, y, waterish, 40); each(t, (c) => creatureValue(att, c, 0, resistOf(c, 'frost') >= 100 ? 0 : 9)); }
      else if (s?.type === 'fire') { done.add(k); for (const c of G.creaturesAt(x, y)) v += side(c) === side(att) ? 3 : 0; }
      break;
    case 'water': {
      done.add(k);
      const setup = teamHas(G, att, ['lightning', 'frost_ray', 'shock_bomb', 'frost_bomb', 'storm_staff']);
      for (const c of G.creaturesAt(x, y)) {
        if (side(c) === side(att)) v += c.st?.burning ? 4 : setup ? -1.5 : 0;
        else v += setup ? 2.5 : 0.3;
      }
      if (s?.type === 'fire') for (const c of G.creaturesAt(x, y)) if (side(c) === side(att)) v += 2;
      break;
    }
    case 'oil': {
      done.add(k);
      const fire = teamHas(G, att, ['firebolt', 'flare_shot', 'fire_bomb', 'lit_torch']);
      for (const c of G.creaturesAt(x, y)) v += side(c) !== side(att) ? (fire ? 3 : 0.5) : fire ? -2 : 0;
      break;
    }
    case 'poison':
      done.add(k);
      for (const c of G.creaturesAt(x, y)) v += creatureValue(att, c, 0, statusValue(c, 'poison'));
      break;
  }
  return v;
}

// ---------------------------------------------------------------- candidate generation
function weaponValue(G, e, t, mult = 1) {
  const w = weaponOf(e);
  if (w.ammo && !e.inv?.some((s) => s.id === w.ammo)) return 0;
  const h = hitChance(G.state, G.map, e, t, w.ranged ? 'ranged' : 'melee').chance / 100;
  const avg = ((w.dmg[0] + w.dmg[1]) / 2) * statMult(e, w.stat) * mult * (1 + 0.5 * (critChance(e) + (w.crit || 0) / 100));
  let v = creatureValue(e, t, estDamage(e, t, avg, w.type || 'physical'), w.el ? statusValue(t, w.el) * 0.5 : 0);
  const coat = w.stack?.d?.coat || e.inv?.find((s) => s.id === w.ammo && s.d)?.d?.coat;
  if (coat && coat !== 'oil') v += creatureValue(e, t, estDamage(e, t, 3, coat), statusValue(t, coat));
  return v * h;
}
function inReach(G, e, t, range, needLos) {
  return cheb(e.x, e.y, t.x, t.y) <= range && (!needLos || los(G.map, G.index, e.x, e.y, t.x, t.y));
}
function hazardCost(G, e) {
  const shockFoes = foesHave(G, e, ['lightning', 'shock_bomb', 'storm_staff']);
  const frostFoes = foesHave(G, e, ['frost_ray', 'frost_nova', 'frost_bomb']);
  const fireFoes = foesHave(G, e, ['firebolt', 'flare_shot', 'fire_bomb']);
  return (x, y) => {
    const s = surfaceAt(G.state, G.map, G.map.idx(x, y));
    if (!s) return 0;
    if (s.e) return 8;
    if ((s.type === 'water' || s.type === 'blood') && (shockFoes || frostFoes)) return 3;
    if (s.type === 'oil' && fireFoes) return 3;
    if (s.type === 'fire' && resistOf(e, 'fire') < 100) return 8;
    if (s.type === 'poison' && resistOf(e, 'poison') < 100) return 5;
    if (s.type === 'oil' || s.type === 'ice') return 1;
    return 0;
  };
}

/** Builds scored candidate actions for combatant e. Each: { v, ap, kind, ... } */
export function candidates(G, e) {
  const out = [];
  const basic = e.kind === 'player' && G.playerBrain === 'basic'; // no item / surface tactics
  const all = combatants(G);
  const foes = all.filter((c) => alive(c) && side(c) !== side(e));
  const friends = all.filter((c) => c && !c.dead && side(c) === side(e));
  const losFn = (a, b, c, d) => los(G.map, G.index, a, b, c, d);
  const w = weaponOf(e);
  const moveTiles = e.mp + e.ap * moveRange(e);

  // 1) weapon attacks (in reach now, or after walking up — host handles the approach for players)
  for (const t of foes) {
    const v = weaponValue(G, e, t);
    if (v <= 0) continue;
    if (inReach(G, e, t, w.range, w.range > 1)) out.push({ v, ap: w.ap, kind: 'attack', target: t });
    else if (!w.ranged) {
      const path = findPath(G.map, G.index, e.x, e.y, t.x, t.y, { range: 1, blockCreatures: G.creatureKeys(e), cost: hazardCost(G, e), maxNodes: 1500 });
      if (path && path.length && path.length <= moveTiles) {
        const mc = Math.ceil(Math.max(0, path.length - e.mp) / moveRange(e));
        if (mc + w.ap <= e.ap) out.push({ v: v - 0.4 * mc, ap: mc + w.ap, kind: 'approach', target: t, path });
      }
    }
  }
  // 2) skills
  for (const sk of e.skills || []) {
    const s = SKILLS[sk.id];
    if (sk.cd > 0 || s.ap > e.ap || s.req?.(e)) continue;
    if (s.target === 'self') {
      let v = 0;
      if (sk.id === 'cleave') for (const t of foes) if (cheb(e.x, e.y, t.x, t.y) <= 1) v += weaponValue(G, e, t, 0.8);
      if (sk.id === 'frost_nova') {
        const done = new Set();
        for (const [x, y] of circleTiles(e.x, e.y, 1)) {
          for (const c of G.creaturesAt(x, y)) if (side(c) !== side(e)) v += creatureValue(e, c, estDamage(e, c, 5.5 * statMult(e, 'intellect'), 'frost'), statusValue(c, 'frost')) * hitChance(G.state, G.map, e, c, 'spell').chance / 100;
          if (x !== e.x || y !== e.y) v += predictElement(G, e, x, y, 'frost', done);
        }
      }
      if (sk.id === 'rally' && e.hp < e.maxHp * 0.6) v = Math.min(e.maxHp - e.hp, 6 + (e.attrs?.might || 3)) * 0.9;
      if (v > 0) out.push({ v, ap: s.ap, kind: 'skill', id: sk.id, x: e.x, y: e.y });
      continue;
    }
    if (s.target === 'ally') {
      for (const a of friends) {
        if (cheb(e.x, e.y, a.x, a.y) > s.range) continue;
        const v = a.downed ? 30 : a.hp < a.maxHp * 0.5 ? Math.min(a.maxHp - a.hp, 10 * statMult(e, 'intellect')) * 1.1 : 0;
        if (v > 0) out.push({ v, ap: s.ap, kind: 'skill', id: sk.id, x: a.x, y: a.y, target: a });
      }
      continue;
    }
    // enemy/tile targeted: foe tiles plus interesting surface tiles and barrels
    const tiles = new Map();
    for (const t of foes) tiles.set(G.map.idx(t.x, t.y), [t.x, t.y, t]);
    if (s.target === 'tile') {
      const r = s.range;
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        const x = e.x + dx, y = e.y + dy;
        if (!G.map.inb(x, y)) continue;
        const k = G.map.idx(x, y), sf = G.state.surfaces[k];
        const barrel = G.objectsAt(x, y).some((o) => o.type === 'barrel' && (o.liquid === 'oil' || o.liquid === 'powder'));
        if ((sf && ['oil', 'poison', 'water', 'blood'].includes(sf.type)) || barrel || (G.map.tiles[k] === 1 && (dx + dy) % 3 === 0)) if (!tiles.has(k)) tiles.set(k, [x, y, null]);
      }
    }
    for (const [x, y, t0] of tiles.values()) {
      const tgt = t0 || G.creaturesAt(x, y).find((c) => side(c) !== side(e));
      if (s.target === 'enemy' && !tgt) continue;
      if (skillError(G.state, G.map, G.index, e, sk, { x, y, target: tgt }, losFn)) continue;
      let v = 0;
      if (sk.id === 'aimed_shot') v = weaponValue(G, e, tgt, 1.6);
      else {
        const d = SKILL_DMG[sk.id];
        if (d && tgt && side(tgt) !== side(e)) {
          const h = s.attack ? hitChance(G.state, G.map, e, tgt, 'spell').chance / 100 : 1;
          v += creatureValue(e, tgt, estDamage(e, tgt, ((d[0] + d[1]) / 2) * (d[3] ? statMult(e, d[3]) : 1), d[2]), statusValue(tgt, d[2]) * (d[2] === 'physical' ? 0 : 1)) * h;
          if (sk.id === 'shield_bash') v += 4 * h;
        }
        const el = !basic && SKILL_EL[sk.id];
        if (el) {
          const done = new Set();
          for (const [ax, ay] of circleTiles(x, y, s.aoe || 0)) v += predictElement(G, e, ax, ay, el, done);
        }
      }
      if (v > 0) out.push({ v, ap: s.ap, kind: 'skill', id: sk.id, x, y, target: tgt });
    }
  }
  // 3) get out of danger (standing in fire/poison/live water, or in water facing lightning/frost users)
  const danger = hazardCost(G, e)(e.x, e.y);
  if (danger >= 3 && moveTiles > 0 && !basic) {
    const cost = hazardCost(G, e), block = G.creatureKeys(e);
    const seen = new Set([G.map.idx(e.x, e.y)]), q = [[e.x, e.y, 0]];
    let safe = null;
    while (q.length && !safe) {
      const [x, y, d] = q.shift();
      if (d > 0 && cost(x, y) === 0) { safe = [x, y, d]; break; }
      if (d >= Math.min(moveTiles, 8)) continue;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const nx = x + dx, ny = y + dy, k = G.map.idx(nx, ny);
        if (seen.has(k) || !walkable(G.map, G.index, nx, ny) || block.has(k)) continue;
        seen.add(k); q.push([nx, ny, d + 1]);
      }
    }
    if (safe) {
      const path = findPath(G.map, G.index, e.x, e.y, safe[0], safe[1], { blockCreatures: block, maxNodes: 800 });
      if (path?.length) out.push({ v: danger * 1.6, ap: Math.ceil(Math.max(0, path.length - e.mp) / moveRange(e)), kind: 'move', x: safe[0], y: safe[1], path });
    }
  }
  // 4) throwables & consumables (players carry items)
  if (e.inv && !basic) {
    const tr = throwRange(e), tap = throwAp(e);
    const seen = new Set();
    e.inv.forEach((st, i) => {
      const d = ITEMS[st.id];
      if (seen.has(st.id)) return;
      seen.add(st.id);
      if (d.throw && (d.throw.dmg || d.throw.el || d.throw.liquid) && st.id !== 'flask_water' || (st.id === 'flask_water' && teamHas(G, e, ['lightning', 'frost_ray']))) {
        if (tap > e.ap) return;
        const t = d.throw;
        const cand = new Map();
        for (const f of foes) if (cheb(e.x, e.y, f.x, f.y) <= tr) cand.set(G.map.idx(f.x, f.y), [f.x, f.y]);
        for (const [x, y] of cand.values()) {
          let v = 0;
          const done = new Set();
          for (const [ax, ay] of circleTiles(x, y, t.r || 0)) {
            if (t.dmg) for (const c of G.creaturesAt(ax, ay)) v += creatureValue(e, c, estDamage({}, c, (t.dmg[0] + t.dmg[1]) / 2, t.type), t.el && t.type !== t.el ? 0 : statusValue(c, t.type));
            if (t.liquid) v += predictElement(G, e, ax, ay, t.liquid, new Set());
          }
          if (t.el) for (const [ax, ay] of circleTiles(x, y, t.r || 0)) v += predictElement(G, e, ax, ay, t.el, done);
          if (st.id === 'healing_potion' || st.id === 'smoke_bomb') v = 0;
          v -= d.v * 0.15; // don't waste expensive bombs on scraps
          if (v > 0) out.push({ v, ap: tap, kind: 'throw', ref: i, x, y });
        }
      }
      if (d.use?.heal && e.ap >= 1 && e.hp < e.maxHp * 0.4) out.push({ v: Math.min(e.maxHp - e.hp, d.use.heal[1]) + (e.hp < e.maxHp * 0.25 ? 8 : 0), ap: 1, kind: 'use', ref: i });
      if (st.id === 'healing_potion') for (const a of friends) if (a.downed && a !== e) {
        const path = cheb(e.x, e.y, a.x, a.y) <= 1 ? [] : findPath(G.map, G.index, e.x, e.y, a.x, a.y, { range: 1, blockCreatures: G.creatureKeys(e), maxNodes: 1500 });
        if (!path) continue;
        const mc = Math.ceil(Math.max(0, path.length - e.mp) / moveRange(e));
        if (mc + 1 <= e.ap) out.push({ v: 28 - mc, ap: mc + 1, kind: 'revive', ref: i, target: a });
      }
    });
  }
  return out;
}

/** Positioning when nothing better to do: melee closes in; ranged finds a safe tile with a shot (preferring darkness). */
function positionMove(G, e) {
  const all = combatants(G);
  const foes = all.filter((c) => alive(c) && side(c) !== side(e));
  if (!foes.length) return null;
  const w = weaponOf(e);
  const maxTiles = e.mp + e.ap * moveRange(e);
  if (maxTiles <= 0) return null;
  let reach = w.range;
  for (const sk of e.skills || []) { const s = SKILLS[sk.id]; if (s.target === 'tile' || s.target === 'enemy') reach = Math.max(reach, Math.min(s.range, 7)); }
  const ranged = reach > 1;
  foes.sort((a, b) => cheb(e.x, e.y, a.x, a.y) - cheb(e.x, e.y, b.x, b.y));
  const block = G.creatureKeys(e), cost = hazardCost(G, e);
  if (!ranged) {
    for (const t of foes.slice(0, 3)) {
      const path = findPath(G.map, G.index, e.x, e.y, t.x, t.y, { range: 1, blockCreatures: block, cost, maxNodes: 2500 });
      if (path && path.length) return path.slice(0, maxTiles);
    }
    return null;
  }
  // ranged: BFS reachable tiles, score them
  const L = lightMap(G.state, G.map);
  const dv = e.st?.nightsight || ENEMIES[e.type]?.darkvision;
  let best = null, bestS = -1e9;
  const seen = new Map([[G.map.idx(e.x, e.y), 0]]), q = [[e.x, e.y, 0]];
  while (q.length) {
    const [x, y, d] = q.shift();
    let sc = -cost(x, y) * 2 - d * 0.15;
    const shots = foes.filter((f) => cheb(x, y, f.x, f.y) <= reach && los(G.map, G.index, x, y, f.x, f.y));
    if (!shots.length) sc -= 6 + Math.min(...foes.map((f) => cheb(x, y, f.x, f.y))) * 0.5;
    else sc += 4 + (dv ? 0 : L[G.map.idx(shots[0].x, shots[0].y)]);
    const adj = foes.filter((f) => cheb(x, y, f.x, f.y) <= 1).length;
    sc -= adj * 4;
    sc += (2 - L[G.map.idx(x, y)]) * 0.8; // lurk in the dark
    if (sc > bestS) { bestS = sc; best = [x, y]; }
    if (d >= maxTiles) continue;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const nx = x + dx, ny = y + dy, k = G.map.idx(nx, ny);
      if (seen.has(k) || !walkable(G.map, G.index, nx, ny) || block.has(k)) continue;
      seen.set(k, d + 1);
      q.push([nx, ny, d + 1]);
    }
  }
  if (!best || (best[0] === e.x && best[1] === e.y)) return null;
  const path = findPath(G.map, G.index, e.x, e.y, best[0], best[1], { blockCreatures: block, cost, maxNodes: 2500 });
  return path && path.length ? path.slice(0, maxTiles) : null;
}

// ---------------------------------------------------------------- execution
/**
 * One bot decision for combatant e (whose turn it is). Executes it and returns a delay (ms),
 * or null to end the turn. Players act via G.handleAction (same validation as humans).
 */
export function botStep(G, e) {
  const r = G.rtOf(e.id);
  r.botSteps = (r.botSteps || 0) + 1;
  if (r.botSteps > 14 || (e.ap <= 0 && e.mp <= 0)) return null;
  r.banned ||= new Set();
  const cands = candidates(G, e).filter((c) => c.ap <= e.ap && !r.banned.has(key(c)));
  cands.sort((a, b) => b.v - 0.3 * b.ap - (a.v - 0.3 * a.ap));
  const best = cands[0];
  const before = JSON.stringify([e.ap, e.mp, e.x, e.y, e.inv?.length, r.path.length]);
  if (best && best.v > 0.8) {
    exec(G, e, best);
    if (JSON.stringify([e.ap, e.mp, e.x, e.y, e.inv?.length, r.path.length]) === before) r.banned.add(key(best));
    return 600;
  }
  const path = positionMove(G, e);
  if (path) {
    if (e.kind === 'player') G.handleAction(e.pid, { type: 'move', x: path[path.length - 1][0], y: path[path.length - 1][1] });
    else { G.payMove(e, path.length); G.startPath(e, path, null); }
    if (JSON.stringify([e.ap, e.mp, e.x, e.y, e.inv?.length, r.path.length]) === before) return null;
    r.moved = (r.moved || 0) + 1;
    return r.moved > 2 ? null : 300;
  }
  return null;
}
const key = (c) => [c.kind, c.id, c.target?.id, c.x, c.y, c.ref].join(':');

function exec(G, e, c) {
  if (e.kind === 'player') {
    const pid = e.pid;
    switch (c.kind) {
      case 'attack': case 'approach': return G.handleAction(pid, { type: 'attack', target: c.target.id });
      case 'skill': return G.handleAction(pid, { type: 'skill', id: c.id, x: c.x, y: c.y, target: c.target?.id });
      case 'throw': return G.handleAction(pid, { type: 'throw', ref: c.ref, x: c.x, y: c.y });
      case 'use': return G.handleAction(pid, { type: 'use', ref: c.ref });
      case 'revive': return G.handleAction(pid, { type: 'apply', ref: c.ref, target: c.target.id, rule: 'heal_ally' });
      case 'move': return G.handleAction(pid, { type: 'move', x: c.x, y: c.y });
    }
    return;
  }
  // enemies act directly (they have no client)
  const w = weaponOf(e);
  switch (c.kind) {
    case 'attack': e.ap -= w.ap; G.weaponStrike(e, c.target, 1); return;
    case 'approach': case 'move': G.payMove(e, c.path.length); G.startPath(e, c.path, null); return;
    case 'skill': { const sk = e.skills.find((s) => s.id === c.id); G.castSkill(e, sk, { x: c.x, y: c.y, target: c.target }); return; }
  }
}

// ---------------------------------------------------------------- between fights (player bots)
/** Cheap "player habits" outside combat: spend points, craft bombs, carry a torch in the dark, loot. */
export function botPrep(G, e, { lootNear = true } = {}) {
  const pid = e.pid;
  const primary = { sellsword: 'might', ranger: 'finesse', alchemist: 'intellect', elementalist: 'intellect' }[e.cls];
  while (e.pts > 0) G.handleAction(pid, { type: 'allocate', attr: e.pts % 2 ? 'vigor' : primary });
  for (const rid of ['fire_bomb', 'healing_potion', 'frost_bomb', 'shock_bomb']) {
    for (let n = 0; n < 3; n++) { const before = e.inv.length + JSON.stringify(e.inv).length; G.handleAction(pid, { type: 'craft', recipe: rid }); if (e.inv.length + JSON.stringify(e.inv).length === before) break; }
  }
  // light: melee fighters carry a torch at night (they must see their target); ranged lurk in the dark
  const melee = !weaponOf(e).ranged;
  const dark = lightMap(G.state, G.map)[G.map.idx(e.x, e.y)] < 2;
  if (melee && dark && e.cls !== 'sellsword') {
    let ti = e.inv.findIndex((s) => s.id === 'lit_torch');
    if (ti < 0) { const t = e.inv.findIndex((s) => s.id === 'torch'); if (t >= 0) G.handleAction(pid, { type: 'craft', recipe: 'lit_torch' }); ti = e.inv.findIndex((s) => s.id === 'lit_torch'); }
    if (ti >= 0 && e.eq.offhand?.id !== 'lit_torch') G.handleAction(pid, { type: 'equip', ref: ti });
  }
  if (dark && !e.st.nightsight) { const n = e.inv.findIndex((s) => s.id === 'nightsight'); if (n >= 0 && (!melee || e.cls === 'sellsword')) G.handleAction(pid, { type: 'use', ref: n }); }
  if (lootNear) for (const c of Object.values(G.state.entities)) {
    if (!c.items?.length || c.locked || Math.max(Math.abs(c.x - e.x), Math.abs(c.y - e.y)) > 12) continue;
    if (c.kind === 'object' && c.type !== 'chest' && c.type !== 'pile') continue;
    G.place(e, ...G.freeTileNear(c.x, c.y));
    G.handleAction(pid, { type: 'take', from: c.id, all: true });
  }
}
export { maxAp };
