// Canvas renderer: cached terrain chunks, blob surfaces, procedural sprites, effects.
import { T, TILES } from '../data/tiles.js';
import { ITEMS } from '../data/items.js';
import { ENEMIES } from '../data/enemies.js';
import { CLASSES } from '../data/classes.js';
import { STATUS, SURF, surfaceAt } from '../sim/rules.js';
import { hash } from '../rng.js';
import { circleTiles } from '../util.js';

const BASE = 32;
const CH = 16;

function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  r = Math.max(0, Math.min(255, Math.round(r * f))); g = Math.max(0, Math.min(255, Math.round(g * f))); b = Math.max(0, Math.min(255, Math.round(b * f)));
  return `rgb(${r},${g},${b})`;
}
const SURF_SOLID = { water: '#3f8fd9', blood: '#8a1418', oil: '#24190c', poison: '#5bc43a', fire: '#ff6a1c', ice: '#d4f1ff', steam: '#eef3f7' };
const SURF_ALPHA = { water: 0.5, blood: 0.6, oil: 0.78, poison: 0.5, fire: 0.42, ice: 0.75, steam: 0.38 };

export class Renderer {
  constructor(canvas, view) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.view = view;
    this.cam = { x: 0, y: 0, zoom: 1, ox: 0, oy: 0 };
    this.chunks = new Map();
    this.rpos = new Map();
    this.fx = [];
    this.particles = [];
    this.layer = document.createElement('canvas');
    this.lctx = this.layer.getContext('2d');
    this.shake = 0;
    this.banner = null;
    this.hover = null;
    this.overlay = null; // set by UI: { pathPreview, targeting }
    this.resize();
    addEventListener('resize', () => this.resize());
  }
  resize() {
    const dpr = Math.min(2, devicePixelRatio || 1);
    this.dpr = dpr;
    this.cv.width = innerWidth * dpr; this.cv.height = innerHeight * dpr;
    this.cv.style.width = innerWidth + 'px'; this.cv.style.height = innerHeight + 'px';
    this.layer.width = this.cv.width; this.layer.height = this.cv.height;
  }
  get ts() { return BASE * this.cam.zoom * this.dpr; }
  screenToTile(sx, sy) {
    const ts = this.ts;
    const x = (sx * this.dpr - this.cv.width / 2) / ts + this.cam.x;
    const y = (sy * this.dpr - this.cv.height / 2) / ts + this.cam.y;
    return [Math.floor(x), Math.floor(y)];
  }
  tileToScreen(x, y) {
    const ts = this.ts;
    return [(x - this.cam.x) * ts + this.cv.width / 2, (y - this.cam.y) * ts + this.cv.height / 2];
  }
  invalidateTerrain() { this.chunks.clear(); }

  // ---------------- terrain ----------------
  chunk(cx, cy) {
    const key = cx + ',' + cy;
    let c = this.chunks.get(key);
    if (c) return c;
    c = document.createElement('canvas');
    c.width = c.height = CH * BASE;
    const g = c.getContext('2d');
    const map = this.view.map;
    for (let y = 0; y < CH; y++)
      for (let x = 0; x < CH; x++) this.drawTile(g, map, cx * CH + x, cy * CH + y, x * BASE, y * BASE);
    this.chunks.set(key, c);
    return c;
  }
  drawTile(g, map, x, y, px, py) {
    const t = map.tile(x, y);
    const h = hash(x, y, 9);
    const S = BASE;
    g.fillStyle = shade(TILES[t].c, 0.92 + h * 0.16);
    g.fillRect(px, py, S, S);
    const r2 = hash(x, y, 21), r3 = hash(x, y, 33);
    switch (t) {
      case T.GRASS: case T.FOREST:
        g.strokeStyle = shade(TILES[t].c, t === T.GRASS ? 1.25 : 1.3);
        g.lineWidth = 1.2;
        for (let i = 0; i < 4; i++) {
          const bx = px + hash(x, y, 40 + i) * S, by = py + hash(x, y, 50 + i) * S;
          g.beginPath(); g.moveTo(bx, by); g.lineTo(bx + 1.5, by - 4); g.stroke();
        }
        if (t === T.GRASS && r2 < 0.06) { g.fillStyle = ['#f3e37a', '#f7a8c9', '#fff'][Math.floor(r3 * 3)]; g.fillRect(px + r3 * 26 + 3, py + r2 * 400 % 26 + 3, 3, 3); }
        break;
      case T.SAND:
        g.fillStyle = shade(TILES[t].c, 0.82);
        for (let i = 0; i < 5; i++) g.fillRect(px + hash(x, y, 60 + i) * S, py + hash(x, y, 70 + i) * S, 1.5, 1.5);
        break;
      case T.DIRT:
        g.fillStyle = shade(TILES[t].c, 0.8);
        for (let i = 0; i < 4; i++) g.fillRect(px + hash(x, y, 60 + i) * S, py + hash(x, y, 70 + i) * S, 2, 2);
        break;
      case T.ROCKY:
        g.fillStyle = shade(TILES[t].c, 0.75);
        for (let i = 0; i < 3; i++) { g.beginPath(); g.arc(px + hash(x, y, 60 + i) * S, py + hash(x, y, 70 + i) * S, 2 + r2 * 2, 0, 7); g.fill(); }
        break;
      case T.MOUNTAIN: {
        g.fillStyle = shade(TILES[t].c, 1.25);
        g.beginPath(); g.moveTo(px + 4, py + S - 4); g.lineTo(px + S * (0.35 + r2 * 0.3), py + 5); g.lineTo(px + S - 3, py + S - 4); g.fill();
        g.fillStyle = shade(TILES[t].c, 0.8);
        g.beginPath(); g.moveTo(px + S * (0.35 + r2 * 0.3), py + 5); g.lineTo(px + S - 3, py + S - 4); g.lineTo(px + S * 0.6, py + S - 4); g.fill();
        break;
      }
      case T.DEEP: case T.SHALLOW: {
        g.strokeStyle = t === T.DEEP ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.14)';
        g.lineWidth = 1.5;
        g.beginPath(); const wy = py + 8 + r2 * 16; g.moveTo(px + 4, wy); g.quadraticCurveTo(px + 12, wy - 3, px + 20, wy); g.stroke();
        // shoreline
        const land = (dx, dy) => { const n = map.tile(x + dx, y + dy); return n !== T.DEEP && n !== T.SHALLOW; };
        g.fillStyle = 'rgba(230,220,170,0.35)';
        if (land(0, -1)) g.fillRect(px, py, S, 3);
        if (land(0, 1)) g.fillRect(px, py + S - 3, S, 3);
        if (land(-1, 0)) g.fillRect(px, py, 3, S);
        if (land(1, 0)) g.fillRect(px + S - 3, py, 3, S);
        break;
      }
      case T.FLOOR:
        g.strokeStyle = 'rgba(0,0,0,0.25)'; g.lineWidth = 1;
        for (let i = 1; i < 4; i++) { g.beginPath(); g.moveTo(px, py + i * 8); g.lineTo(px + S, py + i * 8); g.stroke(); }
        break;
      case T.WALL:
        g.fillStyle = shade(TILES[t].c, 1.35);
        g.fillRect(px, py, S, 6);
        g.strokeStyle = 'rgba(0,0,0,0.35)';
        for (let i = 0; i < 3; i++) { g.strokeRect(px + (i % 2) * 8, py + 6 + i * 9, 16, 9); g.strokeRect(px + 16 + (i % 2) * 8, py + 6 + i * 9, 16, 9); }
        break;
    }
  }

  // ---------------- effects intake ----------------
  addFx(f) {
    const now = performance.now();
    switch (f.type) {
      case 'shake': this.shake = Math.max(this.shake, f.p); return;
      case 'banner': this.banner = { text: f.text, t0: now }; return;
      case 'puff': for (let i = 0; i < 8; i++) this.particle(f.x + 0.5, f.y + 0.5, '#f4f7fa', 0.9, 1.2, -0.6, 6); return;
      case 'flare': setTimeout(() => { for (let i = 0; i < 6; i++) this.particle(f.x + 0.5, f.y + 0.5, i % 2 ? '#ffb347' : '#ff5a1f', 1.6, 0.7, -1.2, 4); }, f.delay || 0); return;
      case 'chips': for (let i = 0; i < 8; i++) this.particle(f.x + 0.5, f.y + 0.5, f.c, 2.2, 0.5, 0.5, 3); return;
      case 'debris': for (let i = 0; i < 14; i++) this.particle(f.x + 0.5, f.y + 0.5, '#9a6a3a', 3, 0.7, 0.4, 4); return;
      case 'craft': for (let i = 0; i < 12; i++) this.particle(f.x + 0.5, f.y + 0.3, f.c || '#ffd86b', 1.3, 0.9, -0.8, 3); return;
      case 'levelup': for (let i = 0; i < 24; i++) this.particle(f.x + 0.5, f.y + 0.5, '#ffd86b', 2.5, 1.2, -1.5, 3); break;
      case 'rain': for (let i = 0; i < 50; i++) setTimeout(() => this.particle(f.x + 0.5 + (Math.random() - 0.5) * 5, f.y - 1.5 + Math.random() * 3, '#9fd0ff', 0.1, 0.5, 4, 2), i * 12); return;
    }
    this.fx.push({ ...f, t0: now });
  }
  particle(x, y, c, spread, life, vy, size) {
    const a = Math.random() * Math.PI * 2, sp = Math.random() * spread;
    this.particles.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp * 0.6 + vy, c, life, t: 0, size });
  }

  // ---------------- frame ----------------
  frame(dt, now) {
    const v = this.view;
    if (!v.state || !v.map) return;
    const ctx = this.ctx, W = this.cv.width, H = this.cv.height;
    const S = v.state;
    // smooth positions
    for (const e of Object.values(S.entities)) {
      if (e.kind === 'object') continue;
      let p = this.rpos.get(e.id);
      if (!p) this.rpos.set(e.id, (p = { x: e.x, y: e.y }));
      const dx = e.x - p.x, dy = e.y - p.y;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) { p.x = e.x; p.y = e.y; }
      else { const k = Math.min(1, dt * 11); p.x += dx * k; p.y += dy * k; }
    }
    const me = S.entities[v.myEid];
    if (me) {
      const p = this.rpos.get(me.id) || me;
      const tx = p.x + 0.5 + this.cam.ox, ty = p.y + 0.5 + this.cam.oy;
      this.cam.x += (tx - this.cam.x) * Math.min(1, dt * 8);
      this.cam.y += (ty - this.cam.y) * Math.min(1, dt * 8);
    }
    let sx = 0, sy = 0;
    if (this.shake > 0.2) { sx = (Math.random() - 0.5) * this.shake * this.dpr; sy = (Math.random() - 0.5) * this.shake * this.dpr; this.shake *= 0.88; } else this.shake = 0;
    ctx.setTransform(1, 0, 0, 1, sx, sy);
    ctx.fillStyle = '#0c0b0a';
    ctx.fillRect(-20, -20, W + 40, H + 40);
    const ts = this.ts;
    const x0 = Math.floor(this.cam.x - W / 2 / ts) - 1, y0 = Math.floor(this.cam.y - H / 2 / ts) - 1;
    const x1 = Math.ceil(this.cam.x + W / 2 / ts) + 1, y1 = Math.ceil(this.cam.y + H / 2 / ts) + 1;
    const scr = (x, y) => [(x - this.cam.x) * ts + W / 2, (y - this.cam.y) * ts + H / 2];

    // terrain chunks
    ctx.imageSmoothingEnabled = this.cam.zoom < 1;
    for (let cy = Math.max(0, Math.floor(y0 / CH)); cy <= Math.min(Math.floor((v.map.H - 1) / CH), Math.floor(y1 / CH)); cy++)
      for (let cx = Math.max(0, Math.floor(x0 / CH)); cx <= Math.min(Math.floor((v.map.W - 1) / CH), Math.floor(x1 / CH)); cx++) {
        const [px, py] = scr(cx * CH, cy * CH);
        ctx.drawImage(this.chunk(cx, cy), Math.floor(px), Math.floor(py), Math.ceil(CH * ts) + 1, Math.ceil(CH * ts) + 1);
      }

    // surfaces as merged blobs per type
    const t = now / 1000;
    const vis = [];
    for (let y = Math.max(0, y0); y <= Math.min(v.map.H - 1, y1); y++)
      for (let x = Math.max(0, x0); x <= Math.min(v.map.W - 1, x1); x++) {
        const s = surfaceAt(S, v.map, v.map.idx(x, y));
        if (s && !(s.base && !s.e)) vis.push([x, y, s]);
      }
    const byType = {};
    for (const it of vis) if (!it[2].base) (byType[it[2].type] ||= []).push(it);
    const lc = this.lctx;
    for (const [type, arr] of Object.entries(byType)) {
      lc.setTransform(1, 0, 0, 1, 0, 0);
      lc.clearRect(0, 0, W, H);
      lc.fillStyle = SURF_SOLID[type];
      for (const [x, y] of arr) {
        const [px, py] = scr(x + 0.5, y + 0.5);
        const wob = type === 'steam' ? Math.sin(t * 1.5 + x + y) * 0.06 : 0;
        lc.beginPath(); lc.arc(px, py, ts * (0.66 + wob + hash(x, y, 3) * 0.06), 0, 7); lc.fill();
      }
      ctx.globalAlpha = SURF_ALPHA[type];
      ctx.drawImage(this.layer, 0, 0);
      ctx.globalAlpha = 1;
    }
    // animated surface details
    for (const [x, y, s] of vis) {
      const [px, py] = scr(x, y);
      const h = hash(x, y, 5);
      if (s.type === 'fire') {
        for (let i = 0; i < 3; i++) {
          const fx = px + ts * (0.2 + 0.3 * i + 0.05 * Math.sin(t * 7 + h * 9 + i));
          const fh = ts * (0.35 + 0.18 * Math.sin(t * 9 + i * 2 + h * 20));
          ctx.fillStyle = i === 1 ? 'rgba(255,220,90,0.85)' : 'rgba(255,120,30,0.8)';
          ctx.beginPath(); ctx.moveTo(fx - ts * 0.12, py + ts * 0.8); ctx.quadraticCurveTo(fx, py + ts * 0.8 - fh * 1.6, fx + ts * 0.12, py + ts * 0.8); ctx.fill();
        }
      } else if (s.type === 'poison' && Math.sin(t * 2 + h * 30) > 0.6) {
        ctx.strokeStyle = 'rgba(200,255,150,0.6)'; ctx.lineWidth = 1 * this.dpr;
        ctx.beginPath(); ctx.arc(px + ts * (0.3 + h * 0.4), py + ts * (0.3 + hash(x, y, 8) * 0.4), ts * 0.06 * (1 + Math.sin(t * 4 + h * 10)), 0, 7); ctx.stroke();
      } else if (s.type === 'ice') {
        ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 1 * this.dpr;
        ctx.beginPath(); ctx.moveTo(px + ts * 0.2, py + ts * (0.3 + h * 0.3)); ctx.lineTo(px + ts * 0.55, py + ts * 0.5); ctx.lineTo(px + ts * 0.8, py + ts * (0.25 + h * 0.4)); ctx.stroke();
      } else if (s.type === 'oil' && h > 0.6) {
        ctx.fillStyle = 'rgba(160,140,255,0.15)';
        ctx.beginPath(); ctx.ellipse(px + ts * 0.5, py + ts * 0.45, ts * 0.22, ts * 0.08, 0.4, 0, 7); ctx.fill();
      }
      if (s.e) {
        ctx.strokeStyle = `rgba(255,245,140,${0.5 + 0.5 * Math.random()})`; ctx.lineWidth = 1.5 * this.dpr;
        ctx.beginPath();
        let lx = px + ts * Math.random(), ly = py + ts * Math.random();
        ctx.moveTo(lx, ly);
        for (let i = 0; i < 3; i++) { lx += (Math.random() - 0.5) * ts * 0.6; ly += (Math.random() - 0.5) * ts * 0.6; ctx.lineTo(lx, ly); }
        ctx.stroke();
      }
    }

    // overlays under entities: targeting & path
    const ov = this.overlay;
    if (ov?.rangeTiles) {
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      for (const [x, y] of ov.rangeTiles) { const [px, py] = scr(x, y); ctx.fillRect(px + 1, py + 1, ts - 2, ts - 2); }
    }
    if (ov?.aoe) {
      ctx.fillStyle = ov.valid ? 'rgba(255,200,80,0.28)' : 'rgba(255,60,60,0.25)';
      for (const [x, y] of ov.aoe) { const [px, py] = scr(x, y); ctx.fillRect(px + 1, py + 1, ts - 2, ts - 2); }
    }
    if (ov?.path) {
      ov.path.forEach(([x, y], i) => {
        const [px, py] = scr(x + 0.5, y + 0.5);
        ctx.fillStyle = i < ov.reach ? 'rgba(120,230,140,0.9)' : 'rgba(255,90,90,0.8)';
        ctx.beginPath(); ctx.arc(px, py, ts * (i === ov.path.length - 1 ? 0.16 : 0.08), 0, 7); ctx.fill();
      });
    }
    if (this.hover && v.map.inb(...this.hover)) {
      const [px, py] = scr(this.hover[0], this.hover[1]);
      ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.lineWidth = 1.5 * this.dpr;
      ctx.strokeRect(px + 1, py + 1, ts - 2, ts - 2);
    }

    // entities, y-sorted
    const ents = [];
    for (const e of Object.values(S.entities)) {
      const p = e.kind === 'object' ? e : this.rpos.get(e.id) || e;
      if (p.x < x0 - 1 || p.x > x1 || p.y < y0 - 1 || p.y > y1) continue;
      ents.push([p.y + (e.dead || e.type === 'pile' || e.type === 'bush' || e.type === 'stump' ? -0.5 : 0), e, p]);
    }
    ents.sort((a, b) => a[0] - b[0]);
    const active = S.combat?.active;
    for (const [, e, p] of ents) {
      const [px, py] = scr(p.x, p.y);
      if (e.kind === 'object') this.drawObject(ctx, e, px, py, ts, t);
      else this.drawCreature(ctx, e, px, py, ts, t, e.id === active, e.id === v.myEid);
    }

    // fx
    this.drawFx(ctx, scr, ts, now, dt);
    // particles
    for (const pa of this.particles) {
      pa.t += dt; pa.x += pa.vx * dt; pa.y += pa.vy * dt; pa.vy += 1.5 * dt;
      const a = 1 - pa.t / pa.life;
      if (a <= 0) continue;
      const [px, py] = scr(pa.x, pa.y);
      ctx.globalAlpha = a;
      ctx.fillStyle = pa.c;
      ctx.fillRect(px, py, pa.size * this.dpr, pa.size * this.dpr);
    }
    ctx.globalAlpha = 1;
    this.particles = this.particles.filter((p) => p.t < p.life);

    // vignette + banner
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const vg = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.75);
    vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.55)');
    ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);
    if (S.combat) { ctx.strokeStyle = 'rgba(200,40,40,0.35)'; ctx.lineWidth = 6 * this.dpr; ctx.strokeRect(0, 0, W, H); }
    if (this.banner) {
      const age = (now - this.banner.t0) / 1000;
      if (age > 2) this.banner = null;
      else {
        const a = age < 0.3 ? age / 0.3 : age > 1.5 ? (2 - age) / 0.5 : 1;
        ctx.globalAlpha = a;
        ctx.font = `bold ${48 * this.dpr}px Georgia, serif`;
        ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillText(this.banner.text, W / 2 + 3, H * 0.3 + 3);
        ctx.fillStyle = this.banner.text === 'Victory' ? '#ffd86b' : this.banner.text === 'Defeated' ? '#c33' : '#ff7b5a';
        ctx.fillText(this.banner.text, W / 2, H * 0.3);
        ctx.globalAlpha = 1;
      }
    }
  }

  drawObject(ctx, e, px, py, ts, t) {
    const cx = px + ts / 2, cy = py + ts / 2, d = this.dpr;
    const shadow = (r = 0.38) => { ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.beginPath(); ctx.ellipse(cx, py + ts * 0.82, ts * r, ts * 0.13, 0, 0, 7); ctx.fill(); };
    const h = hash(e.x, e.y, 77);
    switch (e.type) {
      case 'tree': case 'burning_tree': {
        shadow(0.42);
        ctx.fillStyle = '#5a3b1e'; ctx.fillRect(cx - ts * 0.07, cy, ts * 0.14, ts * 0.34);
        const greens = e.type === 'burning_tree' ? ['#4a3a20', '#5c3d1a', '#3d2f1a'] : ['#2f6b2a', '#3d8034', '#4f9a3f'];
        const off = [[-0.16, -0.08, 0.3], [0.15, -0.1, 0.28], [0, -0.28, 0.3], [0, -0.06, 0.26]];
        off.forEach(([ox, oy, r], i) => { ctx.fillStyle = greens[i % 3]; ctx.beginPath(); ctx.arc(cx + ox * ts, cy + oy * ts, r * ts * (0.9 + h * 0.2), 0, 7); ctx.fill(); });
        if (e.type === 'burning_tree') for (let i = 0; i < 4; i++) {
          const fx = cx + (i - 1.5) * ts * 0.16, fh = ts * (0.35 + 0.15 * Math.sin(t * 10 + i * 2));
          ctx.fillStyle = i % 2 ? 'rgba(255,210,80,0.9)' : 'rgba(255,100,20,0.9)';
          ctx.beginPath(); ctx.moveTo(fx - ts * 0.1, cy); ctx.quadraticCurveTo(fx, cy - fh * 1.5, fx + ts * 0.1, cy); ctx.fill();
        }
        break;
      }
      case 'burnt_tree':
        shadow(0.25);
        ctx.strokeStyle = '#1e1a17'; ctx.lineWidth = ts * 0.12; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(cx, cy + ts * 0.32); ctx.lineTo(cx, cy - ts * 0.25); ctx.moveTo(cx, cy - ts * 0.05); ctx.lineTo(cx + ts * 0.2, cy - ts * 0.25); ctx.moveTo(cx, cy); ctx.lineTo(cx - ts * 0.18, cy - ts * 0.15); ctx.stroke();
        break;
      case 'stump':
        ctx.fillStyle = '#6b4626'; ctx.beginPath(); ctx.ellipse(cx, cy + ts * 0.15, ts * 0.18, ts * 0.12, 0, 0, 7); ctx.fill();
        ctx.fillStyle = '#c9a26b'; ctx.beginPath(); ctx.ellipse(cx, cy + ts * 0.1, ts * 0.14, ts * 0.08, 0, 0, 7); ctx.fill();
        break;
      case 'rock': case 'ore': case 'sulfur_rock': {
        shadow(0.4);
        ctx.fillStyle = e.flinty ? '#7b858c' : '#8d8f91';
        ctx.beginPath(); ctx.moveTo(cx - ts * 0.38, cy + ts * 0.28); ctx.lineTo(cx - ts * 0.28, cy - ts * 0.15); ctx.lineTo(cx + ts * 0.05, cy - ts * 0.3); ctx.lineTo(cx + ts * 0.35, cy - ts * 0.08); ctx.lineTo(cx + ts * 0.38, cy + ts * 0.28); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.18)'; ctx.beginPath(); ctx.moveTo(cx - ts * 0.28, cy - ts * 0.15); ctx.lineTo(cx + ts * 0.05, cy - ts * 0.3); ctx.lineTo(cx, cy); ctx.fill();
        if (e.type !== 'rock') {
          ctx.fillStyle = e.type === 'ore' ? '#d9824a' : '#f2e04b';
          for (let i = 0; i < 5; i++) ctx.fillRect(cx + (hash(e.x, e.y, i) - 0.5) * ts * 0.5, cy + (hash(e.x, e.y, i + 9) - 0.5) * ts * 0.35, ts * 0.08, ts * 0.08);
        }
        break;
      }
      case 'bush': {
        ctx.fillStyle = '#3c7a35'; ctx.beginPath(); ctx.arc(cx - ts * 0.1, cy + ts * 0.12, ts * 0.2, 0, 7); ctx.arc(cx + ts * 0.12, cy + ts * 0.1, ts * 0.19, 0, 7); ctx.arc(cx, cy - ts * 0.02, ts * 0.2, 0, 7); ctx.fill();
        if (!e.picked) {
          ctx.fillStyle = ITEMS[e.herb]?.c || '#fff';
          for (let i = 0; i < 4; i++) { ctx.beginPath(); ctx.arc(cx + (hash(e.x, e.y, i) - 0.5) * ts * 0.45, cy + (hash(e.x, e.y, i + 4) - 0.5) * ts * 0.35, ts * 0.06, 0, 7); ctx.fill(); }
        }
        break;
      }
      case 'well':
        shadow(0.4);
        ctx.fillStyle = '#7d7a75'; ctx.beginPath(); ctx.arc(cx, cy, ts * 0.38, 0, 7); ctx.fill();
        ctx.fillStyle = '#2b5f8a'; ctx.beginPath(); ctx.arc(cx, cy, ts * 0.24, 0, 7); ctx.fill();
        ctx.strokeStyle = '#5a3b1e'; ctx.lineWidth = 3 * d; ctx.beginPath(); ctx.moveTo(cx - ts * 0.4, cy - ts * 0.3); ctx.lineTo(cx + ts * 0.4, cy - ts * 0.3); ctx.stroke();
        break;
      case 'campfire':
        ctx.fillStyle = '#6d6a66';
        for (let i = 0; i < 7; i++) { const a = (i / 7) * Math.PI * 2; ctx.beginPath(); ctx.arc(cx + Math.cos(a) * ts * 0.3, cy + Math.sin(a) * ts * 0.22 + ts * 0.1, ts * 0.08, 0, 7); ctx.fill(); }
        ctx.strokeStyle = '#5a3b1e'; ctx.lineWidth = ts * 0.08;
        ctx.beginPath(); ctx.moveTo(cx - ts * 0.2, cy + ts * 0.2); ctx.lineTo(cx + ts * 0.2, cy); ctx.moveTo(cx + ts * 0.2, cy + ts * 0.2); ctx.lineTo(cx - ts * 0.2, cy); ctx.stroke();
        if (e.lit) {
          const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, ts * 2.2);
          g.addColorStop(0, 'rgba(255,170,60,0.25)'); g.addColorStop(1, 'rgba(255,170,60,0)');
          ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, ts * 2.2, 0, 7); ctx.fill();
          for (let i = 0; i < 3; i++) {
            const fx = cx + (i - 1) * ts * 0.12, fh = ts * (0.3 + 0.12 * Math.sin(t * 11 + i * 2));
            ctx.fillStyle = i === 1 ? '#ffe27a' : '#ff7a2e';
            ctx.beginPath(); ctx.moveTo(fx - ts * 0.1, cy + ts * 0.12); ctx.quadraticCurveTo(fx, cy + ts * 0.12 - fh * 1.6, fx + ts * 0.1, cy + ts * 0.12); ctx.fill();
          }
        }
        break;
      case 'forge':
        shadow(0.45);
        ctx.fillStyle = '#4a4540'; ctx.fillRect(px + ts * 0.1, py + ts * 0.15, ts * 0.8, ts * 0.7);
        ctx.fillStyle = e.lit ? `rgb(255,${130 + 40 * Math.sin(t * 6)},40)` : '#222';
        ctx.fillRect(px + ts * 0.28, py + ts * 0.4, ts * 0.44, ts * 0.28);
        ctx.fillStyle = '#5c5650'; ctx.fillRect(px + ts * 0.1, py + ts * 0.1, ts * 0.8, ts * 0.12);
        break;
      case 'workbench':
        shadow(0.45);
        ctx.fillStyle = '#7a5130'; ctx.fillRect(px + ts * 0.08, py + ts * 0.3, ts * 0.84, ts * 0.4);
        ctx.fillStyle = '#9a6a3d'; ctx.fillRect(px + ts * 0.08, py + ts * 0.25, ts * 0.84, ts * 0.12);
        ctx.fillStyle = '#bbb'; ctx.fillRect(px + ts * 0.2, py + ts * 0.18, ts * 0.25, ts * 0.06);
        break;
      case 'alchemy':
        shadow(0.45);
        ctx.fillStyle = '#5b3f63'; ctx.fillRect(px + ts * 0.08, py + ts * 0.35, ts * 0.84, ts * 0.35);
        ['#e8435a', '#6fcf3f', '#4aa3df'].forEach((c, i) => { ctx.fillStyle = c; ctx.beginPath(); ctx.arc(px + ts * (0.25 + i * 0.25), py + ts * 0.28, ts * 0.09, 0, 7); ctx.fill(); });
        break;
      case 'barrel': {
        shadow(0.32);
        ctx.fillStyle = '#7a4f2a'; ctx.beginPath(); ctx.ellipse(cx, cy + ts * 0.05, ts * 0.3, ts * 0.36, 0, 0, 7); ctx.fill();
        const band = { oil: '#1d150b', water: '#3a85c9', poison: '#5bc43a', powder: '#d23c3c', empty: '#555' }[e.liquid] || '#555';
        ctx.fillStyle = band; ctx.fillRect(cx - ts * 0.3, cy - ts * 0.05, ts * 0.6, ts * 0.12);
        ctx.fillStyle = '#3a2a18'; ctx.fillRect(cx - ts * 0.3, cy - ts * 0.22, ts * 0.6, ts * 0.04); ctx.fillRect(cx - ts * 0.3, cy + ts * 0.2, ts * 0.6, ts * 0.04);
        if (e.liquid === 'powder') { ctx.fillStyle = '#fff'; ctx.font = `bold ${ts * 0.28}px sans-serif`; ctx.textAlign = 'center'; ctx.fillText('!', cx, cy + ts * 0.32); }
        break;
      }
      case 'crate':
        shadow(0.4);
        ctx.fillStyle = '#a0703d'; ctx.fillRect(px + ts * 0.15, py + ts * 0.15, ts * 0.7, ts * 0.65);
        ctx.strokeStyle = '#6b4626'; ctx.lineWidth = 2 * d; ctx.strokeRect(px + ts * 0.15, py + ts * 0.15, ts * 0.7, ts * 0.65);
        ctx.beginPath(); ctx.moveTo(px + ts * 0.15, py + ts * 0.15); ctx.lineTo(px + ts * 0.85, py + ts * 0.8); ctx.moveTo(px + ts * 0.85, py + ts * 0.15); ctx.lineTo(px + ts * 0.15, py + ts * 0.8); ctx.stroke();
        break;
      case 'chest':
        shadow(0.42);
        ctx.fillStyle = '#7a4a22'; ctx.fillRect(px + ts * 0.12, py + ts * 0.3, ts * 0.76, ts * 0.48);
        ctx.fillStyle = '#93602f'; ctx.fillRect(px + ts * 0.12, py + ts * 0.22, ts * 0.76, ts * 0.16);
        ctx.fillStyle = e.locked ? '#c0392b' : '#e8c547'; ctx.fillRect(cx - ts * 0.06, py + ts * 0.38, ts * 0.12, ts * 0.14);
        break;
      case 'pile': {
        const it = e.items?.[0];
        ctx.fillStyle = '#8a6a43'; ctx.beginPath(); ctx.ellipse(cx, cy + ts * 0.18, ts * 0.22, ts * 0.12, 0, 0, 7); ctx.fill();
        if (it) { ctx.fillStyle = ITEMS[it.id]?.c || '#fff'; ctx.font = `${ts * 0.42}px sans-serif`; ctx.textAlign = 'center'; ctx.fillText(ITEMS[it.id]?.i || '?', cx, cy + ts * 0.15); }
        break;
      }
    }
  }

  drawCreature(ctx, e, px, py, ts, t, active, mine) {
    const cx = px + ts / 2, cy = py + ts / 2, d = this.dpr;
    if (e.dead) {
      ctx.globalAlpha = 0.6;
      ctx.fillStyle = shade(ENEMIES[e.type]?.color || '#888', 0.5);
      ctx.beginPath(); ctx.ellipse(cx, cy + ts * 0.15, ts * 0.34, ts * 0.16, 0.2, 0, 7); ctx.fill();
      ctx.globalAlpha = 1;
      if (e.items?.length) { ctx.fillStyle = '#ffd86b'; ctx.beginPath(); ctx.arc(cx + ts * 0.25, cy - ts * 0.05, ts * 0.06 * (1 + 0.3 * Math.sin(t * 4)), 0, 7); ctx.fill(); }
      return;
    }
    const isP = e.kind === 'player', isNpc = e.kind === 'npc';
    const body = isP ? e.color : isNpc ? '#d9b26b' : ENEMIES[e.type].color;
    const r = ts * (ENEMIES[e.type]?.boss ? 0.42 : 0.33);
    const bob = Math.sin(t * 3 + e.x * 1.3) * ts * 0.02;
    ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.beginPath(); ctx.ellipse(cx, py + ts * 0.85, r * 0.95, ts * 0.12, 0, 0, 7); ctx.fill();
    if (active) {
      ctx.strokeStyle = `rgba(255,215,100,${0.6 + 0.4 * Math.sin(t * 6)})`; ctx.lineWidth = 3 * d;
      ctx.beginPath(); ctx.ellipse(cx, py + ts * 0.85, r * 1.25, ts * 0.2, 0, 0, 7); ctx.stroke();
    }
    ctx.globalAlpha = e.downed ? 0.45 : isP && !e.online ? 0.55 : 1;
    ctx.fillStyle = shade(body, 0.7);
    ctx.beginPath(); ctx.arc(cx, cy + bob + ts * 0.03, r, 0, 7); ctx.fill();
    ctx.fillStyle = body;
    ctx.beginPath(); ctx.arc(cx, cy + bob, r * 0.92, 0, 7); ctx.fill();
    ctx.strokeStyle = isP ? (mine ? '#fff' : 'rgba(255,255,255,0.6)') : isNpc ? '#fff3c4' : '#3a0d0d';
    ctx.lineWidth = (mine ? 2.5 : 1.5) * d;
    ctx.stroke();
    ctx.fillStyle = isP || isNpc ? '#1b1b1b' : '#fff';
    ctx.font = `bold ${ts * 0.36}px Georgia, serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(isP ? CLASSES[e.cls]?.glyph || '@' : isNpc ? '$' : ENEMIES[e.type].glyph, cx, cy + bob + ts * 0.02);
    ctx.textBaseline = 'alphabetic';
    ctx.globalAlpha = 1;
    // status tint
    if (e.st?.frozen) { ctx.fillStyle = 'rgba(200,240,255,0.55)'; ctx.beginPath(); ctx.arc(cx, cy, r * 1.05, 0, 7); ctx.fill(); }
    if (e.st?.burning) for (let i = 0; i < 2; i++) { ctx.fillStyle = 'rgba(255,140,40,0.85)'; const fx = cx + (i ? 0.15 : -0.15) * ts; ctx.beginPath(); ctx.moveTo(fx - ts * 0.07, cy - r * 0.5); ctx.quadraticCurveTo(fx, cy - r * 0.5 - ts * (0.3 + 0.1 * Math.sin(t * 12 + i)), fx + ts * 0.07, cy - r * 0.5); ctx.fill(); }
    if (e.downed) { ctx.fillStyle = '#ff6b6b'; ctx.font = `bold ${ts * 0.3}px sans-serif`; ctx.fillText('✖', cx, cy - r - ts * 0.05); }
    if (isNpc) return;
    // hp bar
    const bw = ts * 0.8, bx = cx - bw / 2, by = py - ts * 0.08;
    ctx.fillStyle = 'rgba(0,0,0,0.7)'; ctx.fillRect(bx - d, by - d, bw + 2 * d, ts * 0.1 + 2 * d);
    ctx.fillStyle = isP ? '#4fd46b' : '#e04848';
    ctx.fillRect(bx, by, bw * Math.max(0, e.hp / e.maxHp), ts * 0.1);
    // statuses
    const sts = Object.keys(e.st || {});
    sts.forEach((s, i) => {
      ctx.fillStyle = STATUS[s]?.c || '#fff';
      ctx.beginPath(); ctx.arc(bx + i * ts * 0.17 + ts * 0.06, by - ts * 0.1, ts * 0.065, 0, 7); ctx.fill();
    });
    if (isP) {
      ctx.font = `${ts * 0.26}px sans-serif`; ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fillText(e.name, cx, py + ts * 1.15);
    }
  }

  drawFx(ctx, scr, ts, now, dt) {
    const keep = [];
    for (const f of this.fx) {
      const age = (now - f.t0) / 1000;
      let alive = true;
      switch (f.type) {
        case 'float': {
          if (age > 1.3) { alive = false; break; }
          const [px, py] = scr(f.x + 0.5, f.y - 0.1 - age * 0.9);
          ctx.globalAlpha = Math.min(1, 2 * (1.3 - age));
          ctx.font = `bold ${ts * 0.4}px sans-serif`; ctx.textAlign = 'center';
          ctx.strokeStyle = 'rgba(0,0,0,0.85)'; ctx.lineWidth = 3 * this.dpr; ctx.strokeText(f.text, px, py);
          ctx.fillStyle = f.c || '#fff'; ctx.fillText(f.text, px, py);
          ctx.globalAlpha = 1;
          break;
        }
        case 'proj': case 'throw': {
          const dur = (f.ms || 300) / 1000;
          if (age > dur) { alive = false; break; }
          const k = age / dur;
          const x = f.fx + (f.tx - f.fx) * k + 0.5, yLin = f.fy + (f.ty - f.fy) * k + 0.5;
          const arc = f.type === 'throw' ? Math.sin(k * Math.PI) * 1.2 : 0;
          const [px, py] = scr(x, yLin - arc);
          if (f.type === 'throw') {
            ctx.font = `${ts * 0.5}px sans-serif`; ctx.textAlign = 'center'; ctx.fillStyle = f.c; ctx.fillText(f.i || '•', px, py);
          } else {
            const [qx, qy] = scr(f.fx + (f.tx - f.fx) * Math.max(0, k - 0.15) + 0.5, f.fy + (f.ty - f.fy) * Math.max(0, k - 0.15) + 0.5);
            ctx.strokeStyle = f.c; ctx.lineWidth = (f.big ? 6 : 3) * this.dpr; ctx.lineCap = 'round';
            ctx.beginPath(); ctx.moveTo(qx, qy); ctx.lineTo(px, py); ctx.stroke();
          }
          break;
        }
        case 'beam': case 'bolt': {
          if (age > 0.35) { alive = false; break; }
          const [ax, ay] = scr(f.fx + 0.5, f.fy + 0.5), [bx, by] = scr(f.tx + 0.5, f.ty + 0.5);
          ctx.globalAlpha = 1 - age / 0.35;
          ctx.strokeStyle = f.c; ctx.lineWidth = (f.type === 'beam' ? 5 : 3) * this.dpr;
          ctx.beginPath(); ctx.moveTo(ax, ay);
          if (f.type === 'bolt') for (let i = 1; i < 6; i++) ctx.lineTo(ax + (bx - ax) * i / 6 + (Math.random() - 0.5) * ts * 0.5, ay + (by - ay) * i / 6 + (Math.random() - 0.5) * ts * 0.5);
          ctx.lineTo(bx, by); ctx.stroke(); ctx.globalAlpha = 1;
          break;
        }
        case 'zap': {
          if (age > 0.5) { alive = false; break; }
          ctx.strokeStyle = `rgba(255,250,150,${1 - age * 2})`; ctx.lineWidth = 2 * this.dpr;
          for (const [x, y] of f.tiles) {
            const [px, py] = scr(x + 0.5, y + 0.5);
            ctx.beginPath(); ctx.moveTo(px - ts * 0.4, py); ctx.lineTo(px - ts * 0.1, py - ts * 0.2); ctx.lineTo(px + ts * 0.1, py + ts * 0.2); ctx.lineTo(px + ts * 0.4, py); ctx.stroke();
          }
          break;
        }
        case 'boom': {
          if (age > 0.6) { alive = false; break; }
          const [px, py] = scr(f.x + 0.5, f.y + 0.5);
          const rr = ts * (f.r + 0.6) * (0.3 + age * 1.6);
          ctx.globalAlpha = 1 - age / 0.6;
          const g = ctx.createRadialGradient(px, py, 0, px, py, rr);
          g.addColorStop(0, '#fff6c8'); g.addColorStop(0.4, f.c || '#ff7a2e'); g.addColorStop(1, 'rgba(255,80,20,0)');
          ctx.fillStyle = g; ctx.beginPath(); ctx.arc(px, py, rr, 0, 7); ctx.fill();
          ctx.globalAlpha = 1;
          break;
        }
        case 'splash': {
          if (age > 0.45) { alive = false; break; }
          const [px, py] = scr(f.x + 0.5, f.y + 0.5);
          ctx.strokeStyle = f.c; ctx.globalAlpha = 1 - age / 0.45; ctx.lineWidth = 3 * this.dpr;
          ctx.beginPath(); ctx.arc(px, py, ts * (f.r + 0.5) * (0.4 + age * 1.4), 0, 7); ctx.stroke(); ctx.globalAlpha = 1;
          break;
        }
        case 'hit': {
          if (age > 0.18) { alive = false; break; }
          const [px, py] = scr(f.x + 0.5, f.y + 0.5);
          ctx.fillStyle = `rgba(255,255,255,${0.7 - age * 4})`; ctx.beginPath(); ctx.arc(px, py, ts * 0.42, 0, 7); ctx.fill();
          break;
        }
        case 'swing': {
          if (age > 0.22) { alive = false; break; }
          const [px, py] = scr(f.x + 0.5, f.y + 0.5);
          const ang = f.tx != null ? Math.atan2(f.ty - f.y, f.tx - f.x) : 0;
          ctx.strokeStyle = `rgba(255,255,255,${0.9 - age * 4})`; ctx.lineWidth = 3 * this.dpr;
          ctx.beginPath(); ctx.arc(px, py, ts * 0.7, ang - 1 + age * 6, ang + age * 6 - 0.2); ctx.stroke();
          break;
        }
        case 'ping': {
          if (age > 2.5) { alive = false; break; }
          const [px, py] = scr(f.x + 0.5, f.y + 0.5);
          ctx.strokeStyle = f.c || '#fff'; ctx.lineWidth = 3 * this.dpr; ctx.globalAlpha = 1 - age / 2.5;
          for (let i = 0; i < 2; i++) { ctx.beginPath(); ctx.arc(px, py, ts * (0.3 + ((age * 1.2 + i * 0.5) % 1)), 0, 7); ctx.stroke(); }
          ctx.globalAlpha = 1;
          break;
        }
        default: alive = false;
      }
      if (alive) keep.push(f);
    }
    this.fx = keep;
  }
}

export function aoeTiles(x, y, r) { return circleTiles(x, y, r); }
