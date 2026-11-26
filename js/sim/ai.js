// Simple enemy brain: use a skill if possible, else attack, else close distance (avoiding hazards).
import { ENEMIES } from '../data/enemies.js';
import { SKILLS } from './skills.js';
import { weaponOf, moveRange } from './entities.js';
import { findPath, los } from './map.js';
import { surfaceAt } from './rules.js';
import { cheb, chance } from '../util.js';

export function aiStep(G, e) {
  const r = G.rtOf(e.id);
  if (++r.aiSteps > 12) return null;
  if (e.ap <= 0 && e.mp <= 0) return null;
  const def = ENEMIES[e.type];
  const foes = G.players().filter((p) => !p.downed && G.inCombat(p));
  if (!foes.length) return null;
  const { map } = G;
  const index = G.index;
  const sees = (f) => los(map, index, e.x, e.y, f.x, f.y);
  foes.sort((a, b) => cheb(e.x, e.y, a.x, a.y) + a.hp / 8 - (cheb(e.x, e.y, b.x, b.y) + b.hp / 8));

  // 1) skills
  for (const sk of e.skills) {
    const s = SKILLS[sk.id];
    if (sk.cd > 0 || s.ap > e.ap) continue;
    if (s.target === 'self') {
      const adj = foes.some((f) => cheb(e.x, e.y, f.x, f.y) <= 1);
      if ((sk.id === 'rally' && e.hp < e.maxHp * 0.5) || (sk.id === 'cleave' && adj)) {
        G.castSkill(e, sk, {});
        return 900;
      }
      continue;
    }
    const t = foes.find((f) => cheb(e.x, e.y, f.x, f.y) <= s.range && (!s.los || sees(f)));
    if (!t) continue;
    if (sk.id === 'rain' && (t.st.wet || !chance(0.5))) continue;
    if (s.target === 'ally') continue;
    G.castSkill(e, sk, { x: t.x, y: t.y, target: t });
    return 950;
  }
  // 2) basic attack
  const w = weaponOf(e);
  if (e.ap >= w.ap) {
    const t = foes.find((f) => cheb(e.x, e.y, f.x, f.y) <= w.range && (w.range <= 1 || sees(f)));
    if (t) {
      e.ap -= w.ap;
      G.weaponStrike(e, t, 1);
      return 750;
    }
  }
  // 3) move into range of the best target
  if (r.moved > 2) return null;
  let want = w.range;
  if (def.prefersRange) for (const sk of e.skills) if (SKILLS[sk.id].target !== 'self') want = Math.max(want, SKILLS[sk.id].range);
  const maxTiles = e.mp + e.ap * moveRange(e);
  if (maxTiles <= 0) return null;
  const hazard = (x, y) => {
    const s = surfaceAt(G.state, map, map.idx(x, y));
    if (!s) return 0;
    if (s.e) return 8;
    if (s.type === 'fire' && !(def.res?.fire >= 100)) return 8;
    if (s.type === 'poison' && !(def.res?.poison >= 100)) return 5;
    return 0;
  };
  for (const t of foes) {
    const path = findPath(map, index, e.x, e.y, t.x, t.y, { range: want, needLos: want > 1, blockCreatures: G.creatureKeys(e), cost: hazard, maxNodes: 2500 });
    if (!path || !path.length) continue;
    const steps = path.slice(0, maxTiles);
    G.payMove(e, steps.length);
    G.startPath(e, steps, null);
    r.moved = (r.moved || 0) + 1;
    return 200;
  }
  return null;
}
