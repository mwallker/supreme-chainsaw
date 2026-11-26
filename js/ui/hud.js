// In-game UI: HUD, panels, input, targeting, context menus. Works identically for host and clients
// through the `view` object: { state, map, index, myEid, isHost, send(action), net }.
import { ITEMS, COAT, itemName, SHOP, sellPrice } from '../data/items.js';
import { OBJECTS, objName } from '../data/objects.js';
import { ENEMIES } from '../data/enemies.js';
import { CLASSES, ATTRS } from '../data/classes.js';
import { TILES } from '../data/tiles.js';
import { RECIPES } from '../data/recipes.js';
import { STATUS, surfaceAt, surfaceName } from '../sim/rules.js';
import { SKILLS, skillError, skillRange } from '../sim/skills.js';
import { weaponOf, moveRange, armorOf, throwRange, throwAp, critChance, countItem, statMult } from '../sim/entities.js';
import { findPath, los, walkable, isCreature } from '../sim/map.js';
import { matchCombination, describeResult, recipeMissing, stackAt, toolName } from '../sim/crafting.js';
import { applyRulesFor, defaultOptions } from '../sim/interact.js';
import { esc, cheb, circleTiles } from '../util.js';
import { hitChance, describeHit, lightAt, LIGHT_NAMES, LIGHT_ICONS, LIGHT_PENALTY, phaseOf, clockText } from '../sim/light.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const GATHER_RULES = ['chop', 'mine', 'skin', 'fill', 'light', 'unlock', 'harvest'];

export class UI {
  constructor(view, renderer) {
    this.v = view;
    this.r = renderer;
    this.panels = {};
    this.targeting = null;
    this.craftSlots = [null, null, null];
    this.picking = null;
    this.container = null;
    this.shop = null;
    this.sig = {};
    this.keys = new Set();
    this.buildPanels();
    this.bindInput();
    this.bindTips();
  }
  get S() { return this.v.state; }
  me() { return this.S?.entities[this.v.myEid]; }
  inCombat() { const c = this.S.combat; return !!(c && c.order.includes(this.v.myEid)); }
  myTurn() { return this.S.combat?.active === this.v.myEid; }
  canAct() { return !this.inCombat() || this.myTurn(); }
  send(a) { this.v.send(a); }

  // ================================================================ feedback
  toast(text, cls = '') {
    const d = document.createElement('div');
    d.className = 'toast ' + cls;
    d.textContent = text;
    $('#toasts').appendChild(d);
    setTimeout(() => d.remove(), 3000);
    while ($('#toasts').children.length > 4) $('#toasts').firstChild.remove();
  }
  log(text, cls = '') {
    const l = $('#log');
    const d = document.createElement('div');
    d.className = cls;
    d.textContent = text;
    const atBottom = l.scrollTop + l.clientHeight >= l.scrollHeight - 30;
    l.appendChild(d);
    while (l.children.length > 250) l.firstChild.remove();
    if (atBottom) l.scrollTop = l.scrollHeight;
  }
  priv(msg) {
    if (typeof msg === 'string') return this.toast(msg);
    if (msg.open === 'container') { this.container = msg.id; this.show('container'); }
    else if (msg.open === 'shop') { this.shop = msg.id; this.show('shop'); this.show('inventory'); }
    else if (msg.open === 'craft') { this.show('craft'); this.show('inventory'); }
    this.update(true);
  }

  // ================================================================ panels
  makePanel(id, title, pos, width) {
    const p = document.createElement('div');
    p.className = 'panel hidden';
    p.id = 'panel-' + id;
    p.style.width = width + 'px';
    Object.assign(p.style, pos);
    p.innerHTML = `<header><span class="t">${title}</span><button class="x">✕</button></header><div class="body"></div>`;
    $('#panels').appendChild(p);
    $('.x', p).onclick = () => this.hide(id);
    // drag
    const h = $('header', p);
    h.onmousedown = (ev) => {
      if (ev.target.tagName === 'BUTTON') return;
      const r = p.getBoundingClientRect(), ox = ev.clientX - r.left, oy = ev.clientY - r.top;
      const mv = (e) => { p.style.left = e.clientX - ox + 'px'; p.style.top = Math.max(0, e.clientY - oy) + 'px'; p.style.right = 'auto'; p.style.bottom = 'auto'; };
      const up = () => { removeEventListener('mousemove', mv); removeEventListener('mouseup', up); };
      addEventListener('mousemove', mv); addEventListener('mouseup', up);
    };
    this.panels[id] = { el: p, body: $('.body', p) };
    return p;
  }
  buildPanels() {
    this.makePanel('inventory', 'Inventory', { right: '64px', top: '200px' }, 412);
    this.makePanel('craft', 'Crafting', { left: '240px', top: '90px' }, 430);
    this.makePanel('character', 'Character', { left: '240px', top: '90px' }, 380);
    this.makePanel('help', 'How to play', { left: 'calc(50% - 300px)', top: '60px' }, 600);
    this.makePanel('net', 'Party & Connection', { right: '64px', top: '200px' }, 380);
    this.makePanel('container', 'Container', { left: 'calc(50% - 170px)', top: '160px' }, 340);
    this.makePanel('shop', 'Merchant', { left: '240px', top: '90px' }, 380);
    this.renderHelp();
    $$('#menubar button').forEach((b) => (b.onclick = () => this.toggle(b.dataset.panel)));
  }
  show(id) { this.panels[id].el.classList.remove('hidden'); this.renderPanel(id); this.syncMenu(); }
  hide(id) {
    this.panels[id].el.classList.add('hidden');
    if (id === 'container') this.container = null;
    if (id === 'shop') this.shop = null;
    this.syncMenu();
  }
  toggle(id) { this.isOpen(id) ? this.hide(id) : this.show(id); }
  isOpen(id) { return !this.panels[id].el.classList.contains('hidden'); }
  syncMenu() { $$('#menubar button').forEach((b) => b.classList.toggle('on', this.isOpen(b.dataset.panel))); }
  renderPanel(id) {
    if (!this.me()) return;
    const f = { inventory: this.renderInventory, craft: this.renderCraft, character: this.renderCharacter, net: this.renderNet, container: this.renderContainer, shop: this.renderShop }[id];
    if (f) f.call(this, this.panels[id].body);
  }

  // ================================================================ update loop
  update(force) {
    const S = this.S, me = this.me();
    if (!S || !me) return;
    const players = Object.values(S.entities).filter((e) => e.kind === 'player');
    const pSig = JSON.stringify([players.map((p) => [p.id, p.hp, p.maxHp, p.ap, p.st, p.downed, p.online, p.level, p.name]), S.combat?.active, S.combat?.order, S.combat?.round]);
    if (force || pSig !== this.sig.p) { this.sig.p = pSig; this.renderParty(players); this.renderTurnbar(); }
    const mSig = JSON.stringify([me, S.recipes, S.combat?.active, !!S.combat]);
    if (force || mSig !== this.sig.m) {
      this.sig.m = mSig;
      this.renderActions();
      for (const id of ['inventory', 'craft', 'character', 'shop']) if (this.isOpen(id)) this.renderPanel(id);
    }
    if (this.container) {
      const c = S.entities[this.container];
      if (!c || cheb(c.x, c.y, me.x, me.y) > 1 || (c.type === 'pile' && !c.items?.length)) this.hide('container');
      else {
        const cs = JSON.stringify(c.items);
        if (force || cs !== this.sig.c) { this.sig.c = cs; this.renderPanel('container'); }
      }
    }
    if (this.shop) { const n = S.entities[this.shop]; if (!n || cheb(n.x, n.y, me.x, me.y) > 2) this.hide('shop'); }
    const nSig = JSON.stringify([S.players, S.time]);
    if (nSig !== this.sig.n) { this.sig.n = nSig; if (this.isOpen('net')) this.renderPanel('net'); this.renderNetInfo(); this.renderActions(); }
    this.pathCache = null;
  }

  renderParty(players) {
    const me = this.me();
    players.sort((a, b) => (a.id === me.id ? -1 : b.id === me.id ? 1 : a.id < b.id ? -1 : 1));
    const c = this.S.combat;
    $('#party').innerHTML = players.map((p) => `
      <div class="pf ${p.id === me.id ? 'me' : ''} ${c?.active === p.id ? 'active' : ''}" data-eid="${p.id}" data-tip="${esc(this.creatureTip(p))}">
        <div class="por" style="background:${p.color}">${CLASSES[p.cls].glyph}</div>
        <div class="info">
          <div class="nm">${esc(p.name)} <small>Lv ${p.level} ${CLASSES[p.cls].n}</small>${p.online ? '' : '<span class="tag">offline</span>'}${p.downed ? '<span class="tag bad">DOWN</span>' : ''}</div>
          <div class="bar"><i style="width:${(100 * p.hp) / p.maxHp}%"></i></div>
          <div class="hpt">${p.hp} / ${p.maxHp} HP</div>
          ${c && c.order.includes(p.id) ? `<div class="pips">${[...Array(6)].map((_, i) => `<span class="pip ${i < p.ap ? 'on' : ''}"></span>`).join('')}</div>` : ''}
          <div class="chips">${Object.entries(p.st).map(([s, n]) => `<span class="chip" style="background:${STATUS[s].c}">${STATUS[s].n} ${n}</span>`).join('')}</div>
        </div>
      </div>`).join('');
    $$('#party .pf').forEach((el) => {
      el.ondragover = (ev) => { if (el.dataset.eid !== me.id) { ev.preventDefault(); el.classList.add('drop'); } };
      el.ondragleave = () => el.classList.remove('drop');
      el.ondrop = (ev) => {
        ev.preventDefault(); el.classList.remove('drop');
        const ref = ev.dataTransfer.getData('text/plain');
        if (ref !== '' && !ref.startsWith('eq:')) this.send({ type: 'give', ref: +ref, to: el.dataset.eid });
      };
      el.onclick = () => { const p = this.S.entities[el.dataset.eid]; if (p && p.id !== me.id) { this.r.cam.ox = p.x - me.x; this.r.cam.oy = p.y - me.y; } else { this.r.cam.ox = this.r.cam.oy = 0; } };
    });
  }
  renderTurnbar() {
    const c = this.S.combat, tb = $('#turnbar');
    if (!c) { tb.classList.add('hidden'); return; }
    tb.classList.remove('hidden');
    tb.innerHTML = `<span class="rnd">Round ${c.round}</span>` + c.order.map((id) => {
      const e = this.S.entities[id];
      if (!e || e.dead) return '';
      const isP = e.kind === 'player';
      const col = isP ? e.color : ENEMIES[e.type].color;
      return `<div class="tchip ${isP ? 'player' : 'enemy'} ${c.active === id ? 'act' : ''} ${e.downed ? 'down' : ''}" style="background:${col}" data-tip="${esc(this.creatureTip(e))}">${isP ? CLASSES[e.cls].glyph : ENEMIES[e.type].glyph}<i><b style="width:${(100 * e.hp) / e.maxHp}%"></b></i></div>`;
    }).join('');
  }
  renderNetInfo() {
    const n = this.v.net || {};
    const count = Object.keys(this.S.players || {}).length;
    let html = `<span>${count}/4 players</span>`;
    if (this.v.isHost && n.code && n.mode !== 'manual') html = `Room <b>${n.code}</b> · ${html}`;
    else if (this.v.isHost && n.mode === 'manual') html = `Manual invites · ${html}`;
    else html = `Connected · ${html}`;
    const ph = phaseOf(this.S.time ?? 540);
    html = `<span data-tip="${esc(`<h4>${ph[0].toUpperCase() + ph.slice(1)}</h4>Day: lit · dawn/dusk: dim · night: dark. Forests and interiors are one step darker. Fires, torches and glowing creatures light their surroundings. Rest at a campfire to skip the night.`)}">${{ day: '☀', dawn: '🌅', dusk: '🌇', night: '☾' }[ph]} ${clockText(this.S.time ?? 540)}</span> · ` + html;
    $('#netinfo').innerHTML = html;
  }

  renderActions() {
    const me = this.me();
    const inC = this.inCombat(), mine = this.myTurn();
    const w = weaponOf(me);
    const items = [{ key: '1', ic: me.eq.weapon ? ITEMS[me.eq.weapon.id].i : '✊', ap: w.ap, tip: `<h4>Attack</h4>${esc(w.n || 'Fists')}: ${w.dmg[0]}-${w.dmg[1]} ${w.type || 'physical'}, range ${w.range}.<br><span class="d">Left-click an enemy also attacks.</span>`, act: () => this.startTargeting({ kind: 'attack' }), id: 'attack' }];
    me.skills.forEach((sk, i) => {
      const s = SKILLS[sk.id];
      items.push({ key: String(i + 2), ic: s.i, ap: s.ap, cd: sk.cd, color: s.c, tip: `<h4 style="color:${s.c}">${s.n}</h4>${esc(s.d)}<br><span class="d">${s.ap} AP · cooldown ${s.cd} · range ${s.range || 'self'}</span>`, act: () => this.useSkill(sk.id), id: 'skill:' + sk.id });
    });
    const t = this.targeting;
    $('#actions').innerHTML = items.map((it, i) => `<button class="act ${t && ((t.kind === 'attack' && it.id === 'attack') || (t.kind === 'skill' && it.id === 'skill:' + t.id)) ? 'sel' : ''}" data-i="${i}" data-tip="${esc(it.tip)}" ${inC && !mine ? 'disabled' : ''}><span class="key">${it.key}</span><span style="color:${it.color || '#eadfcb'}">${it.ic}</span><small>${it.ap}</small>${it.cd ? `<span class="cd">${it.cd}</span>` : ''}</button>`).join('')
      + (inC ? `<button class="act end" id="endturn" ${mine ? '' : 'disabled'} data-tip="End your turn (Space). Unused AP carries over (max 6).">End<br>Turn</button>` : '');
    $$('#actions .act[data-i]').forEach((b) => (b.onclick = () => items[+b.dataset.i].act()));
    if ($('#endturn')) $('#endturn').onclick = () => this.send({ type: 'endTurn' });
    this.actionItems = items;
    // AP bar
    const ap = $('#apbar');
    if (inC) {
      const act = this.S.entities[this.S.combat.active];
      ap.innerHTML = `<span class="turn">${mine ? 'Your turn' : esc(act?.name || '…') + "'s turn"}</span>${[...Array(6)].map((_, i) => `<span class="pip ${i < me.ap ? 'on' : ''}"></span>`).join('')}<span>${me.ap} AP · move ${me.mp + me.ap * moveRange(me)} tiles</span>${this.myLightHtml(me)}`;
    } else ap.innerHTML = `<span class="subtle">Exploring — real time. Right-click anything for options.</span>${this.myLightHtml(me)}`;
  }

  myLightHtml(me) {
    const lv = lightAt(this.S, this.v.map, me.x, me.y);
    const tip = ['You stand in darkness: enemies without darkvision have −35% to hit you, and you get +10% against lit targets.', 'You stand in dim light: enemies have −15% to hit you.', 'You stand in full light: easy to see, easy to hit.'][lv];
    return `<span data-tip="${esc(tip + ' Press L to show the light map.')}" style="color:${['#9aa6ff', '#d8c99a', '#ffe08a'][lv]}">${LIGHT_ICONS[lv]} ${LIGHT_NAMES[lv]}</span>`;
  }

  // ================================================================ inventory
  slotHtml(s, ref, extra = '') {
    if (!s) return `<div class="slot empty" data-ref="${ref}" ${extra}></div>`;
    const d = ITEMS[s.id];
    const coat = s.d?.coat ? `coat" style="--coat:${COAT[s.d.coat].c}` : '';
    const pick = this.picking === String(ref) ? 'picking' : '';
    return `<div class="slot ${coat} ${pick}" draggable="true" data-ref="${ref}" data-tip="${esc(this.itemTip(s))}" ${extra}><span style="color:${d.c}">${d.i}</span>${s.q > 1 ? `<span class="q">${s.q}</span>` : ''}</div>`;
  }
  renderInventory(body) {
    const me = this.me();
    const gold = countItem(me, 'gold');
    const slots = [];
    for (let i = 0; i < 32; i++) slots.push(this.slotHtml(me.inv[i], me.inv[i] ? i : '', ''));
    body.innerHTML = `
      <div class="equip">
        ${['weapon', 'offhand', 'armor'].map((s) => `<div>${this.slotHtml(me.eq[s], 'eq:' + s).replace('class="slot', `data-eslot="${s}" class="slot`)}<div class="subtle" style="text-align:center;font-size:10px">${s}</div></div>`).join('')}
        <div class="gold">¤ ${gold}</div>
      </div>
      <div class="grid">${slots.join('')}</div>
      <p class="subtle">Click an item for actions. <b>Drag an item onto another to combine them</b> — onto the world to use it there, onto a party member to hand it over.</p>`;
    this.wireSlots(body);
  }
  wireSlots(root) {
    $$('.slot', root).forEach((el) => {
      const ref = el.dataset.ref;
      el.onclick = (ev) => {
        if (el.dataset.craft != null) { this.craftSlots[+el.dataset.craft] = null; this.renderPanel('craft'); return; }
        if (ref === '') return;
        if (this.picking != null) {
          const first = this.picking;
          this.picking = null;
          if (first !== ref) this.send({ type: 'combine', refs: [first, ref] });
          this.renderPanel('inventory');
          return;
        }
        this.itemMenu(ref, ev.clientX, ev.clientY);
      };
      el.oncontextmenu = (ev) => { ev.preventDefault(); if (ref !== '') this.itemMenu(ref, ev.clientX, ev.clientY); };
      el.ondragstart = (ev) => { ev.dataTransfer.setData('text/plain', ref); this.dragRef = ref; };
      el.ondragend = () => { this.dragRef = null; $$('.slot').forEach((s) => s.classList.remove('combo-ok', 'combo-no')); };
      el.ondragover = (ev) => {
        ev.preventDefault();
        if (this.dragRef == null || this.dragRef === ref) return;
        if (el.dataset.craft != null) { el.classList.add('combo-ok'); return; }
        if (ref === '') return;
        const me = this.me();
        const a = stackAt(me, this.dragRef), b = stackAt(me, ref);
        if (!a || !b) { if (el.dataset.eslot) el.classList.add('combo-ok'); return; }
        const m = matchCombination([a, b]);
        el.classList.toggle('combo-ok', !!m);
        el.classList.toggle('combo-no', !m);
        if (m) this.showTip(`<h4>Combine → ${esc(describeResult(m))}</h4>`, ev.clientX, ev.clientY);
      };
      el.ondragleave = () => el.classList.remove('combo-ok', 'combo-no');
      el.ondrop = (ev) => {
        ev.preventDefault();
        el.classList.remove('combo-ok', 'combo-no');
        const src = ev.dataTransfer.getData('text/plain');
        if (src === '' || src === ref) return;
        if (el.dataset.craft != null) { this.setCraftSlot(+el.dataset.craft, src); return; }
        if (el.dataset.eslot) {
          const me = this.me();
          const tgt = stackAt(me, ref), from = stackAt(me, src);
          if (tgt && from && matchCombination([from, tgt])) this.send({ type: 'combine', refs: [src, ref] });
          else if (!src.startsWith('eq:')) this.send({ type: 'equip', ref: +src });
          return;
        }
        if (ref === '') return;
        const me = this.me();
        const a = stackAt(me, src), b = stackAt(me, ref);
        const m = a && b && matchCombination([a, b]);
        if (m) this.send({ type: 'combine', refs: [src, ref] });
        else if (!src.startsWith('eq:') && !ref.startsWith('eq:')) this.send({ type: 'swap', from: +src, to: +ref });
        else this.toast("Those don't combine.");
      };
    });
  }
  itemMenu(ref, x, y) {
    const me = this.me();
    const s = stackAt(me, ref);
    if (!s) return;
    const d = ITEMS[s.id];
    const isEq = String(ref).startsWith('eq:');
    const o = [];
    if (d.use && !isEq) o.push({ ic: '✚', label: d.use.drink || /Potion|Antidote/.test(d.n) ? 'Drink' : 'Use', fn: () => this.send({ type: 'use', ref: +ref }) });
    if (d.slot && !isEq) o.push({ ic: '⛨', label: 'Equip', fn: () => this.send({ type: 'equip', ref: +ref }) });
    if (isEq) o.push({ ic: '⛨', label: 'Unequip', fn: () => this.send({ type: 'unequip', slot: ref.slice(3) }) });
    o.push({ ic: '☛', label: 'Use on… (pick a target)', fn: () => this.startTargeting({ kind: 'apply', ref: String(ref) }) });
    if (!isEq && s.id !== 'gold') o.push({ ic: '➚', label: `Throw… (${throwAp(me)} AP)`, fn: () => this.startTargeting({ kind: 'throw', ref: String(ref) }) });
    o.push({ ic: '⚗', label: 'Combine with… (pick an item)', fn: () => { this.picking = String(ref); this.show('inventory'); this.toast('Now click the item to combine with.', 'info'); } });
    o.push({ ic: '⚒', label: 'Put in crafting grid', fn: () => { this.show('craft'); const i = this.craftSlots.findIndex((c) => !c); this.setCraftSlot(i < 0 ? 2 : i, String(ref)); } });
    if (!isEq) {
      for (const p of Object.values(this.S.entities)) if (p.kind === 'player' && p.id !== me.id && p.online) o.push({ ic: '🤝', label: `Give to ${esc(p.name)}`, fn: () => this.send({ type: 'give', ref: +ref, to: p.id }) });
      if (this.shop && s.id !== 'gold') o.push({ ic: '¤', label: `Sell for ${sellPrice(s.id)}g${s.q > 1 ? ' (shift: all)' : ''}`, fn: (ev) => this.send({ type: 'sell', npc: this.shop, ref: +ref, all: ev?.shiftKey }) });
      o.push({ ic: '⤓', label: 'Drop', fn: () => this.send({ type: 'drop', ref: +ref }) });
      if (s.q > 1) o.push({ ic: '⤓', label: 'Drop all', fn: () => this.send({ type: 'drop', ref: +ref, all: true }) });
    }
    this.showCtx(x, y, itemName(s), o);
  }

  // ================================================================ crafting
  setCraftSlot(i, ref) {
    const s = stackAt(this.me(), ref);
    if (!s) return;
    this.craftSlots = this.craftSlots.map((c) => (c && c.ref === ref ? null : c));
    this.craftSlots[i] = { ref, id: s.id };
    this.renderPanel('craft');
  }
  renderCraft(body) {
    const me = this.me();
    // re-validate refs (inventory indices shift)
    this.craftSlots = this.craftSlots.map((c) => {
      if (!c) return null;
      const s = stackAt(me, c.ref);
      if (s && s.id === c.id) return c;
      const i = me.inv.findIndex((x) => x.id === c.id);
      return i >= 0 ? { ref: String(i), id: c.id } : null;
    });
    const stacks = this.craftSlots.map((c) => c && stackAt(me, c.ref));
    const m = matchCombination(stacks);
    let res = '<span class="subtle">Drag ingredients (or a weapon + coating) here. Tools like a mortar can go in too.</span>';
    let ok = false;
    if (stacks.filter(Boolean).length >= 1) {
      if (!m) res = '<span class="need">These don\'t combine into anything known to nature.</span>';
      else if (m.kind === 'coat') { res = `→ <b>${esc(describeResult(m))}</b>`; ok = true; }
      else {
        const miss = recipeMissing(this.S, me, m.recipe, false);
        ok = !miss.length;
        res = `→ <b>${esc(describeResult(m))}</b>${this.S.recipes.includes(m.recipe.id) ? '' : ' <span class="have">(new!)</span>'}${miss.length ? `<br><span class="need">Requires ${esc(miss.join(', '))}</span>` : ''}`;
      }
    }
    const known = RECIPES.filter((r) => this.S.recipes.includes(r.id));
    const unknown = RECIPES.filter((r) => !this.S.recipes.includes(r.id));
    const rrow = (r) => {
      const [oid, oq] = r.out, od = ITEMS[oid];
      const miss = recipeMissing(this.S, me, r);
      const ing = Object.entries(r.in).map(([id, q]) => `<span class="${countItem(me, id) >= q ? 'have' : 'need'}">${q}× ${ITEMS[id].n}</span>`).join(' + ');
      const req = [r.tool && `tool: ${toolName(r.tool)}`, r.station && `at ${OBJECTS[r.station].n}`].filter(Boolean).join(', ');
      return `<div class="recipe" data-tip="${esc(this.itemTip({ id: oid, q: oq }))}"><span class="ri" style="color:${od.c}">${od.i}</span><span class="rt"><b>${oq > 1 ? oq + '× ' : ''}${od.n}</b><br>${ing}${req ? ` <span class="subtle">(${req})</span>` : ''}</span><button data-r="${r.id}" ${miss.length ? 'disabled' : ''}>Craft</button></div>`;
    };
    body.innerHTML = `
      <div class="craft-row">
        ${[0, 1, 2].map((i) => this.slotHtml(stacks[i], this.craftSlots[i]?.ref ?? '', `data-craft="${i}"`)).join('<span class="plus">+</span>')}
      </div>
      <div class="craft-row"><div class="result ${ok ? 'ok' : ''}">${res}</div><button id="combine-btn" class="big" ${ok && this.canAct() ? '' : 'disabled'}>Combine</button></div>
      <div class="tabs"><b style="flex:1">Recipe book</b><span class="subtle">${known.length}/${RECIPES.length} discovered</span></div>
      <div class="recipes">${known.map(rrow).join('')}
      ${unknown.map((r) => `<div class="recipe unknown"><span class="ri">?</span><span class="rt">??? — <i>${esc(r.hint)}</i></span></div>`).join('')}</div>`;
    // craft slots: always droppable even when empty
    $$('[data-craft]', body).forEach((el) => el.setAttribute('data-ref', this.craftSlots[+el.dataset.craft]?.ref ?? ''));
    this.wireSlots(body);
    $$('[data-craft]', body).forEach((el) => {
      el.ondragstart = (ev) => ev.preventDefault();
      el.onclick = () => { this.craftSlots[+el.dataset.craft] = null; this.renderPanel('craft'); };
    });
    $('#combine-btn', body).onclick = () => {
      const refs = this.craftSlots.filter(Boolean).map((c) => c.ref);
      this.send({ type: 'combine', refs });
      this.craftSlots = [null, null, null];
    };
    $$('button[data-r]', body).forEach((b) => (b.onclick = () => this.send({ type: 'craft', recipe: b.dataset.r })));
  }

  // ================================================================ character
  renderCharacter(body) {
    const me = this.me();
    const w = weaponOf(me);
    body.innerHTML = `
      <div style="display:flex;gap:10px;align-items:center">
        <div class="pf" style="min-width:0;border:none;background:none;padding:0"><div class="por" style="background:${me.color};width:52px;height:52px;font-size:24px">${CLASSES[me.cls].glyph}</div></div>
        <div style="flex:1"><b style="font-size:17px">${esc(me.name)}</b><br><span class="subtle">Level ${me.level} ${CLASSES[me.cls].n}</span>
        <div class="bar xp"><i style="width:${me.xp / me.level}%"></i></div><span class="subtle">${me.xp} / ${me.level * 100} XP</span></div>
      </div>
      <h4 style="margin:12px 0 4px">Attributes ${me.pts ? `<span class="have">(${me.pts} points to spend)</span>` : ''}</h4>
      ${Object.entries(ATTRS).map(([k, a]) => `<div class="attr-row"><span class="an">${a.n}</span><span class="av">${me.attrs[k]}</span>${me.pts ? `<button data-a="${k}">+</button>` : ''}<small>${a.d}</small></div>`).join('')}
      <div class="stats">
        <span>Health: <b>${me.hp}/${me.maxHp}</b></span><span>Armor: <b>${armorOf(me)}</b></span>
        <span>AP: <b>6 max, +4/turn</b></span><span>Move: <b>${moveRange(me)} tiles/AP</b></span>
        <span>Weapon: <b>${w.dmg.map((d) => Math.round(d * statMult(me, w.stat))).join('-')}</b> ${w.type || 'physical'}</span><span>Crit: <b>${Math.round(critChance(me) * 100)}%</b></span>
        <span>Throw range: <b>${throwRange(me)}</b></span><span>Throw cost: <b>${throwAp(me)} AP</b></span>
      </div>
      <h4 style="margin:12px 0 4px">Skills</h4>
      ${me.skills.map((sk) => { const s = SKILLS[sk.id]; return `<div class="skill-row"><span class="ic" style="color:${s.c}">${s.i}</span><div><b>${s.n}</b> <span class="subtle">${s.ap} AP · cd ${s.cd}</span><br>${esc(s.d)}</div></div>`; }).join('')}
      ${me.passive === 'quick_toss' ? '<div class="skill-row"><span class="ic">➚</span><div><b>Quick Toss</b> <span class="subtle">passive</span><br>Throwing items costs only 1 AP.</div></div>' : ''}`;
    $$('button[data-a]', body).forEach((b) => (b.onclick = () => this.send({ type: 'allocate', attr: b.dataset.a })));
  }

  // ================================================================ container & shop
  renderContainer(body) {
    const c = this.S.entities[this.container];
    if (!c) return;
    this.panels.container.el.querySelector('.t').textContent = c.kind === 'enemy' ? `${c.name} (remains)` : objName(c);
    const items = c.items || [];
    body.innerHTML = items.length
      ? items.map((s, i) => `<div class="list-row" data-tip="${esc(this.itemTip(s))}"><span class="ic" style="color:${ITEMS[s.id].c}">${ITEMS[s.id].i}</span><span class="nm">${esc(itemName(s))}${s.q > 1 ? ' ×' + s.q : ''}</span><button data-i="${i}">Take</button></div>`).join('') + `<div class="row end"><button id="take-all" class="big">Take all</button></div>`
      : '<p class="subtle">Empty.</p>';
    $$('button[data-i]', body).forEach((b) => (b.onclick = () => this.send({ type: 'take', from: c.id, idx: +b.dataset.i })));
    if ($('#take-all', body)) $('#take-all', body).onclick = () => this.send({ type: 'take', from: c.id, all: true });
  }
  renderShop(body) {
    const me = this.me();
    const gold = countItem(me, 'gold');
    body.innerHTML = `<p class="subtle">"Flasks, fuses and fixings. Mind the oil." — Gold: <b class="gold">¤ ${gold}</b></p>` +
      SHOP.map(([id, price]) => { const q = id === 'arrows' ? 10 : 1; return `<div class="list-row" data-tip="${esc(this.itemTip({ id, q }))}"><span class="ic" style="color:${ITEMS[id].c}">${ITEMS[id].i}</span><span class="nm">${q > 1 ? q + '× ' : ''}${ITEMS[id].n}</span><span class="gold">${price * q}g</span><button data-b="${id}" data-q="${q}" ${gold >= price * q ? '' : 'disabled'}>Buy</button></div>`; }).join('') +
      `<p class="subtle">To sell: click an item in your inventory → Sell.</p>`;
    $$('button[data-b]', body).forEach((b) => (b.onclick = () => this.send({ type: 'buy', npc: this.shop, id: b.dataset.b, q: +b.dataset.q })));
  }

  // ================================================================ net & help
  renderNet(body) {
    const n = this.v.net || {};
    const players = Object.values(this.S.entities).filter((e) => e.kind === 'player');
    let html = '';
    if (this.v.isHost) {
      html += `<p>You are the <b>host</b>. The world runs in this browser tab — keep it open.</p>`;
      if (n.mode === 'peerjs' || n.mode === 'tabs') html += `<p>Room code: <b class="gold" style="font-size:20px;letter-spacing:3px;user-select:text">${n.code}</b> <button id="copy-code">Copy</button><br><span class="subtle">${n.mode === 'tabs' ? 'Open this page in another tab of this browser, choose "Local tabs" and join with the code.' : 'Friends choose "Online" on the title screen and enter this code.'}</span></p>`;
      if (n.mode === 'manual') html += `<p><b>Manual invite</b> — one code exchange per player.</p><button id="mk-invite">Create invite code</button><div id="invite-area"></div>`;
      if (n.error) html += `<p class="need">${esc(n.error)}</p>`;
    } else html += `<p>Connected to the host.</p>`;
    html += `<h4>Party (${Object.keys(this.S.players).length}/4 online)</h4>` + players.map((p) => `<div class="list-row"><span class="ic" style="color:${p.color}">${CLASSES[p.cls].glyph}</span><span class="nm">${esc(p.name)} <span class="subtle">Lv ${p.level} ${CLASSES[p.cls].n}</span></span>${p.online ? '<span class="have">online</span>' : '<span class="subtle">offline</span>'}</div>`).join('');
    html += `<div class="row end">${this.v.isHost ? '<button id="save-btn">Save world</button>' : ''}<button id="leave-btn">Leave</button></div>`;
    if (this.v.isHost) html += `<p class="subtle">Saved worlds can be resumed from the title screen. Players rejoin by using the same character name.</p>`;
    body.innerHTML = html;
    if ($('#copy-code', body)) $('#copy-code', body).onclick = () => navigator.clipboard?.writeText(n.code).then(() => this.toast('Copied!', 'info'));
    if ($('#save-btn', body)) $('#save-btn', body).onclick = () => { this.v.save(); this.toast('World saved.', 'info'); };
    $('#leave-btn', body).onclick = () => { if (confirm('Leave the game?')) location.reload(); };
    if ($('#mk-invite', body)) $('#mk-invite', body).onclick = async () => {
      const area = $('#invite-area', body);
      area.innerHTML = '<p class="subtle">Generating… (gathering network routes)</p>';
      const inv = await n.manual.createInvite();
      area.innerHTML = `<p>1. Send this code to your friend:</p><textarea rows="4" readonly>${inv.code}</textarea><button id="cp-off">Copy</button>
        <p>2. Paste their reply code here:</p><textarea id="ans" rows="4"></textarea><button id="acc">Connect</button>`;
      $('#cp-off', area).onclick = () => navigator.clipboard?.writeText(inv.code).then(() => this.toast('Copied!', 'info'));
      $('#acc', area).onclick = async () => {
        try { await inv.accept($('#ans', area).value); area.innerHTML = '<p class="have">Connecting… they will appear in the party list.</p>'; }
        catch (err) { this.toast('Invalid reply code: ' + err.message); }
      };
    };
  }
  renderHelp() {
    this.panels.help.body.innerHTML = `<div class="help">
      <h3>Basics</h3>
      <ul><li><b>Left-click</b> ground to walk; enemies to attack; chests, bushes, the merchant etc. to interact. With an axe/pickaxe in your bags, clicking a tree/rock chops/mines it.</li>
      <li><b>Right-click anything</b> for every option — including <b>using any of your items on it</b>.</li>
      <li><kbd>I</kbd> inventory · <kbd>C</kbd> crafting · <kbd>P</kbd> character · <kbd>N</kbd> party · <kbd>H</kbd> help · <kbd>Enter</kbd> chat · <kbd>WASD</kbd> pan · <kbd>Q</kbd>/<kbd>E</kbd> or middle-drag to rotate the camera · <kbd>F</kbd> recenter · wheel to zoom</li></ul>
      <h3>Turn-based combat</h3>
      <ul><li>Combat starts when enemies spot you (or you attack). Every action costs <b>AP</b>: you get +4 per turn and can bank up to 6.</li>
      <li>Moving costs 1 AP per ${3} tiles. Attacks 2 AP, throws 2 AP, items 1 AP. <kbd>1</kbd>–<kbd>5</kbd> pick attack/skills, <kbd>Space</kbd> ends your turn.</li>
      <li>Downed allies can be revived with a healing potion (use it on them) or Mend. Rest at a lit campfire to recover.</li></ul>
      <h3>Elements &amp; surfaces</h3>
      <ul><li><b>Oil + fire</b> → the whole slick ignites. <b>Poison + fire</b> → explosion.</li>
      <li><b>Water + lightning</b> → electrified pool: everyone in it is shocked. Wet + shocked = <b>stunned</b>.</li>
      <li><b>Water + frost</b> → ice; anyone standing in the water is <b>frozen</b>. Physical hits shatter frozen targets.</li>
      <li><b>Fire + water</b> → steam (makes everyone wet). Blood from wounds conducts and freezes too.</li>
      <li>Barrels: oil barrels explode in fire, powder kegs explode violently. Trees burn (and charred trees give charcoal).</li></ul>
      <h3>Crafting &amp; interactions</h3>
      <ul><li>Drag one item onto another to combine. Unknown combos are discovered by experimenting — the recipe book shows hints.</li>
      <li>Weapons and arrows can be <b>coated</b>: drag a paste (ember, frost, storm, venom) or a flask of oil/poison onto them.</li>
      <li>Herbs + mortar → pastes. Flask + water → fill at wells, lakes or water barrels. Oil from oil barrels.</li>
      <li>Light the forge (tinderbox / torch), smelt iron ore, forge gear with a hammer. Burn logs on a campfire for charcoal; charcoal + sulfur → gunpowder.</li>
      <li>Anything can be thrown. Flasks shatter into surfaces; bombs combine liquids and elements.</li></ul>
      <h3>Light, darkness &amp; hitting</h3>
      <ul><li>Attacks and attack spells roll to hit. Base 90% melee / 85% ranged &amp; spells, ±2% per Finesse point of attacker and target.</li>
      <li>Every tile is <b>☀ Lit</b>, <b>◐ Dim</b> (−15% to hit anyone there) or <b>● Dark</b> (−35%). Attacking a lit target from darkness gives +10%.</li>
      <li>Light comes from the time of day (day → dusk → night), campfires, forges, burning ground, trees and creatures, glowing imps and wisps — and a <b>lit torch in your off-hand</b>. Forests and interiors are darker.</li>
      <li>Water puts out torches and fires. Steam clouds dim the light; <b>smoke bombs</b> make a pool of darkness. Wolves, skeletons, slimes and wisps see in the dark — so can you, with a <b>Nightsight Draught</b>.</li>
      <li>A missed spell still lands on its tile: a missed firebolt still ignites the oil. Press <kbd>L</kbd> for the light map; targeting colours your range by light.</li></ul>
      <h3>Multiplayer</h3>
      <ul><li>The host's browser simulates the world; up to 3 friends connect directly to it. Share the room code (Online/Local tabs) or exchange codes (Manual).</li>
      <li>Combat pulls in the whole party. Use <kbd>Right-click → Ping</kbd> to mark a spot for friends.</li></ul>
    </div>`;
  }

  // ================================================================ tooltips
  itemTip(s) {
    const d = ITEMS[s.id];
    if (!d) return '';
    const L = [`<h4 style="color:${d.c}">${esc(itemName(s))}${s.q > 1 ? ' ×' + s.q : ''}</h4>`];
    if (d.weapon) { const w = d.weapon; L.push(`Weapon: ${w.dmg[0]}-${w.dmg[1]} ${w.type}${w.el ? ' +' + w.el : ''}, range ${w.range}, ${w.ap} AP${w.twoHanded ? ', two-handed' : ''}. Scales with ${w.stat}.`); }
    if (d.armor) L.push(`Armor +${d.armor} (${d.slot})`);
    if (s.d?.coat) L.push(`<span style="color:${COAT[s.d.coat].c}">Coated: ${s.d.coat}${s.d.ch ? ` (${s.d.ch} hits)` : ''}</span>`);
    if (d.use) L.push(`Use: ${d.use.heal ? `heal ${d.use.heal[0]}-${d.use.heal[1]}` : ''}${d.use.cure ? ` cures ${d.use.cure.join(', ')}` : ''}${d.use.status ? ` ${STATUS[d.use.status[0]].n} for ${d.use.status[1]} rounds` : ''}`);
    if (d.light) L.push(`<span style="color:#ffe08a">Light source when held in the off-hand (bright ${d.light[0]}, dim ${d.light[1]})</span>`);
    if (d.throw) { const t = d.throw; L.push(`Throw: ${[t.liquid && t.liquid + ' surface', t.el && t.el, t.dmg && `${t.dmg[0]}-${t.dmg[1]} ${t.type}`, t.heal && 'heals'].filter(Boolean).join(', ')}${t.r ? ` (radius ${t.r})` : ''}`); }
    if (d.coat) L.push(`Coating: combine with a weapon or arrows (${d.coat}).`);
    if (d.tools.length) L.push(`Tool: ${d.tools.map(toolName).join(', ')}`);
    if (d.d) L.push(`<span class="d">${esc(d.d)}</span>`);
    return L.join('<br>');
  }
  creatureTip(e) {
    const L = [`<h4>${esc(e.name)}</h4>`];
    if (e.kind === 'player') L.push(`Lv ${e.level} ${CLASSES[e.cls].n}`);
    L.push(`HP ${e.hp}/${e.maxHp}${e.kind === 'enemy' && ENEMIES[e.type].armor ? ` · Armor ${ENEMIES[e.type].armor}` : ''}`);
    if (e.kind === 'enemy') {
      const res = ENEMIES[e.type].res || {};
      const parts = Object.entries(res).map(([k, v]) => (v >= 100 ? `immune to ${k}` : v < 0 ? `weak to ${k}` : `resists ${k}`));
      if (parts.length) L.push(`<span class="d">${parts.join(', ')}</span>`);
    }
    for (const [s, n] of Object.entries(e.st || {})) L.push(`<span style="color:${STATUS[s].c}">${STATUS[s].n} (${n})</span> <span class="d">${STATUS[s].d}</span>`);
    return L.join('<br>');
  }
  tileTip(x, y) {
    const v = this.v;
    if (!v.map.inb(x, y)) return '';
    const L = [];
    const at = v.index.at.get(v.map.idx(x, y)) || [];
    for (const e of at) {
      if (isCreature(e) && !e.dead) L.push(this.creatureTip(e));
      else if (e.kind === 'enemy' && e.dead) L.push(`<h4>${esc(e.name)} (dead)</h4>${e.items?.length ? 'Has loot.' : ''}`);
      else if (e.kind === 'object') L.push(`<h4>${esc(objName(e))}</h4>${e.type === 'pile' ? e.items.map((s) => esc(itemName(s)) + (s.q > 1 ? ' ×' + s.q : '')).join(', ') : `<span class="d">${esc(OBJECTS[e.type].d || '')}</span>`}`);
    }
    const s = surfaceAt(v.state, v.map, v.map.idx(x, y));
    if (s && !(s.base && !s.e)) L.push(`<b>${surfaceName(s)}</b>${s.t > 0 ? ` <span class="d">(${s.t} rounds)</span>` : ''}`);
    const lv = lightAt(v.state, v.map, x, y);
    L.push(`<span class="d">${TILES[v.map.tile(x, y)].n}${s?.base && !s.e ? ' (water)' : ''}</span> · <span style="color:${['#7f8cff', '#c9b98a', '#ffe08a'][lv]}">${LIGHT_ICONS[lv]} ${LIGHT_NAMES[lv]}${lv < 2 ? ` (${LIGHT_PENALTY[lv]}% to hit targets here)` : ''}</span>`);
    if (this.pathInfo) L.push(this.pathInfo);
    if (this.targetInfo) L.push(this.targetInfo);
    return L.join('<hr style="border:0;border-top:1px solid #5b4a36;margin:4px 0">');
  }
  bindTips() {
    const tip = $('#tip');
    document.addEventListener('mousemove', (ev) => {
      const el = ev.target.closest?.('[data-tip]');
      if (el && el.dataset.tip) this.showTip(el.dataset.tip, ev.clientX, ev.clientY);
      else if (ev.target !== this.r.cv) tip.classList.add('hidden');
    });
  }
  showTip(html, x, y) {
    const tip = $('#tip');
    tip.innerHTML = html;
    tip.classList.remove('hidden');
    const w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = Math.min(innerWidth - w - 8, x + 16) + 'px';
    tip.style.top = Math.min(innerHeight - h - 8, y + 16) + 'px';
  }

  // ================================================================ context menu
  showCtx(x, y, title, opts) {
    const c = $('#ctx');
    c.innerHTML = (title ? `<div class="h">${esc(title)}</div>` : '') + opts.map((o, i) => `<div class="o ${o.dis ? 'dis' : ''}" data-i="${i}"><span class="ic" style="color:${o.color || '#eadfcb'}">${o.ic || '•'}</span> ${o.label}</div>`).join('');
    c.classList.remove('hidden');
    c.style.left = Math.min(innerWidth - c.offsetWidth - 6, x) + 'px';
    c.style.top = Math.min(innerHeight - c.offsetHeight - 6, y) + 'px';
    $$('.o', c).forEach((el) => (el.onclick = (ev) => { const o = opts[+el.dataset.i]; if (o.dis) return; this.hideCtx(); o.fn(ev); }));
  }
  hideCtx() { $('#ctx').classList.add('hidden'); }
  usableStacks() {
    const me = this.me();
    const seen = new Set(), out = [];
    me.inv.forEach((s, i) => { const k = s.id + (s.d ? JSON.stringify(s.d) : ''); if (!seen.has(k)) { seen.add(k); out.push({ ref: String(i), s }); } });
    for (const slot of ['weapon', 'offhand']) if (me.eq[slot] && !seen.has(me.eq[slot].id)) out.push({ ref: 'eq:' + slot, s: me.eq[slot] });
    return out;
  }
  worldMenu(sx, sy, x, y) {
    const v = this.v, me = this.me();
    if (!v.map.inb(x, y)) return;
    const at = (v.index.at.get(v.map.idx(x, y)) || []).filter((e) => e.id !== me.id);
    const o = [];
    for (const t of at) {
      for (const d of defaultOptions(this.S, me, t)) o.push({ ic: '◆', label: `${esc(d.label)} <span class="subtle">${esc(t.kind === 'object' ? objName(t) : t.name)}</span>`, fn: () => this.send({ type: 'interact', target: t.id, opt: d.id }) });
      if (t.kind === 'object' && OBJECTS[t.type]?.destructible && this.inCombat()) o.push({ ic: '⚔', label: `Attack ${esc(objName(t))}`, fn: () => this.send({ type: 'attack', target: t.id }) });
    }
    let n = 0;
    const tileFree = !at.some((e) => e.kind === 'npc' || (e.kind === 'object' && OBJECTS[e.type]?.block));
    for (const t of [...at.filter((e) => e.kind !== 'npc'), ...(tileFree ? [null] : [])]) {
      for (const { ref, s } of this.usableStacks()) {
        for (const rule of applyRulesFor(this.S, v.map, me, s, t, x, y)) {
          if (n++ > 14) break;
          o.push({ ic: ITEMS[s.id].i, color: ITEMS[s.id].c, label: `${rule.label} <span class="subtle">with ${esc(itemName(s))}</span>`, fn: () => this.send({ type: 'apply', ref, target: t?.id, x, y, rule: rule.id }) });
        }
      }
    }
    const throwables = this.usableStacks().filter(({ ref, s }) => !ref.startsWith('eq:') && s.id !== 'gold' && (ITEMS[s.id].throw || ITEMS[s.id].throwDmg));
    if (throwables.length) o.push({ ic: '➚', label: 'Throw here ▸', fn: () => this.showCtx(sx, sy, 'Throw what?', throwables.map(({ ref, s }) => ({ ic: ITEMS[s.id].i, color: ITEMS[s.id].c, label: `${esc(itemName(s))}${s.q > 1 ? ' ×' + s.q : ''}`, fn: () => this.send({ type: 'throw', ref, x, y }) }))) });
    if (walkable(v.map, v.index, x, y)) o.push({ ic: '➜', label: 'Move here', fn: () => this.send({ type: 'move', x, y }) });
    o.push({ ic: '◎', label: 'Ping (mark for party)', fn: () => this.send({ type: 'ping', x, y }) });
    const title = at[0] ? (at[0].kind === 'object' ? objName(at[0]) : at[0].name) : TILES[v.map.tile(x, y)].n;
    this.showCtx(sx, sy, title, o);
  }

  // ================================================================ targeting
  startTargeting(t) {
    if (this.inCombat() && !this.myTurn()) return this.toast("It's not your turn.");
    this.targeting = t;
    let hint = '';
    if (t.kind === 'attack') hint = 'Click an enemy (or barrel/crate) to attack';
    if (t.kind === 'skill') hint = `${SKILLS[t.id].n}: pick a target`;
    if (t.kind === 'throw') hint = `Throw ${itemName(stackAt(this.me(), t.ref))}: pick a tile`;
    if (t.kind === 'apply') hint = `Use ${itemName(stackAt(this.me(), t.ref))} on…`;
    this.setHint(hint + ' — right-click / Esc to cancel');
    this.hideCtx();
    this.renderActions();
  }
  cancelTargeting() { this.targeting = null; this.setHint(''); this.r.overlay = null; this.renderActions(); }
  setHint(text) {
    let h = $('.targeting-hint');
    if (!text) { h?.remove(); return; }
    if (!h) { h = document.createElement('div'); h.className = 'targeting-hint'; $('#game').appendChild(h); }
    h.textContent = text;
  }
  useSkill(id) {
    const s = SKILLS[id];
    if (s.target === 'self') { this.send({ type: 'skill', id }); return; }
    this.startTargeting({ kind: 'skill', id });
  }
  targetSpec() {
    const t = this.targeting, me = this.me();
    if (!t) return null;
    if (t.kind === 'attack') { const w = weaponOf(me); return { range: w.range, aoe: 0, los: w.range > 1 }; }
    if (t.kind === 'skill') { const s = SKILLS[t.id]; return { range: skillRange(me, t.id), aoe: s.aoe || 0, los: !!s.los }; }
    if (t.kind === 'throw') { const s = stackAt(me, t.ref); return { range: throwRange(me), aoe: ITEMS[s?.id]?.throw?.r || 0, los: false }; }
    if (t.kind === 'apply') return { range: 1, aoe: 0, los: false };
  }
  confirmTarget(x, y, sx, sy) {
    const t = this.targeting, me = this.me(), v = this.v;
    const at = (v.index.at.get(v.map.idx(x, y)) || []).filter((e) => e.id !== me.id || (t.kind === 'skill' && SKILLS[t.id].target === 'ally'));
    const creature = at.find((e) => isCreature(e) && !e.dead && e.kind !== 'npc');
    if (t.kind === 'attack') {
      const tgt = at.find((e) => (e.kind === 'enemy' && !e.dead) || (e.kind === 'object' && OBJECTS[e.type]?.destructible));
      if (!tgt) return this.toast('Pick an enemy or a breakable object.');
      this.send({ type: 'attack', target: tgt.id });
    } else if (t.kind === 'skill') {
      const s = SKILLS[t.id];
      const target = s.target === 'enemy' ? at.find((e) => e.kind === 'enemy' && !e.dead) : s.target === 'ally' ? at.find((e) => e.kind === 'player') : creature;
      const sk = me.skills.find((q) => q.id === t.id);
      const err = skillError(this.S, v.map, v.index, me, sk, { x, y, target }, (a, b, c, d) => los(v.map, v.index, a, b, c, d));
      if (err) return this.toast(err);
      this.send({ type: 'skill', id: t.id, x, y, target: target?.id });
    } else if (t.kind === 'throw') {
      this.send({ type: 'throw', ref: t.ref, x, y });
    } else if (t.kind === 'apply') {
      const s = stackAt(me, t.ref);
      const opts = [];
      for (const tg of [...at.filter((e) => e.kind !== 'npc'), null]) for (const rule of applyRulesFor(this.S, v.map, me, s, tg, x, y)) opts.push({ rule, tg });
      if (!opts.length) { this.toast(`Using ${itemName(s)} there does nothing.`); return; }
      if (opts.length === 1) this.send({ type: 'apply', ref: t.ref, target: opts[0].tg?.id, x, y, rule: opts[0].rule.id });
      else this.showCtx(sx, sy, `Use ${itemName(s)}`, opts.map(({ rule, tg }) => ({ ic: ITEMS[s.id].i, label: rule.label + (tg ? ` <span class="subtle">${esc(tg.kind === 'object' ? objName(tg) : tg.name)}</span>` : ''), fn: () => this.send({ type: 'apply', ref: t.ref, target: tg?.id, x, y, rule: rule.id }) })));
    }
    this.cancelTargeting();
  }

  hostileAt(x, y) {
    const at = this.v.index.at.get(this.v.map.idx(x, y)) || [];
    return at.find((e) => e.kind === 'enemy' && !e.dead);
  }
  hitHtml(att, tgt, kind) {
    const h = hitChance(this.S, this.v.map, att, tgt, kind);
    const col = h.chance >= 75 ? '#6ee07a' : h.chance >= 50 ? '#f2c94c' : '#ff6b6b';
    return `<b style="color:${col}">${h.chance}% to hit</b> <span class="d">(${esc(describeHit(h)) || 'no modifiers'})</span>`;
  }
  /** Called every frame: hover info, path preview, targeting overlay. */
  frame() {
    const me = this.me(), v = this.v;
    if (!me || !this.mouse) return;
    const [x, y] = this.r.screenToTile(this.mouse.x, this.mouse.y);
    this.r.hover = [x, y];
    this.pathInfo = this.targetInfo = null;
    const spec = this.targetSpec();
    if (spec) {
      const key = `${x},${y},${me.x},${me.y},${this.targeting.kind},${this.targeting.id || this.targeting.ref}`;
      if (key !== this.ovKey) {
        this.ovKey = key;
        const range = [];
        for (let dy = -spec.range; dy <= spec.range; dy++) for (let dx = -spec.range; dx <= spec.range; dx++) range.push([me.x + dx, me.y + dy]);
        const inRange = cheb(me.x, me.y, x, y) <= spec.range;
        const sight = !spec.los || los(v.map, v.index, me.x, me.y, x, y);
        this.r.overlay = { rangeTiles: range, aoe: circleTiles(x, y, spec.aoe), valid: inRange && sight, light: true };
        this.ovValid = inRange ? (sight ? '' : 'No line of sight') : 'Out of range';
      }
      const t = this.targeting;
      const rolls = t.kind === 'attack' || (t.kind === 'skill' && (SKILLS[t.id].attack || t.id === 'aimed_shot'));
      const foe = rolls && this.hostileAt(x, y);
      this.targetInfo = (this.ovValid ? `<span class="need">${this.ovValid}</span>` : '') + (foe ? (this.ovValid ? '<br>' : '') + this.hitHtml(me, foe, t.kind === 'skill' && t.id !== 'aimed_shot' ? 'spell' : weaponOf(me).ranged ? 'ranged' : 'melee') : '');
    } else if (this.inCombat() && this.myTurn() && walkable(v.map, v.index, x, y) && !v.index.creatures.has(v.map.idx(x, y))) {
      const key = `${x},${y},${me.x},${me.y},${me.ap},${me.mp}`;
      if (key !== this.ovKey) {
        this.ovKey = key;
        const keys = new Set(v.index.creatures.keys());
        keys.delete(v.map.idx(me.x, me.y));
        const path = findPath(v.map, v.index, me.x, me.y, x, y, { blockCreatures: keys, maxNodes: 1500 }) || [];
        const reach = me.mp + me.ap * moveRange(me);
        const n = Math.min(path.length, reach);
        const cost = Math.ceil(Math.max(0, n - me.mp) / moveRange(me));
        this.r.overlay = { path, reach };
        this.pathPreviewInfo = path.length ? (path.length > reach ? `<span class="need">Too far (${path.length} tiles, can move ${reach})</span>` : `Move ${path.length} tiles: <b>${cost} AP</b>`) : '<span class="need">No path</span>';
      }
      this.pathInfo = this.pathPreviewInfo;
    } else if (this.r.overlay) { this.r.overlay = null; this.ovKey = null; }
    if (!spec && this.canAct()) {
      const foe = this.hostileAt(x, y);
      if (foe) this.targetInfo = `Left-click: attack · ${this.hitHtml(me, foe, weaponOf(me).ranged ? 'ranged' : 'melee')}`;
    }
    if (this.mouseOnCanvas && $('#ctx').classList.contains('hidden')) {
      const k = `${x},${y}`;
      const now = performance.now();
      if (k !== this.tipKey || now - (this.tipAt || 0) > 250) { this.tipKey = k; this.tipAt = now; const html = this.tileTip(x, y); if (html) this.showTip(html, this.mouse.x, this.mouse.y); }
    }
  }

  // ================================================================ input
  bindInput() {
    const cv = this.r.cv;
    cv.addEventListener('mousemove', (ev) => { this.mouse = { x: ev.clientX, y: ev.clientY }; this.mouseOnCanvas = true; });
    cv.addEventListener('mouseleave', () => { this.mouseOnCanvas = false; $('#tip').classList.add('hidden'); });
    cv.addEventListener('mousedown', (ev) => {
      this.hideCtx();
      const [x, y] = this.r.screenToTile(ev.clientX, ev.clientY);
      if (ev.button === 2) {
        if (this.targeting) { this.cancelTargeting(); return; }
        this.worldMenu(ev.clientX, ev.clientY, x, y);
        return;
      }
      if (ev.button !== 0) return;
      if (this.picking != null) { this.picking = null; this.renderPanel('inventory'); }
      if (this.targeting) return this.confirmTarget(x, y, ev.clientX, ev.clientY);
      this.defaultClick(x, y, ev);
    });
    cv.addEventListener('contextmenu', (ev) => ev.preventDefault());
    cv.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      this.r.cam.zoom = Math.max(0.5, Math.min(2.2, this.r.cam.zoom * (ev.deltaY > 0 ? 0.9 : 1.1)));
    }, { passive: false });
    cv.addEventListener('dragover', (ev) => ev.preventDefault());
    cv.addEventListener('drop', (ev) => {
      ev.preventDefault();
      const ref = ev.dataTransfer.getData('text/plain');
      if (ref === '') return;
      const [x, y] = this.r.screenToTile(ev.clientX, ev.clientY);
      this.dropOnWorld(ref, x, y, ev.clientX, ev.clientY);
    });
    document.addEventListener('mousedown', (ev) => { if (!ev.target.closest('#ctx') && ev.target !== cv) this.hideCtx(); });

    const chat = $('#chat');
    chat.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') { const t = chat.value.trim(); if (t) this.send({ type: 'chat', text: t }); chat.value = ''; chat.blur(); }
      if (ev.key === 'Escape') chat.blur();
    });
    addEventListener('keydown', (ev) => {
      if (!this.me() || ev.target.tagName === 'INPUT' || ev.target.tagName === 'TEXTAREA') return;
      const k = ev.key.toLowerCase();
      this.keys.add(k);
      if (k === 'enter') { chat.focus(); ev.preventDefault(); return; }
      if (k === 'escape') {
        if (this.targeting) return this.cancelTargeting();
        if (!$('#ctx').classList.contains('hidden')) return this.hideCtx();
        if (this.picking != null) { this.picking = null; return this.renderPanel('inventory'); }
        const open = Object.keys(this.panels).filter((id) => this.isOpen(id));
        if (open.length) this.hide(open[open.length - 1]);
        return;
      }
      if (k === 'i') this.toggle('inventory');
      else if (k === 'c') this.toggle('craft');
      else if (k === 'p') this.toggle('character');
      else if (k === 'h' || k === '?') this.toggle('help');
      else if (k === 'n') this.toggle('net');
      else if (k === 'f') { this.r.cam.ox = this.r.cam.oy = 0; }
      else if (k === 'l') { this.r.showLight = !this.r.showLight; this.toast(this.r.showLight ? 'Light map on: blue = dark, grey = dim.' : 'Light map off.', 'info'); }
      else if (k === ' ') { ev.preventDefault(); if (this.inCombat() && this.myTurn()) this.send({ type: 'endTurn' }); }
      else if (k === '+' || k === '=') this.r.cam.zoom = Math.min(2.2, this.r.cam.zoom * 1.1);
      else if (k === '-') this.r.cam.zoom = Math.max(0.5, this.r.cam.zoom / 1.1);
      else if (/^[1-9]$/.test(k)) { const it = this.actionItems?.[+k - 1]; if (it) it.act(); }
    });
    addEventListener('keyup', (ev) => this.keys.delete(ev.key.toLowerCase()));
    addEventListener('blur', () => this.keys.clear());
  }
  panCamera(dt) {
    const sp = 14 * dt / this.r.cam.zoom;
    let dx = 0, dy = 0;
    if (this.keys.has('w') || this.keys.has('arrowup')) dy -= sp;
    if (this.keys.has('s') || this.keys.has('arrowdown')) dy += sp;
    if (this.keys.has('a') || this.keys.has('arrowleft')) dx -= sp;
    if (this.keys.has('d') || this.keys.has('arrowright')) dx += sp;
    if (dx || dy) this.r.pan(dx, dy);
    if (this.keys.has('q')) this.r.cam.yaw += 1.8 * dt;
    if (this.keys.has('e')) this.r.cam.yaw -= 1.8 * dt;
  }
  defaultClick(x, y) {
    const v = this.v, me = this.me();
    if (!v.map.inb(x, y)) return;
    const at = (v.index.at.get(v.map.idx(x, y)) || []).filter((e) => e.id !== me.id);
    const enemy = at.find((e) => e.kind === 'enemy' && !e.dead);
    if (enemy) return this.send({ type: 'attack', target: enemy.id });
    for (const t of at) {
      const opts = defaultOptions(this.S, me, t).filter((o) => o.id !== 'smash');
      if (opts.length) return this.send({ type: 'interact', target: t.id, opt: opts[0].id });
      // auto-use a gathering tool (axe on tree, pickaxe on rock, knife on wolf...)
      for (const { ref, s } of this.usableStacks()) {
        const rule = applyRulesFor(this.S, v.map, me, s, t, x, y).find((r) => GATHER_RULES.includes(r.id));
        if (rule) return this.send({ type: 'apply', ref, target: t.id, x, y, rule: rule.id });
      }
    }
    if (walkable(v.map, v.index, x, y)) return this.send({ type: 'move', x, y });
    const blocker = at.find((e) => e.kind === 'object');
    if (blocker) this.toast(`${objName(blocker)}: right-click for options.`);
  }
  dropOnWorld(ref, x, y, sx, sy) {
    const v = this.v, me = this.me();
    const s = stackAt(me, ref);
    if (!s) return;
    const at = (v.index.at.get(v.map.idx(x, y)) || []).filter((e) => e.id !== me.id && e.kind !== 'npc');
    const opts = [];
    for (const tg of [...at, null]) for (const rule of applyRulesFor(this.S, v.map, me, s, tg, x, y)) opts.push({ rule, tg });
    if (opts.length === 1) return this.send({ type: 'apply', ref, target: opts[0].tg?.id, x, y, rule: opts[0].rule.id });
    const menu = opts.map(({ rule, tg }) => ({ ic: ITEMS[s.id].i, label: rule.label + (tg ? ` <span class="subtle">${esc(tg.kind === 'object' ? objName(tg) : tg.name)}</span>` : ''), fn: () => this.send({ type: 'apply', ref, target: tg?.id, x, y, rule: rule.id }) }));
    if (!ref.startsWith('eq:') && s.id !== 'gold') menu.push({ ic: '➚', label: 'Throw it here', fn: () => this.send({ type: 'throw', ref, x, y }) });
    if (!menu.length) return this.toast('Nothing to do with that there.');
    if (!opts.length) return menu[0].fn();
    this.showCtx(sx, sy, itemName(s), menu);
  }
}
