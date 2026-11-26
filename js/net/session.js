// Host & client sessions: host-authoritative state replication via per-entity JSON diffs.
import { Emitter } from '../util.js';
import { WorldMap, encodeTiles, decodeTiles, buildIndex } from '../sim/map.js';

export const PROTOCOL = 3;
export const HOST_PID = 'host';
const HEARTBEAT_TIMEOUT = 10000;

const globalsOf = (s) => ({ combat: s.combat, players: s.players, recipes: s.recipes, round: s.round, spawn: s.spawn, seed: s.seed, time: s.time, level: s.level, levelInfo: s.levelInfo, activated: s.activated, victory: s.victory });

export class HostSession extends Emitter {
  constructor(game) {
    super();
    this.game = game;
    this.conns = new Map(); // pid -> Channel
    this.transports = [];
    this.cache = { e: new Map(), s: new Map(), g: '' };
    this.cacheStale = true;
    this.nextPid = 1;
    game.events.on('priv', ({ pid, msg }) => { if (pid === HOST_PID) this.emit('priv', msg); });
    // a new level means a new map: resend the world to everyone
    game.events.on('level', () => {
      const S = this.game.state;
      const msg = { t: 'level', W: this.game.map.W, H: this.game.map.H, tiles: encodeTiles(Array.from(this.game.map.tiles)), snap: { e: S.entities, s: S.surfaces, g: globalsOf(S) } };
      for (const ch of this.conns.values()) ch.send(msg);
      this.rebaseCache();
      this.emit('level');
    });
    // heartbeat: detect peers that vanished without saying goodbye
    this.hb = setInterval(() => {
      const now = Date.now();
      for (const ch of this.conns.values()) {
        if (now - ch.lastSeen > HEARTBEAT_TIMEOUT) ch.close();
        else ch.send({ t: 'ping' });
      }
    }, 2000);
  }
  attach(transport) {
    this.transports.push(transport);
    transport.on('conn', (ch) => this.onConn(ch));
  }
  onConn(ch) {
    ch.lastSeen = Date.now();
    ch.on('msg', (m) => { ch.lastSeen = Date.now(); this.onMsg(ch, m); });
    ch.on('close', () => {
      if (ch.pid) { this.game.removePlayer(ch.pid); this.conns.delete(ch.pid); this.flush(); this.emit('players'); }
    });
  }
  onMsg(ch, m) {
    if (m.t === 'hello') {
      if (ch.pid) return;
      if (m.v !== PROTOCOL) { ch.send({ t: 'reject', reason: 'Version mismatch — refresh both browsers.' }); return; }
      const pid = 'p' + this.nextPid++ + Math.random().toString(36).slice(2, 5);
      const r = this.game.addPlayer(pid, m.char || {});
      if (r.error) { ch.send({ t: 'reject', reason: r.error }); setTimeout(() => ch.close(), 800); return; }
      this.flush(); // bring everyone else up to date, then rebase cache on current state
      ch.pid = pid;
      this.conns.set(pid, ch);
      const S = this.game.state;
      ch.send({ t: 'welcome', pid, eid: r.eid, W: this.game.map.W, H: this.game.map.H, tiles: encodeTiles(Array.from(this.game.map.tiles)),
        snap: { e: S.entities, s: S.surfaces, g: globalsOf(S) } });
      this.rebaseCache();
      this.emit('players');
    } else if (m.t === 'act' && ch.pid) {
      this.game.handleAction(ch.pid, m.a);
      this.flush();
    }
  }
  rebaseCache() {
    const S = this.game.state;
    this.cache.e = new Map(Object.entries(S.entities).map(([id, e]) => [id, JSON.stringify(e)]));
    this.cache.s = new Map(Object.entries(S.surfaces).map(([k, s]) => [k, JSON.stringify(s)]));
    this.cache.g = JSON.stringify(globalsOf(S));
    this.cacheStale = false;
  }
  diff() {
    const S = this.game.state, c = this.cache;
    let any = false;
    const E = {}, Sf = {};
    for (const id in S.entities) {
      const s = JSON.stringify(S.entities[id]);
      if (c.e.get(id) !== s) { c.e.set(id, s); E[id] = S.entities[id]; any = true; }
    }
    for (const id of c.e.keys()) if (!(id in S.entities)) { c.e.delete(id); E[id] = null; any = true; }
    for (const k in S.surfaces) {
      const s = JSON.stringify(S.surfaces[k]);
      if (c.s.get(k) !== s) { c.s.set(k, s); Sf[k] = S.surfaces[k]; any = true; }
    }
    for (const k of c.s.keys()) if (!(k in S.surfaces)) { c.s.delete(k); Sf[k] = null; any = true; }
    const g = JSON.stringify(globalsOf(S));
    let G;
    if (g !== c.g) { c.g = g; G = globalsOf(S); any = true; }
    return any ? { e: E, s: Sf, g: G } : null;
  }
  /** Send pending state changes, logs, effects and private messages. */
  flush() {
    const out = this.game.drain();
    if (this.conns.size) {
      if (this.cacheStale) this.rebaseCache();
      const d = this.diff();
      if (d || out.log.length || out.fx.length) {
        const msg = { t: 'snap', d, log: out.log, fx: out.fx };
        for (const ch of this.conns.values()) ch.send(msg);
      }
    } else this.cacheStale = true;
    for (const { pid, msg } of out.priv) if (pid !== HOST_PID) this.conns.get(pid)?.send({ t: 'priv', msg });
    this.emit('state');
  }
  step() {
    this.game.tick();
    this.flush();
  }
  kick(pid) { this.conns.get(pid)?.close(); }
}

export class ClientSession extends Emitter {
  constructor(ch) {
    super();
    this.ch = ch;
    this.state = null;
    this.lastSeen = Date.now();
    ch.on('msg', (m) => { this.lastSeen = Date.now(); this.onMsg(m); });
    ch.on('close', () => { clearInterval(this.hb); if (!this.rejected) this.emit('disconnected'); });
    this.hb = setInterval(() => { if (Date.now() - this.lastSeen > HEARTBEAT_TIMEOUT) ch.close(); }, 2000);
  }
  hello(char) { this.ch.send({ t: 'hello', v: PROTOCOL, char }); }
  send(a) { this.ch.send({ t: 'act', a }); }
  get index() {
    if (this._dirty) { this._index = buildIndex(this.state, this.map); this._dirty = false; }
    return this._index;
  }
  onMsg(m) {
    switch (m.t) {
      case 'level':
        if (!this.state) return;
        this.map = new WorldMap(m.W, m.H, decodeTiles(m.tiles));
        this.state = { entities: m.snap.e, surfaces: m.snap.s, ...m.snap.g };
        this._dirty = true;
        this.emit('level');
        this.emit('state');
        break;
      case 'welcome':
        this.pid = m.pid;
        this.myEid = m.eid;
        this.map = new WorldMap(m.W, m.H, decodeTiles(m.tiles));
        this.state = { entities: m.snap.e, surfaces: m.snap.s, ...m.snap.g };
        this._dirty = true;
        this.emit('welcome');
        this.emit('state');
        break;
      case 'snap': {
        if (!this.state) return;
        const d = m.d;
        if (d) {
          for (const id in d.e) { if (d.e[id]) this.state.entities[id] = d.e[id]; else delete this.state.entities[id]; }
          for (const k in d.s) { if (d.s[k]) this.state.surfaces[k] = d.s[k]; else delete this.state.surfaces[k]; }
          if (d.g) Object.assign(this.state, d.g);
          this._dirty = true;
        }
        for (const l of m.log || []) this.emit('log', l);
        for (const f of m.fx || []) this.emit('fx', f);
        if (d) this.emit('state');
        break;
      }
      case 'priv': this.emit('priv', m.msg); break;
      case 'reject': this.rejected = true; this.emit('reject', m.reason); break;
      case 'ping': this.ch.send({ t: 'pong' }); break;
    }
  }
}
