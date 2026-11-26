// Boot: title screen, character creation, hosting/joining, main loop.
import { CLASSES, ATTRS, FREE_POINTS, PLAYER_COLORS } from './data/classes.js';
import { ITEMS } from './data/items.js';
import { TILES } from './data/tiles.js';
import { ENEMIES } from './data/enemies.js';
import { SKILLS } from './sim/skills.js';
import { Game } from './sim/game.js';
import { HostSession, ClientSession, HOST_PID } from './net/session.js';
import { PeerHost, peerConnect, ManualHost, manualAnswer, TabsHost, tabsConnect } from './net/transport.js';
import { Renderer } from './render/renderer3d.js';
import { UI } from './ui/hud.js';
import { esc, randomCode, pick } from './util.js';

const $ = (s) => document.querySelector(s);
const SAVE_KEY = 'emberwake-save-v2'; // v2: level-based worlds
const NAMES = ['Aldric', 'Brenna', 'Corvin', 'Dagny', 'Ember', 'Fenna', 'Garrick', 'Hollis', 'Isolde', 'Jory', 'Kestrel', 'Lirael', 'Maren', 'Niall', 'Orla', 'Pell', 'Quill', 'Rook', 'Sable', 'Tamsin', 'Ulric', 'Vesna', 'Wren', 'Yara'];

const screens = ['title', 'create', 'connecting', 'game'];
function showScreen(id) { for (const s of screens) $('#' + s).classList.toggle('hidden', s !== id); }
const netMode = () => document.querySelector('input[name=net]:checked').value;

// ------------------------------------------------------------------ title
function initTitle() {
  const params = new URLSearchParams(location.hash.slice(1));
  if (params.get('join')) $('#join-code').value = params.get('join').toUpperCase();
  if (params.get('mode')) { const r = document.querySelector(`input[name=net][value=${params.get('mode')}]`); if (r) r.checked = true; }
  const save = loadSave();
  if (save) { $('#btn-continue').classList.remove('hidden'); $('#btn-continue').textContent = `Continue saved world (${save.hostChar.name}, ${new Date(save.at).toLocaleString()})`; }
  $('#btn-host').onclick = () => openCreation({ intent: 'host', mode: netMode() });
  $('#btn-join').onclick = () => {
    const code = $('#join-code').value.trim().toUpperCase();
    const mode = netMode();
    if (!code && mode !== 'manual') { $('#join-code').focus(); $('#join-code').placeholder = 'Enter the host\'s code'; return; }
    openCreation({ intent: 'join', mode, code });
  };
  $('#join-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-join').click(); });
  $('#btn-continue').onclick = () => { const s = loadSave(); if (s) startHost(s.hostChar, netMode(), s); };
}
function loadSave() { try { return JSON.parse(localStorage.getItem(SAVE_KEY)); } catch { return null; } }

// ------------------------------------------------------------------ character creation
const cc = { name: pick(NAMES), cls: 'sellsword', color: PLAYER_COLORS[0], alloc: { might: 0, finesse: 0, intellect: 0, vigor: 0 } };
let ccIntent = null;
function openCreation(intent) {
  ccIntent = intent;
  $('#cc-go').textContent = intent.intent === 'host' ? 'Begin adventure' : 'Join the party';
  $('#cc-name').value = cc.name;
  renderCreation();
  showScreen('create');
  $('#cc-name').focus();
}
function renderCreation() {
  $('#cc-colors').innerHTML = PLAYER_COLORS.map((c) => `<div class="swatch ${c === cc.color ? 'sel' : ''}" style="background:${c}" data-c="${c}"></div>`).join('');
  document.querySelectorAll('.swatch').forEach((el) => (el.onclick = () => { cc.color = el.dataset.c; renderCreation(); }));
  $('#cc-classes').innerHTML = Object.entries(CLASSES).map(([id, c]) => `
    <div class="cls ${id === cc.cls ? 'sel' : ''}" data-c="${id}">
      <div class="glyph" style="color:${id === cc.cls ? cc.color : '#eadfcb'}">${c.glyph}</div>
      <h3>${c.n}</h3><p>${esc(c.d)}</p>
      <div class="sk">${c.skills.map((s) => SKILLS[s].i + ' ' + SKILLS[s].n).join('<br>')}</div>
    </div>`).join('');
  document.querySelectorAll('.cls').forEach((el) => (el.onclick = () => { cc.cls = el.dataset.c; cc.alloc = { might: 0, finesse: 0, intellect: 0, vigor: 0 }; renderCreation(); }));
  const base = CLASSES[cc.cls].attrs;
  const used = Object.values(cc.alloc).reduce((a, b) => a + b, 0);
  $('#cc-attrs').innerHTML = `<b>Attributes</b> <small>(${FREE_POINTS - used} point${FREE_POINTS - used === 1 ? "" : "s"} left)</small>` + Object.entries(ATTRS).map(([k, a]) => `
    <div class="attr-row"><span class="an">${a.n}</span><button data-k="${k}" data-d="-1" ${cc.alloc[k] ? '' : 'disabled'}>−</button><span class="av">${base[k] + cc.alloc[k]}</span><button data-k="${k}" data-d="1" ${used < FREE_POINTS ? '' : 'disabled'}>+</button><small>${a.d}</small></div>`).join('');
  document.querySelectorAll('#cc-attrs button').forEach((b) => (b.onclick = () => { cc.alloc[b.dataset.k] += +b.dataset.d; renderCreation(); }));
  const attrs = finalAttrs();
  const c = CLASSES[cc.cls];
  const kit = [...Object.values(c.eq), ...c.inv.map(([id, q]) => (q > 1 ? `${q}× ` : '') + id)].map((x) => { const id = x.replace(/^\d+× /, ''); return x.replace(id, ITEMS[id].n); });
  $('#cc-summary').innerHTML = `<b>${c.n}</b> · ${18 + attrs.vigor * 4} HP · 6 AP (+4/turn)${c.passive === 'quick_toss' ? ' · <b>Quick Toss</b>: throwing costs 1 AP' : ''}<br><br><b>Starting kit:</b> ${kit.join(', ')}<br><br><small>Everyone shares the village supply chest: axe, pickaxe, hammer, mortar, flasks… Combine, coat and throw everything.</small>`;
}
function finalAttrs() { const b = CLASSES[cc.cls].attrs; return Object.fromEntries(Object.keys(b).map((k) => [k, b[k] + cc.alloc[k]])); }
function initCreation() {
  $('#cc-random').onclick = () => { cc.name = pick(NAMES); $('#cc-name').value = cc.name; };
  $('#cc-name').oninput = () => (cc.name = $('#cc-name').value);
  $('#cc-back').onclick = () => showScreen('title');
  $('#cc-go').onclick = () => {
    const name = $('#cc-name').value.trim().slice(0, 16) || pick(NAMES);
    const char = { name, cls: cc.cls, color: cc.color, attrs: finalAttrs() };
    if (ccIntent.intent === 'host') startHost(char, ccIntent.mode, null);
    else startClient(char, ccIntent.mode, ccIntent.code);
  };
}

// ------------------------------------------------------------------ connecting screen helpers
function connScreen(title, html) {
  $('#conn-title').textContent = title;
  $('#conn-body').innerHTML = html;
  showScreen('connecting');
}
function connError(msg) {
  connScreen('Could not connect', `<p class="need">${esc(msg)}</p>`);
  $('#conn-cancel').textContent = 'Back';
}
$('#conn-cancel').onclick = () => location.reload();

// ------------------------------------------------------------------ host
async function startHost(char, mode, save) {
  connScreen('Creating world…', '<p class="subtle">Raising mountains, planting herbs, hiding bandits…</p>');
  await new Promise((r) => setTimeout(r, 30));
  const game = new Game(save ? { save: save.world } : {});
  const session = new HostSession(game);
  const r = game.addPlayer(HOST_PID, char);
  if (r.error) return connError(r.error);
  const net = { mode, code: null, manual: null, error: null };
  const view = {
    isHost: true, net,
    get state() { return game.state; },
    get map() { return game.map; },
    get index() { return game.index; },
    myEid: r.eid,
    send(a) { game.handleAction(HOST_PID, a); session.flush(); },
    save() { try { localStorage.setItem(SAVE_KEY, JSON.stringify({ world: game.serialize(), hostChar: char, at: Date.now() })); return true; } catch { return false; } },
  };
  const ui = enterGame(view);
  window.__host = { game, session };
  game.events.on('log', (m) => ui.log(m.text, m.cls));
  game.events.on('fx', (f) => ui.r.addFx(f));
  session.on('priv', (m) => ui.priv(m));
  session.on('state', () => ui.update());
  game.drain();
  ui.log(save ? 'World loaded. Welcome back.' : 'Welcome to Emberwake. Press H for help. The village supply chest (north of the campfire) has tools for everyone.', 'sys');

  // fixed-rate simulation on a worker timer (keeps running in background tabs)
  try {
    const w = new Worker(URL.createObjectURL(new Blob(['setInterval(()=>postMessage(0),100)'], { type: 'text/javascript' })));
    w.onmessage = () => session.step();
  } catch { setInterval(() => session.step(), 100); }
  setInterval(() => view.save(), 60000);

  // networking
  try {
    if (mode === 'peerjs') {
      net.code = randomCode(5);
      const t = new PeerHost(net.code);
      await t.start();
      session.attach(t);
      ui.log(`Room open! Friends join with code ${net.code} (Online mode).`, 'good');
    } else if (mode === 'tabs') {
      net.code = randomCode(4);
      const t = new TabsHost(net.code);
      await t.start();
      session.attach(t);
      ui.log(`Local room ${net.code}: open another tab, choose "Local tabs" and join with this code.`, 'good');
    } else {
      net.manual = new ManualHost();
      session.attach(net.manual);
      ui.log('Manual mode: open the Party panel (N) to create invite codes.', 'good');
    }
  } catch (err) {
    net.error = err.message;
    ui.log(`Networking unavailable: ${err.message} You can still play solo.`, 'bad');
  }
  ui.renderNetInfo();
  ui.update(true);
}

// ------------------------------------------------------------------ client
async function startClient(char, mode, code) {
  let ch;
  try {
    if (mode === 'manual') ch = await manualJoinFlow();
    else {
      connScreen('Connecting…', `<p>Looking for room <b>${esc(code)}</b>…</p>`);
      ch = mode === 'tabs' ? await tabsConnect(code) : await peerConnect(code);
    }
  } catch (err) { return connError(err.message); }
  connScreen('Joining…', '<p>Connected. Receiving the world…</p>');
  const cs = new ClientSession(ch);
  let ui = null;
  cs.on('reject', (reason) => connError(reason));
  cs.on('welcome', () => {
    const view = {
      isHost: false, net: { mode, code },
      get state() { return cs.state; },
      get map() { return cs.map; },
      get index() { return cs.index; },
      myEid: cs.myEid,
      send(a) { cs.send(a); },
    };
    ui = enterGame(view);
    ui.log('You joined the party. Press H for help.', 'sys');
    ui.update(true);
  });
  cs.on('state', () => ui?.update());
  cs.on('log', (m) => ui?.log(m.text, m.cls));
  cs.on('fx', (f) => ui?.r.addFx(f));
  cs.on('priv', (m) => ui?.priv(m));
  cs.on('disconnected', () => {
    if (!ui) return connError('Connection closed by host.');
    ui.log('Disconnected from host.', 'bad');
    ui.toast('Disconnected from the host. Reload to rejoin (use the same name to keep your character).');
  });
  cs.hello(char);
}
function manualJoinFlow() {
  return new Promise((resolve, reject) => {
    connScreen('Manual connection', `<p>1. Paste the <b>invite code</b> the host sent you:</p><textarea id="offer" rows="5"></textarea>
      <div class="row end"><button id="mk-ans" class="big">Generate reply code</button></div><div id="ans-area"></div>`);
    $('#mk-ans').onclick = async () => {
      try {
        $('#ans-area').innerHTML = '<p class="subtle">Working…</p>';
        const { code, ready } = await manualAnswer($('#offer').value);
        $('#ans-area').innerHTML = `<p>2. Send this <b>reply code</b> back to the host:</p><textarea rows="5" readonly>${code}</textarea>
          <div class="row end"><button id="cp-ans">Copy</button></div><p class="subtle">3. Waiting for the host to accept…</p>`;
        $('#cp-ans').onclick = () => navigator.clipboard?.writeText(code);
        resolve(await ready);
      } catch (err) { reject(new Error('That invite code did not work: ' + err.message)); }
    };
  });
}

// ------------------------------------------------------------------ game
function enterGame(view) {
  showScreen('game');
  const renderer = new Renderer($('#view'), view);
  const ui = new UI(view, renderer);
  const mm = $('#minimap'), mctx = mm.getContext('2d');
  let base = null, baseMap = null, sc = 1;
  const rebuildBase = () => {
    const map = view.map;
    baseMap = map;
    mm.width = 200; mm.height = Math.round((200 * map.H) / map.W);
    sc = mm.width / map.W;
    base = document.createElement('canvas');
    base.width = map.W; base.height = map.H;
    const bctx = base.getContext('2d');
    const img = bctx.createImageData(map.W, map.H);
    for (let i = 0; i < map.tiles.length; i++) {
      const c = parseInt(TILES[map.tiles[i]].c.slice(1), 16);
      img.data[i * 4] = (c >> 16) & 255; img.data[i * 4 + 1] = (c >> 8) & 255; img.data[i * 4 + 2] = c & 255; img.data[i * 4 + 3] = 255;
    }
    bctx.putImageData(img, 0, 0);
  };
  mm.onclick = (ev) => {
    const me = view.state.entities[view.myEid];
    const r = mm.getBoundingClientRect();
    renderer.cam.ox = (ev.clientX - r.left) / sc - me.x;
    renderer.cam.oy = (ev.clientY - r.top) / sc - me.y;
  };
  const drawMini = () => {
    if (view.map !== baseMap) rebuildBase();
    mctx.imageSmoothingEnabled = false;
    mctx.drawImage(base, 0, 0, mm.width, mm.height);
    const S = view.state, info = S.levelInfo;
    const ps = Object.values(S.entities).filter((e) => e.kind === 'player');
    const alive = new Set(Object.values(S.entities).filter((e) => e.kind === 'enemy' && !e.dead).map((e) => e.grp));
    if (info) {
      for (const c of info.checkpoints) { mctx.fillStyle = '#ffb347'; mctx.fillRect(c.x * sc - 2, c.y * sc - 2, 4, 4); }
      for (const en of info.encounters) if (alive.has(en.id)) { mctx.strokeStyle = en.boss ? '#ff3030' : '#e06060'; mctx.lineWidth = en.boss ? 2 : 1.5; mctx.beginPath(); mctx.arc(en.x * sc, en.y * sc, en.boss ? 6 : 4.5, 0, 7); mctx.stroke(); }
      mctx.fillStyle = '#7fd8ff'; mctx.fillRect(info.exit.x * sc - 2.5, info.exit.y * sc - 2.5, 5, 5);
    }
    for (const e of Object.values(S.entities)) {
      if (e.kind === 'enemy' && !e.dead && ps.some((p) => Math.abs(p.x - e.x) < 14 && Math.abs(p.y - e.y) < 14)) { mctx.fillStyle = ENEMIES[e.type].boss ? '#ff2222' : '#e04848'; mctx.fillRect(e.x * sc - 1, e.y * sc - 1, 3, 3); }
      else if (e.kind === 'npc') { mctx.fillStyle = '#ffd86b'; mctx.fillRect(e.x * sc - 1, e.y * sc - 1, 3, 3); }
    }
    for (const p of ps) { mctx.fillStyle = p.color; mctx.beginPath(); mctx.arc(p.x * sc, p.y * sc, p.id === view.myEid ? 3.5 : 2.5, 0, 7); mctx.fill(); if (p.id === view.myEid) { mctx.strokeStyle = '#fff'; mctx.lineWidth = 1; mctx.stroke(); } }
    const R = 13 / renderer.cam.zoom;
    mctx.strokeStyle = 'rgba(255,255,255,0.6)'; mctx.lineWidth = 1;
    mctx.beginPath(); mctx.arc(renderer.cam.x * sc, renderer.cam.y * sc, R * sc, 0, 7); mctx.stroke();
  };
  let last = performance.now(), lastMini = 0;
  const loop = (now) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    ui.panCamera(dt);
    renderer.frame(dt, now);
    ui.frame();
    if (now - lastMini > 250) { lastMini = now; drawMini(); }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  window.__game = { view, ui, renderer }; // handy for debugging
  return ui;
}

initTitle();
initCreation();
