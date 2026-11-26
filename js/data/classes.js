export const ATTRS = {
  might: { n: 'Might', d: 'Melee damage, throw range.' },
  finesse: { n: 'Finesse', d: 'Ranged & dagger damage, initiative, crit chance, movement.' },
  intellect: { n: 'Intellect', d: 'Spell and staff damage, healing.' },
  vigor: { n: 'Vigor', d: 'Health (+4 HP per point).' },
};
export const CLASSES = {
  sellsword: { n: 'Sellsword', glyph: '⚔', d: 'Frontliner. Sword, shield and a stubborn streak.',
    attrs: { might: 5, finesse: 3, intellect: 2, vigor: 5 }, skills: ['cleave', 'shield_bash', 'rally'],
    eq: { weapon: 'rusty_sword', offhand: 'wooden_shield', armor: 'padded_tunic' },
    inv: [['healing_potion', 2], ['tinderbox', 1], ['flask_water', 1], ['torch', 1], ['gold', 15]] },
  ranger: { n: 'Ranger', glyph: '➶', d: 'Archer and scout. Coats arrows with whatever is lying around.',
    attrs: { might: 3, finesse: 6, intellect: 2, vigor: 4 }, skills: ['aimed_shot', 'flare_shot', 'dash'],
    eq: { weapon: 'short_bow', armor: 'leather_armor' },
    inv: [['arrows', 24], ['dagger', 1], ['ember_paste', 1], ['healing_potion', 1], ['torch', 1], ['gold', 15]] },
  alchemist: { n: 'Alchemist', glyph: '⚗', d: 'Brews, bombs and pastes. Throwing costs only 1 AP.',
    attrs: { might: 3, finesse: 4, intellect: 5, vigor: 3 }, skills: ['acid_splash', 'mend'], passive: 'quick_toss',
    eq: { weapon: 'dagger', armor: 'padded_tunic' },
    inv: [['mortar', 1], ['empty_flask', 2], ['flask_water', 2], ['flask_oil', 2], ['cloth', 2], ['healroot', 2], ['fire_bomb', 2], ['healing_potion', 1], ['smoke_bomb', 1], ['torch', 1], ['gold', 20]] },
  elementalist: { n: 'Elementalist', glyph: '✧', d: 'Fire, frost and lightning. The environment is the weapon.',
    attrs: { might: 2, finesse: 3, intellect: 6, vigor: 4 }, skills: ['firebolt', 'frost_ray', 'lightning', 'rain'],
    eq: { weapon: 'oak_staff', armor: 'padded_tunic' },
    inv: [['healing_potion', 1], ['tinderbox', 1], ['torch', 1], ['nightsight', 1], ['gold', 15]] },
};
export const FREE_POINTS = 3;
export const PLAYER_COLORS = ['#4fa3ff', '#ff6b6b', '#5fd38d', '#ffb84d', '#c38bff', '#4fe3d6'];
