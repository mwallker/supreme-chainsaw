// Level generation: noise terrain themed per level, a road from the start camp to the exit gate,
// and designed encounter sites placed along the road (deterministic per level seed).
import { mulberry32, fbm } from '../rng.js';
import { T, TILES } from '../data/tiles.js';
import { OBJECTS } from '../data/objects.js';
import { LEVELS } from '../data/levels.js';
import { makeEnemy } from './entities.js';

export function generateLevel(levelIdx) {
  const def = LEVELS[levelIdx];
  const { W, H, seed } = def;
  const rng = mulberry32(seed);
  const R = () => rng();
  const RI = (a, b) => a + Math.floor(R() * (b - a + 1));
  const idx = (x, y) => x + y * W;
  const tiles = new Uint8Array(W * H);
  const tf = def.terrain;

  // ---------- terrain
  const hs = new Float32Array(W * H), ms = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { hs[idx(x, y)] = fbm(x / 16, y / 16, seed, 4); ms[idx(x, y)] = fbm(x / 13 + 50, y / 13 + 50, seed + 777, 3); }
  const sorted = Array.from(hs).sort((a, b) => a - b), q = (p) => sorted[Math.floor(p * (sorted.length - 1))];
  const msorted = Array.from(ms).sort((a, b) => a - b);
  const th = { deep: q(tf.deep), shallow: q(tf.shallow), sand: q(tf.sand), rocky: q(tf.rocky), mount: q(tf.mount), forest: msorted[Math.floor(tf.forest * msorted.length)] };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = idx(x, y), edge = Math.min(x, y, W - 1 - x, H - 1 - y);
    let h = hs[i];
    if (edge < 2) { tiles[i] = T.MOUNTAIN; continue; }
    if (edge < 5) h = Math.max(h, th.rocky + (5 - edge) * 0.03);
    tiles[i] = h < th.deep ? T.DEEP : h < th.shallow ? T.SHALLOW : h < th.sand ? T.SAND : h > th.mount ? T.MOUNTAIN : h > th.rocky ? T.ROCKY : ms[i] > th.forest ? T.FOREST : T.GRASS;
  }

  // ---------- road: start (west) -> exit (east)
  const startX = def.village ? 16 : 8, endX = W - 8;
  let x = startX, y = Math.floor(H / 2) + RI(-4, 4);
  const endY = Math.floor(H / 2) + RI(-8, 8);
  const path = [[x, y]];
  while (x < endX) {
    if (R() < 0.68) x++;
    else {
      const want = Math.sign(endY - y + (R() - 0.5) * 18);
      y = Math.max(8, Math.min(H - 9, y + (want || 1)));
    }
    path.push([x, y]);
  }
  const road = new Set();
  const carve = (cx, cy) => { for (const [ox, oy] of [[0, 0], [0, 1]]) { const i = idx(cx + ox, cy + oy); const t = tiles[i]; tiles[i] = t === T.DEEP || t === T.SHALLOW ? T.FLOOR : T.DIRT; road.add(i); } };
  path.forEach(([px, py]) => carve(px, py));

  const entities = [];
  const occupied = new Set();
  const reserved = new Set(); // no scatter here
  const obj = (type, ox, oy, extra = {}) => { const e = { kind: 'object', type, x: ox, y: oy, ...extra }; entities.push(e); occupied.add(idx(ox, oy)); return e; };
  const reserve = (cx, cy, r) => { for (let yy = cy - r; yy <= cy + r; yy++) for (let xx = cx - r; xx <= cx + r; xx++) if (Math.hypot(xx - cx, yy - cy) <= r + 0.5) reserved.add(idx(xx, yy)); };
  const free = (fx, fy) => fx > 2 && fy > 2 && fx < W - 3 && fy < H - 3 && TILES[tiles[idx(fx, fy)]].pass && !occupied.has(idx(fx, fy));
  const near = (cx, cy, r, avoidRoad = true) => {
    for (let t = 0; t < 60; t++) {
      const nx = cx + RI(-r, r), ny = cy + RI(-r, r);
      if (free(nx, ny) && !(avoidRoad && road.has(idx(nx, ny)))) return [nx, ny];
    }
    for (let t = 0; t < 60; t++) { const nx = cx + RI(-r, r), ny = cy + RI(-r, r); if (free(nx, ny)) return [nx, ny]; }
    return null;
  };

  // ---------- start camp
  const [sx, sy] = path[0];
  if (def.village) buildVillage(tiles, W, sx, sy, obj, entities, occupied);
  else {
    for (let yy = sy - 4; yy <= sy + 4; yy++) for (let xx = sx - 4; xx <= sx + 4; xx++) if (Math.hypot(xx - sx, yy - sy) < 4.6 && !road.has(idx(xx, yy))) tiles[idx(xx, yy)] = T.DIRT;
    obj('campfire', sx, sy - 2, { lit: true });
    obj('alchemy', sx - 2, sy + 2);
    obj('workbench', sx + 2, sy + 2);
    obj('chest', sx - 3, sy - 1, { name: 'Expedition Supplies', items: (def.supplies || []).map(([id, q]) => ({ id, q })) });
    entities.push({ kind: 'npc', type: 'merchant', name: 'Merrin the Trader', x: sx + 2, y: sy - 2 });
    occupied.add(idx(sx + 2, sy - 2));
  }
  reserve(sx, sy, def.village ? 12 : 5);
  const spawn = { x: sx, y: sy + 1 };

  // ---------- encounters & checkpoints
  const info = { encounters: [], checkpoints: [], exit: null, name: def.name };
  const marshNoise = (xx, yy) => fbm(xx / 3, yy / 3, seed + 5, 2);
  for (const enc of def.encounters) {
    const pi = Math.min(path.length - 1, Math.floor(enc.at * path.length));
    const [cx, cy] = path[pi];
    if (enc.checkpoint) {
      const p = near(cx, cy - 2, 2) || [cx, cy - 2];
      obj('campfire', p[0], p[1], { lit: true });
      reserve(cx, cy, 3);
      info.checkpoints.push({ x: p[0], y: p[1] });
      continue;
    }
    const r = enc.boss ? 6 : 5;
    for (let yy = cy - r; yy <= cy + r; yy++) for (let xx = cx - r; xx <= cx + r; xx++) {
      const d = Math.hypot(xx - cx, yy - cy), i = idx(xx, yy);
      if (d > r + 0.3 || road.has(i)) continue;
      let t = T.GRASS;
      switch (enc.clear) {
        case 'grass': t = R() < 0.15 ? T.DIRT : T.GRASS; break;
        case 'bog': t = d < 2.6 ? T.SHALLOW : T.GRASS; break;
        case 'camp': t = d < 3.5 ? T.DIRT : T.GRASS; break;
        case 'marsh': t = marshNoise(xx, yy) > 0.52 ? T.SHALLOW : R() < 0.5 ? T.SAND : T.GRASS; break;
        case 'ruin': t = d > r - 0.8 && R() < 0.35 ? T.WALL : T.FLOOR; break;
        case 'icepool': t = d < 2.4 ? T.SHALLOW : T.FLOOR; break;
        case 'crypt': t = d > r - 0.7 ? T.WALL : T.FLOOR; break;
      }
      tiles[i] = t;
    }
    // keep the road open through walls
    for (const [px, py] of path.slice(Math.max(0, pi - r - 2), pi + r + 3)) for (const [ox, oy] of [[0, 0], [0, 1], [0, -1]]) { const i = idx(px, py + oy); if (tiles[i] === T.WALL) tiles[i] = T.FLOOR; }
    reserve(cx, cy, r + 1);
    const entry = path[Math.max(0, pi - r - 4)];
    info.encounters.push({ id: enc.id, name: enc.name, x: cx, y: cy, entry: [entry[0], entry[1]], boss: !!enc.boss });
    // enemies (base group; per-player extras are added when the fight begins)
    for (const type of enc.enemies) {
      const p = near(cx, cy, 2, false) || near(cx, cy, 4, false);
      if (p) { const e = makeEnemy(type, p[0], p[1], enc.id, { enc: enc.id }); entities.push(e); occupied.add(idx(p[0], p[1])); }
    }
    for (const pr of enc.props || []) {
      const [kind, arg] = pr;
      if (kind === 'barrel') { const p = near(cx, cy, 4); if (p) obj('barrel', p[0], p[1], { liquid: arg, hp: arg === 'powder' ? 4 : 6, uses: 6 }); }
      else if (kind === 'chest' || kind === 'crate') { const p = near(cx, cy, r - 1); if (p) obj(kind, p[0], p[1], { hp: 8, items: arg.map(([id, q]) => ({ id, q })) }); }
      else if (kind === 'oil') {
        const p = near(cx, cy, 2, false);
        if (p) (info.oil ||= []).push([p[0], p[1], arg]);
      }
    }
  }

  // ---------- exit gate
  const [ex, ey] = path[path.length - 1];
  obj('exit', ex + 1, ey);
  info.exit = { x: ex + 1, y: ey };
  reserve(ex, ey, 2);

  // ---------- scatter resources
  const nearWater = (xx, yy) => { for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const t = tiles[idx(xx + dx, yy + dy)]; if (t === T.SHALLOW || t === T.DEEP) return true; } return false; };
  for (let yy = 3; yy < H - 3; yy++) for (let xx = 3; xx < W - 3; xx++) {
    const i = idx(xx, yy);
    if (occupied.has(i) || reserved.has(i)) continue;
    let roadNear = false;
    for (let dy = -1; dy <= 1 && !roadNear; dy++) for (let dx = -1; dx <= 1; dx++) if (road.has(idx(xx + dx, yy + dy))) { roadNear = true; break; }
    if (roadNear) continue;
    const t = tiles[i], r = R();
    if (t === T.FOREST) {
      if (r < 0.3) obj('tree', xx, yy);
      else if (r < 0.34) obj('bush', xx, yy, { herb: R() < 0.45 ? 'stormcap' : R() < 0.7 ? 'nightshade' : 'healroot' });
    } else if (t === T.GRASS) {
      if (nearWater(xx, yy) && r < 0.05) obj('bush', xx, yy, { herb: 'frostleaf' });
      else if (r < 0.05) obj('tree', xx, yy);
      else if (r < 0.075) obj('bush', xx, yy, { herb: R() < 0.7 ? 'healroot' : 'nightshade' });
      else if (r < 0.083) obj('rock', xx, yy, { uses: 3 });
    } else if (t === T.ROCKY) {
      if (r < 0.09) obj('rock', xx, yy, { uses: 3 });
      else if (r < 0.125) obj('ore', xx, yy, { uses: 3 });
      else if (r < 0.145) obj('sulfur_rock', xx, yy, { uses: 3 });
      else if (r < 0.16) obj('bush', xx, yy, { herb: 'emberroot' });
    } else if (t === T.SAND) {
      if (r < 0.03) obj('rock', xx, yy, { uses: 3, flinty: true });
      else if (r < 0.07) obj('bush', xx, yy, { herb: nearWater(xx, yy) ? 'frostleaf' : 'emberroot' });
    }
  }
  for (const e of entities) if (e.kind === 'enemy') { e.hx = e.x; e.hy = e.y; }
  return { W, H, tiles, entities, spawn, info };
}

function buildVillage(tiles, W, cx, cy, obj, entities, occupied) {
  const idx = (x, y) => x + y * W;
  for (let y = cy - 11; y <= cy + 11; y++) for (let x = cx - 11; x <= cx + 11; x++) {
    const d = Math.hypot(x - cx, y - cy);
    if (d <= 10.5 && x > 2 && y > 2) tiles[idx(x, y)] = d <= 3.5 ? T.DIRT : T.GRASS;
  }
  const house = (x0, y0, w, h, door) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) tiles[idx(x, y)] = x === x0 || y === y0 || x === x0 + w - 1 || y === y0 + h - 1 ? T.WALL : T.FLOOR;
    tiles[idx(door[0], door[1])] = T.FLOOR;
  };
  house(cx - 10, cy - 9, 6, 5, [cx - 7, cy - 5]);
  house(cx + 3, cy - 10, 7, 5, [cx + 6, cy - 6]);
  house(cx - 10, cy + 5, 6, 5, [cx - 7, cy + 5]);
  obj('campfire', cx, cy - 1, { lit: true });
  obj('well', cx - 4, cy + 2);
  obj('workbench', cx + 4, cy + 4);
  obj('forge', cx + 6, cy + 4, { lit: false });
  obj('alchemy', cx - 4, cy - 2);
  obj('barrel', cx + 7, cy + 6, { liquid: 'oil', hp: 6, uses: 6 });
  obj('barrel', cx - 5, cy + 3, { liquid: 'water', hp: 6, uses: 6 });
  obj('chest', cx - 2, cy - 3, { name: 'Village Supply Chest', items: [
    { id: 'iron_axe', q: 1 }, { id: 'pickaxe', q: 1 }, { id: 'hammer', q: 1 }, { id: 'dagger', q: 1 },
    { id: 'mortar', q: 1 }, { id: 'empty_flask', q: 4 }, { id: 'cloth', q: 3 }, { id: 'stick', q: 4 }, { id: 'torch', q: 3 }, { id: 'nightsight', q: 1 }] });
  obj('chest', cx - 8, cy - 7, { items: [{ id: 'healing_potion', q: 2 }, { id: 'string', q: 3 }, { id: 'feather', q: 4 }, { id: 'gold', q: 10 }] });
  obj('chest', cx + 7, cy - 8, { items: [{ id: 'flask_oil', q: 2 }, { id: 'flint', q: 3 }, { id: 'leather', q: 2 }] });
  obj('crate', cx - 8, cy + 7, { hp: 8, items: [{ id: 'wood', q: 3 }, { id: 'raw_meat', q: 2 }] });
  obj('crate', cx - 7, cy + 7, { hp: 8, items: [{ id: 'stone', q: 3 }, { id: 'healroot', q: 2 }] });
  entities.push({ kind: 'npc', type: 'merchant', name: 'Merrin the Trader', x: cx + 2, y: cy - 2 });
  occupied.add(idx(cx + 2, cy - 2));
}
