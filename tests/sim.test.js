// Headless smoke tests for the simulation (node tests/sim.test.js)
import assert from 'node:assert/strict';
import { Game } from '../js/sim/game.js';
import { makeEnemy } from '../js/sim/entities.js';
import { surfaceAt } from '../js/sim/rules.js';
import { matchCombination } from '../js/sim/crafting.js';

import { applyElement } from '../js/sim/rules.js';
import { lightAt, hitChance, LIT, DIM, DARK, phaseOf } from '../js/sim/light.js';
import { T } from '../js/data/tiles.js';
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
  const rnd = Math.random; Math.random = () => 0.5; // hit, no crit, no blood splash
  G.handleAction('a', { type: 'attack', target: w.id });
  Math.random = rnd;
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

test('light: day/night, forest canopy, campfire radius', () => {
  const G = new Game({ seed: 5 });
  const S = G.state, M = G.map;
  const fire = Object.values(S.entities).find((e) => e.type === 'campfire' && e.lit);
  let forest = null;
  for (let i = 0; i < M.tiles.length && !forest; i++) if (M.tiles[i] === T.FOREST) forest = [i % M.W, (i / M.W) | 0];
  S.time = 12 * 60;
  assert.equal(lightAt(S, M, S.spawn.x + 8, S.spawn.y + 8), LIT);
  assert.equal(lightAt(S, M, forest[0], forest[1]) <= DIM, true, 'forest canopy is dim at noon');
  S.time = 23 * 60;
  assert.equal(phaseOf(S.time), 'night');
  assert.equal(lightAt(S, M, fire.x + 1, fire.y), LIT, 'next to the campfire is lit');
  assert.equal(lightAt(S, M, fire.x + 5, fire.y), DIM, 'edge of campfire light is dim');
  assert.equal(lightAt(S, M, fire.x + 9, fire.y), DARK, 'beyond it is dark');
});

test('light: held torch lights you up, water puts it out, smoke blinds', () => {
  const G = new Game({ seed: 6 });
  G.state.time = 1 * 60;
  const { eid } = G.addPlayer('a', char('ranger'));
  const me = G.ent(eid);
  G.place(me, me.x + 12, me.y + 12);
  const before = lightAt(G.state, G.map, me.x, me.y);
  me.eq.offhand = { id: 'lit_torch', q: 1 };
  assert.equal(lightAt(G.state, G.map, me.x + 2, me.y), LIT);
  assert.ok(lightAt(G.state, G.map, me.x, me.y) > before);
  applyElement(G, me.x, me.y, 'water');
  assert.equal(me.eq.offhand.id, 'torch', 'torch doused');
  G.state.time = 12 * 60;
  const clear = lightAt(G.state, G.map, me.x + 3, me.y);
  applyElement(G, me.x + 3, me.y, 'smoke');
  assert.equal(lightAt(G.state, G.map, me.x + 3, me.y), DARK, 'smoke cloud is dark at noon');
  applyElement(G, me.x + 3, me.y, 'water');
  assert.equal(lightAt(G.state, G.map, me.x + 3, me.y), clear, 'water clears the smoke');
});

test('hit chance: darkness penalty, darkvision, unseen bonus', () => {
  const G = new Game({ seed: 7 });
  const { eid } = G.addPlayer('a', char('sellsword'));
  const me = G.ent(eid);
  G.place(me, me.x + 15, me.y + 15);
  const bandit = G.addEnt(makeEnemy('bandit', me.x + 1, me.y, 'gh'));
  const wolf = G.addEnt(makeEnemy('wolf', me.x, me.y + 1, 'gh'));
  G.state.time = 12 * 60;
  const day = hitChance(G.state, G.map, me, bandit).chance;
  G.state.time = 0;
  const night = hitChance(G.state, G.map, me, bandit).chance;
  assert.equal(day - night, 35, 'darkness costs 35%');
  me.st.nightsight = 5;
  assert.equal(day - hitChance(G.state, G.map, me, bandit).chance, 15, 'nightsight turns dark into dim');
  delete me.st.nightsight;
  assert.equal(hitChance(G.state, G.map, wolf, me).parts.some(([l]) => l.includes('darkvision')), true, 'wolves see in the dark');
  // attacker in darkness, target 5 tiles away lit by its own burning
  G.place(bandit, me.x + 5, me.y);
  bandit.st.burning = 2;
  const h = hitChance(G.state, G.map, me, bandit);
  assert.ok(h.parts.some(([l]) => l.includes('unseen')), 'unseen bonus');
});

test('a missed firebolt still ignites the oil it lands in', () => {
  const G = new Game({ seed: 9 });
  const { eid } = G.addPlayer('a', char('elementalist'));
  const me = G.ent(eid);
  const b = G.addEnt(makeEnemy('bandit', me.x + 3, me.y, 'gm'));
  G.state.surfaces[G.map.idx(b.x, b.y)] = { type: 'oil', t: 6 };
  G.startCombat([b.id], me.id);
  const rnd = Math.random; Math.random = () => 0.995; // force the miss
  const hp = b.hp;
  G.handleAction('a', { type: 'skill', id: 'firebolt', x: b.x, y: b.y, target: b.id });
  Math.random = rnd;
  assert.equal(surfaceAt(G.state, G.map, G.map.idx(b.x, b.y)).type, 'fire', 'oil ignited');
  assert.ok(b.st.burning, 'but the fire still catches the bandit');
  assert.ok(b.hp <= hp);
});

test('resting at night skips to morning', () => {
  const G = new Game({ seed: 10 });
  const { eid } = G.addPlayer('a', char('sellsword'));
  const me = G.ent(eid);
  G.state.time = 22 * 60;
  const fire = Object.values(G.state.entities).find((e) => e.type === 'campfire' && e.lit);
  G.place(me, fire.x + 1, fire.y);
  G.handleAction('a', { type: 'interact', target: fire.id, opt: 'rest' });
  assert.equal(phaseOf(G.state.time), 'day');
  assert.ok(G.state.time > 22 * 60);
});

for (const [name, fn] of tests) {
  try { await fn(); passed++; console.log('✓', name); } catch (e) { console.error('✗', name, '\n', e); process.exitCode = 1; }
}
console.log(`\n${passed}/${tests.length} tests passed`);
