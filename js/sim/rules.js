// Core interaction rules: statuses, surfaces & elements, damage, death.
// All functions take the host Game `G` and mutate authoritative state.
import { T, TILES } from '../data/tiles.js';
import { ITEMS } from '../data/items.js';
import { ENEMIES } from '../data/enemies.js';
import { OBJECTS, objName } from '../data/objects.js';
import { ri, chance, circleTiles } from '../util.js';
import { armorOf, resistOf, maxHp, addItem } from './entities.js';
import { isCreature } from './map.js';

// ---------------- statuses ----------------
export const STATUS = {
  wet: { n: 'Wet', c: '#4aa3df', d: 'Lightning damage +50%. Frost will freeze. Immune to burning.' },
  burning: { n: 'Burning', c: '#ff7b29', d: 'Takes fire damage each turn.' },
  chilled: { n: 'Chilled', c: '#9fd8ff', d: '-1 AP per turn. More frost freezes.' },
  frozen: { n: 'Frozen', c: '#e0f6ff', d: 'Cannot act. Physical hits shatter for +50%.' },
  shocked: { n: 'Shocked', c: '#f5e663', d: 'More lightning stuns.' },
  stunned: { n: 'Stunned', c: '#ffe14d', d: 'Cannot act.' },
  poisoned: { n: 'Poisoned', c: '#7bd34a', d: 'Takes poison damage each turn.' },
  oiled: { n: 'Oiled', c: '#9a7a45', d: 'Movement halved. Fire flares up.' },
  resolute: { n: 'Resolute', c: '#d9c3a0', d: 'Just shook off a stun or freeze: immune to both for now.' },
  nightsight: { n: 'Nightsight', c: '#b48cff', d: 'Sees in the dark: darkness counts as dim, dim as lit.' },
};
const STATUS_IMMUNITY = { burning: 'fire', chilled: 'frost', frozen: 'frost', shocked: 'shock', poisoned: 'poison' };

export function addStatus(G, e, s, turns = 2, o = {}) {
  if (!isCreature(e) || e.dead || e.kind === 'npc') return;
  const imm = STATUS_IMMUNITY[s];
  if (imm && resistOf(e, imm) >= 100) return;
  const st = e.st;
  switch (s) {
    case 'burning':
      if (st.wet) { delete st.wet; G.fx({ type: 'puff', x: e.x, y: e.y }); G.float(e, 'Sizzle', '#ddd'); return; }
      if (st.frozen) { delete st.frozen; G.float(e, 'Thawed', '#cdefff'); return; }
      if (st.oiled) {
        delete st.oiled; turns += 1;
        G.log(`${e.name}'s oil flares up!`, 'fire');
        dealDamage(G, e, ri(3, 5), 'fire', null, { noStatus: true });
      }
      break;
    case 'wet':
      delete st.burning;
      if (e.eq?.offhand?.id === 'lit_torch') { e.eq.offhand = { id: 'torch', q: 1 }; G.log(`${e.name}'s torch sputters out.`); G.fx({ type: 'puff', x: e.x, y: e.y }); }
      if (st.chilled) { delete st.chilled; s = 'frozen'; turns = 1; }
      break;
    case 'chilled':
      delete st.burning;
      if (!o.noEscalate && (st.wet || st.chilled)) { delete st.wet; delete st.chilled; s = 'frozen'; turns = 1; }
      break;
    case 'shocked':
      if (st.wet || st.shocked) { delete st.shocked; s = 'stunned'; turns = 1; }
      break;
    case 'frozen':
      delete st.burning; delete st.wet;
      break;
  }
  if (s === 'frozen' || s === 'stunned') {
    if (st.resolute) { G.float(e, 'Resisted', '#d9c3a0'); return; }
    if (!st[s]) G.float(e, STATUS[s].n + '!', STATUS[s].c);
    if (G.state.combat?.active === e.id) {
      // stunned/frozen mid-turn: the rest of this turn is lost (and the status is spent)
      st.resolute = 2;
      G.log(`${e.name} is ${s} and loses the rest of the turn.`);
      const r = G.rtOf(e.id); r.path = []; r.queued = null;
      G.later(500, () => G.endTurn(e.id));
      return;
    }
  }
  st[s] = Math.max(st[s] || 0, turns);
}

/** Damage-over-time and duration countdown; called at turn start (combat) or each realtime round. */
export function tickStatuses(G, e) {
  const st = e.st;
  if (st.burning) dealDamage(G, e, ri(3, 5), 'fire', null, { noStatus: true, dot: true });
  if (st.poisoned && !e.dead && !e.downed) dealDamage(G, e, ri(2, 4), 'poison', null, { noStatus: true, dot: true });
  for (const k of Object.keys(st)) {
    st[k]--;
    if (st[k] <= 0) delete st[k];
  }
}

const ELEMENT_STATUS = { fire: 'burning', frost: 'chilled', shock: 'shocked', poison: 'poisoned', water: 'wet', oil: 'oiled' };
export function elementHit(G, e, el, turns = 2) {
  const s = ELEMENT_STATUS[el];
  if (s) addStatus(G, e, s, s === 'shocked' || s === 'chilled' ? 1 : turns);
}

// ---------------- surfaces ----------------
export const SURF = {
  water: { n: 'Water', c: 'rgba(70,150,225,0.5)' },
  blood: { n: 'Blood', c: 'rgba(150,20,25,0.55)' },
  oil: { n: 'Oil', c: 'rgba(45,32,16,0.75)' },
  poison: { n: 'Poison', c: 'rgba(100,205,60,0.5)' },
  fire: { n: 'Fire', c: 'rgba(255,110,30,0.45)' },
  ice: { n: 'Ice', c: 'rgba(205,238,255,0.75)' },
  steam: { n: 'Steam', c: 'rgba(235,240,245,0.4)' },
  smoke: { n: 'Smoke', c: 'rgba(60,60,60,0.6)' },
};
const BASE_WATER = Object.freeze({ type: 'water', t: -1, base: true });

/** Surface at tile key (works on any state + map; shallows are permanent water). */
export function surfaceAt(state, map, k) {
  const s = state.surfaces[k];
  if (s) return s;
  return map.tiles[k] === T.SHALLOW ? BASE_WATER : null;
}
export function surfaceName(s) {
  if (!s) return '';
  return (s.e ? 'Electrified ' : '') + SURF[s.type].n;
}

function setSurf(G, k, type, t, e = 0) {
  const shallow = G.map.tiles[k] === T.SHALLOW;
  if (!type) {
    delete G.state.surfaces[k];
    return;
  }
  if (shallow && type === 'water' && !e) { delete G.state.surfaces[k]; return; }
  G.state.surfaces[k] = e ? { type, t, e } : { type, t };
}

const DUR = { water: 6, blood: 6, oil: 7, poison: 5, fire: 3, ice: 4, steam: 3, smoke: 4 };

function floodSame(G, x, y, pred, limit) {
  const { map, state } = G;
  const out = [], seen = new Set([map.idx(x, y)]), q = [[x, y]];
  while (q.length && out.length < limit) {
    const [cx, cy] = q.shift();
    out.push([cx, cy]);
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
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

const isWaterish = (s) => s && (s.type === 'water' || s.type === 'blood');

/**
 * Applies an element to a tile. Liquids (water, oil, poison, blood) create surfaces;
 * energies (fire, frost, shock) transform them. This is where the combo magic lives.
 */
export function applyElement(G, x, y, el, o = {}) {
  const { map, state } = G;
  if (!map.inb(x, y)) return;
  const tile = map.tile(x, y);
  if (!TILES[tile].pass) return;
  const k = map.idx(x, y);
  const s = surfaceAt(state, map, k);
  const cur = s?.type || null;
  const here = () => G.creaturesAt(x, y);

  switch (el) {
    case 'water':
    case 'blood':
      if (cur === 'fire') { setSurf(G, k, 'steam', DUR.steam); G.fx({ type: 'puff', x, y }); }
      else if (cur === 'smoke') setSurf(G, k, el, DUR[el]); // water knocks the smoke down
      else if (cur === 'ice' || cur === 'oil') { /* water slides off */ }
      else if (cur === 'water' || cur === 'blood') setSurf(G, k, cur, Math.max(s.t, DUR[cur]), s.e || 0);
      else setSurf(G, k, el, DUR[el]);
      for (const c of here()) addStatus(G, c, 'wet', 2);
      for (const ob of G.objectsAt(x, y)) if ((ob.type === 'campfire' || ob.type === 'forge') && ob.lit) { ob.lit = false; G.log(`The ${OBJECTS[ob.type].n.toLowerCase()} is doused.`); }
      for (const ob of G.objectsAt(x, y)) if (ob.type === 'burning_tree') { ob.type = 'burnt_tree'; delete ob.burn; }
      break;
    case 'oil':
      if (cur === 'fire') setSurf(G, k, 'fire', DUR.fire + 1);
      else if (cur !== 'ice') setSurf(G, k, 'oil', DUR.oil);
      for (const c of here()) addStatus(G, c, cur === 'fire' ? 'burning' : 'oiled', 2);
      break;
    case 'smoke':
      if (cur !== 'fire') setSurf(G, k, 'smoke', DUR.smoke);
      G.fx({ type: 'puff', x, y });
      break;
    case 'poison':
      if (cur === 'fire') { poisonBlast(G, x, y); setSurf(G, k, 'fire', DUR.fire); }
      else if (cur !== 'ice') setSurf(G, k, 'poison', DUR.poison);
      for (const c of here()) addStatus(G, c, 'poisoned', 2);
      break;
    case 'fire': {
      if (cur === 'oil') {
        const tiles = floodSame(G, x, y, (q) => q?.type === 'oil', 80);
        tiles.forEach(([tx, ty], i) => {
          const kk = map.idx(tx, ty);
          setSurf(G, kk, 'fire', DUR.fire + 1);
          G.fx({ type: 'flare', x: tx, y: ty, delay: i * 25 });
          for (const c of G.creaturesAt(tx, ty)) { addStatus(G, c, 'burning', 3); dealDamage(G, c, ri(3, 6), 'fire', o.src, { noStatus: true }); }
          burnObjects(G, tx, ty);
        });
        if (tiles.length > 2) G.log(`The oil goes up in flames!`, 'fire');
        return;
      }
      if (cur === 'poison') {
        const tiles = floodSame(G, x, y, (q) => q?.type === 'poison', 40);
        tiles.forEach(([tx, ty]) => { setSurf(G, map.idx(tx, ty), 'fire', DUR.fire); poisonBlast(G, tx, ty); });
        G.log(`The poison cloud explodes!`, 'fire');
        return;
      }
      if (isWaterish(s)) { setSurf(G, k, 'steam', DUR.steam); G.fx({ type: 'puff', x, y }); for (const c of here()) addStatus(G, c, 'wet', 2); }
      else if (cur === 'ice') setSurf(G, k, 'water', DUR.water);
      else if (cur === 'fire') s.t = Math.max(s.t, DUR.fire);
      else if (cur === 'steam') { /* nothing */ }
      else if (o.ignite) setSurf(G, k, 'fire', 2);
      if (cur !== 'steam' && !isWaterish(s) && cur !== 'ice' && (cur === 'fire' || o.ignite)) for (const c of here()) addStatus(G, c, 'burning', 2);
      burnObjects(G, x, y);
      break;
    }
    case 'frost': {
      if (isWaterish(s)) {
        const tiles = floodSame(G, x, y, isWaterish, 40);
        for (const [tx, ty] of tiles) {
          const kk = map.idx(tx, ty);
          setSurf(G, kk, 'ice', DUR.ice);
          for (const c of G.creaturesAt(tx, ty)) addStatus(G, c, 'frozen', 1);
        }
        if (tiles.length > 1) G.log('The water freezes solid!', 'frost');
      } else if (cur === 'fire') { setSurf(G, k, null); G.fx({ type: 'puff', x, y }); }
      else if (cur === 'steam') setSurf(G, k, 'water', DUR.water);
      for (const c of here()) addStatus(G, c, 'chilled', 1);
      for (const ob of G.objectsAt(x, y)) if ((ob.type === 'campfire' || ob.type === 'forge') && ob.lit) ob.lit = false;
      break;
    }
    case 'shock': {
      if (isWaterish(s) || cur === 'steam') {
        const pred = cur === 'steam' ? (q) => q?.type === 'steam' : isWaterish;
        const tiles = floodSame(G, x, y, pred, 60);
        for (const [tx, ty] of tiles) {
          const kk = map.idx(tx, ty);
          const sv = surfaceAt(state, map, kk);
          setSurf(G, kk, sv.type, sv.t < 0 ? -1 : Math.max(sv.t, 2), 2);
          for (const c of G.creaturesAt(tx, ty)) {
            dealDamage(G, c, ri(3, 6), 'shock', o.src, { noStatus: true });
            addStatus(G, c, 'shocked', 1);
          }
        }
        G.fx({ type: 'zap', tiles: tiles.slice(0, 30) });
        if (tiles.length > 1) G.log('Electricity arcs through the water!', 'shock');
      }
      break;
    }
  }
}

export function applyArea(G, x, y, r, el, o) {
  for (const [tx, ty] of circleTiles(x, y, r)) applyElement(G, tx, ty, el, o);
}

function poisonBlast(G, x, y) {
  G.fx({ type: 'boom', x, y, r: 1, c: '#a6e34a' });
  for (const [tx, ty] of circleTiles(x, y, 1)) for (const c of G.creaturesAt(tx, ty)) dealDamage(G, c, ri(4, 7), 'fire', null, {});
}

function burnObjects(G, x, y) {
  for (const ob of G.objectsAt(x, y)) {
    if (ob.type === 'tree') { ob.type = 'burning_tree'; ob.burn = 3; G.log('A tree catches fire!', 'fire'); }
    else if ((ob.type === 'campfire' || ob.type === 'forge') && !ob.lit) { ob.lit = true; G.log(`The ${OBJECTS[ob.type].n.toLowerCase()} is lit.`); }
    else if (ob.type === 'barrel' && (ob.liquid === 'oil' || ob.liquid === 'powder')) G.later(180, () => damageObject(G, ob, 99, 'fire'));
    else if (ob.type === 'crate') G.later(200, () => damageObject(G, ob, 99, 'fire'));
    else if (ob.type === 'bush' && !ob.picked) { ob.picked = 12; }
  }
}

/** Per-round surface aging and burning trees. */
export function tickSurfaces(G) {
  const { state, map } = G;
  for (const [k, s] of Object.entries(state.surfaces)) {
    if (s.e) { s.e--; if (!s.e) delete s.e; }
    if (s.t > 0) {
      s.t--;
      if (s.t <= 0) {
        delete state.surfaces[k];
        if (s.type === 'steam' && chance(0.5) && map.tiles[k] !== T.SHALLOW) state.surfaces[k] = { type: 'water', t: 2 };
        continue;
      }
    }
    if (map.tiles[k] === T.SHALLOW && s.type === 'water' && !s.e) delete state.surfaces[k];
  }
  for (const ob of Object.values(state.entities)) {
    if (ob.type === 'burning_tree') {
      // spread to neighbours
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!(dx || dy) || !chance(0.12)) continue;
        for (const n of G.objectsAt(ob.x + dx, ob.y + dy)) if (n.type === 'tree') { n.type = 'burning_tree'; n.burn = 3; }
        if (chance(0.3)) applyElement(G, ob.x + dx, ob.y + dy, 'fire', { ignite: true });
      }
      if (--ob.burn <= 0) { ob.type = 'burnt_tree'; delete ob.burn; }
    }
    if (ob.type === 'bush' && ob.picked) { if (--ob.picked <= 0) delete ob.picked; }
  }
}

/** Effects of the surface a creature stands on. when: 'enter' | 'turn' */
export function surfaceEffect(G, e, when) {
  if (e.dead || e.kind === 'npc' || e.flying) return;
  const s = surfaceAt(G.state, G.map, G.map.idx(e.x, e.y));
  if (!s) return;
  switch (s.type) {
    case 'water': case 'blood': case 'steam':
      addStatus(G, e, 'wet', 2);
      if (s.e) { dealDamage(G, e, ri(3, 5), 'shock', null, { noStatus: true }); addStatus(G, e, 'shocked', 1); }
      break;
    case 'ice': if (!e.st.chilled && !e.st.frozen) addStatus(G, e, 'chilled', 1, { noEscalate: true }); break;
    case 'oil': addStatus(G, e, 'oiled', 2); break;
    case 'fire':
      addStatus(G, e, 'burning', 2);
      if (!e.dead && !e.downed) dealDamage(G, e, ri(2, 4), 'fire', null, { noStatus: true });
      break;
    case 'poison':
      addStatus(G, e, 'poisoned', 2);
      if (!e.dead && !e.downed) dealDamage(G, e, ri(1, 3), 'poison', null, { noStatus: true });
      break;
  }
}

// ---------------- damage ----------------
const DMG_COLOR = { physical: '#ffffff', fire: '#ff8a3d', frost: '#9fe3ff', shock: '#f5e663', poison: '#8ee05a' };

export function dealDamage(G, t, amount, type, src, o = {}) {
  if (!t || t.dead) return 0;
  if (src?.dm && !o.dot) amount *= src.dm; // per-encounter enemy damage tuning
  if (t.kind === 'object') return damageObject(G, t, amount, type);
  if (!isCreature(t) || t.downed || t.kind === 'npc') return 0;
  const res = resistOf(t, type);
  if (res >= 100) {
    G.float(t, 'Immune', '#aaa');
    if (type === 'poison' && t.kind === 'enemy') heal(G, t, Math.ceil(amount / 2), true);
    return 0;
  }
  let mult = 1 - res / 100;
  if (type === 'shock' && t.st.wet) mult *= 1.5;
  if (type === 'physical' && t.st.frozen) { mult *= 1.5; delete t.st.frozen; G.float(t, 'Shatter!', '#e0f6ff'); }
  if (type === 'fire' && t.st.frozen) delete t.st.frozen;
  let dmg = amount;
  if (type === 'physical') dmg = Math.max(1, dmg - armorOf(t));
  dmg = Math.max(0, Math.round(dmg * mult * (o.crit ? 1.5 : 1)));
  t.hp -= dmg;
  G.onDamage?.(src, t, dmg, type);
  G.float(t, (o.crit ? 'Crit ' : '') + dmg, DMG_COLOR[type] || '#fff');
  if (src && src !== t && !o.dot) G.fx({ type: 'hit', x: t.x, y: t.y });
  if (t.kind === 'enemy' && (src?.kind === 'player' || G.players().some((p) => Math.max(Math.abs(p.x - t.x), Math.abs(p.y - t.y)) <= 12))) G.aggro(t);
  if (!o.noStatus && type !== 'physical') elementHit(G, t, type);
  if (type === 'physical' && dmg >= 4 && chance(0.35) && !ENEMIES[t.type]?.res?.poison) {
    // bleeding creatures splash blood (which conducts and freezes!)
    const k = G.map.idx(t.x, t.y);
    if (!surfaceAt(G.state, G.map, k)) G.state.surfaces[k] = { type: 'blood', t: 4 };
  }
  if (t.hp <= 0) {
    t.hp = 0;
    if (t.kind === 'player') downPlayer(G, t);
    else killEnemy(G, t, src);
  }
  return dmg;
}

export function heal(G, t, amount, quiet) {
  if (!t || t.dead) return;
  if (t.downed) { t.downed = false; G.log(`${t.name} is back on their feet!`, 'good'); }
  const before = t.hp;
  t.hp = Math.min(maxHp(t), t.hp + amount);
  if (!quiet || t.hp > before) G.float(t, '+' + (t.hp - before), '#6ee07a');
}

function downPlayer(G, t) {
  t.downed = true;
  t.st = {};
  G.log(`${t.name} is down!`, 'bad');
  G.fx({ type: 'boom', x: t.x, y: t.y, r: 0, c: '#a00' });
}

function killEnemy(G, t, src) {
  const def = ENEMIES[t.type];
  t.dead = true;
  t.st = {};
  t.items = [];
  for (const [id, a, b, p] of def.loot) if (chance(p)) { const q = ri(a, b); if (q > 0) t.items.push({ id, q }); }
  G.log(`${t.name} dies.`, 'good');
  if (def.deathEl) applyElement(G, t.x, t.y, def.deathEl, { ignite: true });
  // XP to the whole party
  for (const p of G.players()) {
    p.xp += def.xp;
    while (p.xp >= p.level * 100) {
      p.xp -= p.level * 100;
      p.level++;
      p.pts += 2;
      p.maxHp = maxHp(p);
      p.hp = p.maxHp;
      G.log(`${p.name} reached level ${p.level}! (+2 attribute points)`, 'good');
      G.fx({ type: 'levelup', x: p.x, y: p.y });
    }
  }
  G.dirtyIndex = true;
}

export function damageObject(G, ob, amount, type) {
  const d = OBJECTS[ob.type];
  if (!d?.destructible || ob.gone) return 0;
  if (ob.type === 'barrel' && type === 'fire' && (ob.liquid === 'oil' || ob.liquid === 'powder')) amount = 99;
  ob.hp = (ob.hp ?? d.hp) - amount;
  G.float(ob, String(amount > 50 ? '' : amount), '#ddd');
  if (ob.hp > 0) return amount;
  ob.gone = true;
  G.removeEnt(ob.id);
  const { x, y } = ob;
  if (ob.type === 'crate') {
    G.fx({ type: 'debris', x, y });
    if (ob.items?.length) G.dropItems(x, y, ob.items);
    G.log('The crate splinters.');
  } else if (ob.type === 'barrel') {
    switch (ob.liquid) {
      case 'oil':
        if (type === 'fire') {
          G.log('The oil barrel explodes!', 'fire');
          G.fx({ type: 'boom', x, y, r: 2, c: '#ff7a2e' });
          applyArea(G, x, y, 2, 'oil');
          applyArea(G, x, y, 2, 'fire', { ignite: true });
          for (const [tx, ty] of circleTiles(x, y, 1)) for (const c of G.creaturesAt(tx, ty)) dealDamage(G, c, ri(5, 9), 'fire', null);
        } else { applyArea(G, x, y, 1, 'oil'); G.log('Oil spills everywhere.'); }
        break;
      case 'powder':
        G.log('The powder keg EXPLODES!', 'fire');
        G.fx({ type: 'boom', x, y, r: 3, c: '#ffcf4a' });
        G.fx({ type: 'shake', p: 10 });
        for (const [tx, ty] of circleTiles(x, y, 2)) {
          for (const c of G.creaturesAt(tx, ty)) dealDamage(G, c, ri(10, 16), 'physical', null);
          for (const o2 of G.objectsAt(tx, ty)) if (OBJECTS[o2.type]?.destructible) G.later(150, () => damageObject(G, o2, 99, 'fire'));
        }
        applyArea(G, x, y, 1, 'fire', { ignite: true });
        break;
      default:
        applyArea(G, x, y, 1, ob.liquid);
        G.log(`The ${objName(ob).toLowerCase()} bursts.`);
    }
  }
  return amount;
}

export function explosion(G, x, y, r, dmg, type, src) {
  G.fx({ type: 'boom', x, y, r, c: type === 'fire' ? '#ff7a2e' : '#ffcf4a' });
  if (r >= 2) G.fx({ type: 'shake', p: 8 });
  for (const [tx, ty] of circleTiles(x, y, r)) {
    for (const c of G.creaturesAt(tx, ty)) dealDamage(G, c, ri(dmg[0], dmg[1]), type, src);
    for (const ob of G.objectsAt(tx, ty)) if (OBJECTS[ob.type]?.destructible) G.later(150, () => damageObject(G, ob, ri(dmg[0], dmg[1]), type === 'physical' ? 'fire' : type));
  }
}

export { addItem };
