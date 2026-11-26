// Authoritative host simulation: state, movement, combat turns, player actions.
import { Emitter, cheb, roll, ri, chance, clamp } from '../util.js';
import { ITEMS, SHOP, sellPrice, itemName } from '../data/items.js';
import { ENEMIES } from '../data/enemies.js';
import { OBJECTS } from '../data/objects.js';
import { ATTRS } from '../data/classes.js';
import { STARTING_RECIPES } from '../data/recipes.js';
import { WorldMap, buildIndex, findPath, los, walkable, isCreature, encodeTiles, decodeTiles } from './map.js';
import { generateWorld } from './worldgen.js';
import { makePlayer, weaponOf, statMult, critChance, moveRange, maxAp, apRegen, throwRange, throwAp, addItem, takeFromSlot, maxHp } from './entities.js';
import { dealDamage, addStatus, tickStatuses, tickSurfaces, surfaceEffect, applyElement, applyArea, heal, explosion, elementHit, damageObject } from './rules.js';
import { SKILLS, skillError } from './skills.js';
import { doCombine, craftRecipe, stackAt } from './crafting.js';
import { applyRulesFor, makeCtx, defaultOptions, runDefault, useConsumable } from './interact.js';
import { aiStep } from './ai.js';
import { hitChance, START_TIME } from './light.js';

const ROUND_MS = 4000;

export class Game {
  constructor(opts) {
    this.events = new Emitter();
    this.rt = new Map();
    this.timers = [];
    this.outLog = []; this.outFx = []; this.outPriv = [];
    this.pendingAggro = new Set();
    if (opts.save) {
      const s = opts.save;
      this.map = new WorldMap(s.W, s.H, decodeTiles(s.tiles));
      this.state = s.state;
      this.state.players = {};
      this.state.combat = null;
      for (const e of Object.values(this.state.entities)) if (e.kind === 'player') { e.online = false; delete e.pid; }
    } else {
      const seed = opts.seed ?? Math.floor(Math.random() * 1e9);
      const w = generateWorld(seed);
      this.map = new WorldMap(w.W, w.H, w.tiles);
      this.state = { seed, nextId: 1, entities: {}, surfaces: {}, combat: null, players: {}, recipes: [...STARTING_RECIPES], spawn: w.spawn, round: 0, time: START_TIME };
      for (const e of w.entities) this.addEnt(e);
    }
    if (this.state.time == null) this.state.time = START_TIME;
    this.dirtyIndex = true;
    this.lastRound = performance.now();
    this.lastWander = 0;
  }

  // ---------- infrastructure ----------
  get index() {
    if (this.dirtyIndex) { this._index = buildIndex(this.state, this.map); this.dirtyIndex = false; }
    return this._index;
  }
  newId(p) { return p + (this.state.nextId++).toString(36); }
  ent(id) { return this.state.entities[id]; }
  addEnt(e) {
    e.id = this.newId(e.kind[0]);
    this.state.entities[e.id] = e;
    this.dirtyIndex = true;
    return e;
  }
  removeEnt(id) { delete this.state.entities[id]; this.rt.delete(id); this.dirtyIndex = true; }
  rtOf(id) {
    let r = this.rt.get(id);
    if (!r) this.rt.set(id, (r = { path: [], queued: null, next: 0, aiNext: 0, aiSteps: 0 }));
    return r;
  }
  place(e, x, y) { e.x = x; e.y = y; this.dirtyIndex = true; }
  log(text, cls = '') { const m = { text, cls }; this.outLog.push(m); this.events.emit('log', m); }
  fx(o) { this.outFx.push(o); this.events.emit('fx', o); }
  float(e, text, c) { this.fx({ type: 'float', x: e.x, y: e.y, text, c }); }
  tell(pid, msg) { if (pid) { this.outPriv.push({ pid, msg }); this.events.emit('priv', { pid, msg }); } }
  later(ms, fn) { this.timers.push({ at: performance.now() + ms, fn }); }
  players() { return Object.values(this.state.entities).filter((e) => e.kind === 'player'); }
  creaturesAt(x, y) {
    const a = this.index.at.get(this.map.idx(x, y));
    return a ? a.filter((e) => isCreature(e) && e.kind !== 'npc' && !e.dead && !e.downed) : [];
  }
  objectsAt(x, y) {
    const a = this.index.at.get(this.map.idx(x, y));
    return a ? a.filter((e) => e.kind === 'object') : [];
  }
  creatureKeys(except) {
    const s = new Set(this.index.creatures.keys());
    if (except) s.delete(this.map.idx(except.x, except.y));
    return s;
  }
  hostile(a, b) { return isCreature(b) && b.kind !== 'npc' && !b.dead && (a.kind === 'player') !== (b.kind === 'player'); }
  inCombat(e) { return !!(this.state.combat && this.state.combat.order.includes(e.id)); }
  aggro(e) { if (e.kind === 'enemy' && !e.dead && !this.inCombat(e)) this.pendingAggro.add(e.id); }

  dropItems(x, y, items) {
    if (!items?.length) return;
    let pile = this.objectsAt(x, y).find((o) => o.type === 'pile');
    if (!pile) pile = this.addEnt({ kind: 'object', type: 'pile', x, y, items: [] });
    for (const it of items) {
      const ex = !it.d && ITEMS[it.id].stack > 1 && pile.items.find((s) => s.id === it.id && !s.d);
      if (ex) ex.q += it.q; else pile.items.push({ ...it });
    }
  }

  serialize() {
    return { v: 1, W: this.map.W, H: this.map.H, tiles: encodeTiles(Array.from(this.map.tiles)), state: this.state };
  }

  // ---------- players ----------
  addPlayer(pid, char) {
    const name = String(char.name || 'Wanderer').slice(0, 16);
    const online = this.players().filter((p) => p.online);
    if (online.some((p) => p.name.toLowerCase() === name.toLowerCase())) return { error: `A player named ${name} is already here.` };
    let e = this.players().find((p) => !p.online && p.name.toLowerCase() === name.toLowerCase());
    if (!e) {
      if (online.length >= 4) return { error: 'Game is full (4 players max).' };
      const sp = this.freeTileNear(this.state.spawn.x, this.state.spawn.y);
      e = this.addEnt(makePlayer({ ...char, name }, sp[0], sp[1]));
      this.log(`${name} the ${char.cls[0].toUpperCase() + char.cls.slice(1)} joins the party.`, 'good');
    } else this.log(`${name} has returned.`, 'good');
    e.online = true; e.pid = pid;
    this.state.players[pid] = { eid: e.id, name };
    if (this.state.combat && !this.inCombat(e)) { this.state.combat.order.push(e.id); e.ap = 0; }
    return { eid: e.id };
  }
  removePlayer(pid) {
    const p = this.state.players[pid];
    if (!p) return;
    delete this.state.players[pid];
    const e = this.ent(p.eid);
    if (e) {
      e.online = false; delete e.pid;
      this.log(`${e.name} left the game.`);
      if (this.state.combat?.active === e.id) this.endTurn(e.id);
    }
  }
  freeTileNear(x, y) {
    for (let r = 0; r < 8; r++)
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        const nx = x + dx, ny = y + dy;
        if (walkable(this.map, this.index, nx, ny) && !this.index.creatures.has(this.map.idx(nx, ny))) return [nx, ny];
      }
    return [x, y];
  }

  // ---------- movement ----------
  moveCost(e, n) { return Math.ceil(Math.max(0, n - e.mp) / moveRange(e)); }
  payMove(e, n) {
    const c = this.moveCost(e, n);
    e.ap -= c;
    e.mp = e.mp + c * moveRange(e) - n;
  }
  startPath(e, path, queued) {
    const r = this.rtOf(e.id);
    r.path = path.slice();
    r.queued = queued;
    r.next = performance.now() + 30;
  }
  /** Ensure e is within range of (x,y); if not, walk there and re-issue the action. Returns true if ready now. */
  approach(pid, e, a, x, y, range, cost = 0, needLos = false) {
    const ok = () => cheb(e.x, e.y, x, y) <= range && (!needLos || los(this.map, this.index, e.x, e.y, x, y));
    if (ok()) return true;
    if (a._arrived) { this.tell(pid, "Can't reach that from here."); return false; }
    const combat = this.inCombat(e);
    const path = findPath(this.map, this.index, e.x, e.y, x, y, { range, needLos, blockCreatures: combat ? this.creatureKeys(e) : null, maxNodes: combat ? 3000 : 9000 });
    if (!path || !path.length) { this.tell(pid, 'No path there.'); return false; }
    if (combat) {
      const mc = this.moveCost(e, path.length);
      if (mc + cost > e.ap) { this.tell(pid, `Not enough AP (need ${mc + cost}).`); return false; }
      this.payMove(e, path.length);
    }
    this.startPath(e, path, { pid, a: { ...a, _arrived: true } });
    return false;
  }
  knockback(t, fx, fy, n) {
    const dx = Math.sign(t.x - fx), dy = Math.sign(t.y - fy);
    for (let i = 0; i < n; i++) {
      const nx = t.x + dx, ny = t.y + dy;
      if (!walkable(this.map, this.index, nx, ny) || this.index.creatures.has(this.map.idx(nx, ny))) {
        dealDamage(this, t, ri(2, 4), 'physical', null);
        this.float(t, 'Slammed!', '#ffd27f');
        break;
      }
      this.place(t, nx, ny);
      surfaceEffect(this, t, 'enter');
      if (t.dead || t.downed) break;
    }
    const r = this.rtOf(t.id); r.path = []; r.queued = null;
  }

  // ---------- combat ----------
  startCombat(enemyIds, firstId) {
    const S = this.state;
    const set = new Set();
    const live = (e) => e && e.kind === 'enemy' && !e.dead;
    for (const id of enemyIds) if (live(this.ent(id))) set.add(id);
    if (!set.size) return;
    const all = Object.values(S.entities).filter((e) => live(e) && !this.inCombat(e));
    for (const id of [...set]) {
      const a = this.ent(id);
      for (const o of all) if (o.grp === a.grp || cheb(o.x, o.y, a.x, a.y) <= 6) set.add(o.id);
    }
    const newcomers = [...set].filter((id) => !S.combat || !S.combat.order.includes(id)).map((id) => this.ent(id));
    for (const e of newcomers) { e.ap = 0; e.mp = 0; const r = this.rtOf(e.id); r.path = []; r.queued = null; }
    if (S.combat) {
      for (const e of newcomers) { S.combat.order.push(e.id); this.log(`${e.name} joins the fight!`, 'bad'); }
      for (const p of this.players()) if (!this.inCombat(p)) S.combat.order.push(p.id);
      return;
    }
    const parts = [...this.players(), ...newcomers];
    const init = new Map(parts.map((e) => [e.id, e.id === firstId ? 999 : (e.attrs?.finesse || 3) * 2 + ri(0, 6)]));
    parts.sort((a, b) => init.get(b.id) - init.get(a.id));
    for (const p of parts) {
      p.ap = 0; p.mp = 0;
      const r = this.rtOf(p.id); r.path = []; r.queued = null;
    }
    S.combat = { order: parts.map((p) => p.id), idx: 0, round: 1, active: null };
    this.log('⚔ Combat begins!', 'bad');
    this.fx({ type: 'banner', text: 'Combat!' });
    this.startTurn(0);
  }

  startTurn(idx) {
    const c = this.state.combat;
    if (!c) return;
    c.idx = idx;
    const e = this.ent(c.order[idx]);
    c.active = e?.id || null;
    if (!e || e.dead || e.downed || (e.kind === 'player' && !e.online)) {
      // skip silently (offline players lose their turn)
      return this.later(e && e.kind === 'player' && !e.online ? 300 : 0, () => { if (this.state.combat === c && c.active === (e?.id || null)) this.nextTurn(); });
    }
    e.ap = Math.min(maxAp(e), e.ap + apRegen(e) - (e.st.chilled ? 1 : 0));
    e.mp = 0;
    for (const sk of e.skills || []) if (sk.cd > 0) sk.cd--;
    tickStatuses(this, e);
    if (!e.dead && !e.downed) surfaceEffect(this, e, 'turn');
    const r = this.rtOf(e.id);
    r.aiSteps = 0; r.moved = 0; r.waitEnd = false;
    c.turnStart = Date.now();
    if (e.dead || e.downed) return this.later(600, () => this.endTurn(e.id));
    if (e.st.frozen || e.st.stunned) {
      this.log(`${e.name} is ${e.st.frozen ? 'frozen' : 'stunned'} and loses the turn.`);
      this.float(e, 'Skip', '#ffe14d');
      return this.later(900, () => this.endTurn(e.id));
    }
    if (e.kind === 'enemy') r.aiNext = performance.now() + 550;
  }
  endTurn(id) {
    const c = this.state.combat;
    if (!c || c.active !== id) return;
    const e = this.ent(id);
    if (e) e.mp = 0;
    this.nextTurn();
  }
  nextTurn() {
    const c = this.state.combat;
    if (!c) return;
    if (this.checkCombatEnd()) return;
    let idx = c.idx + 1;
    if (idx >= c.order.length) {
      idx = 0;
      c.round++;
      this.state.time += 1;
      tickSurfaces(this);
      // prune the dead
      c.order = c.order.filter((id) => { const e = this.ent(id); return e && !(e.kind === 'enemy' && e.dead); });
      if (this.checkCombatEnd()) return;
    }
    this.startTurn(idx);
  }
  checkCombatEnd() {
    const c = this.state.combat;
    if (!c) return true;
    const ents = c.order.map((id) => this.ent(id)).filter(Boolean);
    const foes = ents.filter((e) => e.kind === 'enemy' && !e.dead);
    const friends = ents.filter((e) => e.kind === 'player' && !e.downed);
    if (foes.length && friends.length) return false;
    this.state.combat = null;
    if (!foes.length) {
      this.log('✦ Victory! The fight is over.', 'good');
      this.fx({ type: 'banner', text: 'Victory' });
      for (const p of this.players()) if (p.downed) { p.downed = false; p.hp = Math.max(1, Math.floor(p.maxHp * 0.25)); this.log(`${p.name} staggers back up.`); }
    } else {
      this.log('☠ The party has fallen... You wake up in the village.', 'bad');
      this.fx({ type: 'banner', text: 'Defeated' });
      for (const p of this.players()) {
        const sp = this.freeTileNear(this.state.spawn.x, this.state.spawn.y);
        this.place(p, sp[0], sp[1]);
        p.downed = false; p.st = {}; p.hp = Math.ceil(p.maxHp / 2);
      }
      for (const e of foes) { e.hp = e.maxHp; e.st = {}; this.place(e, e.hx, e.hy); }
    }
    for (const e of ents) { e.ap = 0; e.mp = 0; }
    this.lastRound = performance.now();
    return true;
  }
  spendAp(pid, e, n) {
    if (!this.inCombat(e)) return true;
    if (e.ap < n) { this.tell(pid, `Not enough AP (need ${n}).`); return false; }
    e.ap -= n;
    return true;
  }

  // ---------- attacks & skills ----------
  /** Roll to hit a creature; light, finesse and statuses all count. Returns true on hit. */
  rollHit(e, t, kind, what) {
    if (!t || !isCreature(t) || t.kind === 'npc') return true;
    const h = hitChance(this.state, this.map, e, t, kind);
    const r = Math.random() * 100;
    if (r < h.chance) return true;
    this.float(t, 'Miss', '#c9c9c9');
    this.log(`${e.name}'s ${what} misses ${t.name} (${h.chance}% to hit${h.light < 2 ? ', target in ' + (h.light ? 'dim light' : 'darkness') : ''}).`, 'sys');
    return false;
  }
  weaponStrike(e, t, mult) {
    const w = weaponOf(e);
    let ammo = null;
    if (w.ammo) {
      ammo = e.inv.find((s) => s.id === w.ammo && s.d) || e.inv.find((s) => s.id === w.ammo);
      if (!ammo) { this.float(e, 'No arrows!', '#f66'); return 'Out of arrows'; }
      ammo.q--;
      if (ammo.q <= 0) e.inv.splice(e.inv.indexOf(ammo), 1);
    }
    if (w.ranged) this.fx({ type: 'proj', fx: e.x, fy: e.y, tx: t.x, ty: t.y, c: (ammo?.d?.coat && { fire: '#ff7a2e', frost: '#9fe3ff', shock: '#f5e663', poison: '#8ee05a', oil: '#8a6d3b' }[ammo.d.coat]) || w.proj || '#ddd' });
    else this.fx({ type: 'swing', x: e.x, y: e.y, tx: t.x, ty: t.y });
    if (!this.rollHit(e, t, w.ranged ? 'ranged' : 'melee', mult > 1 ? 'aimed shot' : w.n || 'attack')) return null;
    const crit = chance(critChance(e) + (w.crit || 0) / 100);
    const dmg = Math.round(roll(w.dmg) * statMult(e, w.stat) * mult);
    dealDamage(this, t, dmg, w.type || 'physical', e, { crit, noStatus: !w.el });
    if (w.el) applyElement(this, t.x, t.y, w.el, { src: e });
    const coat = ammo?.d?.coat || w.stack?.d?.coat;
    if (coat && !t.dead) {
      if (coat === 'oil') { if (isCreature(t)) addStatus(this, t, 'oiled', 2); }
      else {
        dealDamage(this, t, ri(2, 4), coat, e);
        if (coat !== 'poison') applyElement(this, t.x, t.y, coat, { src: e });
      }
      if (!ammo && w.stack?.d) { w.stack.d.ch--; if (w.stack.d.ch <= 0) delete w.stack.d; }
    }
    return null;
  }
  attack(pid, e, t, a = {}) {
    if (!t || t.dead || t.gone) return this.tell(pid, 'Invalid target.');
    const destructible = t.kind === 'object' && OBJECTS[t.type]?.destructible;
    if (!destructible && t.kind !== 'enemy') return this.tell(pid, "You can't attack that.");
    if (t.kind === 'enemy' && !this.inCombat(e)) {
      this.startCombat([t.id], e.id);
      if (!this.inCombat(e) || this.state.combat.active !== e.id) return;
    }
    const w = weaponOf(e);
    if (!this.approach(pid, e, { ...a, type: 'attack', target: t.id }, t.x, t.y, w.range, w.ap, w.range > 1)) return;
    if (w.ammo && !e.inv.some((s) => s.id === w.ammo)) return this.tell(pid, 'Out of arrows! Craft some (stick + feather + flint).');
    if (!this.spendAp(pid, e, w.ap)) return;
    this.weaponStrike(e, t, 1);
  }
  castSkill(e, sk, args) {
    const s = SKILLS[sk.id];
    if (e.kind === 'enemy') e.ap -= s.ap;
    let miss = false;
    if (s.attack) {
      const tgt = args.target && isCreature(args.target) ? args.target : this.creaturesAt(args.x, args.y)[0];
      if (tgt && this.hostile(e, tgt)) miss = !this.rollHit(e, tgt, 'spell', s.n);
    }
    const res = s.cast(this, e, { ...args, miss });
    sk.cd = s.cd;
    this.log(`${e.name} uses ${s.n}.`, 'skill');
    return res;
  }
  cmdSkill(pid, e, a) {
    const sk = e.skills.find((s) => s.id === a.id);
    if (!sk) return this.tell(pid, "You don't know that skill.");
    const s = SKILLS[a.id];
    const target = a.target ? this.ent(a.target) : null;
    const losFn = (x0, y0, x1, y1) => los(this.map, this.index, x0, y0, x1, y1);
    const err = skillError(this.state, this.map, this.index, e, sk, { x: a.x, y: a.y, target }, losFn);
    if (err) return this.tell(pid, err);
    if (!this.inCombat(e)) {
      let foes = [];
      if (target?.kind === 'enemy') foes = [target];
      else if (s.target === 'tile') foes = this.creaturesAt(a.x, a.y).filter((c) => c.kind === 'enemy');
      else if (s.id === 'cleave') for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) foes.push(...this.creaturesAt(e.x + dx, e.y + dy).filter((c) => c.kind === 'enemy'));
      if (foes.length && s.id !== 'rain') {
        this.startCombat(foes.map((f) => f.id), e.id);
        if (this.state.combat?.active !== e.id) return;
      }
    }
    if (!this.spendAp(pid, e, s.ap)) return;
    const res = this.castSkill(e, sk, { x: a.x, y: a.y, target });
    if (typeof res === 'string') this.tell(pid, res);
  }
  cmdThrow(pid, e, a) {
    const s = stackAt(e, a.ref);
    if (!s || String(a.ref).startsWith('eq:')) return this.tell(pid, 'Pick an item from your bags to throw.');
    if (!this.map.inb(a.x, a.y)) return;
    const range = throwRange(e);
    if (cheb(e.x, e.y, a.x, a.y) > range) {
      if (this.inCombat(e)) return this.tell(pid, `Out of throwing range (${range}).`);
      if (!this.approach(pid, e, a, a.x, a.y, range)) return;
    }
    if (!this.inCombat(e)) {
      const r = ITEMS[s.id].throw?.r || 0;
      const foes = [];
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) foes.push(...this.creaturesAt(a.x + dx, a.y + dy).filter((c) => c.kind === 'enemy'));
      if (foes.length) { this.startCombat(foes.map((f) => f.id), e.id); if (this.state.combat?.active !== e.id) return; }
    }
    if (!this.spendAp(pid, e, throwAp(e))) return;
    const item = takeFromSlot(e, +a.ref, 1);
    this.log(`${e.name} throws ${itemName(item)}.`);
    this.resolveThrow(e, item, a.x, a.y);
  }
  resolveThrow(e, item, x, y) {
    const def = ITEMS[item.id];
    const d = cheb(e.x, e.y, x, y);
    this.fx({ type: 'throw', fx: e.x, fy: e.y, tx: x, ty: y, c: def.c, i: def.i, ms: 220 + d * 45 });
    const t = def.throw;
    this.later(220 + d * 45, () => {
      if (t) {
        this.fx({ type: 'splash', x, y, r: t.r || 0, c: def.c });
        if (t.explosion) explosion(this, x, y, t.r, t.dmg, t.type, e);
        else if (t.dmg) {
          for (let dy = -(t.r || 0); dy <= (t.r || 0); dy++) for (let dx = -(t.r || 0); dx <= (t.r || 0); dx++) {
            if (dx * dx + dy * dy > (t.r || 0) * ((t.r || 0) + 1)) continue;
            for (const c of this.creaturesAt(x + dx, y + dy)) dealDamage(this, c, roll(t.dmg), t.type, e, { noStatus: !!t.el });
            for (const o of this.objectsAt(x + dx, y + dy)) if (OBJECTS[o.type]?.destructible) damageObject(this, o, roll(t.dmg), t.type);
          }
        }
        if (t.liquid) applyArea(this, x, y, t.r, t.liquid, { src: e });
        if (t.el) applyArea(this, x, y, t.r, t.el, { ignite: true, src: e });
        if (t.heal) for (let dy = -t.r; dy <= t.r; dy++) for (let dx = -t.r; dx <= t.r; dx++) for (const c of this.creaturesAt(x + dx, y + dy)) heal(this, c, roll(t.heal));
        if (t.heal) for (const p of this.players()) if (p.downed && cheb(p.x, p.y, x, y) <= t.r) heal(this, p, roll(t.heal));
      } else {
        const c = this.creaturesAt(x, y)[0];
        if (c) dealDamage(this, c, roll(def.throwDmg || [1, 1]), 'physical', e);
        for (const o of this.objectsAt(x, y)) if (OBJECTS[o.type]?.destructible) damageObject(this, o, roll(def.throwDmg || [1, 1]), 'physical');
        const [px, py] = walkable(this.map, this.index, x, y) ? [x, y] : [e.x, e.y];
        this.dropItems(px, py, [item]);
      }
    });
  }

  // ---------- action dispatch ----------
  handleAction(pid, a) {
    const pl = this.state.players[pid];
    if (!pl || !a || typeof a !== 'object') return;
    const e = this.ent(pl.eid);
    if (!e) return;
    try { this.act(pid, e, a); }
    catch (err) { console.error(err); this.tell(pid, 'Error: ' + err.message); }
    if (this.pendingAggro.size) { const ids = [...this.pendingAggro]; this.pendingAggro.clear(); this.startCombat(ids); }
    this.checkCombatEnd();
  }
  act(pid, e, a) {
    switch (a.type) {
      case 'chat': {
        const text = String(a.text || '').slice(0, 200).trim();
        if (text) this.log(`${e.name}: ${text}`, 'chat');
        return;
      }
      case 'allocate':
        if (e.pts > 0 && ATTRS[a.attr]) {
          e.attrs[a.attr]++; e.pts--;
          const m = maxHp(e);
          e.hp += m - e.maxHp; e.maxHp = m;
        }
        return;
      case 'swap': {
        const i = +a.from, j = +a.to;
        if (e.inv[i] && j >= 0 && j < e.inv.length) [e.inv[i], e.inv[j]] = [e.inv[j], e.inv[i]];
        return;
      }
      case 'ping': this.fx({ type: 'ping', x: a.x, y: a.y, c: e.color }); return;
    }
    if (e.downed) return this.tell(pid, 'You are down! An ally can revive you with a healing potion or Mend.');
    const r = this.rtOf(e.id);
    const combat = this.inCombat(e);
    if (combat) {
      if (this.state.combat.active !== e.id) return this.tell(pid, "It's not your turn.");
      if (r.path.length) return this.tell(pid, 'Wait until you finish moving.');
      if (e.st.frozen || e.st.stunned) return;
    }
    switch (a.type) {
      case 'move': return this.cmdMove(pid, e, a);
      case 'attack': return this.attack(pid, e, this.ent(a.target), a);
      case 'skill': return this.cmdSkill(pid, e, a);
      case 'throw': return this.cmdThrow(pid, e, a);
      case 'use': {
        const s = stackAt(e, a.ref);
        if (!s || !ITEMS[s.id].use) return this.tell(pid, "That can't be used like that.");
        if (!this.spendAp(pid, e, 1)) return;
        useConsumable(this, e, s);
        return;
      }
      case 'apply': {
        const s = stackAt(e, a.ref);
        if (!s) return;
        const t = a.target ? this.ent(a.target) : null;
        const x = t ? t.x : a.x, y = t ? t.y : a.y;
        const rules = applyRulesFor(this.state, this.map, e, s, t, x, y);
        const rule = a.rule ? rules.find((q) => q.id === a.rule) : rules[0];
        if (!rule) return this.tell(pid, `Using ${ITEMS[s.id].n} there does nothing.`);
        if (!this.approach(pid, e, a, x, y, 1, 1)) return;
        if (!this.spendAp(pid, e, 1)) return;
        const msg = rule.run(this, makeCtx(this.state, this.map, e, s, t, x, y));
        if (msg) this.log(msg);
        return;
      }
      case 'interact': {
        const t = this.ent(a.target);
        if (!t) return;
        const opts = defaultOptions(this.state, e, t);
        const opt = a.opt || opts[0]?.id;
        if (!opt) return this.tell(pid, 'Nothing to do here.');
        if (opt === 'attack') return this.attack(pid, e, t, a);
        if (opt === 'smash' && combat) return this.attack(pid, e, t, a);
        if (!this.approach(pid, e, a, t.x, t.y, 1, opt === 'open' || opt === 'gather' ? 1 : 0)) return;
        return runDefault(this, pid, e, t, opt);
      }
      case 'combine': return doCombine(this, pid, e, (a.refs || []).slice(0, 3));
      case 'craft': return craftRecipe(this, pid, e, a.recipe);
      case 'equip': return this.cmdEquip(pid, e, a);
      case 'unequip': {
        const s = e.eq[a.slot];
        if (!s) return;
        if (!this.spendAp(pid, e, 1)) return;
        e.eq[a.slot] = null;
        if (addItem(e, s.id, 1, s.d)) this.dropItems(e.x, e.y, [s]);
        return;
      }
      case 'drop': {
        const it = takeFromSlot(e, +a.ref, a.all ? 9999 : 1);
        if (it) { this.dropItems(e.x, e.y, [it]); }
        return;
      }
      case 'take': return this.cmdTake(pid, e, a);
      case 'give': {
        const t = this.ent(a.to);
        if (!t || t.kind !== 'player' || t === e) return;
        if (cheb(e.x, e.y, t.x, t.y) > 6) return this.tell(pid, 'Too far away to hand that over.');
        const it = takeFromSlot(e, +a.ref, 9999);
        if (!it) return;
        const left = addItem(t, it.id, it.q, it.d);
        if (left) this.dropItems(t.x, t.y, [{ ...it, q: left }]);
        this.log(`${e.name} gives ${it.q > 1 ? it.q + '× ' : ''}${itemName(it)} to ${t.name}.`);
        return;
      }
      case 'buy': {
        const npc = this.ent(a.npc);
        if (!npc || cheb(npc.x, npc.y, e.x, e.y) > 2) return this.tell(pid, 'Get closer to the merchant.');
        const entry = SHOP.find(([id]) => id === a.id);
        if (!entry) return;
        const q = clamp(+a.q || 1, 1, 20), cost = entry[1] * q;
        if (!this.payGold(e, cost)) return this.tell(pid, `Not enough gold (${cost}).`);
        if (addItem(e, a.id, q)) this.dropItems(e.x, e.y, [{ id: a.id, q }]);
        this.log(`${e.name} buys ${q > 1 ? q + '× ' : ''}${ITEMS[a.id].n}.`);
        return;
      }
      case 'sell': {
        const npc = this.ent(a.npc);
        if (!npc || cheb(npc.x, npc.y, e.x, e.y) > 2) return this.tell(pid, 'Get closer to the merchant.');
        const s = e.inv[+a.ref];
        if (!s || s.id === 'gold') return;
        const it = takeFromSlot(e, +a.ref, a.all ? 9999 : 1);
        addItem(e, 'gold', sellPrice(it.id) * it.q);
        return;
      }
      case 'endTurn': if (combat) this.endTurn(e.id); return;
      case 'stop': r.path = []; r.queued = null; return;
    }
  }
  payGold(e, n) {
    const have = e.inv.reduce((a, s) => a + (s.id === 'gold' ? s.q : 0), 0);
    if (have < n) return false;
    let left = n;
    for (const s of e.inv) if (s.id === 'gold' && left) { const k = Math.min(s.q, left); s.q -= k; left -= k; }
    e.inv = e.inv.filter((s) => s.q > 0);
    return true;
  }
  cmdMove(pid, e, a) {
    const { x, y } = a;
    if (!walkable(this.map, this.index, x, y)) return this.tell(pid, "Can't walk there.");
    const combat = this.inCombat(e);
    let path = findPath(this.map, this.index, e.x, e.y, x, y, { blockCreatures: combat ? this.creatureKeys(e) : null, maxNodes: combat ? 3000 : 12000 });
    if (!path) return this.tell(pid, 'No path.');
    if (combat) {
      const maxTiles = e.mp + e.ap * moveRange(e);
      path = path.slice(0, maxTiles);
      if (!path.length) return this.tell(pid, 'Not enough AP to move.');
      this.payMove(e, path.length);
    }
    this.startPath(e, path, null);
  }
  cmdEquip(pid, e, a) {
    const s = e.inv[+a.ref];
    if (!s) return;
    const def = ITEMS[s.id];
    if (!def.slot) return this.tell(pid, "That can't be equipped.");
    if (!this.spendAp(pid, e, 1)) return;
    const item = takeFromSlot(e, +a.ref, 1);
    const back = [];
    if (e.eq[def.slot]) back.push(e.eq[def.slot]);
    if (def.slot === 'weapon' && def.weapon.twoHanded && e.eq.offhand) { back.push(e.eq.offhand); e.eq.offhand = null; }
    if (def.slot === 'offhand' && e.eq.weapon && ITEMS[e.eq.weapon.id].weapon.twoHanded) { back.push(e.eq.weapon); e.eq.weapon = null; }
    e.eq[def.slot] = item;
    for (const b of back) if (addItem(e, b.id, b.q, b.d)) this.dropItems(e.x, e.y, [b]);
  }
  cmdTake(pid, e, a) {
    const t = this.ent(a.from);
    if (!t || !t.items) return;
    if (cheb(t.x, t.y, e.x, e.y) > 1) return this.tell(pid, 'Too far away.');
    if (t.locked) return;
    const idxs = a.all ? t.items.map((_, i) => i) : [+a.idx];
    for (const i of idxs) {
      const it = t.items[i];
      if (!it) continue;
      const left = addItem(e, it.id, it.q, it.d);
      it.q = left;
      if (left) this.tell(pid, 'Your bags are full.');
    }
    t.items = t.items.filter((s) => s.q > 0);
    if (t.type === 'pile' && !t.items.length) this.removeEnt(t.id);
  }

  // ---------- main loop ----------
  tick(now = performance.now()) {
    // timers
    if (this.timers.length) {
      const due = this.timers.filter((t) => t.at <= now);
      this.timers = this.timers.filter((t) => t.at > now);
      for (const t of due) { try { t.fn(); } catch (err) { console.error(err); } }
    }
    // movement
    for (const [id, r] of this.rt) {
      if (!r.path.length || now < r.next) continue;
      const e = this.ent(id);
      if (!e || e.dead || e.downed || e.st.frozen || e.st.stunned) { r.path = []; r.queued = null; continue; }
      const [nx, ny] = r.path[0];
      const combat = this.inCombat(e);
      const occ = this.index.creatures.get(this.map.idx(nx, ny));
      if (!walkable(this.map, this.index, nx, ny) || (combat && occ && occ !== e)) { r.path = []; r.queued = null; continue; }
      const px = e.x, py = e.y;
      this.place(e, nx, ny);
      r.path.shift();
      r.next = now + (combat ? 170 : 135);
      const trail = e.kind === 'enemy' && ENEMIES[e.type].trail;
      if (trail && combat) applyElement(this, px, py, trail);
      surfaceEffect(this, e, 'enter');
      if (!r.path.length && r.queued) {
        const q = r.queued; r.queued = null;
        if (q.pid) this.handleAction(q.pid, q.a);
      }
    }
    // AI turn
    const c = this.state.combat;
    if (c) {
      const a = this.ent(c.active);
      if (a && a.kind === 'enemy' && !a.dead) {
        const r = this.rtOf(a.id);
        if (!r.path.length && !r.waitEnd && now >= r.aiNext) {
          let delay = null;
          try { delay = aiStep(this, a); } catch (err) { console.error(err); }
          if (delay == null) { r.waitEnd = true; this.later(250, () => this.endTurn(a.id)); }
          else r.aiNext = now + delay;
        }
      }
    }
    // aggro: enemies notice players
    {
      const ps = this.players().filter((p) => !p.downed && p.online);
      for (const e of Object.values(this.state.entities)) {
        if (e.kind !== 'enemy' || e.dead || this.inCombat(e)) continue;
        const range = ENEMIES[e.type].aggro || 5;
        for (const p of ps) if (cheb(p.x, p.y, e.x, e.y) <= range && los(this.map, this.index, e.x, e.y, p.x, p.y)) { this.pendingAggro.add(e.id); break; }
      }
    }
    if (this.pendingAggro.size) { const ids = [...this.pendingAggro]; this.pendingAggro.clear(); this.startCombat(ids); }
    // real-time rounds outside combat
    if (!this.state.combat && now - this.lastRound > ROUND_MS) {
      this.lastRound = now;
      this.realtimeRound();
    }
    // idle wandering
    if (now - this.lastWander > 1500) {
      this.lastWander = now;
      for (const e of Object.values(this.state.entities)) {
        if (e.kind !== 'enemy' || e.dead || this.inCombat(e) || !chance(0.2)) continue;
        const r = this.rtOf(e.id);
        if (r.path.length) continue;
        const tx = e.hx + ri(-3, 3), ty = e.hy + ri(-3, 3);
        if (!walkable(this.map, this.index, tx, ty)) continue;
        const p = findPath(this.map, this.index, e.x, e.y, tx, ty, { maxNodes: 200 });
        if (p && p.length <= 6) this.startPath(e, p, null);
      }
    }
    if (this.state.combat) this.checkCombatEnd();
  }
  realtimeRound() {
    this.state.round++;
    this.state.time += 10;
    for (const e of Object.values(this.state.entities)) {
      if (!isCreature(e) || e.dead || e.kind === 'npc') continue;
      if (e.kind === 'player' && e.downed) { e.downed = false; e.hp = 1; this.log(`${e.name} comes to.`); continue; }
      if (Object.keys(e.st).length) tickStatuses(this, e);
      if (!e.dead && !e.downed) surfaceEffect(this, e, 'turn');
      for (const sk of e.skills || []) if (sk.cd > 0) sk.cd--;
      if (e.kind === 'enemy' && !e.dead && e.hp < e.maxHp) e.hp = Math.min(e.maxHp, e.hp + 2);
      if (e.kind === 'player' && !e.downed && e.hp < e.maxHp && !e.st.burning && !e.st.poisoned) e.hp = Math.min(e.maxHp, e.hp + 1);
    }
    tickSurfaces(this);
    if (this.pendingAggro.size) { const ids = [...this.pendingAggro]; this.pendingAggro.clear(); this.startCombat(ids); }
  }
  /** Drain outbound queues (for the network layer). */
  drain() {
    const out = { log: this.outLog, fx: this.outFx, priv: this.outPriv };
    this.outLog = []; this.outFx = []; this.outPriv = [];
    return out;
  }
}
export { elementHit };
