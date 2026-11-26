// Crafting: recipe matching, coatings, requirement checks (pure), and the host-side craft.
import { ITEMS, COAT, itemName } from '../data/items.js';
import { RECIPES, RECIPE_BY_ID, STATION_TOOLS } from '../data/recipes.js';
import { OBJECTS } from '../data/objects.js';
import { cheb } from '../util.js';
import { countItem, takeItem, addItem, hasToolItem } from './entities.js';

/** Resolve a slot reference ('3' inventory index or 'eq:weapon') to a stack. */
export function stackAt(e, ref) {
  if (typeof ref === 'string' && ref.startsWith('eq:')) return e.eq?.[ref.slice(3)] || null;
  return e.inv?.[+ref] || null;
}

export function nearStation(state, e, station) {
  for (const o of Object.values(state.entities)) {
    if (o.kind !== 'object' || OBJECTS[o.type]?.station !== station) continue;
    if (cheb(o.x, o.y, e.x, e.y) > 2) continue;
    if ((station === 'forge' || station === 'campfire') && !o.lit) continue;
    return true;
  }
  return false;
}
export function hasTool(state, e, tool) {
  if (hasToolItem(e, tool)) return true;
  for (const [st, tools] of Object.entries(STATION_TOOLS)) if (tools.includes(tool) && nearStation(state, e, st)) return true;
  return false;
}

const isCoatable = (s) => s && (ITEMS[s.id].weapon || ITEMS[s.id].ammo);

/** What combining these stacks would do: {kind:'recipe', recipe} | {kind:'coat', ...} | null */
export function matchCombination(stacks) {
  stacks = stacks.filter(Boolean);
  if (stacks.length === 2) {
    for (const [a, b] of [[stacks[0], stacks[1]], [stacks[1], stacks[0]]]) {
      if (isCoatable(a) && ITEMS[b.id].coat && !(ITEMS[b.id].weapon || ITEMS[b.id].ammo)) return { kind: 'coat', target: a, coat: b, el: ITEMS[b.id].coat };
    }
  }
  const totals = {};
  for (const s of stacks) totals[s.id] = (totals[s.id] || 0) + s.q;
  const ids = Object.keys(totals);
  for (const r of RECIPES) {
    const need = Object.keys(r.in);
    if (!need.every((id) => totals[id] >= r.in[id])) continue;
    const extra = ids.filter((id) => !need.includes(id));
    // allowed extra: exactly one tool item providing the recipe's tool
    if (extra.length === 0 || (extra.length === 1 && r.tool && ITEMS[extra[0]].tools.includes(r.tool))) return { kind: 'recipe', recipe: r };
  }
  return null;
}

export function recipeMissing(state, e, r, checkIngredients = true) {
  const miss = [];
  if (checkIngredients) for (const [id, q] of Object.entries(r.in)) if (countItem(e, id) < q) miss.push(`${q}× ${ITEMS[id].n}`);
  if (r.tool && !hasTool(state, e, r.tool)) miss.push(`tool: ${toolName(r.tool)}`);
  if (r.station && !nearStation(state, e, r.station)) miss.push(`near a ${r.station === 'forge' || r.station === 'campfire' ? 'lit ' : ''}${OBJECTS[r.station].n}`);
  return miss;
}
export const toolName = (t) => ({ knife: 'knife/dagger', axe: 'axe', pickaxe: 'pickaxe', mortar: 'mortar & pestle', hammer: 'hammer', fire: 'fire source' })[t] || t;

export function describeResult(m) {
  if (!m) return null;
  if (m.kind === 'coat') return `${COAT[m.el].n} ${ITEMS[m.target.id].n}`;
  const [id, q] = m.recipe.out;
  return `${q > 1 ? q + '× ' : ''}${ITEMS[id].n}`;
}

// ---------------- host side ----------------
export function doCombine(G, pid, e, refs) {
  const stacks = refs.map((r) => stackAt(e, r));
  if (stacks.some((s) => !s)) return G.tell(pid, 'Invalid items.');
  if (new Set(refs.map(String)).size !== refs.length) return G.tell(pid, 'Pick different items.');
  const m = matchCombination(stacks);
  if (!m) { G.tell(pid, "Those don't combine into anything."); G.float(e, '?', '#aaa'); return; }
  if (!G.spendAp(pid, e, 1)) return;
  if (m.kind === 'coat') return applyCoating(G, e, m);
  return craftRecipe(G, pid, e, m.recipe.id, true);
}

function applyCoating(G, e, m) {
  const { target, coat, el } = m;
  const tdef = ITEMS[target.id];
  const cdef = ITEMS[coat.id];
  // consume coating item (from wherever it is)
  coat.q--;
  if (cdef.liquid) addItem(e, 'empty_flask', 1);
  if (tdef.ammo) {
    const n = Math.min(10, target.q);
    target.q -= n;
    addItem(e, target.id, n, { coat: el });
    G.log(`${e.name} coats ${n} arrows: ${COAT[el].n.toLowerCase()}!`, 'craft');
  } else {
    target.d = { coat: el, ch: 4 };
    G.log(`${e.name} coats their ${tdef.n}: ${COAT[el].n.toLowerCase()} for 4 hits.`, 'craft');
  }
  e.inv = e.inv.filter((s) => s.q > 0);
  G.fx({ type: 'craft', x: e.x, y: e.y, c: COAT[el].c });
}

export function craftRecipe(G, pid, e, rid, apPaid = false) {
  const r = RECIPE_BY_ID[rid];
  if (!r) return;
  const miss = recipeMissing(G.state, e, r);
  if (miss.length) return G.tell(pid, 'Missing: ' + miss.join(', '));
  if (!apPaid && !G.spendAp(pid, e, 1)) return;
  for (const [id, q] of Object.entries(r.in)) takeItem(e, id, q);
  const [oid, oq] = r.out;
  const left = addItem(e, oid, oq);
  if (left) G.dropItems(e.x, e.y, [{ id: oid, q: left }]);
  const fresh = !G.state.recipes.includes(r.id);
  if (fresh) G.state.recipes.push(r.id);
  G.log(`${e.name} crafted ${oq > 1 ? oq + '× ' : ''}${ITEMS[oid].n}${fresh ? ' — new recipe discovered!' : ''}`, fresh ? 'good' : 'craft');
  G.fx({ type: 'craft', x: e.x, y: e.y, c: ITEMS[oid].c });
}

export { itemName, RECIPES };
