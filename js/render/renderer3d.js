// 3D renderer (Three.js). Same interface the UI expects from a renderer:
//   cam {x,y,zoom,ox,oy,yaw,pitch}, screenToTile(), tileToScreen(), hover, overlay, addFx(), frame(), pan(), cv
// The simulation is a tile grid; tile (x,y) maps to world (x+0.5, height, y+0.5).
import * as THREE from 'three';
import { T, TILES } from '../data/tiles.js';
import { ITEMS } from '../data/items.js';
import { ENEMIES } from '../data/enemies.js';
import { STATUS, surfaceAt } from '../sim/rules.js';
import { hash } from '../rng.js';
import { esc } from '../util.js';
import { lightMap, daylight } from '../sim/light.js';

const TILE_H = { [T.DEEP]: -0.6, [T.SHALLOW]: -0.24, [T.SAND]: 0.0, [T.GRASS]: 0.05, [T.FOREST]: 0.07, [T.DIRT]: 0.03, [T.ROCKY]: 0.18, [T.MOUNTAIN]: 1.4, [T.FLOOR]: 0.1, [T.WALL]: 1.05 };
const TILE_COL = { [T.WALL]: '#857a6c', [T.MOUNTAIN]: '#6d665d', [T.FLOOR]: '#8a6440' };
const WATER_Y = -0.1;
const STATIC = new Set(['tree', 'burning_tree', 'burnt_tree', 'stump', 'rock', 'ore', 'sulfur_rock', 'bush']);
const SURF_COL = { water: '#3f8fd9', blood: '#8a1418', oil: '#21170b', poison: '#5bc43a', fire: '#ff6a1c', ice: '#d4f1ff' };
const SURF_OP = { water: 0.55, blood: 0.7, oil: 0.85, poison: 0.6, fire: 0.55, ice: 0.85 };
const V = new THREE.Vector3(), M4 = new THREE.Matrix4(), Q = new THREE.Quaternion(), S3 = new THREE.Vector3(), E = new THREE.Euler(), C = new THREE.Color();

const matCache = new Map();
function lam(color, o = {}) {
  const k = color + JSON.stringify(o);
  let m = matCache.get(k);
  if (!m) matCache.set(k, (m = new THREE.MeshLambertMaterial({ color, ...o })));
  return m;
}
const basic = (color, o = {}) => new THREE.MeshBasicMaterial({ color, ...o });

/** Fixed-capacity instanced pool, rebuilt in bulk. */
class Pool {
  constructor(scene, geo, mat, cap, { shadow = true, receive = false, pick = false } = {}) {
    this.mesh = new THREE.InstancedMesh(geo, mat, cap);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = shadow;
    this.mesh.receiveShadow = receive;
    this.cap = cap; this.n = 0; this.ids = [];
    this.pick = pick;
    scene.add(this.mesh);
  }
  begin() { this.n = 0; }
  add(x, y, z, sx = 1, sy = 1, sz = 1, ry = 0, color = null, id = null, rx = 0, rz = 0) {
    if (this.n >= this.cap) return;
    E.set(rx, ry, rz); Q.setFromEuler(E); V.set(x, y, z); S3.set(sx, sy, sz);
    M4.compose(V, Q, S3);
    this.mesh.setMatrixAt(this.n, M4);
    if (color) this.mesh.setColorAt(this.n, C.set(color));
    this.ids[this.n] = id;
    this.n++;
  }
  end() {
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.mesh.boundingSphere = null; this.mesh.boundingBox = null;
  }
}

const PARTICLE_VS = `attribute float size; attribute float alpha; attribute vec3 pcolor; varying vec3 vC; varying float vA;
void main(){ vC=pcolor; vA=alpha; vec4 mv=modelViewMatrix*vec4(position,1.0); gl_PointSize=size*(320.0/-mv.z); gl_Position=projectionMatrix*mv; }`;
const PARTICLE_FS = `varying vec3 vC; varying float vA; void main(){ vec2 c=gl_PointCoord-0.5; float d=length(c); if(d>0.5) discard; gl_FragColor=vec4(vC, vA*(1.0-d*1.6)); }`;

export class Renderer {
  constructor(canvas, view) {
    this.cv = canvas;
    this.view = view;
    this.cam = { x: 0, y: 0, zoom: 1, ox: 0, oy: 0, yaw: Math.PI * 0.25, pitch: 0.92 };
    this.rpos = new Map();
    this.hover = null;
    this.overlay = null;
    this.shake = 0;
    this.gl = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.gl.setPixelRatio(Math.min(2, devicePixelRatio || 1));
    this.gl.shadowMap.enabled = true;
    this.gl.shadowMap.type = THREE.PCFSoftShadowMap;
    this.gl.toneMapping = THREE.ACESFilmicToneMapping;
    this.gl.toneMappingExposure = 1.05;
    this.scene = new THREE.Scene();
    this.sky = new THREE.Color('#9bb7c9');
    this.scene.background = this.sky.clone();
    this.scene.fog = new THREE.Fog(this.sky.clone(), 30, 70);
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 250);
    this.hemi = new THREE.HemisphereLight('#dfeaff', '#5a4630', 1.5);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight('#fff0d8', 2.6);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    Object.assign(this.sun.shadow.camera, { left: -26, right: 26, top: 26, bottom: -26, near: 1, far: 80 });
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    this.scene.add(this.sun, this.sun.target);
    this.lights = [];
    for (let i = 0; i < 8; i++) { const l = new THREE.PointLight('#ff9a40', 0, 8, 1.5); this.scene.add(l); this.lights.push(l); }
    this.flash = new THREE.PointLight('#ffcf80', 0, 10, 1.5);
    this.scene.add(this.flash);
    this.raycaster = new THREE.Raycaster();
    this.creatures = new Map();
    this.dyn = new Map();
    this.fx = [];
    this.lastScan = 0;
    this.terrainBuilt = false;
    this.initPools();
    this.initParticles();
    this.initDom();
    this.bindRotate();
    this.resize();
    addEventListener('resize', () => this.resize());
  }
  get dpr() { return 1; }
  resize() {
    this.gl.setSize(innerWidth, innerHeight, true);
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
  }
  bindRotate() {
    let drag = null;
    this.cv.addEventListener('mousedown', (ev) => { if (ev.button === 1) { ev.preventDefault(); drag = { x: ev.clientX, y: ev.clientY }; } });
    addEventListener('mousemove', (ev) => {
      if (!drag) return;
      this.cam.yaw -= (ev.clientX - drag.x) * 0.006;
      this.cam.pitch = Math.max(0.45, Math.min(1.4, this.cam.pitch + (ev.clientY - drag.y) * 0.004));
      drag = { x: ev.clientX, y: ev.clientY };
    });
    addEventListener('mouseup', (ev) => { if (ev.button === 1) drag = null; });
  }
  /** Pan in screen directions (tiles), relative to camera yaw. */
  pan(dx, dy) {
    const s = Math.sin(this.cam.yaw), c = Math.cos(this.cam.yaw);
    this.cam.ox += dx * c + dy * s;
    this.cam.oy += -dx * s + dy * c;
  }

  // ------------------------------------------------------------ setup
  initPools() {
    const S = this.scene;
    const trunkG = new THREE.CylinderGeometry(0.07, 0.12, 1, 6).translate(0, 0.5, 0);
    const roundG = new THREE.IcosahedronGeometry(0.5, 0);
    const pineG = new THREE.ConeGeometry(0.48, 1.2, 7).translate(0, 0.6, 0);
    const P = (g, m, cap, o) => new Pool(S, g, m, cap, o);
    this.p = {
      trunk: P(trunkG, lam('#ffffff'), 3000, { pick: true }),
      round: P(roundG, lam('#ffffff', { flatShading: true }), 2500, { pick: true }),
      pine: P(pineG, lam('#ffffff', { flatShading: true }), 2500, { pick: true }),
      stump: P(new THREE.CylinderGeometry(0.15, 0.17, 0.18, 7).translate(0, 0.09, 0), lam('#7a5230'), 2000),
      rock: P(new THREE.DodecahedronGeometry(0.38, 0), lam('#ffffff', { flatShading: true }), 1500, { pick: true }),
      bush: P(new THREE.IcosahedronGeometry(0.3, 0), lam('#ffffff', { flatShading: true }), 1500),
      herb: P(new THREE.SphereGeometry(0.065, 6, 4), basic('#ffffff'), 4500, { shadow: false }),
      tuft: P(new THREE.ConeGeometry(0.035, 0.24, 3).translate(0, 0.12, 0), lam('#ffffff'), 9000, { shadow: false }),
      flower: P(new THREE.SphereGeometry(0.045, 5, 3), basic('#ffffff'), 2000, { shadow: false }),
      flame: P(new THREE.ConeGeometry(0.11, 0.5, 6).translate(0, 0.25, 0), basic('#ffffff', { transparent: true, opacity: 0.85, depthWrite: false, toneMapped: false }), 2500, { shadow: false }),
      steam: P(new THREE.SphereGeometry(0.32, 8, 6), new THREE.MeshLambertMaterial({ color: '#f2f6f8', transparent: true, opacity: 0.45, depthWrite: false }), 800, { shadow: false }),
      elec: P(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), basic('#f5d020', { transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false }), 1200, { shadow: false }),
      range: P(new THREE.PlaneGeometry(0.94, 0.94).rotateX(-Math.PI / 2), basic('#ffffff', { transparent: true, opacity: 0.22, depthWrite: false }), 800, { shadow: false }),
      lightOv: P(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), basic('#ffffff', { transparent: true, opacity: 0.4, depthWrite: false }), 4000, { shadow: false }),
      smoke: P(new THREE.SphereGeometry(0.42, 8, 6), new THREE.MeshLambertMaterial({ color: '#3d3b38', transparent: true, opacity: 0.72, depthWrite: false }), 800, { shadow: false }),
      aoe: P(new THREE.PlaneGeometry(0.94, 0.94).rotateX(-Math.PI / 2), basic('#ffc850', { transparent: true, opacity: 0.42, depthWrite: false }), 100, { shadow: false }),
      path: P(new THREE.CylinderGeometry(0.09, 0.09, 0.04, 10), basic('#ffffff'), 300, { shadow: false }),
    };
    this.surf = {};
    for (const [type, col] of Object.entries(SURF_COL)) {
      const m = type === 'fire'
        ? basic('#e2440c', { transparent: true, opacity: 0.5, depthWrite: false, toneMapped: false })
        : new THREE.MeshStandardMaterial({ color: col, transparent: true, opacity: SURF_OP[type], depthWrite: false, roughness: type === 'ice' || type === 'oil' ? 0.15 : 0.5, metalness: type === 'oil' ? 0.3 : 0, polygonOffset: true, polygonOffsetFactor: -2 });
      this.surf[type] = new Pool(this.scene, new THREE.PlaneGeometry(1.02, 1.02).rotateX(-Math.PI / 2), m, 2500, { shadow: false, receive: true });
    }
    this.pickPools = [this.p.trunk, this.p.round, this.p.pine, this.p.rock];
    // hover outline + active turn ring
    this.hoverMesh = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(0.96, 0.96).rotateX(-Math.PI / 2)), new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.8 }));
    this.scene.add(this.hoverMesh);
    this.ring = new THREE.Mesh(new THREE.TorusGeometry(0.46, 0.035, 6, 28).rotateX(Math.PI / 2), basic('#ffd864'));
    this.scene.add(this.ring);
  }
  initParticles() {
    const N = 3000;
    this.parts = [];
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('pcolor', new THREE.BufferAttribute(new Float32Array(N * 3), 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('size', new THREE.BufferAttribute(new Float32Array(N), 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('alpha', new THREE.BufferAttribute(new Float32Array(N), 1).setUsage(THREE.DynamicDrawUsage));
    this.pts = new THREE.Points(g, new THREE.ShaderMaterial({ vertexShader: PARTICLE_VS, fragmentShader: PARTICLE_FS, transparent: true, depthWrite: false }));
    this.pts.frustumCulled = false;
    this.ptsCap = N;
    this.scene.add(this.pts);
  }
  initDom() {
    const d = document.createElement('div');
    d.id = 'world-ui';
    this.cv.parentElement.insertBefore(d, this.cv.nextSibling);
    this.dom = d;
    this.plates = new Map();
    this.floats = [];
  }
  buildTerrain() {
    const map = this.view.map, W = map.W, H = map.H;
    this.hts = new Float32Array(W * H);
    const box = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    const mesh = new THREE.InstancedMesh(box, lam('#ffffff'), W * H);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(W * H * 3), 3);
    mesh.receiveShadow = true; mesh.castShadow = true; mesh.frustumCulled = false;
    let i = 0;
    const tuft = this.p.tuft, flower = this.p.flower;
    tuft.begin(); flower.begin();
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const t = map.tile(x, y), h0 = hash(x, y, 9);
        let h = TILE_H[t];
        if (t === T.MOUNTAIN) h += hash(x, y, 4) * 1.3 + (map.tile(x - 1, y) === T.MOUNTAIN && map.tile(x + 1, y) === T.MOUNTAIN && map.tile(x, y - 1) === T.MOUNTAIN && map.tile(x, y + 1) === T.MOUNTAIN ? 0.8 : 0);
        else if (t === T.ROCKY) h += h0 * 0.15;
        this.hts[map.idx(x, y)] = h;
        V.set(x + 0.5, -1.5, y + 0.5); S3.set(1, h + 1.5, 1); M4.compose(V, Q.identity(), S3);
        mesh.setMatrixAt(i, M4);
        C.set(TILE_COL[t] || TILES[t].c).multiplyScalar(t === T.MOUNTAIN || t === T.ROCKY || t === T.WALL ? 0.85 + h0 * 0.25 : 0.96 + h0 * 0.08);
        if (t === T.MOUNTAIN && h > 2) C.lerp(new THREE.Color('#e9edf0'), 0.35);
        mesh.setColorAt(i++, C);
        if ((t === T.GRASS || t === T.FOREST) && h0 < 0.55) {
          const n = 1 + Math.floor(hash(x, y, 13) * 3);
          for (let k = 0; k < n; k++) tuft.add(x + 0.15 + hash(x, y, 20 + k) * 0.7, h, y + 0.15 + hash(x, y, 30 + k) * 0.7, 1, 0.7 + hash(x, y, 40 + k) * 0.8, 1, 0, C.set(TILES[t].c).multiplyScalar(1.25 + hash(x, y, 50 + k) * 0.3).getHex());
          if (t === T.GRASS && hash(x, y, 21) < 0.08) flower.add(x + 0.2 + hash(x, y, 22) * 0.6, h + 0.08, y + 0.2 + hash(x, y, 23) * 0.6, 1, 1, 1, 0, ['#f3e37a', '#f7a8c9', '#ffffff', '#b9a4ff'][Math.floor(hash(x, y, 24) * 4)]);
        }
      }
    tuft.end(); flower.end();
    this.scene.add(mesh);
    this.terrain = mesh;
    const water = new THREE.Mesh(new THREE.PlaneGeometry(W + 40, H + 40).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#2a6aa2', transparent: true, opacity: 0.62, roughness: 0.12, metalness: 0.2 }));
    water.position.set(W / 2, WATER_Y, H / 2);
    water.receiveShadow = true;
    this.scene.add(water);
    this.water = water;
    this.terrainBuilt = true;
  }
  /** Height creatures stand at on a tile. */
  gy(x, y) {
    const m = this.view.map;
    x = Math.floor(x); y = Math.floor(y);
    if (!m.inb(x, y)) return 0;
    return this.hts[m.idx(x, y)];
  }
  surfY(x, y) { return Math.max(this.gy(x, y), WATER_Y) + 0.025; }

  // ------------------------------------------------------------ world objects
  scanObjects(S) {
    const sig = [];
    for (const e of Object.values(S.entities)) if (e.kind === 'object' && STATIC.has(e.type)) sig.push(e.id, e.type, e.picked ? 1 : 0, e.herb || '');
    const s = sig.join('|');
    if (s !== this.staticSig) { this.staticSig = s; this.rebuildStatic(S); }
    // dynamic (few, individually modelled)
    const seen = new Set();
    for (const e of Object.values(S.entities)) {
      if (e.kind !== 'object' || STATIC.has(e.type)) continue;
      seen.add(e.id);
      const key = [e.type, e.lit, e.liquid, e.locked, e.items?.[0]?.id].join('|');
      let r = this.dyn.get(e.id);
      if (r && r.key === key) continue;
      if (r) this.scene.remove(r.g);
      const g = buildObject(e);
      g.position.set(e.x + 0.5, this.gy(e.x, e.y), e.y + 0.5);
      g.rotation.y = (hash(e.x, e.y, 5) - 0.5) * 0.6;
      g.userData.eid = e.id;
      g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      this.scene.add(g);
      this.dyn.set(e.id, { g, key, e });
    }
    for (const [id, r] of this.dyn) if (!seen.has(id)) { this.scene.remove(r.g); this.dyn.delete(id); }
  }
  rebuildStatic(S) {
    const p = this.p, map = this.view.map;
    for (const k of ['trunk', 'round', 'pine', 'stump', 'rock', 'bush', 'herb']) p[k].begin();
    for (const e of Object.values(S.entities)) {
      if (e.kind !== 'object' || !STATIC.has(e.type)) continue;
      const x = e.x + 0.5, z = e.y + 0.5, y = this.gy(e.x, e.y), h = hash(e.x, e.y, 77), h2 = hash(e.x, e.y, 78);
      const s = 0.85 + h * 0.45;
      switch (e.type) {
        case 'tree': case 'burning_tree': {
          const burning = e.type === 'burning_tree';
          const pine = map.tile(e.x, e.y) === T.FOREST;
          p.trunk.add(x, y, z, s, pine ? 0.55 * s : 0.75 * s, s, 0, burning ? '#3b2a1a' : '#6b4526', e.id);
          if (pine) {
            const c = burning ? '#3d3020' : C.setHSL(0.33 + h2 * 0.05, 0.45, 0.22 + h * 0.06).getHex();
            p.pine.add(x, y + 0.4 * s, z, s, s, s, h * 6, c, e.id);
            p.pine.add(x, y + 0.85 * s, z, s * 0.72, s * 0.8, s * 0.72, h * 3, c, e.id);
          } else {
            const c = burning ? '#4a3a20' : C.setHSL(0.27 + h2 * 0.06, 0.5, 0.3 + h * 0.07).getHex();
            p.round.add(x, y + 0.95 * s, z, s * 1.05, s * 0.95, s * 1.05, h * 6, c, e.id);
            p.round.add(x + 0.18 * s, y + 0.75 * s, z - 0.1, s * 0.6, s * 0.6, s * 0.6, h2 * 6, c, e.id);
          }
          break;
        }
        case 'burnt_tree': p.trunk.add(x, y, z, s * 0.9, 0.85 * s, s * 0.9, 0, '#1f1a16', e.id); break;
        case 'stump': p.stump.add(x, y, z, 1, 1, 1, h * 6); break;
        case 'rock': case 'ore': case 'sulfur_rock': {
          const c = e.type === 'ore' ? '#9a7462' : e.type === 'sulfur_rock' ? '#b8ae62' : e.flinty ? '#7b858c' : '#8e9092';
          p.rock.add(x, y + 0.18, z, s, 0.75 * s, s, h * 6, c, e.id, h2, 0);
          break;
        }
        case 'bush':
          p.bush.add(x, y + 0.2, z, 1.1, 0.75, 1.1, h * 6, C.setHSL(0.3, 0.45, 0.28 + h * 0.06).getHex());
          if (!e.picked) for (let k = 0; k < 4; k++) p.herb.add(x + (hash(e.x, e.y, k) - 0.5) * 0.45, y + 0.28 + hash(e.x, e.y, k + 9) * 0.12, z + (hash(e.x, e.y, k + 4) - 0.5) * 0.45, 1, 1, 1, 0, ITEMS[e.herb]?.c || '#fff');
          break;
      }
    }
    for (const k of ['trunk', 'round', 'pine', 'stump', 'rock', 'bush', 'herb']) p[k].end();
  }
  rebuildSurfaces(S) {
    const map = this.view.map;
    for (const p of Object.values(this.surf)) p.begin();
    this.p.steam.begin(); this.p.elec.begin(); this.p.smoke.begin();
    this.fireTiles = [];
    for (const [k, s] of Object.entries(S.surfaces)) {
      const x = k % map.W, y = (k / map.W) | 0, sy = this.surfY(x, y);
      if (s.type === 'smoke') {
        for (let i = 0; i < 3; i++) this.p.smoke.add(x + 0.25 + hash(x, y, i) * 0.5, sy + 0.3 + i * 0.35, y + 0.25 + hash(x, y, i + 3) * 0.5, 1 + i * 0.25, 0.85, 1 + i * 0.25, hash(x, y, i + 7) * 6);
      } else if (s.type === 'steam') {
        for (let i = 0; i < 2; i++) this.p.steam.add(x + 0.3 + hash(x, y, i) * 0.4, sy + 0.35 + i * 0.3, y + 0.3 + hash(x, y, i + 3) * 0.4, 1 + i * 0.3, 0.8, 1 + i * 0.3);
      } else if (this.surf[s.type]) this.surf[s.type].add(x + 0.5, sy + (s.type === 'ice' ? 0.01 : 0), y + 0.5);
      if (s.e) this.p.elec.add(x + 0.5, sy + 0.02, y + 0.5);
      if (s.type === 'fire') this.fireTiles.push([x, y]);
    }
    for (const p of Object.values(this.surf)) p.end();
    this.p.steam.end(); this.p.elec.end(); this.p.smoke.end();
  }

  // ------------------------------------------------------------ creatures
  updateCreatures(S, t, dt) {
    const seen = new Set();
    const tx = this.cam.x, ty = this.cam.y;
    const active = S.combat?.active;
    let ringAt = null;
    for (const e of Object.values(S.entities)) {
      if (e.kind !== 'player' && e.kind !== 'enemy' && e.kind !== 'npc') continue;
      const p = this.rpos.get(e.id) || e;
      if (Math.abs(p.x - tx) > 45 || Math.abs(p.y - ty) > 45) continue;
      seen.add(e.id);
      const key = [e.type, e.cls, e.color, e.eq?.offhand?.id].join('|');
      let r = this.creatures.get(e.id);
      if (!r || r.key !== key) {
        if (r) this.scene.remove(r.g);
        r = buildCreature(e);
        r.key = key;
        r.g.userData.eid = e.id;
        r.y = this.gy(p.x + 0.5, p.y + 0.5);
        r.face = hash(e.x, e.y, 3) * 6;
        this.scene.add(r.g);
        this.creatures.set(e.id, r);
      }
      const gx = p.x + 0.5, gz = p.y + 0.5;
      const ground = this.gy(gx, gz);
      r.y += (ground - r.y) * Math.min(1, dt * 10);
      const mdx = gx - r.g.position.x, mdz = gz - r.g.position.z;
      if (mdx * mdx + mdz * mdz > 0.0004) r.face = Math.atan2(mdx, mdz);
      let da = r.face - r.g.rotation.y;
      da = Math.atan2(Math.sin(da), Math.cos(da));
      r.g.rotation.y += da * Math.min(1, dt * 10);
      r.g.position.set(gx, r.y, gz);
      const lying = e.dead || e.downed;
      r.inner.rotation.z += ((lying ? Math.PI / 2 : 0) - r.inner.rotation.z) * Math.min(1, dt * 6);
      r.inner.position.y = lying ? 0.2 : r.float ? 0.35 + Math.sin(t * 2.5 + e.x) * 0.12 : Math.abs(Math.sin(t * 9)) * (mdx * mdx + mdz * mdz > 0.0004 ? 0.06 : 0);
      if (r.squash) r.inner.scale.set(1 + Math.sin(t * 4) * 0.06, 1 - Math.sin(t * 4) * 0.06, 1 + Math.sin(t * 4) * 0.06);
      r.ice.visible = !!e.st?.frozen;
      if (e.id === active && !e.dead) ringAt = [gx, r.y, gz];
    }
    for (const [id, r] of this.creatures) if (!seen.has(id)) { this.scene.remove(r.g); this.creatures.delete(id); }
    this.ring.visible = !!ringAt;
    if (ringAt) { this.ring.position.set(ringAt[0], ringAt[1] + 0.04, ringAt[2]); const s = 1 + Math.sin(t * 6) * 0.08; this.ring.scale.set(s, 1, s); }
  }

  // ------------------------------------------------------------ dynamic flames & lights
  updateFlames(S, t) {
    const fl = this.p.flame;
    fl.begin();
    const near = (x, y) => Math.abs(x - this.cam.x) < 32 && Math.abs(y - this.cam.y) < 32;
    const flame = (x, y, z, s, i) => {
      const k = 0.75 + 0.35 * Math.sin(t * 11 + i * 1.7 + x * 3.1);
      fl.add(x, y, z, s, s * k * 1.3, s, 0, i % 3 === 0 ? '#ffb030' : i % 3 === 1 ? '#ff5a10' : '#e8340c');
    };
    const lightCands = [];
    for (const [x, y] of this.fireTiles || []) {
      if (!near(x, y)) continue;
      const sy = this.surfY(x, y);
      for (let i = 0; i < 3; i++) flame(x + 0.2 + hash(x, y, i) * 0.6, sy, y + 0.2 + hash(x, y, i + 5) * 0.6, 0.9 + hash(x, y, i + 9) * 0.6, i + x);
      lightCands.push([x + 0.5, sy + 0.6, y + 0.5, 1]);
    }
    for (const e of Object.values(S.entities)) {
      if (e.kind === 'object') {
        if (e.type === 'burning_tree' && near(e.x, e.y)) {
          const y = this.gy(e.x, e.y);
          for (let i = 0; i < 4; i++) flame(e.x + 0.25 + hash(e.x, e.y, i) * 0.5, y + 0.5 + hash(e.x, e.y, i + 2) * 0.7, e.y + 0.25 + hash(e.x, e.y, i + 4) * 0.5, 1.6, i);
          lightCands.push([e.x + 0.5, y + 1.2, e.y + 0.5, 1.4]);
        } else if ((e.type === 'campfire' || e.type === 'forge') && e.lit && near(e.x, e.y)) {
          const y = this.gy(e.x, e.y) + (e.type === 'forge' ? 0.32 : 0.08);
          for (let i = 0; i < 3; i++) flame(e.x + 0.38 + i * 0.12, y, e.y + 0.45 + (i % 2) * 0.1, e.type === 'forge' ? 0.7 : 1.3, i);
          lightCands.push([e.x + 0.5, y + 0.6, e.y + 0.5, 1.3]);
        }
      } else if (e.eq?.offhand?.id === 'lit_torch' && !e.dead && this.creatures.has(e.id)) {
        const r = this.creatures.get(e.id);
        V.set(-0.3, 0.98, 0.12).applyEuler(r.g.rotation).add(r.g.position);
        flame(V.x, V.y, V.z, 0.75, 1);
        lightCands.push([V.x, V.y + 0.3, V.z, 1.1, e.id]);
      }
      if (e.kind !== 'object' && e.st?.burning && !e.dead) {
        const p = this.rpos.get(e.id) || e;
        const y = this.gy(p.x + 0.5, p.y + 0.5);
        for (let i = 0; i < 3; i++) flame(p.x + 0.35 + i * 0.15, y + 0.4 + (i % 2) * 0.2, p.y + 0.5, 1.1, i);
        lightCands.push([p.x + 0.5, y + 0.8, p.y + 0.5, 0.8]);
      }
    }
    fl.end();
    // assign point lights to nearest distinct sources
    if (t - (this.lightT || 0) > 0.3) {
      this.lightT = t;
      lightCands.sort((a, b) => Math.hypot(a[0] - this.cam.x, a[2] - this.cam.y) - Math.hypot(b[0] - this.cam.x, b[2] - this.cam.y));
      const chosen = [];
      for (const c of lightCands) { if (chosen.length >= this.lights.length) break; if (chosen.every((o) => Math.hypot(o[0] - c[0], o[2] - c[2]) > 2.5)) chosen.push(c); }
      this.lightSrc = chosen;
    }
    this.lights.forEach((l, i) => {
      const c = this.lightSrc?.[i];
      if (!c) { l.intensity = 0; return; }
      const carrier = c[4] && this.creatures.get(c[4]);
      if (carrier) l.position.copy(V.set(-0.3, 1.25, 0.12).applyEuler(carrier.g.rotation).add(carrier.g.position));
      else l.position.set(c[0], c[1], c[2]);
      l.intensity = (4 + Math.sin(t * 13 + i) * 0.8 + Math.sin(t * 7.3 + i * 2) * 0.6) * c[3];
    });
    // electricity flicker
    this.p.elec.mesh.material.opacity = 0.12 + Math.random() * 0.35;
  }

  // ------------------------------------------------------------ overlays
  updateOverlay() {
    const ov = this.overlay;
    if (ov === this.lastOv) return;
    this.lastOv = ov;
    const { range, aoe, path } = this.p;
    range.begin(); aoe.begin(); path.begin();
    const L = ov?.light ? lightMap(this.view.state, this.view.map) : null;
    if (ov?.rangeTiles) for (const [x, y] of ov.rangeTiles) if (this.view.map.inb(x, y)) range.add(x + 0.5, this.surfY(x, y) + 0.02, y + 0.5, 1, 1, 1, 0, L ? ['#2a3cff', '#8a94b8', '#fff2c0'][L[this.view.map.idx(x, y)]] : '#ffffff');
    if (ov?.aoe) for (const [x, y] of ov.aoe) if (this.view.map.inb(x, y)) aoe.add(x + 0.5, this.surfY(x, y) + 0.03, y + 0.5);
    aoe.mesh.material.color.set(ov?.valid === false ? '#ff4040' : '#ffc850');
    if (ov?.path) ov.path.forEach(([x, y], i) => path.add(x + 0.5, this.surfY(x, y) + 0.03, y + 0.5, i === ov.path.length - 1 ? 1.8 : 1, 1, i === ov.path.length - 1 ? 1.8 : 1, 0, i < ov.reach ? '#78e68c' : '#ff5a5a'));
    range.end(); aoe.end(); path.end();
  }

  // ------------------------------------------------------------ picking
  screenToTile(sx, sy) {
    const map = this.view.map;
    if (!map || !this.terrainBuilt) return [0, 0];
    const nd = new THREE.Vector2((sx / innerWidth) * 2 - 1, -(sy / innerHeight) * 2 + 1);
    this.raycaster.setFromCamera(nd, this.camera);
    const objs = [...this.pickPools.map((p) => p.mesh), ...[...this.creatures.values()].map((r) => r.g), ...[...this.dyn.values()].map((r) => r.g)];
    const hits = this.raycaster.intersectObjects(objs, true);
    for (const h of hits) {
      if (h.instanceId != null) {
        const pool = this.pickPools.find((p) => p.mesh === h.object);
        const id = pool?.ids[h.instanceId];
        const e = id && this.view.state.entities[id];
        if (e) return [e.x, e.y];
      } else {
        let o = h.object;
        while (o && o.userData.eid == null) o = o.parent;
        const e = o && this.view.state.entities[o.userData.eid];
        if (e) return [e.x, e.y];
      }
    }
    const ray = this.raycaster.ray;
    let hgt = 0, tx = 0, ty = 0;
    for (let i = 0; i < 5; i++) {
      const tt = (hgt - ray.origin.y) / ray.direction.y;
      const px = ray.origin.x + ray.direction.x * tt, pz = ray.origin.z + ray.direction.z * tt;
      tx = Math.floor(px); ty = Math.floor(pz);
      const nh = Math.max(this.gy(tx, ty), WATER_Y);
      if (Math.abs(nh - hgt) < 0.01) break;
      hgt = nh;
    }
    return [tx, ty];
  }
  /** Tile coords (may be fractional, e.g. x+0.5) → CSS pixel position. */
  tileToScreen(x, y, lift = 0.5) {
    V.set(x, this.gy(x, y) + lift, y).project(this.camera);
    return [(V.x + 1) / 2 * innerWidth, (1 - V.y) / 2 * innerHeight, V.z < 1];
  }

  // ------------------------------------------------------------ effects
  addFx(f) {
    const now = performance.now();
    const W = (x, y, lift = 0.8) => new THREE.Vector3(x + 0.5, this.gy(x + 0.5, y + 0.5) + lift, y + 0.5);
    const add = (obj, dur, upd) => { if (obj) this.scene.add(obj); this.fx.push({ obj, t0: now, dur, upd }); };
    switch (f.type) {
      case 'float': this.addFloat(f); return;
      case 'banner': this.showBanner(f.text); return;
      case 'shake': this.shake = Math.max(this.shake, f.p * 0.012); return;
      case 'puff': for (let i = 0; i < 10; i++) this.particle(W(f.x, f.y, 0.3), '#f4f7fa', 0.8, 1.4, 0.6, 26); return;
      case 'flare': setTimeout(() => { for (let i = 0; i < 6; i++) this.particle(W(f.x, f.y, 0.2), i % 2 ? '#ffb347' : '#ff5a1f', 1.2, 0.7, 1.6, 18); }, f.delay || 0); return;
      case 'chips': for (let i = 0; i < 10; i++) this.particle(W(f.x, f.y, 0.5), f.c, 1.8, 0.6, 1.2, 9, -6); return;
      case 'debris': for (let i = 0; i < 16; i++) this.particle(W(f.x, f.y, 0.4), '#9a6a3a', 2.4, 0.8, 2, 12, -7); return;
      case 'craft': for (let i = 0; i < 14; i++) this.particle(W(f.x, f.y, 1), f.c || '#ffd86b', 0.9, 0.9, 1.2, 9); return;
      case 'levelup': for (let i = 0; i < 40; i++) this.particle(W(f.x, f.y, 0.2), '#ffd86b', 1.2, 1.4, 2.2, 10); return;
      case 'rain': for (let i = 0; i < 90; i++) setTimeout(() => this.particle(new THREE.Vector3(f.x + 0.5 + (Math.random() - 0.5) * 5, 4, f.y + 0.5 + (Math.random() - 0.5) * 5), '#9fd0ff', 0.05, 0.6, -6, 7, 0), i * 8); return;
      case 'proj': case 'throw': {
        const a = W(f.fx, f.fy, 0.8), b = W(f.tx, f.ty, f.type === 'throw' ? 0.2 : 0.7);
        const dur = f.ms || 120 + a.distanceTo(b) * 40;
        const m = new THREE.Mesh(f.type === 'throw' ? new THREE.BoxGeometry(0.16, 0.2, 0.16) : new THREE.SphereGeometry(f.big ? 0.16 : 0.08, 8, 6), basic(f.c || '#fff'));
        add(m, dur, (k) => {
          m.position.lerpVectors(a, b, k);
          if (f.type === 'throw') { m.position.y += Math.sin(k * Math.PI) * 1.6; m.rotation.x += 0.3; m.rotation.z += 0.2; }
          else if (Math.random() < 0.6) this.particle(m.position.clone(), f.c || '#fff', 0.1, 0.25, 0, f.big ? 14 : 7, 0);
        });
        return;
      }
      case 'beam': {
        const a = W(f.fx, f.fy, 0.8), b = W(f.tx, f.ty, 0.6);
        const len = a.distanceTo(b);
        const m = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, len, 6).rotateX(Math.PI / 2), basic(f.c, { transparent: true, blending: THREE.AdditiveBlending }));
        m.position.lerpVectors(a, b, 0.5); m.lookAt(b);
        add(m, 350, (k) => { m.material.opacity = 1 - k; m.scale.set(1 - k * 0.5, 1 - k * 0.5, 1); });
        return;
      }
      case 'bolt': {
        const a = W(f.fx, f.fy, 0.8), b = W(f.tx, f.ty, 0.6);
        const g = new THREE.BufferGeometry().setFromPoints(Array.from({ length: 9 }, () => new THREE.Vector3()));
        const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: f.c, transparent: true }));
        add(line, 380, (k) => {
          const pos = g.attributes.position;
          for (let i = 0; i < 9; i++) { V.lerpVectors(a, b, i / 8); if (i && i < 8) V.add(new THREE.Vector3((Math.random() - 0.5) * 0.5, (Math.random() - 0.5) * 0.5, (Math.random() - 0.5) * 0.5)); pos.setXYZ(i, V.x, V.y, V.z); }
          pos.needsUpdate = true; line.material.opacity = 1 - k;
        });
        this.flashAt(b, '#fff59a', 4);
        return;
      }
      case 'zap': {
        const lines = (f.tiles || []).slice(0, 24).map(([x, y]) => {
          const g = new THREE.BufferGeometry().setFromPoints(Array.from({ length: 5 }, () => new THREE.Vector3()));
          const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color: '#fff59a', transparent: true }));
          l.userData.c = [x + 0.5, this.surfY(x, y) + 0.08, y + 0.5];
          return l;
        });
        const grp = new THREE.Group(); lines.forEach((l) => grp.add(l));
        add(grp, 500, (k) => lines.forEach((l) => {
          const pos = l.geometry.attributes.position, [cx, cy, cz] = l.userData.c;
          for (let i = 0; i < 5; i++) pos.setXYZ(i, cx - 0.45 + i * 0.22, cy + (Math.random() - 0.3) * 0.25, cz + (Math.random() - 0.5) * 0.5);
          pos.needsUpdate = true; l.material.opacity = 1 - k;
        }));
        return;
      }
      case 'boom': {
        const c = W(f.x, f.y, 0.4);
        const m = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), basic(f.c || '#ff7a2e', { transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
        m.position.copy(c);
        const R = f.r + 0.7;
        add(m, 550, (k) => { const s = R * (0.25 + k * 0.9); m.scale.set(s, s * 0.7, s); m.material.opacity = 0.9 * (1 - k); });
        for (let i = 0; i < 12 + f.r * 14; i++) this.particle(c.clone(), i % 2 ? '#ffd27a' : f.c || '#ff6a1c', 1.6 + f.r, 0.7, 2.5, 16, -4);
        for (let i = 0; i < 6 + f.r * 5; i++) this.particle(c.clone(), '#555049', 0.8 + f.r * 0.5, 1.6, 1.4, 30, 0.6);
        this.flashAt(c, f.c || '#ffb060', 10 + f.r * 6);
        return;
      }
      case 'splash': {
        const m = new THREE.Mesh(new THREE.RingGeometry(0.8, 1, 24).rotateX(-Math.PI / 2), basic(f.c, { transparent: true, side: THREE.DoubleSide, depthWrite: false }));
        m.position.copy(W(f.x, f.y, 0.08));
        const R = (f.r || 0) + 0.5;
        add(m, 450, (k) => { const s = R * (0.3 + k); m.scale.set(s, 1, s); m.material.opacity = 1 - k; });
        for (let i = 0; i < 10; i++) this.particle(W(f.x, f.y, 0.2), f.c, 1.2, 0.5, 2, 10, -6);
        return;
      }
      case 'hit': {
        const m = new THREE.Mesh(new THREE.SphereGeometry(0.35, 10, 8), basic('#ffffff', { transparent: true, depthWrite: false }));
        m.position.copy(W(f.x, f.y, 0.6));
        add(m, 180, (k) => { m.material.opacity = 0.7 * (1 - k); m.scale.setScalar(1 + k); });
        return;
      }
      case 'swing': {
        const m = new THREE.Mesh(new THREE.TorusGeometry(0.6, 0.035, 4, 16, Math.PI * 0.9).rotateX(Math.PI / 2), basic('#ffffff', { transparent: true, depthWrite: false }));
        m.position.copy(W(f.x, f.y, 0.65));
        const ang = f.tx != null ? Math.atan2(f.tx - f.x, f.ty - f.y) : 0;
        add(m, 220, (k) => { m.rotation.y = ang - 0.9 + k * 1.4; m.material.opacity = 1 - k; });
        return;
      }
      case 'ping': {
        const grp = new THREE.Group();
        const ring = new THREE.Mesh(new THREE.RingGeometry(0.4, 0.5, 24).rotateX(-Math.PI / 2), basic(f.c || '#fff', { transparent: true, side: THREE.DoubleSide, depthWrite: false }));
        const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 4, 6).translate(0, 2, 0), basic(f.c || '#fff', { transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending }));
        grp.add(ring, beam);
        grp.position.copy(W(f.x, f.y, 0.05));
        add(grp, 2500, (k) => { const s = 1 + ((k * 5) % 1) * 1.5; ring.scale.set(s, 1, s); ring.material.opacity = 1 - k; beam.material.opacity = 0.6 * (1 - k); });
        return;
      }
    }
  }
  flashAt(v, color, intensity) { this.flash.position.copy(v).add(new THREE.Vector3(0, 0.6, 0)); this.flash.color.set(color); this.flash.intensity = intensity; }
  particle(pos, color, spread, life, vy, size, grav = -1.2) {
    if (this.parts.length >= this.ptsCap) return;
    const a = Math.random() * Math.PI * 2, sp = Math.random() * spread;
    this.parts.push({ p: pos, v: new THREE.Vector3(Math.cos(a) * sp, vy * (0.5 + Math.random() * 0.5), Math.sin(a) * sp), c: new THREE.Color(color), life, t: 0, size, grav });
  }
  updateParticles(dt) {
    const g = this.pts.geometry, P = g.attributes.position, Cc = g.attributes.pcolor, Sz = g.attributes.size, A = g.attributes.alpha;
    let n = 0;
    this.parts = this.parts.filter((q) => (q.t += dt) < q.life);
    for (const q of this.parts) {
      q.v.y += q.grav * dt;
      q.p.addScaledVector(q.v, dt);
      P.setXYZ(n, q.p.x, q.p.y, q.p.z); Cc.setXYZ(n, q.c.r, q.c.g, q.c.b); Sz.setX(n, q.size * 0.01); A.setX(n, 1 - q.t / q.life);
      n++;
    }
    g.setDrawRange(0, n);
    P.needsUpdate = Cc.needsUpdate = Sz.needsUpdate = A.needsUpdate = true;
  }
  addFloat(f) {
    const d = document.createElement('div');
    d.className = 'wfloat';
    d.textContent = f.text;
    d.style.color = f.c || '#fff';
    this.dom.appendChild(d);
    this.floats.push({ d, x: f.x + 0.5, y: f.y + 0.5, t0: performance.now(), jitter: (Math.random() - 0.5) * 0.4 });
  }
  showBanner(text) {
    const b = document.createElement('div');
    b.className = 'wbanner ' + (text === 'Victory' ? 'win' : text === 'Defeated' ? 'lose' : '');
    b.textContent = text;
    this.dom.appendChild(b);
    setTimeout(() => b.remove(), 2000);
  }

  // ------------------------------------------------------------ DOM nameplates
  updatePlates(S) {
    const seen = new Set();
    const myId = this.view.myEid;
    for (const [id, r] of this.creatures) {
      const e = S.entities[id];
      if (!e || e.dead) continue;
      const p = this.rpos.get(id) || e;
      if (Math.abs(p.x - this.cam.x) > 22 / Math.min(1, this.cam.zoom) || Math.abs(p.y - this.cam.y) > 22 / Math.min(1, this.cam.zoom)) continue;
      V.set(p.x + 0.5, r.y + r.h + 0.25, p.y + 0.5).project(this.camera);
      if (V.z > 1 || Math.abs(V.x) > 1.1 || Math.abs(V.y) > 1.1) continue;
      seen.add(id);
      let pl = this.plates.get(id);
      if (!pl) { pl = { d: document.createElement('div'), key: '' }; pl.d.className = 'plate'; this.dom.appendChild(pl.d); this.plates.set(id, pl); }
      const key = [e.hp, e.maxHp, JSON.stringify(e.st || {}), e.downed, e.online, e.name, id === myId].join('|');
      if (key !== pl.key) {
        pl.key = key;
        const isP = e.kind === 'player', npc = e.kind === 'npc';
        pl.d.className = 'plate ' + (isP ? 'pl' : npc ? 'np' : 'en') + (id === myId ? ' me' : '');
        pl.d.innerHTML = (isP || npc || ENEMIES[e.type]?.boss ? `<b>${esc(e.name)}${isP && !e.online ? ' (offline)' : ''}${e.downed ? ' — DOWN' : ''}</b>` : '') +
          (npc ? '' : `<i><s style="width:${(100 * Math.max(0, e.hp)) / e.maxHp}%"></s></i>`) +
          `<span>${Object.keys(e.st || {}).map((s) => `<em style="background:${STATUS[s].c}"></em>`).join('')}</span>`;
      }
      pl.d.style.transform = `translate(${((V.x + 1) / 2) * innerWidth}px, ${((1 - V.y) / 2) * innerHeight}px) translate(-50%, -100%)`;
    }
    for (const [id, pl] of this.plates) if (!seen.has(id)) { pl.d.remove(); this.plates.delete(id); }
    const now = performance.now();
    this.floats = this.floats.filter((f) => {
      const age = (now - f.t0) / 1000;
      if (age > 1.4) { f.d.remove(); return false; }
      V.set(f.x + f.jitter, this.gy(f.x, f.y) + 1.4 + age * 0.9, f.y).project(this.camera);
      f.d.style.transform = `translate(${((V.x + 1) / 2) * innerWidth}px, ${((1 - V.y) / 2) * innerHeight}px) translate(-50%, -50%)`;
      f.d.style.opacity = Math.min(1, 2 * (1.4 - age));
      return true;
    });
  }

  // ------------------------------------------------------------ main frame
  frame(dt, now) {
    const v = this.view;
    if (!v.state || !v.map) return;
    if (!this.terrainBuilt) this.buildTerrain();
    const S = v.state, t = now / 1000;
    for (const e of Object.values(S.entities)) {
      if (e.kind === 'object') continue;
      let p = this.rpos.get(e.id);
      if (!p) this.rpos.set(e.id, (p = { x: e.x, y: e.y }));
      const dx = e.x - p.x, dy = e.y - p.y;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) { p.x = e.x; p.y = e.y; }
      else { const k = Math.min(1, dt * 11); p.x += dx * k; p.y += dy * k; }
    }
    // camera
    const me = S.entities[v.myEid];
    if (me) {
      const p = this.rpos.get(me.id) || me;
      const tx = p.x + 0.5 + this.cam.ox, tz = p.y + 0.5 + this.cam.oy;
      const k = Math.hypot(tx - this.cam.x, tz - this.cam.y) > 12 ? 1 : Math.min(1, dt * 7);
      this.cam.x += (tx - this.cam.x) * k;
      this.cam.y += (tz - this.cam.y) * k;
    }
    const dist = 17 / this.cam.zoom;
    const ty = this.gy(this.cam.x, this.cam.y) * 0.5 + 0.3;
    const cp = Math.cos(this.cam.pitch);
    let sx = 0, sy = 0;
    if (this.shake > 0.005) { sx = (Math.random() - 0.5) * this.shake; sy = (Math.random() - 0.5) * this.shake; this.shake *= 0.88; } else this.shake = 0;
    this.camera.position.set(this.cam.x + Math.sin(this.cam.yaw) * cp * dist + sx, ty + Math.sin(this.cam.pitch) * dist + sy, this.cam.y + Math.cos(this.cam.yaw) * cp * dist);
    this.camera.lookAt(this.cam.x + sx, ty, this.cam.y);
    this.scene.fog.near = dist + 6; this.scene.fog.far = dist + 42;
    this.sun.position.set(this.cam.x - 14, 26, this.cam.y + 9);
    this.sun.target.position.set(this.cam.x, 0, this.cam.y);
    // combat mood
    const inCombat = !!S.combat;
    this.cv.parentElement.classList.toggle('in-combat', inCombat);
    const dl = daylight(S.time ?? 540);
    const sky = new THREE.Color('#0b1220').lerp(new THREE.Color(inCombat ? '#a39a96' : '#9bb7c9'), dl).lerp(new THREE.Color('#c9825a'), 4 * dl * (1 - dl) * 0.55);
    this.scene.background.lerp(sky, Math.min(1, dt * 2));
    this.scene.fog.color.copy(this.scene.background);
    this.sun.intensity = 0.45 + 2.15 * dl;
    this.sun.color.set('#7f98ff').lerp(C.set('#fff0d8'), dl).lerp(C.set('#ffad6b'), 4 * dl * (1 - dl) * 0.6);
    this.hemi.intensity = 0.55 + 0.95 * dl;
    this.hemi.color.set('#5a6c9a').lerp(C.set('#dfeaff'), dl);
    this.gl.toneMappingExposure = 0.95 + 0.1 * dl;
    if (this.showLight && now - (this.lightOvT || 0) > 300) {
      this.lightOvT = now;
      const L = lightMap(S, v.map), lo = this.p.lightOv;
      lo.begin();
      for (let y = Math.max(0, Math.floor(this.cam.y) - 24); y < Math.min(v.map.H, this.cam.y + 24); y++)
        for (let x = Math.max(0, Math.floor(this.cam.x) - 24); x < Math.min(v.map.W, this.cam.x + 24); x++) {
          const l = L[v.map.idx(x, y)];
          if (l < 2 && v.map.tilePass(x, y)) lo.add(x + 0.5, this.surfY(x, y) + 0.015, y + 0.5, 1, 1, 1, 0, l ? '#5a6488' : '#1a2a9a');
        }
      lo.end();
    } else if (!this.showLight && this.p.lightOv.mesh.count) { this.p.lightOv.begin(); this.p.lightOv.end(); }

    if (now - this.lastScan > 250) {
      this.lastScan = now;
      this.scanObjects(S);
      const ss = JSON.stringify(S.surfaces);
      if (ss !== this.surfSig) { this.surfSig = ss; this.rebuildSurfaces(S); }
    }
    this.updateCreatures(S, t, dt);
    this.updateFlames(S, t);
    this.updateOverlay();
    if (this.hover && v.map.inb(...this.hover)) {
      this.hoverMesh.visible = true;
      this.hoverMesh.position.set(this.hover[0] + 0.5, this.surfY(...this.hover) + 0.03, this.hover[1] + 0.5);
    } else this.hoverMesh.visible = false;
    // pulse lit dynamic objects (forge glow) and steam drift
    this.p.steam.mesh.position.y = Math.sin(t * 1.5) * 0.05;
    this.water.material.opacity = 0.6 + Math.sin(t * 0.8) * 0.03;
    this.flash.intensity *= Math.pow(0.02, dt);
    // fx
    this.fx = this.fx.filter((f) => {
      const k = Math.min(1, (now - f.t0) / f.dur);
      f.upd?.(k, dt);
      if (k >= 1) { if (f.obj) { this.scene.remove(f.obj); f.obj.traverse?.((o) => { o.geometry?.dispose(); o.material?.dispose?.(); }); } return false; }
      return true;
    });
    this.updateParticles(dt);
    this.gl.render(this.scene, this.camera);
    this.updatePlates(S);
  }
}

// ================================================================ model builders
const G = {
  torso: new THREE.CylinderGeometry(0.19, 0.24, 0.52, 10),
  robe: new THREE.ConeGeometry(0.3, 0.8, 10),
  head: new THREE.SphereGeometry(0.16, 12, 10),
  leg: new THREE.BoxGeometry(0.1, 0.32, 0.11),
  arm: new THREE.BoxGeometry(0.08, 0.38, 0.08),
  blade: new THREE.BoxGeometry(0.04, 0.6, 0.09),
  hood: new THREE.ConeGeometry(0.2, 0.32, 10),
  horn: new THREE.ConeGeometry(0.05, 0.22, 6),
  staff: new THREE.CylinderGeometry(0.025, 0.03, 1.2, 6),
  orb: new THREE.SphereGeometry(0.09, 10, 8),
  shield: new THREE.CylinderGeometry(0.22, 0.22, 0.05, 14),
  bow: new THREE.TorusGeometry(0.32, 0.018, 4, 16, Math.PI),
  flask: new THREE.SphereGeometry(0.06, 8, 6),
  pack: new THREE.BoxGeometry(0.3, 0.32, 0.16),
  ice: new THREE.BoxGeometry(0.75, 1.15, 0.75).translate(0, 0.57, 0),
};
const mesh = (geo, mat, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.set(rx, ry, rz); m.castShadow = true; return m; };
const ICE_MAT = new THREE.MeshStandardMaterial({ color: '#cdeeff', transparent: true, opacity: 0.55, roughness: 0.05 });

function humanoid(inner, { body, head = '#e3b48b', legs, robe = false }) {
  const legM = lam(legs || new THREE.Color(body).multiplyScalar(0.55).getStyle());
  if (robe) inner.add(mesh(G.robe, lam(body), 0, 0.42, 0));
  else {
    inner.add(mesh(G.leg, legM, -0.09, 0.16, 0), mesh(G.leg, legM, 0.09, 0.16, 0));
    inner.add(mesh(G.torso, lam(body), 0, 0.58, 0));
  }
  inner.add(mesh(G.arm, lam(body), -0.27, 0.6, 0, 0, 0, 0.15), mesh(G.arm, lam(body), 0.27, 0.6, 0, 0, 0, -0.15));
  inner.add(mesh(G.head, lam(head), 0, 0.98, 0));
}
const sword = (inner, c = '#d8dde2') => inner.add(mesh(G.blade, lam(c), 0.33, 0.62, 0.14, 0.9, 0, 0));
const staff = (inner, orb) => { inner.add(mesh(G.staff, lam('#7a5530'), 0.33, 0.62, 0.05)); inner.add(mesh(G.orb, basic(orb), 0.33, 1.24, 0.05)); };
const bow = (inner) => inner.add(mesh(G.bow, lam('#8a5a30'), -0.32, 0.65, 0.1, 0, Math.PI / 2, Math.PI / 2));

function buildCreature(e) {
  const g = new THREE.Group(), inner = new THREE.Group();
  g.add(inner);
  const r = { g, inner, h: 1.1, float: false, squash: false };
  if (e.kind === 'player') {
    humanoid(inner, { body: e.color, robe: e.cls === 'elementalist' });
    if (e.cls === 'sellsword') sword(inner);
    const off = e.eq?.offhand?.id;
    if (off === 'wooden_shield' || off === 'iron_shield') inner.add(mesh(G.shield, lam(off === 'iron_shield' ? '#b9c0c6' : '#8a5a30'), -0.32, 0.6, 0.05, Math.PI / 2, 0, 0.1));
    if (off === 'torch' || off === 'lit_torch') inner.add(mesh(new THREE.CylinderGeometry(0.025, 0.03, 0.5, 6), lam('#6b4526'), -0.3, 0.75, 0.12, 0.25, 0, 0), mesh(new THREE.CylinderGeometry(0.05, 0.04, 0.08, 6), lam(off === 'lit_torch' ? '#3a2a1a' : '#d9cfb8'), -0.3, 0.99, 0.12));
    if (e.cls === 'ranger') { bow(inner); inner.add(mesh(G.hood, lam('#3e5a2e'), 0, 1.12, 0)); inner.add(mesh(G.pack, lam('#6b4a2a'), 0, 0.62, -0.2)); }
    if (e.cls === 'alchemist') { inner.add(mesh(G.pack, lam('#6b4a2a'), 0, 0.62, -0.2)); ['#e8435a', '#6fcf3f', '#ff9a2e'].forEach((c, i) => inner.add(mesh(G.flask, basic(c), -0.12 + i * 0.12, 0.4, 0.22))); }
    if (e.cls === 'elementalist') { staff(inner, '#c3a6ff'); inner.add(mesh(G.hood, lam('#2c2a48'), 0, 1.15, 0, 0, 0, 0)); }
  } else if (e.kind === 'npc') {
    humanoid(inner, { body: '#c9a15e' });
    inner.add(mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.03, 14), lam('#5a3a1a'), 0, 1.1, 0), mesh(new THREE.CylinderGeometry(0.15, 0.17, 0.2, 12), lam('#5a3a1a'), 0, 1.2, 0));
    inner.add(mesh(new THREE.BoxGeometry(0.4, 0.5, 0.25), lam('#7a5530'), 0, 0.68, -0.25));
  } else {
    const d = ENEMIES[e.type];
    switch (e.type) {
      case 'wolf': {
        const m = lam('#8d8d8d'), dk = lam('#6a6a6a');
        inner.add(mesh(new THREE.BoxGeometry(0.3, 0.28, 0.7), m, 0, 0.45, 0));
        inner.add(mesh(new THREE.BoxGeometry(0.24, 0.24, 0.3), m, 0, 0.58, 0.42), mesh(new THREE.BoxGeometry(0.12, 0.1, 0.16), dk, 0, 0.53, 0.62));
        inner.add(mesh(G.horn, dk, -0.08, 0.76, 0.38), mesh(G.horn, dk, 0.08, 0.76, 0.38));
        for (const [x, z] of [[-0.1, 0.25], [0.1, 0.25], [-0.1, -0.25], [0.1, -0.25]]) inner.add(mesh(new THREE.BoxGeometry(0.08, 0.32, 0.08), dk, x, 0.16, z));
        inner.add(mesh(new THREE.BoxGeometry(0.07, 0.07, 0.35), m, 0, 0.55, -0.48, 0.6, 0, 0));
        r.h = 0.8;
        break;
      }
      case 'slime': {
        inner.add(mesh(new THREE.SphereGeometry(0.4, 14, 10).scale(1, 0.75, 1).translate(0, 0.3, 0), new THREE.MeshStandardMaterial({ color: '#58b947', transparent: true, opacity: 0.75, roughness: 0.15 })));
        inner.add(mesh(new THREE.SphereGeometry(0.13, 8, 6), lam('#2e6b23'), 0, 0.3, 0));
        inner.add(mesh(new THREE.SphereGeometry(0.05, 6, 4), basic('#111'), -0.1, 0.42, 0.33), mesh(new THREE.SphereGeometry(0.05, 6, 4), basic('#111'), 0.1, 0.42, 0.33));
        r.squash = true; r.h = 0.7;
        break;
      }
      case 'frost_wisp': {
        inner.add(mesh(new THREE.SphereGeometry(0.2, 12, 10), basic('#e6f8ff'), 0, 0.5, 0));
        inner.add(mesh(new THREE.SphereGeometry(0.36, 12, 10), new THREE.MeshBasicMaterial({ color: '#8fdcff', transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false }), 0, 0.5, 0));
        const l = new THREE.PointLight('#8fdcff', 2, 4, 1.5); l.position.y = 0.5; inner.add(l);
        r.float = true; r.h = 0.9;
        break;
      }
      case 'fire_imp':
        humanoid(inner, { body: '#c9401f', head: '#e2552b' });
        inner.add(mesh(G.horn, lam('#2a1a10'), -0.08, 1.15, 0), mesh(G.horn, lam('#2a1a10'), 0.08, 1.15, 0));
        inner.scale.setScalar(0.72);
        { const l = new THREE.PointLight('#ff7a2e', 1.5, 3, 1.5); l.position.y = 0.8; inner.add(l); }
        r.h = 0.85;
        break;
      case 'skeleton':
        humanoid(inner, { body: '#e8e2cf', head: '#f0ead8', legs: '#cfc8b2' });
        inner.add(mesh(new THREE.SphereGeometry(0.035, 6, 4), basic('#111'), -0.06, 1.0, 0.14), mesh(new THREE.SphereGeometry(0.035, 6, 4), basic('#111'), 0.06, 1.0, 0.14));
        sword(inner, '#9a7a5a');
        break;
      case 'storm_cultist':
        humanoid(inner, { body: '#c9b93a', robe: true });
        inner.add(mesh(G.hood, lam('#5a5320'), 0, 1.12, 0));
        staff(inner, '#fff38a');
        break;
      case 'bandit_archer':
        humanoid(inner, { body: '#b5651d' });
        inner.add(mesh(G.hood, lam('#5a3010'), 0, 1.12, 0));
        bow(inner);
        break;
      case 'warlord':
        humanoid(inner, { body: '#8f2424', legs: '#3a2a20' });
        inner.add(mesh(G.horn, lam('#e8e2cf'), -0.12, 1.12, 0, 0, 0, 0.5), mesh(G.horn, lam('#e8e2cf'), 0.12, 1.12, 0, 0, 0, -0.5));
        inner.add(mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.1, 6), lam('#5a3a1a'), 0.35, 0.7, 0.1), mesh(new THREE.BoxGeometry(0.05, 0.35, 0.3), lam('#c9cfd4'), 0.35, 1.15, 0.22));
        inner.scale.setScalar(1.35);
        r.h = 1.5;
        break;
      default: // bandit
        humanoid(inner, { body: d.color });
        inner.add(mesh(G.hood, lam('#5a1a10'), 0, 1.12, 0));
        sword(inner);
    }
  }
  r.ice = mesh(G.ice, ICE_MAT);
  r.ice.visible = false;
  g.add(r.ice);
  return r;
}

function buildObject(e) {
  const g = new THREE.Group();
  const stone = lam('#7d7a75'), wood = lam('#7a5130'), dark = lam('#3a2a1a');
  switch (e.type) {
    case 'well':
      g.add(mesh(new THREE.CylinderGeometry(0.42, 0.45, 0.5, 14, 1, true), lam('#8a8680', { side: THREE.DoubleSide }), 0, 0.25, 0));
      g.add(mesh(new THREE.CircleGeometry(0.4, 14).rotateX(-Math.PI / 2), lam('#1d4a70'), 0, 0.3, 0));
      g.add(mesh(new THREE.BoxGeometry(0.06, 1, 0.06), wood, -0.38, 0.5, 0), mesh(new THREE.BoxGeometry(0.06, 1, 0.06), wood, 0.38, 0.5, 0));
      g.add(mesh(new THREE.ConeGeometry(0.62, 0.35, 4), lam('#8b3a2a'), 0, 1.15, 0, 0, Math.PI / 4, 0));
      break;
    case 'campfire':
      for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; g.add(mesh(new THREE.DodecahedronGeometry(0.09), stone, Math.cos(a) * 0.32, 0.06, Math.sin(a) * 0.32)); }
      g.add(mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.55, 6), wood, 0, 0.1, 0, 0, 0.6, Math.PI / 2), mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.55, 6), wood, 0, 0.12, 0, 0, -0.6, Math.PI / 2));
      if (e.lit) g.add(mesh(new THREE.CircleGeometry(0.25, 12).rotateX(-Math.PI / 2), basic('#ff8a2e'), 0, 0.03, 0));
      break;
    case 'forge':
      g.add(mesh(new THREE.BoxGeometry(0.9, 0.7, 0.85), lam('#4a4540'), 0, 0.35, 0));
      g.add(mesh(new THREE.BoxGeometry(0.35, 0.9, 0.35), lam('#3a3632'), 0.22, 1.1, -0.2));
      g.add(mesh(new THREE.PlaneGeometry(0.45, 0.25), e.lit ? basic('#ff8a2e') : basic('#151210'), 0, 0.4, 0.43));
      g.add(mesh(new THREE.BoxGeometry(0.4, 0.18, 0.2), lam('#2a2a2a'), -0.6, 0.35, 0.2)); // anvil
      break;
    case 'workbench':
      g.add(mesh(new THREE.BoxGeometry(0.95, 0.08, 0.55), lam('#9a6a3d'), 0, 0.55, 0));
      for (const [x, z] of [[-0.4, -0.22], [0.4, -0.22], [-0.4, 0.22], [0.4, 0.22]]) g.add(mesh(new THREE.BoxGeometry(0.07, 0.55, 0.07), wood, x, 0.27, z));
      g.add(mesh(new THREE.BoxGeometry(0.3, 0.04, 0.08), lam('#c0c4c8'), 0.15, 0.61, 0.05), mesh(new THREE.BoxGeometry(0.25, 0.15, 0.15), wood, -0.2, 0.66, 0));
      break;
    case 'alchemy':
      g.add(mesh(new THREE.BoxGeometry(0.95, 0.08, 0.55), lam('#5b3f63'), 0, 0.55, 0));
      for (const [x, z] of [[-0.4, -0.22], [0.4, -0.22], [-0.4, 0.22], [0.4, 0.22]]) g.add(mesh(new THREE.BoxGeometry(0.07, 0.55, 0.07), dark, x, 0.27, z));
      ['#e8435a', '#6fcf3f', '#4aa3df'].forEach((c, i) => g.add(mesh(new THREE.SphereGeometry(0.09, 10, 8), new THREE.MeshStandardMaterial({ color: c, transparent: true, opacity: 0.8, emissive: c, emissiveIntensity: 0.3 }), -0.25 + i * 0.25, 0.68, 0)));
      break;
    case 'barrel': {
      g.add(mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.72, 14), wood, 0, 0.36, 0));
      const band = { oil: '#1d150b', water: '#3a85c9', poison: '#5bc43a', powder: '#d23c3c', empty: '#555' }[e.liquid] || '#555';
      g.add(mesh(new THREE.CylinderGeometry(0.295, 0.295, 0.12, 14), lam(band), 0, 0.36, 0));
      g.add(mesh(new THREE.CylinderGeometry(0.29, 0.29, 0.03, 14), dark, 0, 0.12, 0), mesh(new THREE.CylinderGeometry(0.29, 0.29, 0.03, 14), dark, 0, 0.6, 0));
      if (e.liquid === 'powder') g.add(mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.2, 4), lam('#ddd'), 0.1, 0.8, 0));
      break;
    }
    case 'crate':
      g.add(mesh(new THREE.BoxGeometry(0.7, 0.65, 0.7), lam('#a0703d'), 0, 0.33, 0));
      g.add(new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(0.71, 0.66, 0.71)), new THREE.LineBasicMaterial({ color: '#5a3a1a' })).translateY(0.33));
      break;
    case 'chest':
      g.add(mesh(new THREE.BoxGeometry(0.75, 0.4, 0.48), lam('#7a4a22'), 0, 0.2, 0));
      g.add(mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.75, 12, 1, false, 0, Math.PI).rotateZ(Math.PI / 2).rotateX(Math.PI / 2), lam('#93602f'), 0, 0.4, 0));
      g.add(mesh(new THREE.BoxGeometry(0.1, 0.14, 0.04), lam(e.locked ? '#c0392b' : '#e8c547'), 0, 0.38, 0.25));
      break;
    case 'pile': {
      g.add(mesh(new THREE.SphereGeometry(0.2, 10, 8).scale(1, 0.7, 1), lam('#8a6a43'), 0, 0.14, 0));
      const it = e.items?.[0];
      if (it) g.add(mesh(new THREE.OctahedronGeometry(0.1), basic(ITEMS[it.id]?.c || '#fff'), 0, 0.4, 0));
      break;
    }
  }
  return g;
}
