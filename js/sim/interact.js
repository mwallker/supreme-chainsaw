// Item -> world interactions ("use X on Y") and default object interactions.
// match() is pure (used by client UI to build context menus); run() is host-only.
import { ITEMS } from '../data/items.js';
import { OBJECTS, objName } from '../data/objects.js';
import { T } from '../data/tiles.js';
import { ri, chance } from '../util.js';
import { surfaceAt, applyElement, addStatus, heal, damageObject, SURF, STATUS } from './rules.js';
import { phaseOf, DAY } from './light.js';
import { addItem, countItem } from './entities.js';
import { isCreature } from './map.js';

const tools = (s) => ITEMS[s.id].tools;
const isFireSource = (s) => tools(s).includes('fire');
const isLitFire = (ctx) => (ctx.t && (ctx.t.type === 'campfire' || ctx.t.type === 'forge') && ctx.t.lit) || ctx.t?.type === 'burning_tree' || ctx.surf?.type === 'fire' || (ctx.t && isCreature(ctx.t) && ctx.t.st?.burning);
const waterSource = (ctx) => (ctx.t && (ctx.t.type === 'well' || (ctx.t.type === 'barrel' && ctx.t.liquid === 'water'))) || (!ctx.t && (ctx.tile === T.SHALLOW || ctx.tile === T.DEEP || ctx.surf?.type === 'water'));
const liquidSource = (ctx) => {
  if (waterSource(ctx)) return 'water';
  if (ctx.t?.type === 'barrel' && (ctx.t.liquid === 'oil' || ctx.t.liquid === 'poison')) return ctx.t.liquid;
  if (!ctx.t && (ctx.surf?.type === 'oil' || ctx.surf?.type === 'poison')) return ctx.surf.type;
  return null;
};
const FLASK = { water: 'flask_water', oil: 'flask_oil', poison: 'flask_poison' };

function consumeOne(G, e, stack) {
  stack.q--;
  if (stack.q <= 0) {
    const i = e.inv.indexOf(stack);
    if (i >= 0) e.inv.splice(i, 1);
    else for (const [k, s] of Object.entries(e.eq)) if (s === stack) e.eq[k] = null;
  }
}
function give(G, e, id, q) {
  const left = addItem(e, id, q);
  if (left) G.dropItems(e.x, e.y, [{ id, q: left }]);
}

/** ctx: { e, s (stack), t (target entity|null), x, y, surf, tile } */
export const APPLY_RULES = [
  { id: 'chop', label: 'Chop', match: (c) => tools(c.s).includes('axe') && c.t && (c.t.type === 'tree' || c.t.type === 'burnt_tree'),
    run(G, c) {
      const burnt = c.t.type === 'burnt_tree';
      c.t.uses = (c.t.uses ?? 3) - 1;
      if (burnt) give(G, c.e, 'charcoal', ri(1, 2)); else { give(G, c.e, 'wood', ri(1, 2)); if (chance(0.5)) give(G, c.e, 'stick', 1); }
      G.fx({ type: 'chips', x: c.t.x, y: c.t.y, c: burnt ? '#333' : '#8b5a2b' });
      if (c.t.uses <= 0) { c.t.type = 'stump'; delete c.t.uses; G.dirtyIndex = true; }
      return `${c.e.name} chops the ${burnt ? 'charred tree' : 'tree'}.`;
    } },
  { id: 'mine', label: 'Mine', match: (c) => tools(c.s).includes('pickaxe') && c.t && ['rock', 'ore', 'sulfur_rock'].includes(c.t.type),
    run(G, c) {
      const t = c.t;
      if (t.type === 'rock') { give(G, c.e, 'stone', ri(1, 2)); if (chance(t.flinty ? 0.8 : 0.4)) give(G, c.e, 'flint', 1); }
      if (t.type === 'ore') give(G, c.e, 'iron_ore', ri(1, 2));
      if (t.type === 'sulfur_rock') give(G, c.e, 'sulfur', ri(1, 2));
      G.fx({ type: 'chips', x: t.x, y: t.y, c: '#aaa' });
      t.uses = (t.uses ?? 3) - 1;
      if (t.uses <= 0) { G.removeEnt(t.id); }
      return `${c.e.name} mines the ${objName(t).toLowerCase()}.`;
    } },
  { id: 'harvest', label: 'Harvest (knife)', match: (c) => tools(c.s).includes('knife') && c.t?.type === 'bush' && !c.t.picked,
    run(G, c) { give(G, c.e, c.t.herb, 2); c.t.picked = 15; return `${c.e.name} carefully harvests ${ITEMS[c.t.herb].n}.`; } },
  { id: 'skin', label: 'Skin', match: (c) => tools(c.s).includes('knife') && c.t?.dead && c.t.kind === 'enemy' && c.t.type === 'wolf' && !c.t.skinned,
    run(G, c) { c.t.skinned = true; give(G, c.e, 'wolf_pelt', 1); give(G, c.e, 'raw_meat', ri(1, 2)); return `${c.e.name} skins the wolf.`; } },
  { id: 'fill', label: 'Fill flask', match: (c) => c.s.id === 'empty_flask' && !!liquidSource(c),
    run(G, c) {
      const liq = liquidSource(c);
      consumeOne(G, c.e, c.s);
      give(G, c.e, FLASK[liq], 1);
      if (c.t?.type === 'barrel') { c.t.uses = (c.t.uses ?? 6) - 1; if (c.t.uses <= 0) { G.log('The barrel is empty.'); c.t.liquid = 'empty'; } }
      else if (!c.t && c.surf && !c.surf.base && c.surf.type !== 'water') delete G.state.surfaces[G.map.idx(c.x, c.y)];
      return `${c.e.name} fills a flask with ${liq}.`;
    } },
  { id: 'douse', label: 'Douse', match: (c) => c.s.id === 'flask_water' && isLitFire(c),
    run(G, c) {
      consumeOne(G, c.e, c.s); give(G, c.e, 'empty_flask', 1);
      if (c.t && isCreature(c.t)) { delete c.t.st.burning; addStatus(G, c.t, 'wet', 2); }
      applyElement(G, c.x, c.y, 'water');
      return `${c.e.name} douses the flames.`;
    } },
  { id: 'pour', label: 'Pour out', match: (c) => !!ITEMS[c.s.id].liquid && !(c.t && c.t.kind === 'object') && !(c.s.id === 'flask_water' && isLitFire(c)),
    run(G, c) {
      const liq = ITEMS[c.s.id].liquid;
      consumeOne(G, c.e, c.s); give(G, c.e, 'empty_flask', 1);
      applyElement(G, c.x, c.y, liq);
      if (c.t && isCreature(c.t) && liq === 'oil') addStatus(G, c.t, 'oiled', 3);
      return `${c.e.name} pours out the ${liq}.`;
    } },
  { id: 'light', label: 'Light', match: (c) => isFireSource(c.s) && c.t && (c.t.type === 'campfire' || c.t.type === 'forge') && !c.t.lit,
    run(G, c) { c.t.lit = true; G.fx({ type: 'flare', x: c.t.x, y: c.t.y }); return `${c.e.name} lights the ${OBJECTS[c.t.type].n.toLowerCase()}.`; } },
  { id: 'ignite_barrel', label: 'Ignite (stand back!)', match: (c) => isFireSource(c.s) && c.t?.type === 'barrel' && (c.t.liquid === 'oil' || c.t.liquid === 'powder'),
    run(G, c) { G.later(500, () => damageObject(G, c.t, 99, 'fire')); G.float(c.t, 'hisss...', '#ffb347'); return `${c.e.name} lights the fuse...`; } },
  { id: 'ignite_tree', label: 'Set on fire', match: (c) => isFireSource(c.s) && c.t?.type === 'tree',
    run(G, c) { applyElement(G, c.t.x, c.t.y, 'fire', { ignite: true }); return `${c.e.name} sets the tree alight.`; } },
  { id: 'ignite_creature', label: 'Set on fire', match: (c) => isFireSource(c.s) && c.t && isCreature(c.t) && !c.t.dead && c.t.kind !== 'npc' && c.t !== c.e,
    run(G, c) { addStatus(G, c.t, 'burning', 2); return `${c.e.name} sets ${c.t.name} on fire!`; } },
  { id: 'ignite_tile', label: 'Ignite ground', match: (c) => isFireSource(c.s) && !c.t && c.surf?.type !== 'fire',
    run(G, c) { applyElement(G, c.x, c.y, 'fire', { ignite: true, src: c.e }); return `${c.e.name} sets the ground alight.`; } },
  { id: 'light_torch', label: 'Light torch', match: (c) => c.s.id === 'torch' && isLitFire(c),
    run(G, c) {
      if (c.e.eq.offhand === c.s) c.e.eq.offhand = { id: 'lit_torch', q: 1 };
      else { consumeOne(G, c.e, c.s); give(G, c.e, 'lit_torch', 1); }
      return `${c.e.name} lights a torch.`;
    } },
  { id: 'cook', label: 'Cook', match: (c) => c.s.id === 'raw_meat' && isLitFire(c) && c.t?.kind === 'object',
    run(G, c) { const n = c.s.q; consumeAll(c.e, c.s); give(G, c.e, 'cooked_meat', n); return `${c.e.name} cooks ${n} meat.`; } },
  { id: 'char', label: 'Burn into charcoal', match: (c) => c.s.id === 'wood' && c.t?.type === 'campfire' && c.t.lit,
    run(G, c) { consumeOne(G, c.e, c.s); give(G, c.e, 'charcoal', 2); return `${c.e.name} burns a log down to charcoal.`; } },
  { id: 'smelt', label: 'Smelt', match: (c) => c.s.id === 'iron_ore' && c.t?.type === 'forge' && c.t.lit,
    run(G, c) { const n = Math.min(c.s.q, 3); c.s.q -= n; c.e.inv = c.e.inv.filter((s) => s.q > 0); give(G, c.e, 'iron_ingot', n); return `${c.e.name} smelts ${n} iron ingot${n > 1 ? 's' : ''}.`; } },
  { id: 'unlock', label: 'Unlock', match: (c) => c.s.id === 'rusty_key' && c.t?.type === 'chest' && c.t.locked,
    run(G, c) { consumeOne(G, c.e, c.s); c.t.locked = false; return `${c.e.name} unlocks the chest.`; } },
  { id: 'smash_lock', label: 'Smash the lock', match: (c) => (tools(c.s).includes('hammer') || ITEMS[c.s.id].weapon?.blunt) && c.t?.type === 'chest' && c.t.locked,
    run(G, c) {
      if (chance(0.5)) { c.t.locked = false; G.fx({ type: 'chips', x: c.t.x, y: c.t.y, c: '#c79a5b' }); return `${c.e.name} smashes the lock open!`; }
      G.float(c.t, 'clang', '#bbb'); return `${c.e.name} bashes the lock. It holds... for now.`;
    } },
  { id: 'heal_ally', label: 'Use on ally', match: (c) => !!ITEMS[c.s.id].use?.heal && c.t?.kind === 'player' && c.t !== c.e,
    run(G, c) { useConsumable(G, c.t, c.s, c.e); return null; } },
];

function consumeAll(e, stack) { stack.q = 0; e.inv = e.inv.filter((s) => s.q > 0); }

export function useConsumable(G, target, stack, user) {
  const def = ITEMS[stack.id];
  const u = def.use;
  if (!u) return false;
  const owner = user || target;
  consumeOne(G, owner, stack);
  if (u.heal) heal(G, target, ri(u.heal[0], u.heal[1]));
  if (u.status) { target.st[u.status[0]] = u.status[1]; G.float(target, STATUS[u.status[0]].n, STATUS[u.status[0]].c); }
  for (const s of u.cure || []) delete target.st[s];
  if (u.risk && chance(0.35)) { addStatus(G, target, u.risk, 2); G.log(`${target.name} feels sick...`, 'bad'); }
  if (u.returns) give(G, owner, u.returns, 1);
  if (user && user !== target) G.log(`${user.name} uses ${def.n} on ${target.name}.`);
  else G.log(`${target.name} ${u.drink || /Potion|Antidote/.test(def.n) ? 'drinks' : 'uses'} ${def.n}.`);
  return true;
}

export function applyRulesFor(state, map, e, s, t, x, y) {
  const k = map.idx(x, y);
  const ctx = { e, s, t, x, y, surf: surfaceAt(state, map, k), tile: map.tiles[k] };
  return APPLY_RULES.filter((r) => { try { return r.match(ctx); } catch { return false; } });
}
export function makeCtx(state, map, e, s, t, x, y) {
  const k = map.idx(x, y);
  return { e, s, t, x, y, surf: surfaceAt(state, map, k), tile: map.tiles[k] };
}

/** Default interactions for a target entity (no item). Returns [{id,label}] */
export function defaultOptions(state, e, t) {
  const o = [];
  if (!t) return o;
  if (t.kind === 'object') {
    switch (t.type) {
      case 'chest': o.push(t.locked ? { id: 'locked', label: 'Open (locked)' } : { id: 'open', label: 'Open' }); break;
      case 'pile': o.push({ id: 'open', label: 'Pick up' }); break;
      case 'bush': if (!t.picked) o.push({ id: 'gather', label: `Gather ${ITEMS[t.herb].n}` }); break;
      case 'campfire': if (t.lit) o.push({ id: 'rest', label: 'Rest (heal fully)' }); o.push({ id: 'craft', label: 'Craft here' }); break;
      case 'forge': case 'workbench': case 'alchemy': o.push({ id: 'craft', label: 'Craft here' }); break;
      case 'barrel': case 'crate': o.push({ id: 'smash', label: 'Smash' }); break;
    }
  } else if (t.kind === 'npc') o.push({ id: 'trade', label: 'Trade' });
  else if (t.kind === 'enemy' && t.dead && t.items?.length) o.push({ id: 'open', label: 'Loot' });
  else if (t.kind === 'enemy' && !t.dead) o.push({ id: 'attack', label: 'Attack' });
  return o;
}

export function runDefault(G, pid, e, t, opt) {
  switch (opt) {
    case 'open':
      if (t.locked) return G.tell(pid, 'It is locked. A key, or something heavy, might help.');
      if (!G.spendAp(pid, e, 1)) return;
      G.tell(pid, { open: 'container', id: t.id });
      return;
    case 'locked': return G.tell(pid, 'Locked. Use a key on it — or a hammer or club to smash the lock.');
    case 'gather':
      if (t.picked) return G.tell(pid, 'Already picked. It will regrow.');
      if (!G.spendAp(pid, e, 1)) return;
      give(G, e, t.herb, 1); t.picked = 15;
      G.log(`${e.name} gathers ${ITEMS[t.herb].n}. (A knife yields more.)`);
      return;
    case 'rest':
      if (G.state.combat) return G.tell(pid, "You can't rest during combat.");
      for (const p of G.players()) if (Math.max(Math.abs(p.x - t.x), Math.abs(p.y - t.y)) <= 4) { p.downed = false; p.hp = p.maxHp; p.st = {}; G.float(p, 'Rested', '#6ee07a'); }
      G.log(`${e.name} rests by the fire. Everyone nearby recovers.`, 'good');
      if (phaseOf(G.state.time) === 'night' || phaseOf(G.state.time) === 'dusk') {
        const base = Math.floor(G.state.time / 1440) * 1440, m = G.state.time - base;
        G.state.time = m < DAY ? base + DAY : base + 1440 + DAY;
        G.log('The night passes. Dawn breaks over the village.', 'sys');
      }
      return;
    case 'smash':
      if (G.inCombat(e)) return G.attack(pid, e, t);
      damageObject(G, t, 99, 'physical');
      return;
    case 'craft': return G.tell(pid, { open: 'craft' });
    case 'trade': return G.tell(pid, { open: 'shop', id: t.id });
    case 'attack': return G.attack(pid, e, t);
  }
}
export { SURF, countItem };
