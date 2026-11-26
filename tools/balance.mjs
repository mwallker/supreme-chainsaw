// Balance harness: plays full 3-level campaigns headlessly with bots on BOTH sides
// (player bot vs enemy bot), at ~50x speed on a virtual clock, across party sizes and class mixes.
//
//   node tools/balance.mjs                 evaluate current tuning (smart vs smart) + side matrix
//   node tools/balance.mjs --tune 6        auto-tune encounter multipliers for 6 iterations, then write them to js/data/levels.js
//   node tools/balance.mjs --runs 8        runs per party composition (default 6)
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
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
  const G = new Game({ level: 0, clock: () => t, timeScale: 0.02, enemyBrain });
  G.playerBrain = playerBrain;
  const party = comp.map((cls, i) => {
    const pid = 'bot' + i;
    const { eid } = G.addPlayer(pid, charFor(cls, i));
    G.botPlayers.add(eid);
    return G.ent(eid);
  });
  const step = (ms = 50) => { t += ms; G.tick(t); G.drain(); };
  const fullRest = () => { for (const p of party) { p.hp = p.maxHp; p.downed = false; p.st = {}; } };
  const records = [];
  const stalls = [];
  let alive = true;
  try {
    for (let L = 0; L < LEVELS.length && alive; L++) {
      if (L > 0) G.loadLevel(L);
      fullRest();
      for (const enc of LEVELS[L].encounters) {
        if (enc.checkpoint) { fullRest(); continue; }
        if (rest === 'always') fullRest();
        const info = G.state.levelInfo.encounters.find((e) => e.id === enc.id);
        for (const p of party) botPrep(G, p);
        const potionsBefore = party.reduce((a, p) => a + p.inv.filter((s) => s.id === 'healing_potion').reduce((b, s) => b + s.q, 0), 0);
        for (const p of party) { const [x, y] = G.freeTileNear(info.entry[0], info.entry[1]); G.place(p, x, y); }
        for (const p of party) G.handleAction(p.pid, { type: 'move', x: info.x, y: info.y });
        let started = false, guard = 0;
        const downed = new Set();
        while (guard++ < 20000) {
          step();
          if (G.state.combat) started = true;
          for (const p of party) if (p.downed) downed.add(p.id);
          if (started && !G.state.combat) break;
          if (!started && guard > 400) { G.startCombat(Object.values(G.state.entities).filter((e) => e.grp === enc.id && !e.dead).map((e) => e.id)); }
          if (G.state.combat && G.state.combat.round > 40) { G.state.combat = null; break; }
        }
        const win = G.encounterCleared(enc.id) && party.some((p) => !p.downed);
        const hpLeft = party.reduce((a, p) => a + Math.max(0, p.hp), 0) / party.reduce((a, p) => a + p.maxHp, 0);
        const potionsAfter = party.reduce((a, p) => a + p.inv.filter((s) => s.id === 'healing_potion').reduce((b, s) => b + s.q, 0), 0);
        if (guard >= 20000) stalls.push(`${enc.id} seed ${seed}`);
        records.push({ level: L, enc: enc.id, name: enc.name, win, rounds: G.lastRounds || 0, hpLeft: win ? hpLeft : 0, downs: downed.size, potions: Math.max(0, potionsBefore - potionsAfter), size: comp.length });
        if (!win) { alive = false; break; }
        for (const p of party) { if (p.downed) { p.downed = false; p.hp = Math.max(1, Math.floor(p.maxHp * 0.25)); } }
        for (let i = 0; i < 20; i++) step();
        for (const p of party) botPrep(G, p);
      }
    }
  } finally { Math.random = realRandom; }
  return { records, stalls, completed: alive, levels: party.map((p) => p.level) };
}

export function evaluate({ runs = RUNS, playerBrain = 'smart', enemyBrain = 'smart', sizes = [1, 2, 3, 4], rest = 'checkpoints', seedBase = 1000 } = {}) {
  const stats = {}; // enc -> {reached, wins, rounds, hp, downs, potions, bySize}
  const camp = { runs: 0, done: 0, bySize: {}, stalls: [] };
  let seed = seedBase;
  for (const n of sizes) for (const comp of COMPS[n]) for (let r = 0; r < runs; r++) {
    const res = runCampaign({ comp, seed: seed++, playerBrain, enemyBrain, rest });
    camp.runs++; if (res.completed) camp.done++;
    camp.stalls.push(...res.stalls);
    const cs = (camp.bySize[n] ||= { runs: 0, done: 0 }); cs.runs++; if (res.completed) cs.done++;
    for (const rec of res.records) {
      const s = (stats[rec.enc] ||= { name: rec.name, level: rec.level, reached: 0, wins: 0, rounds: 0, hp: 0, downs: 0, potions: 0, bySize: {} });
      s.reached++; if (rec.win) { s.wins++; s.hp += rec.hpLeft; s.rounds += rec.rounds; }
      s.downs += rec.downs; s.potions += rec.potions;
      const b = (s.bySize[n] ||= { reached: 0, wins: 0 }); b.reached++; if (rec.win) b.wins++;
    }
  }
  return { stats, camp };
}

const pct = (a, b) => (b ? Math.round((100 * a) / b) + '%' : '—');
function table(res, title) {
  const L = [`### ${title}`, '', '| Level | Encounter | Target win | Win (all) | 1p | 2p | 3p | 4p | Rounds | HP left (target) | Downs/fight | Potions/fight | Reached |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|'];
  for (const lv of LEVELS) for (const enc of lv.encounters) {
    if (enc.checkpoint) continue;
    const s = res.stats[enc.id];
    if (!s) { L.push(`| ${lv.name.split('.')[0]} | ${enc.name} | ${pct(enc.target, 1)} | — | | | | | | | | | 0 |`); continue; }
    const by = (n) => (s.bySize[n] ? pct(s.bySize[n].wins, s.bySize[n].reached) : '—');
    L.push(`| ${lv.name.split('.')[0]} | ${enc.name}${enc.boss ? ' (boss)' : ''} | ${pct(enc.target, 1)} | **${pct(s.wins, s.reached)}** | ${by(1)} | ${by(2)} | ${by(3)} | ${by(4)} | ${s.wins ? (s.rounds / s.wins).toFixed(1) : '—'} | ${s.wins ? pct(s.hp, s.wins) : '—'} (${pct(hpTarget(enc), 1)}) | ${(s.downs / s.reached).toFixed(2)} | ${(s.potions / s.reached).toFixed(2)} | ${s.reached} |`);
  }
  const c = res.camp;
  if (c.stalls?.length) L.push('', `⚠ Stalled fights: ${c.stalls.join(', ')}`);
  L.push('', `Full campaign completed: **${pct(c.done, c.runs)}** of ${c.runs} runs (` + Object.entries(c.bySize).map(([n, v]) => `${n}p ${pct(v.done, v.runs)}`).join(', ') + ').', '');
  return L.join('\n');
}

/** Intended average HP left after winning (conditional on a win): tighter later and at bosses. */
const hpTarget = (enc) => (enc.boss ? 0.45 : 0.62) - 0.05 * LEVELS.findIndex((l) => l.encounters.includes(enc));

function tune(iterations) {
  const knobs = {};
  for (const lv of LEVELS) for (const enc of lv.encounters) if (!enc.checkpoint) knobs[enc.id] = enc;
  for (let it = 1; it <= iterations; it++) {
    const res = evaluate({ runs: Math.max(3, RUNS - 2), seedBase: 5000 + it * 977 });
    const line = [];
    for (const [id, enc] of Object.entries(knobs)) {
      const s = res.stats[id];
      if (!s || s.reached < 4) continue;
      const wr = s.wins / s.reached;
      const hp = s.wins ? s.hp / s.wins : 0;
      // positive -> too easy -> raise difficulty. Win rate saturates near 100%, so HP left gives the gradient.
      const err = (wr - enc.target) * 2 + (hp - hpTarget(enc)) * 1.2;
      const f = Math.max(0.75, Math.min(1.35, 1 + err));
      enc.hpMul = +Math.max(0.4, Math.min(3, enc.hpMul * f)).toFixed(2);
      enc.dmgMul = +Math.max(0.5, Math.min(2, enc.dmgMul * Math.sqrt(f))).toFixed(2);
      line.push(`${id} ${Math.round(wr * 100)}%/${Math.round(hp * 100)}hp→${enc.hpMul}/${enc.dmgMul}`);
    }
    // party-size fairness: nudge SIZE_HP so every party size completes the campaign about equally often
    const mean = Object.values(res.camp.bySize).reduce((a, b) => a + b.done / b.runs, 0) / Object.keys(res.camp.bySize).length;
    for (const [n, b] of Object.entries(res.camp.bySize)) SIZE_HP[n] = +Math.max(0.4, Math.min(2.2, SIZE_HP[n] * (1 + Math.max(-0.3, Math.min(0.3, (b.done / b.runs - mean) * 0.9))))).toFixed(2);
    console.log(`iter ${it}: ` + line.join(' | ') + ` | SIZE_HP ${JSON.stringify(SIZE_HP)}`);
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

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();

function main() {
const t0 = Date.now();
if (TUNE) tune(TUNE);
const out = ['# Balance report', '', `Generated by \`node tools/balance.mjs\` — ${new Date().toISOString().slice(0, 10)}. Bots play full campaigns (Level I → III) at 50× speed; ${RUNS} runs per party composition, ${Object.values(COMPS).flat().length} compositions across party sizes 1–4.`, '',
  'Win rates are **first-attempt** and **conditional on reaching** the encounter. Parties rest only at the level start and the mid-level campfire (attrition between fights is real); downed members get back up at 25% HP after a won fight.', ''];
const main = evaluate({});
out.push(table(main, 'Smart player bots vs smart enemy bots (the tuning target)'));
console.log(table(main, 'smart vs smart'));
if (!QUICK) {
  const runs = Math.max(2, Math.floor(RUNS / 2));
  const m = [
    ['smart', 'basic', 'Smart players vs basic enemy AI (enemy bot switched off)'],
    ['basic', 'smart', 'Basic players (no item/surface tactics) vs smart enemies'],
  ];
  for (const [pb, eb, title] of m) {
    const r = evaluate({ runs, playerBrain: pb, enemyBrain: eb, seedBase: 9000 });
    out.push(table(r, title));
    console.log(table(r, title));
  }
  const rr = evaluate({ runs, rest: 'always', seedBase: 12000 });
  out.push(table(rr, 'Smart vs smart, resting before every fight (casual play)'));
}
fs.writeFileSync(new URL('../docs/BALANCE.md', import.meta.url), out.join('\n') + `\n_Simulation time: ${((Date.now() - t0) / 1000).toFixed(0)}s._\n`);
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(0)}s → docs/BALANCE.md`);
}
