// Peer-to-peer transports. The host runs the game; clients connect directly to it.
//  - peerjs: WebRTC data channels, using the free public PeerJS broker only to exchange connection info.
//  - manual: WebRTC with copy/paste signaling (zero servers besides public STUN).
//  - tabs:   BroadcastChannel between tabs of the same browser (for local testing).
import { Emitter } from '../util.js';

const CHUNK = 12000;
const PREFIX = 'emberwake-';
const ICE = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];

/** A message pipe with JSON encoding + chunking for big snapshots. Emits 'msg', 'close'. */
export class Channel extends Emitter {
  constructor(sendRaw, closeRaw) {
    super();
    this.sendRaw = sendRaw;
    this.closeRaw = closeRaw;
    this.parts = new Map();
    this.dead = false;
  }
  send(obj) {
    if (this.dead) return;
    const s = JSON.stringify(obj);
    try {
      if (s.length <= CHUNK) return this.sendRaw(s);
      const id = Math.random().toString(36).slice(2, 8);
      const n = Math.ceil(s.length / CHUNK);
      for (let i = 0; i < n; i++) this.sendRaw(`\u0001${id}|${i}|${n}|${s.slice(i * CHUNK, (i + 1) * CHUNK)}`);
    } catch (err) {
      console.warn('send failed', err);
    }
  }
  receive(raw) {
    if (typeof raw !== 'string') return;
    let s = raw;
    if (raw.charCodeAt(0) === 1) {
      const a = raw.indexOf('|'), b = raw.indexOf('|', a + 1), c = raw.indexOf('|', b + 1);
      const id = raw.slice(1, a), i = +raw.slice(a + 1, b), n = +raw.slice(b + 1, c);
      let p = this.parts.get(id);
      if (!p) this.parts.set(id, (p = { n, got: 0, arr: [] }));
      if (p.arr[i] == null) { p.arr[i] = raw.slice(c + 1); p.got++; }
      if (p.got < p.n) return;
      this.parts.delete(id);
      s = p.arr.join('');
    }
    let m;
    try { m = JSON.parse(s); } catch { return; }
    this.emit('msg', m);
  }
  closed() {
    if (this.dead) return;
    this.dead = true;
    this.emit('close');
  }
  close() {
    try { this.closeRaw?.(); } catch { /* ignore */ }
    this.closed();
  }
}

// ---------------------------------------------------------------- PeerJS
let peerjsLoading = null;
function loadPeerJS() {
  if (window.Peer) return Promise.resolve(window.Peer);
  if (!peerjsLoading) {
    peerjsLoading = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js';
      s.onload = () => (window.Peer ? res(window.Peer) : rej(new Error('PeerJS failed to load')));
      s.onerror = () => { peerjsLoading = null; rej(new Error('Could not load PeerJS (offline?). Try Manual or Local tabs mode.')); };
      document.head.appendChild(s);
    });
  }
  return peerjsLoading;
}
function wrapPeerConn(dc) {
  const ch = new Channel((s) => dc.send(s), () => dc.close());
  dc.on('data', (d) => ch.receive(d));
  dc.on('close', () => ch.closed());
  dc.on('error', () => ch.closed());
  return ch;
}

export class PeerHost extends Emitter {
  constructor(code) { super(); this.code = code; this.mode = 'peerjs'; }
  async start() {
    const Peer = await loadPeerJS();
    await new Promise((res, rej) => {
      this.peer = new Peer(PREFIX + this.code.toLowerCase(), { debug: 1 });
      this.peer.on('open', res);
      this.peer.on('error', (e) => rej(new Error('PeerJS: ' + (e.type || e.message))));
    });
    this.peer.on('connection', (dc) => {
      dc.on('open', () => this.emit('conn', wrapPeerConn(dc)));
    });
    this.peer.on('disconnected', () => { try { this.peer.reconnect(); } catch { /* ignore */ } });
  }
  close() { this.peer?.destroy(); }
}
export async function peerConnect(code) {
  const Peer = await loadPeerJS();
  const peer = new Peer({ debug: 1 });
  await new Promise((res, rej) => { peer.on('open', res); peer.on('error', (e) => rej(new Error('PeerJS: ' + (e.type || e.message)))); });
  return new Promise((res, rej) => {
    const dc = peer.connect(PREFIX + code.toLowerCase(), { reliable: true, serialization: 'raw' });
    const t = setTimeout(() => rej(new Error('No host answered with that code.')), 12000);
    peer.on('error', (e) => { clearTimeout(t); rej(new Error(e.type === 'peer-unavailable' ? 'No game found with that code.' : 'PeerJS: ' + e.type)); });
    dc.on('open', () => { clearTimeout(t); const ch = wrapPeerConn(dc); ch.on('close', () => peer.destroy()); res(ch); });
  });
}

// ---------------------------------------------------------------- Manual WebRTC
const encSdp = (d) => btoa(unescape(encodeURIComponent(JSON.stringify({ t: d.type, s: d.sdp }))));
const decSdp = (s) => { const o = JSON.parse(decodeURIComponent(escape(atob(s.trim())))); return { type: o.t, sdp: o.s }; };
function gathered(pc) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((res) => {
    const t = setTimeout(res, 5000);
    pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); res(); } });
  });
}
function wrapDc(dc, pc) {
  const ch = new Channel((s) => dc.send(s), () => { dc.close(); pc.close(); });
  dc.onmessage = (ev) => ch.receive(ev.data);
  dc.onclose = () => ch.closed();
  pc.addEventListener('connectionstatechange', () => { if (['failed', 'closed'].includes(pc.connectionState)) ch.closed(); });
  return ch;
}
export class ManualHost extends Emitter {
  constructor() { super(); this.mode = 'manual'; }
  async start() {}
  /** Creates an invite: returns { code, accept(answerCode) } */
  async createInvite() {
    const pc = new RTCPeerConnection({ iceServers: ICE });
    const dc = pc.createDataChannel('game', { ordered: true });
    dc.onopen = () => this.emit('conn', wrapDc(dc, pc));
    await pc.setLocalDescription(await pc.createOffer());
    await gathered(pc);
    return { code: encSdp(pc.localDescription), accept: (ans) => pc.setRemoteDescription(decSdp(ans)) };
  }
  close() {}
}
/** Client side: takes the host's invite code, returns { code (reply), ready: Promise<Channel> } */
export async function manualAnswer(offerCode) {
  const pc = new RTCPeerConnection({ iceServers: ICE });
  const ready = new Promise((res) => {
    pc.ondatachannel = (ev) => { const dc = ev.channel; dc.onopen = () => res(wrapDc(dc, pc)); };
  });
  await pc.setRemoteDescription(decSdp(offerCode));
  await pc.setLocalDescription(await pc.createAnswer());
  await gathered(pc);
  return { code: encSdp(pc.localDescription), ready };
}

// ---------------------------------------------------------------- Local tabs (BroadcastChannel)
export class TabsHost extends Emitter {
  constructor(code) { super(); this.code = code; this.mode = 'tabs'; this.peers = new Map(); }
  async start() {
    this.bc = new BroadcastChannel(PREFIX + this.code);
    this.bc.onmessage = (ev) => {
      const m = ev.data;
      if (!m || m.to !== 'host') return;
      if (m.k === 'hello' && !this.peers.has(m.from)) {
        const ch = new Channel((s) => this.bc.postMessage({ to: m.from, from: 'host', k: 'data', d: s }), () => this.bc.postMessage({ to: m.from, from: 'host', k: 'bye' }));
        this.peers.set(m.from, ch);
        ch.on('close', () => this.peers.delete(m.from));
        this.bc.postMessage({ to: m.from, from: 'host', k: 'ack' });
        this.emit('conn', ch);
      } else if (m.k === 'data') this.peers.get(m.from)?.receive(m.d);
      else if (m.k === 'bye') this.peers.get(m.from)?.closed();
    };
    addEventListener('beforeunload', () => { for (const ch of this.peers.values()) ch.close(); });
  }
  close() { this.bc?.close(); }
}
export function tabsConnect(code) {
  return new Promise((res, rej) => {
    const me = 'c' + Math.random().toString(36).slice(2, 9);
    const bc = new BroadcastChannel(PREFIX + code);
    let ch = null;
    const t = setTimeout(() => { bc.close(); rej(new Error('No host tab found with that code.')); }, 2500);
    bc.onmessage = (ev) => {
      const m = ev.data;
      if (!m || m.to !== me) return;
      if (m.k === 'ack' && !ch) {
        clearTimeout(t);
        ch = new Channel((s) => bc.postMessage({ to: 'host', from: me, k: 'data', d: s }), () => bc.postMessage({ to: 'host', from: me, k: 'bye' }));
        ch.on('close', () => bc.close());
        addEventListener('beforeunload', () => ch.close());
        res(ch);
      } else if (m.k === 'data') ch?.receive(m.d);
      else if (m.k === 'bye') ch?.closed();
    };
    bc.postMessage({ to: 'host', from: me, k: 'hello' });
  });
}
