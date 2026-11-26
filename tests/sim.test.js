// Headless smoke tests for the simulation (node tests/sim.test.js)
import assert from 'node:assert/strict';
import { Game } from '../js/sim/game.js';
import { makeEnemy } from '../js/sim/entities.js';
import { surfaceAt } from '../js/sim/rules.js';
import { matchCombination } from '../js/sim/crafting.js';

import { applyElement } from '../js/sim/rules.js';
let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const run = (G, ms) => { const end = performance.now() + ms; while (performance.now() < end) G.tick(); };
const char = (cls, name = 'Tess') => ({ name, cls, color: '#4fa3ff', attrs: { sellsword: { might: 6, finesse: 3, intellect: 2, vigor: 7 }, ranger: { might: 3, finesse: 8, intellect: 2, vigor: 5 }, alchemist: { might: 4, finesse: 5, intellect: 6, vigor: 3 }, elementalist: { might: 2, finesse: 4, intellect: 8, vigor: 4 } }[cls] });

test('world generates with village, camps, enemies', () => {
  const G = new Game({ seed: 1234 });
  const ents = Object.values(G.state.entities);
  assert.ok(ents.filter((e) => e.kind === 'enemy').length >= 20, 'enemies');
  assert.ok(ents.some((e) => e.type === 'forge'));
  assert.ok(ents.some((e) => e.kind === 'npc'));
  console.log('   entities:', ents.length, 'enemies:', ents.filter((e) => e.kind === 'enemy').length, 'json KB:', (JSON.stringify(G.state).length / 1024) | 0);
});

test('players join, max 4, reconnect by name', () => {
  const G = new Game({ seed: 5 });
  for (let i = 0; i < 4; i++) assert.ok(G.addPlayer('p' + i, char('ranger', 'P' + i)).eid);
  assert.ok(G.addPlayer('p9', char('ranger', 'Extra')).error);
  G.removePlayer('p1');
  const r = G.addPlayer('p10', char('ranger', 'P1'));
  assert.ok(r.eid);
  assert.equal(G.players().length, 4);
});

test('oil + fire spreads along connected oil', () => {
  const G = new Game({ seed: 77 });
  const { x, y } = G.state.spawn;
  const k = (dx) => G.map.idx(x + 5 + dx, y + 3);
  for (let dx = 0; dx < 3; dx++) G.state.surfaces[k(dx)] = { type: 'oil', t: 5 };
  applyElement(G, x + 5, y + 3, 'fire', { ignite: true });
  for (let dx = 0; dx < 3; dx++) assert.equal(G.state.surfaces[k(dx)].type, 'fire');
});

test('surface reactions', () => {
  const G = new Game({ seed: 77 });
  const { x, y } = G.state.spawn;
  const tx = x + 4, ty = y + 4;
  const k = G.map.idx(tx, ty);
  applyElement(G, tx, ty, 'water');
  assert.equal(surfaceAt(G.state, G.map, k)?.type, 'water');
  applyElement(G, tx, ty, 'shock');
  assert.ok(surfaceAt(G.state, G.map, k).e, 'electrified');
  applyElement(G, tx, ty, 'frost');
  assert.equal(surfaceAt(G.state, G.map, k).type, 'ice');
  applyElement(G, tx, ty, 'fire');
  assert.equal(surfaceAt(G.state, G.map, k).type, 'water');
  applyElement(G, tx, ty, 'fire');
  assert.equal(surfaceAt(G.state, G.map, k).type, 'steam');
});

test('crafting combos match', () => {
  assert.equal(matchCombination([{ id: 'flask_oil', q: 1 }, { id: 'cloth', q: 1 }]).recipe.id, 'fire_bomb');
  assert.equal(matchCombination([{ id: 'emberroot', q: 1 }, { id: 'mortar', q: 1 }]).recipe.id, 'ember_paste');
  assert.equal(matchCombination([{ id: 'dagger', q: 1 }, { id: 'ember_paste', q: 1 }]).kind, 'coat');
  assert.equal(matchCombination([{ id: 'arrows', q: 9 }, { id: 'flask_poison', q: 1 }]).kind, 'coat');
  assert.equal(matchCombination([{ id: 'stone', q: 1 }, { id: 'cloth', q: 1 }]), null);
});

test('host actions: craft fire bomb, throw it, combat with enemy', () => {
  const G = new Game({ seed: 99 });
  const { eid } = G.addPlayer('a', char('alchemist'));
  const me = G.ent(eid);
  const before = me.inv.find((s) => s.id === 'fire_bomb')?.q || 0;
  const oil = me.inv.findIndex((s) => s.id === 'flask_oil'), cloth = me.inv.findIndex((s) => s.id === 'cloth');
  G.handleAction('a', { type: 'combine', refs: [oil, cloth] });
  assert.equal(me.inv.find((s) => s.id === 'fire_bomb').q, before + 1);
  // spawn a wolf next to the player and attack
  const w = G.addEnt(makeEnemy('wolf', me.x + 2, me.y, 'gx'));
  G.handleAction('a', { type: 'attack', target: w.id });
  assert.ok(G.state.combat, 'combat started');
  assert.equal(G.state.combat.active, me.id);
  run(G, 1500);
  const bomb = me.inv.findIndex((s) => s.id === 'fire_bomb');
  G.handleAction('a', { type: 'throw', ref: bomb, x: w.x, y: w.y });
  run(G, 800);
  assert.ok(w.hp < w.maxHp, 'wolf took damage');
  // play out the fight: player ends turns, AI acts
  for (let i = 0; i < 40 && G.state.combat; i++) {
    if (G.state.combat.active === me.id) {
      if (me.downed) break;
      G.handleAction('a', { type: 'attack', target: w.id });
      run(G, 900);
      G.handleAction('a', { type: 'endTurn' });
    }
    run(G, 300);
  }
  console.log('   combat over:', !G.state.combat, 'wolf dead:', !!w.dead, 'me hp', me.hp, 'downed', !!me.downed);
});

test('apply rules: fill flask at well, light forge', () => {
  const G = new Game({ seed: 3 });
  const { eid } = G.addPlayer('a', char('sellsword'));
  const me = G.ent(eid);
  const well = Object.values(G.state.entities).find((e) => e.type === 'well');
  me.inv.push({ id: 'empty_flask', q: 1 });
  G.handleAction('a', { type: 'apply', ref: me.inv.length - 1, target: well.id });
  run(G, 3000);
  assert.ok(me.inv.some((s) => s.id === 'flask_water'), 'filled flask');
  const forge = Object.values(G.state.entities).find((e) => e.type === 'forge');
  const tb = me.inv.findIndex((s) => s.id === 'tinderbox');
  G.handleAction('a', { type: 'apply', ref: tb, target: forge.id });
  run(G, 3000);
  assert.ok(forge.lit, 'forge lit');
});


test('coated weapon applies its element on hit', () => {
  const G = new Game({ seed: 11 });
  const { eid } = G.addPlayer('a', char('sellsword'));
  const me = G.ent(eid);
  me.inv.push({ id: 'ember_paste', q: 1 });
  G.handleAction('a', { type: 'combine', refs: ['eq:weapon', String(me.inv.length - 1)] });
  assert.equal(me.eq.weapon.d.coat, 'fire');
  const w = G.addEnt(makeEnemy('wolf', me.x + 1, me.y, 'gq'));
  w.hp = w.maxHp = 200;
  G.handleAction('a', { type: 'attack', target: w.id });
  assert.ok(w.st.burning, 'wolf burning');
  assert.equal(me.eq.weapon.d.ch, 3);
});

test('forge chain: light forge, smelt ore, forge a sword', () => {
  const G = new Game({ seed: 3 });
  const { eid } = G.addPlayer('a', char('sellsword'));
  const me = G.ent(eid);
  const forge = Object.values(G.state.entities).find((e) => e.type === 'forge');
  G.place(me, forge.x - 1, forge.y + 1);
  me.inv.push({ id: 'iron_ore', q: 4 }, { id: 'hammer', q: 1 }, { id: 'leather', q: 1 });
  G.handleAction('a', { type: 'apply', ref: me.inv.findIndex((s) => s.id === 'tinderbox'), target: forge.id });
  assert.ok(forge.lit);
  G.handleAction('a', { type: 'apply', ref: me.inv.findIndex((s) => s.id === 'iron_ore'), target: forge.id });
  assert.equal(me.inv.find((s) => s.id === 'iron_ingot').q, 3);
  G.handleAction('a', { type: 'combine', refs: [me.inv.findIndex((s) => s.id === 'iron_ingot'), me.inv.findIndex((s) => s.id === 'leather')] });
  assert.ok(me.inv.some((s) => s.id === 'iron_sword'), 'sword forged');
  assert.ok(G.state.recipes.includes('iron_sword'), 'recipe discovered');
});

test('fire reaches an oil barrel: explosion damages and spreads fire', () => {
  const G = new Game({ seed: 21 });
  const { eid } = G.addPlayer('a', char('elementalist'));
  const me = G.ent(eid);
  const bx = me.x + 4, by = me.y + 2;
  const barrel = G.addEnt({ kind: 'object', type: 'barrel', liquid: 'oil', hp: 6, x: bx, y: by });
  const wolf = G.addEnt(makeEnemy('wolf', bx + 1, by, 'gb'));
  applyElement(G, bx, by, 'fire', { ignite: true });
  run(G, 600);
  assert.ok(!G.ent(barrel.id), 'barrel destroyed');
  assert.ok(wolf.hp < wolf.maxHp, 'wolf hurt by blast');
  assert.equal(surfaceAt(G.state, G.map, G.map.idx(bx, by)).type, 'fire');
});

test('frost on water freezes creatures standing in it', () => {
  const G = new Game({ seed: 8 });
  const { eid } = G.addPlayer('a', char('elementalist'));
  const me = G.ent(eid);
  const x = me.x + 3, y = me.y + 3;
  applyElement(G, x, y, 'water'); applyElement(G, x + 1, y, 'water');
  const w = G.addEnt(makeEnemy('wolf', x + 1, y, 'gf'));
  applyElement(G, x, y, 'frost');
  assert.ok(w.st.frozen, 'wolf frozen');
  assert.equal(surfaceAt(G.state, G.map, G.map.idx(x + 1, y)).type, 'ice');
});

for (const [name, fn] of tests) {
  try { await fn(); passed++; console.log('✓', name); } catch (e) { console.error('✗', name, '\n', e); process.exitCode = 1; }
}
console.log(`\n${passed}/${tests.length} tests passed`);
