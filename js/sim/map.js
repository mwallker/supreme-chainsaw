// Grid map, spatial index, pathfinding and line of sight. Shared by host and clients.
import { T, TILES } from '../data/tiles.js';
import { OBJECTS } from '../data/objects.js';

export class WorldMap {
  constructor(W, H, tiles) {
    this.W = W; this.H = H; this.tiles = tiles;
  }
  idx(x, y) { return x + y * this.W; }
  inb(x, y) { return x >= 0 && y >= 0 && x < this.W && y < this.H; }
  tile(x, y) { return this.inb(x, y) ? this.tiles[x + y * this.W] : T.MOUNTAIN; }
  tilePass(x, y) { return this.inb(x, y) && TILES[this.tiles[x + y * this.W]].pass; }
  tileSight(x, y) { return !this.inb(x, y) || !!TILES[this.tiles[x + y * this.W]].sight; }
}

export const encodeTiles = (t) => String.fromCharCode(...t.map((v) => 48 + v));
export function decodeTiles(s) {
  const t = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) t[i] = s.charCodeAt(i) - 48;
  return t;
}

export const isCreature = (e) => e.kind === 'player' || e.kind === 'enemy' || e.kind === 'npc';
export const isAlive = (e) => isCreature(e) && !e.dead && !e.downed;

/** Builds lookups: entities per tile, tiles blocked by objects, tiles blocking sight, tiles held by living creatures. */
export function buildIndex(state, map) {
  const at = new Map(), blockers = new Set(), sight = new Set(), creatures = new Map();
  for (const e of Object.values(state.entities)) {
    const k = map.idx(e.x, e.y);
    let a = at.get(k);
    if (!a) at.set(k, (a = []));
    a.push(e);
    if (e.kind === 'object') {
      const d = OBJECTS[e.type];
      if (d?.block) blockers.add(k);
      if (d?.sight) sight.add(k);
    } else if (e.kind === 'npc') blockers.add(k);
    else if (isCreature(e) && !e.dead && !e.downed) creatures.set(k, e);
  }
  return { at, blockers, sight, creatures };
}

export function walkable(map, index, x, y) {
  return map.tilePass(x, y) && !index.blockers.has(map.idx(x, y));
}

export function los(map, index, x0, y0, x1, y1) {
  let dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1, err = dx + dy;
  let x = x0, y = y0;
  for (;;) {
    if (x === x1 && y === y1) return true;
    if (!(x === x0 && y === y0)) {
      if (map.tileSight(x, y) || index.sight.has(map.idx(x, y))) return false;
    }
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x += sx; }
    if (e2 <= dx) { err += dx; y += sy; }
  }
}

// Binary heap keyed by f
class Heap {
  constructor() { this.a = []; }
  push(n) { const a = this.a; a.push(n); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (a[p].f <= a[i].f) break; [a[p], a[i]] = [a[i], a[p]]; i = p; } }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last; let i = 0;
      for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < a.length && a[l].f < a[m].f) m = l; if (r < a.length && a[r].f < a[m].f) m = r; if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m; }
    }
    return top;
  }
  get size() { return this.a.length; }
}

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

/**
 * A* on 8-connected grid. Returns list of [x,y] steps (excluding start) or null.
 * opts.range: stop when Chebyshev distance to target <= range (target tile may be blocked)
 * opts.blockCreatures: Set/Map of tile keys occupied by creatures (ignored: self tile)
 * opts.cost(x,y): extra cost for a tile (AI hazard avoidance)
 * opts.needLos: goal tile must have LOS to target
 */
export function findPath(map, index, sx, sy, tx, ty, opts = {}) {
  const range = opts.range || 0;
  const maxNodes = opts.maxNodes || 6000;
  const W = map.W;
  const goal = (x, y) => Math.max(Math.abs(x - tx), Math.abs(y - ty)) <= range && (!opts.needLos || los(map, index, x, y, tx, ty));
  if (goal(sx, sy)) return [];
  const blockC = opts.blockCreatures;
  const passable = (x, y) => {
    if (!map.tilePass(x, y)) return false;
    const k = x + y * W;
    if (index.blockers.has(k)) return false;
    if (blockC && blockC.has(k)) return false;
    return true;
  };
  const h = (x, y) => Math.max(0, Math.max(Math.abs(x - tx), Math.abs(y - ty)) - range);
  const start = sx + sy * W;
  const g = new Map([[start, 0]]), came = new Map();
  const open = new Heap();
  open.push({ k: start, x: sx, y: sy, f: h(sx, sy) });
  let n = 0;
  while (open.size && n++ < maxNodes) {
    const cur = open.pop();
    if (goal(cur.x, cur.y)) {
      const path = [];
      let k = cur.k;
      while (k !== start) { path.push([k % W, (k / W) | 0]); k = came.get(k); }
      return path.reverse();
    }
    const gc = g.get(cur.k);
    for (const [dx, dy] of DIRS) {
      const nx = cur.x + dx, ny = cur.y + dy;
      if (!passable(nx, ny)) continue;
      if (dx && dy && (!passable(cur.x + dx, cur.y) || !passable(cur.x, cur.y + dy))) continue; // no corner cutting
      const nk = nx + ny * W;
      const ng = gc + (dx && dy ? 1.0001 : 1) + (opts.cost ? opts.cost(nx, ny) : 0);
      if (ng < (g.get(nk) ?? Infinity)) {
        g.set(nk, ng); came.set(nk, cur.k);
        open.push({ k: nk, x: nx, y: ny, f: ng + h(nx, ny) });
      }
    }
  }
  return null;
}
