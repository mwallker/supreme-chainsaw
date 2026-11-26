// Balance harness: plays full 3-level campaigns headlessly with bots on BOTH sides
// (player bot vs enemy bot) in the engine's headless mode — no clock, no movement or animation
// waits: every fight is resolved turn by turn as fast as the bots can decide.
//
//   node tools/balance.mjs                 evaluate current tuning (smart vs smart) + side matrix
//   node tools/balance.mjs --tune 6        auto-tune encounter multipliers for 6 iterations, then write them to js/data/levels.js
//   node tools/balance.mjs --runs 8        runs per party composition (default 6)
//   --threads N                            worker threads (default: all cores)
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import { Worker, isMainThread } from 'node:worker_threads';
import { Game } from '../js/sim/game.js';
import { LEVELS, SIZE_HP } from '../js/data/levels.js';
import { CLASSES } from '../js/data/classes.js';
import { mulberry32 } from '../js/rng.js';
import { botPrep } from '../js/sim/bots.js';

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : d; };
const RUNS = +arg('--runs', 6);
const TUNE = +arg('--tune', 0);
const QUICK = !!arg('--quick', false);
const TUNE_RUNS = +arg('--tune-runs', 5);

const PRIMARY = { sellsword: 'might', ranger: 'finesse', alchemist: 'intellect', elementalist: 'intellect' };
const COMPS = {
  1: [['sellsword'], ['ranger'], ['alchemist'], ['elementalist']],
  2: [['sellsword', 'elementalist'], ['ranger', 'alchemist'], ['sellsword', 'ranger'], ['alchemist', 'elementalist']],
  3: [['sellsword', 'ranger', 'elementalist'], ['sellsword', 'alchemist', 'elementalist'], ['ranger', 'alchemist', 'elementalist']],
  4: [['sellsword', 'ranger', 'alchemist', 'elementalist'], ['sellsword', 'sellsword', 'elementalist', 'alchemist']],
};
const charFor = (cls, i) => {
  const attrs = { ...CLASSES[cls].attrs };
  attrs[PRIMARY[cls]] += 2; attrs.vigor += 1;
  return { name: `${cls}${i}`, cls, color: '#4fa3ff', attrs };
};

/** Plays one campaign. Returns per-encounter records. */
export function runCampaign({ comp, seed, playerBrain = 'smart', enemyBrain = 'smart', rest = 'checkpoints' }) {
  const realRandom = Math.random;
  Math.random = mulberry32(seed);
  let t = 0;
  const G = new Game({ level: 0, clock: () => t, headless: true, enemyBrain });
  G.playerBrain = playerBrain;
  const party = comp.map((cls, i) => {
    const pid = 'bot' + i;
    const { eid } = G.addPlayer(pid, charFor(cls, i));
    G.botPlayers.add(eid);
    return G.ent(eid);
  });
  const fullRest = () => { for (const p of party) { p.hp = p.maxHp; p.downed = false; p.st = {}; } };
  const records = [];
  const stalls = [];
  let alive = true;
  try {
    for (let L = 0; L < LEVELS.length; L++) {
      if (L > 0) G.loadLevel(L);
      fullRest();
      for (const enc of LEVELS[L].encounters) {
        if (enc.checkpoint) { fullRest(); continue; }
        if (rest === 'always') fullRest();
        const info = G.state.levelInfo.encounters.find((e) => e.id === enc.id);
        for (const p of party) botPrep(G, p);
        const potionsBefore = party.reduce((a, p) => a + p.inv.filter((s) => s.id === 'healing_potion').reduce((b, s) => b + s.q, 0), 0);
        let attempts = 0, firstWin = null, win = false, rounds = 0, downs = 0;
        while (attempts < 3 && !win) {
        attempts++;
        // the party arrives at the edge of the clearing; the fight starts (initiative decides who acts first)
        for (const p of party) { const [x, y] = G.freeTileNear(info.entry[0] + Math.sign(info.x - info.entry[0]) * 4, info.entry[1]); G.place(p, x, y); }
        G.startCombat(Object.values(G.state.entities).filter((e) => e.grp === enc.id && !e.dead).map((e) => e.id));
        const downed = new Set();
        const onDown = () => { for (const p of party) if (p.downed) downed.add(p.id); };
        const unsub = G.events.on('log', onDown);
        const rounds0 = G.runCombat(40);
        G.events.off('log', onDown);
        G.drain();
        if (rounds0 == null || G.state.combat) { stalls.push(`${enc.id} seed ${seed}`); G.state.combat = null; }
        win = G.encounterCleared(enc.id) && party.some((p) => !p.downed);
        if (firstWin === null) { firstWin = win; rounds = G.lastRounds || 0; downs = downed.size; }
        if (!win) { G.state.combat = null; fullRest(); for (const p of party) botPrep(G, p); }
        }
        if (!win) { // give up: clear the fight so later encounters still get samples
          for (const e of Object.values(G.state.entities)) if (e.grp === enc.id) e.dead = true;
          alive = false; fullRest();
        }
        const hpLeft = party.reduce((a, p) => a + Math.max(0, p.hp), 0) / party.reduce((a, p) => a + p.maxHp, 0);
        const potionsAfter = party.reduce((a, p) => a + p.inv.filter((s) => s.id === 'healing_potion').reduce((b, s) => b + s.q, 0), 0);
        records.push({ level: L, enc: enc.id, name: enc.name, win: firstWin, eventual: win, attempts, rounds, hpLeft: firstWin ? hpLeft : 0, downs, potions: Math.max(0, potionsBefore - potionsAfter), size: comp.length });
        for (const p of party) { if (p.downed) { p.downed = false; p.hp = Math.max(1, Math.floor(p.maxHp * 0.25)); } }
        for (const p of party) botPrep(G, p);
      }
    }
  } finally { Math.random = realRandom; }
  return { records, stalls, completed: alive, levels: party.map((p) => p.level) };
}

// ---------------------------------------------------------------- parallel evaluation
const THREADS = Math.max(1, Math.min(os.availableParallelism?.() || os.cpus().length, +arg('--threads', 99)));
let pool = null;
function getPool() {
  if (pool) return pool;
  const workers = Array.from({ length: THREADS }, () => new Worker(new URL('./balance-worker.mjs', import.meta.url)));
  const idle = [...workers], queue = [], pending = new Map();
  let nextId = 0;
  const pump = () => { while (idle.length && queue.length) { const w = idle.pop(); w.postMessage(queue.shift()); } };
  for (const w of workers) {
    w.on('message', (m) => { pending.get(m.id)(m.res); pending.delete(m.id); idle.push(w); pump(); });
    w.on('error', (err) => { console.error('worker error', err); process.exit(1); });
  }
  pool = {
    run(job) {
      const knobs = {};
      for (const lv of LEVELS) for (const e of lv.encounters) if (!e.checkpoint) knobs[e.id] = { hpMul: e.hpMul, dmgMul: e.dmgMul };
      return new Promise((res) => { const id = nextId++; pending.set(id, res); queue.push({ id, job, knobs, sizeHp: [...SIZE_HP] }); pump(); });
    },
    close() { for (const w of workers) w.terminate(); pool = null; },
  };
  return pool;
}

/** Plays every (party composition × run) campaign across worker threads and aggregates the records. */
export async function evaluate({ runs = RUNS, playerBrain = 'smart', enemyBrain = 'smart', sizes = [1, 2, 3, 4], rest = 'checkpoints', seedBase = 1000 } = {}) {
  const jobs = [];
  let seed = seedBase;
  for (const n of sizes) for (const comp of COMPS[n]) for (let r = 0; r < runs; r++) jobs.push({ comp, seed: seed++, playerBrain, enemyBrain, rest });
  const results = await Promise.all(jobs.map((j) => getPool().run(j)));
  const stats = {}; // enc -> {reached, wins, rounds, hp, downs, potions, bySize}
  const camp = { runs: 0, done: 0, bySize: {}, stalls: [] };
  results.forEach((res, i) => {
    const n = jobs[i].comp.length;
    camp.runs++; if (res.completed) camp.done++;
    camp.stalls.push(...res.stalls);
    const cs = (camp.bySize[n] ||= { runs: 0, done: 0 }); cs.runs++; if (res.completed) cs.done++;
    for (const rec of res.records) {
      const s = (stats[rec.enc] ||= { name: rec.name, level: rec.level, reached: 0, wins: 0, eventual: 0, rounds: 0, hp: 0, downs: 0, potions: 0, bySize: {} });
      s.reached++; if (rec.eventual) s.eventual++; if (rec.win) { s.wins++; s.hp += rec.hpLeft; s.rounds += rec.rounds; }
      s.downs += rec.downs; s.potions += rec.potions;
      const b = (s.bySize[n] ||= { reached: 0, wins: 0 }); b.reached++; if (rec.win) b.wins++;
    }
  });
  return { stats, camp };
}

const pct = (a, b) => (b ? Math.round((100 * a) / b) + '%' : '—');
function table(res, title) {
  const L = [`### ${title}`, '', '| Level | Encounter | Target win | 1st-try win | 1p | 2p | 3p | 4p | Won within 3 tries | Rounds | HP left (target) | Downs/fight | Potions/fight |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|'];
  for (const lv of LEVELS) for (const enc of lv.encounters) {
    if (enc.checkpoint) continue;
    const s = res.stats[enc.id];
    if (!s) { L.push(`| ${lv.name.split('.')[0]} | ${enc.name} | ${pct(enc.target, 1)} | — | | | | | | | | | |`); continue; }
    const by = (n) => (s.bySize[n] ? pct(s.bySize[n].wins, s.bySize[n].reached) : '—');
    L.push(`| ${lv.name.split('.')[0]} | ${enc.name}${enc.boss ? ' (boss)' : ''} | ${pct(enc.target, 1)} | **${pct(s.wins, s.reached)}** | ${by(1)} | ${by(2)} | ${by(3)} | ${by(4)} | ${pct(s.eventual, s.reached)} | ${s.wins ? (s.rounds / s.wins).toFixed(1) : '—'} | ${s.wins ? pct(s.hp, s.wins) : '—'} (${pct(hpTarget(enc), 1)}) | ${(s.downs / s.reached).toFixed(2)} | ${(s.potions / s.reached).toFixed(2)} |`);
  }
  const c = res.camp;
  if (c.stalls?.length) L.push('', `⚠ Stalled fights: ${c.stalls.join(', ')}`);
  L.push('', `Campaign completed (every fight won within 3 tries): **${pct(c.done, c.runs)}** of ${c.runs} runs (` + Object.entries(c.bySize).map(([n, v]) => `${n}p ${pct(v.done, v.runs)}`).join(', ') + ').', '');
  return L.join('\n');
}

/** Intended average HP left after winning (conditional on a win): tighter later and at bosses. */
const hpTarget = (enc) => (enc.boss ? 0.45 : 0.62) - 0.05 * LEVELS.findIndex((l) => l.encounters.includes(enc));

async function tune(iterations) {
  const knobs = {};
  const gain = {};
  for (const lv of LEVELS) for (const enc of lv.encounters) if (!enc.checkpoint) knobs[enc.id] = enc;
  for (let it = 1; it <= iterations; it++) {
    const t1 = Date.now();
    const res = await evaluate({ runs: TUNE_RUNS, seedBase: 5000 + it * 977 });
    const line = [];
    for (const [id, enc] of Object.entries(knobs)) {
      const s = res.stats[id];
      if (!s || s.reached < 4) continue;
      const wr = s.wins / s.reached;
      const hp = s.wins ? s.hp / s.wins : 0;
      // positive -> too easy -> raise difficulty. Win rate saturates near 100%, so HP left gives the gradient.
      // win rate first; HP left only refines fights that are already winning often enough
      const err = (wr - enc.target) * 2 + (wr >= enc.target - 0.02 ? (hp - hpTarget(enc)) * 1.2 : 0);
      // adaptive step per knob: halve the gain when the error flips sign (overshoot), grow it back otherwise
      const st = (gain[id] ||= { g: 0.6, s: 0 });
      const sign = Math.sign(err);
      st.g = st.s && sign && sign !== st.s ? Math.max(0.08, st.g * 0.5) : Math.min(0.6, st.g * 1.15);
      st.s = sign || st.s;
      const f = 1 + st.g * Math.max(-0.4, Math.min(0.4, err));
      enc.hpMul = +Math.max(0.4, Math.min(3.5, enc.hpMul * f ** 0.55)).toFixed(2);
      enc.dmgMul = +Math.max(0.5, Math.min(2.6, enc.dmgMul * f ** (enc.hpMul >= 3.4 ? 1 : 0.55))).toFixed(2);
      line.push(`${id} ${Math.round(wr * 100)}%/${Math.round(hp * 100)}hp→${enc.hpMul}/${enc.dmgMul}`);
    }
    // party-size fairness: per size, compare first-try win rates against each fight's target (12 fights of data per size)
    for (const n of [1, 2, 3, 4]) {
      let err = 0, w = 0;
      for (const [id, enc] of Object.entries(knobs)) { const b = res.stats[id]?.bySize[n]; if (b?.reached >= 2) { err += (b.wins / b.reached - enc.target) * b.reached; w += b.reached; } }
      if (!w) continue;
      err /= w;
      const st = (gain['size' + n] ||= { g: 0.8, s: 0 });
      const sign = Math.sign(err);
      st.g = st.s && sign && sign !== st.s ? Math.max(0.1, st.g * 0.5) : Math.min(0.8, st.g * 1.15);
      st.s = sign || st.s;
      SIZE_HP[n] = +Math.max(0.25, Math.min(2.5, SIZE_HP[n] * (1 + Math.max(-0.3, Math.min(0.3, err * st.g))))).toFixed(2);
    }
    // the two knobs multiply: keep size multipliers centred on 1 and move the overall scale into the encounters
    const g = Math.pow(SIZE_HP[1] * SIZE_HP[2] * SIZE_HP[3] * SIZE_HP[4], 1 / 4);
    for (const n of [1, 2, 3, 4]) SIZE_HP[n] = +(SIZE_HP[n] / g).toFixed(2);
    for (const enc of Object.values(knobs)) { enc.hpMul = +Math.min(3.5, enc.hpMul * g).toFixed(2); enc.dmgMul = +Math.min(2.6, enc.dmgMul * Math.sqrt(g)).toFixed(2); }
    console.log(`iter ${it} (${((Date.now() - t1) / 1000).toFixed(0)}s): ` + line.join(' | ') + ` | SIZE_HP ${JSON.stringify(SIZE_HP)}`);
  }
  // write back to levels.js
  const p = new URL('../js/data/levels.js', import.meta.url);
  let src = fs.readFileSync(p, 'utf8');
  for (const [id, enc] of Object.entries(knobs)) {
    src = src.replace(new RegExp(`(id: '${id}'[^\\n]*?hpMul: )[\\d.]+(, dmgMul: )[\\d.]+`), `$1${enc.hpMul}$2${enc.dmgMul}`);
  }
  src = src.replace(/export const SIZE_HP = \[[^\]]*\];/, `export const SIZE_HP = ${JSON.stringify(SIZE_HP).replace(/,/g, ', ')};`);
  fs.writeFileSync(p, src);
  console.log('Wrote tuned values to js/data/levels.js');
}

if (isMainThread && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().finally(() => pool?.close());

async function main() {
const t0 = Date.now();
if (TUNE) await tune(TUNE);
const out = ['# Balance report', '', `Generated by \`node tools/balance.mjs\` — ${new Date().toISOString().slice(0, 10)}. Bots play full campaigns (Level I → III) in the engine's headless mode (no clock or animation waits, parallel worker threads); ${RUNS} runs per party composition, ${Object.values(COMPS).flat().length} compositions across party sizes 1–4.`, '',
  '"1st-try win" is the share of parties that win the fight on their first attempt. Like real players, a party that loses respawns at the level start, rests and retries (up to 3 tries); "won within 3 tries" counts those. Parties rest only at the level start and the mid-level campfire, so attrition between fights is real. Downed members get back up at 25% HP after a won fight. HP left is the average remaining health after a first-try win.', ''];
const main = await evaluate({});
out.push(table(main, 'Smart player bots vs smart enemy bots (the tuning target)'));
console.log(table(main, 'smart vs smart'));
if (!QUICK) {
  const runs = Math.max(2, Math.floor(RUNS / 2));
  const m = [
    ['smart', 'basic', 'Smart players vs basic enemy AI (enemy bot switched off)'],
    ['basic', 'smart', 'Basic players (no item/surface tactics) vs smart enemies'],
  ];
  for (const [pb, eb, title] of m) {
    const r = await evaluate({ runs, playerBrain: pb, enemyBrain: eb, seedBase: 9000 });
    out.push(table(r, title));
    console.log(table(r, title));
  }
  const rr = await evaluate({ runs, rest: 'always', seedBase: 12000 });
  out.push(table(rr, 'Smart vs smart, resting before every fight (casual play)'));
}
fs.writeFileSync(new URL('../docs/BALANCE.md', import.meta.url), out.join('\n') + `\n_Simulation time: ${((Date.now() - t0) / 1000).toFixed(0)}s._\n`);
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(0)}s → docs/BALANCE.md`);
}
