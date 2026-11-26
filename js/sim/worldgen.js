// Procedural world: terrain from noise, a central village, roads, resources and enemy camps.
import { mulberry32, fbm } from '../rng.js';
import { T, TILES } from '../data/tiles.js';
import { OBJECTS } from '../data/objects.js';
import { makeEnemy } from './entities.js';

export const WORLD_W = 112, WORLD_H = 112;

export function generateWorld(seed) {
  const W = WORLD_W, H = WORLD_H;
  const rng = mulberry32(seed);
  const R = () => rng();
  const RI = (a, b) => a + Math.floor(R() * (b - a + 1));
  const tiles = new Uint8Array(W * H);
  const cx = W >> 1, cy = H >> 1;
  const idx = (x, y) => x + y * W;

  // --- terrain from quantiles of height noise
  const hs = new Float32Array(W * H), ms = new Float32Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      hs[idx(x, y)] = fbm(x / 20, y / 20, seed, 4);
      ms[idx(x, y)] = fbm(x / 16 + 50, y / 16 + 50, seed + 777, 3);
    }
  const sorted = Array.from(hs).sort((a, b) => a - b);
  const q = (p) => sorted[Math.floor(p * (sorted.length - 1))];
  const tDeep = q(0.09), tShallow = q(0.14), tSand = q(0.18), tRocky = q(0.83), tMount = q(0.92);
  const msorted = Array.from(ms).sort((a, b) => a - b);
  const tForest = msorted[Math.floor(0.55 * msorted.length)];

  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = idx(x, y);
      const edge = Math.min(x, y, W - 1 - x, H - 1 - y);
      if (edge < 3) { tiles[i] = T.MOUNTAIN; continue; }
      let h = hs[i];
      const vd = Math.hypot(x - cx, y - cy);
      if (vd < 15) { const f = Math.min(1, (15 - vd) / 6); h = h * (1 - f) + (tSand + tRocky) * 0.5 * f; }
      if (edge < 6) h = Math.max(h, tRocky + (6 - edge) * 0.02);
      let t;
      if (h < tDeep) t = T.DEEP;
      else if (h < tShallow) t = T.SHALLOW;
      else if (h < tSand) t = T.SAND;
      else if (h > tMount) t = T.MOUNTAIN;
      else if (h > tRocky) t = T.ROCKY;
      else t = ms[i] > tForest ? T.FOREST : T.GRASS;
      tiles[i] = t;
    }

  // --- roads: wiggly paths from village to 4 directions
  const road = new Set();
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (const [dx, dy] of dirs) {
    let x = cx, y = cy;
    let len = 0;
    while (len++ < 70) {
      x += dx; y += dy;
      if (R() < 0.3) { if (dx) y += R() < 0.5 ? -1 : 1; else x += R() < 0.5 ? -1 : 1; }
      if (Math.min(x, y, W - 1 - x, H - 1 - y) < 5) break;
      for (const [ox, oy] of [[0, 0], [dy ? 1 : 0, dx ? 1 : 0]]) {
        const rx = x + ox, ry = y + oy, i = idx(rx, ry);
        const cur = tiles[i];
        tiles[i] = cur === T.DEEP || cur === T.SHALLOW ? T.FLOOR : T.DIRT; // bridges over water
        road.add(i);
      }
    }
  }

  // --- village
  for (let y = cy - 12; y <= cy + 12; y++)
    for (let x = cx - 12; x <= cx + 12; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d <= 11) tiles[idx(x, y)] = d <= 3.5 ? T.DIRT : T.GRASS;
    }
  const house = (x0, y0, w, h, door) => {
    for (let y = y0; y < y0 + h; y++)
      for (let x = x0; x < x0 + w; x++) {
        const wall = x === x0 || y === y0 || x === x0 + w - 1 || y === y0 + h - 1;
        tiles[idx(x, y)] = wall ? T.WALL : T.FLOOR;
      }
    tiles[idx(door[0], door[1])] = T.FLOOR;
  };
  house(cx - 10, cy - 9, 6, 5, [cx - 7, cy - 5]);
  house(cx + 4, cy - 10, 7, 5, [cx + 7, cy - 6]);
  house(cx - 10, cy + 5, 6, 5, [cx - 7, cy + 5]);

  const entities = [];
  const occupied = new Set();
  const obj = (type, x, y, extra = {}) => {
    const e = { kind: 'object', type, x, y, ...extra };
    entities.push(e);
    occupied.add(idx(x, y));
    return e;
  };

  obj('campfire', cx, cy, { lit: true });
  obj('well', cx - 4, cy + 2);
  obj('workbench', cx + 5, cy + 4);
  obj('forge', cx + 7, cy + 4, { lit: false });
  obj('alchemy', cx - 4, cy - 2);
  obj('barrel', cx + 8, cy + 6, { liquid: 'oil', hp: 6, uses: 6 });
  obj('barrel', cx - 5, cy + 3, { liquid: 'water', hp: 6, uses: 6 });
  obj('chest', cx - 2, cy - 3, { name: 'Village Supply Chest', items: [
    { id: 'iron_axe', q: 1 }, { id: 'pickaxe', q: 1 }, { id: 'hammer', q: 1 }, { id: 'dagger', q: 1 },
    { id: 'mortar', q: 1 }, { id: 'empty_flask', q: 4 }, { id: 'cloth', q: 3 }, { id: 'stick', q: 4 }] });
  obj('chest', cx - 8, cy - 7, { items: [{ id: 'healing_potion', q: 2 }, { id: 'string', q: 3 }, { id: 'feather', q: 4 }, { id: 'gold', q: 10 }] });
  obj('chest', cx + 8, cy - 8, { items: [{ id: 'flask_oil', q: 2 }, { id: 'flint', q: 3 }, { id: 'leather', q: 2 }] });
  obj('crate', cx - 8, cy + 7, { hp: 8, items: [{ id: 'wood', q: 3 }, { id: 'raw_meat', q: 2 }] });
  obj('crate', cx - 7, cy + 7, { hp: 8, items: [{ id: 'stone', q: 3 }, { id: 'healroot', q: 2 }] });
  entities.push({ kind: 'npc', type: 'merchant', name: 'Merrin the Trader', x: cx + 2, y: cy - 2 });
  occupied.add(idx(cx + 2, cy - 2));

  // --- resources
  const nearWater = (x, y) => {
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const t = tiles[idx(x + dx, y + dy)]; if (t === T.SHALLOW || t === T.DEEP) return true; }
    return false;
  };
  for (let y = 4; y < H - 4; y++)
    for (let x = 4; x < W - 4; x++) {
      const i = idx(x, y);
      if (road.has(i) || occupied.has(i) || Math.hypot(x - cx, y - cy) < 12.5) continue;
      const t = tiles[i], r = R();
      if (t === T.FOREST) {
        if (r < 0.3) obj('tree', x, y);
        else if (r < 0.335) obj('bush', x, y, { herb: R() < 0.45 ? 'stormcap' : R() < 0.7 ? 'nightshade' : 'healroot' });
      } else if (t === T.GRASS) {
        if (nearWater(x, y) && r < 0.05) obj('bush', x, y, { herb: 'frostleaf' });
        else if (r < 0.05) obj('tree', x, y);
        else if (r < 0.075) obj('bush', x, y, { herb: R() < 0.7 ? 'healroot' : 'nightshade' });
        else if (r < 0.083) obj('rock', x, y, { uses: 3 });
      } else if (t === T.ROCKY) {
        if (r < 0.09) obj('rock', x, y, { uses: 3 });
        else if (r < 0.125) obj('ore', x, y, { uses: 3 });
        else if (r < 0.145) obj('sulfur_rock', x, y, { uses: 3 });
        else if (r < 0.16) obj('bush', x, y, { herb: 'emberroot' });
      } else if (t === T.SAND) {
        if (r < 0.03) obj('rock', x, y, { uses: 3, flinty: true });
        else if (r < 0.07) obj('bush', x, y, { herb: nearWater(x, y) ? 'frostleaf' : 'emberroot' });
      }
    }

  // --- reachability from village (objects block)
  const blocked = new Set(entities.filter((e) => e.kind === 'npc' || OBJECTS[e.type]?.block).map((e) => idx(e.x, e.y)));
  const reach = new Uint8Array(W * H);
  const qq = [idx(cx, cy + 1)];
  reach[qq[0]] = 1;
  while (qq.length) {
    const k = qq.pop(), x = k % W, y = (k / W) | 0;
    for (const [dx, dy] of dirs) {
      const nx = x + dx, ny = y + dy, nk = idx(nx, ny);
      if (reach[nk] || !TILES[tiles[nk]].pass || blocked.has(nk)) continue;
      reach[nk] = 1; qq.push(nk);
    }
  }

  // --- enemy camps
  const camps = [];
  const typesNear = ['wolves', 'slimes', 'wolves', 'slimes'];
  const typesMid = ['bandits', 'imps', 'bandits', 'cultists', 'imps'];
  const typesFar = ['warlord', 'undead', 'wisps', 'undead', 'cultists'];
  let tries = 0;
  while (camps.length < 13 && tries++ < 4000) {
    const x = RI(8, W - 9), y = RI(8, H - 9);
    const d = Math.hypot(x - cx, y - cy);
    if (d < 18 || !reach[idx(x, y)] || road.has(idx(x, y))) continue;
    if (camps.some((c) => Math.hypot(c.x - x, c.y - y) < 15)) continue;
    let type;
    if (d < 30) type = typesNear.shift() || 'wolves';
    else if (d < 42) type = typesMid.shift() || 'bandits';
    else type = typesFar.shift() || 'undead';
    camps.push({ x, y, type, d });
  }
  // clear camp areas
  const clearR = 3.2;
  for (let i = entities.length - 1; i >= 0; i--) {
    const e = entities[i];
    if (camps.some((c) => Math.hypot(c.x - e.x, c.y - e.y) <= clearR)) entities.splice(i, 1);
  }
  let grp = 0;
  const near = (c, r = 2) => {
    for (let t = 0; t < 30; t++) {
      const x = c.x + RI(-r, r), y = c.y + RI(-r, r);
      const i = idx(x, y);
      if (!TILES[tiles[i]].pass || entities.some((e) => e.x === x && e.y === y)) continue;
      return [x, y];
    }
    return null;
  };
  const spawn = (c, type, extra) => { const p = near(c); if (p) entities.push(makeEnemy(type, p[0], p[1], 'g' + grp, extra)); };
  const prop = (c, type, extra, r = 3) => { const p = near(c, r); if (p) obj(type, p[0], p[1], extra); };
  for (const c of camps) {
    grp++;
    switch (c.type) {
      case 'wolves': for (let i = 0; i < 3; i++) spawn(c, 'wolf'); break;
      case 'slimes': {
        // a little bog
        for (let y = c.y - 2; y <= c.y + 2; y++)
          for (let x = c.x - 2; x <= c.x + 2; x++)
            if (Math.hypot(x - c.x, y - c.y) < 2.4 && tiles[idx(x, y)] !== T.WALL && R() < 0.85) tiles[idx(x, y)] = T.SHALLOW;
        for (let i = 0; i < 3; i++) spawn(c, 'slime');
        prop(c, 'barrel', { liquid: 'poison', hp: 6, uses: 6 });
        break;
      }
      case 'bandits':
        obj('campfire', c.x, c.y, { lit: true });
        spawn(c, 'bandit'); spawn(c, 'bandit'); spawn(c, 'bandit_archer');
        prop(c, 'barrel', { liquid: 'oil', hp: 6, uses: 6 }); prop(c, 'barrel', { liquid: 'oil', hp: 6, uses: 6 });
        prop(c, 'chest', { items: [{ id: 'gold', q: RI(8, 20) }, { id: 'flask_oil', q: 2 }, { id: 'cloth', q: 2 }, { id: 'iron_ingot', q: 1 }] });
        break;
      case 'imps':
        spawn(c, 'fire_imp'); spawn(c, 'fire_imp');
        prop(c, 'barrel', { liquid: 'oil', hp: 6, uses: 6 }); prop(c, 'barrel', { liquid: 'powder', hp: 4 });
        prop(c, 'crate', { hp: 8, items: [{ id: 'sulfur', q: 2 }, { id: 'charcoal', q: 2 }, { id: 'emberroot', q: 1 }] });
        break;
      case 'cultists':
        spawn(c, 'storm_cultist'); spawn(c, 'storm_cultist'); spawn(c, 'bandit');
        prop(c, 'barrel', { liquid: 'water', hp: 6, uses: 6 });
        prop(c, 'chest', { items: [{ id: 'stormcap', q: 2 }, { id: 'shock_bomb', q: 1 }, { id: 'gold', q: RI(10, 20) }] });
        break;
      case 'wisps':
        for (let y = c.y - 1; y <= c.y + 1; y++) for (let x = c.x - 1; x <= c.x + 1; x++) if (TILES[tiles[idx(x, y)]].pass) tiles[idx(x, y)] = T.SHALLOW;
        spawn(c, 'frost_wisp'); spawn(c, 'frost_wisp'); spawn(c, 'skeleton');
        prop(c, 'crate', { hp: 8, items: [{ id: 'frostleaf', q: 2 }, { id: 'frost_bomb', q: 1 }] });
        break;
      case 'undead':
        spawn(c, 'skeleton'); spawn(c, 'skeleton'); spawn(c, 'skeleton');
        prop(c, 'chest', { items: [{ id: 'gold', q: RI(15, 30) }, { id: 'iron_ingot', q: 2 }, { id: 'healing_potion', q: 1 }] });
        break;
      case 'warlord':
        obj('campfire', c.x, c.y, { lit: true });
        spawn(c, 'warlord'); spawn(c, 'bandit'); spawn(c, 'bandit_archer'); spawn(c, 'bandit_archer');
        prop(c, 'barrel', { liquid: 'powder', hp: 4 }); prop(c, 'barrel', { liquid: 'oil', hp: 6, uses: 6 }); prop(c, 'barrel', { liquid: 'oil', hp: 6, uses: 6 });
        prop(c, 'chest', { locked: true, name: "Warlord's Hoard", items: [{ id: 'gold', q: 80 }, { id: 'iron_mail', q: 1 }, { id: 'powder_bomb', q: 2 }, { id: 'storm_staff', q: 1 }] });
        break;
    }
  }
  return { W, H, tiles, entities, spawn: { x: cx, y: cy + 1 }, camps };
}
