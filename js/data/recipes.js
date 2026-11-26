// Combination recipes. `in`: ingredients consumed. `tool`: capability required
// (from an item in your bags or a nearby station). `station`: must stand near it.
// A tool item may also be placed into the combine slots (e.g. drag herb onto mortar).
export const RECIPES = [
  { id: 'plank', in: { wood: 1 }, tool: 'axe', out: ['plank', 2], hint: 'Split a log with an axe.' },
  { id: 'stick', in: { plank: 1 }, tool: 'knife', out: ['stick', 4], hint: 'Whittle a plank with a blade.' },
  { id: 'torch', in: { stick: 1, cloth: 1 }, out: ['torch', 1], hint: 'Wrap cloth around a stick.' },
  { id: 'lit_torch', in: { torch: 1 }, tool: 'fire', out: ['lit_torch', 1], hint: 'A torch and any fire source.' },
  { id: 'string', in: { cloth: 1 }, tool: 'knife', out: ['string', 3], hint: 'Cut cloth into strips.' },
  { id: 'leather', in: { wolf_pelt: 1 }, tool: 'knife', out: ['leather', 2], hint: 'Scrape a pelt with a knife.' },
  { id: 'arrows', in: { stick: 1, feather: 1, flint: 1 }, out: ['arrows', 6], hint: 'Shaft, fletching and a sharp tip.' },
  { id: 'tinderbox', in: { flint: 1, stone: 1 }, out: ['tinderbox', 1], hint: 'Strike flint on stone.' },
  { id: 'mortar', in: { stone: 2 }, out: ['mortar', 1], hint: 'Two stones make a mortar.' },
  { id: 'ember_paste', in: { emberroot: 1 }, tool: 'mortar', out: ['ember_paste', 1], hint: 'Grind a warm root.' },
  { id: 'frost_paste', in: { frostleaf: 1 }, tool: 'mortar', out: ['frost_paste', 1], hint: 'Grind a cold leaf.' },
  { id: 'storm_paste', in: { stormcap: 1 }, tool: 'mortar', out: ['storm_paste', 1], hint: 'Grind a crackling mushroom.' },
  { id: 'venom_paste', in: { nightshade: 1 }, tool: 'mortar', out: ['venom_paste', 1], hint: 'Grind poisonous berries.' },
  { id: 'healing_potion', in: { flask_water: 1, healroot: 1 }, tool: 'mortar', out: ['healing_potion', 1], hint: 'Ground restorative root in water.' },
  { id: 'flask_poison', in: { flask_water: 1, nightshade: 1 }, out: ['flask_poison', 1], hint: 'Spoil clean water with berries.' },
  { id: 'antidote', in: { flask_water: 1, slime_gel: 1 }, out: ['antidote', 1], hint: 'Slimes are immune to poison. Why?' },
  { id: 'bandage', in: { cloth: 1, healroot: 1 }, out: ['bandage', 1], hint: 'Cloth and a healing herb.' },
  { id: 'fire_bomb', in: { flask_oil: 1, cloth: 1 }, out: ['fire_bomb', 1], hint: 'A flask of oil with a wick.' },
  { id: 'frost_bomb', in: { flask_water: 1, frost_paste: 1 }, out: ['frost_bomb', 1], hint: 'Water and something very cold.' },
  { id: 'shock_bomb', in: { flask_water: 1, storm_paste: 1 }, out: ['shock_bomb', 1], hint: 'Water and something crackling.' },
  { id: 'gunpowder', in: { charcoal: 1, sulfur: 1 }, tool: 'mortar', out: ['gunpowder', 2], hint: 'Ground charcoal and a yellow mineral.' },
  { id: 'powder_bomb', in: { empty_flask: 1, gunpowder: 1, cloth: 1 }, out: ['powder_bomb', 1], hint: 'Flask, black powder, wick.' },
  { id: 'spear', in: { stick: 2, flint: 1 }, out: ['spear', 1], hint: 'Two sticks and a sharp stone.' },
  { id: 'club', in: { wood: 1, string: 1 }, out: ['club', 1], hint: 'A log with a grip.' },
  { id: 'short_bow', in: { stick: 2, string: 2 }, tool: 'knife', out: ['short_bow', 1], hint: 'Bent sticks and twine.' },
  { id: 'oak_staff', in: { plank: 1, string: 1 }, out: ['oak_staff', 1], hint: 'A plank, wrapped.' },
  { id: 'storm_staff', in: { plank: 1, stormcap: 1, string: 1 }, out: ['storm_staff', 1], hint: 'A staff crowned with a crackling cap.' },
  { id: 'padded_tunic', in: { cloth: 3, string: 1 }, out: ['padded_tunic', 1], hint: 'Layers of cloth, stitched.' },
  { id: 'leather_armor', in: { leather: 3, string: 2 }, out: ['leather_armor', 1], hint: 'Leather, stitched.' },
  { id: 'wooden_shield', in: { plank: 2, leather: 1 }, station: 'workbench', out: ['wooden_shield', 1], hint: 'Planks and a strap, at a workbench.' },
  { id: 'empty_flask', in: { flint: 2 }, station: 'forge', out: ['empty_flask', 1], hint: 'Melt flint into glass at a lit forge.' },
  { id: 'iron_sword', in: { iron_ingot: 2, leather: 1 }, station: 'forge', tool: 'hammer', out: ['iron_sword', 1], hint: 'Two ingots and a leather grip. Forge + hammer.' },
  { id: 'iron_axe', in: { iron_ingot: 1, plank: 1 }, station: 'forge', tool: 'hammer', out: ['iron_axe', 1], hint: 'Ingot and plank. Forge + hammer.' },
  { id: 'pickaxe', in: { iron_ingot: 1, stick: 2 }, station: 'forge', tool: 'hammer', out: ['pickaxe', 1], hint: 'Ingot and two sticks. Forge + hammer.' },
  { id: 'hammer', in: { iron_ingot: 1, wood: 1 }, station: 'forge', out: ['hammer', 1], hint: 'Ingot and a log at a forge.' },
  { id: 'dagger', in: { iron_ingot: 1, string: 1 }, station: 'forge', tool: 'hammer', out: ['dagger', 1], hint: 'Ingot and twine. Forge + hammer.' },
  { id: 'iron_shield', in: { wooden_shield: 1, iron_ingot: 1 }, station: 'forge', tool: 'hammer', out: ['iron_shield', 1], hint: 'Reinforce a wooden shield.' },
  { id: 'iron_mail', in: { iron_ingot: 2, padded_tunic: 1 }, station: 'forge', tool: 'hammer', out: ['iron_mail', 1], hint: 'Rivet iron onto padding.' },
];
export const RECIPE_BY_ID = Object.fromEntries(RECIPES.map((r) => [r.id, r]));
export const STARTING_RECIPES = ['plank', 'stick', 'torch', 'lit_torch', 'fire_bomb', 'ember_paste', 'healing_potion', 'arrows'];

// Which stations stand in for which tools.
export const STATION_TOOLS = { alchemy: ['mortar'], workbench: ['knife', 'axe'], forge: ['hammer', 'fire'], campfire: ['fire'] };
