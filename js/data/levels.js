// The three campaign levels. Each is generated from a fixed seed (so balance numbers are
// reproducible) along a road from the start camp to an exit gate guarded by a boss.
// Encounter balance knobs (tuned by tools/balance.mjs with player & enemy bots):
//   enemies    base group (solo party)
//   perPlayer  added once for every party member beyond the first
//   hpMul      enemy health multiplier
//   dmgMul     enemy damage multiplier
//   target     intended first-attempt win rate for the bots (smart vs smart)
export const LEVELS = [
  {
    id: 'greenwood', name: 'I. The Greenwood Road', seed: 1101, W: 124, H: 56, time: 10 * 60,
    blurb: 'Wolves and slimes have cut the village off from the trade road. A dire wolf has made the old gate its den.',
    terrain: { deep: 0.05, shallow: 0.09, sand: 0.12, rocky: 0.87, mount: 0.94, forest: 0.5 },
    village: true,
    encounters: [
      { id: 'g1', name: 'Wolf Pack', at: 0.3, clear: 'grass', enemies: ['wolf', 'wolf'], perPlayer: ['wolf'], hpMul: 2.58, dmgMul: 1.66, target: 0.95 },
      { id: 'g2', name: 'The Bog', at: 0.46, clear: 'bog', enemies: ['slime', 'slime'], perPlayer: ['slime'], hpMul: 1.81, dmgMul: 1.21, target: 0.92,
        props: [['barrel', 'poison']] },
      { checkpoint: true, at: 0.56 },
      { id: 'g3', name: 'Bandit Scouts', at: 0.7, clear: 'camp', enemies: ['bandit', 'bandit_archer'], perPlayer: ['bandit'], hpMul: 2.65, dmgMul: 1.49, target: 0.9,
        props: [['barrel', 'oil'], ['barrel', 'oil'], ['oil', 2], ['chest', [['gold', 15], ['flask_oil', 2], ['healing_potion', 1]]]] },
      { id: 'g4', name: 'The Dire Wolf', at: 0.9, boss: true, clear: 'grass', enemies: ['dire_wolf', 'wolf'], perPlayer: ['wolf'], hpMul: 2.08, dmgMul: 1.34, target: 0.85,
        props: [['chest', [['gold', 30], ['healing_potion', 2], ['iron_ingot', 2], ['leather', 3]]]] },
    ],
  },
  {
    id: 'marsh', name: "II. Smugglers' Marsh", seed: 2202, W: 128, H: 58, time: 19 * 60 + 20,
    blurb: 'Bandits and storm cultists run powder through the drowned marsh. Dusk is falling — and everything here is wet.',
    terrain: { deep: 0.1, shallow: 0.22, sand: 0.27, rocky: 0.9, mount: 0.96, forest: 0.62 },
    supplies: [['torch', 2], ['flask_water', 2], ['healing_potion', 2], ['fire_bomb', 1]],
    encounters: [
      { id: 'm1', name: 'Storm Cultists', at: 0.26, clear: 'marsh', enemies: ['storm_cultist', 'bandit'], perPlayer: ['storm_cultist'], hpMul: 2.37, dmgMul: 1.43, target: 0.88 },
      { id: 'm2', name: 'Oil Depot', at: 0.44, clear: 'camp', enemies: ['bandit', 'bandit', 'bandit_archer'], perPlayer: ['bandit'], hpMul: 2.73, dmgMul: 1.57, target: 0.85,
        props: [['barrel', 'oil'], ['barrel', 'oil'], ['barrel', 'oil'], ['oil', 3], ['chest', [['gold', 25], ['flask_oil', 3], ['cloth', 3], ['healing_potion', 1]]]] },
      { checkpoint: true, at: 0.55 },
      { id: 'm3', name: 'Cinder Imps', at: 0.68, clear: 'ruin', enemies: ['fire_imp', 'fire_imp'], perPlayer: ['fire_imp'], hpMul: 1.33, dmgMul: 1.05, target: 0.85,
        props: [['barrel', 'powder'], ['barrel', 'oil'], ['crate', [['sulfur', 2], ['charcoal', 2], ['emberroot', 2]]]] },
      { id: 'm4', name: 'The Warlord', at: 0.9, boss: true, clear: 'camp', enemies: ['warlord', 'bandit_archer'], perPlayer: ['bandit'], hpMul: 2, dmgMul: 1.36, target: 0.78,
        props: [['barrel', 'powder'], ['barrel', 'oil'], ['chest', [['gold', 60], ['iron_mail', 1], ['powder_bomb', 2], ['storm_staff', 1], ['healing_potion', 2]]]] },
    ],
  },
  {
    id: 'barrow', name: 'III. The Frozen Barrow', seed: 3303, W: 126, H: 58, time: 22 * 60,
    blurb: 'Under a moonless sky the dead walk the barrow fields. They see in the dark. You will need light — or to bring the dark with you.',
    terrain: { deep: 0.06, shallow: 0.13, sand: 0.15, rocky: 0.8, mount: 0.92, forest: 0.4 },
    supplies: [['torch', 3], ['nightsight', 2], ['healing_potion', 2], ['fire_bomb', 2], ['frost_bomb', 1]],
    encounters: [
      { id: 'b1', name: 'Barrow Watch', at: 0.27, clear: 'ruin', enemies: ['skeleton', 'skeleton'], perPlayer: ['skeleton'], hpMul: 3, dmgMul: 1.95, target: 0.85 },
      { id: 'b2', name: 'Wisp Pools', at: 0.45, clear: 'icepool', enemies: ['frost_wisp', 'frost_wisp'], perPlayer: ['frost_wisp'], hpMul: 3, dmgMul: 2, target: 0.82 },
      { checkpoint: true, at: 0.56 },
      { id: 'b3', name: 'The Ossuary', at: 0.7, clear: 'crypt', enemies: ['skeleton', 'frost_wisp', 'skeleton'], perPlayer: ['skeleton'], hpMul: 2.03, dmgMul: 1.31, target: 0.78,
        props: [['crate', [['healing_potion', 1], ['bone', 3]]]] },
      { id: 'b4', name: 'The Barrow King', at: 0.9, boss: true, clear: 'crypt', enemies: ['barrow_king', 'skeleton'], perPlayer: ['frost_wisp'], hpMul: 2.66, dmgMul: 1.55, target: 0.7,
        props: [['chest', [['gold', 100], ['iron_sword', 1]]]] },
    ],
  },
];
/** Enemy health multiplier per party size (index = number of players); damage scales with its square root. */
export const SIZE_HP = [1, 0.63, 1.06, 1.11, 1.22];
