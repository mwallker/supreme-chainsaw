// Item definitions. Everything here is data — behaviour lives in sim/.
// Fields: n name, i glyph, c color, stack max, v value, d description,
// tools: capabilities the item grants (knife, axe, pickaxe, mortar, hammer, fire)
// weapon/slot/armor: equipment, use: consumable effect, throw: thrown effect,
// coat: coating element when combined with a weapon/arrows, liquid: what it holds.
const W = (dmg, o = {}) => ({ slot: 'weapon', stack: 1, weapon: { dmg, type: 'physical', range: 1, stat: 'might', ap: 2, ...o } });

export const ITEMS = {
  gold: { n: 'Gold', i: '¤', c: '#f2c94c', stack: 9999, v: 1, d: 'Coins. The merchant in the village takes them.' },
  wood: { n: 'Log', i: '▬', c: '#8b5a2b', stack: 30, v: 1, d: 'Chopped from trees. Split it with an axe for planks, or burn it to charcoal on a campfire.' },
  stick: { n: 'Stick', i: '/', c: '#c0905d', stack: 30, v: 1 },
  plank: { n: 'Plank', i: '▭', c: '#d0a066', stack: 30, v: 2 },
  stone: { n: 'Stone', i: '●', c: '#9aa0a6', stack: 30, v: 1, throwDmg: [2, 4], d: 'Throwable in a pinch.' },
  flint: { n: 'Flint', i: '◆', c: '#7d8b94', stack: 30, v: 2, throwDmg: [1, 3] },
  iron_ore: { n: 'Iron Ore', i: '◈', c: '#b0745a', stack: 30, v: 3, throwDmg: [2, 4], d: 'Smelt it at a lit forge.' },
  sulfur: { n: 'Sulfur', i: '✦', c: '#e2d64b', stack: 30, v: 3 },
  iron_ingot: { n: 'Iron Ingot', i: '▰', c: '#cfd5da', stack: 20, v: 10, throwDmg: [3, 5] },
  charcoal: { n: 'Charcoal', i: '■', c: '#555', stack: 30, v: 2 },
  gunpowder: { n: 'Gunpowder', i: '⁂', c: '#9a9a9a', stack: 20, v: 6 },
  cloth: { n: 'Cloth', i: '▤', c: '#e4d8bd', stack: 30, v: 2 },
  string: { n: 'Twine', i: '∿', c: '#d2b98d', stack: 30, v: 1 },
  feather: { n: 'Feather', i: '❦', c: '#f0f0f0', stack: 30, v: 1 },
  bone: { n: 'Bone', i: '⌇', c: '#efe6cf', stack: 30, v: 1, throwDmg: [1, 3] },
  wolf_pelt: { n: 'Wolf Pelt', i: '≋', c: '#8d7b6a', stack: 10, v: 5 },
  leather: { n: 'Leather', i: '▥', c: '#a9744a', stack: 20, v: 4 },
  slime_gel: { n: 'Slime Gel', i: '◉', c: '#7cd65b', stack: 20, v: 3 },
  rusty_key: { n: 'Rusty Key', i: '⚷', c: '#c79a5b', stack: 5, v: 0, d: 'Opens a locked chest somewhere.' },
  raw_meat: { n: 'Raw Meat', i: '♨', c: '#d8545a', stack: 10, v: 2, use: { heal: [2, 3], risk: 'poisoned' }, d: 'Edible... barely. Cook it on a lit campfire.' },
  cooked_meat: { n: 'Roast Meat', i: '♨', c: '#c07a3d', stack: 10, v: 5, use: { heal: [8, 11] } },

  healroot: { n: 'Healroot', i: '❀', c: '#ff8fb1', stack: 20, v: 2, herb: true, d: 'A restorative root.' },
  emberroot: { n: 'Emberroot', i: '❀', c: '#ff7a2e', stack: 20, v: 3, herb: true, d: 'Warm to the touch. Grind it.' },
  frostleaf: { n: 'Frostleaf', i: '❄', c: '#8fdcff', stack: 20, v: 3, herb: true, d: 'Grows near water. Always cold.' },
  stormcap: { n: 'Stormcap', i: '♣', c: '#f2e35b', stack: 20, v: 3, herb: true, d: 'A mushroom that crackles.' },
  nightshade: { n: 'Nightshade', i: '♠', c: '#a77be0', stack: 20, v: 3, herb: true, d: 'Poisonous berries.' },

  ember_paste: { n: 'Ember Paste', i: '◐', c: '#ff6a1a', stack: 10, v: 5, coat: 'fire', d: 'Combine with a weapon or arrows to make them burn.' },
  frost_paste: { n: 'Frost Paste', i: '◐', c: '#9fe3ff', stack: 10, v: 5, coat: 'frost', d: 'Combine with a weapon or arrows for frost hits.' },
  storm_paste: { n: 'Storm Paste', i: '◐', c: '#f5e663', stack: 10, v: 5, coat: 'shock', d: 'Combine with a weapon or arrows for shocking hits.' },
  venom_paste: { n: 'Venom Paste', i: '◐', c: '#8ee05a', stack: 10, v: 5, coat: 'poison', d: 'Combine with a weapon or arrows to poison targets.' },

  empty_flask: { n: 'Empty Flask', i: '⚱', c: '#cfe8f0', stack: 10, v: 2, throw: { dmg: [1, 2], type: 'physical' }, d: 'Use it on water, an oil barrel or a poison puddle to fill it.' },
  flask_water: { n: 'Flask of Water', i: '⚱', c: '#4aa3df', stack: 10, v: 3, liquid: 'water', use: { cure: ['burning'], drink: true, returns: 'empty_flask' }, throw: { liquid: 'water', r: 1 }, d: 'Throw to soak an area. Pour on fires.' },
  flask_oil: { n: 'Flask of Oil', i: '⚱', c: '#7a5526', stack: 10, v: 5, liquid: 'oil', coat: 'oil', throw: { liquid: 'oil', r: 1 }, d: 'Throw to make a slick. Then add fire.' },
  flask_poison: { n: 'Flask of Poison', i: '⚱', c: '#6fcf3f', stack: 10, v: 6, liquid: 'poison', coat: 'poison', throw: { liquid: 'poison', r: 1 }, d: 'Toxic puddle. Explodes when ignited.' },
  healing_potion: { n: 'Healing Potion', i: '⚗', c: '#e8435a', stack: 10, v: 14, use: { heal: [12, 16], cure: ['poisoned'] }, throw: { heal: [8, 12], r: 1 }, d: 'Drink, use on an ally (revives the downed), or throw it.' },
  antidote: { n: 'Antidote', i: '⚗', c: '#9be36b', stack: 10, v: 8, use: { cure: ['poisoned', 'oiled'], heal: [3, 5] } },
  nightsight: { n: 'Nightsight Draught', i: '⚗', c: '#b48cff', stack: 10, v: 12, use: { status: ['nightsight', 20], drink: true }, d: 'See in the dark for 20 rounds: darkness counts as dim light, dim as lit.' },
  smoke_bomb: { n: 'Smoke Bomb', i: '✹', c: '#8a8a8a', stack: 10, v: 8, throw: { liquid: 'smoke', r: 1 }, d: 'A choking cloud. Anyone inside is in darkness: hard to hit, hard to see out of. Water clears it.' },
  bandage: { n: 'Bandage', i: '✚', c: '#f4efe4', stack: 10, v: 4, use: { heal: [6, 8], cure: ['burning'] } },

  fire_bomb: { n: 'Firebomb', i: '✹', c: '#ff5a1f', stack: 10, v: 10, throw: { liquid: 'oil', el: 'fire', r: 1, dmg: [4, 7], type: 'fire' }, d: 'Oil and a wick. Bursts into flame.' },
  frost_bomb: { n: 'Frost Grenade', i: '✹', c: '#9fe3ff', stack: 10, v: 10, throw: { el: 'frost', r: 1, dmg: [4, 7], type: 'frost' }, d: 'Chills targets and freezes water and blood.' },
  shock_bomb: { n: 'Storm Jar', i: '✹', c: '#f5e663', stack: 10, v: 10, throw: { liquid: 'water', el: 'shock', r: 1, dmg: [3, 6], type: 'shock' }, d: 'Water and lightning in a jar.' },
  powder_bomb: { n: 'Powder Bomb', i: '✺', c: '#e0483a', stack: 10, v: 16, throw: { el: 'fire', r: 2, dmg: [9, 15], type: 'physical', explosion: true }, d: 'Very loud. Very effective.' },

  torch: { n: 'Torch', i: '¡', c: '#a0703a', stack: 5, v: 2, slot: 'offhand', d: 'Unlit. Use it on any fire (or combine with a tinderbox) to light it.' },
  lit_torch: { n: 'Lit Torch', i: '¡', c: '#ffb347', stack: 5, v: 3, slot: 'offhand', light: [2, 5], tools: ['fire'], throw: { el: 'fire', r: 0, dmg: [2, 4], type: 'fire' },
    d: 'Hold it in your off-hand: lights the area around you (bright 2, dim 5) — you see your foes, and they see you. Goes out if you get wet. A fire source; throw it to ignite things.' },
  tinderbox: { n: 'Tinderbox', i: '♦', c: '#d1a15a', stack: 1, v: 4, tools: ['fire'], d: 'A fire source. Use it on oil, campfires, forges, enemies...' },
  mortar: { n: 'Mortar & Pestle', i: '⍜', c: '#bcb3a3', stack: 1, v: 8, tools: ['mortar'], d: 'Grinds herbs into pastes and potions.' },
  arrows: { n: 'Arrows', i: '↟', c: '#d9c49a', stack: 99, v: 1, ammo: true },

  dagger: { n: 'Dagger', i: '†', c: '#d0d6dc', v: 8, tools: ['knife'], ...W([2, 5], { stat: 'finesse', crit: 15 }), d: 'Also works as a knife.' },
  rusty_sword: { n: 'Rusty Sword', i: '⚔', c: '#b98b6a', v: 6, ...W([3, 6]) },
  iron_sword: { n: 'Iron Sword', i: '⚔', c: '#e3e8ec', v: 30, ...W([5, 9]) },
  club: { n: 'Club', i: '⚲', c: '#8b5a2b', v: 3, ...W([3, 5], { blunt: true }) },
  spear: { n: 'Flint Spear', i: '↑', c: '#a5b0b8', v: 8, ...W([4, 7], { range: 2, twoHanded: true }), d: 'Reach: hits 2 tiles away.' },
  iron_axe: { n: 'Iron Axe', i: '⚒', c: '#c9cfd4', v: 14, tools: ['axe'], ...W([4, 7]), d: 'Chops trees. Also chops bandits.' },
  pickaxe: { n: 'Pickaxe', i: '⛏', c: '#b9bfc4', v: 12, tools: ['pickaxe'], ...W([3, 5]) },
  hammer: { n: 'Smith Hammer', i: '⚒', c: '#9da4aa', v: 12, tools: ['hammer'], ...W([3, 6], { blunt: true }), d: 'Forging tool. Smashes locks.' },
  short_bow: { n: 'Short Bow', i: '➶', c: '#b07d4f', v: 12, ...W([3, 6], { range: 8, stat: 'finesse', ammo: 'arrows', twoHanded: true, ranged: true, proj: '#e8d9b0' }) },
  oak_staff: { n: 'Oak Staff', i: '⚚', c: '#9c7a52', v: 10, ...W([3, 5], { range: 5, stat: 'intellect', twoHanded: true, ranged: true, proj: '#c3a6ff', type: 'physical' }) },
  storm_staff: { n: 'Storm Staff', i: '⚚', c: '#f5e663', v: 24, ...W([4, 6], { range: 5, stat: 'intellect', twoHanded: true, ranged: true, el: 'shock', type: 'shock', proj: '#f5e663' }), d: 'Bolts electrify water.' },

  wooden_shield: { n: 'Wooden Shield', i: '⛉', c: '#b07d4f', stack: 1, v: 6, slot: 'offhand', armor: 1 },
  iron_shield: { n: 'Iron Shield', i: '⛉', c: '#cfd5da', stack: 1, v: 20, slot: 'offhand', armor: 2 },
  padded_tunic: { n: 'Padded Tunic', i: '⛊', c: '#cdbf9e', stack: 1, v: 6, slot: 'armor', armor: 1 },
  leather_armor: { n: 'Leather Armor', i: '⛊', c: '#a9744a', stack: 1, v: 14, slot: 'armor', armor: 2 },
  iron_mail: { n: 'Iron Mail', i: '⛊', c: '#cfd5da', stack: 1, v: 30, slot: 'armor', armor: 4 },
};

for (const [id, d] of Object.entries(ITEMS)) {
  d.id = id;
  if (d.stack == null) d.stack = 1;
  d.tools = d.tools || [];
}

export const COAT = {
  fire: { n: 'Burning', c: '#ff7a2e' },
  frost: { n: 'Frosted', c: '#9fe3ff' },
  shock: { n: 'Charged', c: '#f5e663' },
  poison: { n: 'Envenomed', c: '#7bd34a' },
  oil: { n: 'Oiled', c: '#8a6d3b' },
};

export function itemName(s) {
  const d = ITEMS[s.id];
  if (!d) return s.id;
  return s.d?.coat ? `${COAT[s.d.coat].n} ${d.n}` : d.n;
}

export const SHOP = [
  ['empty_flask', 4], ['flask_water', 5], ['flask_oil', 8], ['cloth', 3], ['string', 2], ['feather', 2],
  ['arrows', 1], ['torch', 3], ['nightsight', 18], ['tinderbox', 6], ['healing_potion', 16], ['iron_ingot', 14], ['mortar', 10],
];
export const sellPrice = (id) => Math.max(1, Math.floor((ITEMS[id]?.v || 0) / 2));

// Rarity tiers drive the slot frame and tooltip header. Derived from value; an item can override with `r`.
export const RARITY = {
  common: { n: 'Common', c: '#e9dcc4' },
  rare: { n: 'Rare', c: '#7fb6ff' },
  epic: { n: 'Epic', c: '#c99bff' },
  legendary: { n: 'Legendary', c: '#ffb347' },
};
export function rarityOf(s) {
  const d = ITEMS[s?.id];
  if (!d) return 'common';
  let r = d.r || (d.v >= 30 ? 'legendary' : d.v >= 20 ? 'epic' : d.v >= 12 ? 'rare' : 'common');
  if (s.d?.coat && r === 'common' && (d.weapon || d.ammo)) r = 'rare'; // a coated blade is a step up
  return r;
}
export function itemKind(d) {
  if (d.weapon) return `${d.weapon.twoHanded ? 'Two-handed' : 'One-handed'} ${d.weapon.ranged ? 'ranged weapon' : 'weapon'}`;
  if (d.slot === 'offhand') return d.armor ? 'Shield' : 'Off-hand';
  if (d.slot === 'armor') return 'Body armor';
  if (d.ammo) return 'Ammunition';
  if (d.coat && !d.liquid) return 'Coating';
  if (d.throw && !d.use) return 'Throwable';
  if (d.use) return 'Consumable';
  if (d.herb) return 'Herb';
  if (d.tools.length) return 'Tool';
  return 'Material';
}
