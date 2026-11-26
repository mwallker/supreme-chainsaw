export const OBJECTS = {
  tree: { n: 'Tree', block: true, sight: true, d: 'Chop with an axe. Burns if set alight.' },
  burning_tree: { n: 'Burning Tree', block: true, sight: true },
  burnt_tree: { n: 'Charred Tree', block: true, d: 'Chop it with an axe for charcoal.' },
  stump: { n: 'Stump', block: false },
  rock: { n: 'Boulder', block: true, sight: true, d: 'Mine with a pickaxe: stone and flint.' },
  ore: { n: 'Iron Vein', block: true, sight: true, d: 'Mine with a pickaxe for iron ore.' },
  sulfur_rock: { n: 'Sulfur Deposit', block: true, d: 'Mine with a pickaxe for sulfur.' },
  bush: { n: 'Herb Bush', block: false },
  well: { n: 'Well', block: true, d: 'Fill empty flasks here.' },
  campfire: { n: 'Campfire', block: true, station: 'campfire', d: 'Rest, cook meat, burn logs into charcoal.' },
  forge: { n: 'Forge', block: true, station: 'forge', d: 'Light it, then smelt ore and forge gear.' },
  workbench: { n: 'Workbench', block: true, station: 'workbench', d: 'Woodworking. Counts as a knife and axe.' },
  alchemy: { n: 'Alchemy Table', block: true, station: 'alchemy', d: 'Counts as a mortar & pestle.' },
  barrel: { n: 'Barrel', block: true, hp: 6, destructible: true },
  crate: { n: 'Crate', block: true, hp: 8, destructible: true, d: 'Smash it open.' },
  chest: { n: 'Chest', block: true, container: true },
  pile: { n: 'Items', block: false, container: true },
};
export const BARREL_NAMES = { oil: 'Oil Barrel', water: 'Water Barrel', poison: 'Poison Barrel', powder: 'Powder Keg' };
export const HERB_BUSH = { healroot: 'Healroot Bush', emberroot: 'Emberroot Bush', frostleaf: 'Frostleaf', stormcap: 'Stormcap Cluster', nightshade: 'Nightshade Bush' };
export function objName(e) {
  if (e.type === 'barrel') return BARREL_NAMES[e.liquid] || 'Barrel';
  if (e.type === 'bush') return HERB_BUSH[e.herb] || 'Bush';
  if (e.type === 'chest' && e.locked) return 'Locked Chest';
  if (e.type === 'campfire' || e.type === 'forge') return (e.lit ? 'Lit ' : 'Cold ') + OBJECTS[e.type].n;
  return e.name || OBJECTS[e.type]?.n || e.type;
}
